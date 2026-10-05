// Tracks open documents of the supported languages and manifests, analyses them
// (immediately on open or reveal, debounced on edits), asks the lookup service
// for the packages of visible documents, and tells the surfaces when an
// analysis or one of its answers changed.

import * as vscode from "vscode";
import { targetKey, type Core } from "../core/index";
import type { AnalysisEntry, DocumentAnalysis, LookupResult, LookupTarget } from "../core/types";
import type { LineItem } from "../presentation/decoration";
import { lineAfterEdit, TypingHold } from "../presentation/typingHold";
import type { Logger } from "../core/ports";
import { isSupportedDocument, manifestKindOf, manifestLanguageId, MAX_DOCUMENT_CHARS } from "./selectors";

interface Tracked {
  version: number;
  analysis: DocumentAnalysis;
}

export class DocumentTracker implements vscode.Disposable {
  private readonly analyses = new Map<string, Tracked>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly changed = new vscode.EventEmitter<string[]>();
  private readonly closed = new vscode.EventEmitter<string>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly hold = new TypingHold((uri) => this.released(uri), {
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });

  /** URIs whose analysis or answers changed. */
  readonly onDidChange = this.changed.event;
  /** A tracked document was closed. */
  readonly onDidClose = this.closed.event;

  constructor(
    private readonly core: Core,
    private debounceMs: number,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((doc) => this.analyzeNow(doc, this.isVisible(doc))),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length === 0) return;
        const last = e.contentChanges[e.contentChanges.length - 1];
        if (last && this.isVisible(e.document)) this.hold.edited(e.document.uri.toString(), lineAfterEdit(last.range.start.line, last.text));
        this.schedule(e.document);
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        const active = e.selections[0]?.active;
        if (active) this.hold.cursorMoved(e.textEditor.document.uri.toString(), active.line);
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => this.hold.saved(doc.uri.toString())),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.forget(doc.uri.toString());
        // Unsaved manifest edits are gone: the index reads the file from disk again.
        if (manifestKindOf(doc.uri.path)) void this.core.workspace.fileChanged(doc.uri.toString()).catch(() => undefined);
      }),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) {
          const tracked = this.analyses.get(editor.document.uri.toString());
          if (!tracked || tracked.version !== editor.document.version) this.analyzeNow(editor.document, true);
          else this.request(tracked.analysis);
        }
      }),
      this.core.workspace.onDidChange(() => this.reanalyzeAll()),
      this.core.lookups.onDidUpdate((keys) => this.answersChanged(keys)),
      this.core.lookups.onDidChangeStatus(() => this.changed.fire([...this.analyses.keys()])),
    );
    for (const doc of vscode.workspace.textDocuments) this.analyzeNow(doc, this.isVisible(doc));
  }

  setDebounce(ms: number): void {
    this.debounceMs = ms;
  }

  get(uri: string): DocumentAnalysis | undefined {
    return this.analyses.get(uri)?.analysis;
  }

  /** The analysis of a document, analysing it now when it is stale or unknown. */
  ensure(doc: vscode.TextDocument): DocumentAnalysis | undefined {
    const tracked = this.analyses.get(doc.uri.toString());
    if (tracked && tracked.version === doc.version) return tracked.analysis;
    return this.analyzeNow(doc, false);
  }

  uris(): string[] {
    return [...this.analyses.keys()];
  }

  visibleUris(): string[] {
    return vscode.window.visibleTextEditors.map((e) => e.document.uri.toString()).filter((u) => this.analyses.has(u));
  }

  /** The cached answer for an entry; `disabled` when lookups are off and nothing is cached. */
  resultFor(entry: AnalysisEntry): LookupResult | undefined {
    if (!entry.target) return undefined;
    return peekResult(this.core, entry.target);
  }

  items(uri: string): LineItem[] {
    const analysis = this.get(uri);
    if (!analysis) return [];
    return analysis.entries.map((entry) => {
      const result = this.resultFor(entry);
      const item: LineItem = { entry, result };
      if (!result && this.hold.holds(uri, entry)) item.held = true;
      return item;
    });
  }

  /** True for an undeclared import on the line being typed (not looked up yet). */
  isHeld(uri: string, entry: AnalysisEntry): boolean {
    return this.hold.holds(uri, entry);
  }

  /** The line being typed was released: look its imports up and redraw. */
  private released(uri: string): void {
    const tracked = this.analyses.get(uri);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri);
    if (!tracked || !doc) return;
    // A newer edit may be waiting for its debounce: analyse now so the full name is used.
    if (tracked.version !== doc.version) this.analyzeNow(doc, this.isVisible(doc));
    else if (this.isVisible(doc)) this.request(tracked.analysis);
    this.changed.fire([uri]);
  }

  /** Re-requests the packages of every visible document. */
  requestVisible(): void {
    for (const uri of this.visibleUris()) {
      const analysis = this.get(uri);
      if (analysis) this.request(analysis);
    }
  }

  reanalyzeAll(): void {
    for (const doc of vscode.workspace.textDocuments) {
      if (this.analyses.has(doc.uri.toString())) this.analyzeNow(doc, this.isVisible(doc));
    }
  }

  /** Re-renders every tracked document without re-analysing (settings changes). */
  refreshAll(): void {
    this.changed.fire([...this.analyses.keys()]);
  }

  private isVisible(doc: vscode.TextDocument): boolean {
    return vscode.window.visibleTextEditors.some((e) => e.document === doc);
  }

  private schedule(doc: vscode.TextDocument): void {
    const uri = doc.uri.toString();
    if (!this.analyses.has(uri) && !isSupportedDocument({ scheme: doc.uri.scheme, path: doc.uri.path, languageId: doc.languageId })) return;
    const pending = this.timers.get(uri);
    if (pending) clearTimeout(pending);
    this.timers.set(
      uri,
      setTimeout(() => {
        this.timers.delete(uri);
        if (!doc.isClosed) this.analyzeNow(doc, this.isVisible(doc));
      }, this.debounceMs),
    );
  }

  private analyzeNow(doc: vscode.TextDocument, visible: boolean): DocumentAnalysis | undefined {
    const uri = doc.uri.toString();
    if (!isSupportedDocument({ scheme: doc.uri.scheme, path: doc.uri.path, languageId: doc.languageId })) return undefined;
    const text = doc.getText();
    if (text.length > MAX_DOCUMENT_CHARS) {
      this.forget(uri);
      return undefined;
    }
    const kind = manifestKindOf(doc.uri.path);
    // Keep the index's copy of an open manifest in step with the editor, so a
    // quick fix from a source file edits the ranges the user sees.
    if (kind) this.core.workspace.documentChanged(uri, text);
    let analysis: DocumentAnalysis;
    try {
      analysis = this.core.analyze({ uri, languageId: kind ? manifestLanguageId(kind) : doc.languageId, text });
    } catch (err) {
      this.logger.error(`Analysis failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    this.analyses.set(uri, { version: doc.version, analysis });
    if (visible) this.request(analysis);
    this.changed.fire([uri]);
    return analysis;
  }

  private request(analysis: DocumentAnalysis): void {
    const targets: LookupTarget[] = [];
    for (const e of analysis.entries) if (e.target && !this.hold.holds(analysis.uri, e)) targets.push(e.target);
    if (targets.length > 0) this.core.lookups.request(targets, "visible");
  }

  private forget(uri: string): void {
    this.hold.forget(uri);
    const pending = this.timers.get(uri);
    if (pending) clearTimeout(pending);
    this.timers.delete(uri);
    if (this.analyses.delete(uri)) this.closed.fire(uri);
  }

  private answersChanged(keys: string[]): void {
    const wanted = new Set(keys);
    const uris: string[] = [];
    for (const [uri, tracked] of this.analyses) {
      if (tracked.analysis.entries.some((e) => e.target && wanted.has(targetKey(e.target)))) uris.push(uri);
    }
    if (uris.length > 0) this.changed.fire(uris);
  }

  dispose(): void {
    this.hold.dispose();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const s of this.subscriptions) s.dispose();
    this.changed.dispose();
    this.closed.dispose();
  }
}

/** The cached answer for a target; `disabled` when lookups are off and nothing is cached. */
export function peekResult(core: Core, target: LookupTarget): LookupResult | undefined {
  const cached = core.lookups.peek(target);
  if (cached) return cached;
  return core.lookups.status().state === "disabled" ? { state: "disabled" } : undefined;
}
