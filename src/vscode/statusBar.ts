// The status bar item (docs/DESIGN.md 9.8): a summary of the active document,
// else of the last workspace check, else hidden.

import * as vscode from "vscode";
import type { Core } from "../core/index";
import { statusBarModel, summarize, type SummaryItem } from "../presentation/summary";
import type { Settings } from "../settings";
import type { DocumentTracker } from "./documents";
import { STATUS_BAR_COMMANDS, trustedMarkdown } from "./hover";

export const STATUS_BAR_CLICK_COMMAND = "semverity.showDependencies";

export class StatusBarController implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem("semverity.status", vscode.StatusBarAlignment.Right, 100);
  private readonly subscriptions: vscode.Disposable[] = [];
  private workspaceItems: (() => SummaryItem[]) | undefined;

  constructor(
    private readonly core: Core,
    private readonly tracker: DocumentTracker,
    private readonly settings: () => Settings,
  ) {
    this.item.name = "Semverity";
    this.item.command = STATUS_BAR_CLICK_COMMAND;
    this.subscriptions.push(
      tracker.onDidChange(() => this.update()),
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      core.lookups.onDidChangeStatus(() => this.update()),
      core.lookups.onDidUpdate(() => this.update()),
    );
  }

  /** The items of the last workspace check, read on every update (answers keep arriving). */
  setWorkspaceItems(items: (() => SummaryItem[]) | undefined): void {
    this.workspaceItems = items;
    this.update();
  }

  update(): void {
    const s = this.settings();
    if (!s.statusBarEnabled) {
      this.item.hide();
      return;
    }
    const editor = vscode.window.activeTextEditor;
    const uri = editor?.document.uri.toString();
    const analysis = uri ? this.tracker.get(uri) : undefined;
    let items: SummaryItem[] | undefined;
    let scope: string | undefined;
    if (uri && analysis && analysis.kind !== "unsupported") {
      items = this.tracker.items(uri);
      scope = "this file";
    } else if (this.workspaceItems) {
      items = this.workspaceItems();
      scope = "workspace";
    }
    if (!items) {
      this.item.hide();
      return;
    }
    const summary = summarize(items, { scoreBasis: s.scoreBasis, gates: s.gates });
    const model = statusBarModel(summary, this.core.lookups.status(), { warningBelow: s.warningBelow, scope });
    this.item.text = model.text;
    this.item.tooltip = trustedMarkdown(model.tooltipMarkdown, STATUS_BAR_COMMANDS);
    this.item.backgroundColor =
      model.severity === "error"
        ? new vscode.ThemeColor("statusBarItem.errorBackground")
        : model.severity === "warning"
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;
    this.item.show();
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    this.item.dispose();
  }
}
