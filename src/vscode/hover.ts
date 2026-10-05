// The hover card over an import specifier or a manifest dependency (docs/DESIGN.md 9.5).

import * as vscode from "vscode";
import { targetKey, type Core } from "../core/index";
import type { AnalysisEntry, LookupResult, LookupTarget } from "../core/types";
import { hoverMarkdown } from "../presentation/hover";
import { fileName } from "../presentation/labels";
import type { PresentationSettings } from "../presentation/settings";
import { containsPosition, toRange } from "./convert";
import type { DocumentTracker } from "./documents";
import { healthyEdit, listingFor, within } from "./healthy";
import type { PendingEdits } from "./pendingEdits";

/**
 * The commands each surface's Markdown may run from its links: only the ones
 * that surface emits itself. The apply command takes an opaque id (see
 * PendingEdits), never an edit.
 */
export const HOVER_COMMANDS = ["semverity.applyVersion", "semverity.setApiKey"];
export const TREE_TOOLTIP_COMMANDS = ["semverity.setApiKey"];
export const STATUS_BAR_COMMANDS = ["semverity.checkWorkspace", "semverity.toggleLookups"];

export function trustedMarkdown(md: string, commands: readonly string[]): vscode.MarkdownString {
  const ms = new vscode.MarkdownString(md, true);
  ms.isTrusted = { enabledCommands: [...commands] };
  ms.supportHtml = false;
  return ms;
}

/** The lockfile name, when the core reports one on the target (an optional field). */
export function lockfileOf(target: LookupTarget | undefined): string | undefined {
  const lockfile = (target as (LookupTarget & { lockfile?: unknown }) | undefined)?.lockfile;
  return typeof lockfile === "string" && lockfile ? fileName(lockfile) : undefined;
}

export function entryAt(entries: readonly AnalysisEntry[], position: vscode.Position): AnalysisEntry | undefined {
  const p = { line: position.line, character: position.character };
  return entries.find((e) => containsPosition(e.range, p) || (e.specRange !== undefined && containsPosition(e.specRange, p)));
}

export class SemverityHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly core: Core,
    private readonly tracker: DocumentTracker,
    private readonly settings: () => PresentationSettings,
    private readonly pending: PendingEdits,
  ) {}

  async provideHover(doc: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
    const s = this.settings();
    if (!s.hovers) return undefined;
    const analysis = this.tracker.ensure(doc);
    if (!analysis) return undefined;
    const entry = entryAt(analysis.entries, position);
    if (!entry || (entry.skip && !entry.excluded)) return undefined;

    let result: LookupResult | undefined = this.tracker.resultFor(entry);
    // The import on the line being typed is looked up once it is finished.
    if (!result && this.tracker.isHeld(doc.uri.toString(), entry)) return undefined;
    // No answer yet, or only the listing's summary: wait (bounded) for the full card.
    const partial = result?.state === "scored" && result.card.fromListing === true;
    if (entry.target && (!result || partial)) {
      const answers = await within(this.core.lookups.resolve([entry.target], "visible", { full: true }), 4000);
      result = answers?.get(targetKey(entry.target)) ?? this.tracker.resultFor(entry);
    }
    if (token.isCancellationRequested) return undefined;
    if (result && (result.state === "scored" || result.state === "not_scored") && !result.listing && entry.target) {
      const listing = await listingFor(this.core, entry, result);
      if (listing) result = { ...result, listing };
    }
    if (token.isCancellationRequested) return undefined;

    const fix = result?.state === "scored" ? healthyEdit(entry, result, result.listing) : undefined;
    const md = hoverMarkdown(entry, result, {
      siteBaseUrl: s.siteBaseUrl,
      now: Date.now(),
      signedIn: this.core.lookups.status().signedIn,
      lockfile: lockfileOf(entry.target),
      applyCommand: fix && entry.declaredIn ? { title: `Use ${fix.to}`, args: { id: this.pending.register({ declaredIn: entry.declaredIn, version: fix.to }) } } : undefined,
    });
    if (!md) return undefined;
    return new vscode.Hover(trustedMarkdown(md, HOVER_COMMANDS), toRange(entry.range));
  }
}
