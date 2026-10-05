// Command registrations (docs/DESIGN.md 9.3).

import * as vscode from "vscode";
import { packagePageUrl, targetKey, type Core } from "../core/index";
import type { Ecosystem, LookupTarget, PackageId } from "../core/types";
import { currentBumpEdit } from "../presentation/quickfix";
import { ECOSYSTEMS } from "../core/types";
import { readSettings, type Settings } from "../settings";
import { toRange } from "./convert";
import type { DiagnosticsController } from "./diagnostics";
import type { DocumentTracker } from "./documents";
import type { ChannelLogger } from "./logger";
import type { PendingEdits } from "./pendingEdits";
import { looksLikeApiKey, type ApiKeyStore } from "./secrets";
import { manifestKindOf, manifestLanguageId } from "./selectors";
import { STATUS_BAR_CLICK_COMMAND, type StatusBarController } from "./statusBar";
import type { DependencyTree, ManifestResult, PackageNode } from "./tree";
import { packageOfNode } from "./tree";

const MAX_WORKSPACE_TARGETS = 2000;
const CHECK_CHUNK = 25;

export interface CommandDeps {
  core: Core;
  tracker: DocumentTracker;
  tree: DependencyTree;
  diagnostics: DiagnosticsController;
  statusBar: StatusBarController;
  apiKeys: ApiKeyStore;
  logger: ChannelLogger;
  pending: PendingEdits;
  settings: () => Settings;
}

interface PackageArg {
  ecosystem: Ecosystem;
  name: string;
  version?: string;
}

function isPackageArg(v: unknown): v is PackageArg {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["ecosystem"] === "string" &&
    (ECOSYSTEMS as readonly string[]).includes(o["ecosystem"]) &&
    typeof o["name"] === "string" &&
    o["name"] !== "" &&
    (o["version"] === undefined || typeof o["version"] === "string")
  );
}

function isPackageNode(v: unknown): v is PackageNode {
  return typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "package" && "entry" in v;
}

function applyId(v: unknown): unknown {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>)["id"] : undefined;
}

function relativeLabel(uri: string): string {
  return vscode.workspace.asRelativePath(vscode.Uri.parse(uri), (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
}

export function registerCommands(d: CommandDeps): vscode.Disposable {
  let checking: Promise<void> | undefined;

  const openPage = async (id: PackageId, version?: string) => {
    const url = packagePageUrl(d.settings().siteBaseUrl, id, version);
    await vscode.env.openExternal(vscode.Uri.parse(url, true));
  };

  const checkWorkspace = async (): Promise<void> => {
    if (checking) return checking;
    checking = (async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Semverity: checking workspace dependencies", cancellable: true },
        async (progress, token) => {
          progress.report({ message: "reading manifests" });
          await d.core.workspace.rebuild();
          const manifests: ManifestResult[] = [];
          const targets = new Map<string, LookupTarget>();
          for (const m of d.core.workspace.manifests()) {
            if (token.isCancellationRequested) return;
            const doc = vscode.workspace.textDocuments.find((t) => t.uri.toString() === m.uri);
            let text = doc?.getText();
            if (text === undefined) {
              try {
                text = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.parse(m.uri, true)));
              } catch {
                continue;
              }
            }
            const kind = manifestKindOf(vscode.Uri.parse(m.uri).path) ?? m.kind;
            const analysis = d.core.analyze({ uri: m.uri, languageId: manifestLanguageId(kind), text });
            manifests.push({ uri: m.uri, label: relativeLabel(m.uri), entries: analysis.entries });
            for (const e of analysis.entries) {
              if (e.target && targets.size < MAX_WORKSPACE_TARGETS) targets.set(targetKey(e.target), e.target);
            }
          }
          d.tree.setResults(manifests);
          d.diagnostics.setWorkspace(manifests);
          d.statusBar.setWorkspaceItems(() => d.tree.items());

          if (d.core.lookups.status().state === "disabled") {
            void vscode.window.showInformationMessage("Semverity network lookups are off; showing cached scores only.");
            return;
          }
          // Cached answers are already shown; resolve() answers them from the cache.
          const all = [...targets.values()];
          let done = 0;
          progress.report({ message: `0 of ${all.length}` });
          for (let i = 0; i < all.length; i += CHECK_CHUNK) {
            if (token.isCancellationRequested) break;
            const chunk = all.slice(i, i + CHECK_CHUNK);
            await d.core.lookups.resolve(chunk, "background");
            done += chunk.length;
            progress.report({ message: `${done} of ${all.length}`, increment: (chunk.length / all.length) * 100 });
            d.tree.refresh();
          }
          d.logger.info(`Workspace check: ${manifests.length} manifests, ${all.length} packages.`);
        },
      );
    })().finally(() => {
      checking = undefined;
    });
    return checking;
  };

  const openPackagePage = async (arg?: unknown): Promise<void> => {
    if (isPackageArg(arg)) return openPage(arg, arg.version);
    if (isPackageNode(arg)) {
      const pkg = packageOfNode(arg, d.tree.result(arg.entry));
      if (pkg) return openPage(pkg, pkg.version);
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage("Open a file with imports or a manifest to choose a package.");
      return;
    }
    const analysis = d.tracker.ensure(editor.document);
    const entries = (analysis?.entries ?? []).filter((e) => e.target);
    const line = editor.selection.active.line;
    const onLine = entries.find((e) => e.line === line);
    const pick = async () => {
      if (onLine) return onLine;
      if (entries.length === 0) return undefined;
      const seen = new Set<string>();
      const items = entries
        .filter((e) => {
          const key = targetKey(e.target as LookupTarget);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map((e) => ({ label: e.label, description: e.target?.version ?? e.target?.range ?? "latest", entry: e }));
      return (await vscode.window.showQuickPick(items, { title: "Open a package on Semverity" }))?.entry;
    };
    const entry = await pick();
    if (!entry?.target) {
      if (entries.length === 0) void vscode.window.showInformationMessage("Semverity found no packages in this file.");
      return;
    }
    const result = d.tracker.resultFor(entry);
    const coordinate = result && "coordinate" in result ? result.coordinate : undefined;
    await openPage(coordinate ?? entry.target.id, coordinate?.version ?? entry.target.version);
  };

  const refresh = (): void => {
    const ids = new Map<string, PackageId>();
    const add = (target: LookupTarget | undefined) => {
      if (target) ids.set(`${target.id.ecosystem}:${target.id.name}`, target.id);
    };
    for (const uri of d.tracker.visibleUris()) for (const e of d.tracker.get(uri)?.entries ?? []) add(e.target);
    const treeItems = d.tree.isEmpty() ? [] : d.tree.items();
    for (const item of treeItems) add(item.entry.target);
    if (ids.size === 0) return;
    d.core.lookups.invalidate([...ids.values()]);
    d.tracker.requestVisible();
    const background = treeItems.map((i) => i.entry.target).filter((t): t is LookupTarget => t !== undefined);
    if (background.length > 0) d.core.lookups.request(background, "background");
  };

  const setApiKey = async (): Promise<void> => {
    const value = await vscode.window.showInputBox({
      title: "Semverity API key",
      prompt: "Create a key in the dashboard at https://semverity.dev. It is kept in VS Code's secret storage and sent only to the Semverity API.",
      placeHolder: "svk_…",
      password: true,
      ignoreFocusOut: true,
    });
    const key = value?.trim();
    if (!key) return;
    if (!looksLikeApiKey(key)) {
      const choice = await vscode.window.showWarningMessage(
        "This does not look like a Semverity API key (svk_ followed by 40 characters). Store it anyway?",
        { modal: true },
        "Store",
      );
      if (choice !== "Store") return;
    }
    // The secret storage change event refreshes the core and the surfaces.
    await d.apiKeys.set(key);
    void vscode.window.showInformationMessage("Semverity API key stored.");
  };

  const clearApiKey = async (): Promise<void> => {
    await d.apiKeys.clear();
    void vscode.window.showInformationMessage("Semverity API key removed.");
  };

  const toggleLookups = async (): Promise<void> => {
    const config = vscode.workspace.getConfiguration("semverity");
    const next = !d.settings().networkEnabled;
    await config.update("network.enabled", next, vscode.ConfigurationTarget.Global);
    // A workspace or folder value of false keeps lookups off (see stickyOff in src/settings.ts).
    const effective = readSettings(vscode.workspace.getConfiguration("semverity")).networkEnabled;
    if (effective !== next) {
      void vscode.window.showWarningMessage(
        "Semverity network lookups were turned on in user settings, but this workspace's settings turn them off. Remove semverity.network.enabled from the workspace settings to turn them on here.",
      );
    } else {
      void vscode.window.showInformationMessage(`Semverity network lookups are ${next ? "on" : "off"}.`);
    }
  };

  // The hover's "Use x" link: its only argument is the id of an edit the
  // extension computed (PendingEdits). The edit is recomputed against the
  // manifest's current text and applied only to a manifest inside the workspace.
  const applyVersion = async (arg?: unknown): Promise<void> => {
    const pending = d.pending.get(applyId(arg));
    if (!pending) return;
    const uri = vscode.Uri.parse(pending.declaredIn.manifestUri, true);
    if (!manifestKindOf(uri.path) || !vscode.workspace.getWorkspaceFolder(uri)) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    const fresh = currentBumpEdit(pending.declaredIn, pending.version, doc.getText());
    if (!fresh) {
      void vscode.window.showInformationMessage("Semverity: the dependency changed since the hover was shown; nothing was edited.");
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, toRange(fresh.range), fresh.newText);
    await vscode.workspace.applyEdit(edit);
  };

  const showDependencies = async (): Promise<void> => {
    await vscode.commands.executeCommand("semverity.dependencies.focus");
    if (d.tree.isEmpty()) await checkWorkspace();
  };

  return vscode.Disposable.from(
    vscode.commands.registerCommand("semverity.checkWorkspace", checkWorkspace),
    vscode.commands.registerCommand("semverity.openPackagePage", openPackagePage),
    vscode.commands.registerCommand("semverity.refresh", refresh),
    vscode.commands.registerCommand("semverity.clearCache", async () => {
      await d.core.lookups.clear();
      d.tracker.refreshAll();
      d.tracker.requestVisible();
      d.tree.refresh();
      void vscode.window.showInformationMessage("Semverity cached scores cleared.");
    }),
    vscode.commands.registerCommand("semverity.setApiKey", setApiKey),
    vscode.commands.registerCommand("semverity.clearApiKey", clearApiKey),
    vscode.commands.registerCommand("semverity.toggleLookups", toggleLookups),
    vscode.commands.registerCommand("semverity.showLog", () => d.logger.show()),
    vscode.commands.registerCommand("semverity.applyVersion", applyVersion),
    vscode.commands.registerCommand(STATUS_BAR_CLICK_COMMAND, showDependencies),
  );
}
