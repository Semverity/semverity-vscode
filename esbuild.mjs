// Bundles the extension into dist/extension.js. The vscode module is provided
// by the extension host at run time and is never bundled.
import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  outfile: "dist/extension.js",
  external: ["vscode"],
  // Prefer ES module entry points: jsonc-parser's "main" is a UMD build whose
  // dynamic require("./impl/...") calls esbuild cannot follow, which leaves the
  // bundle unable to load. scripts/check-bundle.mjs guards against a repeat.
  mainFields: ["module", "main"],
  minify: production,
  sourcemap: production ? false : "linked",
  sourcesContent: false,
  legalComments: production ? "none" : "inline",
  logLevel: "info",
  metafile: production,
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  const result = await esbuild.build(options);
  if (production && result.metafile) {
    const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
    console.log(`dist/extension.js: ${(bytes / 1024).toFixed(1)} KiB`);
  }
}
