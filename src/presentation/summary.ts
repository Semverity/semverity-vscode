// Summaries for the status bar and the tree view (docs/DESIGN.md 9.8 and 9.9). Pure.

import type { Grade } from "../core/api/types";
import { packageKey } from "../core/api/purl";
import type { AnalysisEntry, LookupResult, NetworkStatus } from "../core/types";
import { GRADE_ORDER, scoreFor, type ScoreBasis } from "./grades";
import { criticalFindings, otherGates } from "./facts";
import { clockTime, formatScore } from "./labels";
import { commandLink } from "./markdown";
import { DEFAULT_WARNING_GATES } from "./settings";

export interface SummaryItem {
  entry: AnalysisEntry;
  result?: LookupResult;
}

export interface Summary {
  /** Distinct packages that were looked up or excluded (skipped entries do not count). */
  total: number;
  scored: number;
  grades: Record<Grade, number>;
  notScored: number;
  /** Pending, queued or waiting on the network. */
  pending: number;
  excluded: number;
  malware: number;
  kev: number;
  /** Packages with at least one fired gate from the warning list. */
  gated: number;
  /** The lowest score under the basis. */
  lowest?: { score: number; grade: Grade; atMost: boolean; label: string };
  /** Scored answers shown from an aged cache. */
  stale: number;
}

export interface SummaryOptions {
  scoreBasis?: ScoreBasis;
  gates?: readonly string[];
}

function itemKey(item: SummaryItem): string | undefined {
  if (item.entry.target) return `${packageKey(item.entry.target.id)}@${item.entry.target.version ?? item.entry.target.range ?? "latest"}`;
  if (item.entry.excluded) return `excluded:${item.entry.label}`;
  return undefined;
}

/** Counts per state and grade over distinct packages. */
export function summarize(items: readonly SummaryItem[], options: SummaryOptions = {}): Summary {
  const basis = options.scoreBasis ?? "headline";
  const gateList = options.gates ?? DEFAULT_WARNING_GATES;
  const s: Summary = {
    total: 0,
    scored: 0,
    grades: { A: 0, B: 0, C: 0, D: 0, F: 0 },
    notScored: 0,
    pending: 0,
    excluded: 0,
    malware: 0,
    kev: 0,
    gated: 0,
    stale: 0,
  };
  const seen = new Set<string>();
  for (const item of items) {
    const key = itemKey(item);
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    s.total++;
    if (item.entry.excluded) {
      s.excluded++;
      continue;
    }
    const r = item.result;
    if (!r || r.state === "pending" || r.state === "offline" || r.state === "rate_limited" || r.state === "error" || r.state === "disabled") {
      s.pending++;
      continue;
    }
    if (r.state === "not_scored") {
      s.notScored++;
      continue;
    }
    const score = scoreFor(r.card, basis);
    if (!score) {
      s.notScored++;
      continue;
    }
    s.scored++;
    if (r.stale) s.stale++;
    s.grades[score.grade]++;
    const critical = criticalFindings(r.card);
    if (critical.some((c) => c.gate === "malware")) s.malware++;
    if (critical.some((c) => c.gate === "kev")) s.kev++;
    if (otherGates(r.card).some((g) => gateList.includes(g.id))) s.gated++;
    if (!s.lowest || score.score < s.lowest.score) {
      s.lowest = { score: score.score, grade: score.grade, atMost: score.atMost, label: item.entry.label };
    }
  }
  return s;
}

export interface StatusBarModel {
  text: string;
  tooltipMarkdown: string;
  severity: "none" | "warning" | "error";
}

function deps(n: number): string {
  return `${n} ${n === 1 ? "dep" : "deps"}`;
}

function lowestText(s: Summary): string {
  return s.lowest ? `lowest ${formatScore(s.lowest.score, s.lowest.atMost)} ${s.lowest.grade}` : "";
}

/** Text, tooltip and background of the status bar item. */
export function statusBarModel(summary: Summary, status: NetworkStatus, options: { warningBelow?: number; scope?: string } = {}): StatusBarModel {
  const warningBelow = options.warningBelow ?? 65;
  let text: string;
  let severity: StatusBarModel["severity"] = "none";

  if (status.state === "disabled") {
    text = "$(shield) Semverity off";
  } else if (summary.malware > 0 || summary.kev > 0) {
    text = `$(error) ${deps(summary.total)} · ${summary.malware > 0 ? "malware" : "KEV"}`;
    severity = "error";
  } else if (summary.gated > 0) {
    const low = lowestText(summary);
    text = `$(warning) ${deps(summary.total)} · ${summary.gated} ${summary.gated === 1 ? "gate" : "gates"}${low ? ` · ${low}` : ""}`;
    severity = "warning";
  } else if (summary.scored > 0) {
    text = `$(shield) ${deps(summary.total)} · ${lowestText(summary)}`;
    if (warningBelow > 0 && summary.lowest && Math.round(summary.lowest.score) < warningBelow) severity = "warning";
  } else if (summary.notScored > 0 && summary.pending === 0) {
    // Every answer is in and none is a score (common signed out, where only indexed versions answer).
    text = `$(shield) ${deps(summary.total)} · none scored`;
  } else {
    text = "$(shield) Semverity";
  }
  if (status.state === "offline") text = `$(cloud-offline) ${text}`;
  else if (status.state === "rate_limited") text = `$(watch) ${text}`;

  const lines: string[] = [];
  lines.push(`**Semverity**${options.scope ? ` · ${options.scope}` : ""}`);
  const counts: string[] = [];
  for (const g of GRADE_ORDER) if (summary.grades[g] > 0) counts.push(`${g} ${summary.grades[g]}`);
  if (counts.length > 0) lines.push(`Grades: ${counts.join(" · ")}`);
  const other: string[] = [];
  if (summary.malware > 0) other.push(`${summary.malware} malware`);
  if (summary.kev > 0) other.push(`${summary.kev} KEV`);
  if (summary.gated > 0) other.push(`${summary.gated} with gates`);
  if (summary.notScored > 0) other.push(`${summary.notScored} not scored`);
  if (summary.pending > 0) other.push(`${summary.pending} pending`);
  if (summary.excluded > 0) other.push(`${summary.excluded} excluded`);
  if (summary.stale > 0) other.push(`${summary.stale} cached`);
  if (other.length > 0) lines.push(other.join(" · "));
  lines.push(status.signedIn ? "Signed in with an API key" : "Signed out: public index only");
  switch (status.state) {
    case "ok":
      lines.push("Network lookups on");
      break;
    case "disabled":
      lines.push("Network lookups off: nothing is sent, cached scores only");
      break;
    case "offline":
      lines.push(`The Semverity API is not reachable${status.retryAt ? `; retrying at ${clockTime(status.retryAt)}` : ""}`);
      break;
    case "rate_limited":
      lines.push(`Rate limited by the Semverity API${status.retryAt ? `; resuming at ${clockTime(status.retryAt)}` : ""}`);
      break;
    case "unauthorized":
      lines.push("The API key was refused; looking up signed out");
      break;
  }
  const links = [commandLink("Check Workspace", "semverity.checkWorkspace")];
  links.push(commandLink(status.state === "disabled" ? "Turn lookups on" : "Turn lookups off", "semverity.toggleLookups"));
  lines.push(links.join(" · "));
  return { text, tooltipMarkdown: lines.join("  \n"), severity };
}

/** "12 dependencies · lowest 58 D" for a manifest node. */
export function manifestDescription(summary: Summary): string {
  const parts = [`${summary.total} ${summary.total === 1 ? "dependency" : "dependencies"}`];
  if (summary.malware > 0) parts.push("malware");
  else if (summary.kev > 0) parts.push("KEV");
  const low = lowestText(summary);
  if (low) parts.push(low);
  return parts.join(" · ");
}

function rank(item: SummaryItem): number {
  if (item.entry.excluded) return 5;
  const r = item.result;
  if (!r) return 4;
  if (r.state === "scored") {
    if (criticalFindings(r.card).length > 0) return 0;
    if (otherGates(r.card).some((g) => g.hard)) return 1;
    return scoreFor(r.card, "headline") ? 2 : 3;
  }
  if (r.state === "not_scored") return 3;
  return 4;
}

/** Worst first: malware and KEV, other hard gates, ascending score, not scored, pending, excluded. */
export function treeOrder(a: SummaryItem, b: SummaryItem): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if ((ra === 1 || ra === 2) && a.result?.state === "scored" && b.result?.state === "scored") {
    const sa = scoreFor(a.result.card, "headline")?.score ?? 0;
    const sb = scoreFor(b.result.card, "headline")?.score ?? 0;
    if (sa !== sb) return sa - sb;
  }
  return a.entry.label.localeCompare(b.entry.label);
}
