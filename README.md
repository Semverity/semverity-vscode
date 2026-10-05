# Semverity for Visual Studio Code

See the [Semverity](https://semverity.dev) score of every open source dependency as you import it. When you type an import or edit a manifest, the extension works out which package and version you mean, looks it up on the Semverity API and shows the answer next to the line: the headline score and grade, the security grade, any gates that fired (malware, known exploited vulnerabilities, unfixed critical advisories and more), how much of the evidence was available, and a healthier version when there is one.

Semverity scores open source packages. The headline score rolls up a package together with everything it depends on; the own score covers the package alone. Both use the same bands: A is 90 and above, B 80 to 89, C 65 to 79, D 50 to 64 and F below 50. A version that pulls in malware or a known exploited vulnerability on an installed path is graded F whatever its own score.

The extension sends package coordinates (ecosystem, name and version) and nothing else. See [What is sent](#what-is-sent).

## Features

- **Inline score.** A compact shield, score and grade at the end of each import or dependency line, coloured by grade: `83 B`, `≤83 B` while the score is an upper bound (not every dependency is scored yet), `74 C · 1 gate`, `KEV · 25 F`, `malware`. Lines with several packages (`import os, yaml, requests`) list each one, coloured by the worst.
- **Hover card.** Headline and own score with grades, the security grade, evidence coverage, every fired gate with the reason and recommendation, why a score is low (the weakest dependencies, the lowest scoring areas), the healthy version with a one-click link to use it, and a link to the package page on semverity.dev. When nothing is cached yet, the hover waits up to 4 seconds for the score and up to 3 seconds for the package's version list, then shows what it has (the decoration fills in when the answer arrives).
- **Problems.** Warnings and errors for low scores (configurable thresholds) and for selected gates. Malware and KEV (a vulnerability on the CISA Known Exploited Vulnerabilities list) are always reported as errors while diagnostics are on.
- **Quick fix.** "Bump lodash to 4.18.1 (Semverity healthy version)" rewrites the version in the manifest that declares the package, keeping your range operator where it can.
- **Status bar.** A summary of the open file: how many dependencies, the lowest score, fired gates, and whether lookups are working, rate limited or offline.
- **Workspace check.** "Semverity: Check Workspace Dependencies" scores every dependency declared in the workspace's manifests and lists them in the Semverity view in the Explorer, worst first, one group per manifest.

## Supported languages and files

| Ecosystem | Source files | Manifests | Lockfiles read for exact versions |
|---|---|---|---|
| npm | JavaScript and TypeScript (`.js .mjs .cjs .jsx .ts .mts .cts .tsx`): `import`, `export ... from`, `require()`, `require.resolve()`, `import()`, `import x = require()` | `package.json` | `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock` (v1 and Berry), `bun.lock` |
| PyPI | Python: `import`, `from ... import`, `importlib.import_module()`, `__import__()` | `requirements*.txt`, `pyproject.toml` (PEP 621, Poetry, PEP 735 groups) | `poetry.lock`, `uv.lock`, `pdm.lock`, `Pipfile.lock` |
| Go modules | Go: single and grouped `import` declarations | `go.mod` | none needed (`go.mod` versions are exact) |

How an import becomes a package:

- **JavaScript and TypeScript.** Bare specifiers map to npm package names (`lodash/fp` is `lodash`, `@scope/pkg/sub` is `@scope/pkg`). Node built-ins (`fs`, `node:fs`), other schemes (`bun:`, `deno:`, `virtual:` and the like), relative paths, `package.json` `imports` (`#x`), tsconfig or jsconfig `paths` and `baseUrl` aliases, `@/` and `~/` aliases, and the workspace's own packages are never looked up.
- **Python.** Import names map to distribution names. Where they differ (`yaml` is PyYAML, `cv2` is opencv-python, `sklearn` is scikit-learn, `PIL` is Pillow, `bs4` is beautifulsoup4, and many more) a curated table is used, and the workspace's requirements choose between candidates (`cv2` resolves to `opencv-python-headless` when that is what you declared). A from-import of a namespace package is mapped through the name it imports (`from google.cloud import storage` is google-cloud-storage, `from google import genai` is google-genai); a bare namespace root such as `google`, `google.cloud` or `azure` is never looked up on its own. Standard library modules, relative imports and modules that exist inside the workspace (a `.py` file, a package, or any directory between a workspace folder and a `.py` file, which covers namespace packages, `src` layouts and `scripts` folders) are never looked up.
- **Go.** An import path maps to the longest module path in the nearest `go.mod` that prefixes it. The standard library, packages under your own module and modules replaced by a local path are never looked up.

An import that no manifest declares is looked up at its latest version, under its top-level name (the npm package name, the Python distribution from the table or the import name itself, or the Go module path), unless `semverity.privacy.lookupUndeclaredImports` is off.

How a version is chosen, in order: the version a lockfile pins, else an exact version in the manifest, else the newest version Semverity knows that satisfies the declared range, else the latest release. The hover says which one applied ("locked version (package-lock.json)", "declared version", "newest known version matching `^4.17.0`", "latest version (not declared)"). An import in a source file takes the version of the nearest manifest that declares the package.

## What is sent

Only package coordinates: ecosystem, package name and version, as purls in a batch body or as segments of a GET path, to the configured API base URL (default `https://api.semverity.dev`, operated by Semverity), plus the headers below. Never sent: source code, import statements, file names or paths, manifest or lockfile contents, repository, workspace or folder names, user or machine identifiers, editor version, settings. There is no telemetry of any kind, and the extension does not use the VS Code telemetry API. Package page links open `https://semverity.dev/registry/...` in the browser only when the user clicks them. Requests go to the configured base URL and nowhere else: redirects are never followed (an API that answers with a redirect is treated as unreachable), and no cookies are sent.

The requests are `POST /v1/packages:batch` (a JSON body of the form `{"purls": ["pkg:npm/lodash@4.18.1", "pkg:pypi/pyyaml@6.0.3"]}`), `GET /v1/packages/{ecosystem}/{name}` (the package's versions and its healthy version) and `GET /v1/packages/{ecosystem}/{name}/versions/{version}` (one version's card). The extension sets these headers on every request:

| Header | Value |
|---|---|
| `Accept` | `application/json` |
| `User-Agent` | `semverity-vscode/<extension version>` |
| `Content-Type` | `application/json` (POST only) |
| `Authorization` | `Bearer <key>`, only when you have set an API key and the base URL uses `https:` (or `http:` on a loopback address, for local development) |
| `If-None-Match` | the stored ETag, when revalidating a cached answer |

The Node.js HTTP stack adds standard transport headers (`Host`, `Connection`, `Content-Length`, `Accept-Encoding`, `Accept-Language: *`, `Sec-Fetch-Mode: cors`) that carry nothing about you, your code or your workspace. When VS Code is configured with an HTTP proxy (`http.proxy` or the system proxy), requests go through it, so the proxy sees them too.

As with any HTTP request, the API sees the network address the request comes from; signed out, it uses that address to apply its rate limit. With an API key, requests are associated with the Semverity account that owns the key, and the API may collect a package version it has not indexed yet and keep it watched (re-scored as new evidence and advisories arrive), as described in the Semverity API documentation. Signed out, lookups only read the public index: nothing is collected or watched.

Turn every network lookup off with `semverity.network.enabled` (or "Semverity: Turn Network Lookups On or Off"). Cached scores are still shown, and are marked as cached once they age out.

## Privacy

Before anything is queued, a privacy filter drops packages that should not leave the machine. A package is never sent when:

1. it matches `semverity.privacy.excludePatterns` (user, workspace and folder values are combined, so a workspace can add exclusions but never remove yours). Patterns use `*` for any run of characters and `?` for one character, optionally prefixed with `npm:`, `pypi:` or `golang:`; for example `@acme/*`, `acme-*`, `golang:git.example.com/*`;
2. the npm registry configuration points it at a registry other than the public one (`registry.npmjs.org`, `registry.yarnpkg.com`) or a trusted host. The extension reads `.npmrc` (`@scope:registry=` and `registry=` lines), the Yarn 1 `.yarnrc` (`registry` and `"@scope:registry"`), the Yarn Berry `.yarnrc.yml` (`npmRegistryServer` and `npmScopes.<scope>.npmRegistryServer`) and Bun's `bunfig.toml` (`[install] registry` and `[install.scopes]`), in every directory from the file's directory up to the workspace root and in your home directory, plus the `NPM_CONFIG_REGISTRY`, `YARN_NPM_REGISTRY_SERVER` and `BUN_CONFIG_REGISTRY` environment variables. Every binding found counts, whichever tool you use. A scope bound to another registry is never sent. When the default registry is not public, an unscoped package is sent only when a lockfile shows it came from a public registry: pnpm, Yarn Berry and Bun lockfiles often do not record where a package came from, so in those projects (and without a lockfile) every npm package is held back until you add the registry host to `semverity.privacy.trustedRegistryHosts` (the usual case for a company mirror of npm). Only registry URLs are read; tokens and every other setting are ignored and never stored or logged. On by default (`semverity.privacy.excludeNpmrcScopes`);
3. a lockfile resolves it from a host other than the public registries (`registry.npmjs.org`, `registry.yarnpkg.com`, `pypi.org`, `files.pythonhosted.org`) or a host you trust in `semverity.privacy.trustedRegistryHosts` (for a company mirror of the public registries);
4. a Python package index that is not public or trusted could serve it. Indexes are read from the requirements file that declares the package (`--index-url`, `-i`, `--extra-index-url`, `--find-links`) and from `pyproject.toml` (uv's `index`, `index-url` and `extra-index-url`, Poetry's and PDM's `source` tables; an index marked explicit only affects the packages pinned to it, and those are never sent). An import that no manifest declares is held back when any Python manifest of the workspace names such an index. Every PyPI package is held back when the environment (`PIP_INDEX_URL`, `PIP_EXTRA_INDEX_URL`, `PIP_FIND_LINKS`, `UV_INDEX_URL`, `UV_EXTRA_INDEX_URL`, `UV_DEFAULT_INDEX`, `UV_INDEX`) or your user or site `pip.conf` (`pip.ini` on Windows, or `$PIP_CONFIG_FILE`) or `uv.toml` names one. A file with `--extra-index-url https://download.pytorch.org/whl/cpu`, for example, is not looked up until you add `download.pytorch.org` to `semverity.privacy.trustedRegistryHosts`. A `--find-links` to a local directory has no host to check, so it holds packages back too;
5. it is a Go module matching `GOPRIVATE`, `GONOPROXY` or `GONOSUMDB`, or a module replaced by a local path. The variables are read from the environment VS Code was started with and from the file `go env -w` writes (`$GOENV`, or `go/env` under your user configuration directory), and both are honoured. VS Code started from a desktop launcher may not see variables set only in a shell profile, so prefer `go env -w GOPRIVATE=...` or add an exclude pattern such as `golang:git.example.com/*`;
6. it is local code: relative imports, aliases, the workspace's own package names, monorepo workspace packages, `workspace:`, `file:`, `link:`, git and URL specs, editable and path requirements, Python modules inside the workspace, Go packages under the main module;
7. no manifest declares it and `semverity.privacy.lookupUndeclaredImports` is off. With the setting on (the default), an undeclared import is sent by name at its latest version once the rules above let it through; turn it off if your code imports internal packages installed from an index the extension cannot see (for example one passed to `pip install --index-url` on the command line).

An excluded package shows `excluded` (when `semverity.decorations.showUnscored` is on), and its hover names the rule that matched: "Not looked up: matches `@acme/*`. Nothing about this package was sent."

`semverity.network.enabled` and the three `semverity.ecosystems.*` switches can be turned off at any level, but never back on by a workspace: when your user settings say off, a workspace or folder value of on is ignored. In an untrusted workspace (Restricted Mode), workspace values of `semverity.network.enabled`, `semverity.ecosystems.npm`, `semverity.ecosystems.pypi`, `semverity.ecosystems.golang`, `semverity.privacy.excludeNpmrcScopes` and `semverity.privacy.lookupUndeclaredImports` are ignored, so a repository you have not trusted cannot widen what is sent. The API base URL, the site URL and the trusted registry hosts can only be set in user settings, so a workspace can never redirect lookups or your API key.

## API key (optional)

Without a key, the extension reads every public package version Semverity has already scored. A version Semverity has not scored shows `not scored`, and the hover names the latest scored version when there is one. Signed-out reads are rate limited per network address.

With a key, Semverity also collects and scores public packages it has not seen yet: the decoration shows `scoring…` and updates by itself when the score is ready. Signed-in lookups count against the key's own allowance instead of the per-address limit.

Create a key in the dashboard at [semverity.dev](https://semverity.dev), then run **Semverity: Set API Key** and paste it. The key is stored only in VS Code's SecretStorage (your operating system's credential store); it is never written to settings, the cache or the log, and it is only sent to the configured API base URL over `https:`. **Semverity: Clear API Key** removes it. If the API refuses the key, the extension stops sending it for the session, carries on signed out and tells you once.

## Cache and network use

- Answers are cached in memory and in VS Code's extension storage on this machine (not synced between machines), for the response's `Cache-Control` lifetime or `semverity.cache.ttlHours` (default 24 hours) when it has none, and never less than 15 minutes. Semverity refreshes public scores at most daily, so a day-old answer is normally current. "Not scored" answers are kept for `semverity.cache.negativeTtlMinutes` (default 60 minutes); setting or clearing an API key forgets them.
- An answer past its lifetime is still shown while it is rechecked in the background, with an ETag where the API supplied one, so an unchanged answer costs a `304` and no body.
- Edits are debounced (`semverity.editDebounceMs`, default 600 ms), the imports of a file are looked up together in one batch request, and requests are limited to `semverity.network.maxRequestsPerMinute` (default 60, with bursts of up to 10) with one request in flight at a time. An import or range that names no exact version needs the package's version list first (one request per package, since the batch takes exact versions only); the list already carries the score of the latest and healthy versions, so the decoration shows as soon as it arrives, and the full card follows in the next batch. The extension also stays within the API's allowance of package lookups: signed out, 25 at once and then 60 a minute per network address; with an API key, 100 at once and then 10 a minute (the key's 600 lookups an hour).
- On `429 Too Many Requests` or `503` every request pauses until the `Retry-After` time. When the API cannot be reached the extension retries with a growing delay (15 seconds up to 10 minutes) and keeps showing cached answers, marked "(cached)" once they could not be rechecked for a whole TTL.
- **Semverity: Clear Cached Scores** empties the cache; **Semverity: Refresh Scores** looks up the visible files' packages again.

A workspace check of many uncached dependencies is paced by these limits (about 175 dependencies in the first two and a half minutes signed out, and noticeably slower with an API key once its first 100 are spent); cached answers appear at once and a progress notification shows how far it has got.

## Settings

| Setting | Default | Description |
|---|---|---|
| `semverity.network.enabled` | `true` | Look packages up on the Semverity API. When off, nothing is sent anywhere and only cached scores are shown. Off at any level wins. |
| `semverity.api.baseUrl` | `https://api.semverity.dev` | API base URL. User settings only. |
| `semverity.site.baseUrl` | `https://semverity.dev` | Web site base URL for package page links. User settings only. |
| `semverity.ecosystems.npm` | `true` | Score JavaScript and TypeScript imports and `package.json` dependencies. |
| `semverity.ecosystems.pypi` | `true` | Score Python imports and `requirements*.txt` and `pyproject.toml` dependencies. |
| `semverity.ecosystems.golang` | `true` | Score Go imports and `go.mod` requirements. |
| `semverity.decorations.enabled` | `true` | Show the inline score at the end of import and manifest lines. |
| `semverity.decorations.showUnscored` | `true` | Also decorate packages that are not scored yet, pending or excluded (muted). |
| `semverity.hovers.enabled` | `true` | Show the Semverity card on hover. |
| `semverity.diagnostics.enabled` | `true` | Report low scores and fired gates in the Problems panel. Malware and KEV are always errors while this is on. |
| `semverity.diagnostics.scoreBasis` | `headline` | Which score the thresholds read: `headline` (with dependencies) or `own`. |
| `semverity.diagnostics.warningBelow` | `65` | Warn when the score is below this value (65 is the bottom of grade C). `0` turns score warnings off. |
| `semverity.diagnostics.errorBelow` | `0` | Report an error when the score is below this value. `0` turns score errors off. |
| `semverity.diagnostics.gates` | see below | Gates that raise a warning when they fire. |
| `semverity.privacy.excludePatterns` | `[]` | Package name patterns that are never sent. |
| `semverity.privacy.excludeNpmrcScopes` | `true` | Never send npm packages that `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `bunfig.toml` or the environment bind to a registry other than the public one. |
| `semverity.privacy.trustedRegistryHosts` | `[]` | Registry hosts that mirror the public registries. User settings only. |
| `semverity.privacy.lookupUndeclaredImports` | `true` | Look up imports that no manifest declares (at their latest version). |
| `semverity.cache.ttlHours` | `24` | Lifetime of an answer without its own `Cache-Control` lifetime, and the age after which an answer that could not be rechecked is shown as cached. |
| `semverity.cache.negativeTtlMinutes` | `60` | How long a "not scored" answer is kept. |
| `semverity.network.maxRequestsPerMinute` | `60` | Upper bound on requests to the API per minute (1 to 60). |
| `semverity.editDebounceMs` | `600` | Milliseconds to wait after the last edit before looking up new imports. |
| `semverity.statusBar.enabled` | `true` | Show the summary in the status bar. |

The gates that warn by default are `high_vuln_with_fix`, `unfixed_high_vuln`, `yanked`, `typosquat`, `install_script_untrusted`, `dependency_confusion`, `denied_package` and `license_denied`. You can also add `moderate_vuln_with_fix`, `archived`, `prerelease`, `min_age`, `bus_factor_one`, `no_provenance`, `source_repo_missing` and `unpinned`. Every fired gate is listed in the hover whether or not it warns.

The inline colours are themeable as `semverity.gradeA` to `semverity.gradeF` and `semverity.unscored` in `workbench.colorCustomizations`.

## Commands

| Command | What it does |
|---|---|
| Semverity: Check Workspace Dependencies | Scores every dependency declared in the workspace's manifests (up to 2,000), fills the Semverity view and reports problems in the manifests. |
| Semverity: Open Package Page | Opens the package on semverity.dev: the package on the cursor line, or a choice of the open file's packages. |
| Semverity: Refresh Scores | Looks up the packages of the visible files (and of the Semverity view) again. |
| Semverity: Clear Cached Scores | Empties the memory and on-disk cache. |
| Semverity: Set API Key | Stores an API key in SecretStorage. |
| Semverity: Clear API Key | Removes the stored API key. |
| Semverity: Turn Network Lookups On or Off | Flips `semverity.network.enabled` in your user settings. |
| Semverity: Show Log | Opens the Semverity output channel. The log holds package coordinates and API status codes, never the API key or source text. |

## Quick fixes and lockfiles

The quick fix edits the manifest only: `package.json`, `requirements*.txt`, `pyproject.toml` or `go.mod`. It never edits a lockfile, so run your package manager afterwards (`npm install`, `pnpm install`, `yarn`, `pip install -r`, `poetry lock`, `uv lock`, `go mod tidy`) to bring the lockfile and the installed packages in line. A range keeps its operator where it can (`^4.17.0` becomes `^4.18.1`, `~=1.2.0` becomes `~=1.3.1`); a range with several clauses becomes `^<version>` for npm and `==<version>` for Python. The fix is offered from a source file too, and then edits the manifest that declares the package. The hover's "Use x" link runs the same edit, and it too only ever edits one of those manifest files.

## Known limitations

- Ecosystems other than npm, PyPI and Go modules are not covered yet.
- tsconfig and jsconfig `extends` chains are not followed when collecting path aliases; aliases declared only in an extended config may be looked up as packages unless they match an exclude pattern.
- Bundler aliases defined outside tsconfig and jsconfig (Vite or webpack `resolve.alias`, Babel module resolvers) are not detected. An aliased import that no manifest declares is looked up as a package of that name: add the alias to `semverity.privacy.excludePatterns`, or turn `semverity.privacy.lookupUndeclaredImports` off.
- `go.work` files are not parsed. Every module with a `go.mod` in the workspace counts as one of your own modules, which covers workspace members and never sends them.
- Python modules inside the workspace are found by their `.py` files and `__init__.py` packages when the workspace is indexed, and new files are picked up as they are created. Namespace packages without an `__init__.py` and code outside the workspace folders are not known to be local; an import of one that no requirement declares is looked up under its name unless an exclude pattern covers it.
- Python's installed package metadata is not read, so an import whose distribution name differs and is not in the curated table, and that no requirement declares, is looked up under its import name.
- There is no automated extension-host test: the available test runners download a VS Code build at test time, which this project does not allow. The logic is covered by unit tests, and each release is checked by hand (see [CONTRIBUTING.md](CONTRIBUTING.md)).

## Feedback and security

Bugs and ideas: [GitHub issues](https://github.com/Semverity/semverity-vscode/issues). Questions about a particular package's score belong on its page at semverity.dev. Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Copyright Cliff Colvin and the Semverity contributors. The bundled third-party packages are listed with their licenses in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
