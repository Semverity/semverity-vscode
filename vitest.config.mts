import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Logic under test must not reach the real vscode API. Any import of
      // "vscode" in a test run resolves to a stub that throws, so a leak
      // fails loudly instead of silently needing the extension host.
      vscode: fileURLToPath(new URL("./test/helpers/vscode-stub.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/core/**", "src/presentation/**"],
    },
  },
});
