/**
 * Serveur MCP de WYRLO (Model Context Protocol, JSON-RPC 2.0).
 *
 * Outils exposés à l'agent :
 * - `wyrlo_prepare` : la question à chercher, enrichie du vocabulaire du projet ;
 * - `wyrlo_search` : les adresses des passages les plus proches dans l'index sans copie
 *   (mode B), sans texte : l'agent relit le texte avec ses propres outils ;
 * - `wyrlo_guard` : vérifie la réponse de l'agent avant qu'il ne la donne ;
 * - `wyrlo_feedback` : retour de l'utilisateur final sur une réponse donnée.
 *
 * Mode C (plateformes) : l'espace du client final est fixé par la configuration du serveur
 * (`ServerOptions.tenant`), jamais par l'agent : un agent ne peut pas chercher dans l'espace
 * d'un autre client.
 *
 * Aucune dépendance en plus du SDK. Aucun texte reçu n'est écrit dans un journal ; la
 * clé d'API ne sort jamais du processus (lue dans WYRLO_API_KEY).
 */

import { type GuardPassageInput, type Wyrlo, WyrloError } from "@wyrlo/sdk";

export const SERVER_NAME = "wyrlo";
export const SERVER_VERSION = "0.1.0";
/** Versions du protocole acceptées, de la plus récente à la plus ancienne. */
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

/** Méthodes du SDK utilisées : un vrai client `Wyrlo`, ou un double pour les tests. */
export type WyrloClient = Pick<Wyrlo, "guard" | "prepare" | "feedback" | "search">;

/** Réglages du serveur, fixés à son lancement (jamais par l'agent). */
export interface ServerOptions {
  /** Espace du client final dans l'index (mode C) ; absent : espace par défaut du projet. */
  tenant?: string;
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, Json>; required?: string[] };
  annotations?: Record<string, boolean>;
}

const PASSAGE_SCHEMA: Json = {
  type: "object",
  properties: {
    id: { type: "string", description: "Identifiant stable du passage (sinon sa position)." },
    text: { type: "string", description: "Texte du passage, tel que vous l'avez lu." },
    source: { type: "string", description: "Document d'origine, par exemple « CGV.pdf »." },
    address: {
      type: "object",
      description:
        "Adresse rendue par wyrlo_search, à recopier telle quelle : un passage modifié depuis son indexation est alors signalé « stale ».",
      properties: {
        document: { type: "string" },
        version: { type: "string" },
        start: { type: "integer" },
        length: { type: "integer" },
        fingerprint: { type: "string" },
      },
      required: ["document", "version", "start", "length", "fingerprint"],
    },
  },
  required: ["text"],
};

export const TOOLS: Tool[] = [
  {
    name: "wyrlo_prepare",
    title: "Préparer la recherche",
    description:
      "À appeler avant votre recherche : renvoie la question à chercher, enrichie du vocabulaire du projet. Passez ensuite le même request_id à wyrlo_guard.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string", description: "Question de l'utilisateur." } },
      required: ["question"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "wyrlo_search",
    title: "Chercher dans l'index sans copie",
    description:
      "Cherche les passages les plus proches de la question dans l'index sans copie du projet (mode B, ouvert sur demande). Rend des adresses (document, version, start, length, fingerprint), jamais de texte : relisez le texte avec vos propres outils, puis passez chaque passage à wyrlo_guard avec son adresse.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        k: { type: "integer", minimum: 1, maximum: 50, description: "Nombre de résultats (8)." },
        labels_any: {
          type: "array",
          items: { type: "string" },
          description: "Documents portant au moins une de ces étiquettes.",
        },
      },
      required: ["question"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "wyrlo_guard",
    title: "Vérifier une réponse",
    description:
      "Vérifie votre réponse contre les passages qui l'appuient, avant de la donner. decision « abstain » : dites que vous ne savez pas. Signale aussi les phrases non appuyées, les injections dans les passages et les passages périmés (stale). Une panne de WYRLO ne bloque jamais : la réponse revient « unverified » et degraded.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        answer: { type: "string", description: "La réponse que vous comptez donner." },
        passages: { type: "array", items: PASSAGE_SCHEMA, minItems: 1 },
        language: { type: "string", description: "« fr », « en »… (devinée sinon)." },
        request_id: { type: "string", description: "Celui de wyrlo_prepare, s'il y en a un." },
      },
      required: ["question", "answer", "passages"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "wyrlo_feedback",
    title: "Retour de l'utilisateur",
    description:
      "Retour de l'utilisateur final sur une réponse donnée (helpful: true pour un pouce en haut), avec le trace_id rendu par wyrlo_guard. Aucun texte n'est envoyé.",
    inputSchema: {
      type: "object",
      properties: { trace_id: { type: "string" }, helpful: { type: "boolean" } },
      required: ["trace_id", "helpful"],
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
];

const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** Erreur d'arguments : rendue à l'agent comme résultat d'outil en erreur. */
class ArgumentError extends Error {}

function needString(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (!str(v)) throw new ArgumentError(`« ${name} » : texte non vide attendu.`);
  return v;
}

function optStringArray(args: Record<string, unknown>, name: string): string[] | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new ArgumentError(`« ${name} » : liste de textes attendue.`);
  }
  return v as string[];
}

function passagesArg(args: Record<string, unknown>): GuardPassageInput[] {
  const v = args.passages;
  if (!Array.isArray(v) || v.length === 0) {
    throw new ArgumentError("« passages » : liste non vide attendue.");
  }
  return v.map((raw, i) => {
    if (typeof raw !== "object" || raw === null || !str((raw as { text?: unknown }).text)) {
      throw new ArgumentError(`« passages[${i}].text » : texte non vide attendu.`);
    }
    const p = raw as Record<string, unknown>;
    const out: GuardPassageInput = { text: p.text as string };
    if (str(p.id)) out.id = p.id;
    if (str(p.source)) out.source = p.source;
    if (typeof p.address === "object" && p.address !== null) {
      out.address = p.address as GuardPassageInput["address"];
    }
    return out;
  });
}

const textResult = (value: unknown, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
  ...(isError ? { isError: true } : {}),
});

async function callTool(
  client: WyrloClient,
  name: string,
  args: Record<string, unknown>,
  options: ServerOptions,
) {
  switch (name) {
    case "wyrlo_prepare": {
      const out = await client.prepare({ question: needString(args, "question") });
      return textResult(out);
    }
    case "wyrlo_search": {
      const k = args.k;
      if (k !== undefined && (typeof k !== "number" || !Number.isInteger(k))) {
        throw new ArgumentError("« k » : entier attendu.");
      }
      const labelsAny = optStringArray(args, "labels_any");
      const out = await client.search({
        question: needString(args, "question"),
        ...(typeof k === "number" ? { k } : {}),
        ...(labelsAny ? { labelsAny } : {}),
        ...(options.tenant ? { tenant: options.tenant } : {}),
      });
      return textResult(out);
    }
    case "wyrlo_guard": {
      const language = args.language;
      const requestId = args.request_id;
      const out = await client.guard({
        question: needString(args, "question"),
        answer: needString(args, "answer"),
        passages: passagesArg(args),
        ...(str(language) ? { language } : {}),
        ...(str(requestId) ? { requestId } : {}),
      });
      return textResult(out);
    }
    case "wyrlo_feedback": {
      if (typeof args.helpful !== "boolean") {
        throw new ArgumentError("« helpful » : vrai ou faux attendu.");
      }
      const out = await client.feedback({
        traceId: needString(args, "trace_id"),
        helpful: args.helpful,
      });
      return textResult(out);
    }
    default:
      return null;
  }
}

/**
 * Traite un message JSON-RPC. Rend la réponse, ou null pour une notification (aucune
 * réponse attendue).
 */
export async function handleMessage(
  client: WyrloClient,
  message: unknown,
  options: ServerOptions = {},
): Promise<JsonRpcResponse | null> {
  if (
    typeof message !== "object" ||
    message === null ||
    (message as { jsonrpc?: unknown }).jsonrpc !== "2.0" ||
    typeof (message as { method?: unknown }).method !== "string"
  ) {
    const id = (message as { id?: unknown } | null)?.id;
    return {
      jsonrpc: "2.0",
      id: typeof id === "string" || typeof id === "number" ? id : null,
      error: { code: -32600, message: "Requête JSON-RPC invalide." },
    };
  }
  const request = message as JsonRpcRequest;
  const isNotification = request.id === undefined;
  const id = request.id ?? null;
  const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, text: string): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id,
    error: { code, message: text },
  });
  const params = request.params ?? {};

  if (isNotification) return null;

  switch (request.method) {
    case "initialize": {
      const asked = params.protocolVersion;
      const version =
        typeof asked === "string" && (PROTOCOL_VERSIONS as readonly string[]).includes(asked)
          ? asked
          : PROTOCOL_VERSIONS[0];
      return ok({
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, title: "WYRLO", version: SERVER_VERSION },
        instructions:
          "Avant de répondre à partir de documents, faites vérifier votre réponse par wyrlo_guard. Si decision vaut « abstain », dites que vous ne savez pas. Avec l'index sans copie, cherchez par wyrlo_search, relisez le texte avec vos outils, et recopiez l'adresse de chaque passage.",
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const name = params.name;
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (typeof name !== "string" || typeof args !== "object" || args === null) {
        return fail(-32602, "Paramètres invalides : name et arguments attendus.");
      }
      try {
        const result = await callTool(client, name, args, options);
        if (result === null) return fail(-32602, `Outil inconnu : ${name}.`);
        return ok(result);
      } catch (error) {
        if (error instanceof ArgumentError) {
          return ok(
            textResult({ error: { code: "invalid_arguments", message: error.message } }, true),
          );
        }
        if (error instanceof WyrloError) {
          return ok(
            textResult(
              { error: { status: error.status, code: error.code, message: error.message } },
              true,
            ),
          );
        }
        return ok(
          textResult({ error: { code: "internal_error", message: "Erreur inattendue." } }, true),
        );
      }
    }
    default:
      return fail(-32601, `Méthode inconnue : ${request.method}.`);
  }
}
