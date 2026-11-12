# WYRLO SDKs

Official TypeScript and Python clients for the [WYRLO](https://www.wyrlo.io) API: check a
RAG answer against its sources before showing it, and say "I don't know" instead of a
wrong answer.

| Package | Folder | Install (once published) |
| --- | --- | --- |
| `@wyrlo/sdk` (TypeScript, Node 18+) | [`typescript/`](typescript/) | `npm install @wyrlo/sdk` |
| `wyrlo` (Python 3.9+, LangChain and LlamaIndex extras) | [`python/`](python/) | `pip install wyrlo` |
| `@wyrlo/mcp` (MCP server for agents, Node 18+) | [`mcp/`](mcp/) | `npx @wyrlo/mcp` |

Documentation: https://www.wyrlo.io/docs

API access is currently on request: https://www.wyrlo.io/fr/demander-un-acces

These SDKs are licensed under the [Apache License 2.0](LICENSE). The WYRLO service
(API, verification engine, nightly loop, developer console) is proprietary and is not
part of this repository; using it requires a WYRLO account and API key, under the WYRLO
terms of service. The Apache License does not grant rights to the WYRLO name or
logo (section 6).

## Development

```sh
cd typescript && npm install && npm test && npm run build
cd mcp && npm install && npm test   # after building typescript/
cd python && python -m pip install -e ".[langchain,llamaindex]" && python -m unittest discover -s tests
```

Security issues: see [SECURITY.md](SECURITY.md).
