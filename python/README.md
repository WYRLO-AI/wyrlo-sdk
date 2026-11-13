# wyrlo

Python SDK for [WYRLO](https://www.wyrlo.io): your RAG says "I don't know" instead of a
wrong answer. Python 3.9+, no dependencies. **Server-side only.**

[Version française](https://github.com/WYRLO-AI/wyrlo-sdk/blob/main/python/README.fr.md)

```bash
pip install wyrlo                      # SDK only
pip install "wyrlo[langchain]"         # with LangChain
pip install "wyrlo[llamaindex]"        # with LlamaIndex
```

Documentation: https://www.wyrlo.io/docs. API access is currently on request:
https://www.wyrlo.io/fr/demander-un-acces.

## Usage

```python
from wyrlo import Wyrlo

wyrlo = Wyrlo()  # reads WYRLO_API_KEY

res = wyrlo.guard(
    question=question,
    passages=[{"id": d.id, "text": d.text, "source": d.file} for d in docs],
    answer=answer,  # the answer produced by your LLM
)

if not res.should_answer:
    return "I don't know. " + res.reason
return res.answer  # cite res.kept_passages
```

`res.reason` is a short explanation, in English (`locale="fr"` for French).

Recommended: prepare the search with your settings' vocabulary, and pass the same request
identifier to `guard`:

```python
prepared = wyrlo.prepare(question)
docs = search(prepared.query)  # your search
res = wyrlo.guard(question=question, passages=..., answer=answer,
                  request_id=prepared.request_id)
```

`prepare` does not raise on outages: it returns the original question
(`degraded=True`). During a partial test of the settings, `res.settings_variant` is
`"control"` or `"candidate"`.

If your interface offers a thumbs up / down, send it with the answer's `trace_id` (no text
sent): `wyrlo.feedback(res.trace_id, helpful=True)`.

Or let the SDK call your LLM: `generate=lambda passages: llm(question, passages)`.
Passages can also be plain strings.

## LangChain and LlamaIndex

Two small integrations, tested with the real libraries (versions in
`requirements-integrations.txt`). They call your retriever and your LLM, then `guard`; the
result is the same `GuardResult`, and a WYRLO outage never raises.

```bash
pip install "wyrlo[langchain]"     # adds langchain-core
pip install "wyrlo[llamaindex]"    # adds llama-index-core
```

```python
from wyrlo.langchain import guarded_chain

rag = guarded_chain(retriever, prompt | llm)   # prompt: {question} and {context}
res = rag.invoke("What is the withdrawal period?")
```

```python
from wyrlo.llamaindex import GuardedQueryEngine

engine = GuardedQueryEngine(index.as_retriever(similarity_top_k=5), llm)
res = engine.query("What is the withdrawal period?")
```

Passages sent: identifier (`Document.id` or `node_id`), text, source
(`metadata["source"]`, or `file_name` for LlamaIndex) and score if any.

## Outages: never blocking

Network failure, timeout (3 s in total by default, retry included) or 5xx error: one retry
with the same `request_id` (the question is counted only once), then a **degraded**
result: `decision="answer"`, `confidence="unverified"`, `degraded=True`.

Monthly cap of the free tier reached (1,000 analysed questions per month): same degraded
result, with `quota_exceeded=True`, until the next month.

A missing or refused key, or an invalid request, raises `WyrloError`
(`status`, `code`, `details`).

## Options

```python
Wyrlo(api_key="wyr_live_…", base_url=None, timeout=3.0, max_retries=1, region=None,
      mask=None, locale=None)
```

`base_url`: default `WYRLO_BASE_URL`, otherwise `DEFAULT_BASE_URL` (exported by the
package): `https://api.wyrlo.io/functions/v1` (endpoint `/guard`). An empty value falls
back to the default address; trailing slashes are removed.

`region`: default `WYRLO_REGION`, otherwise `eu-west-3` (Paris; an empty value also falls
back to Paris). Each call sends the `X-Region` header: without it, Supabase would run the
function in the region closest to your server (for example `us-east-1`), while the
question, passages and answer arrive there in clear, before masking. The
`x-sb-edge-region` response header confirms the processing region.

`locale`: language of `reason` and of the API error messages. English by default; `"fr"`
for French (sent as the `Accept-Language` header).

## Client-side masking

WYRLO masks recognisable personal data before any processing. With `mask=True`, this
masking happens **on your server, before sending**: the values never leave your machine,
WYRLO only receives markers (`[EMAIL_1]`, `[TELEPHONE_1]`…).

```python
wyrlo = Wyrlo(mask=True)
res = wyrlo.guard(question=question, passages=passages, answer=answer)
# res.answer, res.reason and res.unsupported_sentences contain the real values.
# res.local_masking: LocalMasking(method="rules", counts={"EMAIL": 2, "TELEPHONE": 1})
```

Masked (rules with validity checks, the same as WYRLO's, standard library only):
e-mails, phone numbers (France and international), IBANs (checksum verified), bank cards
(Luhn check), French social security numbers (checksum verified or nearby keyword), IP
addresses, passport and identity card numbers (with a keyword), postal addresses (number
and street type), recognisable API keys and tokens. The same value gets the same marker in
the question, the answer and the passages.

**Not masked**: names of people and companies, addresses without a number or street type,
and any identifier without a recognisable shape. Dates, amounts and order numbers stay
too: verification must be able to compare them. For names, pass your own function, for
example Presidio installed on your machine (nothing leaves it):

```python
from presidio_analyzer import AnalyzerEngine
from presidio_anonymizer import AnonymizerEngine

analyzer, anonymizer = AnalyzerEngine(), AnonymizerEngine()

def mask(texts):
    # Receives all the texts of a call, returns as many masked texts.
    return [
        anonymizer.anonymize(text=t, analyzer_results=analyzer.analyze(text=t, language="en")).text
        for t in texts
    ]

wyrlo = Wyrlo(mask=mask)
```

If masking fails (exception, different number of texts), **nothing is sent**: the answer
passes without verification (`degraded=True`, step `anonymize` in `skipped_steps`). The
`mask_texts` and `unmask_text` functions are also exported.

## No-copy index (mode B)

Open on request, project by project. WYRLO splits your documents, masks personal data,
computes the vectors (Mistral AI, European endpoint), then forgets the text: only the
address, fingerprint and vector of each passage are kept.

```python
wyrlo.index(
    "docs/terms.md",
    "2026-11-07",
    title="Terms of sale",  # recommended: better search, never stored
    text=content,
    labels=["terms"],
)
# Many documents: 100 per call, one result per document.
batch = wyrlo.index_many(
    [{"id": f.path, "version": f.version, "title": f.title, "text": f.text} for f in files]
)

# 8 passages (about 600 characters each): enough context for the answer.
res = wyrlo.search(question, k=8)
passages = [
    {
        "id": f"{r['document']}#{r['start']}",
        "text": read_on_your_side(r["document"])[r["start"] : r["start"] + r["length"]],
        "address": {k: r[k] for k in ("document", "version", "start", "length", "fingerprint")},
    }
    for r in res.results
]
out = wyrlo.guard(question=question, passages=passages, generate=generate)
# A passage modified since it was indexed comes back with stale=True: it is a signal,
# it does not change the decision. Read the updated document and index it again.

wyrlo.remove("docs/terms.md")  # always possible, even with mode B turned off
wyrlo.index_stats()  # figures only, no identifier
```

- `search` never raises on an outage: empty list, `degraded=True`, to be completed by your
  own search. `keyword_hits` merges your keyword results.
- `index`, `remove` and `index_stats` raise `WyrloError` for any error, outages included
  (`unavailable`): retrying is safe (same `version`: "unchanged").
- Mode B turned off: `WyrloError` 403 `index_disabled`.
- With the `mask` option, `index` refuses to send the text (`mask_unsupported`), because
  positions and fingerprints must refer to your original text; pass
  `allow_unmasked=True` to send it anyway. In `guard`, a passage whose text is changed by
  masking is sent without its address (it would never be recognised).
- `index_many`: up to 100 documents in one call (body of 512 KiB at most), in the same
  space, with one result per document (`indexed`, `unchanged` or `failed`). A rejected
  document does not block the others; with the code `overloaded`, send it again later.
- `title` (optional, 300 characters at most): title of the document, put at the head of
  each passage to compute the vectors, never stored. Send it when the document has one:
  measured on 283 unseen questions, the right passage is in the top 5 for 85.2% of
  questions with the title, against 79.9% without. Change the `version` if the title
  changes.
- Limits: 5,000 documents (500 on the Free plan) and 100,000 passages per project; 2,000 passages and 400,000
  characters per document.

### One space per end customer (mode C, platforms)

If you offer an assistant to your own customers, store each customer's documents in their
own space, with an opaque identifier of your choice (never a name or an e-mail address;
letters, digits, ". _ : -", 100 characters at most). Each search only sees one space,
filtered by WYRLO's database:

```python
wyrlo.index("terms.md", "v3", text=content, tenant="client-42")
wyrlo.search(question, tenant="client-42")  # never another customer's documents
wyrlo.remove("terms.md", tenant="client-42")
wyrlo.index_stats(tenant="client-42")
wyrlo.remove_tenant("client-42")  # the whole space, right away (end of contract)
```

Without `tenant`, everything happens in the project's default space. The limits remain
those of the project. Developer and Production plans (on the Free plan, a call with
`tenant` is refused: 422 `invalid_request` on the `tenant` field). The LangChain and LlamaIndex retrievers take the same parameter:
`WyrloRetriever(client=wyrlo, read=read, tenant="client-42")`.

`passages_from_search(res.results, read)` runs the loop above for you: `read` receives
`(document, version, start, length)` and returns the text, or `None` if the document no
longer exists (the result is then dropped). For LangChain and LlamaIndex, a retriever does
the same and keeps the address until `guard`:

```python
from wyrlo.langchain import WyrloRetriever, guarded_chain

rag = guarded_chain(WyrloRetriever(client=wyrlo, read=read, k=8), prompt | llm)

from wyrlo.llamaindex import GuardedQueryEngine, WyrloRetriever

engine = GuardedQueryEngine(WyrloRetriever(wyrlo, read, k=8), llm)
```

## Tests

```bash
python3 -m unittest discover -s tests
```

The integration tests are skipped if the libraries are missing.
