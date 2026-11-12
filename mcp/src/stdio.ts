/**
 * Transport stdio du protocole MCP : un message JSON-RPC par ligne sur l'entrée standard,
 * une réponse par ligne sur la sortie standard. Rien d'autre n'est écrit sur la sortie
 * (elle appartient au protocole) ; aucun contenu n'est écrit sur la sortie d'erreur.
 */

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  handleMessage,
  type JsonRpcResponse,
  type ServerOptions,
  type WyrloClient,
} from "./server.ts";

export async function serveStdio(
  client: WyrloClient,
  input: Readable,
  output: Writable,
  options: ServerOptions = {},
): Promise<void> {
  const send = (response: JsonRpcResponse | JsonRpcResponse[]) =>
    output.write(`${JSON.stringify(response)}\n`);
  const pending: Promise<unknown>[] = [];
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON illisible." } });
      continue;
    }
    // Les appels d'outils peuvent se chevaucher : chacun répond dès qu'il est prêt.
    const task = Array.isArray(message)
      ? Promise.all(message.map((m) => handleMessage(client, m, options))).then((all) => {
          const responses = all.filter((r): r is JsonRpcResponse => r !== null);
          if (responses.length) send(responses);
        })
      : handleMessage(client, message, options).then((r) => {
          if (r) send(r);
        });
    pending.push(task);
  }
  await Promise.all(pending);
}
