# @wyrlo/mcp

MCP server for [WYRLO](https://www.wyrlo.io): your agent searches the no-copy index and
has its answer verified before giving it. If it is not sure, it says "I don't know".

[Version française](https://github.com/WYRLO-AI/wyrlo-sdk/blob/main/mcp/README.fr.md)

Start: `npx @wyrlo/mcp` (Node 18+), with your key in `WYRLO_API_KEY`. API access is
currently on request: https://www.wyrlo.io/fr/demander-un-acces.

## Setup in an MCP client

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

Variables: `WYRLO_API_KEY` (required), `WYRLO_BASE_URL`, `WYRLO_REGION` (Paris by
default), `WYRLO_TENANT` (an end customer's space in the index, mode C; optional). The key
stays in the server process; it is never passed to the agent.

## Remote server, no install

For MCP clients that accept a remote server with a header: same tools, at
`https://api.wyrlo.io/mcp` ("Streamable HTTP" transport, stateless).

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

The key is read on each call, sent to the API in the Paris region, never kept or logged.
Calls count as direct API calls. For a platform (mode C), the `x-wyrlo-tenant` header sets
the end customer's space where `wyrlo_search` looks.

The space always comes from the server configuration, never from the agent: an agent
cannot search another customer's space.

## Tools

| Tool             | Role                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `wyrlo_prepare`  | The question to search for, enriched with the project's vocabulary.                                                                         |
| `wyrlo_search`   | The addresses of the closest passages in the no-copy index (mode B, open on request). Never any text.                                       |
| `wyrlo_guard`    | Verifies the answer against its passages. `abstain`: say "I don't know". Also flags injections and stale passages.                          |
| `wyrlo_answer`   | Writes an answer from the passages read, then verifies it: sentences with their confidence and sources; "I don't know" with leads. Preview. |
| `wyrlo_feedback` | End-user feedback (thumbs), with the `trace_id` from `wyrlo_guard`. No text sent.                                                           |

With the no-copy index, the agent searches with `wyrlo_search`, reads the text with its
own tools (files, database, business tool), then passes each passage to `wyrlo_guard`
with its `address` copied as is.

## Outages

Like the SDK, `wyrlo_guard` never blocks: if WYRLO is unreachable, the answer comes back
`unverified` and `degraded`. A refused key, an invalid request or mode B turned off come
back as a tool result in error, with their code (`unauthorized`, `invalid_request`,
`index_disabled`).

## Protocol

stdio, JSON-RPC 2.0, one message per line; protocol versions 2025-06-18, 2025-03-26 and
2024-11-05. No dependency besides `@wyrlo/sdk`.
