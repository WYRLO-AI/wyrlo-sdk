// Nœud n8n de WYRLO (préversion), en style déclaratif : chaque opération décrit la requête
// envoyée à l'API (routes de docs/api/openapi.json). Trois opérations :
// - Verify Answer : POST /guard        (vérifier la réponse de votre RAG)
// - Answer        : POST /guard/answer (réponse citée et vérifiée, préversion)
// - Search        : POST /guard/search (adresses des meilleurs passages de l'index sans copie)
// Les passages sont un tableau JSON : [{ "id": "…", "text": "…", "source": "…" }].

const passagesField = (operations) => ({
  displayName: "Passages (JSON)",
  name: "passages",
  type: "json",
  default: "[]",
  required: true,
  displayOptions: { show: { operation: operations } },
  description:
    'Retrieved passages, as a JSON array: [{ "id": "doc#1", "text": "…", "source": "file.md" }]',
  routing: {
    send: {
      type: "body",
      property: "passages",
      value: "={{ typeof $value === 'string' ? JSON.parse($value) : $value }}",
    },
  },
});

const questionField = {
  displayName: "Question",
  name: "question",
  type: "string",
  default: "",
  required: true,
  description: "The end user's question",
  routing: { send: { type: "body", property: "question" } },
};

class Wyrlo {
  description = {
    displayName: "WYRLO",
    name: "wyrlo",
    icon: "file:wyrlo.svg",
    group: ["transform"],
    version: 1,
    subtitle: '={{$parameter["operation"]}}',
    description:
      "Verify a RAG answer against its sources, or get a cited and verified answer (preview)",
    defaults: { name: "WYRLO" },
    inputs: ["main"],
    outputs: ["main"],
    credentials: [{ name: "wyrloApi", required: true }],
    requestDefaults: {
      baseURL: "={{$credentials.baseUrl}}",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
    },
    properties: [
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        default: "verify",
        options: [
          {
            name: "Verify Answer",
            value: "verify",
            action: "Verify an answer against its passages",
            description: "Check the answer your LLM wrote; decision is answer or abstain",
            routing: { request: { method: "POST", url: "/guard" } },
          },
          {
            name: "Answer",
            value: "answer",
            action: "Get a cited and verified answer",
            description:
              "WYRLO has a model write the answer from the passages, then verifies it (preview)",
            routing: { request: { method: "POST", url: "/guard/answer", timeout: 60000 } },
          },
          {
            name: "Search",
            value: "search",
            action: "Search the no-copy index",
            description: "Addresses of the best passages for a question (never the text)",
            routing: { request: { method: "POST", url: "/guard/search" } },
          },
        ],
      },
      questionField,
      {
        displayName: "Answer",
        name: "answer",
        type: "string",
        typeOptions: { rows: 4 },
        default: "",
        required: true,
        displayOptions: { show: { operation: ["verify"] } },
        description: "The answer written by your LLM",
        routing: { send: { type: "body", property: "answer" } },
      },
      passagesField(["verify", "answer"]),
      {
        displayName: "Results",
        name: "k",
        type: "number",
        typeOptions: { minValue: 1, maxValue: 50 },
        default: 8,
        displayOptions: { show: { operation: ["search"] } },
        description: "Number of passages to return",
        routing: { send: { type: "body", property: "k" } },
      },
      {
        displayName: "Additional Fields",
        name: "additionalFields",
        type: "collection",
        placeholder: "Add Field",
        default: {},
        options: [
          {
            displayName: "End Customer (Tenant)",
            name: "tenant",
            type: "string",
            default: "",
            description: "End customer the question is asked for (platforms, Partner plan)",
            routing: { send: { type: "body", property: "tenant" } },
          },
          {
            displayName: "Language",
            name: "language",
            type: "string",
            default: "",
            placeholder: "fr",
            description: "Language of the question (guessed when empty)",
            displayOptions: { show: { "/operation": ["verify", "answer"] } },
            routing: { send: { type: "body", property: "language" } },
          },
        ],
      },
    ],
  };
}

module.exports = { Wyrlo };
