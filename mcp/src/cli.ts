#!/usr/bin/env node
/**
 * wyrlo-mcp : serveur MCP de WYRLO en local (stdio).
 *
 *   WYRLO_API_KEY=wyr_live_… npx @wyrlo/mcp
 *
 * Variables : WYRLO_API_KEY (obligatoire), WYRLO_BASE_URL, WYRLO_REGION (Paris par défaut),
 * WYRLO_TENANT (espace du client final dans l'index, mode C ; facultatif).
 */

import { Wyrlo, WyrloError } from "@wyrlo/sdk";
import { serveStdio } from "./stdio.ts";

try {
  const tenant = process.env.WYRLO_TENANT?.trim();
  await serveStdio(new Wyrlo(), process.stdin, process.stdout, tenant ? { tenant } : {});
} catch (error) {
  // Seule l'erreur de configuration est décrite ; jamais de contenu ni de clé.
  const message =
    error instanceof WyrloError ? error.message : "Erreur inattendue du serveur MCP de WYRLO.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
