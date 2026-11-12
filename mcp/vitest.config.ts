import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests sur le source du SDK : son dist n'est pas versionné.
export default defineConfig({
  resolve: {
    alias: { "@wyrlo/sdk": fileURLToPath(new URL("../typescript/src/index.ts", import.meta.url)) },
  },
});
