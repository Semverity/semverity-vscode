// Extension entry point: reads the settings, builds the core with the vscode
// adapters behind its ports, and registers every surface of docs/DESIGN.md
// section 9 on the extension context.

import * as vscode from "vscode";
import { createCore, type Core } from "./core/index";
import type { PresentationSettings } from "./presentation/settings";
import { readSettings, toCoreOptions, toPresentationSettings, type Settings } from "./settings";
import { systemClock } from "./vscode/clock";
import { SemverityCodeActions } from "./vscode/codeActions";
import { registerCommands } from "./vscode/commands";
import { DecorationController } from "./vscode/decorations";
import { DiagnosticsController } from "./vscode/diagnostics";
import { DocumentTracker } from "./vscode/documents";
import { createFetch } from "./vscode/fetch";
import { WorkspaceFiles } from "./vscode/files";
import { readGoEnvFile } from "./vscode/goEnv";
import { readPythonConfigs } from "./vscode/pythonEnv";
import { SemverityHoverProvider } from "./vscode/hover";
import { ChannelLogger } from "./vscode/logger";
import { PendingEdits } from "./vscode/pendingEdits";
import { ApiKeyStore } from "./vscode/secrets";
import { MANIFEST_GLOBS, SOURCE_LANGUAGES, SUPPORTED_SCHEMES } from "./vscode/selectors";
import { StatusBarController } from "./vscode/statusBar";
import { MementoStore } from "./vscode/store";
import { DependencyTree } from "./vscode/tree";
import { watchWorkspaceFiles } from "./vscode/watchers";

function documentSelector(): vscode.DocumentFilter[] {
  const filters: vscode.DocumentFilter[] = [];
  for (const scheme of SUPPORTED_SCHEMES) {
    for (const language of SOURCE_LANGUAGES) filters.push({ scheme, language });
    for (const pattern of MANIFEST_GLOBS) filters.push({ scheme, pattern });
  }
  return filters;
}

function siteHost(siteBaseUrl: string): string {
  try {
    return new URL(siteBaseUrl).host;
  } catch {
    return "semverity.dev";
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const logger = new ChannelLogger();
  context.subscriptions.push(logger);

  const version = String((context.extension.packageJSON as { version?: unknown }).version ?? "0.0.0");
  const read = (): Settings => readSettings(vscode.workspace.getConfiguration("semverity"));
  let settings = read();
  let presentation: PresentationSettings = toPresentationSettings(settings);
  // The Go env file (`go env -w GOPRIVATE=...`) is read whenever the options are
  // built, so a change there applies on the next settings change or window reload.
  // The same holds for the user pip and uv configuration (private package indexes).
  const coreOptions = () => toCoreOptions(settings, version, process.env, readGoEnvFile(process.env), readPythonConfigs(process.env));

  const apiKeys = new ApiKeyStore(context.secrets);
  context.subscriptions.push(apiKeys);

  let core: Core;
  try {
    core = createCore({
      options: coreOptions(),
      fetch: createFetch(),
      clock: systemClock,
      store: new MementoStore(context.globalState),
      files: new WorkspaceFiles(),
      secrets: apiKeys,
      logger,
    });
  } catch (err) {
    logger.error(`Semverity could not start: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  context.subscriptions.push(core);

  const tracker = new DocumentTracker(core, settings.editDebounceMs, logger);
  const tree = new DependencyTree(core, () => presentation);
  const treeView = vscode.window.createTreeView("semverity.dependencies", { treeDataProvider: tree, showCollapseAll: true });
  const decorations = new DecorationController(tracker, () => presentation);
  const diagnostics = new DiagnosticsController(core, tracker, () => presentation);
  const statusBar = new StatusBarController(core, tracker, () => settings);
  context.subscriptions.push(tracker, tree, treeView, decorations, diagnostics, statusBar);

  const pending = new PendingEdits();
  const selector = documentSelector();
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(selector, new SemverityHoverProvider(core, tracker, () => presentation, pending)),
    vscode.languages.registerCodeActionsProvider(
      selector,
      new SemverityCodeActions(core, tracker, () => siteHost(presentation.siteBaseUrl)),
      SemverityCodeActions.metadata,
    ),
    watchWorkspaceFiles(core, logger),
  );

  const refreshSurfaces = () => {
    decorations.refreshAll();
    diagnostics.refreshAll();
    statusBar.update();
    tree.refresh();
  };

  const apiKeyChanged = () => {
    // A key changes what the API can find: the core drops its negative answers,
    // re-reads the key (a refused key gets a fresh chance) and looks the
    // visible targets up again. Scores already cached stay valid.
    if (core.lookups.apiKeyChanged) core.lookups.apiKeyChanged();
    else core.lookups.invalidate();
    tracker.requestVisible();
    refreshSurfaces();
  };

  context.subscriptions.push(
    registerCommands({ core, tracker, tree, diagnostics, statusBar, apiKeys, logger, pending, settings: () => settings }),
    // Fires for the Set and Clear API Key commands and for changes made in another window.
    apiKeys.onDidChange(apiKeyChanged),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("semverity")) return;
      settings = read();
      presentation = toPresentationSettings(settings);
      tracker.setDebounce(settings.editDebounceMs);
      core.updateOptions(coreOptions());
      tracker.reanalyzeAll();
      tracker.requestVisible();
      refreshSurfaces();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      settings = read();
      presentation = toPresentationSettings(settings);
      core.updateOptions(coreOptions());
      tracker.reanalyzeAll();
      refreshSurfaces();
    }),
  );

  tracker.start();
  statusBar.update();
  core.workspace.rebuild().catch((err: unknown) => {
    logger.warn(`Workspace index build failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

export function deactivate(): void {
  // Everything is registered on the extension context and disposed by the host.
}
