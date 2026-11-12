/**
 * Jeu de mesure du masquage (virage API du 05/11/2026) : textes entièrement fictifs,
 * produits par un tirage reproductible (graine fixe), avec la position de chaque valeur à
 * masquer et de chaque leurre qui doit rester (numéro de commande, date, montant, IBAN ou
 * carte à la clé fausse…). Les noms de personnes y figurent aussi, marqués « PERSONNE » :
 * les règles ne les masquent pas, et la mesure doit le montrer.
 *
 * Aucune valeur réelle : IBAN, cartes et NIR sont tirés au hasard puis complétés de leur
 * clé ; les clés d'API sont assemblées à l'exécution (aucune n'est écrite en clair ici).
 */

export type TypeAttendu =
  | "EMAIL"
  | "TELEPHONE"
  | "IBAN"
  | "CARTE"
  | "NIR"
  | "IP"
  | "PIECE"
  | "ADRESSE"
  | "SECRET"
  | "PERSONNE";

export interface Repere {
  type: TypeAttendu | "LEURRE";
  /** Variante (« FR compact », « SIRET »…) pour le détail des résultats. */
  forme: string;
  debut: number;
  fin: number;
}

export interface CasMasquage {
  texte: string;
  reperes: Repere[];
}

/** Générateur pseudo-aléatoire reproductible (mulberry32). */
function hasard(graine: number) {
  let a = graine >>> 0;
  const suivant = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const entier = (min: number, max: number) => min + Math.floor(suivant() * (max - min + 1));
  const choix = <T>(liste: readonly T[]): T => liste[entier(0, liste.length - 1)] as T;
  const chiffres = (n: number) => Array.from({ length: n }, () => String(entier(0, 9))).join("");
  const lettres = (n: number, alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ") =>
    Array.from({ length: n }, () => alphabet[entier(0, alphabet.length - 1)]).join("");
  return { suivant, entier, choix, chiffres, lettres };
}

type Hasard = ReturnType<typeof hasard>;

const PRENOMS = [
  "Jeanne",
  "Karim",
  "Sophie",
  "Lucas",
  "Amina",
  "Hugo",
  "Chloé",
  "Mehdi",
  "Léa",
  "Tom",
];
const NOMS = [
  "Martin",
  "Bernard",
  "Dubois",
  "Moreau",
  "Laurent",
  "Garcia",
  "Roux",
  "Fontaine",
  "Haddad",
  "Petit",
];
const DOMAINES = [
  "exemple.fr",
  "exemple.com",
  "boutique-exemple.fr",
  "mail.exemple.org",
  "societe-fictive.eu",
];
const VILLES = [
  ["75011", "Paris"],
  ["69006", "Lyon"],
  ["13008", "Marseille"],
  ["33000", "Bordeaux"],
  ["59800", "Lille"],
  ["44000", "Nantes"],
] as const;

function mod97(chaine: string): number {
  let reste = 0;
  for (const c of chaine) {
    const v = c >= "A" && c <= "Z" ? String(c.charCodeAt(0) - 55) : c;
    for (const d of v) reste = (reste * 10 + Number(d)) % 97;
  }
  return reste;
}

function ibanAvecCle(pays: string, bban: string, valide: boolean): string {
  const cle = 98 - mod97(`${bban}${pays}00`);
  const juste = String(cle).padStart(2, "0");
  const fausse = String(((cle + 1) % 97) + 2).padStart(2, "0");
  return `${pays}${valide ? juste : fausse}${bban}`;
}

function luhnCompleter(debut: string, valide: boolean): string {
  let somme = 0;
  for (let i = 0; i < debut.length; i++) {
    let d = Number(debut[debut.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    somme += d;
  }
  const cle = (10 - (somme % 10)) % 10;
  return debut + String(valide ? cle : (cle + 1) % 10);
}

const grouper = (s: string, taille: number, sep = " ") =>
  s.match(new RegExp(`.{1,${taille}}`, "g"))?.join(sep) ?? s;

/** Une valeur à placer dans un texte, avec son type attendu et sa forme. */
interface Valeur {
  type: TypeAttendu | "LEURRE";
  forme: string;
  valeur: string;
  /** Phrases possibles ; {v} marque la valeur. */
  phrases: readonly string[];
}

function valeurs(h: Hasard): Valeur[] {
  const prenom = h.choix(PRENOMS);
  const nom = h.choix(NOMS);
  const tel8 = () => `${h.entier(1, 9)}${h.chiffres(8)}`;
  const t = tel8();
  const paires = (s: string, sep: string) => grouper(s, 2, sep);
  const [cp, ville] = h.choix(VILLES);
  const bbanFr = h.chiffres(23);
  const bbanDe = h.chiffres(18);
  const bbanGb = `${h.lettres(4)}${h.chiffres(14)}`;
  const visa = luhnCompleter(`4${h.chiffres(14)}`, true);
  const mc = luhnCompleter(`5${h.entier(1, 5)}${h.chiffres(13)}`, true);
  const amex = luhnCompleter(`3${h.choix(["4", "7"])}${h.chiffres(12)}`, true);
  const nirCorps = `${h.entier(1, 2)}${h.chiffres(2)}${String(h.entier(1, 12)).padStart(2, "0")}${String(h.entier(1, 95)).padStart(2, "0").replace("20", "21")}${h.chiffres(6)}`;
  const nirCle = String(97 - Number(BigInt(nirCorps) % 97n)).padStart(2, "0");
  const nirEspaces = (s: string) =>
    `${s[0]} ${s.slice(1, 3)} ${s.slice(3, 5)} ${s.slice(5, 7)} ${s.slice(7, 10)} ${s.slice(10, 13)}${s.length > 13 ? ` ${s.slice(13)}` : ""}`;
  const ip4 = `${h.entier(1, 223)}.${h.entier(0, 255)}.${h.entier(0, 255)}.${h.entier(1, 254)}`;
  const hex = () => h.entier(0, 65535).toString(16);
  const ip6 = `2001:db8:${hex()}::${hex()}`;
  const piece = `${h.chiffres(2)}${h.lettres(2)}${h.chiffres(5)}`;
  const jeton = (n: number) =>
    h.lettres(n, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
  const siret = luhnCompleter(h.chiffres(13), true);
  const deux = (min: number, max: number) => String(h.entier(min, max)).padStart(2, "0");
  const nirFaux = String((Number(nirCle) % 97) + 1).padStart(2, "0");

  return [
    {
      type: "EMAIL",
      forme: "simple",
      valeur: `${prenom}.${nom}@${h.choix(DOMAINES)}`.toLowerCase(),
      phrases: ["Écrivez à {v} pour toute question.", "Contact: {v}", "Copie à {v}."],
    },
    {
      type: "EMAIL",
      forme: "avec étiquette",
      valeur: `${prenom.toLowerCase()}+sav@${h.choix(DOMAINES)}`,
      phrases: ["Adresse de suivi : {v}"],
    },
    {
      type: "TELEPHONE",
      forme: "FR espaces",
      valeur: `0${t[0]} ${paires(t.slice(1), " ")}`,
      phrases: ["Appelez le {v} entre 9 h et 18 h.", "Tél. {v}"],
    },
    {
      type: "TELEPHONE",
      forme: "FR compact",
      valeur: `0${t}`,
      phrases: ["Numéro : {v}", "Rappeler au {v} demain."],
    },
    {
      type: "TELEPHONE",
      forme: "FR points",
      valeur: `0${t[0]}.${paires(t.slice(1), ".")}`,
      phrases: ["Standard {v}"],
    },
    {
      type: "TELEPHONE",
      forme: "FR +33",
      valeur: `+33 ${t[0]} ${paires(t.slice(1), " ")}`,
      phrases: ["Depuis l'étranger : {v}."],
    },
    {
      type: "TELEPHONE",
      forme: "FR +33 (0)",
      valeur: `+33 (0)${t[0]} ${paires(t.slice(1), " ")}`,
      phrases: ["Ligne directe {v}"],
    },
    {
      type: "TELEPHONE",
      forme: "international",
      valeur: h.choix([
        `+44 20 ${h.chiffres(4)} ${h.chiffres(4)}`,
        `+1 415 555 ${h.chiffres(4)}`,
        `+49 30 ${h.chiffres(7)}`,
        `+32 2 ${h.chiffres(3)} ${h.chiffres(2)} ${h.chiffres(2)}`,
      ]),
      phrases: ["Office: {v}", "Call {v} for support."],
    },
    {
      type: "IBAN",
      forme: "FR groupé",
      valeur: grouper(ibanAvecCle("FR", bbanFr, true), 4),
      phrases: ["IBAN : {v}", "Virement sur {v} sous 14 jours."],
    },
    {
      type: "IBAN",
      forme: "DE compact",
      valeur: ibanAvecCle("DE", bbanDe, true),
      phrases: ["IBAN {v}"],
    },
    {
      type: "IBAN",
      forme: "GB groupé",
      valeur: grouper(ibanAvecCle("GB", bbanGb, true), 4),
      phrases: ["Account {v}."],
    },
    {
      type: "CARTE",
      forme: "Visa groupée",
      valeur: grouper(visa, 4),
      phrases: ["Carte {v} expirée.", "Paid with card {v}."],
    },
    {
      type: "CARTE",
      forme: "Mastercard tirets",
      valeur: grouper(mc, 4, "-"),
      phrases: ["Carte bancaire : {v}"],
    },
    { type: "CARTE", forme: "Amex compacte", valeur: amex, phrases: ["Card number {v}"] },
    {
      type: "NIR",
      forme: "avec clé",
      valeur: nirEspaces(nirCorps + nirCle),
      phrases: ["NIR {v}", "N° d'assuré : {v}."],
    },
    {
      type: "NIR",
      forme: "sans clé, mot-clé",
      valeur: nirEspaces(nirCorps),
      phrases: ["Mon numéro de sécurité sociale : {v}", "sécurité sociale {v}"],
    },
    {
      type: "IP",
      forme: "IPv4",
      valeur: ip4,
      phrases: ["Connexion depuis {v} hier soir.", "Serveur {v}"],
    },
    { type: "IP", forme: "IPv6", valeur: ip6, phrases: ["Hôte {v} joignable."] },
    {
      type: "PIECE",
      forme: "passeport",
      valeur: piece,
      phrases: ["Passeport n° {v}", "passport number {v}"],
    },
    { type: "PIECE", forme: "CNI", valeur: piece, phrases: ["CNI : {v}"] },
    {
      type: "ADRESSE",
      forme: "FR complète",
      valeur: `${h.entier(1, 199)} ${h.choix(["rue", "avenue", "boulevard", "impasse", "chemin"])} des ${h.choix(["Lilas", "Tilleuls", "Acacias", "Écoles"])}, ${cp} ${ville}`,
      phrases: ["Livraison au {v}. Merci", "Adresse : {v}"],
    },
    {
      type: "ADRESSE",
      forme: "FR bis sans ville",
      valeur: `${h.entier(1, 60)} bis ${h.choix(["rue", "avenue"])} ${h.choix(["Foch", "Jean Jaurès", "Victor Hugo"])}`,
      phrases: ["Bureau au {v}, 2e étage."],
    },
    {
      type: "ADRESSE",
      forme: "EN",
      valeur: `${h.entier(1, 999)} ${h.choix(["Baker", "Oak", "Maple", "High"])} ${h.choix(["Street", "Road", "Avenue", "Lane"])}`,
      phrases: ["Office at {v}.", "Ship to {v}"],
    },
    {
      type: "ADRESSE",
      forme: "numéro collé (221B)",
      valeur: `${h.entier(1, 400)}B ${h.choix(["Baker", "Oak"])} Street`,
      phrases: ["Flat at {v}."],
    },
    {
      type: "ADRESSE",
      forme: "lieu-dit sans numéro",
      valeur: `lieu-dit ${h.choix(["La Croix", "Les Granges", "Le Moulin"])}`,
      phrases: [`Ferme située {v}, ${cp} ${ville}.`],
    },
    {
      type: "SECRET",
      forme: "Stripe",
      valeur: ["sk", "live", jeton(24)].join("_"),
      phrases: ["Clé {v} à ne pas partager."],
    },
    {
      type: "SECRET",
      forme: "WYRLO",
      valeur: ["wyr", "live", jeton(48)].join("_"),
      phrases: ["WYRLO_API_KEY={v}"],
    },
    { type: "SECRET", forme: "Bearer", valeur: jeton(32), phrases: ["Authorization: Bearer {v}"] },
    {
      type: "SECRET",
      forme: "JWT",
      valeur: ["eyJ" + jeton(16), jeton(20), jeton(24)].join("."),
      phrases: ["jeton {v}"],
    },
    {
      type: "SECRET",
      forme: "AWS",
      valeur: "AKIA" + h.lettres(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"),
      phrases: ["aws_access_key_id = {v}"],
    },
    {
      type: "PERSONNE",
      forme: "prénom nom",
      valeur: `${prenom} ${nom}`,
      phrases: ["Dossier suivi par {v}.", "{v} a appelé ce matin."],
    },
    {
      type: "PERSONNE",
      forme: "civilité",
      valeur: `M. ${nom}`,
      phrases: ["Rendez-vous avec {v} jeudi."],
    },
    // Leurres : doivent rester tels quels (la vérification compare ces valeurs).
    {
      type: "LEURRE",
      forme: "commande",
      valeur: `${h.entier(10000, 99999)}`,
      phrases: ["Commande {v} expédiée."],
    },
    {
      type: "LEURRE",
      forme: "référence",
      valeur: `2026-${h.chiffres(2)}-${h.chiffres(4)}`,
      phrases: ["Réf. {v}"],
    },
    {
      type: "LEURRE",
      forme: "date",
      valeur: `${String(h.entier(1, 28)).padStart(2, "0")}/${String(h.entier(1, 12)).padStart(2, "0")}/2026`,
      phrases: ["Le {v}, livraison prévue."],
    },
    {
      type: "LEURRE",
      forme: "heure",
      valeur: `${deux(0, 23)}:${deux(0, 59)}:${deux(0, 59)}`,
      phrases: ["Appel reçu à {v}."],
    },
    {
      type: "LEURRE",
      forme: "montant",
      valeur: `${h.entier(1, 9)} ${h.chiffres(3)},${h.chiffres(2)} €`,
      phrases: ["Total {v} TTC."],
    },
    {
      type: "LEURRE",
      forme: "version",
      valeur: `${h.entier(1, 9)}.${h.entier(0, 20)}.${h.entier(0, 20)}`,
      phrases: ["version {v}"],
    },
    {
      type: "LEURRE",
      forme: "IBAN clé fausse",
      valeur: grouper(ibanAvecCle("FR", bbanFr, false), 4),
      phrases: ["IBAN {v} (refusé)"],
    },
    {
      type: "LEURRE",
      forme: "carte Luhn faux",
      valeur: grouper(luhnCompleter(`4${h.chiffres(14)}`, false), 4),
      phrases: ["Carte {v} invalide."],
    },
    {
      type: "LEURRE",
      forme: "15 chiffres, clé fausse, sans mot-clé",
      valeur: nirEspaces(nirCorps + nirFaux),
      phrases: ["Référence dossier {v}"],
    },
    {
      type: "LEURRE",
      forme: "SIRET",
      valeur: `${siret.slice(0, 3)} ${siret.slice(3, 6)} ${siret.slice(6, 9)} ${siret.slice(9)}`,
      phrases: ["SIRET {v}"],
    },
    { type: "LEURRE", forme: "lot sans mot-clé", valeur: piece, phrases: ["Lot {v} reçu."] },
    {
      type: "LEURRE",
      forme: "code postal seul",
      valeur: `${cp} ${ville}`,
      phrases: ["Agence de {v}.", "Bureau de {v}"],
    },
  ];
}

/** Jeu complet : `nombre` textes de 1 à 3 phrases, chacune portant une valeur. */
export function jeuMasquage(nombre = 2000, graine = 20261105): CasMasquage[] {
  const h = hasard(graine);
  const cas: CasMasquage[] = [];
  for (let i = 0; i < nombre; i++) {
    const tirage = valeurs(h);
    const reperes: Repere[] = [];
    let texte = "";
    const n = h.entier(1, 3);
    for (let j = 0; j < n; j++) {
      // Chaque sorte de valeur a la même chance d'être tirée.
      const v = tirage[(i * 3 + j) % tirage.length] as Valeur;
      const phrase = h.choix(v.phrases);
      const [avant = "", apres = ""] = phrase.split("{v}");
      if (texte) texte += " ";
      const debut = texte.length + avant.length;
      texte += avant + v.valeur + apres;
      reperes.push({ type: v.type, forme: v.forme, debut, fin: debut + v.valeur.length });
    }
    cas.push({ texte, reperes });
  }
  return cas;
}
