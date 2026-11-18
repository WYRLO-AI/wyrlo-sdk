import { describe, expect, it } from "vitest";

import { Wyrlo } from "../src/index.ts";
import {
  maskTextsWithNames,
  type NameFinder,
  spansFromTokens,
  splitForModel,
} from "../src/names.ts";
import { unmaskText } from "../src/masking.ts";

/** Détecteur factice : rend les positions des noms donnés. */
const finderOf =
  (...noms: string[]): NameFinder =>
  (text) =>
    noms.flatMap((nom) => {
      const i = text.indexOf(nom);
      return i < 0 ? [] : [{ start: i, end: i + nom.length }];
    });

describe("masquage des noms de personnes", () => {
  it("masque les noms après les règles, une même marque pour un même nom", async () => {
    const masked = await maskTextsWithNames(
      [
        "Camille Durand (camille.durand@example.com) a écrit à Jean-Pierre Lefèvre.",
        "Réponse pour camille durand, puis pour Jean-Pierre Lefèvre.",
      ],
      finderOf("Camille Durand", "Jean-Pierre Lefèvre"),
    );
    expect(masked.texts).toEqual([
      "[PERSONNE_1] ([EMAIL_1]) a écrit à [PERSONNE_2].",
      "Réponse pour [PERSONNE_1], puis pour [PERSONNE_2].",
    ]);
    expect(masked.counts).toEqual({ EMAIL: 1, PERSONNE: 4 });
    expect(unmaskText(masked.texts[0] ?? "", masked.values)).toBe(
      "Camille Durand (camille.durand@example.com) a écrit à Jean-Pierre Lefèvre.",
    );
  });

  it("élargit au mot entier, écarte les positions invalides et les marques", async () => {
    const texte = "Appeler Lefèvre au 06 12 34 56 78.";
    const masked = await maskTextsWithNames([texte], () => [
      { start: 8, end: 11 },
      { start: -1, end: 3 },
      { start: 5, end: 500 },
      { start: 19, end: 30 },
    ]);
    expect(masked.texts).toEqual(["Appeler [PERSONNE_1] au [TELEPHONE_1]."]);
  });

  it("ne masque pas un nom à l'intérieur d'un autre mot", async () => {
    const masked = await maskTextsWithNames(
      ["Rose Martin aime les roses et la rosée."],
      finderOf("Rose Martin"),
    );
    expect(masked.texts).toEqual(["[PERSONNE_1] aime les roses et la rosée."]);
  });

  it("retrouve les positions à partir des jetons du modèle", () => {
    const texte = "Mon collègue Jean-Pierre Lefèvre de Brénaval à Lyon.";
    const jetons = [
      ["O", "Mon"],
      ["O", "collègue"],
      ["B-PER", "Jean"],
      ["I-PER", "-"],
      ["I-PER", "Pierre"],
      ["I-PER", "Le"],
      ["I-PER", "##f"],
      ["I-PER", "##èvre"],
      ["O", "de"],
      ["B-ORG", "Br"],
      ["I-ORG", "##éna"],
      ["I-ORG", "##val"],
      ["O", "à"],
      ["B-LOC", "Lyon"],
      ["O", "."],
    ].map(([entity, word]) => ({ entity: entity ?? "O", word: word ?? "", score: 0.99 }));
    const spans = spansFromTokens(texte, jetons);
    expect(spans.map((s) => texte.slice(s.start, s.end))).toEqual(["Jean-Pierre Lefèvre"]);
    expect(spansFromTokens(texte, jetons, 0.999)).toEqual([]);
  });

  it("coupe les longs textes sans rien perdre", () => {
    const texte = "Une phrase assez longue pour le découpage. ".repeat(60);
    const morceaux = splitForModel(texte, 200);
    expect(morceaux.every((m) => m.text.length <= 200)).toBe(true);
    expect(morceaux.map((m) => m.text).join("")).toBe(texte);
    expect(morceaux.every((m) => texte.startsWith(m.text, m.offset))).toBe(true);
  });

  it("option mask du client : noms masqués à l'envoi, remis au retour", async () => {
    let envoye = "";
    const wyrlo = new Wyrlo({
      apiKey: "wyr_test_fictive",
      mask: { names: finderOf("Camille Durand") },
      fetch: async (_url, init) => {
        envoye = String(init?.body);
        return new Response(
          JSON.stringify({
            trace_id: "00000000-0000-4000-8000-000000000001",
            decision: "answer",
            confidence: "certain",
            confidence_score: 1,
            reason: "[PERSONNE_1] figure dans le passage.",
            passages: [],
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
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const result = await wyrlo.guard({
      question: "Le dossier de Camille Durand est-il complet ?",
      answer: "Le dossier de Camille Durand est complet.",
      passages: [{ text: "Dossier de Camille Durand : complet." }],
    });
    expect(envoye).not.toContain("Camille");
    expect(envoye).toContain("[PERSONNE_1]");
    expect(result.reason).toBe("Camille Durand figure dans le passage.");
    expect(result.local_masking).toEqual({ method: "rules+names", counts: { PERSONNE: 3 } });
  });

  it("détecteur en panne : rien n'est envoyé", async () => {
    let appels = 0;
    const wyrlo = new Wyrlo({
      apiKey: "wyr_test_fictive",
      mask: {
        names: () => {
          throw new Error("modèle absent");
        },
      },
      fetch: async () => {
        appels += 1;
        return new Response("{}");
      },
    });
    const result = await wyrlo.guard({ question: "q", answer: "a", passages: [{ text: "p" }] });
    expect(appels).toBe(0);
    expect(result.degraded).toBe(true);
  });
});
