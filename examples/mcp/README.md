# WYRLO MCP server in an agent

The server gives your agent four tools: `wyrlo_prepare`, `wyrlo_search`, `wyrlo_guard`
and `wyrlo_feedback`. The agent calls `wyrlo_guard` before answering: with `abstain`, it
says "I don't know" instead of guessing. Details: [`mcp/README.md`](../../mcp/README.md).

## Local server (stdio)

Most MCP clients read a JSON file with an `mcpServers` section, for example
`claude_desktop_config.json` (Claude Desktop) or `.cursor/mcp.json` (Cursor):

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

## Remote server (Streamable HTTP)

Nothing to install, for clients that accept a remote server with a header:

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

## A system prompt that uses it

```text
Before giving an answer based on documents, call wyrlo_guard with the question, the
passages you used and your draft answer. If the decision is "abstain", say you don't know
and name the documents that might contain the answer. Otherwise give the answer and cite
the passages marked kept.
```
