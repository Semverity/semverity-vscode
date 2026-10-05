// Resolved in place of "vscode" under vitest (see vitest.config.mts). Logic
// under test must not need the editor API; reaching this module is a bug.
throw new Error("The vscode module is not available in unit tests. Keep editor calls in src/vscode adapters.");
