# Semverity for VS Code: design

Design of the extension as of 0.1.0: what it does, how it is put together, what it sends and how it is tested. Keep it current with what ships.

## 1. What the extension does

As a developer types an import (JavaScript and TypeScript `import`, `export ... from`, `require`, `import()`; Python `import` and `from ... import`; Go import paths) or edits a manifest (`package.json`, `requirements*.txt`, `pyproject.toml`, `go.mod`), the extension:

1. parses the document locally and maps each import or declared dependency to a package (npm package name, PyPI distribution name, Go module path);
2. chooses a version locally (lockfile pin, else an exact manifest version, else a manifest range resolved against the versions Semverity knows, else the latest release);
3. drops anything the privacy filter refuses (section 6);
4. looks the remaining package versions up on the Semverity API (`https://api.semverity.dev`), batched, cached and rate limited (sections 4 and 5);
5. shows the answer as an inline decoration, a hover card, diagnostics with quick fixes, a status bar summary and, after "Check Workspace", a tree view (section 9).

Non-goals for 0.1.0: no other ecosystems (Cargo, Maven and the rest are served by the API and can follow), no transitive tree browsing in the editor (the hover links to the package page, which has the tree), no scanning of whole repositories through `/v1/scan` (that sends manifest contents; this extension sends coordinates only), no web extension build (the extension is Node only, `main` without `browser`).

## 2. Architecture

```
            vscode API
                |
  src/vscode/*  adapters: documents, decorations, hover, diagnostics, code actions,
                status bar, tree, commands, config, secrets, files, store, logger, fetch
                |                                   ^
                | CoreDeps (ports)                  | DocumentAnalysis, LookupResult
                v                                   |
  src/core/*    parsers -> mapping -> resolver -> privacy filter -> lookup service -> client -> fetch
                                   ^                              |
                           workspace index                     score cache (memory + globalState)
                (manifests, lockfiles, .npmrc, tsconfig, local modules)

  src/presentation/*   pure functions: LookupResult + AnalysisEntry + Settings -> decoration text,
                       hover markdown, diagnostic specs, quick fix edits, status bar summary
```

Rules that keep the logic testable and the privacy promise checkable:

- `src/core/**` and `src/presentation/**` never import `vscode` (eslint `no-restricted-imports`; vitest aliases `vscode` to a module that throws).
- Only `src/core/api/client.ts` calls `fetch`, and only through the `FetchLike` port (eslint `no-restricted-globals` everywhere else, except the adapter that hands `globalThis.fetch` over). The client's methods accept `Coordinate` and `PackageId` values only, so file paths and source text cannot reach a request by construction.
- URIs inside the core are opaque strings used for local file access; they are never part of a `Coordinate`.

## 3. Module layout and interfaces

Seeded contract files (already in the repository, owned by core, changed only additively):

| File | Contents |
|---|---|
| `src/core/types.ts` | `Ecosystem`, `PackageId`, `Coordinate`, `VersionSource`, `TextRange`, `ImportRef`, `ManifestDependency`, `ParsedManifest`, `LookupTarget`, `SkipReason`, `DeclaredIn`, `AnalysisEntry`, `DocumentAnalysis`, `FiredGate`, `CardSummary`, `ListingSummary`, `LookupResult`, `NetworkStatus`, `CoreOptions`, `Disposable`, `Event` |
| `src/core/ports.ts` | `FetchLike`, `FetchResponseLike`, `Clock`, `KeyValueStore`, `Logger`, `SecretSource`, `FileSource` |
| `src/core/api/types.ts` | API response shapes: `PackageCard`, `Headline`, `OwnScore`, `SecurityScore`, `Gate`, `WithDependencies`, `InheritedGate`, `Contribution`, `PackageList`, `PackageVersionEntry`, `Pending`, `BatchRequest`, `BatchResponse`, `ErrorResponse` |
| `src/core/api/purl.ts` | purl, API path, cache key and package page URL builders (implemented and tested; verified against the live API) |
| `src/core/index.ts` | the core facade: `Core`, `CoreDeps`, `WorkspaceIndex`, `LookupService`, `Priority`, `targetKey()`, `createCore()` (stub that throws until core lands) |

### 3.1 Core modules (owner: core)

| File | Exports | Notes |
|---|---|---|
| `src/core/emitter.ts` | `class Emitter<T> { event: Event<T>; fire(v: T): void; dispose(): void }` | tiny, no dependencies |
| `src/core/uri.ts` | `dirname(uri)`, `basename(uri)`, `join(uri, ...parts)`, `ancestors(uri, stopAt)`, `relative(from, to)` | string operations on `scheme:///path` URIs; posix separators |
| `src/core/parsers/scan.ts` | `stripJsComments(text): string`, `lineIndex(text): LineIndex` with `positionAt(offset)` | comment and string masking that keeps offsets (masked characters become spaces, newlines kept) |
| `src/core/parsers/javascript.ts` | `parseJsImports(text: string): ImportRef[]` | section 7.1 |
| `src/core/parsers/python.ts` | `parsePythonImports(text: string): ImportRef[]` | section 7.2 |
| `src/core/parsers/go.ts` | `parseGoImports(text: string): ImportRef[]` | section 7.3 |
| `src/core/parsers/packageJson.ts` | `parsePackageJson(uri, text): PackageJsonManifest` (`ParsedManifest` plus `workspaces: string[]`, `importsKeys: string[]`) | jsonc-parser tree for exact ranges |
| `src/core/parsers/requirements.ts` | `parseRequirements(uri, text): RequirementsManifest` (plus `indexUrls: string[]`, `includes: string[]`) | PEP 508 subset |
| `src/core/parsers/pyproject.ts` | `parsePyproject(uri, text): ParsedManifest` | smol-toml for structure, a line scan for ranges |
| `src/core/parsers/goMod.ts` | `parseGoMod(uri, text): GoModManifest` (plus `module?: string`, `replaces: GoReplace[]`) | line parser |
| `src/core/parsers/lockfiles.ts` | `parseNpmLock`, `parsePnpmLock`, `parseYarnLock`, `parseBunLock`, `parsePoetryLock` (also `pdm.lock`), `parseUvLock`, `parsePipfileLock`; each returns `Lockfile` | `Lockfile = { ecosystem; versions(name, importerDir?): string \| undefined; resolvedHost(name): string \| undefined }` |
| `src/core/parsers/npmRegistries.ts` | `parseNpmrc`, `parseYarnrc`, `parseYarnrcYml`, `parseBunfig` (scope and default registry bindings, as hosts) | reads only registry URLs; tokens and every other setting are ignored and never stored |
| `src/core/privacy/localConfig.ts` | npm registry and Python index variables of the environment; `pip.conf` and `uv.toml` index keys | only URLs are kept; the adapter `src/vscode/pythonEnv.ts` reads the files |
| `src/core/parsers/tsconfig.ts` | `parseTsconfigAliases(text): { patterns: string[]; baseUrl?: string }` | JSONC; `extends` is not followed in 0.1.0 |
| `src/core/mapping/nodeBuiltins.ts` | `NODE_BUILTINS: ReadonlySet<string>` | static list (Node 22 `module.builtinModules`), plus `bun:`, `deno:` style scheme handling in npm.ts |
| `src/core/mapping/npm.ts` | `npmPackageFor(specifier, aliases): { name: string } \| { skip: SkipReason; detail?: string }` | section 7.1 |
| `src/core/mapping/pythonStdlib.ts` | `PYTHON_STDLIB: ReadonlySet<string>` | `sys.stdlib_module_names` of CPython 3.13 plus `__future__` |
| `src/core/mapping/pythonTable.ts` | `PYTHON_IMPORT_TO_DIST: ReadonlyMap<string, readonly string[]>` | curated table, dotted keys allowed, first entry is the default |
| `src/core/mapping/python.ts` | `pythonDistributionFor(importName, declared, ctx, fromNames): { name: string; declared: boolean } \| { skip }` | section 7.2 |
| `src/core/mapping/golang.ts` | `goModuleFor(importPath, ctx): { module: string; declared: boolean } \| { skip }`, `isGoStdlib(path)` | section 7.3 |
| `src/core/resolver/workspaceIndex.ts` | `class WorkspaceIndexImpl implements WorkspaceIndex` plus query methods used by the resolver: `npmContext(uri)`, `pythonContext(uri)`, `goContext(uri)`, `manifestFor(uri)` | per-directory maps built from `FileSource` |
| `src/core/resolver/resolve.ts` | `analyzeSource(doc, index, filter, options): DocumentAnalysis`, `analyzeManifest(doc, index, filter, options): DocumentAnalysis` | combines parse, map, version choice, privacy |
| `src/core/resolver/versions.ts` | `pickVersion(ecosystem, range, known: string[]): string \| undefined`, `exactVersion(ecosystem, spec): string \| undefined`, `compareVersions(ecosystem, a, b): number` | npm via `semver`; PyPI via pep440.ts; Go via semver after stripping `v` |
| `src/core/resolver/pep440.ts` | `parsePep440(v)`, `comparePep440(a, b)`, `satisfiesPep440(v, specifier)` | release, pre, post, dev segments; operators `== != <= >= < > ~= ===` and `==1.2.*` |
| `src/core/privacy/patterns.ts` | `compilePattern(p): (id: PackageId) => boolean` | section 6.2 |
| `src/core/privacy/goprivate.ts` | `matchGoPrivate(patterns: string, modulePath): boolean` | Go's `GOPRIVATE` glob semantics (path element prefixes) |
| `src/core/privacy/filter.ts` | `class PrivacyFilter { check(id, local: LocalSignals): { allowed: true } \| { allowed: false; rule: string } }` | section 6 |
| `src/core/api/cacheControl.ts` | `parseCacheControl(h): { maxAgeSec?: number; swrSec?: number; noStore: boolean }`, `parseRetryAfter(h, nowMs): number \| undefined` (ms) | seconds or HTTP date |
| `src/core/api/client.ts` | `class SemverityClient { batch(coords); card(c, etag?); listing(id, etag?) }` | section 4 |
| `src/core/api/summary.ts` | `summarizeCard(card: PackageCard): CardSummary \| undefined`, `summarizeListing(list: PackageList): ListingSummary \| undefined` | trims for storage (drops sub-signals, sources, unfired gates); returns undefined for an ecosystem outside `Ecosystem` |
| `src/core/cache/scoreCache.ts` | `class ScoreCache` | section 5.2 |
| `src/core/lookup/rateLimiter.ts` | `class TokenBucket { take(n): number /* ms to wait, 0 when granted */ }` | uses `Clock` |
| `src/core/lookup/service.ts` | `class LookupServiceImpl implements LookupService` | queue, coalescing, chunking, pending polls, backoff, status |
| `src/core/index.ts` | `createCore(deps): Core` | wires the above |

`Core.analyze()` is synchronous and network free. `LookupService.peek()` answers from the cache only. All network work happens in `LookupServiceImpl` on its own schedule.

### 3.2 Presentation modules (owner: ui; pure, tested with vitest)

| File | Exports |
|---|---|
| `src/presentation/grades.ts` | `GRADE_ORDER`, `colorIdFor(grade \| undefined): string` (`semverity.gradeA`..`semverity.gradeF`, `semverity.unscored`), `scoreFor(card, basis): { score: number; grade: Grade } \| undefined`, `worse(a, b)` |
| `src/presentation/labels.ts` | `gateLabel(id)`, `versionSourceLabel(source, range?)`, `relativeAge(ms, now)`, `formatScore(score, atMost)` |
| `src/presentation/decoration.ts` | `decorationFor(items: { entry: AnalysisEntry; result?: LookupResult }[], s: PresentationSettings): DecorationSpec \| undefined` with `DecorationSpec = { text: string; colorId: string; iconGrade: Grade \| "none"; muted: boolean }` |
| `src/presentation/hover.ts` | `hoverMarkdown(entry, result, ctx: HoverContext): string` with `HoverContext = { siteBaseUrl; now; applyCommand?: { title; args } }` |
| `src/presentation/diagnostics.ts` | `diagnosticsFor(entry, result, s): DiagnosticSpec[]`, `DiagnosticSpec = { range; severity: "error" \| "warning" \| "information"; message; code: "malware" \| "kev" \| "gate" \| "score"; target: string }` |
| `src/presentation/quickfix.ts` | `rewriteSpec(kind: ManifestKind, spec, version): string`, `bumpEdit(declaredIn, version): { uri; range; newText } \| undefined`, `bumpTitle(name, from, to, compare)` |
| `src/presentation/summary.ts` | `summarize(items): Summary`, `statusBarModel(summary, status: NetworkStatus): { text; tooltipMarkdown; severity: "none" \| "warning" \| "error" }`, `treeOrder(a, b)` |

### 3.3 Adapters (owner: ui; thin, not unit tested beyond what is practical)

| File | Role |
|---|---|
| `src/settings.ts` | `readSettings(config: ConfigLike): Settings`, `toCoreOptions(s, extensionVersion, env): CoreOptions`, `toPresentationSettings(s)`; `ConfigLike = { get<T>(key): T \| undefined; inspect<T>(key): { globalValue?; workspaceValue?; workspaceFolderValue? } \| undefined }` (testable without vscode) |
| `src/vscode/fetch.ts` | `globalThis.fetch` as `FetchLike` with a 15 s `AbortSignal.timeout` |
| `src/vscode/files.ts` | `FileSource` over `workspace.fs`, `workspace.findFiles` and open text documents; `readUserConfig(name)` reads `~/.npmrc`, `~/.yarnrc`, `~/.yarnrc.yml` and Bun's `.bunfig.toml` with `fs/promises` |
| `src/vscode/store.ts` | `globalState` as `KeyValueStore` (not added to `setKeysForSync`) |
| `src/vscode/secrets.ts` | `ApiKeyStore`: `get()`, `set(key)`, `clear()`, `onDidChange` over `context.secrets` under the key `semverity.apiKey`; implements `SecretSource` |
| `src/vscode/logger.ts` | `LogOutputChannel` named "Semverity" as `Logger` |
| `src/vscode/convert.ts` | `TextRange` to and from `vscode.Range` |
| `src/vscode/documents.ts` | `DocumentTracker`: watches open and visible documents of the supported selectors, debounces edits (`editDebounceMs`), keeps the latest `DocumentAnalysis` per URI and version, requests lookups for visible documents, refreshes the surfaces on `onDidUpdate` |
| `src/vscode/watchers.ts` | `FileSystemWatcher`s for manifests, lockfiles, `.npmrc`, `tsconfig.json`, `jsconfig.json`, `go.work`, and for created `*.py` files, that call `core.workspace.fileChanged(uri)` (a new local Python module fires one coalesced `onDidChange`) |
| `src/vscode/goEnv.ts` | Reads the `go env -w` file (`$GOENV` or `os.UserConfigDir()/go/env`, at most 64 KiB) for `toCoreOptions`; only `GOPRIVATE`, `GONOPROXY` and `GONOSUMDB` are kept |
| `src/vscode/decorations.ts` | one `TextEditorDecorationType` per grade (after-text coloured with the grade's `ThemeColor`, before-icon a shield SVG data URI per grade and theme kind) |
| `src/vscode/hover.ts` | `HoverProvider` (async; fetches the listing on hover when the result has none) |
| `src/vscode/diagnostics.ts` | `DiagnosticCollection("semverity")` for open documents and, after a workspace check, for manifests |
| `src/vscode/codeActions.ts` | `CodeActionProvider` (`QuickFix`) for Semverity diagnostics |
| `src/vscode/statusBar.ts` | the status bar item |
| `src/vscode/tree.ts` | `TreeDataProvider` for the view `semverity.dependencies` |
| `src/vscode/commands.ts` | command registrations (section 9.3) |
| `src/extension.ts` | `activate` and `deactivate`: settings, adapters, `createCore`, providers, listeners |

## 4. API calls

Base URL: setting `semverity.api.baseUrl` (default `https://api.semverity.dev`, application scope so a workspace cannot redirect it). The client sets these headers on every request:

| Header | Value |
|---|---|
| `Accept` | `application/json` |
| `User-Agent` | `semverity-vscode/<extension version>` |
| `Content-Type` | `application/json` (POST only) |
| `Authorization` | `Bearer <key>` only when an API key is stored and the base URL is `https:` (or `http:` on a loopback host, for local development) |
| `If-None-Match` | the stored ETag, on conditional GETs only |

The Node.js HTTP stack adds standard transport headers (`Host`, `Connection`, `Content-Length`, `Accept-Encoding`, `Accept-Language: *`, `Sec-Fetch-Mode: cors`) that carry nothing about the user, the code or the workspace. When VS Code is configured with an HTTP proxy, requests go through it. No cookies, no editor or machine identifiers, no workspace or repository names.

### 4.1 `POST /v1/packages:batch` (cards for versions)

Request body: `{"purls": ["pkg:npm/lodash@4.18.1", "pkg:pypi/pyyaml@6.0.3", "pkg:golang/github.com/stretchr/testify@v1.12.1"]}`. Purls come from `toPurl()` (npm scope `@` percent-encoded; PyPI names PEP 503 normalised, because `PyYAML` is `404` while `pyyaml` is indexed; Go versions keep the `v`).

Limits: signed out at most 50 purls per request and each purl costs one token of the per-address allowance (60 per minute, burst 30 by default); signed in at most 500 per request against the key's 600 lookups per hour. The client sends at most 25 purls per request signed out and at most 100 signed in.

`?wait=` is never used (it holds a server worker for up to 30 s); pending purls are polled instead.

Response `200` (signed out, always `200`; `Cache-Control: no-store`):

```json
{
  "cards": [{ "purl": "pkg:npm/lodash@4.18.1", "ecosystem": "npm", "name": "lodash", "version": "4.18.1",
              "resolution": "public", "overall": 82.76, "coverage": 79.15,
              "security_score": {"score": 87, "grade": "B", "scored": true, "coverage": 1},
              "gates": [{"id": "malware", "fired": false, "hard": true, "immutable": true},
                        {"id": "no_provenance", "fired": true, "hard": false, "immutable": false,
                         "reason": "no verified build provenance"}],
              "flags": ["no_build_provenance"], "notes": ["Community and bus factor: only 35% of the evidence available"],
              "license": "MIT", "scoring_version": 1, "evaluated_at": "2026-09-29T02:39:53Z",
              "detail": "full", "source": "index",
              "headline": {"score": 82.8, "grade": "B", "basis": "own", "context": "registry",
                           "state": "not_collected", "at_most": true},
              "own": {"score": 82.76, "grade": "B"} }],
  "invalid": ["not-a-purl"],
  "not_indexed": ["pkg:npm/lodash@4.17.21"]
}
```

Signed in, the status is `202` with `Retry-After` when some purls are being collected, and `pending[]` lists them as `{purl, status: "collecting", status_url, retry_after_seconds}`; `not_indexed` is absent and an unknown purl is collected instead of refused.

Matching answers to requests: cards are matched by `coordinateKey(fromPurl(card.purl))`, never by position; `not_indexed`, `invalid` and `pending` entries are matched by parsing the purl the same way (the server canonicalises, so `@types` comes back as `%40types`). A requested purl that appears nowhere in the answer is treated as `not_indexed` with the negative lifetime.

Notes on fields: `coverage` on the card is a percentage (79.15); `security_score.coverage` is a fraction (1); `headline` is omitted when the own score is unknown; `with_dependencies` is present only when a graph is stored.

### 4.2 `GET /v1/packages/{ecosystem}/{name}` (listing: latest and healthy)

Path from `listingPath()`: the name is raw (`/v1/packages/npm/@types/node`, `/v1/packages/golang/github.com/stretchr/testify`); a name with a `versions` segment gets a trailing `/versions`.

Response `200` with `Cache-Control: public, max-age=300, stale-while-revalidate=600` and a strong `ETag`:

```json
{"ecosystem": "npm", "name": "lodash", "purl": "pkg:npm/lodash",
 "latest": "4.18.1", "healthy": "4.18.1", "strategy": "healthy", "source": "index",
 "headline": {"score": 82.8, "grade": "B", "basis": "own", "context": "registry", "state": "not_collected", "at_most": true},
 "own": {"score": 82.8, "grade": "B"},
 "versions": [{"version": "4.18.1", "purl": "pkg:npm/lodash@4.18.1", "overall": 82.8,
               "security_score": {"score": 87, "grade": "B", "scored": true},
               "fired_gates": ["no_provenance"], "published_at": "2026-04-01T21:01:20Z",
               "headline": {"score": 82.8, "grade": "B", "...": "..."}, "own": {"score": 82.8, "grade": "B"}},
              {"version": "0.1.0", "purl": "pkg:npm/lodash@0.1.0", "published_at": "2012-04-23T16:37:12Z"}]}
```

Every published version is listed; only scored versions carry scores. Used for: `latest` targets (the latest version), `range` targets (all listed versions feed `pickVersion`), the healthy pick (hover, diagnostics, quick fix), and the "latest scored" hint when a pinned version is not indexed. `304` on a matching `If-None-Match` refreshes the stored entry's lifetime. Signed out, an unknown name is `404` `{"code": "not_indexed", ...}` with `Cache-Control: public, max-age=60`. Signed in, an unknown npm, PyPI or Go name is `202` with `Retry-After` and a `Pending` body (collected on demand).

### 4.3 `GET /v1/packages/{ecosystem}/{name}/versions/{version}` (one card, conditional)

Path from `cardPath()` (`?version=` form for names with a `versions` segment). Same `Cache-Control` and `ETag` as the listing; `404 not_indexed` signed out; `202` with `Pending` when collecting signed in. Used instead of a batch when exactly one card is needed (one new import typed) and to revalidate a single card that has an ETag. Cards fetched by batch have no ETag and are revalidated by batch.

### 4.4 Status handling (client and lookup service)

| Status | Meaning | Handling |
|---|---|---|
| `200` | answer | store; lifetime per section 5.1 |
| `202` | collecting (signed in) | `pending` result; poll after `max(Retry-After, retry_after_seconds, 5 s)`, at most 6 polls per target per session, then keep `pending` until the next explicit request |
| `304` | not modified | keep the stored value, renew its lifetime and `validatedAt` |
| `400` | malformed or over the batch cap | a batch is split in half and retried once per half; a single purl becomes `not_scored` with reason `invalid` |
| `401` | key refused | stop sending the key for the session, status `unauthorized`, retry the request once signed out; the ui warns once and offers "Set API Key" |
| `403` | key not allowed (for example `installation_suspended`) | same as `401` |
| `404` | `not_indexed` (signed out) or `not_found` | `not_scored` with the negative lifetime |
| `413` | body too large | split as for `400` |
| `429` | rate limited | pause every request until `Retry-After` (default 60 s when absent); status `rate_limited`; queued targets wait |
| `503` | busy (`Retry-After: 2`) or store down | pause until `Retry-After`; exponential backoff from 5 s when repeated |
| other `5xx` | server error | backoff 5 s, 10 s, 20 s ... capped at 5 min; results become `error` only when nothing is cached |
| network error or timeout (15 s) | offline | status `offline`; retry after 15 s doubling to 10 min; cached answers keep being shown, marked stale per 5.1 |

The `ErrorResponse` body (`{code, message, request_id}`) is logged at debug level with the request path; the path holds only the coordinate.

## 5. Network discipline

### 5.1 Lifetimes and staleness

Each cache entry stores `{ value, validatedAt, freshUntil, etag?, negative, lastFailureAt? }`.

- Fresh lifetime of a positive answer: the response's `Cache-Control: max-age` when present, else `semverity.cache.ttlHours` (default 24 h). Batch answers are `no-store` for shared caches and carry no max-age, so their cards live for the TTL; the extension cache is an application cache of public scores that the registry refreshes at most daily, and the README says so.
- A floor of 15 minutes applies to every lifetime (the 300 s max-age of GETs would otherwise re-validate a file's listings every five minutes while it is open). This lengthens freshness only for the local cache and never serves a different answer than the server last gave.
- Negative answers (`not_indexed`, `not_found`, a purl missing from a batch answer): `max(max-age, semverity.cache.negativeTtlMinutes)` (default 60 min). Setting or clearing the API key drops every negative entry, since a key changes what is found.
- Past `freshUntil` an entry is still served (stale-while-revalidate) and a revalidation is queued at background priority (conditional GET when an ETag is stored, else a batch).
- An entry is shown as stale when `now - validatedAt > ttl` (it could not be rechecked for a whole TTL) or when it is past `freshUntil` and the last attempt failed (`lastFailureAt > validatedAt`). Stale answers keep their diagnostics, with "(cached)" in the message.
- With `semverity.network.enabled` off nothing is requested; cached answers are shown and become stale by the rules above; targets with no cache get `{ state: "disabled" }`.

### 5.2 Score cache

- Memory: `Map<string, Entry>` keyed `card:<coordinateKey>` and `list:<packageKey>`.
- Persistent: `globalState` key `semverity.cache.v1:<sha256(apiBaseUrl) first 12 hex>` holding `{ schema: 1, entries: [key, Entry][] }`, written at most every 5 s after a change and on deactivate; LRU eviction at 3,000 entries; an unreadable or other-schema value is dropped. Stored cards are `CardSummary` (sub-signals, sources and unfired gates removed), so an entry stays under about 1 KB.
- `clear()` empties both; `invalidate(ids)` drops the entries of those packages.

### 5.3 Scheduling and rate limits

- Edits: the ui debounces a document `editDebounceMs` (default 600 ms) after the last change before re-analysing it. Opening or revealing a document analyses it at once.
- Coalescing: `request()` queues targets; the service flushes the queue 150 ms after the first enqueue, so a whole file's imports become one batch. Duplicate targets and targets already in flight are merged.
- Priority: `visible` targets (documents in visible editors) go before `background` ones (workspace check, revalidation).
- Plan per flush: `latest` and `range` targets first need their listing (one GET each, conditional when an ETag is stored), which turns them into concrete coordinates; concrete coordinates missing or due in the cache go into batches (one `GET` card instead when exactly one is due).
- A latest or range target needs its listing (one GET per package) before its card can be batched. The listing carries the headline, own score and fired gate ids of latest, healthy and the newest scored version, so once it is cached `peek` answers such a target from the listing entry (`cardFromListing`, `CardSummary.fromListing`, never persisted); its card is then fetched at background priority (it rides along with the next batch), unless a hover waits for it (`resolve(..., { full: true })`). Missing listings of visible targets are fetched before revalidations.
- Two token buckets bound the traffic: requests (`semverity.network.maxRequestsPerMinute`, default 60, burst 10) and purls (signed out 60 per minute with a burst of 25, matching the server's per-address allowance; signed in 10 per minute with a burst of 100, matching 600 per hour). A batch of n purls takes one request token and n purl tokens; a GET takes one of each. When a bucket is empty the flush waits.
- One request in flight at a time (the server admits few signed-out requests per process); 429 and 503 pause the whole queue.
- A workspace check of 150 uncached dependencies therefore takes about 2.5 minutes signed out; the progress notification shows done and total, and cached answers appear at once.

## 6. Privacy

### 6.1 What is sent, and to whom

Only package coordinates: ecosystem, package name and version, as purls in a batch body or as segments of a GET path, to the configured API base URL (default `https://api.semverity.dev`, operated by Semverity), plus the headers in section 4. Never sent: source code, import statements, file names or paths, manifest or lockfile contents, repository, workspace or folder names, user or machine identifiers, editor version, settings. There is no telemetry of any kind, and the extension does not use the VS Code telemetry API. Package page links open `https://semverity.dev/registry/...` in the browser only when the user clicks them.

With an API key, the API may collect a package version that is not yet indexed and keep it watched (registry behaviour described in the API documentation); the README states this.

### 6.2 The privacy filter

The filter runs after mapping and before anything is queued. The first rule that matches excludes the package, and the rule is recorded for the hover ("Not looked up: matches `@acme/*`"); excluded packages are decorated as "excluded" in the muted colour when `showUnscored` is on and never reach the lookup service.

1. `semverity.privacy.excludePatterns`: user, workspace and folder values are unioned (a workspace can add exclusions, never remove the user's). Syntax: optional `npm:`, `pypi:` or `golang:` prefix, then a glob where `*` matches any run of characters (including `/`) and `?` one character; PyPI patterns are compared after PEP 503 normalisation, npm and Go patterns case-sensitively.
2. npm registry configuration (on by default, `semverity.privacy.excludeNpmrcScopes`): every scope and default registry binding in `.npmrc`, `.yarnrc`, `.yarnrc.yml` and `bunfig.toml` from the file's directory up to the workspace root and in the home directory, plus `NPM_CONFIG_REGISTRY`, `YARN_NPM_REGISTRY_SERVER` and `BUN_CONFIG_REGISTRY`. All bindings are kept (the installing tool is unknown); a scope with any binding whose host is not `registry.npmjs.org`, `registry.yarnpkg.com` or in `semverity.privacy.trustedRegistryHosts` is refused, and with a non-public default registry an unscoped (or not publicly bound) package is refused unless the lockfile names its host. Only registry URLs are read; tokens and other settings are never stored or logged.
3. Lockfile sources: an npm package whose lockfile `resolved` URL, or a PyPI package whose `poetry.lock`, `pdm.lock` or `uv.lock` source, names a host other than the public registry (`registry.npmjs.org`, `registry.yarnpkg.com`; `pypi.org`, `files.pythonhosted.org`) or a trusted host.
4. Python indexes with a non-public, untrusted host: every package of a requirements file that sets `--index-url`, `-i`, `--extra-index-url` or `--find-links`, or of a `pyproject.toml` with uv, Poetry or PDM indexes (explicit indexes only affect the dependencies pinned to them, which are non-registry); undeclared imports when any workspace Python manifest names such an index; every PyPI package when `PIP_INDEX_URL`, `PIP_EXTRA_INDEX_URL`, `PIP_FIND_LINKS`, `UV_INDEX_URL`, `UV_EXTRA_INDEX_URL`, `UV_DEFAULT_INDEX`, `UV_INDEX` or the user or site `pip.conf`/`pip.ini`/`uv.toml` names one.
5. Go: module paths matching `GOPRIVATE`, `GONOPROXY` or `GONOSUMDB` from the extension host environment and from the `go env -w` file, both honoured (Go's own glob semantics), and modules replaced by a local path.
6. Local and non-registry code (resolver skips, never sent): relative imports, aliases (tsconfig `paths` and `baseUrl` entries, `package.json` `imports`, `@/` and `~/`), the workspace's own package names (every `package.json` `name`, `pyproject.toml` `[project].name`, `go.mod` `module`), monorepo workspace packages, `workspace:`, `file:`, `link:`, git and URL specs, editable and path requirements, Python modules that exist in the workspace (a `.py` file, a package, or any directory between a workspace folder and a `.py` file, unless a manifest declares that name), Go imports under the main module.
7. `semverity.privacy.lookupUndeclaredImports` off: imports that no manifest declares are not looked up.

`semverity.network.enabled` off sends nothing at all. It and the `semverity.ecosystems.*` switches are read with `inspect()`: false at the user, workspace or folder level wins, so a workspace can narrow but never widen what the user turned off. In an untrusted workspace the workspace values of `semverity.network.enabled`, `semverity.ecosystems.*`, `semverity.privacy.excludeNpmrcScopes` and `semverity.privacy.lookupUndeclaredImports` are ignored (`restrictedConfigurations`); the base URLs and trusted hosts are application scope and cannot be set by a workspace at all.

### 6.3 The API key

Stored only in `SecretStorage` under `semverity.apiKey`; set with "Semverity: Set API Key" (password input; the value is trimmed and must look like `svk_` followed by 40 characters, with a confirm prompt for other shapes) and removed with "Semverity: Clear API Key". It is read when a request is built and never written to settings, the cache, logs or error messages. The logger never receives headers. The key is sent only to the configured API base URL over `https:` (or loopback `http:`).

## 7. Import to package mapping

### 7.1 JavaScript and TypeScript (npm)

Languages: `javascript`, `javascriptreact`, `typescript`, `typescriptreact` (covers `.js .mjs .cjs .jsx .ts .mts .cts .tsx`). Documents over 1 MB are skipped.

Parsing (`parseJsImports`): comments are masked first (strings and template literals are respected while masking), then these forms are matched with the specifier's exact range (without quotes):

- `import x from "a"`, `import { a, b as c } from "a"`, `import * as a from "a"`, `import "a"`, `import type { T } from "a"`, `import x, { y } from "a"` (multi-line forms included)
- `export * from "a"`, `export * as ns from "a"`, `export { a } from "a"`, `export type { T } from "a"`
- `require("a")`, `require.resolve("a")`, `import("a")` with a single string literal argument (template literals without `${}` count)
- `import x = require("a")` (TypeScript)

Strings that merely contain these words are not matched (they are masked like comments when not in an import position: the matcher only reads string literals that follow the keywords).

Mapping (`npmPackageFor`):

| Specifier | Result |
|---|---|
| `./x`, `../x`, `/x`, `file:` URLs | skip `relative` |
| `node:fs`, `fs`, `fs/promises`, any name in `NODE_BUILTINS` | skip `builtin` |
| other `scheme:` specifiers (`bun:`, `deno:`, `cloudflare:`, `virtual:`, `data:`, `http(s):`, `jsr:`) | skip `builtin` (`npm:name@range` maps to `name`) |
| `#x` (package.json `imports`) | skip `alias` |
| matches a tsconfig or jsconfig `paths` pattern of the nearest config, or whose first segment exists under its `baseUrl` | skip `alias` |
| `@/x`, `~/x`, `~x` | skip `alias` |
| contains `!` (webpack loader syntax) | skip `unmapped` |
| `@scope/name/sub/path` | `@scope/name` |
| `name/sub/path` | `name` |
| not a valid npm name (lowercase rules relaxed for old packages; no spaces, at most 214 characters) | skip `unmapped` |
| a workspace package name or the nearest `package.json` `name` | skip `self` |

### 7.2 Python (PyPI)

Language: `python`. Parsing (`parsePythonImports`) tracks strings (single, double, triple quoted, prefixes such as `r`, `b`, `f`) and comments, joins backslash continuations and parenthesised `from x import (...)` lists, and splits on `;`. Matched: `import a`, `import a.b.c as d, e`, `from a.b import c` (the imported names are kept as `ImportRef.names`), `from a import (x, y)`, indented imports (inside functions, `try`, `if TYPE_CHECKING:`), and `importlib.import_module("a.b")` / `__import__("a")` with a literal. `from . import x` and `from .a import b` are relative. The range is the dotted module name as written.

Mapping (`pythonDistributionFor`):

1. Relative imports: skip `relative`. `__future__` and any top-level name in `PYTHON_STDLIB`: skip `builtin`.
2. The top-level name is a module or package inside the workspace (a `<name>.py` file or a `<name>/__init__.py` directory anywhere under the roots, excluding virtual environments, `site-packages`, `node_modules`, `build`, `dist`, `.tox`, `.nox`): skip `local-module`. A directory between a workspace folder and a `.py` file (a PEP 420 namespace package, a `src` layout, a `scripts` folder) is local too, unless a manifest declares a distribution of that name.
3. From-imports try the imported names first: `from google.cloud import storage` maps `google.cloud.storage` (the table, then a declared `google-cloud-storage`), so namespace packages map to the right project.
4. Candidates: the curated table (`PYTHON_IMPORT_TO_DIST`) by the longest dotted prefix of the import (`google.cloud.storage` before `google`); declared distributions (every requirements file, `pyproject.toml` dependency list and lockfile in the workspace) disambiguate: the first candidate that is declared wins (`cv2` resolves to `opencv-python-headless` when that is what the requirements declare), then a declared dashed name (`google.cloud.run` as `google-cloud-run`), then the declared top-level name; otherwise the table's first candidate, marked undeclared.
5. Nothing matched: a namespace root (`PYTHON_NAMESPACE_ROOTS`: `google`, `google.cloud`, `azure`, `azure.mgmt`, `backports`, `jaraco`, `zope`, `sphinxcontrib` and a few more) is skipped as `unmapped`; any other name falls back to its top-level name, marked undeclared.
6. The workspace's own project name: skip `self`.

The curated table holds at least these (import, then distributions in preference order):

`yaml` PyYAML; `cv2` opencv-python, opencv-python-headless, opencv-contrib-python, opencv-contrib-python-headless; `sklearn` scikit-learn; `skimage` scikit-image; `PIL` Pillow; `bs4` beautifulsoup4; `dateutil` python-dateutil; `dotenv` python-dotenv; `jwt` PyJWT; `jose` python-jose; `magic` python-magic; `serial` pyserial; `usb` pyusb; `zmq` pyzmq; `Crypto` pycryptodome, pycrypto; `Cryptodome` pycryptodomex; `OpenSSL` pyOpenSSL; `nacl` PyNaCl; `attr` attrs; `pkg_resources` setuptools; `setuptools` setuptools; `MySQLdb` mysqlclient; `psycopg2` psycopg2, psycopg2-binary; `psycopg` psycopg; `docx` python-docx; `pptx` python-pptx; `fitz` PyMuPDF; `git` GitPython; `github` PyGithub; `gitlab` python-gitlab; `telegram` python-telegram-bot; `discord` discord.py; `slugify` python-slugify; `multipart` python-multipart; `gi` PyGObject; `wx` wxPython; `ldap` python-ldap; `Levenshtein` Levenshtein, python-Levenshtein; `markdown` Markdown; `win32api`, `win32con`, `win32com`, `pythoncom`, `pywintypes` pywin32; `google.protobuf` protobuf; `google.cloud.storage` google-cloud-storage; `google.cloud.bigquery` google-cloud-bigquery; `google.cloud.pubsub` google-cloud-pubsub; `google.auth` google-auth; `googleapiclient` google-api-python-client; `grpc` grpcio; `kafka` kafka-python; `redis` redis; `snappy` python-snappy; `lz4` lz4; `Bio` biopython; `mpl_toolkits` matplotlib; `tensorflow` tensorflow; `torch` torch; `huggingface_hub` huggingface-hub; `sentence_transformers` sentence-transformers; `faiss` faiss-cpu, faiss-gpu; `umap` umap-learn; `dns` dnspython; `socks` PySocks; `websocket` websocket-client; `consul` python-consul; `etcd3` etcd3; `ruamel` ruamel.yaml; `xdist` pytest-xdist; `pytest_asyncio` pytest-asyncio; `typing_extensions` typing-extensions; `pydantic_settings` pydantic-settings; `sqlalchemy` SQLAlchemy; `flask_sqlalchemy` Flask-SQLAlchemy; `flask_cors` Flask-Cors; `flask_login` Flask-Login; `rest_framework` djangorestframework; `corsheaders` django-cors-headers; `debug_toolbar` django-debug-toolbar; `environ` django-environ; `storages` django-storages; `crispy_forms` django-crispy-forms; `celery` celery; `kombu` kombu; `boto3` boto3; `botocore` botocore; `azure.storage.blob` azure-storage-blob; `azure.identity` azure-identity; `msal` msal; `win32` pywin32; `pyximport` Cython; `Cython` Cython; `OpenGL` PyOpenGL; `pygame` pygame; `xlrd` xlrd; `openpyxl` openpyxl; `lxml` lxml; `jinja2` Jinja2; `markupsafe` MarkupSafe; `itsdangerous` itsdangerous; `werkzeug` Werkzeug; `click` click; `tomli` tomli; `toml` toml; `simplejson` simplejson; `ujson` ujson; `orjson` orjson; `msgpack` msgpack; `pexpect` pexpect; `ptyprocess` ptyprocess; `paramiko` paramiko; `fabric` fabric; `invoke` invoke; `nmap` python-nmap; `scapy` scapy; `shapely` shapely; `osgeo` GDAL; `pyproj` pyproj; `geopandas` geopandas; `community` python-louvain; `igraph` igraph; `cairo` pycairo; `apt` python-apt; `dbus` dbus-python; `smbus` smbus; `RPi` RPi.GPIO; `Xlib` python-xlib; `pyudev` pyudev; `ffmpeg` ffmpeg-python; `speech_recognition` SpeechRecognition; `sounddevice` sounddevice; `soundfile` soundfile; `vlc` python-vlc; `pyaudio` PyAudio.

Names whose import and distribution differ only by case, `_` versus `-` or `.` need no entry, because PEP 503 normalisation already maps them.

### 7.3 Go (modules)

Language: `go`. Parsing (`parseGoImports`): comments masked; `import "p"`, `import name "p"`, `import _ "p"`, `import . "p"` and grouped `import ( ... )` blocks, with double-quoted or back-quoted paths. The range is the path text.

Mapping (`goModuleFor`):

1. Standard library: the first path element has no dot (`fmt`, `net/http`, `golang.org/x` is not stdlib because `golang.org` has a dot), or the path is `C`: skip `builtin`.
2. Under the main module (`module` of the nearest `go.mod`, or any module of `go.work`): skip `self`.
3. The longest module path among the nearest `go.mod`'s `require` lines (and `replace` targets) that equals the import path or prefixes it at a `/` boundary wins (`github.com/aws/aws-sdk-go-v2/service/s3` matches `github.com/aws/aws-sdk-go-v2/service/s3` before `github.com/aws/aws-sdk-go-v2`).
4. A `replace` to a local path: skip `non-registry`. A `replace` to another module: look up the replacement module and version.
5. No match and `lookupUndeclaredImports` on: well-known hosts only (`github.com`, `gitlab.com`, `bitbucket.org` take three elements plus a `/vN` element when the fourth is a major version suffix; `golang.org/x/<name>`; `google.golang.org/<name>`; `go.uber.org/<name>`; `k8s.io/<name>`; `sigs.k8s.io/<name>`; `gopkg.in/<name>.vN` and `gopkg.in/<user>/<name>.vN`); anything else: skip `unmapped`.

## 8. Version resolution

Order for a mapped package, per workspace folder (monorepo aware):

1. Lockfile: the nearest lockfile from the document's directory up to the root. npm: `package-lock.json` (v2 and v3 `packages`, preferring the importer's nested `node_modules` path, then the hoisted one; v1 `dependencies`), `pnpm-lock.yaml` (v6 and v9 `importers[<dir>]`, peer suffixes such as `(react@18.3.1)` removed), `yarn.lock` (v1 and Berry; the entry whose key lists the declared range, else the highest version for the name), `bun.lock` (text). When several exist in one directory: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`. PyPI: `poetry.lock`, `uv.lock`, `pdm.lock`, `Pipfile.lock`. Go: `go.mod` versions are already exact (no lockfile step). Source `lockfile`.
2. Exact manifest version: npm `"1.2.3"` or `"=1.2.3"`, PyPI `==1.2.3` or `===1.2.3`, Go any `require` version (including pseudo-versions and `+incompatible`). Source `manifest`.
3. Range: npm ranges (`^`, `~`, `>=`, `x`, `||`, hyphen ranges) through `semver.maxSatisfying` over the listing's versions, excluding prereleases unless the range names one; PyPI specifiers through `satisfiesPep440`; poetry `^` and `~` are translated to PEP 440 bounds. Source `range`. The listing is fetched by the lookup service, not the resolver.
4. Nothing local: `latest` from the listing. Source `latest`.

npm aliases (`"x": "npm:real@^1"`) look up `real`. Imports in source files take the version of the nearest manifest that declares the package (and its lockfile); an undeclared import is `latest`.

## 9. User interface

### 9.1 Activation and document selectors

Activation events (in `package.json`): `onLanguage` for `javascript`, `javascriptreact`, `typescript`, `typescriptreact`, `python`, `go`, `pip-requirements`, `go.mod`, and `workspaceContains` for `**/package.json`, `**/requirements*.txt`, `**/pyproject.toml`, `**/go.mod`. Commands and the view activate implicitly.

Document selectors: the six languages with `scheme: "file"` and `scheme: "untitled"`, plus the patterns `**/package.json`, `**/requirements*.txt`, `**/pyproject.toml`, `**/go.mod` (any language id, since `pip-requirements` and `go.mod` exist only with other extensions installed). Files under `node_modules`, `.venv`, `venv`, `site-packages` and `vendor` are ignored.

### 9.2 Settings

| Key | Type, default | Scope | Effect |
|---|---|---|---|
| `semverity.network.enabled` | boolean, `true` | restricted in untrusted workspaces; off at any level wins | global switch for lookups |
| `semverity.api.baseUrl` | string, `https://api.semverity.dev` | application | API base URL |
| `semverity.site.baseUrl` | string, `https://semverity.dev` | application | package page links |
| `semverity.ecosystems.npm` / `.pypi` / `.golang` | boolean, `true` | restricted in untrusted workspaces; off at any level wins | ecosystems on and off |
| `semverity.decorations.enabled` | boolean, `true` | resource | inline decorations |
| `semverity.decorations.showUnscored` | boolean, `true` | resource | also decorate not scored, pending and excluded |
| `semverity.hovers.enabled` | boolean, `true` | resource | hover card |
| `semverity.diagnostics.enabled` | boolean, `true` | resource | Problems entries |
| `semverity.diagnostics.scoreBasis` | `headline` or `own`, `headline` | resource | which score the thresholds read |
| `semverity.diagnostics.warningBelow` | number, `65` (0 turns off) | resource | warning threshold |
| `semverity.diagnostics.errorBelow` | number, `0` (off) | resource | error threshold |
| `semverity.diagnostics.gates` | gate ids, see package.json | resource | gates that warn; malware and KEV always error |
| `semverity.privacy.excludePatterns` | string array, `[]` | resource, unioned across levels | never sent |
| `semverity.privacy.excludeNpmrcScopes` | boolean, `true` | restricted | `.npmrc` scope rule |
| `semverity.privacy.trustedRegistryHosts` | string array, `[]` | application | mirrors treated as public |
| `semverity.privacy.lookupUndeclaredImports` | boolean, `true` | restricted | undeclared imports looked up at latest |
| `semverity.cache.ttlHours` | number, `24` | resource | default lifetime and stale age |
| `semverity.cache.negativeTtlMinutes` | number, `60` | resource | not-scored lifetime |
| `semverity.network.maxRequestsPerMinute` | number, `60` (1..60) | resource | request bucket |
| `semverity.editDebounceMs` | number, `600` | resource | edit debounce |
| `semverity.statusBar.enabled` | boolean, `true` | resource | status bar item |

A configuration change re-reads the settings, calls `core.updateOptions`, and refreshes every surface; a change of `api.baseUrl` switches the persistent cache partition.

### 9.3 Commands

| Command | Title | Behaviour |
|---|---|---|
| `semverity.checkWorkspace` | Semverity: Check Workspace Dependencies | `workspace.rebuild()`, look up every declared dependency of every manifest (at most 2,000, deduplicated) at background priority with a cancellable progress notification ("n of m"), fill the tree, publish manifest diagnostics, update the status bar |
| `semverity.openPackagePage` | Semverity: Open Package Page | argument `{ecosystem, name, version?}` (tree, hover, code action); without one, the entry on the cursor line, else a quick pick of the active document's packages; opens `packagePageUrl()` with `env.openExternal` |
| `semverity.refresh` | Semverity: Refresh Scores | invalidates the packages of visible documents (and the tree's, when filled) and looks them up again |
| `semverity.clearCache` | Semverity: Clear Cached Scores | `lookups.clear()` |
| `semverity.setApiKey` | Semverity: Set API Key | password input box, stores in SecretStorage, drops negative cache entries |
| `semverity.clearApiKey` | Semverity: Clear API Key | deletes it, drops negative cache entries |
| `semverity.toggleLookups` | Semverity: Turn Network Lookups On or Off | flips `semverity.network.enabled` at the user level |
| `semverity.showLog` | Semverity: Show Log | reveals the log channel |
| `semverity.applyVersion` | (hidden from the palette) | argument `{id}`, an opaque id of an edit the hover registered (`src/vscode/pendingEdits.ts`); the edit is recomputed against the manifest's current text and applied only to a manifest inside a workspace folder (used by the hover link; quick fixes carry their own `WorkspaceEdit`) |

### 9.4 Inline decoration

One decoration per line that has at least one entry, rendered after the end of the line (margin-left `1.5em`): a `before` icon (a 12 px shield SVG data URI in the grade colour for the current theme kind) and `after` text in the grade's `ThemeColor`.

| Result | Text | Colour |
|---|---|---|
| scored, complete headline | `83 B` | grade |
| scored, `at_most` | `≤83 B` | grade |
| scored, stale | `83 B (cached)` | grade |
| fired hard gate other than malware and KEV | `74 C · 1 gate` (n gates) | grade |
| malware (own, or inherited on an installed path) | `malware` | `semverity.gradeF` |
| KEV (own or inherited installed) | `KEV · 25 F` | `semverity.gradeF` |
| not scored | `not scored` | `semverity.unscored` (only with `showUnscored`) |
| pending, or queued without a cached answer | `scoring…` | unscored |
| excluded by the privacy filter | `excluded` | unscored |
| skipped (builtin, relative, alias, local, self), disabled, offline, error | nothing | |

Scores are rounded to integers. Several entries on one line (`import os, yaml, requests`, a Go block line is one entry) list each scored package as `name 83 B` joined with ` · `, coloured by the worst grade. At most 500 decorations per editor.

### 9.5 Hover

Shown over an entry's range (import specifier or manifest dependency name and version). Markdown with theme icons; each surface is trusted only for the commands it emits (hover: `semverity.applyVersion` and `semverity.setApiKey`; tree tooltip: `semverity.setApiKey`; status bar: `semverity.checkWorkspace` and `semverity.toggleLookups`). Text from the API or the workspace never keeps its own Markdown: it is escaped, and single-backtick code spans are re-emitted through `code()`, which picks a fence longer than any backtick run inside; exclusion rules are structured data whose patterns render as code spans. Template for a scored result:

```
$(shield) **lodash** 4.17.21 · npm · locked version (package-lock.json)

**74 C** with dependencies · at most, 82% of dependencies scored
Own score **80 B** · Security **B** (87) · Evidence coverage 91%

**Gates**
$(error) Known exploited vulnerability (KEV): <reason>
$(warning) High severity advisory with a fix: <reason>. <recommendation>
$(info) No build provenance

**Why the score is low**
- Weakest dependency: `minimist` 1.2.0 (own 41), 12.3 points
- Lowest areas: Community 40, Best practices 52
- Community and bus factor: only 35% of the evidence available

**Healthy version:** 4.18.1 (83 B) · [Use 4.18.1](command:semverity.applyVersion?...)

[Open on semverity.dev](https://semverity.dev/registry/npm/lodash/versions/4.17.21) · scored 2026-09-29 · checked 3 h ago
```

Rules: the headline line says "with dependencies" for basis `with_dependencies` and "own score only, dependencies not scored yet" for basis `own`; the coverage clause appears only when `at_most` is true and `coverage` is present. Gates list hard gates first (`$(error)` for malware and KEV, `$(warning)` for other hard gates and `unfixed_high_vuln`), then soft gates (`$(info)`), each with the server's `reason` and `recommendation` when present; inherited malware and KEV gates read "pulls in a package with a malware finding (depth 2)". "Why the score is low" appears when the basis score is below 80 or a hard gate fired: up to two `weakest` contributions (kind `weakest` or `gate`), the two lowest dimensions under 70, and up to two `notes`. The healthy line appears when the listing has `healthy` different from the version; the "Use" link appears only when the entry has `declaredIn` with a `specRange`. A stale answer ends with "cached, last checked 2 days ago". The version source label is one of "locked version (<lockfile name>)", "declared version", "newest known version matching `^4.17.0`", "latest version (not declared)".

Other states: not scored: "Semverity has not scored lodash 4.17.21 yet." plus "Latest scored version: 4.18.1 (83 B)" when the listing has it, plus, signed out, "With an API key, Semverity collects public packages it has not seen ([Set API Key](command:semverity.setApiKey))"; pending: "Semverity is scoring lodash 4.17.21; this updates by itself."; excluded: "Not looked up: <rule>. Nothing about this package was sent."; disabled: "Network lookups are off (`semverity.network.enabled`)."; offline or rate limited without a cache: "The Semverity API is not reachable; retrying at 14:32."; skipped entries have no hover.

### 9.6 Diagnostics

`diagnosticsFor(entry, result, settings)` produces at most three diagnostics per entry, all with source `Semverity`, the entry's range, and `code: { value, target: <package page URL> }`:

1. `malware` (error): the card's `malware` gate fired, or an inherited `malware` gate with `path_class: installed`. Message: "lodash 4.17.21 has a malware finding: <reason>" or "lodash 4.17.21 pulls in a package with a malware finding (depth 2)". Always reported while diagnostics are on, whatever the thresholds and gate list.
2. `kev` (error): the same for `kev`: "lodash 4.17.21 is affected by a known exploited vulnerability: <reason>". Combined with malware into one diagnostic when both fire.
3. `gate` (warning): other fired gates listed in `semverity.diagnostics.gates`, joined: "lodash 4.17.21: high severity advisory with a fix (bump to 4.18.0)".
4. `score` (error below `errorBelow`, else warning below `warningBelow`; a threshold of 0 is off): "lodash 4.17.21 scores 58 (D) with its dependencies, below 65" (basis `own`: "scores 58 (D) on its own").

Only `scored` results produce diagnostics; stale ones append " (cached)". Open documents get diagnostics on analysis; closing a document clears them; manifests get them from "Check Workspace" too.

### 9.7 Quick fixes

The `CodeActionProvider` (`CodeActionKind.QuickFix`) answers for diagnostics whose source is `Semverity`:

- "Bump lodash to 4.18.1 (Semverity healthy version)" (or "Change ... to" when the healthy version is lower): offered when the listing (fetched on demand, cached) has `healthy` different from the current version and the entry has `declaredIn` with a `specRange`. In a source file the edit goes to the declaring manifest. `isPreferred` for malware, KEV and gate diagnostics. Lockfiles are never edited; the action's title stays short and the README says to run the package manager afterwards.
- "Open lodash on semverity.dev" (always).

`rewriteSpec(kind, spec, version)`: npm keeps a single leading operator (`^`, `~`, `>=`, `=`, none) and replaces complex ranges (`||`, spaces, hyphen ranges, `x` wildcards) with `^<version>`; `npm:real@<range>` keeps the alias prefix. requirements and PEP 621 strings keep a single clause's operator (`==`, `===`, `~=`, `>=`) and replace multi-clause specifiers with `==<version>`. Poetry keeps `^`, `~`, `==` or a bare version, else `^<version>`. go.mod replaces the version token (the README notes `go mod tidy`).

### 9.8 Status bar

Right side, priority 100, shown while the active editor is a supported document (else the last workspace check summary, else hidden).

| Situation | Text | Background |
|---|---|---|
| file with scored entries | `$(shield) 12 deps · lowest 58 D` | warning when the lowest is below `warningBelow` |
| any malware or KEV | `$(error) 12 deps · KEV` (or `malware`) | error |
| fired warning gates | `$(warning) 12 deps · 2 gates · lowest 74 C` | warning |
| every answer in, none a score | `$(shield) 3 deps · none scored` | none |
| nothing scored yet | `$(shield) Semverity` | none |
| lookups off | `$(shield) Semverity off` | none |
| offline or rate limited | prefix `$(cloud-offline)` or `$(watch)`, scores from the cache | none |

Tooltip (markdown): counts per grade, not scored, pending, excluded; "Signed out: public index only" or "Signed in with an API key"; network state with retry time; links "Check Workspace" and "Turn lookups off". Click: focus the tree view, running "Check Workspace" when it is empty.

### 9.9 Tree view

View `semverity.dependencies` in the Explorer (welcome content offers "Check Workspace"). Root items: one per manifest, labelled with its workspace-relative path, description "12 dependencies · lowest 58 D", sorted by path. Children: dependencies sorted worst first (malware and KEV, then other gates, then ascending score, then not scored, then excluded); label the package name, description `4.17.21 · ≤74 C`, icon `ThemeIcon("shield", ThemeColor(grade colour))`, tooltip the hover markdown, `contextValue` `semverity.package` or `semverity.package.scored`, click reveals the dependency line in the manifest, inline action "Open Package Page". Grandchildren: fired gates (error, warning or info icon) and "Healthy version 4.18.1" when the listing is cached.

## 10. Test plan (vitest, no extension host)

Fixtures live in `test/fixtures/` (small, hand-written, no real private data). Helpers in `test/helpers/`: `FakeFetch` (scripted responses by method and path, records every request with headers and body), `FakeClock` (manual `advance(ms)` that runs due timers), `MemoryStore` (KeyValueStore), `MemoryFiles` (FileSource over a map of URI to text), `cards.ts` (builders for `PackageCard`, `CardSummary`, `LookupResult`).

Core (owner core):

- `parsers/javascript`: every form in 7.1, multi-line imports, imports in comments and strings ignored, template literal specifiers, exact ranges (line and character) on CRLF input.
- `parsers/python`: every form in 7.2, parenthesised and continued lines, semicolons, docstrings and comments ignored, relative imports, ranges.
- `parsers/go`: single, grouped, aliased, blank and dot imports, back-quoted paths, comments.
- `parsers/packageJson`, `requirements`, `pyproject`, `goMod`: names, specs, exact versions, ranges of name and spec, non-registry specs, `npm:` aliases, extras and markers, `-r` includes, index URLs, poetry tables and groups, PEP 735 groups, go.mod blocks, `// indirect`, replaces.
- `parsers/lockfiles`: package-lock v1 and v3 (nested versus hoisted), pnpm v6 and v9 with peer suffixes, yarn v1 and Berry, bun.lock, poetry, uv, pdm, Pipfile; `resolvedHost` for private hosts.
- `parsers/npmRegistries`: registry lines and keys only; tokens (`_authToken`, `npmAuthToken`, bunfig `token`) never appear in the result.
- `mapping/npm`: the table in 7.1 row by row. `mapping/python`: stdlib, the curated table including longest dotted prefix, disambiguation by declared requirements (`cv2` with `opencv-python-headless` declared), normalisation, local modules. `mapping/golang`: stdlib rule, longest module prefix, replaces, main module, well-known host guesses.
- `resolver/versions` and `pep440`: precedence lockfile, manifest, range, latest; `maxSatisfying` with prereleases; PEP 440 ordering (`1.0.dev1 < 1.0a1 < 1.0 < 1.0.post1`), `~=`, wildcards; Go pseudo-versions.
- `resolver/resolve`: end-to-end `analyze()` of fixture documents in a small fixture workspace (monorepo with two packages and a root lockfile, a Python project with requirements and a local package, a Go module with a replace).
- `privacy/filter`: each rule in 6.2, ordering, union of exclude patterns, case rules, GOPRIVATE globs, trusted hosts.
- `api/cacheControl`: max-age, stale-while-revalidate, no-store, Retry-After as seconds and as an HTTP date.
- `api/client` (with `FakeFetch`): request URL, method, headers (exactly the allowed set; `Authorization` only with a key and an https base), body contains only purls, matching cards by purl, `not_indexed`, `invalid`, `pending`, missing purls, 304 handling, every status in 4.4. A privacy test asserts that no request body or URL contains a fixture file path, a source line or a workspace name.
- `cache/scoreCache`: lifetimes and floor, negative lifetimes, stale rules, LRU eviction, persistence round trip, schema mismatch, base URL partition.
- `lookup/service` (with `FakeFetch` and `FakeClock`): coalescing within 150 ms into one batch, chunk sizes signed in and out, visible before background, listing first for latest and range targets, single-card GET for one target, conditional revalidation, 429 pause and resume at Retry-After, offline backoff and recovery, request and purl budgets never exceeded over a simulated ten minutes, pending polls capped at six, key dropped after 401 with a signed-out retry, network disabled sends nothing.

Presentation (owner ui):

- `decoration`: every row of the table in 9.4, several entries on one line, `showUnscored` off.
- `hover`: snapshot tests for a complete headline, an `at_most` headline, basis own, malware, KEV, gates with reasons, low score reasons, healthy with and without an apply link, stale, not scored (signed in and out), pending, excluded, disabled; links use `packagePageUrl()`.
- `diagnostics`: each rule in 9.6, thresholds at the boundary (65 is not below 65), basis switch, gate list filtering, malware and KEV regardless of the list and thresholds, inherited gates, stale suffix.
- `quickfix`: `rewriteSpec` for each manifest kind and operator, alias specs, multi-clause specifiers; `bumpEdit` ranges.
- `summary`: counts, lowest score, status bar text and severity for each row in 9.8, tree ordering.
- `settings`: defaults, the union of exclude patterns across levels, `toCoreOptions` (GOPRIVATE env and Go env file joined, `goEnvFilePath` per platform, hosts lowercased, TTLs in ms).

Extension host smoke test: skipped. `@vscode/test-electron` and `@vscode/test-cli` download a VS Code build at test time, which this project's rules do not allow in tests. CONTRIBUTING documents a manual smoke check (F5 with the "Run Extension" launch configuration on a sample folder) and the release checklist runs it by hand.

Quality gates for every change: `npm run lint`, `npm run typecheck`, `npm test`, `npm run notices:check`, `npm run build:production`, `npm run check:bundle` (the bundle loads in plain Node with a `vscode` stand-in and exports `activate` and `deactivate`; esbuild uses `mainFields: ["module", "main"]` because jsonc-parser's UMD `main` hides its requires from the bundler), `npm run package` (produces `semverity.vsix`; `vscode:prepublish` runs the production build and the bundle check). `npm run check` runs the first four.
