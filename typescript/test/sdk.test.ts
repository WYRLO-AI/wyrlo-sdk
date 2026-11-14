import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BASE_URL,
  Wyrlo,
  WyrloError,
  maskTexts,
  unmaskText,
  type GuardResponse,
} from "../src/index.ts";

// Données fictives uniquement.
const KEY = `wyr_test_${"ab".repeat(24)}`;
const PASSAGES = [{ id: "cgv-11", text: "Le délai de rétractation est de 14 jours." }];

const OK: GuardResponse = {
  trace_id: "00000000-0000-4000-8000-000000000001",
  decision: "answer",
  confidence: "certain",
  confidence_score: 1,
  reason: "1 phrase(s) sur 1 appuyée(s) par les sources.",
  passages: [{ id: "cgv-11", kept: true, rank: 1, score: 0.9, injection: false }],
  unsupported_sentences: [],
  injection_detected: false,
  skipped_steps: [],
  degraded: false,
  settings_version: 2,
  language: "fr",
  rerank_method: "similarity",
  verification_method: "signals",
  latency_ms: 120,
  quota_exceeded: false,
};

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

function fakeFetch(responses: (() => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      init: init ?? {},
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (!next) throw new Error("aucune réponse prévue");
    return next();
  }) as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("Wyrlo.guard", () => {
  // Un WYRLO_REGION présent dans l'environnement de la machine ne doit pas fausser les tests.
  beforeEach(() => {
    vi.stubEnv("WYRLO_REGION", undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("plafond mensuel atteint : réponse transmise, marquée dégradée, sans nouvel essai", async () => {
    const { impl, calls } = fakeFetch([
      json(200, {
        ...OK,
        trace_id: null,
        confidence: "unverified",
        confidence_score: null,
        skipped_steps: ["rerank", "injection_check", "consistency", "verification"],
        degraded: true,
        rerank_method: "none",
        verification_method: "none",
        quota_exceeded: true,
      }),
    ]);
    const wyrlo = new Wyrlo({ apiKey: KEY, fetch: impl });
    const res = await wyrlo.guard({ question: "Q ?", passages: PASSAGES, answer: "R." });
    expect(res).toMatchObject({
      decision: "answer",
      degraded: true,
      quota_exceeded: true,
      trace_id: null,
      answer: "R.",
    });
    expect(calls).toHaveLength(1);
  });

  it("réponse non vérifiée : jamais « probable », marquée dégradée", async () => {
    const { impl } = fakeFetch([
      json(200, {
        ...OK,
        confidence: "unverified",
        confidence_score: null,
        skipped_steps: ["rerank", "verification"],
        degraded: true,
        verification_method: "none",
      }),
    ]);
    const wyrlo = new Wyrlo({ apiKey: KEY, fetch: impl });
    const res = await wyrlo.guard({ question: "Q ?", passages: PASSAGES, answer: "R." });
    expect(res).toMatchObject({ decision: "answer", confidence: "unverified", degraded: true });
  });

  it("serveur sans le champ degraded : déduit des étapes sautées", async () => {
    const old: Partial<GuardResponse> = { ...OK, skipped_steps: ["rerank"] };
    delete old.degraded;
    const { impl } = fakeFetch([json(200, old)]);
    const wyrlo = new Wyrlo({ apiKey: KEY, fetch: impl });
    const res = await wyrlo.guard({ question: "Q ?", passages: PASSAGES, answer: "R." });
    expect(res.degraded).toBe(true);
  });

  it("reçu hors de Paris et refusé (421) : résultat dégradé, jamais d'exception", async () => {
    const refused = json(421, { error: { code: "wrong_region", message: "Hors de Paris." } });
    const { impl, calls } = fakeFetch([refused, refused]);
    const wyrlo = new Wyrlo({ apiKey: KEY, fetch: impl });
    const res = await wyrlo.guard({ question: "Q ?", passages: PASSAGES, answer: "R." });
    expect(res).toMatchObject({ decision: "answer", confidence: "unverified", degraded: true });
    expect(calls).toHaveLength(2);
  });

  it("envoie la requête et renvoie la décision", async () => {
    const { impl, calls } = fakeFetch([json(200, OK)]);
    const wyrlo = new Wyrlo({ apiKey: KEY, baseUrl: "https://api.example.test/v1/", fetch: impl });
    const res = await wyrlo.guard({
      question: "Délai de rétractation ?",
      passages: PASSAGES,
      answer: "14 jours.",
      language: "fr",
    });
    expect(res.decision).toBe("answer");
    expect(res.degraded).toBe(false);
    expect(res.answer).toBe("14 jours.");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.example.test/v1/guard");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(headers["x-wyrlo-sdk"]).toMatch(/^typescript\//);
    // Traitement imposé à Paris, région du projet (ADR 0003).
    expect(headers["x-region"]).toBe("eu-west-3");
    expect(calls[0]?.body).toMatchObject({ question: "Délai de rétractation ?", language: "fr" });
    expect(calls[0]?.body.request_id).toBe(res.request_id);
  });

  it("appelle generate avec les passages pour produire la réponse", async () => {
    const { impl, calls } = fakeFetch([json(200, OK)]);
    const wyrlo = new Wyrlo({ apiKey: KEY, fetch: impl });
    const res = await wyrlo.guard({
      question: "Délai ?",
      passages: PASSAGES,
      generate: (passages) => `Réponse fondée sur ${passages.length} passage.`,
    });
    expect(res.answer).toBe("Réponse fondée sur 1 passage.");
    expect(calls[0]?.body.answer).toBe("Réponse fondée sur 1 passage.");
  });

  it("réessaie une erreur 5xx avec le même request_id", async () => {
    const { impl, calls } = fakeFetch([json(502, {}), json(200, OK)]);
    const wyrlo = new Wyrlo({ apiKey: KEY, fetch: impl });
    const res = await wyrlo.guard({ question: "Q ?", passages: PASSAGES, answer: "R." });
    expect(res.degraded).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body.request_id).toBe(calls[1]?.body.request_id);
  });

  it("ne bloque jamais : panne réseau → résultat dégradé, sans exception", async () => {
    const { impl, calls } = fakeFetch([
      () => {
        throw new TypeError("fetch failed");
      },
    ]);
    const wyrlo = new Wyrlo({ apiKey: KEY, fetch: impl, maxRetries: 2 });
    const res = await wyrlo.guard({
      question: "Q ?",
      passages: PASSAGES,
      answer: "R.",
      requestId: "req-1",
    });
    expect(calls).toHaveLength(3);
    expect(res).toMatchObject({
      degraded: true,
      decision: "answer",
      confidence: "unverified",
      trace_id: null,
      request_id: "req-1",
      answer: "R.",
    });
    expect(res.passages[0]).toMatchObject({ id: "cgv-11", kept: true });
  });

  it("ne bloque jamais : délai dépassé → résultat dégradé", async () => {
    const hang = (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("abort"))),
      );
    const wyrlo = new Wyrlo({
      apiKey: KEY,
      fetch: hang as typeof fetch,
      timeoutMs: 50,
      maxRetries: 0,
    });
    const started = Date.now();
    const res = await wyrlo.guard({ question: "Q ?", passages: [], answer: "R." });
    expect(Date.now() - started).toBeLessThan(500);
    expect(res.degraded).toBe(true);
  });

  it("service surchargé (503 + Retry-After) : mode dégradé, sans exception ni nouvel essai", async () => {
    const overloaded = () =>
      new Response(
        JSON.stringify({ error: { code: "overloaded", message: "Service surchargé." } }),
        { status: 503, headers: { "retry-after": "2", "content-type": "application/json" } },
      );
    const { impl, calls } = fakeFetch([overloaded, json(200, OK)]);
    const wyrlo = new Wyrlo({ apiKey: KEY, fetch: impl });
    const res = await wyrlo.guard({ question: "Q ?", passages: PASSAGES, answer: "R." });
    expect(calls).toHaveLength(1);
    expect(res).toMatchObject({ degraded: true, decision: "answer", trace_id: null });
    expect(res.reason).toMatch(/overloaded/);
  });

  it("délai total par défaut de 3 s, nouvelle tentative comprise", async () => {
    const hang = (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("abort"))),
      );
    const wyrlo = new Wyrlo({ apiKey: KEY, fetch: hang as typeof fetch });
    const started = Date.now();
    const res = await wyrlo.guard({ question: "Q ?", passages: [], answer: "R." });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(2_900);
    expect(elapsed).toBeLessThan(3_300);
    expect(res.degraded).toBe(true);
  });

  it("lève une WyrloError pour une clé refusée ou une requête invalide", async () => {
    const { impl, calls } = fakeFetch([
      json(422, {
        error: {
          code: "invalid_request",
          message: "Requête invalide.",
          details: [{ field: "question", issue: "vide" }],
        },
      }),
    ]);
    const wyrlo = new Wyrlo({ apiKey: KEY, fetch: impl });
    const error = await wyrlo
      .guard({ question: "", passages: [], answer: "R." })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WyrloError);
    expect(error).toMatchObject({
      status: 422,
      code: "invalid_request",
      details: [{ field: "question", issue: "vide" }],
    });
    expect(calls).toHaveLength(1);
  });

  it("exige une clé", () => {
    expect(() => new Wyrlo({ apiKey: "" })).toThrow(WyrloError);
  });

  it("prend la région de l'option, puis de WYRLO_REGION, sinon Paris", async () => {
    const regionOf = async (options: { region?: string }) => {
      const { impl, calls } = fakeFetch([json(200, OK)]);
      await new Wyrlo({ apiKey: KEY, fetch: impl, ...options }).guard({
        question: "Q ?",
        passages: PASSAGES,
        answer: "R.",
      });
      return (calls[0]?.init.headers as Record<string, string>)["x-region"];
    };
    expect(await regionOf({})).toBe("eu-west-3");
    expect(await regionOf({ region: "eu-central-1" })).toBe("eu-central-1");
    // Une valeur vide ne doit pas laisser Supabase choisir la région.
    expect(await regionOf({ region: " " })).toBe("eu-west-3");
    vi.stubEnv("WYRLO_REGION", "eu-west-1");
    expect(await regionOf({})).toBe("eu-west-1");
    expect(await regionOf({ region: "eu-central-1" })).toBe("eu-central-1");
    vi.stubEnv("WYRLO_REGION", "  ");
    expect(await regionOf({})).toBe("eu-west-3");
  });

  it("option locale : en-tête Accept-Language, absent par défaut (l'API répond en anglais)", async () => {
    const languageOf = async (options: { locale?: "en" | "fr" }) => {
      const { impl, calls } = fakeFetch([json(200, OK)]);
      await new Wyrlo({ apiKey: KEY, fetch: impl, ...options }).guard({
        question: "Q ?",
        passages: PASSAGES,
        answer: "R.",
      });
      return (calls[0]?.init.headers as Record<string, string>)["accept-language"];
    };
    expect(await languageOf({})).toBeUndefined();
    expect(await languageOf({ locale: "fr" })).toBe("fr");
    expect(await languageOf({ locale: "en" })).toBe("en");
  });
});

describe("adresse de l'API", () => {
  beforeEach(() => {
    vi.stubEnv("WYRLO_BASE_URL", undefined);
    vi.stubEnv("WYRLO_REGION", undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function urlOf(options: { baseUrl?: string }) {
    const { impl, calls } = fakeFetch([json(200, OK)]);
    await new Wyrlo({ apiKey: KEY, fetch: impl, ...options }).guard({
      question: "Q ?",
      passages: PASSAGES,
      answer: "R.",
    });
    return calls[0]?.url;
  }

  it("utilise DEFAULT_BASE_URL sans option ni variable d'environnement", async () => {
    expect(await urlOf({})).toBe(`${DEFAULT_BASE_URL}/guard`);
    // Une valeur vide retombe sur l'adresse par défaut.
    expect(await urlOf({ baseUrl: " " })).toBe(`${DEFAULT_BASE_URL}/guard`);
    vi.stubEnv("WYRLO_BASE_URL", "");
    expect(await urlOf({})).toBe(`${DEFAULT_BASE_URL}/guard`);
  });

  it("préfère WYRLO_BASE_URL à l'adresse par défaut, et l'option à WYRLO_BASE_URL", async () => {
    vi.stubEnv("WYRLO_BASE_URL", "https://env.example.test/functions/v1");
    expect(await urlOf({})).toBe("https://env.example.test/functions/v1/guard");
    expect(await urlOf({ baseUrl: "https://option.example.test/v1" })).toBe(
      "https://option.example.test/v1/guard",
    );
  });

  it("retire les barres obliques finales", async () => {
    expect(await urlOf({ baseUrl: "https://option.example.test/v1///" })).toBe(
      "https://option.example.test/v1/guard",
    );
    vi.stubEnv("WYRLO_BASE_URL", "https://env.example.test/functions/v1/");
    expect(await urlOf({})).toBe("https://env.example.test/functions/v1/guard");
  });

  it("est la même dans le SDK Python", () => {
    const python = readFileSync(
      new URL("../../python/src/wyrlo/__init__.py", import.meta.url),
      "utf8",
    );
    const match = /^DEFAULT_BASE_URL = "([^"]*)"$/m.exec(python);
    expect(match?.[1]).toBe(DEFAULT_BASE_URL);
  });
});

describe("prepare (avant la recherche du client)", () => {
  const json = (status: number, body: unknown) => () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("renvoie la question enrichie et la variante, avec le même identifiant de requête", async () => {
    const { impl, calls } = fakeFetch([
      json(200, {
        query: "Comment obtenir un remboursement ? (rétractation)",
        added_terms: ["rétractation"],
        request_id: "req-1",
        settings_version: 3,
        settings_variant: "candidate",
      }),
    ]);
    const wyrlo = new Wyrlo({ apiKey: KEY, fetch: impl });
    const r = await wyrlo.prepare({
      question: "Comment obtenir un remboursement ?",
      requestId: "req-1",
    });
    expect(calls[0]?.url).toBe(`${DEFAULT_BASE_URL}/guard/prepare`);
    expect(calls[0]?.body).toEqual({
      question: "Comment obtenir un remboursement ?",
      request_id: "req-1",
    });
    expect(r).toMatchObject({
      query: "Comment obtenir un remboursement ? (rétractation)",
      settings_variant: "candidate",
      request_id: "req-1",
      degraded: false,
    });
  });

  it("WYRLO injoignable : la question d'origine, jamais d'exception", async () => {
    const { impl } = fakeFetch([
      () => {
        throw new TypeError("réseau");
      },
    ]);
    const r = await new Wyrlo({ apiKey: KEY, fetch: impl }).prepare({
      question: "Question fictive ?",
    });
    expect(r).toMatchObject({
      query: "Question fictive ?",
      degraded: true,
      settings_variant: null,
    });
    expect(r.request_id).toBeTruthy();
  });

  it("clé refusée : WyrloError", async () => {
    const { impl } = fakeFetch([
      json(401, { error: { code: "unauthorized", message: "Clé refusée." } }),
    ]);
    await expect(
      new Wyrlo({ apiKey: KEY, fetch: impl }).prepare({ question: "Question fictive ?" }),
    ).rejects.toBeInstanceOf(WyrloError);
  });
});

describe("feedback (pouce de l'utilisateur final)", () => {
  const json = (status: number, body: unknown) => () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const TRACE = "00000000-0000-4000-8000-000000000001";

  it("envoie l'identifiant de trace et le pouce, sans texte", async () => {
    const { impl, calls } = fakeFetch([json(200, { recorded: true, trace_id: TRACE })]);
    const r = await new Wyrlo({ apiKey: KEY, fetch: impl }).feedback({
      traceId: TRACE,
      helpful: false,
    });
    expect(calls[0]?.url).toBe(`${DEFAULT_BASE_URL}/guard/feedback`);
    expect(calls[0]?.body).toEqual({ trace_id: TRACE, helpful: false });
    expect(r).toEqual({ recorded: true });
  });

  it("trace inconnue ou WYRLO injoignable : recorded faux, jamais d'exception", async () => {
    const missing = fakeFetch([json(404, { error: { code: "not_found", message: "?" } })]);
    expect(
      await new Wyrlo({ apiKey: KEY, fetch: missing.impl }).feedback({
        traceId: TRACE,
        helpful: true,
      }),
    ).toEqual({ recorded: false });
    const down = fakeFetch([
      () => {
        throw new TypeError("réseau");
      },
    ]);
    expect(
      await new Wyrlo({ apiKey: KEY, fetch: down.impl }).feedback({
        traceId: TRACE,
        helpful: true,
      }),
    ).toEqual({ recorded: false });
  });

  it("clé refusée : WyrloError", async () => {
    const { impl } = fakeFetch([
      json(401, { error: { code: "unauthorized", message: "Clé refusée." } }),
    ]);
    await expect(
      new Wyrlo({ apiKey: KEY, fetch: impl }).feedback({ traceId: TRACE, helpful: true }),
    ).rejects.toBeInstanceOf(WyrloError);
  });
});

describe("sécurité de la clé (audit de sécurité, SEC-33)", () => {
  it("aucune redirection suivie : redirect « error » sur chaque appel", async () => {
    const { impl, calls } = fakeFetch([json(200, OK)]);
    const wyrlo = new Wyrlo({ apiKey: KEY, fetch: impl });
    await wyrlo.guard({ question: "Q ?", passages: PASSAGES, answer: "R." });
    expect(calls[0]?.init.redirect).toBe("error");
  });

  it("adresse sans https refusée, sauf la machine locale", () => {
    for (const baseUrl of [
      "http://api.example.test/v1",
      "ftp://api.example.test",
      "api.example.test",
    ]) {
      expect(() => new Wyrlo({ apiKey: KEY, baseUrl })).toThrow(
        expect.objectContaining({ code: "insecure_base_url" }),
      );
    }
    for (const baseUrl of [
      "https://api.example.test/v1",
      "http://localhost:8000",
      "http://[::1]:8000",
    ]) {
      expect(() => new Wyrlo({ apiKey: KEY, baseUrl })).not.toThrow();
    }
  });
});

describe("masquage côté client (option mask)", () => {
  // Données fictives uniquement.
  const QUESTION = "Comment joindre le service client ?";
  const ANSWER = "Écrivez à aide@boutique-exemple.fr ou appelez le 01 84 88 12 34.";
  const SOURCES = [
    {
      id: "contact",
      text: "Service client : aide@boutique-exemple.fr. Téléphone : 01 84 88 12 34.",
    },
  ];

  it("règles intégrées : seules les marques partent, les vraies valeurs reviennent", async () => {
    const { impl, calls } = fakeFetch([
      json(200, {
        ...OK,
        reason: "Phrase non appuyée : appelez le [TELEPHONE_1].",
        unsupported_sentences: ["Écrivez à [EMAIL_1] ou appelez le [TELEPHONE_1]."],
      }),
    ]);
    const wyrlo = new Wyrlo({ apiKey: KEY, fetch: impl, mask: true });
    const res = await wyrlo.guard({ question: QUESTION, passages: SOURCES, answer: ANSWER });
    const envoye = JSON.stringify(calls[0]?.body);
    expect(envoye).not.toContain("aide@boutique-exemple.fr");
    expect(envoye).not.toContain("01 84 88 12 34");
    expect(calls[0]?.body.answer).toBe("Écrivez à [EMAIL_1] ou appelez le [TELEPHONE_1].");
    expect(calls[0]?.body.passages).toEqual([
      { id: "contact", text: "Service client : [EMAIL_1]. Téléphone : [TELEPHONE_1]." },
    ]);
    expect(calls[0]?.body.question).toBe(QUESTION);
    expect(res.answer).toBe(ANSWER);
    expect(res.unsupported_sentences).toEqual([ANSWER]);
    expect(res.reason).toBe("Phrase non appuyée : appelez le 01 84 88 12 34.");
    expect(res.local_masking).toEqual({ method: "rules", counts: { EMAIL: 2, TELEPHONE: 2 } });
  });

  it("sans l'option : textes envoyés tels quels, local_masking null", async () => {
    const { impl, calls } = fakeFetch([json(200, OK)]);
    const res = await new Wyrlo({ apiKey: KEY, fetch: impl }).guard({
      question: QUESTION,
      passages: SOURCES,
      answer: ANSWER,
    });
    expect(calls[0]?.body.answer).toBe(ANSWER);
    expect(res.local_masking).toBeNull();
  });

  it("fonction fournie : appelée une fois avec tous les textes, sa sortie part", async () => {
    const { impl, calls } = fakeFetch([json(200, OK)]);
    const recus: string[][] = [];
    const wyrlo = new Wyrlo({
      apiKey: KEY,
      fetch: impl,
      mask: async (texts) => {
        recus.push(texts);
        return texts.map((t) => t.replace(/Jeanne Martin/g, "[PERSONNE_1]"));
      },
    });
    const res = await wyrlo.guard({
      question: "Qui suit le dossier ?",
      passages: [{ text: "Le dossier est suivi par Jeanne Martin." }],
      generate: () => "Jeanne Martin suit le dossier.",
    });
    expect(recus).toEqual([
      [
        "Qui suit le dossier ?",
        "Jeanne Martin suit le dossier.",
        "Le dossier est suivi par Jeanne Martin.",
      ],
    ]);
    expect(calls[0]?.body.answer).toBe("[PERSONNE_1] suit le dossier.");
    expect(res.answer).toBe("Jeanne Martin suit le dossier.");
    expect(res.local_masking).toEqual({ method: "custom", counts: null });
  });

  it("masquage en échec ou sortie invalide : rien n'est envoyé, réponse dégradée", async () => {
    for (const mask of [
      () => {
        throw new Error("modèle absent");
      },
      (texts: string[]) => texts.slice(1),
      () => [1, 2, 3] as unknown as string[],
    ]) {
      const { impl, calls } = fakeFetch([json(200, OK)]);
      const res = await new Wyrlo({ apiKey: KEY, fetch: impl, mask }).guard({
        question: QUESTION,
        passages: SOURCES,
        answer: ANSWER,
      });
      expect(calls).toHaveLength(0);
      expect(res.degraded).toBe(true);
      expect(res.decision).toBe("answer");
      expect(res.confidence).toBe("unverified");
      expect(res.skipped_steps).toContain("anonymize");
      expect(res.answer).toBe(ANSWER);
      expect(res.reason).toMatch(/Local masking failed/);
    }
  });

  it("prepare : question masquée à l'envoi, vraie question rendue avec les termes ajoutés", async () => {
    const { impl, calls } = fakeFetch([
      json(200, {
        query: "Mon colis pour [ADRESSE_1] ? (livraison)",
        added_terms: ["livraison"],
        settings_version: 3,
        settings_variant: null,
      }),
    ]);
    const wyrlo = new Wyrlo({ apiKey: KEY, fetch: impl, mask: true });
    const res = await wyrlo.prepare({ question: "Mon colis pour 12 rue des Lilas, 75011 Paris ?" });
    expect(calls[0]?.body.question).toBe("Mon colis pour [ADRESSE_1] ?");
    expect(res.query).toBe("Mon colis pour 12 rue des Lilas, 75011 Paris ? (livraison)");
    expect(res.added_terms).toEqual(["livraison"]);
    expect(res.degraded).toBe(false);
  });

  it("prepare : masquage en échec, rien n'est envoyé, question d'origine", async () => {
    const { impl, calls } = fakeFetch([json(200, OK)]);
    const wyrlo = new Wyrlo({
      apiKey: KEY,
      fetch: impl,
      mask: () => {
        throw new Error("x");
      },
    });
    const res = await wyrlo.prepare({ question: "Q ?" });
    expect(calls).toHaveLength(0);
    expect(res).toMatchObject({ query: "Q ?", degraded: true });
  });

  it("mêmes règles que le moteur : corpus commun (aussi vérifié par le moteur et le SDK Python)", () => {
    const corpus = JSON.parse(
      readFileSync(new URL("./masquage-corpus.json", import.meta.url), "utf8"),
    ) as { textes: string[]; attendu: string[]; decompte: Record<string, number> }[];
    for (const cas of corpus) {
      const m = maskTexts(cas.textes);
      expect(m.texts).toEqual(cas.attendu);
      expect(m.counts).toEqual(cas.decompte);
      // Restauration exacte quand chaque valeur n'a qu'une écriture.
      if (cas.textes.length === 1)
        expect(unmaskText(m.texts[0] ?? "", m.values)).toBe(cas.textes[0]);
    }
  });
});

describe("index sans copie (mode B)", () => {
  beforeEach(() => {
    vi.stubEnv("WYRLO_REGION", undefined);
    vi.stubEnv("WYRLO_BASE_URL", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  const FP = "a".repeat(64);
  const PUT_OK = {
    document: "docs/cgv.md",
    version: "v1",
    status: "indexed",
    passages: [{ index: 0, start: 0, length: 41, fingerprint: FP }],
  };

  it("index : PUT sur l'identifiant encodé, texte et étiquettes, région de Paris", async () => {
    const { impl, calls } = fakeFetch([json(200, PUT_OK)]);
    const wyrlo = new Wyrlo({ apiKey: KEY, fetch: impl });
    const res = await wyrlo.index("docs/cgv.md", {
      version: "v1",
      text: "Le délai de rétractation est de 14 jours.",
      labels: ["cgv"],
    });
    expect(res.status).toBe("indexed");
    expect(calls[0]?.url).toBe(`${DEFAULT_BASE_URL}/guard/index/documents/docs%2Fcgv.md`);
    expect(calls[0]?.init.method).toBe("PUT");
    expect(calls[0]?.body).toMatchObject({ version: "v1", labels: ["cgv"] });
    expect(typeof calls[0]?.body.request_id).toBe("string");
    expect((calls[0]?.init.headers as Record<string, string>)["x-region"]).toBe("eu-west-3");
    expect(calls[0]?.init.redirect).toBe("error");
  });

  it("index : mode B coupé (403) et panne lèvent une WyrloError", async () => {
    const off = fakeFetch([
      json(403, { error: { code: "index_disabled", message: "Mode B coupé." } }),
    ]);
    await expect(
      new Wyrlo({ apiKey: KEY, fetch: off.impl }).index("d", { version: "v1", text: "x" }),
    ).rejects.toMatchObject({ status: 403, code: "index_disabled" });
    const down = fakeFetch([json(503, {})]);
    await expect(
      new Wyrlo({ apiKey: KEY, fetch: down.impl }).index("d", { version: "v1", text: "x" }),
    ).rejects.toMatchObject({ code: "unavailable" });
    const net = fakeFetch([
      () => {
        throw new TypeError("fetch failed");
      },
    ]);
    await expect(
      new Wyrlo({ apiKey: KEY, fetch: net.impl }).index("d", { version: "v1", text: "x" }),
    ).rejects.toBeInstanceOf(WyrloError);
  });

  it("index : avec l'option mask, rien n'est envoyé sans allowUnmasked", async () => {
    const { impl, calls } = fakeFetch([json(200, PUT_OK)]);
    const wyrlo = new Wyrlo({ apiKey: KEY, fetch: impl, mask: true });
    await expect(wyrlo.index("d", { version: "v1", text: "x" })).rejects.toMatchObject({
      code: "mask_unsupported",
    });
    expect(calls).toHaveLength(0);
    await wyrlo.index("d", { version: "v1", text: "x", allowUnmasked: true });
    expect(calls[0]?.body.text).toBe("x");
  });

  it("remove et indexStats : DELETE et GET sans corps", async () => {
    const { impl, calls } = fakeFetch([
      json(200, { document: "d", deleted: true }),
      json(200, {
        enabled: true,
        documents: 1,
        passages: 2,
        last_indexed_at: null,
        month: { documents: 1, passages: 2, searches: 0 },
      }),
    ]);
    const wyrlo = new Wyrlo({ apiKey: KEY, fetch: impl });
    expect(await wyrlo.remove("d")).toEqual({ document: "d", deleted: true });
    expect((await wyrlo.indexStats()).passages).toBe(2);
    expect(calls[0]?.init.method).toBe("DELETE");
    expect(calls[0]?.init.body).toBeUndefined();
    expect(calls[1]?.url).toBe(`${DEFAULT_BASE_URL}/guard/index/stats`);
    expect(calls[1]?.init.method).toBe("GET");
  });

  it("lot : POST /guard/index/documents, espace du lot, résultats par document", async () => {
    const out = {
      results: [
        { document: "a", status: "indexed", version: "v1", passages: [] },
        { document: "b", status: "failed", error: { code: "overloaded", message: "Plus tard." } },
      ],
      indexed: 1,
      unchanged: 0,
      failed: 1,
    };
    const { impl, calls } = fakeFetch([json(200, out)]);
    const wyrlo = new Wyrlo({ apiKey: KEY, fetch: impl });
    const res = await wyrlo.indexMany(
      [
        { id: "a", version: "v1", text: "x", title: "A" },
        { id: "b", version: "v1", passages: [{ text: "y", start: 0 }] },
      ],
      { tenant: "client-1" },
    );
    expect(res.failed).toBe(1);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.url).toContain("/guard/index/documents");
    expect(calls[0]?.body.tenant).toBe("client-1");
    expect((calls[0]?.body.documents as { title?: string }[])[0]?.title).toBe("A");
    expect(typeof calls[0]?.body.request_id).toBe("string");
    const masked = new Wyrlo({ apiKey: KEY, fetch: impl, mask: true });
    await expect(masked.indexMany([{ id: "a", version: "v1", text: "x" }])).rejects.toMatchObject({
      code: "mask_unsupported",
    });
  });

  it("mode C : l'espace part dans le corps (index, search) ou l'adresse (remove, stats)", async () => {
    const { impl, calls } = fakeFetch([
      json(200, PUT_OK),
      json(200, { results: [] }),
      json(200, { document: "d", deleted: true }),
      json(200, {
        enabled: true,
        documents: 1,
        passages: 2,
        last_indexed_at: null,
        tenant: "client-1",
        month: { documents: 1, passages: 2, searches: 0 },
      }),
      json(200, { tenant: "client 1", documents: 1, passages: 2 }),
    ]);
    const wyrlo = new Wyrlo({ apiKey: KEY, fetch: impl });
    await wyrlo.index("d", { version: "v1", text: "x", tenant: "client-1", title: "CGV 2026" });
    await wyrlo.search({ question: "Q ?", tenant: "client-1" });
    await wyrlo.remove("d", { tenant: "client-1" });
    await wyrlo.indexStats({ tenant: "client-1" });
    expect(await wyrlo.removeTenant("client 1")).toEqual({
      tenant: "client 1",
      documents: 1,
      passages: 2,
    });
    expect(calls[0]?.body.tenant).toBe("client-1");
    expect(calls[0]?.body.title).toBe("CGV 2026");
    expect(calls[1]?.body.tenant).toBe("client-1");
    expect(calls[2]?.url).toBe(`${DEFAULT_BASE_URL}/guard/index/documents/d?tenant=client-1`);
    expect(calls[3]?.url).toBe(`${DEFAULT_BASE_URL}/guard/index/stats?tenant=client-1`);
    expect(calls[4]?.url).toBe(`${DEFAULT_BASE_URL}/guard/index?tenant=client%201`);
    expect(calls[4]?.init.method).toBe("DELETE");
    // Sans espace : rien n'est ajouté.
    await expect(wyrlo.removeTenant("")).rejects.toMatchObject({ code: "invalid_request" });
    expect(calls).toHaveLength(5);
  });

  it("search : corps de l'API, puis adresse transmise à guard", async () => {
    const result = {
      document: "d",
      version: "v1",
      start: 0,
      length: 41,
      fingerprint: FP,
      index: 0,
      labels: [],
      score: 0.8,
    };
    const { impl, calls } = fakeFetch([json(200, { results: [result] }), json(200, OK)]);
    const wyrlo = new Wyrlo({ apiKey: KEY, fetch: impl });
    const res = await wyrlo.search({
      question: "Délai ?",
      k: 3,
      labelsAny: ["cgv"],
      keywordHits: ["d"],
    });
    expect(res).toMatchObject({ degraded: false, results: [result] });
    expect(calls[0]?.body).toMatchObject({
      question: "Délai ?",
      k: 3,
      labels_any: ["cgv"],
      keyword_hits: [{ document: "d" }],
    });
    const address = { document: "d", version: "v1", start: 0, length: 41, fingerprint: FP };
    await wyrlo.guard({
      question: "Délai ?",
      answer: "14 jours.",
      passages: [{ id: "p", text: PASSAGES[0]?.text ?? "", address }],
    });
    expect((calls[1]?.body.passages as { address?: unknown }[])[0]?.address).toEqual(address);
  });

  it("search : panne → liste vide « degraded », jamais d'exception ; 403 → WyrloError", async () => {
    for (const reply of [json(503, {}), json(500, {}), json(421, {})]) {
      const { impl } = fakeFetch([reply]);
      const res = await new Wyrlo({ apiKey: KEY, fetch: impl }).search({ question: "Q ?" });
      expect(res).toMatchObject({ results: [], degraded: true });
    }
    const off = fakeFetch([
      json(403, { error: { code: "index_disabled", message: "Mode B coupé." } }),
    ]);
    await expect(
      new Wyrlo({ apiKey: KEY, fetch: off.impl }).search({ question: "Q ?" }),
    ).rejects.toMatchObject({ code: "index_disabled" });
  });

  it("search : question masquée sur votre machine avec l'option mask", async () => {
    const { impl, calls } = fakeFetch([json(200, { results: [] })]);
    await new Wyrlo({ apiKey: KEY, fetch: impl, mask: true }).search({
      question: "Commande de jean@exemple.fr ?",
    });
    expect(calls[0]?.body.question).toBe("Commande de [EMAIL_1] ?");
  });

  it("guard avec mask : adresse retirée si le masquage change le texte (pas de « périmé » à tort)", async () => {
    const { impl, calls } = fakeFetch([json(200, OK)]);
    const address = { document: "d", version: "v1", start: 0, length: 10, fingerprint: FP };
    await new Wyrlo({ apiKey: KEY, fetch: impl, mask: true }).guard({
      question: "Contact ?",
      answer: "Écrire au support.",
      passages: [
        { id: "a", text: "Écrire à jean@exemple.fr.", address },
        { id: "b", text: "Le délai est de 14 jours.", address },
      ],
    });
    const sent = calls[0]?.body.passages as { id: string; address?: unknown }[];
    expect(sent[0]?.address).toBeUndefined();
    expect(sent[1]?.address).toEqual(address);
  });
});

describe("answer (la réponse complète en un appel)", () => {
  const json = (status: number, body: unknown) => () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const HIT = {
    document: "cgv.md",
    version: "v1",
    start: 120,
    length: 31,
    fingerprint: "a".repeat(64),
    index: 0,
    labels: [],
    score: 0.8,
  };
  const ANSWER = {
    trace_id: "t1",
    decision: "answer",
    confidence: "probable",
    answer: "Le moteur est garanti 2 ans.",
    sentences: [
      {
        text: "Le moteur est garanti 2 ans.",
        confidence: "probable",
        sources: ["cgv.md#120"],
        supported: true,
      },
    ],
    leads: [],
    reason: "ok",
    model: { provider: "wyrlo", name: "petit" },
    usage: { input_tokens: 90, output_tokens: 10 },
    degraded: false,
  };

  it("avec read : cherche, relit chez le client, envoie les textes avec leur adresse", async () => {
    const { impl, calls } = fakeFetch([
      json(200, { results: [HIT, { ...HIT, start: 400 }] }),
      json(200, ANSWER),
    ]);
    const lus: number[] = [];
    const res = await new Wyrlo({ apiKey: KEY, fetch: impl }).answer({
      question: "Garantie du moteur ?",
      tenant: "client-1",
      k: 2,
      read: (address) => {
        lus.push(address.start);
        return address.start === 120 ? "Le moteur est garanti 2 ans." : null;
      },
    });
    expect(lus).toEqual([120, 400]);
    expect(calls.map((c) => new URL(c.url).pathname.split("/guard")[1])).toEqual([
      "/search",
      "/answer",
    ]);
    expect(calls[0]?.body).toMatchObject({
      question: "Garantie du moteur ?",
      k: 2,
      tenant: "client-1",
    });
    expect(calls[1]?.body).toMatchObject({
      question: "Garantie du moteur ?",
      tenant: "client-1",
      passages: [
        {
          id: "cgv.md#120",
          text: "Le moteur est garanti 2 ans.",
          source: "cgv.md",
          address: { document: "cgv.md", version: "v1", start: 120, length: 31 },
        },
      ],
    });
    expect(calls[1]?.body.model).toBeUndefined();
    expect(res).toMatchObject({ decision: "answer", trace_id: "t1" });
    expect(res.sentences[0]?.sources).toEqual(["cgv.md#120"]);
  });

  it("avec passages et le modèle du client : pas de recherche, clé transmise pour cet appel", async () => {
    const { impl, calls } = fakeFetch([json(200, ANSWER)]);
    await new Wyrlo({ apiKey: KEY, fetch: impl }).answer({
      question: "Q ?",
      passages: [{ id: "p1", text: "Texte." }],
      model: { provider: "openai", name: "modele-fictif", apiKey: "cle-fournisseur-fictive" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.model).toEqual({
      provider: "openai",
      name: "modele-fictif",
      api_key: "cle-fournisseur-fictive",
    });
  });

  it("ni read ni passages, modèle refusé, service en panne : WyrloError", async () => {
    await expect(
      new Wyrlo({ apiKey: KEY, fetch: fakeFetch([]).impl }).answer({ question: "Q ?" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    const refus = fakeFetch([
      json(422, { error: { code: "invalid_request", message: "Clé refusée." } }),
    ]);
    await expect(
      new Wyrlo({ apiKey: KEY, fetch: refus.impl }).answer({ question: "Q ?", passages: [] }),
    ).rejects.toMatchObject({ status: 422 });
    const panne = fakeFetch([json(503, { error: { code: "overloaded", message: "x" } })]);
    await expect(
      new Wyrlo({ apiKey: KEY, fetch: panne.impl }).answer({ question: "Q ?", passages: [] }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});
