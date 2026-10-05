// The hover card of an import or manifest dependency (docs/DESIGN.md 9.5). Pure:
// returns Markdown with theme icons; the adapter wraps it in a MarkdownString
// trusted for the Semverity commands only.

import { fromPurl, packagePageUrl } from "../core/api/purl";
import type { Grade } from "../core/api/types";
import { exclusionParts } from "../core/privacy/filter";
import type { AnalysisEntry, CardSummary, Coordinate, ExclusionRule, ListingSummary, LookupResult } from "../core/types";
import { scoreFor } from "./grades";
import { criticalFindings } from "./facts";
import { clockTime, ecosystemLabel, formatScore, gateLabel, isoDate, relativeAge, versionSourceLabel } from "./labels";
import { code, commandLink, escapeMarkdown, inlineMarkdown, urlLink } from "./markdown";

export interface HoverContext {
  siteBaseUrl: string;
  now: number;
  /** The quick fix edit as a command link ("Use 4.18.1"); absent when the manifest cannot be edited. */
  applyCommand?: { title: string; args: unknown };
  /** An API key is set (changes the not-scored text). */
  signedIn?: boolean;
  /** File name of the lockfile that pinned the version, when known. */
  lockfile?: string;
}

const BR = "  \n";

function siteName(siteBaseUrl: string): string {
  try {
    return new URL(siteBaseUrl).host || "semverity.dev";
  } catch {
    return "semverity.dev";
  }
}

function headerLine(entry: AnalysisEntry, result: LookupResult | undefined, ctx: HoverContext): string {
  const target = entry.target;
  const coordinate: Coordinate | undefined =
    result && "coordinate" in result && result.coordinate ? result.coordinate : undefined;
  const ecosystem = coordinate?.ecosystem ?? target?.id.ecosystem;
  const name = coordinate?.name ?? target?.id.name ?? entry.label;
  const version = coordinate?.version ?? target?.version;
  const parts = [`$(shield) **${escapeMarkdown(name)}**${version ? ` ${escapeMarkdown(version)}` : ""}`];
  if (ecosystem) parts.push(ecosystemLabel(ecosystem));
  if (target) {
    parts.push(
      escapeLabel(
        versionSourceLabel(target.versionSource, {
          range: target.range ?? entry.declaredIn?.dependency.spec,
          lockfile: ctx.lockfile,
          declared: entry.declaredIn !== undefined,
        }),
      ),
    );
  }
  return parts.join(" · ");
}

/** An exclusion rule: fixed text escaped, user and workspace supplied values as code spans. */
export function exclusionMarkdown(rule: ExclusionRule): string {
  return exclusionParts(rule)
    .map((p) => ("code" in p ? code(p.code) : escapeMarkdown(p.text)))
    .join("");
}

/** Version source labels hold a code span for the range; keep it, escape the rest. */
function escapeLabel(label: string): string {
  return inlineMarkdown(label);
}

function gradeText(score: number, grade: Grade | "", atMost = false): string {
  return grade ? `${formatScore(score, atMost)} ${grade}` : formatScore(score, atMost);
}

function listingEntryText(listing: ListingSummary, version: string): string | undefined {
  const v = listing.versions.find((x) => x.version === version);
  const s = v?.headline ?? v?.own;
  if (!s) return undefined;
  const atMost = v?.headline ? v.headline.at_most : false;
  return gradeText(s.score, s.grade, atMost);
}

function scoreBlock(card: CardSummary): string {
  const lines: string[] = [];
  const head = card.headline;
  if (head) {
    if (head.basis === "with_dependencies") {
      let line = `**${Math.round(head.score)} ${head.grade}** with dependencies`;
      if (head.at_most && head.coverage !== undefined) {
        line += ` · at most, ${Math.round(head.coverage)}% of dependencies scored`;
      } else if (head.at_most) {
        line += " · at most";
      }
      lines.push(line);
    } else {
      lines.push(`**${Math.round(head.score)} ${head.grade}** own score only, dependencies not scored yet`);
    }
  }
  const own = scoreFor(card, "own");
  const second: string[] = [];
  if (own) second.push(`Own score **${gradeText(own.score, own.grade)}**`);
  if (card.fromListing) {
    // Only the listing's summary so far: no security grade or coverage to show yet.
    second.push("full card loading");
    lines.push(second.join(" · "));
    return lines.join(BR);
  }
  if (card.security?.scored && card.security.grade) {
    second.push(`Security **${card.security.grade}** (${Math.round(card.security.score)})`);
  } else {
    second.push("Security not scored");
  }
  if (Number.isFinite(card.coverage)) second.push(`Evidence coverage ${Math.round(card.coverage)}%`);
  lines.push(second.join(" · "));
  return lines.join(BR);
}

function gatesBlock(card: CardSummary): string | undefined {
  const lines: string[] = [];
  const reasonText = (reason?: string, recommendation?: string): string => {
    const parts: string[] = [];
    if (reason) parts.push(inlineMarkdown(reason.replace(/\.\s*$/, "")));
    if (recommendation) parts.push(inlineMarkdown(recommendation.replace(/\.\s*$/, "")));
    return parts.length ? `: ${parts.join(". ")}` : "";
  };
  const hard = card.gates.filter((g) => g.hard);
  const soft = card.gates.filter((g) => !g.hard);
  const rank = (id: string) => (id === "malware" ? 0 : id === "kev" ? 1 : 2);
  for (const g of [...hard].sort((a, b) => rank(a.id) - rank(b.id))) {
    const icon = g.id === "malware" || g.id === "kev" ? "$(error)" : "$(warning)";
    lines.push(`${icon} ${escapeMarkdown(gateLabel(g.id))}${reasonText(g.reason, g.recommendation)}`);
  }
  for (const f of criticalFindings(card).filter((c) => !c.own)) {
    const what = f.gate === "malware" ? "a package with a malware finding" : "a package affected by a known exploited vulnerability (KEV)";
    lines.push(`$(error) Pulls in ${what}${f.depth !== undefined ? ` (depth ${f.depth})` : ""}`);
  }
  for (const ig of card.inheritedGates) {
    if ((ig.gate === "malware" || ig.gate === "kev") && ig.path_class === "installed") continue;
    const optional = ig.path_class === "optional" ? " through optional dependencies only" : "";
    lines.push(
      `$(warning) Pulls in ${ig.count === 1 ? "a package" : `${ig.count} packages`} with: ${escapeMarkdown(gateLabel(ig.gate))}${optional} (depth ${ig.nearest_depth})`,
    );
  }
  // Soft gates: the warning-level unfixed advisory before the informational ones.
  for (const g of [...soft].sort((a, b) => Number(b.id === "unfixed_high_vuln") - Number(a.id === "unfixed_high_vuln"))) {
    const icon = g.id === "unfixed_high_vuln" ? "$(warning)" : "$(info)";
    lines.push(`${icon} ${escapeMarkdown(gateLabel(g.id))}${reasonText(g.reason, g.recommendation)}`);
  }
  if (lines.length === 0) return undefined;
  return `**Gates**${BR}${lines.join(BR)}`;
}

function lowBlock(card: CardSummary): string | undefined {
  const basis = scoreFor(card, "headline");
  const hardFired = card.gates.some((g) => g.hard) || criticalFindings(card).length > 0;
  if (!(basis && basis.score < 80) && !hardFired) return undefined;
  const items: string[] = [];
  for (const c of card.weakest.filter((w) => w.kind === "weakest" || w.kind === "gate").slice(0, 2)) {
    const coord = fromPurl(c.purl);
    const who = coord ? `${code(coord.name)} ${escapeMarkdown(coord.version)}` : code(c.purl);
    const points = `${c.points.toFixed(1)} points`;
    if (c.kind === "gate") {
      items.push(`- ${who} carries a gate (${escapeMarkdown(gateLabel(c.gate ?? "gate"))}), ${points}`);
    } else {
      const own = c.own !== null ? ` (own ${Math.round(c.own)})` : "";
      items.push(`- Weakest dependency: ${who}${own}, ${points}`);
    }
  }
  const low = [...card.dimensions]
    .filter((d) => d.score < 70)
    .sort((a, b) => a.score - b.score)
    .slice(0, 2);
  if (low.length > 0) {
    items.push(`- Lowest areas: ${low.map((d) => `${escapeMarkdown(d.name ?? gateLabel(d.id))} ${Math.round(d.score)}`).join(", ")}`);
  }
  for (const note of card.notes.slice(0, 2)) items.push(`- ${inlineMarkdown(note)}`);
  if (items.length === 0) return undefined;
  return `**Why the score is low**\n\n${items.join("\n")}`;
}

function healthyBlock(version: string, listing: ListingSummary | undefined, ctx: HoverContext): string | undefined {
  const healthy = listing?.healthy;
  if (!listing || !healthy || healthy === version) return undefined;
  const score = listingEntryText(listing, healthy);
  let line = `**Healthy version:** ${escapeMarkdown(healthy)}${score ? ` (${score})` : ""}`;
  if (ctx.applyCommand) line += ` · ${commandLink(ctx.applyCommand.title, "semverity.applyVersion", ctx.applyCommand.args)}`;
  return line;
}

function latestScoredLine(listing: ListingSummary | undefined, version: string | undefined): string | undefined {
  if (!listing) return undefined;
  // `latestScored` is an optional field the core adds to listings; latest and healthy are the fallbacks.
  const latestScored = (listing as ListingSummary & { latestScored?: string }).latestScored;
  for (const v of [latestScored, listing.latest, listing.healthy]) {
    if (!v || v === version) continue;
    const text = listingEntryText(listing, v);
    if (text) return `Latest scored version: ${escapeMarkdown(v)} (${text})`;
  }
  return undefined;
}

/** The hover Markdown; "" for skipped entries (no hover). */
export function hoverMarkdown(entry: AnalysisEntry, result: LookupResult | undefined, ctx: HoverContext): string {
  if (entry.skip && !entry.excluded) return "";
  const blocks: string[] = [headerLine(entry, result, ctx)];
  const name = entry.target?.id.name ?? entry.label;
  const site = siteName(ctx.siteBaseUrl);

  if (entry.excluded) {
    blocks.push(`Not looked up: ${exclusionMarkdown(entry.excluded.rule)}. Nothing about this package was sent.`);
    return blocks.join("\n\n");
  }
  if (!entry.target) return "";
  const id = entry.target.id;

  if (!result) {
    blocks.push(`Semverity is looking ${escapeMarkdown(name)} up; this updates by itself.`);
    return blocks.join("\n\n");
  }

  switch (result.state) {
    case "scored": {
      const { card, coordinate } = result;
      blocks.push(scoreBlock(card));
      const gates = gatesBlock(card);
      if (gates) blocks.push(gates);
      const low = lowBlock(card);
      if (low) blocks.push(low);
      const healthy = healthyBlock(coordinate.version, result.listing, ctx);
      if (healthy) blocks.push(healthy);
      const footer = [urlLink(`Open on ${site}`, packagePageUrl(ctx.siteBaseUrl, coordinate, coordinate.version))];
      const scored = isoDate(card.evaluatedAt);
      if (scored) footer.push(`scored ${scored}`);
      footer.push(result.stale ? `cached, last checked ${relativeAge(result.validatedAt, ctx.now)}` : `checked ${relativeAge(result.validatedAt, ctx.now)}`);
      blocks.push(footer.join(" · "));
      break;
    }
    case "not_scored": {
      const c = result.coordinate;
      const lines = [
        c
          ? `Semverity has not scored ${escapeMarkdown(c.name)} ${escapeMarkdown(c.version)} yet.`
          : `Semverity has not scored ${escapeMarkdown(name)} yet.`,
      ];
      const latest = latestScoredLine(result.listing, c?.version);
      if (latest) lines.push(latest);
      if (!ctx.signedIn) {
        lines.push(`With an API key, Semverity collects public packages it has not seen (${commandLink("Set API Key", "semverity.setApiKey")}).`);
      }
      blocks.push(lines.join(BR));
      blocks.push(urlLink(`Open on ${site}`, packagePageUrl(ctx.siteBaseUrl, id)));
      break;
    }
    case "pending": {
      const c = result.coordinate;
      const what = c ? `${escapeMarkdown(c.name)} ${escapeMarkdown(c.version)}` : escapeMarkdown(name);
      blocks.push(`Semverity is scoring ${what}; this updates by itself.`);
      break;
    }
    case "disabled":
      blocks.push("Network lookups are off (`semverity.network.enabled`).");
      break;
    case "offline":
      blocks.push(`The Semverity API is not reachable; retrying at ${clockTime(result.retryAt)}.`);
      break;
    case "rate_limited":
      blocks.push(`The Semverity API asked for fewer requests; retrying at ${clockTime(result.retryAt)}.`);
      break;
    case "error": {
      const retry = result.retryAt !== undefined ? `; retrying at ${clockTime(result.retryAt)}` : "";
      blocks.push(`Semverity could not look ${escapeMarkdown(name)} up: ${escapeMarkdown(result.message)}${retry}.`);
      break;
    }
  }
  return blocks.join("\n\n");
}
