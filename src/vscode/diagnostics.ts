// Problems entries (docs/DESIGN.md 9.6) for open documents and, after a
// workspace check, for manifests that are not open.

import * as vscode from "vscode";
import type { Core } from "../core/index";
import type { AnalysisEntry } from "../core/types";
import { diagnosticsFor, type DiagnosticSpec } from "../presentation/diagnostics";
import type { PresentationSettings } from "../presentation/settings";
import { toRange } from "./convert";
import { peekResult, type DocumentTracker } from "./documents";

export const DIAGNOSTIC_SOURCE = "Semverity";

const SEVERITY: Record<DiagnosticSpec["severity"], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information,
};

export function toDiagnostic(spec: DiagnosticSpec): vscode.Diagnostic {
  const d = new vscode.Diagnostic(toRange(spec.range), spec.message, SEVERITY[spec.severity]);
  d.source = DIAGNOSTIC_SOURCE;
  d.code = { value: spec.code, target: vscode.Uri.parse(spec.target) };
  return d;
}

export class DiagnosticsController implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection("semverity");
  /** Manifest entries from the last workspace check, by manifest URI. */
  private workspaceEntries = new Map<string, AnalysisEntry[]>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly core: Core,
    private readonly tracker: DocumentTracker,
    private readonly settings: () => PresentationSettings,
  ) {
    this.subscriptions.push(
      tracker.onDidChange((uris) => {
        for (const uri of uris) this.update(uri);
      }),
      tracker.onDidClose((uri) => this.update(uri)),
      core.lookups.onDidUpdate(() => this.refreshWorkspace()),
    );
  }

  /** Recomputes the diagnostics of one document (open analysis first, else the workspace check). */
  update(uri: string): void {
    const s = this.settings();
    if (!s.diagnostics) {
      this.collection.delete(vscode.Uri.parse(uri));
      return;
    }
    const entries = this.tracker.get(uri)?.entries ?? this.workspaceEntries.get(uri);
    if (!entries) {
      this.collection.delete(vscode.Uri.parse(uri));
      return;
    }
    const out: vscode.Diagnostic[] = [];
    for (const entry of entries) {
      if (!entry.target) continue;
      for (const spec of diagnosticsFor(entry, peekResult(this.core, entry.target), s)) out.push(toDiagnostic(spec));
    }
    this.collection.set(vscode.Uri.parse(uri), out);
  }

  /** Replaces the manifest entries of the last workspace check. */
  setWorkspace(manifests: { uri: string; entries: AnalysisEntry[] }[]): void {
    const previous = [...this.workspaceEntries.keys()];
    this.workspaceEntries = new Map(manifests.map((m) => [m.uri, m.entries]));
    for (const uri of previous) if (!this.workspaceEntries.has(uri)) this.update(uri);
    this.refreshWorkspace();
  }

  private refreshWorkspace(): void {
    for (const uri of this.workspaceEntries.keys()) {
      if (!this.tracker.get(uri)) this.update(uri);
    }
  }

  refreshAll(): void {
    const uris = new Set([...this.tracker.uris(), ...this.workspaceEntries.keys()]);
    for (const uri of uris) this.update(uri);
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    this.collection.dispose();
  }
}
