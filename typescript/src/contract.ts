/**
 * Contrat public de l'API d'ingestion WYRLO (POST /guard).
 *
 * Le service WYRLO applique ce même contrat ; toute évolution est versionnée (API_VERSION).
 */

export const API_VERSION = "2026-09-25";

export const LIMITS = {
  bodyBytes: 512 * 1024,
  question: 4_000,
  answer: 20_000,
  passages: 50,
  passageText: 8_000,
  source: 300,
  id: 200,
  requestId: 128,
  sentences: 20,
} as const;

export interface GuardPassageInput {
  /** Identifiant stable du passage dans votre base (sinon, sa position). */
  id?: string;
  text: string;
  /** Document d'origine, affiché dans l'espace client (« CGV.pdf, article 11 »). */
  source?: string;
  /** Score donné par votre recherche, entre 0 et 1 si possible. */
  score?: number;
  /**
   * Adresse du passage rendue par `POST /guard/search` (mode B, index sans copie) :
   * facultative. Si l'empreinte du texte envoyé diffère de celle de l'adresse, le passage
   * est signalé « périmé » (`stale`) dans la réponse : le document a changé depuis son
   * indexation.
   */
  address?: PassageAddress;
}

/** Adresse d'un passage de l'index sans copie (mode B). */
export interface PassageAddress {
  document: string;
  version: string;
  start: number;
  length: number;
  /** Empreinte SHA-256 du texte du passage (64 caractères hexadécimaux). */
  fingerprint: string;
}

export interface GuardRequest {
  question: string;
  answer: string;
  passages: GuardPassageInput[];
  /**
   * Client final pour lequel la vérification est faite (plateformes, offre Partenaire) :
   * identifiant opaque, le même que pour l'index (mode C). Facultatif. La vérification est
   * alors comptée pour ce client ; un nouveau client final est créé au premier usage, dans
   * la limite de l'offre.
   */
  tenant?: string;
  /**
   * Langue (« fr », « en », « en-GB »…). Elle décide des traitements : la vérification
   * phrase par phrase et le reclassement par modèle ne sont disponibles qu'en anglais.
   * Si elle manque, WYRLO la devine sur la question et la réponse, puis sur les passages
   * si elles sont trop courtes (inconnue en cas de doute, et alors traitée comme non
   * anglaise). Sert aussi au masquage.
   */
  language?: string;
  /** Identifiant unique de la requête côté client : un nouvel envoi n'est compté qu'une fois. */
  request_id?: string;
}

/**
 * « unverified » : réponse transmise sans aucun contrôle (serveur d'inférence trop lent ou
 * indisponible, plafond de l'offre atteint, WYRLO injoignable). Jamais présentée comme
 * « probable » ; la décision reste `answer` : WYRLO ne bloque jamais une réponse.
 */
export type Confidence = "certain" | "probable" | "uncertain" | "unverified";
export type Decision = "answer" | "abstain";

/** « verification » : aucune vérification n'a pu être faite (confiance « unverified »). */
export type SkippedStep =
  "rerank" | "injection_check" | "consistency" | "verification" | "anonymize";

/**
 * Reclassement appliqué : « model » (modèle de reclassement, anglais), « similarity »
 * (similarité d'empreintes, autres langues ; ce n'est pas un vrai modèle de
 * reclassement), « none » (désactivé, sauté ou sans passage).
 */
export type RerankMethod = "model" | "similarity" | "none";

/**
 * Vérification appliquée : « answer » (en direct, anglais : la réponse entière
 * confrontée aux meilleurs passages, un seul appel), « sentences » (chaque phrase
 * confrontée aux passages, fait la nuit), « signals » (vérification non disponible pour
 * cette langue : confiance calculée à partir des scores de recherche et de reclassement
 * et de l'accord entre les sources), « model » (réponse française vérifiée en direct par
 * un modèle de langue, dont le verdict décide), « none » (aucune vérification possible).
 */
export type VerificationMethod = "answer" | "sentences" | "signals" | "model" | "none";

export interface GuardPassageResult {
  id: string;
  kept: boolean;
  /** Rang après reclassement (1 = le plus pertinent), null si non reclassé. */
  rank: number | null;
  score: number | null;
  /** Instruction malveillante détectée dans ce passage : il est écarté. */
  injection: boolean;
  /**
   * Seulement pour un passage envoyé avec son adresse (mode B) : vrai si son texte ne
   * correspond plus à l'empreinte de l'adresse (document à réindexer).
   */
  stale?: boolean;
}

export interface GuardResponse {
  /** Identifiant de la trace ; null si la question n'a pas été analysée (plafond atteint). */
  trace_id: string | null;
  decision: Decision;
  confidence: Confidence;
  /**
   * Score entre 0 et 1 : cohérence de la réponse avec les meilleurs passages
   * (`verification_method` « answer ») ou score des signaux (« signals ») ; null si
   * rien n'a pu être vérifié.
   */
  confidence_score: number | null;
  /** Explication courte : en anglais par défaut, en français avec Accept-Language: fr. */
  reason: string;
  passages: GuardPassageResult[];
  /** Phrases de la réponse qu'aucun passage n'appuie (vérification phrase par phrase). */
  unsupported_sentences: string[];
  injection_detected: boolean;
  /** Traitements sautés (serveur d'inférence indisponible ou trop lent). */
  skipped_steps: SkippedStep[];
  /**
   * Mode dégradé : au moins un traitement sauté, ou plafond de l'offre atteint. Toujours
   * vrai quand la confiance est « unverified ». Absent des serveurs antérieurs au 02/10 :
   * le SDK le déduit alors des étapes sautées et du plafond.
   */
  degraded?: boolean;
  settings_version: number | null;
  /** Langue retenue (précisée ou devinée), null si inconnue. */
  language: string | null;
  rerank_method: RerankMethod;
  verification_method: VerificationMethod;
  latency_ms: number;
  /**
   * Plafond mensuel de l'offre atteint : la question n'est ni analysée ni enregistrée, la
   * réponse passe sans vérification (jamais bloquée) jusqu'au mois suivant.
   */
  quota_exceeded: boolean;
  /**
   * Variante des réglages reçue par cette question pendant un test partiel (une nouvelle
   * version essayée sur une part des questions) : « candidate » ou « control » ; null hors
   * test.
   */
  settings_variant?: SettingsVariant | null;
}

export type SettingsVariant = "control" | "candidate";

/**
 * Étape « préparer », avant la recherche du client (`POST /guard/prepare`) : la question
 * à chercher, enrichie du vocabulaire du projet (variante comprise pendant un test
 * partiel). Même `request_id` ensuite pour la vérification : même variante.
 */
export interface PrepareRequest {
  question: string;
  request_id?: string;
}

export interface PrepareResponse {
  /** Texte à donner à votre recherche (la question, plus les termes du vocabulaire). */
  query: string;
  /** Termes ajoutés par le vocabulaire (vide si aucun). */
  added_terms: string[];
  request_id: string | null;
  settings_version: number | null;
  settings_variant: SettingsVariant | null;
}

/**
 * Retour de l'utilisateur final sur une réponse (`POST /guard/feedback`) : pouce en haut
 * (`helpful: true`) ou en bas. Aucun texte : seulement l'identifiant de la trace renvoyé
 * par guard. La boucle de nuit l'utilise comme étiquette, sans appel payant.
 */
export interface FeedbackRequest {
  trace_id: string;
  helpful: boolean;
}

/**
 * `200` : trace connue. `202` : trace pas encore écrite (elle l'est après la réponse de
 * guard, en quelques secondes) ; le pouce lui sera rattaché dès qu'elle existe, et il est
 * supprimé au bout de 2 jours si aucune trace ne correspond.
 */
export interface FeedbackResponse {
  recorded: true;
  trace_id: string;
  trace_found: boolean;
}

/** Vérification du branchement (`GET /guard/health`, sans clé ni appel à la base). */
export interface HealthResponse {
  status: "ok";
  api_version: string;
}

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: { field: string; issue: string }[];
    /** Page de documentation utile (refus hors de Paris : en-tête de région). */
    docs?: string;
  };
}

export type ApiErrorCode =
  | "unauthorized"
  /**
   * Clé de production envoyée depuis le navigateur, par la page du bac à sable (403) : le bac
   * à sable n'accepte que les clés de test (ADR 0023).
   */
  | "live_key_in_browser"
  | "method_not_allowed"
  | "payload_too_large"
  | "invalid_json"
  | "invalid_request"
  | "internal_error"
  /** Trace inconnue pour le projet de la clé (`POST /guard/feedback`), ou route inconnue. */
  | "not_found"
  /** Service momentanément surchargé (503, en-tête Retry-After) : réponse à transmettre en mode dégradé. */
  | "overloaded"
  /**
   * Requête reçue hors de Paris (421) : refusée sans être lue, rien n'a été traité.
   * Ajouter l'en-tête `x-region: eu-west-3` (les SDK le font toujours).
   */
  | "wrong_region"
  /**
   * Index sans copie (mode B) coupé pour le projet de la clé (403) : les routes
   * `/guard/index/…` et `/guard/search` ne sont ouvertes que sur demande.
   */
  | "index_disabled"
  /** Lecture des PDF scannés (`POST /guard/ocr`) coupée : réglage fermé par défaut (403). */
  | "ocr_disabled";

/** Limites de l'index sans copie (mode B, incrément 1). */
export const INDEX_LIMITS = {
  document: 200,
  version: 200,
  labels: 20,
  label: 64,
  /** Texte entier d'un document (le corps reste limité à 512 Kio). */
  text: 400_000,
  passages: 2_000,
  passageText: 8_000,
  k: 50,
  keywordHits: 100,
  /** Identifiant d'espace (mode C) : lettres, chiffres, « . _ : - ». */
  tenant: 100,
  /** Titre d'un document, placé en tête de chaque passage pour le calcul des vecteurs. */
  title: 300,
  /** Contexte d'un passage (en-têtes de tableau, titre de section), pour les vecteurs seulement. */
  context: 300,
  /** Documents par lot (`POST /guard/index/documents`), dans la limite du corps (512 Kio). */
  batchDocuments: 100,
  /** Par projet (sans prix pour l'instant). */
  projectDocuments: 5_000,
  projectPassages: 100_000,
} as const;

/** PUT /guard/index/documents/{id} : le texte entier, ou des passages déjà découpés. */
export interface IndexPutRequest {
  version: string;
  text?: string;
  /**
   * Passages découpés par vous ; `start` : position du passage dans votre document.
   * `context` (facultatif) : en-têtes de son tableau ou titre de sa section, placés devant
   * le passage pour le calcul des vecteurs seulement, jamais conservés.
   */
  passages?: { text: string; start: number; context?: string }[];
  labels?: string[];
  /**
   * Titre du document (300 caractères au plus). Placé en tête de chaque passage pour le
   * calcul des vecteurs seulement : jamais conservé. Aide à retrouver un document par son nom
   * ou sa référence quand un passage ne les répète pas.
   */
  title?: string;
  /**
   * Espace du client final (mode C, plateformes) : identifiant opaque de votre choix, jamais
   * un nom ni une adresse e-mail. Absent : espace par défaut du projet.
   */
  tenant?: string;
  request_id?: string;
}

/** Adresse d'un passage indexé, sans le document (rendue par PUT). */
export interface IndexedPassage {
  index: number;
  start: number;
  length: number;
  fingerprint: string;
}

export interface IndexPutResponse {
  document: string;
  version: string;
  /** « unchanged » : même version déjà indexée, rien n'a été recalculé ni compté. */
  status: "indexed" | "unchanged";
  passages: IndexedPassage[];
  request_id?: string;
}

/**
 * Lot de documents (`POST /guard/index/documents`) : jusqu'à 100 documents en un appel,
 * dans le même espace. Chaque document a les champs de `PUT /guard/index/documents/{id}`,
 * plus son identifiant `id`.
 */
export interface IndexBatchRequest {
  documents: (Omit<IndexPutRequest, "tenant" | "request_id"> & { id: string })[];
  tenant?: string;
  request_id?: string;
}

/** Résultat d'un document du lot. */
export interface IndexBatchResult {
  document: string;
  /**
   * « failed » : ce document seulement n'est pas indexé (`error` dit pourquoi) ; les autres le
   * sont. Avec `error.code` « overloaded », renvoyez-le plus tard tel quel.
   */
  status: "indexed" | "unchanged" | "failed";
  version?: string;
  passages?: IndexedPassage[];
  error?: {
    code: "invalid_request" | "overloaded";
    message: string;
    details?: { field: string; issue: string }[];
  };
}

export interface IndexBatchResponse {
  results: IndexBatchResult[];
  indexed: number;
  unchanged: number;
  failed: number;
  request_id?: string;
}

export interface IndexDeleteResponse {
  document: string;
  deleted: boolean;
}

/** DELETE /guard/index?tenant=… : un espace entier effacé (mode C). */
export interface IndexTenantDeleteResponse {
  tenant: string;
  documents: number;
  passages: number;
}

export interface IndexStatsResponse {
  enabled: boolean;
  documents: number;
  passages: number;
  last_indexed_at: string | null;
  /** Nombre d'espaces de clients finaux (mode C) dans le projet. */
  tenants?: number;
  /** Espace demandé (`?tenant=`) : les chiffres ne portent que sur lui (sauf `month`). */
  tenant?: string;
  /** Consommation du mois, pour tout le projet. */
  month: { documents: number; passages: number; searches: number };
}

/** POST /guard/search */
export interface SearchRequest {
  question: string;
  /** Nombre de résultats (8 par défaut, 50 au plus). */
  k?: number;
  /** Documents portant au moins une de ces étiquettes. */
  labels_any?: string[];
  /** Résultats de votre recherche par mots-clés, du plus au moins pertinent (fusion). */
  keyword_hits?: { document: string }[];
  /** Espace du client final (mode C) : la recherche ne voit que lui. Absent : défaut. */
  tenant?: string;
  request_id?: string;
}

export interface SearchResult extends PassageAddress {
  index: number;
  labels: string[];
  /** Similarité cosinus entre la question et le passage. */
  score: number;
}

export interface SearchResponse {
  results: SearchResult[];
  request_id?: string;
}

// -----------------------------------------------------------------------------
// POST /guard/answer : la réponse complète en un appel (docs/conception-v1-answer.md)
// -----------------------------------------------------------------------------

/** Fournisseurs du modèle de rédaction ; « wyrlo » : modèle géré par WYRLO (Mistral, Europe). */
export const ANSWER_PROVIDERS = [
  "wyrlo",
  "openai",
  "anthropic",
  "mistral",
  "azure_openai",
  "openai_compatible",
] as const;
export type AnswerProvider = (typeof ANSWER_PROVIDERS)[number];

export interface AnswerModelInput {
  provider: AnswerProvider;
  /** Nom du modèle chez le fournisseur ; facultatif pour « wyrlo ». */
  name?: string;
  /** Clé du fournisseur, utilisée pour cet appel seulement : jamais gardée ni journalisée. */
  api_key?: string;
  /** Adresse de l'API (`azure_openai`, `openai_compatible`) : https obligatoire. */
  base_url?: string;
}

export interface AnswerRequest {
  question: string;
  /** Passages relus chez vous (adresses de `/guard/search`) ou venus d'ailleurs. */
  passages: GuardPassageInput[];
  tenant?: string;
  language?: string;
  /** Absent : modèle enregistré pour le projet s'il existe, sinon modèle géré par WYRLO. */
  model?: AnswerModelInput;
  /** Réponse progressive (text/event-stream) : événements `draft` puis `final`. */
  stream?: boolean;
  request_id?: string;
}

export interface AnswerSentence {
  text: string;
  confidence: Confidence;
  /** Identifiants des passages cités par cette phrase. */
  sources: string[];
  /** Faux : aucune source valable, ou phrase que la vérification n'appuie pas. */
  supported: boolean;
}

export interface AnswerResponse {
  /** Trace de la vérification ; null si rien n'a été rédigé (« je ne sais pas » du modèle). */
  trace_id: string | null;
  decision: Decision;
  confidence: Confidence;
  /** Texte complet ; null quand la décision est « abstain ». */
  answer: string | null;
  sentences: AnswerSentence[];
  /** Pistes quand il n'y a pas de réponse : passages les plus proches, sans leur texte. */
  leads: { id: string; source: string | null }[];
  reason: string;
  model: { provider: AnswerProvider; name: string };
  usage: { input_tokens: number; output_tokens: number };
  /** Vérification incomplète ou sautée (mode dégradé) : la réponse reste transmise. */
  degraded: boolean;
}
