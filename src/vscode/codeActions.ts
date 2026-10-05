// Quick fixes for Semverity diagnostics (docs/DESIGN.md 9.7): move the declared
// version to the healthy pick, and open the package page.

import * as vscode from "vscode";
import type { Core } from "../core/index";
import type { AnalysisEntry, DeclaredIn } from "../core/types";
import { currentBumpEdit, type ManifestEdit } from "../presentation/quickfix";
import { fromRange, sameRange, toRange } from "./convert";
import { DIAGNOSTIC_SOURCE } from "./diagnostics";
import type { DocumentTracker } from "./documents";
import { healthyEdit, listingNow } from "./healthy";

const PREFERRED_CODES = new Set(["malware", "kev", "gate"]);

function codeValue(d: vscode.Diagnostic): string | undefined {
  const c = d.code;
  if (c === undefined) return undefined;
  if (typeof c === "object") return String(c.value);
  return String(c);
}

export class SemverityCodeActions implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  constructor(
    private readonly core: Core,
    private readonly tracker: DocumentTracker,
    private readonly siteName: () => string,
  ) {}

  async provideCodeActions(
    doc: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeAction[]> {
    const ours = context.diagnostics.filter((d) => d.source === DIAGNOSTIC_SOURCE);
    if (ours.length === 0) return [];
    const analysis = this.tracker.ensure(doc);
    if (!analysis) return [];

    const byEntry = new Map<AnalysisEntry, vscode.Diagnostic[]>();
    for (const d of ours) {
      const r = fromRange(d.range);
      const entry = analysis.entries.find((e) => e.target && sameRange(e.range, r));
      if (!entry) continue;
      const list = byEntry.get(entry);
      if (list) list.push(d);
      else byEntry.set(entry, [d]);
    }

    const actions: vscode.CodeAction[] = [];
    for (const [entry, diagnostics] of byEntry) {
      if (token.isCancellationRequested) return [];
      const result = this.tracker.resultFor(entry);
      if (!result || result.state !== "scored") continue;
      // Never waits on the network: a listing that is not cached yet is fetched
      // in the background and the fix shows on the next request.
      const listing = await listingNow(this.core, entry, result);
      const fix = healthyEdit(entry, result, listing);
      // Recompute against the manifest's current text: the index may hold an
      // older parse (unsaved edits, an earlier bump), whose range would be stale.
      const fresh = fix && entry.declaredIn ? await this.currentEdit(doc, entry.declaredIn, fix.to) : undefined;
      if (fix && fresh) {
        const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(vscode.Uri.parse(fresh.uri), toRange(fresh.range), fresh.newText);
        action.edit = edit;
        action.diagnostics = diagnostics;
        action.isPreferred = diagnostics.some((d) => PREFERRED_CODES.has(codeValue(d) ?? ""));
        actions.push(action);
      }
      const { coordinate } = result;
      const open = new vscode.CodeAction(`Open ${coordinate.name} on ${this.siteName()}`, vscode.CodeActionKind.QuickFix);
      open.command = {
        command: "semverity.openPackagePage",
        title: open.title,
        arguments: [{ ecosystem: coordinate.ecosystem, name: coordinate.name, version: coordinate.version }],
      };
      open.diagnostics = diagnostics;
      actions.push(open);
    }
    return actions;
  }

  private async currentEdit(doc: vscode.TextDocument, declaredIn: DeclaredIn, version: string): Promise<ManifestEdit | undefined> {
    let text: string;
    if (doc.uri.toString() === declaredIn.manifestUri) text = doc.getText();
    else {
      try {
        text = (await vscode.workspace.openTextDocument(vscode.Uri.parse(declaredIn.manifestUri, true))).getText();
      } catch {
        return undefined;
      }
    }
    return currentBumpEdit(declaredIn, version, text);
  }
}
