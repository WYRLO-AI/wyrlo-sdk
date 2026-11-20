# WYRLO pour n8n (préversion)

Un nœud n8n pour brancher WYRLO dans un flux : vérifier la réponse d'un modèle contre ses
passages, chercher dans l'index sans copie, ou obtenir une réponse citée et vérifiée.

**Préversion, non publié** : le paquet n'est pas sur npm (publication à valider par le
fondateur) et il n'a pas été lancé dans un vrai n8n. Le logo est provisoire.

## Opérations

| Opération     | Route de l'API       | Entrées                            | Sortie                                         |
| ------------- | -------------------- | ---------------------------------- | ---------------------------------------------- |
| Verify Answer | `POST /guard`        | question, réponse, passages (JSON) | `decision` (`answer` ou `abstain`), confiance  |
| Answer        | `POST /guard/answer` | question, passages (JSON)          | réponse, phrases avec leurs sources, ou pistes |
| Search        | `POST /guard/search` | question, nombre de résultats      | adresses des passages (jamais le texte)        |

Champs facultatifs : client final (`tenant`) et langue.

## Essai local (pour qui veut l'essayer avant publication)

1. Dans un n8n auto-hébergé, dossier `~/.n8n/custom/` : copier ce dossier, puis redémarrer
   n8n.
2. Créer un identifiant « WYRLO API » avec la clé du projet (`wyr_test_…`).
3. Ajouter le nœud « WYRLO » après le nœud qui rédige la réponse ; brancher la question, la
   réponse et les passages ; puis un nœud « IF » sur `decision` : `answer` montre la
   réponse, `abstain` affiche « je ne sais pas ».

En cas de panne de WYRLO (erreur réseau ou statut 5xx), réglez le nœud sur « Continue On
Fail » et montrez la réponse comme non vérifiée : WYRLO ne doit jamais bloquer votre flux.
