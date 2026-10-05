// The healthy-version edit shared by the hover's "Use" link and the quick fix.

import type { Core } from "../core/index";
import type { AnalysisEntry, ListingSummary, LookupResult } from "../core/types";
import { bumpEdit, bumpTitle, type ManifestEdit } from "../presentation/quickfix";

export interface HealthyEdit {
  name: string;
  from: string;
  to: string;
  title: string;
  edit: ManifestEdit;
}

/** Resolves within `ms`, or with undefined. Never rejects. */
export function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/** The listing of an entry's package: the cached one on the result, else fetched (bounded wait). */
export async function listingFor(core: Core, entry: AnalysisEntry, result: LookupResult | undefined, ms = 3000): Promise<ListingSummary | undefined> {
  if (result && (result.state === "scored" || result.state === "not_scored") && result.listing) return result.listing;
  if (!entry.target) return undefined;
  if (core.lookups.status().state === "disabled") return undefined;
  return within(core.lookups.listing(entry.target.id), ms);
}

/**
 * The listing without waiting on the network: the one on the result, else the
 * cached one (the lookup service answers a cached listing at once, before the
 * zero wait runs out). A listing that is not cached is requested in the
 * background and is there on the next call. For the quick fix, which VS Code
 * asks for on every cursor move over a diagnostic.
 */
export function listingNow(core: Core, entry: AnalysisEntry, result: LookupResult | undefined): Promise<ListingSummary | undefined> {
  return listingFor(core, entry, result, 0);
}

/** The manifest edit to the healthy version, when there is one and the manifest can be edited. */
export function healthyEdit(entry: AnalysisEntry, result: LookupResult | undefined, listing: ListingSummary | undefined): HealthyEdit | undefined {
  if (!result || result.state !== "scored" || !listing?.healthy) return undefined;
  const from = result.coordinate.version;
  const to = listing.healthy;
  if (to === from || !entry.declaredIn) return undefined;
  // A go.mod replace looks up the replacement module, but the require line
  // names the original one: its version is not the replacement's to change.
  if (entry.declaredIn.manifestKind === "go.mod" && entry.target && entry.target.id.name !== entry.declaredIn.dependency.name) return undefined;
  const edit = bumpEdit(entry.declaredIn, to);
  if (!edit) return undefined;
  const name = result.coordinate.name;
  return { name, from, to, title: bumpTitle(name, from, to), edit };
}
