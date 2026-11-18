# Changelog

All notable changes to the WYRLO SDKs. Versions follow [Semantic Versioning](https://semver.org).

## Unreleased (preview, on the `preview` branch)

Not published on any registry. Interfaces may still change.

- `answer()` in `@wyrlo/sdk` and `wyrlo`, `wyrlo_answer` tool in `@wyrlo/mcp`: a model
  writes the answer from the passages, WYRLO always verifies it, and the answer comes back
  sentence by sentence with its sources, or as "I don't know" with leads
  (`POST /v1/answer`, preview).
- `tenant` on `guard()`: the end customer a verification is made for (platforms).
- `wyrlo` (Python): `output_verifier` and `answer_chain` for LangChain, `verify_response`
  and `AnswerQueryEngine` for LlamaIndex.
- Reading your documents on your machine, then cutting them along their structure:
  `wyrlo.documents` in Python (PDF with tables, DOCX, PPTX, XLSX, HTML, Markdown; extra
  `wyrlo[documents]`), `@wyrlo/sdk/documents` in TypeScript (Markdown, HTML, DOCX, PDF with
  text). Each table row carries its headers.
- `context` on the passages you index: the table headers or section title of a passage,
  used for the vectors only.
- `ocr()` in `wyrlo` (Python): reads a scanned PDF. The service route is closed by default.
- Reports and tests in `@wyrlo/sdk` and `wyrlo`: `gaps()` (topics your users ask about that
  your documents do not cover, by period and end customer), `quality()` (week by week) and
  `regression()` (compare two versions of your RAG on a reference set, with confidence
  intervals and a McNemar test; nothing is stored).
- Names of people masked on your machine before sending: `mask: { names: transformersNames() }`
  (`@wyrlo/sdk/names`, optional `@huggingface/transformers`) and
  `mask={"names": spacy_names(...)}` (`wyrlo.names`, extra `wyrlo[names]`). A language model
  makes mistakes: see the README for what was measured.
- An answer that is itself a refusal ("I couldn't find this in the documents") now comes back
  as `abstain` from the service: nothing to change in your code.
- New preview folders: `go/`, `php/`, `java/`, `csharp/` (clients generated from the
  OpenAPI specification, see `PREVIEW.md`; the C# client has not been compiled yet) and
  `n8n/` (n8n node, not yet run in a real n8n).

## 0.1.2 (2026-11-13)

English by default, everywhere a developer reads a message.

- The API answers in English by default: the `reason` of each decision and the error
  messages. Send `Accept-Language: fr` to get them in French. The fields, codes and
  decisions do not change.
- `@wyrlo/sdk` and `wyrlo`: new `locale` option (`"en"` or `"fr"`), sent as the
  `Accept-Language` header; without it, the API answers in English. The SDKs' own messages
  (degraded mode, errors) are now in English.
- `wyrlo` (LangChain and LlamaIndex integrations): the default prompt is now in English.
- `@wyrlo/mcp`: everything the server shows to agents is now in English: server
  instructions, tool titles and descriptions, parameter descriptions and error messages.
  The tools, their parameters and their results do not change.

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
