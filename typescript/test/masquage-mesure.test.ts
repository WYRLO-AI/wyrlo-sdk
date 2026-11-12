import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { trouver } from "../src/masking.ts";
import { jeuMasquage, type CasMasquage } from "./masquage-jeu.ts";

// Mesure du masquage (règles du moteur, identiques dans le SDK) sur le jeu fictif annoté.
// WYRLO_MESURE=<fichier> y écrit le tableau complet (docs/tests/masquage-integre-mesure-*.md).

interface Compte {
  n: number;
  ok: number;
}

/** Intervalle de Wilson à 95 %, en pourcentage. */
export function wilson(ok: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.959964;
  const p = ok / n;
  const centre = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const demi = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
  return [Math.max(0, centre - demi) * 100, Math.min(1, centre + demi) * 100];
}

export function mesurer(jeu: CasMasquage[]) {
  const rappel = new Map<string, Compte>(); // par type attendu : valeur entièrement masquée
  const exact = new Map<string, Compte>(); // … et avec le bon type
  const parForme = new Map<string, Compte>();
  const leurres = new Map<string, Compte>(); // ok = laissé intact
  const precision = new Map<string, Compte>(); // par type trouvé : masque sur une vraie valeur
  const ajouter = (m: Map<string, Compte>, cle: string, ok: boolean) => {
    const c = m.get(cle) ?? { n: 0, ok: 0 };
    c.n += 1;
    if (ok) c.ok += 1;
    m.set(cle, c);
  };
  for (const cas of jeu) {
    const trouves = trouver(cas.texte);
    const chevauche = (a: { debut: number; fin: number }, b: { debut: number; fin: number }) =>
      a.debut < b.fin && b.debut < a.fin;
    for (const r of cas.reperes) {
      const couvrant = trouves.filter((t) => t.debut <= r.debut && t.fin >= r.fin);
      if (r.type === "LEURRE") {
        ajouter(leurres, r.forme, !trouves.some((t) => chevauche(t, r)));
        continue;
      }
      ajouter(rappel, r.type, couvrant.length > 0);
      ajouter(
        exact,
        r.type,
        couvrant.some((t) => t.type === r.type),
      );
      ajouter(parForme, `${r.type} · ${r.forme}`, couvrant.length > 0);
    }
    for (const t of trouves) {
      ajouter(
        precision,
        t.type,
        cas.reperes.some((r) => r.type !== "LEURRE" && r.type !== "PERSONNE" && chevauche(t, r)),
      );
    }
  }
  return { rappel, exact, parForme, leurres, precision };
}

const pct = (c: Compte | undefined) => (c && c.n ? (100 * c.ok) / c.n : 0);
const ligne = (nom: string, c: Compte) => {
  const [bas, haut] = wilson(c.ok, c.n);
  return `| ${nom} | ${c.ok} / ${c.n} | ${pct(c).toFixed(1)} % | ${bas.toFixed(1)} à ${haut.toFixed(1)} % |`;
};

describe("mesure du masquage sur le jeu fictif annoté", () => {
  const jeu = jeuMasquage();
  const m = mesurer(jeu);

  it("le jeu est reproductible et assez grand", () => {
    expect(jeuMasquage(50)).toEqual(jeuMasquage(50));
    expect(jeu.length).toBe(2000);
    for (const [, c] of m.rappel) expect(c.n).toBeGreaterThanOrEqual(50);
  });

  it("types couverts : presque tout est masqué, avec le bon type", () => {
    for (const type of ["EMAIL", "TELEPHONE", "IBAN", "CARTE", "NIR", "IP", "PIECE", "SECRET"]) {
      expect(pct(m.exact.get(type)), type).toBeGreaterThanOrEqual(99);
    }
  });

  it("adresses : numéro et type de voie masqués ; lieu-dit sans numéro, non (limite)", () => {
    for (const forme of ["FR complète", "FR bis sans ville", "EN", "numéro collé (221B)"]) {
      expect(pct(m.parForme.get(`ADRESSE · ${forme}`)), forme).toBeGreaterThanOrEqual(99);
    }
    expect(pct(m.parForme.get("ADRESSE · lieu-dit sans numéro"))).toBe(0);
  });

  it("noms de personnes : jamais masqués (limite assumée, sans modèle de langue)", () => {
    expect(pct(m.rappel.get("PERSONNE"))).toBe(0);
  });

  it("leurres : dates, montants, commandes, versions et clés fausses restent", () => {
    for (const forme of [
      "commande",
      "référence",
      "date",
      "heure",
      "montant",
      "version",
      "carte Luhn faux",
      "lot sans mot-clé",
      "code postal seul",
      "SIRET",
    ]) {
      expect(pct(m.leurres.get(forme)), forme).toBe(100);
    }
    // Une suite de 13 à 19 chiffres passe le contrôle de Luhn une fois sur dix : sans
    // contexte, elle est masquée comme une carte (masquage de trop, jamais une fuite).
    for (const forme of ["IBAN clé fausse", "15 chiffres, clé fausse, sans mot-clé"]) {
      expect(pct(m.leurres.get(forme)), forme).toBeGreaterThanOrEqual(85);
    }
  });

  it("précision : un masque tombe sur une vraie valeur au moins 95 fois sur 100", () => {
    for (const [type, c] of m.precision) expect(pct(c), type).toBeGreaterThanOrEqual(95);
  });

  it("tableau complet (WYRLO_MESURE=<fichier>)", () => {
    const fichier = process.env.WYRLO_MESURE;
    if (!fichier) return;
    const sortie = [
      `Jeu : ${jeu.length} textes, graine 20261105.`,
      "",
      "| Type | Masqués | Taux | Intervalle à 95 % |",
      "| --- | --- | --- | --- |",
      ...[...m.rappel].map(([k, c]) => ligne(k, c)),
      "",
      "| Type (bon type) | Masqués | Taux | Intervalle à 95 % |",
      "| --- | --- | --- | --- |",
      ...[...m.exact].map(([k, c]) => ligne(k, c)),
      "",
      "| Forme | Masqués | Taux | Intervalle à 95 % |",
      "| --- | --- | --- | --- |",
      ...[...m.parForme].sort().map(([k, c]) => ligne(k, c)),
      "",
      "| Leurre (doit rester) | Intacts | Taux | Intervalle à 95 % |",
      "| --- | --- | --- | --- |",
      ...[...m.leurres].map(([k, c]) => ligne(k, c)),
      "",
      "| Type trouvé | Sur une vraie valeur | Précision | Intervalle à 95 % |",
      "| --- | --- | --- | --- |",
      ...[...m.precision].map(([k, c]) => ligne(k, c)),
    ].join("\n");
    writeFileSync(fichier, `${sortie}\n`);
  });
});
