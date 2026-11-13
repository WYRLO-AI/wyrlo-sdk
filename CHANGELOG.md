# Changelog

All notable changes to the WYRLO SDKs. Versions follow [Semantic Versioning](https://semver.org).

## 0.1.2 (2026-11-13), `@wyrlo/mcp` only

- Everything the MCP server shows to agents is now in English: server instructions, tool
  titles and descriptions, parameter descriptions and error messages. The tools, their
  parameters and their results do not change.
- `@wyrlo/sdk` and `wyrlo` stay at 0.1.1 (no change).

## 0.1.1 (2026-11-13)

No change to the code or the API: documentation and package metadata only.

- Documentation in English for the three packages; the French versions stay in
  `README.fr.md`.
- Runnable examples in `examples/`: TypeScript, Python, LangChain, LlamaIndex, MCP.
- Package metadata: English descriptions, keywords, Python classifiers, links to the
  documentation, issues and changelog.
- `@wyrlo/mcp`: `server.json` and `mcpName` for the official MCP Registry.
- Free tier figures updated: 1,000 analysed questions per month, 500 documents in the
  no-copy index; one space per end customer (mode C) on the Developer and Production
  plans.

## 0.1.0 (2026-11-12)

First public release.

- `@wyrlo/sdk` (TypeScript): `guard`, `prepare`, `feedback`, client-side masking, no-copy
  index (`index`, `indexMany`, `search`, `remove`, `indexStats`, `removeTenant`).
- `wyrlo` (Python): the same API, plus LangChain and LlamaIndex integrations.
- `@wyrlo/mcp`: MCP server (stdio) with `wyrlo_prepare`, `wyrlo_search`, `wyrlo_guard`,
  `wyrlo_feedback`.
