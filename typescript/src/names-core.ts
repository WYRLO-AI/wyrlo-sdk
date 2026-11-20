/**
 * Masquage des noms de personnes : partie sans dépendance (voir `names.ts`).
 */
import { maskTexts, type MaskedTexts } from "./masking.ts";

/** Position d'un nom de personne dans un texte (fin exclue). */
export interface NameSpan {
  start: number;
  end: number;
}

/** Détecteur de noms : rend les positions des noms de personnes d'un texte. */
export type NameFinder = (text: string) => NameSpan[] | Promise<NameSpan[]>;

const MARQUE = /\[[A-Z]+_\d+\]/g;
const LETTRE = /[\p{L}\p{M}]/u;

/** Positions valides, élargies au mot entier, sans chevauchement, hors des marques. */
function nettoyer(texte: string, positions: NameSpan[]): NameSpan[] {
  const marques = [...texte.matchAll(MARQUE)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
  }));
  const valides: NameSpan[] = [];
  for (const p of positions) {
    if (!p || !Number.isInteger(p.start) || !Number.isInteger(p.end)) continue;
    let { start, end } = p;
    if (start < 0 || end > texte.length || start >= end) continue;
    while (start > 0 && LETTRE.test(texte[start - 1] ?? "") && LETTRE.test(texte[start] ?? ""))
      start -= 1;
    while (end < texte.length && LETTRE.test(texte[end] ?? "") && LETTRE.test(texte[end - 1] ?? ""))
      end += 1;
    while (start < end && /\s/.test(texte[start] ?? "")) start += 1;
    while (end > start && /\s/.test(texte[end - 1] ?? "")) end -= 1;
    if (end - start < 2) continue;
    if (marques.some((m) => start < m.end && end > m.start)) continue;
    valides.push({ start, end });
  }
  valides.sort((a, b) => a.start - b.start || b.end - a.end);
  const sorties: NameSpan[] = [];
  for (const v of valides) {
    const dernier = sorties[sorties.length - 1];
    if (dernier && v.start < dernier.end) continue;
    sorties.push(v);
  }
  return sorties;
}

/**
 * Règles intégrées, puis noms de personnes : chaque nom devient « [PERSONNE_n] », la même
 * marque pour un même nom dans tous les textes de l'appel (sans tenir compte de la casse).
 * Une erreur du détecteur remonte : l'appelant n'envoie alors rien.
 */
export async function maskTextsWithNames(
  texts: string[],
  finder: NameFinder,
): Promise<MaskedTexts> {
  const masked = maskTexts(texts);
  const trouves: NameSpan[][] = [];
  const connus = new Set<string>();
  for (const texte of masked.texts) {
    const positions = nettoyer(texte, await finder(texte));
    for (const p of positions) connus.add(texte.slice(p.start, p.end));
    trouves.push(positions);
  }
  // Un nom reconnu une fois est masqué partout dans l'appel, même écrit sans majuscules.
  const repetitions = [...connus]
    .filter((nom) => nom.length >= 4)
    .sort((a, b) => b.length - a.length)
    .map((nom) => nom.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
  const partout = repetitions.length
    ? new RegExp(`(?<![\\p{L}\\p{M}])(?:${repetitions.join("|")})(?![\\p{L}\\p{M}])`, "giu")
    : null;
  const numeros = new Map<string, number>();
  const sorties: string[] = [];
  masked.texts.forEach((texte, i) => {
    const repris = partout
      ? [...texte.matchAll(partout)].map((m) => ({ start: m.index, end: m.index + m[0].length }))
      : [];
    const positions = nettoyer(texte, [...(trouves[i] ?? []), ...repris]);
    let sortie = "";
    let position = 0;
    for (const p of positions) {
      const valeur = texte.slice(p.start, p.end);
      const cle = valeur.toLowerCase().replace(/\s+/g, " ");
      let n = numeros.get(cle);
      if (n === undefined) {
        n = numeros.size + 1;
        numeros.set(cle, n);
      }
      const marque = `[PERSONNE_${n}]`;
      if (!masked.values.has(marque)) masked.values.set(marque, valeur);
      masked.counts.PERSONNE = (masked.counts.PERSONNE ?? 0) + 1;
      sortie += texte.slice(position, p.start) + marque;
      position = p.end;
    }
    sorties.push(sortie + texte.slice(position));
  });
  return { texts: sorties, counts: masked.counts, values: masked.values };
}

/** Jeton rendu par la classification de `@huggingface/transformers`. */
export interface NameToken {
  entity: string;
  score: number;
  word: string;
}

/**
 * Positions des noms de personnes à partir des jetons d'un modèle (étiquettes « B-PER »,
 * « I-PER »). La bibliothèque ne rend pas les positions : chaque jeton est retrouvé dans le
 * texte, dans l'ordre. Exporté pour les tests.
 */
export function spansFromTokens(text: string, tokens: NameToken[], minScore = 0.5): NameSpan[] {
  const spans: NameSpan[] = [];
  let curseur = 0;
  let enCours: NameSpan | null = null;
  for (const jeton of tokens) {
    const suite = jeton.word.startsWith("##");
    const mot = suite ? jeton.word.slice(2) : jeton.word;
    if (!mot || /^\[[A-Z]+\]$/.test(mot)) continue;
    const debut = text.indexOf(mot, curseur);
    if (debut < 0) continue;
    const fin = debut + mot.length;
    const personne = /^[BI]-PER/.test(jeton.entity) && jeton.score >= minScore;
    if (personne) {
      const entre: string = enCours ? text.slice(enCours.end, debut) : "";
      if (enCours && /^[\s'’.-]{0,2}$/.test(entre) && !entre.includes("\n")) enCours.end = fin;
      else {
        if (enCours) spans.push(enCours);
        enCours = { start: debut, end: fin };
      }
    } else if (enCours && !(suite && debut === enCours.end)) {
      spans.push(enCours);
      enCours = null;
    } else if (enCours) {
      // Suite d'un mot commencé dans un nom : le mot entier fait partie du nom.
      enCours.end = fin;
    }
    curseur = fin;
  }
  if (enCours) spans.push(enCours);
  return spans;
}

/** Morceaux d'au plus `taille` caractères, coupés sur une fin de phrase ou un espace. */
export function splitForModel(text: string, taille = 800): { offset: number; text: string }[] {
  const morceaux: { offset: number; text: string }[] = [];
  let debut = 0;
  while (debut < text.length) {
    let fin = Math.min(text.length, debut + taille);
    if (fin < text.length) {
      const fenetre = text.slice(debut, fin);
      const coupe = Math.max(
        fenetre.lastIndexOf("\n"),
        fenetre.lastIndexOf(". "),
        fenetre.lastIndexOf(" "),
      );
      if (coupe > taille / 2) fin = debut + coupe + 1;
    }
    morceaux.push({ offset: debut, text: text.slice(debut, fin) });
    debut = fin;
  }
  return morceaux;
}
