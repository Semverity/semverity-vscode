// Loads dist/extension.js in plain Node with a stand-in for the "vscode" module
// and checks that it evaluates and exports activate and deactivate. This catches
// bundling mistakes (an unresolved require, a missing dependency) that unit tests
// cannot see, without downloading or launching VS Code. It does not call activate.

import Module from "node:module";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const bundle = fileURLToPath(new URL("../dist/extension.js", import.meta.url));
if (!existsSync(bundle)) {
  console.error("dist/extension.js is missing; run npm run build:production first.");
  process.exit(1);
}

// Any property read, call or construction on the stand-in yields another stand-in.
// esbuild's ESM interop copies a module's own keys onto an object whose prototype
// is the module's prototype, so the prototype answers every name as well.
const catchAll = new Proxy(
  {},
  { get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : standIn()) },
);
function standIn() {
  return new Proxy(function vscodeStandIn() {}, {
    get: (_t, prop) => (prop === "then" ? undefined : prop === Symbol.toPrimitive ? () => "" : standIn()),
    getPrototypeOf: () => catchAll,
    apply: () => standIn(),
    construct: () => standIn(),
  });
}

const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  return request === "vscode" ? standIn() : originalLoad.call(this, request, ...rest);
};

try {
  const ext = createRequire(import.meta.url)(bundle);
  for (const name of ["activate", "deactivate"]) {
    if (typeof ext[name] !== "function") throw new Error(`the bundle does not export ${name}()`);
  }
  console.log("dist/extension.js loads and exports activate and deactivate.");
} catch (err) {
  console.error(`dist/extension.js failed to load: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  Module._load = originalLoad;
}
