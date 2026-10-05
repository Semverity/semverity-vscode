// The "Semverity" view in the Explorer (docs/DESIGN.md 9.9): one node per
// manifest, its dependencies worst first, and their fired gates.

import * as vscode from "vscode";
import type { Core } from "../core/index";
import type { AnalysisEntry, Coordinate, LookupResult, PackageId } from "../core/types";
import type { Grade } from "../core/api/types";
import { criticalFindings } from "../presentation/facts";
import { colorIdFor, scoreFor } from "../presentation/grades";
import { hoverMarkdown } from "../presentation/hover";
import { formatScore, gateLabel } from "../presentation/labels";
import type { PresentationSettings } from "../presentation/settings";
import { manifestDescription, summarize, treeOrder, type SummaryItem } from "../presentation/summary";
import { toRange } from "./convert";
import { peekResult } from "./documents";
import { TREE_TOOLTIP_COMMANDS, trustedMarkdown } from "./hover";

export interface ManifestResult {
  uri: string;
  /** Workspace-relative path. */
  label: string;
  entries: AnalysisEntry[];
}

export interface ManifestNode {
  kind: "manifest";
  manifest: ManifestResult;
}

export interface PackageNode {
  kind: "package";
  manifestUri: string;
  entry: AnalysisEntry;
}

export interface DetailNode {
  kind: "detail";
  label: string;
  icon: string;
  color?: string;
}

export type TreeNode = ManifestNode | PackageNode | DetailNode;

/** The package (and version, when known) a tree node stands for. */
export function packageOfNode(node: PackageNode, result: LookupResult | undefined): (PackageId & { version?: string }) | undefined {
  const coordinate: Coordinate | undefined = result && "coordinate" in result ? result.coordinate : undefined;
  if (coordinate) return coordinate;
  const target = node.entry.target;
  return target ? { ...target.id, version: target.version } : undefined;
}

export class DependencyTree implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private manifests: ManifestResult[] = [];
  private filled = false;
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  private readonly subscriptions: vscode.Disposable[] = [];
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly core: Core,
    private readonly settings: () => PresentationSettings,
  ) {
    this.subscriptions.push(core.lookups.onDidUpdate(() => this.refresh()));
  }

  isEmpty(): boolean {
    return !this.filled;
  }

  setResults(manifests: ManifestResult[]): void {
    this.manifests = [...manifests].sort((a, b) => a.label.localeCompare(b.label));
    this.filled = true;
    this.refresh();
  }

  /** Every dependency entry with its current answer (for the status bar and refresh). */
  items(): SummaryItem[] {
    return this.manifests.flatMap((m) => m.entries.map((entry) => ({ entry, result: this.result(entry) })));
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  result(entry: AnalysisEntry): LookupResult | undefined {
    return entry.target ? peekResult(this.core, entry.target) : undefined;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) return this.manifests.map((manifest) => ({ kind: "manifest", manifest }));
    if (node.kind === "manifest") {
      const items = node.manifest.entries
        .filter((entry) => entry.target || entry.excluded)
        .map((entry) => ({ entry, result: this.result(entry) }))
        .sort(treeOrder);
      return items.map(({ entry }) => ({ kind: "package", manifestUri: node.manifest.uri, entry }));
    }
    if (node.kind === "package") return this.details(node);
    return [];
  }

  private details(node: PackageNode): DetailNode[] {
    const result = this.result(node.entry);
    if (!result || result.state !== "scored") return [];
    const out: DetailNode[] = [];
    const card = result.card;
    for (const f of criticalFindings(card)) {
      const label = f.own
        ? `${gateLabel(f.gate)}${f.reason ? `: ${f.reason}` : ""}`
        : `Pulls in a package with: ${gateLabel(f.gate)} (depth ${f.depth ?? "?"})`;
      out.push({ kind: "detail", label, icon: "error", color: "errorForeground" });
    }
    for (const g of card.gates) {
      if (g.id === "malware" || g.id === "kev") continue;
      out.push({
        kind: "detail",
        label: `${gateLabel(g.id)}${g.reason ? `: ${g.reason}` : ""}`,
        icon: g.hard || g.id === "unfixed_high_vuln" ? "warning" : "info",
        color: g.hard ? "editorWarning.foreground" : undefined,
      });
    }
    const healthy = result.listing?.healthy;
    if (healthy && healthy !== result.coordinate.version) {
      out.push({ kind: "detail", label: `Healthy version ${healthy}`, icon: "arrow-up" });
    }
    return out;
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === "manifest") {
      const item = new vscode.TreeItem(node.manifest.label, vscode.TreeItemCollapsibleState.Expanded);
      const items = node.manifest.entries
        .filter((e) => e.target || e.excluded)
        .map((entry) => ({ entry, result: this.result(entry) }));
      const s = this.settings();
      item.description = manifestDescription(summarize(items, { scoreBasis: s.scoreBasis, gates: s.gates }));
      item.resourceUri = vscode.Uri.parse(node.manifest.uri);
      item.iconPath = vscode.ThemeIcon.File;
      item.contextValue = "semverity.manifest";
      item.id = `manifest:${node.manifest.uri}`;
      return item;
    }
    if (node.kind === "detail") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(node.icon, node.color ? new vscode.ThemeColor(node.color) : undefined);
      item.tooltip = node.label;
      return item;
    }
    return this.packageItem(node);
  }

  private packageItem(node: PackageNode): vscode.TreeItem {
    const { entry } = node;
    const result = this.result(entry);
    const scored = result?.state === "scored" ? result : undefined;
    const hasDetails =
      scored !== undefined &&
      (scored.card.gates.length > 0 ||
        criticalFindings(scored.card).length > 0 ||
        (scored.listing?.healthy !== undefined && scored.listing.healthy !== scored.coordinate.version));
    const item = new vscode.TreeItem(entry.label, hasDetails ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    const version = scored?.coordinate.version ?? entry.target?.version ?? entry.target?.range;
    let state: string;
    let grade: Grade | undefined;
    if (entry.excluded) state = "excluded";
    else if (scored) {
      const head = scoreFor(scored.card, "headline");
      const critical = criticalFindings(scored.card);
      if (critical.some((c) => c.gate === "malware")) {
        state = "malware";
        grade = "F";
      } else if (head) {
        state = `${critical.length > 0 ? "KEV · " : ""}${formatScore(head.score, head.atMost)} ${head.grade}${scored.stale ? " (cached)" : ""}`;
        grade = critical.length > 0 ? "F" : head.grade;
      } else state = "not scored";
    } else if (result?.state === "not_scored") state = "not scored";
    else if (result?.state === "disabled") state = "lookups off";
    else if (result?.state === "offline" || result?.state === "rate_limited") state = "waiting for the API";
    else if (result?.state === "error") state = "lookup failed";
    else state = "scoring…";
    item.description = version ? `${version} · ${state}` : state;
    item.iconPath = new vscode.ThemeIcon("shield", new vscode.ThemeColor(colorIdFor(grade)));
    item.contextValue = scored ? "semverity.package.scored" : "semverity.package";
    const s = this.settings();
    const md = hoverMarkdown(entry, result, { siteBaseUrl: s.siteBaseUrl, now: Date.now(), signedIn: this.core.lookups.status().signedIn });
    if (md) item.tooltip = trustedMarkdown(md, TREE_TOOLTIP_COMMANDS);
    item.command = {
      command: "vscode.open",
      title: "Show Dependency",
      arguments: [vscode.Uri.parse(node.manifestUri), { selection: toRange(entry.range), preserveFocus: false }],
    };
    return item;
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    this.changed.dispose();
  }
}
