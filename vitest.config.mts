import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Mirror the tsconfig "@/*" path alias so tests can import modules and JSON
// the same way the app does.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
});
