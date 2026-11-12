# @wyrlo/sdk

SDK TypeScript de [WYRLO](https://www.wyrlo.io) : votre RAG dit « je ne sais pas »
plutôt qu'une réponse fausse.

Le paquet n'est pas encore publié sur npm : la version 0.1.0 est prête et sera publiée
à l'ouverture, sur accord du fondateur. Documentation : https://www.wyrlo.io/docs.

En attendant, installez-le depuis le dépôt :

```bash
cd typescript && npm install && npm run build
npm install /chemin/vers/wyrlo-sdk/typescript
```

Node 18+, Deno, Bun. **Côté serveur uniquement** : la clé ne doit jamais atteindre un
navigateur.

## Utilisation

```ts
import { Wyrlo } from "@wyrlo/sdk";

const wyrlo = new Wyrlo(); // lit WYRLO_API_KEY

const res = await wyrlo.guard({
  question,
  passages: docs.map((d) => ({ id: d.id, text: d.text, source: d.file })),
  answer, // la réponse produite par votre LLM
});

if (res.decision === "abstain") {
  return "Je ne sais pas. " + res.reason;
}
return res.answer; // citez res.passages.filter((p) => p.kept)
```

Recommandé : préparez la recherche avec le vocabulaire de vos réglages, et passez le
même `requestId` à `guard` :

```ts
const prepared = await wyrlo.prepare({ question });
const docs = await search(prepared.query); // votre recherche
const res = await wyrlo.guard({ question, passages, answer, requestId: prepared.request_id });
```

`prepare` ne lève pas d'exception en cas de panne : il renvoie la question d'origine
(`degraded: true`).

Si votre interface propose un pouce (en haut / en bas), transmettez-le avec le
`trace_id` de la réponse. Aucun texte n'est envoyé ; WYRLO s'en sert pour juger ses
corrections sans appel payant :

```ts
await wyrlo.feedback({ traceId: res.trace_id, helpful: true });
```

Ou laissez le SDK appeler votre LLM :

```ts
const res = await wyrlo.guard({
  question,
  passages,
  generate: (passages) => llm.answer(question, passages),
});
```

## Ce que renvoie `guard`

| Champ                   | Sens                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `decision`              | `answer` ou `abstain` (« je ne sais pas »)                                                                           |
| `confidence`            | `certain`, `probable`, `uncertain`, `unverified` (réponse transmise sans aucun contrôle)                             |
| `confidence_score`      | Score de cohérence de la réponse (anglais), ou score des signaux (autres langues) ; null si rien n'a pu être vérifié |
| `passages[].kept`       | Passages à citer ; `injection: true` = écarté                                                                        |
| `unsupported_sentences` | Phrases de la réponse qu'aucun passage n'appuie                                                                      |
| `skipped_steps`         | Traitements sautés côté WYRLO (serveur lent ou indisponible)                                                         |
| `language`              | Langue retenue (précisée ou devinée), null si inconnue                                                               |
| `rerank_method`         | `similarity` (passages réordonnés par similarité), `none` (ordre de votre recherche) ; la similarité reste un signal |
| `verification_method`   | `answer` (anglais) ; `sentences` ; `signals` (autres langues) ; `model` (français, modèle de langue) ; `none`        |
| `degraded`              | Mode dégradé : traitement sauté, WYRLO injoignable ou plafond atteint ; toujours vrai si `unverified`                |
| `quota_exceeded`        | Vrai si le plafond mensuel de l'offre gratuite est atteint (2 000 questions analysées)                               |
| `settings_variant`      | Pendant un test partiel des réglages : `control` ou `candidate` ; null sinon                                         |
| `trace_id`              | Identifiant de la trace dans votre espace WYRLO (null si la question n'a pas été analysée)                           |

## Pannes : jamais bloquant

Panne réseau, délai dépassé (3 s au total par défaut, nouvelle tentative comprise) ou
erreur 5xx : le SDK réessaie une fois avec le même `request_id` (la question n'est comptée qu'une fois),
puis renvoie un résultat **dégradé** : `decision: "answer"`, `confidence: "unverified"`,
`degraded: true`. Votre utilisateur a toujours une réponse.

Plafond mensuel de l'offre gratuite atteint (2 000 questions analysées par mois) : même
résultat dégradé, avec `quota_exceeded: true`, jusqu'au mois suivant.

Une erreur de votre intégration (clé absente ou révoquée, requête invalide) lève une
`WyrloError` (`status`, `code`, `details`), pour être vue dès le développement.

## Options

```ts
new Wyrlo({
  apiKey: "wyr_live_…", // par défaut WYRLO_API_KEY
  baseUrl: "…", // par défaut WYRLO_BASE_URL, sinon DEFAULT_BASE_URL
  region: "eu-west-3", // par défaut WYRLO_REGION, sinon eu-west-3 (Paris)
  timeoutMs: 3000, // au total, nouvelle tentative comprise
  maxRetries: 1,
  mask: false, // true : masquage sur votre serveur avant l'envoi (voir ci-dessous)
});
```

## Masquage côté client

WYRLO masque les données personnelles reconnaissables avant tout traitement. Avec
`mask: true`, ce masquage se fait **sur votre serveur, avant l'envoi** : les valeurs ne
quittent jamais votre machine, WYRLO ne reçoit que des marques (`[EMAIL_1]`,
`[TELEPHONE_1]`…).

```ts
const wyrlo = new Wyrlo({ mask: true });
const res = await wyrlo.guard({ question, passages, answer });
// res.answer, res.reason et res.unsupported_sentences contiennent les vraies valeurs.
// res.local_masking : { method: "rules", counts: { EMAIL: 2, TELEPHONE: 1 } }
```

Masqués (règles avec contrôle de validité, les mêmes que celles de WYRLO) : e-mails,
téléphones (France et international), IBAN (clé vérifiée), cartes bancaires (contrôle de
Luhn), numéro de sécurité sociale (clé vérifiée ou mot-clé proche), adresses IP, numéros
de passeport et de carte d'identité (avec un mot-clé), adresses postales (numéro et type
de voie), clés d'API et jetons reconnaissables. Une même valeur reçoit la même marque
dans la question, la réponse et les passages : la vérification reste exacte.

**Non masqués** : les noms de personnes et d'entreprises, les adresses sans numéro ni type
de voie (lieu-dit), et tout identifiant sans forme reconnaissable (numéro client interne…). Les dates, montants et numéros de commande
restent aussi : la vérification doit pouvoir les comparer. Pour aller plus loin, passez
votre propre fonction, par exemple un modèle de détection des noms qui tourne chez vous :

```ts
const wyrlo = new Wyrlo({
  // Reçoit tous les textes d'un appel, rend autant de textes masqués.
  mask: async (texts) => texts.map((t) => monMasquage(t)),
});
```

Si le masquage échoue (exception, nombre de textes différent), **rien n'est envoyé** :
la réponse passe sans vérification (`degraded: true`, étape `anonymize` dans
`skipped_steps`). Les fonctions `maskTexts` et `unmaskText` sont aussi exportées.

## Index sans copie (mode B)

Ouvert sur demande, projet par projet. WYRLO découpe vos documents, masque les données
personnelles, calcule les vecteurs (Mistral AI, point d'accès européen), puis oublie le
texte : seuls l'adresse, l'empreinte et le vecteur de chaque passage sont gardés.

```ts
await wyrlo.index("docs/cgv.md", {
  version: "2026-11-07",
  title: "Conditions générales de vente", // recommandé : meilleure recherche, jamais conservé
  text: contenu,
  labels: ["cgv"],
});
// Beaucoup de documents : 100 par appel, un résultat par document.
const lot = await wyrlo.indexMany(
  fichiers.map((f) => ({ id: f.chemin, version: f.version, title: f.titre, text: f.texte })),
);

// 8 passages (environ 600 caractères chacun) : assez de contexte pour la réponse.
const { results, degraded } = await wyrlo.search({ question, k: 8 });
// Relisez le texte chez vous, puis vérifiez la réponse avec l'adresse de chaque passage :
const passages = results.map(({ document, version, start, length, fingerprint }) => ({
  id: `${document}#${start}`,
  text: lireChezVous(document).slice(start, start + length),
  address: { document, version, start, length, fingerprint },
}));
const res = await wyrlo.guard({ question, passages, generate });
// Un passage modifié depuis son indexation revient avec `stale: true` : c'est un signal,
// il ne change pas la décision. Relisez le document à jour et réindexez-le.

await wyrlo.remove("docs/cgv.md"); // toujours possible, même mode B coupé
await wyrlo.indexStats(); // chiffres seulement, aucun identifiant
```

- `search` ne lève jamais d'exception pour une panne : liste vide, `degraded: true`, à
  compléter par votre propre recherche. `keywordHits` fusionne vos résultats par mots-clés.
- `index`, `remove` et `indexStats` lèvent une `WyrloError` pour toute erreur, panne
  comprise (`unavailable`) : refaire l'appel est sans risque (même `version` : « unchanged »).
- Mode B coupé : `WyrloError` 403 `index_disabled`.
- Avec l'option `mask`, `index` refuse d'envoyer le texte (`mask_unsupported`), car
  positions et empreintes doivent porter sur votre texte d'origine ; passez
  `allowUnmasked: true` pour l'envoyer quand même. Dans `guard`, un passage dont le
  masquage change le texte part sans son adresse (il ne serait jamais reconnu).
- `indexMany` : jusqu'à 100 documents en un appel (corps de 512 Kio au plus), dans le même
  espace, avec un résultat par document (`indexed`, `unchanged` ou `failed`). Un document
  refusé n'empêche pas les autres ; avec le code `overloaded`, renvoyez-le plus tard.
- `title` (facultatif, 300 caractères au plus) : titre du document, placé en tête de chaque
  passage pour le calcul des vecteurs, jamais conservé. Envoyez-le quand le document en a
  un : mesuré sur 283 questions jamais vues, le bon passage arrive dans les 5 premiers pour
  85,2 % des questions avec le titre, contre 79,9 % sans. Changez la `version` si le titre
  change.
- Limites : 5 000 documents et 100 000 passages par projet ; 2 000 passages et
  400 000 caractères par document.

### Un espace par client final (mode C, plateformes)

Si vous offrez un assistant à vos propres clients, rangez les documents de chacun dans
son espace, avec un identifiant opaque de votre choix (jamais un nom ni une adresse
e-mail ; lettres, chiffres, « . _ : - », 100 caractères au plus). Chaque recherche ne voit
qu'un seul espace, filtré par la base de WYRLO :

```ts
await wyrlo.index("cgv.md", { version: "v3", text: contenu, tenant: "client-42" });
await wyrlo.search({ question, tenant: "client-42" }); // jamais les documents d'un autre
await wyrlo.remove("cgv.md", { tenant: "client-42" });
await wyrlo.indexStats({ tenant: "client-42" });
await wyrlo.removeTenant("client-42"); // tout l'espace, tout de suite (fin de contrat)
```

Sans `tenant`, tout se passe dans l'espace par défaut du projet. Les limites restent
celles du projet.

## Adresse de l'API

Par défaut, le SDK appelle `DEFAULT_BASE_URL` (exporté par le paquet) :
`https://api.wyrlo.io/functions/v1` (point d'entrée `/guard`).
Pour en changer : l'option `baseUrl`, sinon la variable d'environnement
`WYRLO_BASE_URL` ; une valeur vide retombe sur l'adresse par défaut et les barres
obliques finales sont retirées.

Avant le lancement, `https://api.wyrlo.io/functions/v1` deviendra l'adresse par
défaut ; l'adresse actuelle continuera de fonctionner. Les appels vont directement de
votre serveur à l'API, sans relais.

## Région de traitement

Chaque appel envoie l'en-tête `x-region: eu-west-3`. Sans lui, Supabase exécuterait la
fonction dans la région la plus proche de votre serveur (par exemple `us-east-1`), alors
que la question, les passages et la réponse y arrivent en clair, avant masquage. Avec
lui, le traitement reste à Paris ; l'en-tête de réponse `x-sb-edge-region` le confirme.
Une valeur vide pour `region` ou `WYRLO_REGION` retombe sur `eu-west-3`.

Référence de l'API : https://www.wyrlo.io/docs.
