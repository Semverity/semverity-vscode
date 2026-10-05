# Contributing

Thanks for helping improve the Semverity extension. Bug reports, fixes, new import forms, mapping table entries and documentation are all welcome. For a larger change, please open an issue first so we can agree on the approach.

By contributing you agree that your contribution is licensed under the Apache License 2.0, the license of this repository.

## Setup

You need Node.js 22 or later (for the build tools; `devEngines` in `package.json` warns on an older one) and VS Code 1.100 or later. The extension itself runs in the VS Code extension host, which is Node.js 20 for VS Code 1.100, so the bundle targets `node20` and `@types/node` stays on major 20. Raise both, with `engines.vscode`, when the minimum VS Code version moves.

```sh
git clone https://github.com/Semverity/semverity-vscode.git
cd semverity-vscode
npm ci
npm run check
```

| Script | What it does |
|---|---|
| `npm run build` | Bundles `src/extension.ts` into `dist/extension.js` with esbuild (with a source map). |
| `npm run watch` | The same, rebuilding on every change (used by the F5 launch configuration). |
| `npm run build:production` | Minified bundle without source maps, as shipped. |
| `npm run check:bundle` | Loads `dist/extension.js` in plain Node with a stand-in for `vscode` and checks it evaluates and exports `activate` and `deactivate` (catches unresolved requires in the bundle without launching VS Code). Also runs before every `npm run package`. |
| `npm run lint` | eslint over the whole repository. |
| `npm run typecheck` | `tsc` in strict mode, no output. |
| `npm test` | Unit tests with vitest. `npm run test:watch` keeps them running. |
| `npm run notices` | Regenerates `THIRD_PARTY_NOTICES.txt` from the runtime dependencies. |
| `npm run check` | Lint, typecheck, unit tests and the notices check: what CI runs before packaging. |
| `npm run package` | Builds `semverity.vsix` with `@vscode/vsce`. |

## How the code is organised

[docs/DESIGN.md](docs/DESIGN.md) describes the design in full. In short:

- `src/core/` parses documents, maps imports to packages, chooses versions, applies the privacy filter, and looks packages up through the API client with a cache and rate limits. It never imports `vscode`.
- `src/presentation/` turns lookup results into decoration text, hover markdown, diagnostics, quick fix edits and status bar text. Pure functions; it never imports `vscode` either.
- `src/vscode/` and `src/extension.ts` are thin adapters between the editor and the two layers above.

Two rules keep the logic testable and the privacy promise checkable, and lint enforces both:

1. Nothing under `src/core/` or `src/presentation/` imports `vscode`. Under vitest, `vscode` resolves to a stub that throws.
2. Only `src/core/api/client.ts` calls `fetch`, and its methods accept package coordinates only. If a change needs anything other than an ecosystem, name and version to leave the machine, it needs an issue and a discussion first, and the README section "What is sent" must change with it.

## Tests

Unit tests live in `test/`, mirroring `src/`. Fixtures in `test/fixtures/` are small, hand-written and public: never copy a real private manifest, lockfile or `.npmrc` into the repository. The API is never called from tests; `test/helpers/` provides a scripted fake `fetch`, a manual clock, an in-memory store and an in-memory file source.

When you add an import form, a manifest syntax or a mapping table entry, add a test case next to the existing ones.

## Manual smoke check

There is no automated extension-host test: `@vscode/test-electron` and `@vscode/test-cli` download a VS Code build when the tests run, which this project does not allow. Before a release (and for any change to `src/vscode/` or `src/extension.ts`), check the extension by hand:

1. Open this repository in VS Code and press F5 ("Run Extension"). A second window, the Extension Development Host, opens with the extension loaded.
2. In that window, open a scratch folder holding:
   - a `package.json` that depends on a few public packages (for example `lodash`, `express`), with a `package-lock.json` from `npm install --package-lock-only`, and a `.js` or `.ts` file that imports them;
   - a `requirements.txt` with, for example, `requests==2.32.3` and `PyYAML`, and a `.py` file with `import requests, yaml`;
   - a `go.mod` requiring, for example, `github.com/stretchr/testify`, and a `.go` file that imports it.
3. Check that each import and manifest line shows a score, that hovers render, that the status bar summarises the file, and that "Semverity: Check Workspace Dependencies" fills the Semverity view in the Explorer.
4. Add an `.npmrc` with `@acme:registry=https://npm.example.com/` and an import of `@acme/widget`; check that it shows `excluded` and that "Semverity: Show Log" records no request for it.
5. Turn lookups off with "Semverity: Turn Network Lookups On or Off" and check that nothing more is requested.
6. Install the packaged build with `code --install-extension semverity.vsix` in a clean profile (`code --profile semverity-check`) and repeat step 3.

## Pull requests

- Keep each pull request to one change, with tests, and run `npm run check` and `npm run package` before you push.
- Note user-visible changes in `CHANGELOG.md` under "Unreleased".
- Keep settings, commands and their descriptions in `package.json` and the README tables in step.
- Write plain, professional prose in code comments, docs and commit messages.

## Releases

Maintainers release from `main`:

1. Move the "Unreleased" notes in `CHANGELOG.md` under a new version heading and update the comparison links at the bottom.
2. Set the same version in `package.json` (`npm version <version> --no-git-tag-version`), run `npm run check` and `npm run package`, and run the manual smoke check above.
3. Commit, then tag `v<version>` and push the tag. The Release workflow checks that the tag matches `package.json`, packages the extension, attaches `semverity.vsix` to a GitHub release, and publishes it to the Visual Studio Marketplace and Open VSX.

The tag must point at a commit on `main`; the workflow fails otherwise. The marketplace jobs run only after the GitHub release succeeded.

Publishing needs two secrets, kept in a GitHub environment named `release` (Settings, Environments), not as repository secrets. Configure that environment with required reviewers and a deployment tag rule that allows only `v*` tags, so every publish waits for a maintainer's approval. Each publish step is skipped, with a message, when its secret is absent:

- `VSCE_PAT`: an Azure DevOps personal access token with the Marketplace "Manage" scope for the `semverity` publisher.
- `OVSX_PAT`: an Open VSX access token for an account that owns the `semverity` namespace (created once with `npx ovsx create-namespace semverity`).

The publish jobs install `@vscode/vsce` and `ovsx` from `package-lock.json` with `npm ci --ignore-scripts`, so the publisher tools and their dependencies are the locked, integrity-checked versions and no install script runs while a token is in the environment.

A tag with a hyphen (`v0.2.0-rc.1`) creates a GitHub prerelease with the `.vsix` attached and publishes nothing to the marketplaces, so a release candidate can be installed by hand first.
