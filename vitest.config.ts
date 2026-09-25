// Vitest config for a standalone plugin: the only thing needed beyond the
// defaults is the "@/" alias the plugin's tsconfig (and `bb plugin build`)
// already uses for its vendored components.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  esbuild: { jsx: "automatic" },
  test: { include: ["**/*.test.ts", "**/*.test.tsx"] },
});
