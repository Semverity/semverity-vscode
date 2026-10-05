// File system watchers for manifests, lockfiles, .npmrc, tsconfig/jsconfig and
// go.work: each change is reported to the workspace index. A second watcher
// reports new Python files, so a module created inside the workspace is known
// to be local before an import of it is looked up.

import * as vscode from "vscode";
import type { Core } from "../core/index";
import type { Logger } from "../core/ports";
import { isIgnoredPath, WATCHED_FILES_GLOB } from "./selectors";

const PYTHON_FILES_GLOB = "**/*.py";

export function watchWorkspaceFiles(core: Core, logger: Logger): vscode.Disposable {
  const report = (uri: vscode.Uri) => {
    if (isIgnoredPath(uri.path)) return;
    core.workspace.fileChanged(uri.toString()).catch((err: unknown) => {
      logger.warn(`Workspace index update failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  const watcher = vscode.workspace.createFileSystemWatcher(WATCHED_FILES_GLOB);
  // Only creations matter for Python: module names are added, never removed.
  const pythonWatcher = vscode.workspace.createFileSystemWatcher(PYTHON_FILES_GLOB, false, true, true);
  return vscode.Disposable.from(
    watcher,
    watcher.onDidCreate(report),
    watcher.onDidChange(report),
    watcher.onDidDelete(report),
    pythonWatcher,
    pythonWatcher.onDidCreate(report),
  );
}
