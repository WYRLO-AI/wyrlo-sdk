/**
 * Masquage côté client (virage API du 05/11/2026) : les mêmes règles que le masquage
 * intégré au moteur de WYRLO, appliquées sur votre serveur AVANT l'envoi. Les valeurs
 * reconnues ne quittent jamais votre machine ; WYRLO reçoit des marques (« [EMAIL_1] »,
 * « [TELEPHONE_2] »…) qu'il sait traiter, et le SDK remet les vraies valeurs dans ce
 * qu'il vous rend.
 *
 * Ce qui est masqué, par des règles avec contrôle de validité :
 * - EMAIL ; TELEPHONE (France et international, avec indicatif) ; IBAN (clé mod 97) ;
 *   CARTE (13 à 19 chiffres, contrôle de Luhn) ; NIR (numéro de sécurité sociale, clé de
 *   contrôle, ou mot-clé proche) ; IP (IPv4, IPv6) ; PIECE (passeport, carte d'identité,
 *   avec un mot-clé proche) ; ADRESSE (numéro et type de voie, France et anglais, avec code
 *   postal et ville s'ils suivent) ; SECRET (clés d'API et jetons reconnaissables).
 *
 * Ce qui n'est PAS masqué : les noms de personnes et d'entreprises, et tout identifiant
 * sans forme reconnaissable (numéro client interne…). Pour eux, passez votre propre
 * fonction à l'option `mask` (par exemple Presidio, sur votre machine). Les dates,
 * montants et numéros de commande restent : la vérification doit pouvoir les comparer.
 *
 * COPIE des règles du masquage intégré au moteur de WYRLO : un test du moteur vérifie que
 * le code des règles est identique et que les deux donnent le même résultat sur le corpus
 * commun (test/masquage-corpus.json), que le SDK Python vérifie aussi.
 */

export type TypeMasque =
  "SECRET" | "EMAIL" | "IBAN" | "CARTE" | "NIR" | "TELEPHONE" | "IP" | "PIECE" | "ADRESSE";

interface Trouve {
  debut: number;
  fin: number;
  type: TypeMasque;
  valeur: string;
}

const chiffres = (s: string) => s.replace(/\D/g, "");

/** Clé IBAN (ISO 13616) : le reste de la division par 97 doit valoir 1. */
export function ibanValide(brut: string): boolean {
  const iban = brut.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const reordonne = iban.slice(4) + iban.slice(0, 4);
  let reste = 0;
  for (const c of reordonne) {
    const v = c >= "A" && c <= "Z" ? String(c.charCodeAt(0) - 55) : c;
    for (const d of v) reste = (reste * 10 + Number(d)) % 97;
  }
  return reste === 1;
}

/** Longueur des IBAN par pays (registre ISO 13616), pour l'Europe et ses voisins. */
const LONGUEURS_IBAN: Record<string, number> = {
  AD: 24,
  AT: 20,
  BA: 20,
  BE: 16,
  BG: 22,
  CH: 21,
  CY: 28,
  CZ: 24,
  DE: 22,
  DK: 18,
  EE: 20,
  ES: 24,
  FI: 18,
  FO: 18,
  FR: 27,
  GB: 22,
  GI: 23,
  GL: 18,
  GR: 27,
  HR: 21,
  HU: 28,
  IE: 22,
  IS: 26,
  IT: 27,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  MC: 27,
  MD: 24,
  ME: 22,
  MK: 19,
  MT: 31,
  NL: 18,
  NO: 15,
  PL: 28,
  PT: 25,
  RO: 24,
  RS: 22,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  TR: 26,
  UA: 29,
  VA: 22,
};

/**
 * Longueur, dans la valeur trouvée, de l'IBAN valide qui la commence (null sinon). Un IBAN
 * suivi d'un mot en capitales (« … 189 BIC AGRIFRPP ») est ainsi gardé sans ce mot.
 */
export function longueurIban(valeur: string): number | null {
  const attendue = LONGUEURS_IBAN[valeur.slice(0, 2)];
  if (attendue === undefined) return ibanValide(valeur) ? valeur.length : null;
  let vus = 0;
  for (let i = 0; i < valeur.length; i++) {
    if (/[A-Z0-9]/.test(valeur[i] ?? "")) vus += 1;
    if (vus === attendue) {
      // La longueur du pays doit tomber à la fin d'un groupe.
      if (/[A-Z0-9]/.test(valeur[i + 1] ?? "")) return null;
      return ibanValide(valeur.slice(0, i + 1)) ? i + 1 : null;
    }
  }
  return null;
}

/** Contrôle de Luhn (cartes bancaires), 13 à 19 chiffres, pas tous identiques. */
export function luhnValide(brut: string): boolean {
  const n = chiffres(brut);
  if (n.length < 13 || n.length > 19 || /^(\d)\1+$/.test(n)) return false;
  let somme = 0;
  for (let i = 0; i < n.length; i++) {
    let d = Number(n[n.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    somme += d;
  }
  return somme % 10 === 0;
}

/** Clé du NIR : 97 moins (les 13 premiers caractères modulo 97), Corse 2A = 19, 2B = 18. */
export function nirCleValide(brut: string): boolean {
  const s = brut.replace(/\s/g, "").toUpperCase();
  if (!/^[12]\d{4}(?:\d{2}|2A|2B)\d{6}\d{2}$/.test(s)) return false;
  const corps = s.slice(0, 13).replace("2A", "19").replace("2B", "18");
  const cle = Number(s.slice(13));
  return 97 - Number(BigInt(corps) % 97n) === cle;
}

const MOTS_NIR =
  /(s[ée]curit[ée]\s+sociale|\bNIR\b|\bn°\s*SS\b|num[ée]ro\s+de\s+s[ée]cu|\bINSEE\b|social\s+security)/i;
const MOTS_SIRET = /\bSIR(?:ET|EN)\b/i;
const MOTS_PIECE =
  /(passeport|passport|carte\s+(?:nationale\s+)?d['’]identit[ée]|\bCNI\b|identity\s+card|ID\s+card)/i;

/** Un mot-clé dans les `portee` caractères avant la valeur. */
function motCleAvant(texte: string, debut: number, motif: RegExp, portee = 60): boolean {
  return motif.test(texte.slice(Math.max(0, debut - portee), debut));
}

function ipv6Valide(s: string): boolean {
  if (!/[a-f]/i.test(s) && !s.includes("::")) return false;
  const doubles = s.split("::").length - 1;
  if (doubles > 1) return false;
  const groupes = s.split(":").filter((g) => g !== "");
  if (groupes.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return false;
  return doubles === 1 ? groupes.length <= 7 && groupes.length >= 2 : groupes.length === 8;
}

const VOIES_FR =
  "rue|avenue|av\\.|boulevard|bd|chemin|all[ée]e|impasse|place|quai|route|cours|square|passage|chauss[ée]e|voie|faubourg|fbg|r[ée]sidence|hameau|parvis|esplanade|promenade|sentier|villa|cit[ée]|lotissement|lieu-dit";
const VOIES_EN =
  "Street|St\\.|Avenue|Ave\\.|Road|Rd\\.|Boulevard|Blvd\\.|Lane|Ln\\.|Drive|Dr\\.|Court|Ct\\.|Way|Place|Pl\\.";

/** Règles dans l'ordre de priorité : une valeur déjà prise n'est jamais reprise. */
const REGLES: {
  type: TypeMasque;
  motif: RegExp;
  valide?: (valeur: string, texte: string, debut: number) => boolean;
  /** Longueur retenue au début de la valeur trouvée (null : rejetée) ; la suite est relue. */
  longueur?: (valeur: string) => number | null;
}[] = [
  {
    type: "SECRET",
    motif: new RegExp(
      [
        "\\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}",
        "\\bsk-[A-Za-z0-9_-]{20,}",
        "\\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{16,}",
        "\\bx(?:keysib|smtpsib)-[A-Za-z0-9-]{20,}",
        "\\bgh[pousr]_[A-Za-z0-9]{30,}",
        "\\bgithub_pat_[A-Za-z0-9_]{30,}",
        "\\bAKIA[0-9A-Z]{16}\\b",
        "\\bAIza[0-9A-Za-z_-]{35}",
        "\\bxox[abposr]-[A-Za-z0-9-]{10,}",
        "\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
        "(?<=\\bBearer\\s)[A-Za-z0-9._~+/=-]{20,}",
        // Clés WYRLO, simples ou signées (« wyr_live_s1.… ») ; jamais le point final.
        "\\bwyr_(?:live|test)_(?=[A-Za-z0-9_.-]{16,})[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*",
      ].join("|"),
      "g",
    ),
  },
  {
    // Lettres accentuées comprises (« chloé.martin@… » ne laisse pas « chloé » en clair).
    type: "EMAIL",
    motif: /[\p{L}\p{N}_.%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu,
  },
  {
    type: "IBAN",
    motif: /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]{2,4}){3,8}\b/g,
    longueur: longueurIban,
  },
  {
    // Avant les cartes : un NIR à 15 chiffres qui passe aussi le contrôle de Luhn reste un NIR.
    type: "NIR",
    motif:
      /\b[12][ ]?\d{2}[ ]?(?:0[1-9]|1[0-2]|[2-9]\d)[ ]?(?:\d{2}|2[AB])[ ]?\d{3}[ ]?\d{3}(?:[ ]?\d{2})?\b/g,
    valide: (v, texte, debut) =>
      chiffres(v.replace(/2[AB]/i, "00")).length === 15
        ? nirCleValide(v) || motCleAvant(texte, debut, MOTS_NIR)
        : motCleAvant(texte, debut, MOTS_NIR),
  },
  {
    type: "CARTE",
    motif: /(?<![\d.,])(?:\d[ -]?){12,18}\d(?![\d.,]\d)/g,
    // Un SIRET ou un SIREN passe le contrôle de Luhn par construction : il n'est pas une carte.
    valide: (v, texte, debut) => luhnValide(v) && !motCleAvant(texte, debut, MOTS_SIRET, 25),
  },
  {
    type: "TELEPHONE",
    motif:
      /(?<![\w+])(?:(?:\+|00)33[ .-]?(?:\(0\)[ .-]?)?[1-9]|0[1-9])(?:[ .-]?\d{2}){4}(?!\d)|(?<![\w+])\+(?!33)\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,5}(?![\d])/g,
    valide: (v) => {
      const n = chiffres(v).length;
      return n >= 9 && n <= 15;
    },
  },
  {
    type: "IP",
    motif:
      /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.]*\d)|(?<![\w:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\w:])/g,
    valide: (v) => (v.includes(":") ? ipv6Valide(v) : true),
  },
  {
    type: "PIECE",
    motif: /\b(?=[A-Z0-9]*\d[A-Z0-9]*\d)[A-Z0-9]{9,12}\b/g,
    valide: (v, texte, debut) => motCleAvant(texte, debut, MOTS_PIECE, 40),
  },
  {
    type: "ADRESSE",
    motif: new RegExp(
      `\\b\\d{1,4}(?:[a-z](?!\\p{L}))?(?:\\s?(?:bis|ter|quater))?,?\\s+(?:${VOIES_FR})\\s+[^\\n,;:()]{2,60}?(?=[,;:()\\n]|\\.(?:\\s|$)|$)(?:,\\s*\\d{5}\\s+[A-ZÀ-Ý][\\p{L}'’ -]{1,40}[\\p{L}])?` +
        `|\\b\\d{1,5}(?:[a-z](?!\\p{L}))?\\s+(?:[A-Z][a-z]+\\s){1,3}(?:${VOIES_EN})(?![\\p{L}])(?:,\\s*[A-Z][a-z]+(?:\\s[A-Z][a-z]+)?(?:,\\s*[A-Z]{2})?\\s+\\d{5}(?:-\\d{4})?)?`,
      "giu",
    ),
  },
];

/** Normalisation d'une valeur pour l'égalité des marques (casse, espaces, séparateurs). */
function normaliser(type: TypeMasque, valeur: string): string {
  const v = valeur.trim().toLowerCase();
  if (type === "EMAIL" || type === "SECRET" || type === "ADRESSE") return v.replace(/\s+/g, " ");
  return v.replace(/[\s.()+-]/g, "").replace(/^0033|^33(?=\d{9}$)/, "0");
}

/** Valeurs trouvées dans un texte, sans chevauchement, dans l'ordre du texte. */
export function trouver(texte: string): Trouve[] {
  const pris: Trouve[] = [];
  const libre = (d: number, f: number) => pris.every((p) => f <= p.debut || d >= p.fin);
  for (const regle of REGLES) {
    regle.motif.lastIndex = 0;
    for (let m = regle.motif.exec(texte); m !== null; m = regle.motif.exec(texte)) {
      const debut = m.index;
      let valeur = m[0];
      if (!valeur) {
        regle.motif.lastIndex += 1;
        continue;
      }
      if (regle.longueur) {
        const n = regle.longueur(valeur);
        if (n === null) continue;
        // Valeur raccourcie : la suite est relue (un second IBAN collé au premier, par exemple).
        valeur = valeur.slice(0, n);
        regle.motif.lastIndex = debut + n;
      }
      const fin = debut + valeur.length;
      if (!valeur.trim() || !libre(debut, fin)) continue;
      if (regle.valide && !regle.valide(valeur, texte, debut)) continue;
      pris.push({ debut, fin, type: regle.type, valeur });
    }
  }
  return pris.sort((a, b) => a.debut - b.debut);
}

/** Textes masqués, décompte par type et valeurs d'origine de chaque marque. */
export interface MaskedTexts {
  texts: string[];
  /** Nombre de remplacements par type (« EMAIL », « TELEPHONE »…), sans aucune valeur. */
  counts: Record<string, number>;
  /** Marque → valeur d'origine (première écriture rencontrée). Reste sur votre machine. */
  values: Map<string, string>;
}

/**
 * Masque des textes en un seul lot : une même valeur reçoit la même marque dans tous les
 * textes (« 06 12 34 56 78 » et « +33 6 12 34 56 78 » donnent « [TELEPHONE_1] »).
 */
export function maskTexts(texts: string[]): MaskedTexts {
  const numeros = new Map<string, number>();
  const parType = new Map<TypeMasque, number>();
  const counts: Record<string, number> = {};
  const values = new Map<string, string>();
  const sorties = texts.map((texte) => {
    let sortie = "";
    let position = 0;
    for (const t of trouver(texte)) {
      const cle = `${t.type}\u0000${normaliser(t.type, t.valeur)}`;
      let n = numeros.get(cle);
      if (n === undefined) {
        n = (parType.get(t.type) ?? 0) + 1;
        parType.set(t.type, n);
        numeros.set(cle, n);
      }
      const marque = `[${t.type}_${n}]`;
      if (!values.has(marque)) values.set(marque, t.valeur);
      counts[t.type] = (counts[t.type] ?? 0) + 1;
      sortie += texte.slice(position, t.debut) + marque;
      position = t.fin;
    }
    return sortie + texte.slice(position);
  });
  return { texts: sorties, counts, values };
}

/** Remet les valeurs d'origine à la place des marques produites par `maskTexts`. */
export function unmaskText(text: string, values: Map<string, string>): string {
  if (!values.size) return text;
  return text.replace(/\[([A-Z]+)_(\d+)\]/g, (marque) => values.get(marque) ?? marque);
}
