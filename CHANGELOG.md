# Changelog

All notable changes to the Semverity extension are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0]

First release.

### Added

- Scores for npm, PyPI and Go module dependencies as you write imports (JavaScript and TypeScript `import`, `export ... from`, `require` and `import()`; Python `import` and `from ... import`; Go import paths) and as you edit `package.json`, `requirements*.txt`, `pyproject.toml` and `go.mod`.
- Versions chosen from the workspace's lockfiles (`package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `poetry.lock`, `uv.lock`, `pdm.lock`, `Pipfile.lock`), else the manifest's exact version or range, else the latest release.
- Inline decorations with the headline score and grade, a hover card (headline and own score, security grade, gates, coverage, reasons for a low score, healthy version, package page link), Problems entries with configurable thresholds (malware and KEV always reported as errors), and a quick fix that bumps a manifest to the healthy version.
- A status bar summary, a "Check Workspace Dependencies" command with a Semverity view in the Explorer, and an "Open Package Page" command.
- Batched, cached and rate limited lookups: the cache honours `Cache-Control`, revalidates with ETags, backs off on `429` and `503` honouring `Retry-After`, and keeps showing cached scores offline.
- Privacy controls: only package coordinates are sent; exclude patterns; automatic exclusion of npm packages bound to a private registry by `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `bunfig.toml` or the environment, of packages resolved from private registries, of Python packages that a private index could serve (requirements files, `pyproject.toml`, `PIP_INDEX_URL` and the other pip and uv variables, user and site `pip.conf` and `uv.toml`), and of `GOPRIVATE` modules (read from the environment and from the `go env -w` file); a switch that turns every lookup off, which no workspace can turn back on; no telemetry.
- Optional API key, stored in VS Code SecretStorage, which lets Semverity collect public packages it has not scored yet.

[Unreleased]: https://github.com/Semverity/semverity-vscode/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Semverity/semverity-vscode/releases/tag/v0.1.0
