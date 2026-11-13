<div align="center">

# WYRLO SDKs

**Stop RAG hallucinations before your users see them.**
Check every LLM answer against its sources, cite what supports it, and say
_"I don't know"_ instead of a confident wrong answer.

[![npm @wyrlo/sdk](https://img.shields.io/npm/v/@wyrlo/sdk?label=%40wyrlo%2Fsdk)](https://www.npmjs.com/package/@wyrlo/sdk)
[![npm @wyrlo/mcp](https://img.shields.io/npm/v/@wyrlo/mcp?label=%40wyrlo%2Fmcp)](https://www.npmjs.com/package/@wyrlo/mcp)
[![PyPI wyrlo](https://img.shields.io/pypi/v/wyrlo?label=pypi%20wyrlo)](https://pypi.org/project/wyrlo/)
[![Python 3.9+](https://img.shields.io/badge/python-3.9%2B-blue)](python/)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)

[Documentation](https://www.wyrlo.io/docs) · [Examples](examples/) · [Request API access](https://www.wyrlo.io/fr/demander-un-acces) · [Français](#en-français)

<img src="assets/demo.gif" alt="A RAG answer checked by WYRLO: a supported answer passes with its sources; an unsupported one becomes &quot;I don't know&quot;." width="760">

</div>

## Why

Your retrieval finds passages, your LLM writes an answer. When the passages don't contain
the answer, the LLM often fills the gap anyway, and the wrong answer looks exactly like a
right one. WYRLO sits after your LLM, in one API call:

- **Verifies** each answer against the passages it was given (live in English and French).
- **Decides**: `answer` with a confidence level (`certain`, `probable`, `uncertain`), or
  `abstain`, so your app says "I don't know".
- **Shows its work**: the passages to cite, the sentences no passage supports, and passages
  carrying hidden instructions (prompt injection), which are set aside.
- **Never blocks you**: if WYRLO is slow or unreachable, your answer goes through, marked
  `unverified`.

Your retrieval and your LLM stay yours. WYRLO does not replace them.

## Packages

| Package                                                                | Folder                       | Install                  |
| ---------------------------------------------------------------------- | ---------------------------- | ------------------------ |
| `@wyrlo/sdk`: TypeScript, Node 18+, Deno, Bun                          | [`typescript/`](typescript/) | `npm install @wyrlo/sdk` |
| `wyrlo`: Python 3.9+, no dependencies, LangChain and LlamaIndex extras | [`python/`](python/)         | `pip install wyrlo`      |
| `@wyrlo/mcp`: MCP server for agents, Node 18+                          | [`mcp/`](mcp/)               | `npx @wyrlo/mcp`         |

## Quickstart

```ts
import { Wyrlo } from "@wyrlo/sdk";

const wyrlo = new Wyrlo(); // reads WYRLO_API_KEY

const res = await wyrlo.guard({ question, passages, answer }); // answer: your LLM's output

if (res.decision === "abstain") return "I don't know.";
return res.answer; // cite res.passages.filter((p) => p.kept)
```

```python
from wyrlo import Wyrlo

wyrlo = Wyrlo()  # reads WYRLO_API_KEY

res = wyrlo.guard(question=question, passages=passages, answer=answer)
print(res.answer if res.should_answer else "I don't know.")
```

LangChain and LlamaIndex in two lines, an MCP server for agents, and runnable files:
see [`examples/`](examples/).

## Measured, not promised

On a sealed control set of 64 cases written by someone outside WYRLO (32 in French,
32 in English, half correct answers and half wrong ones: wrong figure, reversed
negation, invented or contradicted facts…), WYRLO made **31 correct decisions out of 32
in each language (97%)**. A correct decision lets a right answer through or stops a wrong
one. Measured in production on October 5, 2026, one call at a time. With 32 cases per
language, the 95% confidence interval runs from 84% to 99%: these figures place the
reliability, they do not guarantee it.

## Privacy

- Recognisable personal data (e-mails, phone numbers, IBANs, card numbers…) is masked
  before any processing. With `mask: true`, masking happens **on your server**, before
  sending: the values never leave your machine.
- Processing runs in Paris (`eu-west-3`) by default.
- Optional no-copy index (on request): WYRLO keeps only the address, fingerprint and
  vector of each passage, never its text.

## Access

The API is currently open on request: [request access](https://www.wyrlo.io/fr/demander-un-acces).
The free tier includes 1,000 analysed questions per month.

## License

These SDKs are licensed under the [Apache License 2.0](LICENSE). The WYRLO service
(API, verification engine, nightly loop, developer console) is proprietary and is not
part of this repository; using it requires a WYRLO account and API key, under the WYRLO
terms of service. The Apache License does not grant rights to the WYRLO name or
logo (section 6).

## Contributing

Issues and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Security
issues: see [SECURITY.md](SECURITY.md), never a public issue.

```sh
cd typescript && npm install && npm test && npm run build
cd mcp && npm install && npm test   # after building typescript/
cd python && python -m pip install -e ".[langchain,llamaindex]" && python -m unittest discover -s tests
```

## En français

WYRLO vérifie chaque réponse de votre RAG face à ses sources et fait dire « je ne sais
pas » plutôt qu'une réponse fausse. Documentation détaillée en français :
[TypeScript](typescript/README.fr.md) · [Python](python/README.fr.md) ·
[MCP](mcp/README.fr.md) · [wyrlo.io/docs](https://www.wyrlo.io/docs).
