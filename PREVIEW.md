# Preview: Go, PHP, Java and C# clients, n8n node

> Preview code, not published on any registry. Interfaces may still change.
> The n8n node is in [`n8n/`](n8n/).

Quatre petites bibliothèques **générées depuis la spécification OpenAPI**
(`https://api.wyrlo.io/openapi.json`) par l'outil de génération de WYRLO. Une méthode par
opération de l'API, aucune dépendance hors de la bibliothèque standard de chaque langage.

**Préversion** : l'interface peut encore changer, et rien n'est publié sur un registre
(Maven Central, NuGet, Packagist, pkg.go.dev). Pour TypeScript et Python, préférez les SDK
complets (`@wyrlo/sdk`, `wyrlo`) : ils ajoutent le mode dégradé, le masquage côté client et
la relecture des passages.

| Langage | Dossier   | Minimum             | Corps des requêtes et des réponses     | Essayé                                                  |
| ------- | --------- | ------------------- | -------------------------------------- | ------------------------------------------------------- |
| Go      | `go/`     | Go 1.21             | `map[string]any`                       | Oui (exemple contre un faux serveur)                    |
| PHP     | `php/`    | PHP 8.1, `ext-curl` | tableaux                               | Oui                                                     |
| Java    | `java/`   | Java 11             | chaînes JSON (votre bibliothèque JSON) | Oui                                                     |
| C#      | `csharp/` | .NET 6              | objets en entrée, `JsonNode` en sortie | **Non** : pas d'outil .NET sur la machine de génération |

Ce que fait chaque bibliothèque : adresse de l'API (`https://api.wyrlo.io/functions/v1`),
clé du projet dans `Authorization`, région de Paris (`x-region: eu-west-3`), délais (30
secondes, 60 pour la rédaction), erreurs de l'API levées avec leur statut et leur code.
Elle ne porte pas de types par schéma : les champs sont ceux de la spécification.

Une panne de WYRLO ne doit jamais bloquer votre utilisateur : sur une erreur réseau ou un
statut 5xx de `guard`, montrez la réponse de votre RAG comme non vérifiée.

## Exemples

Chaque dossier contient un exemple qui vérifie une réponse (`guard`), puis demande une
réponse citée et vérifiée (`answer`, préversion). La clé se lit dans `WYRLO_API_KEY`.

```bash
cd go     && WYRLO_API_KEY=wyr_test_… go run ./example
cd php    && WYRLO_API_KEY=wyr_test_… php example.php
cd java   && javac -d out src/main/java/io/wyrlo/*.java example/Example.java \
          && WYRLO_API_KEY=wyr_test_… java -cp out Example
cd csharp && WYRLO_API_KEY=wyr_test_… dotnet run --project Example
```

