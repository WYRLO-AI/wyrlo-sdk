import { PassThrough } from "node:stream";
import { Wyrlo, WyrloError } from "@wyrlo/sdk";
import { describe, expect, it, vi } from "vitest";
import type { TOOLS } from "../src/server.ts";
import { handleMessage, PROTOCOL_VERSIONS, type WyrloClient } from "../src/server.ts";
import { serveStdio } from "../src/stdio.ts";

// Données fictives uniquement.
const KEY = `wyr_test_${"ab".repeat(24)}`;
const FP = "a".repeat(64);
const ADDRESS = { document: "cgv", version: "v1", start: 0, length: 41, fingerprint: FP };

function fakeClient(overrides: Partial<WyrloClient> = {}): WyrloClient {
  return {
    guard: vi.fn(async (input) => ({ decision: "answer", answer: input.answer }) as never),
    prepare: vi.fn(async (input) => ({ query: input.question, degraded: false }) as never),
    feedback: vi.fn(async () => ({ recorded: true })),
    search: vi.fn(async () => ({ results: [], request_id: "r", degraded: false })),
    ...overrides,
  };
}

const call = (client: WyrloClient, name: string, args: Record<string, unknown>) =>
  handleMessage(client, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name, arguments: args },
  });

describe("serveur MCP", () => {
  it("textes montrés aux agents en anglais : consignes, outils, paramètres, erreurs", async () => {
    const client = fakeClient();
    const init = await handleMessage(client, { jsonrpc: "2.0", id: 1, method: "initialize" });
    const list = await handleMessage(client, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const bad = await call(client, "wyrlo_guard", { question: "", answer: "a", passages: [] });
    const unknown = await call(client, "inconnu", {});
    const shown = JSON.stringify([init, list, bad, unknown]);
    expect(shown).toContain("wyrlo_guard");
    // Aucune lettre accentuée ni guillemet français : les agents lisent ces textes en anglais.
    expect(shown).not.toMatch(/[àâçéèêëîïôûùüÿœæ«»]/i);
  });

  it("initialize : version du client si connue, sinon la plus récente ; outils annoncés", async () => {
    const client = fakeClient();
    const known = await handleMessage(client, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    expect(known?.result).toMatchObject({
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "wyrlo" },
    });
    const unknown = await handleMessage(client, {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect((unknown?.result as { protocolVersion: string }).protocolVersion).toBe(
      PROTOCOL_VERSIONS[0],
    );
  });

  it("notification : aucune réponse ; méthode inconnue : -32601 ; message invalide : -32600", async () => {
    const client = fakeClient();
    expect(
      await handleMessage(client, { jsonrpc: "2.0", method: "notifications/initialized" }),
    ).toBeNull();
    expect((await handleMessage(client, { jsonrpc: "2.0", id: 3, method: "x" }))?.error?.code).toBe(
      -32601,
    );
    expect((await handleMessage(client, { id: 4 }))?.error).toMatchObject({ code: -32600 });
  });

  it("tools/list : les quatre outils, chacun avec un schéma d'entrée", async () => {
    const res = await handleMessage(fakeClient(), { jsonrpc: "2.0", id: 5, method: "tools/list" });
    const tools = (res?.result as { tools: typeof TOOLS }).tools;
    expect(tools.map((t) => t.name)).toEqual([
      "wyrlo_prepare",
      "wyrlo_search",
      "wyrlo_guard",
      "wyrlo_feedback",
    ]);
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
  });

  it("wyrlo_guard : passages et adresse transmis au SDK, résultat en texte et structuré", async () => {
    const client = fakeClient();
    const res = await call(client, "wyrlo_guard", {
      question: "Délai ?",
      answer: "14 jours.",
      passages: [{ id: "p1", text: "Le délai est de 14 jours.", source: "CGV", address: ADDRESS }],
      language: "fr",
      request_id: "req-1",
    });
    expect(client.guard).toHaveBeenCalledWith({
      question: "Délai ?",
      answer: "14 jours.",
      passages: [{ id: "p1", text: "Le délai est de 14 jours.", source: "CGV", address: ADDRESS }],
      language: "fr",
      requestId: "req-1",
    });
    const result = res?.result as { content: { text: string }[]; structuredContent: unknown };
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(result.structuredContent);
    expect(result.structuredContent).toMatchObject({ decision: "answer" });
  });

  it("wyrlo_search, wyrlo_prepare, wyrlo_feedback : arguments traduits pour le SDK", async () => {
    const client = fakeClient();
    await call(client, "wyrlo_search", { question: "Q ?", k: 3, labels_any: ["cgv"] });
    expect(client.search).toHaveBeenCalledWith({ question: "Q ?", k: 3, labelsAny: ["cgv"] });
    await call(client, "wyrlo_prepare", { question: "Q ?" });
    expect(client.prepare).toHaveBeenCalledWith({ question: "Q ?" });
    await call(client, "wyrlo_feedback", { trace_id: "t", helpful: false });
    expect(client.feedback).toHaveBeenCalledWith({ traceId: "t", helpful: false });
  });

  it("mode C : l'espace vient du serveur, jamais de l'agent", async () => {
    const client = fakeClient();
    await handleMessage(
      client,
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "wyrlo_search", arguments: { question: "Q ?", tenant: "autre-client" } },
      },
      { tenant: "client-1" },
    );
    expect(client.search).toHaveBeenCalledWith({ question: "Q ?", tenant: "client-1" });
    await call(client, "wyrlo_search", { question: "Q ?", tenant: "autre-client" });
    expect(client.search).toHaveBeenLastCalledWith({ question: "Q ?" });
  });

  it("arguments invalides : résultat d'outil en erreur, sans appel à WYRLO", async () => {
    const client = fakeClient();
    const res = await call(client, "wyrlo_guard", { question: "Q ?", answer: "R", passages: [] });
    expect(res?.result).toMatchObject({ isError: true });
    expect(client.guard).not.toHaveBeenCalled();
    const bad = await call(client, "wyrlo_feedback", { trace_id: "t", helpful: "oui" });
    expect(bad?.result).toMatchObject({ isError: true });
  });

  it("WyrloError (mode B coupé) : rendue à l'agent avec son code ; outil inconnu : -32602", async () => {
    const client = fakeClient({
      search: vi.fn(async () => {
        throw new WyrloError(403, "index_disabled", "Mode B coupé.");
      }),
    });
    const res = await call(client, "wyrlo_search", { question: "Q ?" });
    expect(res?.result).toMatchObject({
      isError: true,
      structuredContent: { error: { status: 403, code: "index_disabled" } },
    });
    expect((await call(client, "inconnu", {}))?.error?.code).toBe(-32602);
  });

  it("avec le vrai SDK : une panne de WYRLO ne bloque pas wyrlo_guard (réponse « degraded »)", async () => {
    const wyrlo = new Wyrlo({
      apiKey: KEY,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    const res = await call(wyrlo, "wyrlo_guard", {
      question: "Q ?",
      answer: "R.",
      passages: [{ text: "Texte." }],
    });
    expect(res?.result).toMatchObject({
      structuredContent: { decision: "answer", confidence: "unverified", degraded: true },
    });
  });

  it("stdio : une réponse par ligne, JSON illisible signalé, notification sans réponse", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on("data", (chunk: Buffer) =>
      lines.push(...chunk.toString().split("\n").filter(Boolean)),
    );
    const done = serveStdio(fakeClient(), input, output);
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.write("pas du json\n");
    input.end();
    await done;
    // Les réponses partent dès qu'elles sont prêtes : l'ordre n'est pas garanti.
    const replies = lines.map((l) => JSON.parse(l) as unknown);
    expect(replies).toHaveLength(2);
    expect(replies).toEqual(
      expect.arrayContaining([
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON." } },
        { jsonrpc: "2.0", id: 1, result: {} },
      ]),
    );
  });
});
