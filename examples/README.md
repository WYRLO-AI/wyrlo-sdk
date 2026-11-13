# Examples

Small, runnable files. Each one needs a WYRLO API key in `WYRLO_API_KEY`
([request access](https://www.wyrlo.io/fr/demander-un-acces)). The documents, questions
and answers are fictitious.

| File | What it shows |
| --- | --- |
| [`typescript/guard.ts`](typescript/guard.ts) | `guard` on a supported answer, then on an answer the passages don't support |
| [`python/guard.py`](python/guard.py) | The same, in Python |
| [`python/langchain_rag.py`](python/langchain_rag.py) | A LangChain RAG chain checked by WYRLO, in two lines |
| [`python/llamaindex_rag.py`](python/llamaindex_rag.py) | A LlamaIndex query engine checked by WYRLO |
| [`mcp/`](mcp/) | Plug the WYRLO MCP server into an agent |

The LangChain and LlamaIndex examples use the libraries' built-in fake models so they run
anywhere: replace them with your own retriever and LLM.

```bash
# TypeScript (Node 18+)
npm install @wyrlo/sdk tsx && npx tsx typescript/guard.ts

# Python (3.9+)
pip install wyrlo && python python/guard.py
pip install "wyrlo[langchain]" && python python/langchain_rag.py
pip install "wyrlo[llamaindex]" && python python/llamaindex_rag.py
```
