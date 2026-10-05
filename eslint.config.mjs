import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "out/", "coverage/", "node_modules/", "*.vsix"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      eqeqeq: ["error", "smart"],
      "no-console": "error",
    },
  },
  {
    // The core and presentation layers are pure: they never import vscode, so
    // they run under vitest without the extension host. Only src/vscode/** and
    // src/extension.ts talk to the editor.
    files: ["src/core/**/*.ts", "src/presentation/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "vscode", message: "Keep vscode behind the adapters in src/vscode." }],
          patterns: [{ group: ["**/vscode/**", "../vscode/*"], message: "Core and presentation must not depend on the adapters." }],
        },
      ],
    },
  },
  {
    // The API client is the only module that touches the network, and it only
    // ever receives coordinates. Nothing else may call fetch directly.
    files: ["src/**/*.ts"],
    ignores: ["src/core/api/client.ts", "src/vscode/fetch.ts"],
    rules: {
      "no-restricted-globals": ["error", { name: "fetch", message: "Use the SemverityClient (src/core/api/client.ts)." }],
    },
  },
  {
    files: ["esbuild.mjs", "scripts/**/*.mjs"],
    rules: { "no-console": "off" },
  },
);
