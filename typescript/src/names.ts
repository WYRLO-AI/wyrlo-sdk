/**
 * Masquage des noms de personnes côté client (cahier des charges du 13/11/2026,
 * chantier 9), en plus des règles de `masking.ts`. Les règles ne reconnaissent que des
 * valeurs à forme fixe (e-mail, téléphone, IBAN…) ; un nom n'a pas de forme : il faut un
 * modèle de langue. Il tourne ici sur votre machine, avec une bibliothèque gratuite : le
 * texte ne part nulle part pour être analysé.
 *
 *   import { Wyrlo } from "@wyrlo/sdk";
 *   import { transformersNames } from "@wyrlo/sdk/names";
 *   const wyrlo = new Wyrlo({ mask: { names: transformersNames() } });
 *
 * `transformersNames()` demande `npm install @huggingface/transformers` (dépendance
 * facultative). Au premier appel, la bibliothèque télécharge le modèle depuis Hugging Face
 * (seul le fichier du modèle est demandé, aucun texte n'est envoyé), puis le garde en cache.
 * Vous pouvez brancher un autre détecteur : toute fonction qui rend les positions des noms.
 *
 * Limite à connaître : un modèle de langue se trompe. Il peut manquer un nom (prénom rare,
 * nom tout en minuscules, nom qui est aussi un mot courant) ou masquer un mot qui n'en est
 * pas un. Les noms d'entreprises et de lieux ne sont pas masqués. Mesurez sur vos propres
 * textes avant de vous y fier.
 */
import {
  type NameFinder,
  type NameSpan,
  type NameToken,
  splitForModel,
  spansFromTokens,
} from "./names-core.ts";

export {
  maskTextsWithNames,
  type NameFinder,
  type NameSpan,
  type NameToken,
  splitForModel,
  spansFromTokens,
} from "./names-core.ts";

export interface TransformersNamesOptions {
  /** Modèle de reconnaissance d'entités (ONNX). Par défaut : multilingue, dont le français. */
  model?: string;
  /** Confiance minimale d'un jeton (0 à 1). Par défaut 0,5. */
  minScore?: number;
}

/** Modèle par défaut : allemand, anglais, espagnol, français, italien, néerlandais, portugais… */
export const DEFAULT_NAMES_MODEL = "Xenova/bert-base-multilingual-cased-ner-hrl";

type Classifier = (text: string, options: { ignore_labels: string[] }) => Promise<NameToken[]>;

/**
 * Détecteur de noms par `@huggingface/transformers` (gratuit, exécuté sur votre machine).
 * Le modèle est chargé au premier appel, une seule fois.
 */
export function transformersNames(options: TransformersNamesOptions = {}): NameFinder {
  let pret: Promise<Classifier> | null = null;
  const charger = async (): Promise<Classifier> => {
    // Nom dans une variable : la dépendance est facultative, résolue seulement ici.
    const paquet = "@huggingface/transformers";
    const bibliotheque = (await import(
      /* webpackIgnore: true */ /* turbopackIgnore: true */ paquet
    )) as {
      pipeline: (tache: string, modele: string) => Promise<Classifier>;
    };
    return bibliotheque.pipeline("token-classification", options.model ?? DEFAULT_NAMES_MODEL);
  };
  return async (text) => {
    if (!text.trim()) return [];
    pret ??= charger();
    const classer = await pret;
    const spans: NameSpan[] = [];
    for (const morceau of splitForModel(text)) {
      const jetons = await classer(morceau.text, { ignore_labels: [] });
      for (const s of spansFromTokens(morceau.text, jetons, options.minScore)) {
        spans.push({ start: s.start + morceau.offset, end: s.end + morceau.offset });
      }
    }
    return spans;
  };
}
