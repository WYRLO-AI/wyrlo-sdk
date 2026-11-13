/**
 * SDK TypeScript de WYRLO.
 *
 *   const wyrlo = new Wyrlo({ apiKey: process.env.WYRLO_API_KEY });
 *   const res = await wyrlo.guard({ question, passages, answer });
 *   if (res.decision === "abstain") return "Je ne sais pas.";
 *
 * Principes :
 * - WYRLO ne doit jamais empêcher votre utilisateur d'avoir une réponse : panne
 *   réseau, délai dépassé ou erreur 5xx → résultat « dégradé » (decision « answer »,
 *   confiance « unverified », `degraded: true`), sans exception.
 * - Une erreur de votre intégration (clé invalide, requête mal formée) lève une
 *   `WyrloError`, pour être vue en développement.
 * - Chaque appel porte un `request_id` : un nouvel essai n'est compté qu'une fois.
 * - Chaque appel impose la région de traitement (`x-region: eu-west-3`, Paris).
 * - À utiliser côté serveur uniquement : la clé ne doit jamais atteindre un navigateur.
 * - Option `mask` : les données personnelles reconnaissables sont masquées sur votre
 *   serveur avant l'envoi ; si le masquage échoue, rien n'est envoyé (résultat dégradé).
 * - Index sans copie (mode B, ouvert sur demande) : `index()`, `remove()`, `indexStats()`
 *   et `search()`. WYRLO ne garde aucun texte : seulement l'adresse, l'empreinte et le
 *   vecteur de chaque passage. Une recherche en panne rend une liste vide marquée
 *   `degraded` ; une indexation en panne lève une `WyrloError` (à refaire plus tard).
 */

import {
  API_VERSION,
  type ApiErrorCode,
  type GuardPassageInput,
  type GuardRequest,
  type GuardResponse,
  type IndexBatchRequest,
  type IndexBatchResponse,
  type IndexDeleteResponse,
  type IndexPutRequest,
  type IndexPutResponse,
  type IndexStatsResponse,
  type IndexTenantDeleteResponse,
  type PrepareResponse,
  type SearchRequest,
  type SearchResponse,
  type SkippedStep,
} from "./contract.ts";
import { maskTexts, unmaskText } from "./masking.ts";

export * from "./contract.ts";
export { maskTexts, unmaskText, type MaskedTexts } from "./masking.ts";

/** Adresse par défaut de l'API (option `baseUrl` ou variable d'environnement `WYRLO_BASE_URL`). */
export const DEFAULT_BASE_URL = "https://api.wyrlo.io/functions/v1";
export const SDK_VERSION = "0.1.2";
/**
 * Région d'exécution imposée à la fonction `guard` : Paris, région du projet (ADR 0003).
 *
 * Sans consigne, Supabase exécute la fonction dans la région la plus proche de
 * l'appelant (us-east-1 depuis les États-Unis, par exemple). Or la question, les
 * passages et la réponse y arrivent en clair, avant masquage : l'en-tête `x-region`
 * garantit que ce traitement reste en Europe. Vérifiable avec l'en-tête de réponse
 * `x-sb-edge-region`.
 */
export const DEFAULT_REGION = "eu-west-3";

export interface WyrloOptions {
  /** Clé d'API du projet (wyr_test_… ou wyr_live_…). Par défaut : WYRLO_API_KEY. */
  apiKey?: string;
  /** Adresse de l'API. Par défaut : WYRLO_BASE_URL, sinon `DEFAULT_BASE_URL`. */
  baseUrl?: string;
  /**
   * Région où la fonction traite le texte en clair (en-tête `x-region`). Par défaut :
   * WYRLO_REGION, sinon « eu-west-3 » (Paris). Voir `DEFAULT_REGION` : ne changez
   * cette valeur que si vous savez où vos données peuvent être traitées.
   */
  region?: string;
  /**
   * Délai maximal d'un appel à `guard`, en millisecondes, nouvelles tentatives comprises
   * (3 000 par défaut). Au-delà, la réponse est transmise en mode dégradé, sans erreur.
   */
  timeoutMs?: number;
  /**
   * Nouvelles tentatives après une panne réseau ou une erreur 5xx, dans le même délai
   * (1 par défaut). Jamais après une réponse « surchargé » (503, 429).
   */
  maxRetries?: number;
  /**
   * Langue des messages et des raisons (`reason`) renvoyés par l'API : « en » (anglais, par
   * défaut) ou « fr » (français), par l'en-tête Accept-Language.
   */
  locale?: "en" | "fr";
  /**
   * Masquage côté client, avant tout envoi (question, réponse, texte des passages) :
   * - `true` : les règles du masquage intégré de WYRLO (e-mails, téléphones, IBAN, cartes,
   *   numéro de sécurité sociale, adresses IP, pièces d'identité, adresses postales, clés
   *   d'API), appliquées sur votre machine ; le SDK remet les vraies valeurs dans la
   *   raison et les phrases non appuyées qu'il vous rend ;
   * - une fonction : la vôtre (par exemple Presidio sur votre machine, pour les noms de
   *   personnes). Elle reçoit tous les textes d'un appel et rend autant de textes masqués ;
   *   gardez une même marque pour une même valeur. Les valeurs ne sont pas remises.
   * Si le masquage échoue, rien n'est envoyé : réponse transmise sans vérification
   * (`degraded`, étape « anonymize » sautée), comme pour une panne de WYRLO.
   * Par défaut : désactivé (WYRLO masque de son côté, avec les mêmes règles).
   */
  mask?: boolean | Masker;
  /** Implémentation de fetch (tests, environnements particuliers). */
  fetch?: typeof fetch;
}

/** Fonction de masquage : tous les textes d'un appel, autant de textes masqués en retour. */
export type Masker = (texts: string[]) => string[] | Promise<string[]>;

/** Masquage côté client appliqué à cet appel (null : aucun). */
export interface LocalMasking {
  /** « rules » : règles intégrées au SDK ; « custom » : votre fonction. */
  method: "rules" | "custom";
  /** Remplacements par type (règles intégrées seulement), sans aucune valeur. */
  counts: Record<string, number> | null;
}

export type Generate = (passages: GuardPassageInput[]) => Promise<string> | string;

export type GuardInput = Omit<GuardRequest, "answer" | "request_id"> & {
  /** Identifiant unique de la requête (sinon généré). */
  requestId?: string;
  /** Délai de cet appel, en millisecondes. */
  timeoutMs?: number;
} & (
    | { answer: string; generate?: never }
    /** Ou une fonction qui produit la réponse à partir des passages (votre LLM). */
    | { generate: Generate; answer?: never }
  );

export interface GuardResult extends Omit<GuardResponse, "trace_id"> {
  /** null si WYRLO n'a pas pu être joint (résultat dégradé). */
  trace_id: string | null;
  /** La réponse vérifiée (celle fournie ou produite par `generate`). */
  answer: string;
  /**
   * Mode dégradé : WYRLO injoignable, plafond mensuel de l'offre atteint
   * (`quota_exceeded`) ou traitement sauté (`skipped_steps`). Toujours vrai quand la
   * confiance est « unverified » (réponse transmise sans contrôle). Jamais bloquant.
   */
  degraded: boolean;
  request_id: string;
  /** Masquage fait sur votre machine avant l'envoi (option `mask`), sinon null. */
  local_masking: LocalMasking | null;
}

/** Délai par défaut d'une indexation (découpage et vecteurs de 2 000 passages au plus). */
export const INDEX_TIMEOUT_MS = 30_000;

/** `index()` : le texte entier (découpé par WYRLO), ou vos passages déjà découpés. */
export type IndexInput = Omit<IndexPutRequest, "request_id" | "text" | "passages"> & {
  requestId?: string;
  /** Délai de cet appel, en millisecondes (30 000 par défaut). */
  timeoutMs?: number;
  /**
   * Avec l'option `mask` du client, `index()` refuse d'envoyer le texte (code
   * `mask_unsupported`) : les positions et les empreintes doivent porter sur votre texte
   * d'origine, qui ne peut donc pas être masqué sur votre machine. Passez `true` pour
   * l'envoyer quand même : WYRLO le masque avant de calculer les vecteurs et n'en garde
   * rien.
   */
  allowUnmasked?: boolean;
} & (
    | { text: string; passages?: never }
    | { passages: NonNullable<IndexPutRequest["passages"]>; text?: never }
  );

/** `search()` : la question, et facultativement vos résultats par mots-clés à fusionner. */
export interface SearchInput {
  question: string;
  /** Nombre de résultats (8 par défaut, 50 au plus). */
  k?: number;
  /** Documents portant au moins une de ces étiquettes. */
  labelsAny?: string[];
  /** Identifiants des documents trouvés par votre recherche par mots-clés, du meilleur au moins bon. */
  keywordHits?: string[];
  /** Espace du client final (mode C) : la recherche ne voit que lui. Absent : défaut. */
  tenant?: string;
  requestId?: string;
  /** Délai de cet appel, en millisecondes. */
  timeoutMs?: number;
}

/** Paramètre `?tenant=` des routes sans corps (mode C). */
const tenantQuery = (tenant?: string) => (tenant ? `?tenant=${encodeURIComponent(tenant)}` : "");

export interface SearchOutcome extends SearchResponse {
  request_id: string;
  /**
   * WYRLO injoignable, surchargé ou masquage local en échec : `results` est vide, à
   * compléter par votre propre recherche. Jamais d'exception pour une panne.
   */
  degraded: boolean;
}

export class WyrloError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | ApiErrorCode
      | "missing_api_key"
      | "insecure_base_url"
      /** WYRLO injoignable ou en panne (index, effacement, chiffres) : à refaire plus tard. */
      | "unavailable"
      /** `index()` avec l'option `mask` : voir `IndexInput.allowUnmasked`. */
      | "mask_unsupported",
    message: string,
    readonly details?: { field: string; issue: string }[],
  ) {
    super(message);
    this.name = "WyrloError";
  }
}

/** https, ou la machine locale (tests, relais local) : jamais la clé en clair (SEC-33). */
function adresseSure(adresse: string): boolean {
  try {
    const url = new URL(adresse);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

const ALL_STEPS: SkippedStep[] = ["rerank", "injection_check", "consistency", "verification"];

function env(name: string): string | undefined {
  const process = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return process?.env?.[name];
}

function newRequestId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type MaskOutcome =
  | { ok: true; texts: string[]; restore: (text: string) => string; info: LocalMasking }
  | { ok: false };

/** Masque les textes d'un appel ; tout échec (exception, réponse invalide) → ok: false. */
async function applyMask(mask: boolean | Masker, texts: string[]): Promise<MaskOutcome> {
  try {
    if (typeof mask === "function") {
      const out = await mask([...texts]);
      if (
        !Array.isArray(out) ||
        out.length !== texts.length ||
        out.some((t) => typeof t !== "string")
      ) {
        return { ok: false };
      }
      return { ok: true, texts: out, restore: (t) => t, info: { method: "custom", counts: null } };
    }
    const masked = maskTexts(texts);
    return {
      ok: true,
      texts: masked.texts,
      restore: (t) => unmaskText(t, masked.values),
      info: { method: "rules", counts: masked.counts },
    };
  } catch {
    return { ok: false };
  }
}
/** Temps restant minimal pour tenter un nouvel appel dans le délai. */
const MIN_ATTEMPT_MS = 300;

export class Wyrlo {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly region: string;
  /** En-tête Accept-Language (option `locale`), vide sans option. */
  private readonly language: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly doFetch: typeof fetch;
  private readonly mask: boolean | Masker;

  constructor(options: WyrloOptions = {}) {
    const apiKey = options.apiKey ?? env("WYRLO_API_KEY");
    if (!apiKey) {
      throw new WyrloError(
        0,
        "missing_api_key",
        "Missing API key: pass apiKey or set WYRLO_API_KEY.",
      );
    }
    this.apiKey = apiKey;
    // Une valeur vide retombe sur l'adresse par défaut, comme dans le SDK Python.
    this.baseUrl = (
      options.baseUrl?.trim() ||
      env("WYRLO_BASE_URL")?.trim() ||
      DEFAULT_BASE_URL
    ).replace(/\/+$/, "");
    if (!adresseSure(this.baseUrl)) {
      throw new WyrloError(
        0,
        "insecure_base_url",
        "API address refused: https required (the key would be sent in clear text).",
      );
    }
    // Une valeur vide retombe sur Paris : ne jamais laisser la région au hasard.
    this.region = options.region?.trim() || env("WYRLO_REGION")?.trim() || DEFAULT_REGION;
    this.language = options.locale ? { "accept-language": options.locale } : {};
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.maxRetries = Math.max(0, options.maxRetries ?? 1);
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.mask = options.mask ?? false;
  }

  /**
   * Vérifie une réponse de votre RAG. Ne lève jamais d'exception pour une panne de
   * WYRLO ; lève une `WyrloError` si la clé ou la requête sont invalides.
   */
  async guard(input: GuardInput): Promise<GuardResult> {
    const answer = (input.generate ? await input.generate(input.passages) : input.answer) ?? "";
    const requestId = input.requestId ?? newRequestId();
    const timeoutMs = input.timeoutMs ?? this.timeoutMs;
    const started = Date.now();

    // Masquage côté client : les textes masqués partent, jamais les valeurs. En échec,
    // rien n'est envoyé (même règle stricte que le moteur avant Mistral).
    let question = input.question;
    let sentAnswer = answer;
    let passages = input.passages;
    let restore = (text: string) => text;
    let localMasking: LocalMasking | null = null;
    if (this.mask) {
      const masked = await applyMask(this.mask, [
        input.question,
        answer,
        ...input.passages.map((p) => p.text),
      ]);
      if (!masked.ok) {
        return this.degradedResult(input, answer, requestId, started, {
          reason:
            "Local masking failed: nothing was sent to WYRLO, answer passed through without verification.",
          steps: [...ALL_STEPS, "anonymize"],
          localMasking: null,
        });
      }
      const [q = "", a = "", ...texts] = masked.texts;
      question = q;
      sentAnswer = a;
      passages = input.passages.map((p, i) => {
        const text = texts[i] ?? "";
        // Texte changé par le masquage : son empreinte ne peut plus correspondre à celle de
        // l'index, l'adresse est retirée pour ne pas signaler à tort un passage « périmé ».
        if (p.address && text !== p.text) {
          const rest = { ...p, text };
          delete rest.address;
          return rest;
        }
        return { ...p, text };
      });
      restore = masked.restore;
      localMasking = masked.info;
    }
    const body: GuardRequest = {
      question,
      answer: sentAnswer,
      passages,
      ...(input.language ? { language: input.language } : {}),
      request_id: requestId,
    };

    // Délai total : nouvelles tentatives comprises, jamais au-delà de `timeoutMs`.
    let overloaded = false;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) {
        const pause = Math.min(200 * 2 ** (attempt - 1), 1_000);
        if (timeoutMs - (Date.now() - started) - pause < MIN_ATTEMPT_MS) break;
        await sleep(pause);
      }
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) break;
      const outcome = await this.send(body, remaining);
      if (outcome.kind === "ok") {
        return {
          ...outcome.response,
          // Vraies valeurs remises (règles intégrées) : elles n'ont jamais quitté la machine.
          reason: restore(outcome.response.reason),
          unsupported_sentences: (outcome.response.unsupported_sentences ?? []).map(restore),
          settings_variant: outcome.response.settings_variant ?? null,
          quota_exceeded: outcome.response.quota_exceeded === true,
          answer,
          // Serveur antérieur au champ `degraded` : déduit des étapes sautées et du plafond.
          degraded:
            outcome.response.degraded === true ||
            outcome.response.quota_exceeded === true ||
            outcome.response.confidence === "unverified" ||
            (outcome.response.skipped_steps?.length ?? 0) > 0,
          request_id: requestId,
          local_masking: localMasking,
        };
      }
      if (outcome.kind === "client_error") throw outcome.error;
      // Service surchargé : pas de nouvel essai, réponse transmise en mode dégradé.
      if (outcome.kind === "overloaded") {
        overloaded = true;
        break;
      }
    }

    return this.degradedResult(input, answer, requestId, started, {
      reason: overloaded
        ? "WYRLO temporarily overloaded: answer passed through without verification."
        : "WYRLO unreachable: answer passed through without verification.",
      steps: ALL_STEPS,
      localMasking,
    });
  }

  /** Résultat dégradé : la réponse passe, sans vérification (jamais bloquant). */
  private degradedResult(
    input: GuardInput,
    answer: string,
    requestId: string,
    started: number,
    why: { reason: string; steps: SkippedStep[]; localMasking: LocalMasking | null },
  ): GuardResult {
    return {
      trace_id: null,
      decision: "answer",
      confidence: "unverified",
      confidence_score: null,
      reason: why.reason,
      passages: input.passages.map((p, i) => ({
        id: p.id ?? `p${i + 1}`,
        kept: true,
        rank: null,
        score: null,
        injection: false,
      })),
      unsupported_sentences: [],
      injection_detected: false,
      skipped_steps: why.steps,
      settings_version: null,
      language: input.language?.trim().toLowerCase().split("-")[0] || null,
      rerank_method: "none",
      verification_method: "none",
      latency_ms: Date.now() - started,
      quota_exceeded: false,
      settings_variant: null,
      answer,
      degraded: true,
      request_id: requestId,
      local_masking: why.localMasking,
    };
  }

  /**
   * Étape à appeler AVANT votre recherche : renvoie la question à chercher, enrichie du
   * vocabulaire du projet (et, pendant un test partiel, de la variante attribuée à cette
   * requête). Passez ensuite le même `requestId` à `guard`. Ne lève jamais d'exception
   * pour une panne de WYRLO : la question d'origine est alors renvoyée telle quelle.
   */
  async prepare(input: {
    question: string;
    requestId?: string;
    timeoutMs?: number;
  }): Promise<PrepareResponse & { request_id: string; degraded: boolean }> {
    const requestId = input.requestId ?? newRequestId();
    const fallback = {
      query: input.question,
      added_terms: [],
      request_id: requestId,
      settings_version: null,
      settings_variant: null,
      degraded: true,
    };
    // Masquage côté client : la question masquée part ; en échec, rien n'est envoyé.
    let question = input.question;
    let restore = (text: string) => text;
    if (this.mask) {
      const masked = await applyMask(this.mask, [input.question]);
      if (!masked.ok) return fallback;
      question = masked.texts[0] ?? "";
      restore = masked.restore;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? this.timeoutMs);
    try {
      const response = await this.doFetch(`${this.baseUrl}/guard/prepare`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          "x-wyrlo-sdk": `typescript/${SDK_VERSION}`,
          "x-wyrlo-api-version": API_VERSION,
          "x-region": this.region,
          ...this.language,
        },
        body: JSON.stringify({ question, request_id: requestId }),
        signal: controller.signal,
        // Aucune redirection suivie : la clé ne part jamais vers une autre adresse (SEC-33).
        redirect: "error",
      });
      const payload = (await response.json().catch(() => null)) as PrepareResponse | null;
      if (response.status === 401 || response.status === 422) {
        const error = isErrorBody(payload) ? payload.error : null;
        throw new WyrloError(
          response.status,
          error?.code ?? "invalid_request",
          error?.message ?? `Request refused (${response.status}).`,
          error?.details,
        );
      }
      if (!response.ok || !payload || typeof payload.query !== "string") return fallback;
      if (question === input.question)
        return { ...payload, request_id: requestId, degraded: false };
      // Question masquée : la recherche se fait avec la vraie question, enrichie des termes
      // ajoutés (« question (terme 1, terme 2) »).
      // Forme inattendue : valeurs remises (règles intégrées), sinon la question d'origine.
      const query = payload.query.startsWith(question)
        ? input.question + payload.query.slice(question.length)
        : this.mask === true
          ? restore(payload.query)
          : input.question;
      return {
        ...payload,
        query,
        added_terms: (payload.added_terms ?? []).map(restore),
        request_id: requestId,
        degraded: false,
      };
    } catch (error) {
      if (error instanceof WyrloError) throw error;
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Retour de l'utilisateur final sur une réponse donnée (pouce en haut : `helpful: true`),
   * avec le `trace_id` renvoyé par `guard`. Aucun texte n'est envoyé. WYRLO s'en sert pour
   * juger ses corrections sans appel payant. Ne lève jamais d'exception pour une panne de
   * WYRLO : `recorded` vaut alors faux.
   */
  async feedback(input: {
    traceId: string;
    helpful: boolean;
    timeoutMs?: number;
  }): Promise<{ recorded: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? this.timeoutMs);
    try {
      const response = await this.doFetch(`${this.baseUrl}/guard/feedback`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          "x-wyrlo-sdk": `typescript/${SDK_VERSION}`,
          "x-wyrlo-api-version": API_VERSION,
          "x-region": this.region,
          ...this.language,
        },
        body: JSON.stringify({ trace_id: input.traceId, helpful: input.helpful }),
        signal: controller.signal,
        // Aucune redirection suivie : la clé ne part jamais vers une autre adresse (SEC-33).
        redirect: "error",
      });
      if (response.status === 401 || response.status === 422) {
        const payload = await response.json().catch(() => null);
        const error = isErrorBody(payload) ? payload.error : null;
        throw new WyrloError(
          response.status,
          error?.code ?? "invalid_request",
          error?.message ?? `Request refused (${response.status}).`,
          error?.details,
        );
      }
      return { recorded: response.ok };
    } catch (error) {
      if (error instanceof WyrloError) throw error;
      return { recorded: false };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Indexe un document (mode B) : `PUT /guard/index/documents/{document}`. WYRLO découpe,
   * masque et calcule les vecteurs, puis oublie le texte. La même `version` déjà indexée
   * répond « unchanged » sans rien recalculer ni compter. `title` : titre du document, placé
   * en tête de chaque passage pour les vecteurs, jamais conservé (changez la `version` si le
   * titre change). Lève une `WyrloError` pour toute erreur, panne comprise (`unavailable`) :
   * l'appel peut être refait sans risque.
   */
  async index(document: string, input: IndexInput): Promise<IndexPutResponse> {
    if (this.mask && input.allowUnmasked !== true) {
      throw new WyrloError(
        0,
        "mask_unsupported",
        "mask option on: index() does not send your text without allowUnmasked: true.",
      );
    }
    const body: IndexPutRequest = {
      version: input.version,
      ...(input.text !== undefined ? { text: input.text } : { passages: input.passages }),
      ...(input.title ? { title: input.title } : {}),
      ...(input.labels ? { labels: input.labels } : {}),
      ...(input.tenant ? { tenant: input.tenant } : {}),
      request_id: input.requestId ?? newRequestId(),
    };
    const out = await this.call(
      "PUT",
      `/guard/index/documents/${encodeURIComponent(document)}`,
      body,
      input.timeoutMs ?? INDEX_TIMEOUT_MS,
    );
    if (out.kind !== "ok") throw this.callError(out);
    return out.payload as IndexPutResponse;
  }
  /**
   * Indexe un lot de documents en un appel : `POST /guard/index/documents`, 100 documents au
   * plus (corps de 512 Kio au plus), dans le même espace. Chaque document a les champs
   * d'`index()` et son identifiant `id`. Un document refusé n'empêche pas les autres :
   * `results[i].status` vaut « failed » avec `error` ; avec `error.code` « overloaded »,
   * renvoyez-le plus tard. Lève une `WyrloError` si tout le lot est refusé (forme, clé, mode
   * B coupé) ou en panne : l'appel peut être refait sans risque.
   */
  async indexMany(
    documents: IndexBatchRequest["documents"],
    options: {
      tenant?: string;
      requestId?: string;
      timeoutMs?: number;
      allowUnmasked?: boolean;
    } = {},
  ): Promise<IndexBatchResponse> {
    if (this.mask && options.allowUnmasked !== true) {
      throw new WyrloError(
        0,
        "mask_unsupported",
        "mask option on: indexMany() does not send your text without allowUnmasked: true.",
      );
    }
    const body: IndexBatchRequest = {
      documents,
      ...(options.tenant ? { tenant: options.tenant } : {}),
      request_id: options.requestId ?? newRequestId(),
    };
    const out = await this.call(
      "POST",
      "/guard/index/documents",
      body,
      options.timeoutMs ?? INDEX_TIMEOUT_MS,
    );
    if (out.kind !== "ok") throw this.callError(out);
    return out.payload as IndexBatchResponse;
  }

  /**
   * Retire un document de l'index (tous ses passages) : `DELETE
   * /guard/index/documents/{document}`. Toujours possible, même mode B coupé ; un document
   * inconnu rend `deleted: false`. Lève une `WyrloError` pour toute erreur, panne comprise.
   * `tenant` : espace du client final (mode C) où se trouve le document.
   */
  async remove(
    document: string,
    options: { timeoutMs?: number; tenant?: string } = {},
  ): Promise<IndexDeleteResponse> {
    const out = await this.call(
      "DELETE",
      `/guard/index/documents/${encodeURIComponent(document)}${tenantQuery(options.tenant)}`,
      null,
      options.timeoutMs ?? INDEX_TIMEOUT_MS,
    );
    if (out.kind !== "ok") throw this.callError(out);
    return out.payload as IndexDeleteResponse;
  }

  /**
   * Chiffres de l'index du projet (`GET /guard/index/stats`), sans aucun identifiant ; avec
   * `tenant`, ceux d'un seul espace (mode C).
   */
  async indexStats(
    options: { timeoutMs?: number; tenant?: string } = {},
  ): Promise<IndexStatsResponse> {
    const out = await this.call(
      "GET",
      `/guard/index/stats${tenantQuery(options.tenant)}`,
      null,
      options.timeoutMs ?? this.timeoutMs,
    );
    if (out.kind !== "ok") throw this.callError(out);
    return out.payload as IndexStatsResponse;
  }

  /**
   * Efface tout l'espace d'un client final (mode C) : `DELETE /guard/index?tenant=…`, tout de
   * suite, même mode B coupé. Rend le nombre de documents et de passages effacés. Lève une
   * `WyrloError` pour toute erreur, panne comprise.
   */
  async removeTenant(
    tenant: string,
    options: { timeoutMs?: number } = {},
  ): Promise<IndexTenantDeleteResponse> {
    if (!tenant) throw new WyrloError(0, "invalid_request", "tenant: identifier expected.");
    const out = await this.call(
      "DELETE",
      `/guard/index${tenantQuery(tenant)}`,
      null,
      options.timeoutMs ?? INDEX_TIMEOUT_MS,
    );
    if (out.kind !== "ok") throw this.callError(out);
    return out.payload as IndexTenantDeleteResponse;
  }

  /**
   * Recherche dans l'index (`POST /guard/search`) : les adresses des passages les plus
   * proches, sans texte. Relisez le texte chez vous (`start`, `length`) et passez chaque
   * passage à `guard` avec son `address` : un document modifié depuis son indexation sera
   * signalé « périmé ». Ne lève jamais d'exception pour une panne (liste vide, `degraded`) ;
   * lève une `WyrloError` si la clé ou la requête sont refusées, ou le mode B coupé (403).
   */
  async search(input: SearchInput): Promise<SearchOutcome> {
    const requestId = input.requestId ?? newRequestId();
    const degraded: SearchOutcome = { results: [], request_id: requestId, degraded: true };
    let question = input.question;
    if (this.mask) {
      const masked = await applyMask(this.mask, [input.question]);
      if (!masked.ok) return degraded;
      question = masked.texts[0] ?? "";
    }
    const body: SearchRequest = {
      question,
      ...(input.k !== undefined ? { k: input.k } : {}),
      ...(input.labelsAny ? { labels_any: input.labelsAny } : {}),
      ...(input.keywordHits
        ? { keyword_hits: input.keywordHits.map((document) => ({ document })) }
        : {}),
      ...(input.tenant ? { tenant: input.tenant } : {}),
      request_id: requestId,
    };
    const out = await this.call("POST", "/guard/search", body, input.timeoutMs ?? this.timeoutMs);
    if (out.kind === "client_error") throw out.error;
    if (out.kind !== "ok") return degraded;
    const payload = out.payload as Partial<SearchResponse> | null;
    if (!payload || !Array.isArray(payload.results)) return degraded;
    return { results: payload.results, request_id: requestId, degraded: false };
  }

  /** Appel simple (routes de l'index) : pas de nouvel essai, délai borné. */
  private async call(
    method: "GET" | "PUT" | "DELETE" | "POST",
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<
    | { kind: "ok"; payload: unknown }
    | { kind: "client_error"; error: WyrloError }
    | { kind: "unavailable"; status: number }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...(body === null ? {} : { "content-type": "application/json" }),
          "x-wyrlo-sdk": `typescript/${SDK_VERSION}`,
          "x-wyrlo-api-version": API_VERSION,
          // Le texte d'un document est traité à Paris, pas dans la région la plus proche.
          "x-region": this.region,
          ...this.language,
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        // Aucune redirection suivie : la clé ne part jamais vers une autre adresse (SEC-33).
        redirect: "error",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.ok && payload !== null) return { kind: "ok", payload };
      // Surchargé, hors de Paris (421) ou en panne : rien n'a été fait, à refaire.
      if (
        response.status === 429 ||
        response.status === 421 ||
        response.status >= 500 ||
        response.ok
      ) {
        return { kind: "unavailable", status: response.status };
      }
      const error = isErrorBody(payload) ? payload.error : null;
      return {
        kind: "client_error",
        error: new WyrloError(
          response.status,
          error?.code ?? "invalid_request",
          error?.message ?? `Request refused (${response.status}).`,
          error?.details,
        ),
      };
    } catch {
      return { kind: "unavailable", status: 0 };
    } finally {
      clearTimeout(timer);
    }
  }

  private callError(
    out: { kind: "client_error"; error: WyrloError } | { kind: "unavailable"; status: number },
  ): WyrloError {
    if (out.kind === "client_error") return out.error;
    return new WyrloError(
      out.status,
      "unavailable",
      "WYRLO unreachable or temporarily overloaded: nothing was done, try again later.",
    );
  }

  private async send(
    body: GuardRequest,
    timeoutMs: number,
  ): Promise<
    | { kind: "ok"; response: GuardResponse }
    | { kind: "client_error"; error: WyrloError }
    | { kind: "overloaded" }
    | { kind: "unavailable" }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.doFetch(`${this.baseUrl}/guard`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          "x-wyrlo-sdk": `typescript/${SDK_VERSION}`,
          "x-wyrlo-api-version": API_VERSION,
          // Traitement du texte en clair à Paris, pas dans la région la plus proche.
          "x-region": this.region,
          ...this.language,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        // Aucune redirection suivie : la clé ne part jamais vers une autre adresse (SEC-33).
        redirect: "error",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.ok && isGuardResponse(payload)) return { kind: "ok", response: payload };
      if (response.status === 503 || response.status === 429) return { kind: "overloaded" };
      // Reçu hors de Paris et refusé sans lecture (421) : comme une panne, jamais bloquant.
      if (response.status === 421) return { kind: "unavailable" };
      if (response.status >= 400 && response.status < 500) {
        const error = isErrorBody(payload) ? payload.error : null;
        return {
          kind: "client_error",
          error: new WyrloError(
            response.status,
            error?.code ?? "invalid_request",
            error?.message ?? `Request refused (${response.status}).`,
            error?.details,
          ),
        };
      }
      return { kind: "unavailable" };
    } catch {
      return { kind: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }
}

function isGuardResponse(value: unknown): value is GuardResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (typeof v.trace_id === "string" || v.trace_id === null) &&
    (v.decision === "answer" || v.decision === "abstain") &&
    typeof v.confidence === "string" &&
    Array.isArray(v.passages)
  );
}

function isErrorBody(value: unknown): value is {
  error: { code: ApiErrorCode; message: string; details?: { field: string; issue: string }[] };
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { error?: { code?: unknown } }).error?.code === "string"
  );
}
