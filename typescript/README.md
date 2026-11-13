# @wyrlo/sdk

TypeScript SDK for [WYRLO](https://www.wyrlo.io): your RAG says "I don't know" instead of
a wrong answer. WYRLO checks each LLM answer against the passages it was given, returns a
decision and a confidence level, and tells you which passages to cite.

[Version française](https://github.com/WYRLO-AI/wyrlo-sdk/blob/main/typescript/README.fr.md)

```bash
npm install @wyrlo/sdk
```

Documentation: https://www.wyrlo.io/docs. API access is currently on request:
https://www.wyrlo.io/fr/demander-un-acces.

Node 18+, Deno, Bun. **Server-side only**: the key must never reach a browser.

## Usage

```ts
import { Wyrlo } from "@wyrlo/sdk";

const wyrlo = new Wyrlo(); // reads WYRLO_API_KEY

const res = await wyrlo.guard({
  question,
  passages: docs.map((d) => ({ id: d.id, text: d.text, source: d.file })),
  answer, // the answer produced by your LLM
});

if (res.decision === "abstain") {
  return "I don't know. " + res.reason;
}
return res.answer; // cite res.passages.filter((p) => p.kept)
```

Recommended: prepare the search with your settings' vocabulary, and pass the same
`requestId` to `guard`:

```ts
const prepared = await wyrlo.prepare({ question });
const docs = await search(prepared.query); // your search
const res = await wyrlo.guard({ question, passages, answer, requestId: prepared.request_id });
```

`prepare` does not throw on outages: it returns the original question
(`degraded: true`).

If your interface offers a thumbs up / down, send it with the answer's `trace_id`. No text
is sent; WYRLO uses it to judge its corrections without a paid call:

```ts
await wyrlo.feedback({ traceId: res.trace_id, helpful: true });
```

Or let the SDK call your LLM:

```ts
const res = await wyrlo.guard({
  question,
  passages,
  generate: (passages) => llm.answer(question, passages),
});
```

## What `guard` returns

| Field                   | Meaning                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `decision`              | `answer` or `abstain` ("I don't know")                                                                                     |
| `confidence`            | `certain`, `probable`, `uncertain`, `unverified` (answer passed through without any check)                                 |
| `confidence_score`      | Consistency score of the answer (English), or score of the signals (other languages); null if nothing could be verified    |
| `reason`                | Short explanation (currently in French)                                                                                    |
| `passages[].kept`       | Passages to cite; `injection: true` = set aside                                                                            |
| `unsupported_sentences` | Sentences of the answer that no passage supports                                                                           |
| `skipped_steps`         | Processing steps skipped on the WYRLO side (slow or unavailable server)                                                    |
| `language`              | Language used (given or detected), null if unknown                                                                         |
| `rerank_method`         | `similarity` (passages reordered by similarity), `none` (your search order); similarity remains a signal                   |
| `verification_method`   | `answer` (English); `sentences`; `signals` (other languages); `model` (French, language model); `none`                     |
| `degraded`              | Degraded mode: step skipped, WYRLO unreachable or cap reached; always true if `unverified`                                 |
| `quota_exceeded`        | True if the monthly cap of the free tier is reached (2,000 analysed questions)                                             |
| `settings_variant`      | During a partial test of the settings: `control` or `candidate`; null otherwise                                            |
| `trace_id`              | Identifier of the trace in your WYRLO space (null if the question was not analysed)                                        |

## Outages: never blocking

Network failure, timeout (3 s in total by default, retry included) or 5xx error: the SDK
retries once with the same `request_id` (the question is counted only once), then returns
a **degraded** result: `decision: "answer"`, `confidence: "unverified"`, `degraded: true`.
Your user always gets an answer.

Monthly cap of the free tier reached (2,000 analysed questions per month): same degraded
result, with `quota_exceeded: true`, until the next month.

An error in your integration (missing or revoked key, invalid request) throws a
`WyrloError` (`status`, `code`, `details`), so you see it during development.

## Options

```ts
new Wyrlo({
  apiKey: "wyr_live_…", // default: WYRLO_API_KEY
  baseUrl: "…", // default: WYRLO_BASE_URL, otherwise DEFAULT_BASE_URL
  region: "eu-west-3", // default: WYRLO_REGION, otherwise eu-west-3 (Paris)
  timeoutMs: 3000, // in total, retry included
  maxRetries: 1,
  mask: false, // true: masking on your server before sending (see below)
});
```

## Client-side masking

WYRLO masks recognisable personal data before any processing. With `mask: true`, this
masking happens **on your server, before sending**: the values never leave your machine,
WYRLO only receives markers (`[EMAIL_1]`, `[TELEPHONE_1]`…).

```ts
const wyrlo = new Wyrlo({ mask: true });
const res = await wyrlo.guard({ question, passages, answer });
// res.answer, res.reason and res.unsupported_sentences contain the real values.
// res.local_masking: { method: "rules", counts: { EMAIL: 2, TELEPHONE: 1 } }
```

Masked (rules with validity checks, the same as WYRLO's): e-mails, phone numbers (France
and international), IBANs (checksum verified), bank cards (Luhn check), French social
security numbers (checksum verified or nearby keyword), IP addresses, passport and identity
card numbers (with a keyword), postal addresses (number and street type), recognisable API
keys and tokens. The same value gets the same marker in the question, the answer and the
passages: verification stays exact.

**Not masked**: names of people and companies, addresses without a number or street type,
and any identifier without a recognisable shape (internal customer number…). Dates,
amounts and order numbers stay too: verification must be able to compare them. To go
further, pass your own function, for example a name-detection model running on your side:

```ts
const wyrlo = new Wyrlo({
  // Receives all the texts of a call, returns as many masked texts.
  mask: async (texts) => texts.map((t) => myMasking(t)),
});
```

If masking fails (exception, different number of texts), **nothing is sent**: the answer
passes without verification (`degraded: true`, step `anonymize` in `skipped_steps`). The
`maskTexts` and `unmaskText` functions are also exported.

## No-copy index (mode B)

Open on request, project by project. WYRLO splits your documents, masks personal data,
computes the vectors (Mistral AI, European endpoint), then forgets the text: only the
address, fingerprint and vector of each passage are kept.

```ts
await wyrlo.index("docs/terms.md", {
  version: "2026-11-07",
  title: "Terms of sale", // recommended: better search, never stored
  text: content,
  labels: ["terms"],
});
// Many documents: 100 per call, one result per document.
const batch = await wyrlo.indexMany(
  files.map((f) => ({ id: f.path, version: f.version, title: f.title, text: f.text })),
);

// 8 passages (about 600 characters each): enough context for the answer.
const { results, degraded } = await wyrlo.search({ question, k: 8 });
// Read the text on your side, then verify the answer with each passage's address:
const passages = results.map(({ document, version, start, length, fingerprint }) => ({
  id: `${document}#${start}`,
  text: readOnYourSide(document).slice(start, start + length),
  address: { document, version, start, length, fingerprint },
}));
const res = await wyrlo.guard({ question, passages, generate });
// A passage modified since it was indexed comes back with `stale: true`: it is a signal,
// it does not change the decision. Read the updated document and index it again.

await wyrlo.remove("docs/terms.md"); // always possible, even with mode B turned off
await wyrlo.indexStats(); // figures only, no identifier
```

- `search` never throws on an outage: empty list, `degraded: true`, to be completed by
  your own search. `keywordHits` merges your keyword results.
- `index`, `remove` and `indexStats` throw a `WyrloError` for any error, outages included
  (`unavailable`): retrying is safe (same `version`: "unchanged").
- Mode B turned off: `WyrloError` 403 `index_disabled`.
- With the `mask` option, `index` refuses to send the text (`mask_unsupported`), because
  positions and fingerprints must refer to your original text; pass
  `allowUnmasked: true` to send it anyway. In `guard`, a passage whose text is changed by
  masking is sent without its address (it would never be recognised).
- `indexMany`: up to 100 documents in one call (body of 512 KiB at most), in the same
  space, with one result per document (`indexed`, `unchanged` or `failed`). A rejected
  document does not block the others; with the code `overloaded`, send it again later.
- `title` (optional, 300 characters at most): title of the document, put at the head of
  each passage to compute the vectors, never stored. Send it when the document has one:
  measured on 283 unseen questions, the right passage is in the top 5 for 85.2% of
  questions with the title, against 79.9% without. Change the `version` if the title
  changes.
- Limits: 5,000 documents and 100,000 passages per project; 2,000 passages and 400,000
  characters per document.

### One space per end customer (mode C, platforms)

If you offer an assistant to your own customers, store each customer's documents in their
own space, with an opaque identifier of your choice (never a name or an e-mail address;
letters, digits, ". _ : -", 100 characters at most). Each search only sees one space,
filtered by WYRLO's database:

```ts
await wyrlo.index("terms.md", { version: "v3", text: content, tenant: "client-42" });
await wyrlo.search({ question, tenant: "client-42" }); // never another customer's documents
await wyrlo.remove("terms.md", { tenant: "client-42" });
await wyrlo.indexStats({ tenant: "client-42" });
await wyrlo.removeTenant("client-42"); // the whole space, right away (end of contract)
```

Without `tenant`, everything happens in the project's default space. The limits remain
those of the project.

## API address

By default, the SDK calls `DEFAULT_BASE_URL` (exported by the package):
`https://api.wyrlo.io/functions/v1` (endpoint `/guard`). To change it: the `baseUrl`
option, otherwise the `WYRLO_BASE_URL` environment variable; an empty value falls back to
the default address and trailing slashes are removed. Calls go directly from your server
to the API, without a relay.

## Processing region

Each call sends the `x-region: eu-west-3` header. Without it, Supabase would run the
function in the region closest to your server (for example `us-east-1`), while the
question, passages and answer arrive there in clear, before masking. With it, processing
stays in Paris; the `x-sb-edge-region` response header confirms it. An empty value for
`region` or `WYRLO_REGION` falls back to `eu-west-3`.

API reference: https://www.wyrlo.io/docs.
