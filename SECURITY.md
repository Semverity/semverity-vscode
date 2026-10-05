# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue, pull request or discussion. Use either:

- GitHub private vulnerability reporting: [report a vulnerability](https://github.com/Semverity/semverity-vscode/security/advisories/new) on this repository, or
- email to [security@semverity.dev](mailto:security@semverity.dev).

Include what you found, the extension version, and the steps or a small example that shows the problem. Leave out real API keys and private package names; if they are needed to show the issue, say so and we will arrange a safe way to share them.

We acknowledge reports within three working days, keep you informed while we investigate, and credit you in the release notes when the fix ships unless you prefer otherwise. Please give us a reasonable time to release a fix before you disclose the issue publicly.

## Scope

In scope: this extension, including anything that could make it send more than package coordinates (ecosystem, name and version), expose the API key stored in VS Code SecretStorage, run code or commands from workspace content, or apply edits the user did not ask for.

Problems with the Semverity service itself (`api.semverity.dev`, `semverity.dev`) are welcome at the same email address. A score you believe is wrong is not a security issue; please raise it through the package's page on semverity.dev.

## Supported versions

Security fixes are made in the latest released version. Please update to it before reporting.
