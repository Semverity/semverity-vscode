# Open questions

Known gaps and decisions still open as of 0.1.0. Each entry says what happens today and the change we would make. Pull requests that settle one are welcome; please mention the entry.

## Requirements files included under other names

A `requirements*.txt` file can include another with `-r` or `-c` (for example `-r requirements/base.txt`). Today only files whose name matches `requirements*.txt` are indexed, decorated and given hovers, so the packages in `requirements/base.txt` are not scored. Nothing from such a file is sent, so this is a coverage gap, not a privacy one.

Proposed change: when the workspace index parses a requirements file, resolve each include relative to that file (inside the workspace only, with a bounded depth), parse the targets as requirements manifests, and let the document selectors, the hover registration and the analysis treat those files as manifests. Their dependencies should also count as declared by the including file, so an import resolves through them. Matching every `.txt` file under a `requirements/` folder would be simpler, but it would read files that are not requirements files (notes, readmes) as package names.

## Theme icon syntax inside code spans

Hovers are rendered with theme icons enabled. Untrusted text has its `$(` escaped, but text that is emitted as a code span (package names, ranges, exclusion patterns, and the single-backtick spans of server text) cannot carry a backslash escape. If the editor ever renders `$(name)` inside a code span as an icon, such text could show an icon (never a link or a command). Check the current VS Code Markdown renderer; if it does, replace `$(` in code span text with a lookalike or render those spans without icon support.

## The quick fix appears on the second request when the listing is not cached

The quick fix that moves a manifest to the healthy version needs the package listing. To keep the light bulb responsive, the code action provider uses only a cached listing and requests a missing one in the background, so the fix shows on the next request (moving the cursor, or opening the light bulb again). Hovering the dependency first also fetches the listing. A possible improvement is to request listings for entries that get a diagnostic when the diagnostics are computed, within the existing request budget.

## Screenshots

The README has no screenshots yet. Real captures of the decoration, hover, Problems entries, status bar and Semverity view should be taken from a development host (F5) on a sample workspace and added under `docs/screenshots/`, referenced from the README with absolute `https://raw.githubusercontent.com/...` URLs so the Marketplace page can show them.

## Extension host smoke test

There is no automated extension host test, because `@vscode/test-electron` and `@vscode/test-cli` download a VS Code build when the test runs. The manual smoke check in CONTRIBUTING.md covers it before each release. A CI job could run it with a cached VS Code download if the cache can be keyed to a pinned version.

## Minimum VS Code version and Node.js

`engines.vscode` is `^1.100.0`, whose extension host runs Node.js 20, so the bundle targets `node20`. `@types/node` is on major 22 (vitest 5 requires `^22 || >=24` as a peer, and npm 10 refuses the install with major 20), so the type checker does not catch Node.js 22-only APIs; nothing in the extension uses one today. Raising the minimum to `^1.101.0` would allow Node.js 22 in the extension host; if we do, change the esbuild target to `node22` in the same change. Contributors need Node.js 22 for the build tools; `devEngines` in `package.json` warns rather than fails on an older one.

## GitHub Actions majors

The workflows pin each action to a commit SHA within the major version they were written against (`actions/checkout` and `actions/setup-node` v5, `actions/upload-artifact` and `actions/download-artifact` v4). Newer majors exist; dependabot proposes them weekly. The upload and download artifact actions should move to compatible majors together, since an artifact uploaded by one major may not be readable by an older download action.
