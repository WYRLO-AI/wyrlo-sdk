# wyrlo

[English](https://github.com/WYRLO-AI/wyrlo-sdk/blob/main/python/README.md)

SDK Python de [WYRLO](https://www.wyrlo.io) : votre RAG dit « je ne sais pas » plutôt
qu'une réponse fausse. Python 3.9+, aucune dépendance. **Côté serveur uniquement.**

```bash
pip install wyrlo                      # SDK seul
pip install "wyrlo[langchain]"         # avec LangChain
pip install "wyrlo[llamaindex]"        # avec LlamaIndex
```

Documentation : https://www.wyrlo.io/docs. L'accès à l'API se fait sur demande pour
l'instant : https://www.wyrlo.io/fr/demander-un-acces.

## Utilisation

```python
from wyrlo import Wyrlo

wyrlo = Wyrlo()  # lit WYRLO_API_KEY

res = wyrlo.guard(
    question=question,
    passages=[{"id": d.id, "text": d.text, "source": d.file} for d in docs],
    answer=answer,  # la réponse produite par votre LLM
)

if not res.should_answer:
    return "Je ne sais pas. " + res.reason
return res.answer  # citez res.kept_passages
```

Recommandé : préparez la recherche avec le vocabulaire de vos réglages, et passez le
même identifiant de requête à `guard` :

```python
prepared = wyrlo.prepare(question)
docs = search(prepared.query)  # votre recherche
res = wyrlo.guard(question=question, passages=..., answer=answer,
                  request_id=prepared.request_id)
```

`prepare` ne lève pas d'exception en cas de panne : il renvoie la question d'origine
(`degraded=True`). Pendant un test partiel des réglages, `res.settings_variant` vaut
`"control"` ou `"candidate"`.

Si votre interface propose un pouce (en haut / en bas), transmettez-le avec le
`trace_id` de la réponse (aucun texte envoyé) : `wyrlo.feedback(res.trace_id, helpful=True)`.

Ou laissez le SDK appeler votre LLM : `generate=lambda passages: llm(question, passages)`.
Les passages peuvent aussi être de simples chaînes.

## LangChain et LlamaIndex

Deux petites intégrations, testées avec les vraies bibliothèques (versions de
`requirements-integrations.txt`). Elles appellent votre retriever et votre LLM, puis
`guard` ; le résultat est le même `GuardResult`, et une panne de WYRLO ne lève jamais
d'exception.

```bash
pip install "wyrlo[langchain]"     # ajoute langchain-core
pip install "wyrlo[llamaindex]"    # ajoute llama-index-core
```

```python
from wyrlo.langchain import guarded_chain

rag = guarded_chain(retriever, prompt | llm)   # prompt : {question} et {context}
res = rag.invoke("Quel est le délai de rétractation ?")
```

```python
from wyrlo.llamaindex import GuardedQueryEngine

engine = GuardedQueryEngine(index.as_retriever(similarity_top_k=5), llm)
res = engine.query("Quel est le délai de rétractation ?")
```

Passages envoyés : identifiant (`Document.id` ou `node_id`), texte, source
(`metadata["source"]`, ou `file_name` pour LlamaIndex) et score s'il existe.

## Pannes : jamais bloquant

Panne réseau, délai dépassé (3 s au total par défaut, nouvelle tentative comprise) ou erreur 5xx :
une nouvelle tentative
avec le même `request_id` (la question n'est comptée qu'une fois), puis un résultat
**dégradé** : `decision="answer"`, `confidence="unverified"`, `degraded=True`.

Plafond mensuel de l'offre gratuite atteint (1 000 questions analysées par mois) : même
résultat dégradé, avec `quota_exceeded=True`, jusqu'au mois suivant.

Une clé absente ou refusée, ou une requête invalide, lève `WyrloError`
(`status`, `code`, `details`).

## Options

```python
Wyrlo(api_key="wyr_live_…", base_url=None, timeout=3.0, max_retries=1, region=None, mask=None)
```

`base_url` : par défaut `WYRLO_BASE_URL`, sinon `DEFAULT_BASE_URL` (exporté par le
paquet) : `https://api.wyrlo.io/functions/v1` (point d'entrée `/guard`) ; la valeur
n'est écrite qu'à cet endroit du code. Une valeur vide retombe sur l'adresse par
défaut ; les barres obliques finales sont retirées.

`region` : par défaut `WYRLO_REGION`, sinon `eu-west-3` (Paris ; une valeur vide
retombe aussi sur Paris). Chaque appel envoie l'en-tête `X-Region` : sans lui, Supabase
exécuterait la fonction dans la région la plus proche de votre serveur (par exemple
`us-east-1`), alors que la question, les passages et la réponse y arrivent en clair,
avant masquage. L'en-tête de réponse `x-sb-edge-region` confirme la région de traitement.

## Masquage côté client

WYRLO masque les données personnelles reconnaissables avant tout traitement. Avec
`mask=True`, ce masquage se fait **sur votre serveur, avant l'envoi** : les valeurs ne
quittent jamais votre machine, WYRLO ne reçoit que des marques (`[EMAIL_1]`,
`[TELEPHONE_1]`…).

```python
wyrlo = Wyrlo(mask=True)
res = wyrlo.guard(question=question, passages=passages, answer=answer)
# res.answer, res.reason et res.unsupported_sentences contiennent les vraies valeurs.
# res.local_masking : LocalMasking(method="rules", counts={"EMAIL": 2, "TELEPHONE": 1})
```

Masqués (règles avec contrôle de validité, les mêmes que celles de WYRLO, bibliothèque
standard seulement) : e-mails, téléphones (France et international), IBAN (clé vérifiée),
cartes bancaires (contrôle de Luhn), numéro de sécurité sociale (clé vérifiée ou mot-clé
proche), adresses IP, numéros de passeport et de carte d'identité (avec un mot-clé),
adresses postales (numéro et type de voie), clés d'API et jetons reconnaissables. Une
même valeur reçoit la même marque dans la question, la réponse et les passages.

**Non masqués** : les noms de personnes et d'entreprises, les adresses sans numéro ni type
de voie (lieu-dit), et tout identifiant sans forme reconnaissable. Les dates, montants et numéros de commande restent aussi : la
vérification doit pouvoir les comparer. Pour les noms, passez votre propre fonction, par
exemple Presidio installé sur votre machine (rien n'en sort) :

```python
from presidio_analyzer import AnalyzerEngine
from presidio_anonymizer import AnonymizerEngine

analyseur, anonymiseur = AnalyzerEngine(), AnonymizerEngine()

def masque(textes):
    # Reçoit tous les textes d'un appel, rend autant de textes masqués.
    return [
        anonymiseur.anonymize(text=t, analyzer_results=analyseur.analyze(text=t, language="en")).text
        for t in textes
    ]

wyrlo = Wyrlo(mask=masque)
```

Si le masquage échoue (exception, nombre de textes différent), **rien n'est envoyé** :
la réponse passe sans vérification (`degraded=True`, étape `anonymize` dans
`skipped_steps`). Les fonctions `mask_texts` et `unmask_text` sont aussi exportées.

## Index sans copie (mode B)

Ouvert sur demande, projet par projet. WYRLO découpe vos documents, masque les données
personnelles, calcule les vecteurs (Mistral AI, point d'accès européen), puis oublie le
texte : seuls l'adresse, l'empreinte et le vecteur de chaque passage sont gardés.

```python
wyrlo.index(
    "docs/cgv.md",
    "2026-11-07",
    title="Conditions générales de vente",  # recommandé : meilleure recherche, jamais conservé
    text=contenu,
    labels=["cgv"],
)
# Beaucoup de documents : 100 par appel, un résultat par document.
lot = wyrlo.index_many(
    [{"id": f.chemin, "version": f.version, "title": f.titre, "text": f.texte} for f in fichiers]
)

# 8 passages (environ 600 caractères chacun) : assez de contexte pour la réponse.
res = wyrlo.search(question, k=8)
passages = [
    {
        "id": f"{r['document']}#{r['start']}",
        "text": lire_chez_vous(r["document"])[r["start"] : r["start"] + r["length"]],
        "address": {k: r[k] for k in ("document", "version", "start", "length", "fingerprint")},
    }
    for r in res.results
]
out = wyrlo.guard(question=question, passages=passages, generate=generate)
# Un passage modifié depuis son indexation revient avec stale=True : c'est un signal,
# il ne change pas la décision. Relisez le document à jour et réindexez-le.

wyrlo.remove("docs/cgv.md")  # toujours possible, même mode B coupé
wyrlo.index_stats()  # chiffres seulement, aucun identifiant
```

- `search` ne lève jamais d'exception pour une panne : liste vide, `degraded=True`, à
  compléter par votre propre recherche. `keyword_hits` fusionne vos résultats par mots-clés.
- `index`, `remove` et `index_stats` lèvent `WyrloError` pour toute erreur, panne comprise
  (`unavailable`) : refaire l'appel est sans risque (même `version` : « unchanged »).
- Mode B coupé : `WyrloError` 403 `index_disabled`.
- Avec l'option `mask`, `index` refuse d'envoyer le texte (`mask_unsupported`), car
  positions et empreintes doivent porter sur votre texte d'origine ; passez
  `allow_unmasked=True` pour l'envoyer quand même. Dans `guard`, un passage dont le
  masquage change le texte part sans son adresse (il ne serait jamais reconnu).
- `index_many` : jusqu'à 100 documents en un appel (corps de 512 Kio au plus), dans le même
  espace, avec un résultat par document (`indexed`, `unchanged` ou `failed`). Un document
  refusé n'empêche pas les autres ; avec le code `overloaded`, renvoyez-le plus tard.
- `title` (facultatif, 300 caractères au plus) : titre du document, placé en tête de chaque
  passage pour le calcul des vecteurs, jamais conservé. Envoyez-le quand le document en a
  un : mesuré sur 283 questions jamais vues, le bon passage arrive dans les 5 premiers pour
  85,2 % des questions avec le titre, contre 79,9 % sans. Changez la `version` si le titre
  change.
- Limites : 5 000 documents (500 sur l'offre Gratuit) et 100 000 passages par projet ; 2 000 passages et
  400 000 caractères par document.

### Un espace par client final (mode C, plateformes)

Offres Développeur et Production (sur l'offre Gratuit, un appel avec `tenant` est refusé :
422 `invalid_request` sur le champ `tenant`).

Si vous offrez un assistant à vos propres clients, rangez les documents de chacun dans
son espace, avec un identifiant opaque de votre choix (jamais un nom ni une adresse
e-mail ; lettres, chiffres, « . _ : - », 100 caractères au plus). Chaque recherche ne voit
qu'un seul espace, filtré par la base de WYRLO :

```python
wyrlo.index("cgv.md", "v3", text=contenu, tenant="client-42")
wyrlo.search(question, tenant="client-42")  # jamais les documents d'un autre
wyrlo.remove("cgv.md", tenant="client-42")
wyrlo.index_stats(tenant="client-42")
wyrlo.remove_tenant("client-42")  # tout l'espace, tout de suite (fin de contrat)
```

Sans `tenant`, tout se passe dans l'espace par défaut du projet. Les limites restent
celles du projet.
Les retrievers LangChain et LlamaIndex prennent le même paramètre :
`WyrloRetriever(client=wyrlo, read=lire, tenant="client-42")`.

`passages_from_search(res.results, read)` fait la boucle ci-dessus pour vous : `read`
reçoit `(document, version, start, length)` et rend le texte, ou `None` si le document
n'existe plus (le résultat est alors écarté). Pour LangChain et LlamaIndex, un retriever
fait la même chose et garde l'adresse jusqu'à `guard` :

```python
from wyrlo.langchain import WyrloRetriever, guarded_chain

rag = guarded_chain(WyrloRetriever(client=wyrlo, read=read, k=8), prompt | llm)

from wyrlo.llamaindex import GuardedQueryEngine, WyrloRetriever

engine = GuardedQueryEngine(WyrloRetriever(wyrlo, read, k=8), llm)
```

## Tests

```bash
python3 -m unittest discover -s tests
```

Les tests des intégrations sont sautés si les bibliothèques manquent ;
`scripts/deploy.sh` les lance dans un environnement où elles sont installées.
