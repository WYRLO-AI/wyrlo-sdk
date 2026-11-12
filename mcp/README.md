# @wyrlo/mcp

Serveur MCP de WYRLO : votre agent cherche dans l'index sans copie et fait vérifier sa
réponse avant de la donner. S'il n'est pas sûr, il dit « je ne sais pas ».

Lancement : `npx @wyrlo/mcp` (Node 18+), avec votre clé dans `WYRLO_API_KEY`.

## Installation dans un client MCP

```json
{
  "mcpServers": {
    "wyrlo": {
      "command": "npx",
      "args": ["-y", "@wyrlo/mcp"],
      "env": { "WYRLO_API_KEY": "wyr_live_…" }
    }
  }
}
```

Variables : `WYRLO_API_KEY` (obligatoire), `WYRLO_BASE_URL`, `WYRLO_REGION` (Paris par
défaut), `WYRLO_TENANT` (espace d'un client final dans l'index, mode C ; facultatif). La
clé reste dans le processus du serveur ; elle n'est jamais transmise à l'agent.

## Serveur distant, sans installation

Pour les clients MCP qui acceptent un serveur distant avec un en-tête : mêmes outils, à
l'adresse `https://api.wyrlo.io/mcp` (transport « Streamable HTTP », sans session).

```json
{
  "mcpServers": {
    "wyrlo": {
      "type": "http",
      "url": "https://api.wyrlo.io/mcp",
      "headers": { "Authorization": "Bearer wyr_live_…" }
    }
  }
}
```

La clé est lue à chaque appel, transmise à l'API dans la région de Paris, jamais gardée ni
journalisée. Les appels comptent comme des appels directs à l'API. Pour une plateforme
(mode C), l'en-tête `x-wyrlo-tenant` fixe l'espace du client final où `wyrlo_search`
cherche.

L'espace vient toujours de la configuration du serveur, jamais de l'agent : un agent ne
peut pas chercher dans l'espace d'un autre client.

## Outils

| Outil            | Rôle                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `wyrlo_prepare`  | La question à chercher, enrichie du vocabulaire du projet.                                                                         |
| `wyrlo_search`   | Les adresses des passages les plus proches dans l'index sans copie (mode B, ouvert sur demande). Jamais de texte.                  |
| `wyrlo_guard`    | Vérifie la réponse contre ses passages. `abstain` : dire « je ne sais pas ». Signale aussi les injections et les passages périmés. |
| `wyrlo_feedback` | Retour de l'utilisateur final (pouce), avec le `trace_id` de `wyrlo_guard`. Aucun texte envoyé.                                    |

Avec l'index sans copie, l'agent cherche par `wyrlo_search`, relit le texte avec ses
propres outils (fichiers, base, outil métier), puis passe chaque passage à `wyrlo_guard`
avec son `address` recopiée telle quelle.

## Pannes

Comme le SDK, `wyrlo_guard` ne bloque jamais : si WYRLO est injoignable, la réponse revient
`unverified` et `degraded`. Une clé refusée, une requête invalide ou le mode B coupé
reviennent comme un résultat d'outil en erreur, avec leur code (`unauthorized`,
`invalid_request`, `index_disabled`).

## Protocole

stdio, JSON-RPC 2.0, un message par ligne ; versions du protocole 2025-06-18, 2025-03-26 et
2024-11-05. Aucune dépendance en plus de `@wyrlo/sdk`.
