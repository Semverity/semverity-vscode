import { describe, expect, it } from "vitest";
import { gradeFor, summarizeCard, summarizeListing } from "../../../src/core/api/summary";
import { apiCard, apiListing } from "../builders";

describe("summarizeCard", () => {
  it("keeps fired gates and trims the rest", () => {
    const s = summarizeCard(
      apiCard("npm", "lodash", "4.17.21", {
        dimensions: [
          { id: "community", name: "Community", score: 40, weight: 1, coverage: 0.5 },
          { id: "security", name: "Security", score: 90, weight: 1, coverage: 1 },
          { id: "practices", score: 52, weight: 1, coverage: 1 },
        ],
        advisory_ids: Array.from({ length: 12 }, (_, i) => `GHSA-${i}`),
        with_dependencies: {
          context: "registry",
          state: "partial",
          score: 74,
          grade: "C",
          coverage: 82,
          drop: 8.8,
          at_most: true,
          inherited_gates: [{ gate: "kev", count: 1, nearest_depth: 2, path_class: "installed", example_path: ["v:0", "v:1"], caps_at: 25 }],
          top: [
            { purl: "pkg:npm/minimist@1.2.0", kind: "weakest", points: 12.3, own: 41, depth: 1, path_class: "installed", path: ["v:0"] },
            { purl: "pkg:npm/a@1", kind: "breadth", points: 1, own: 80, depth: 1, path_class: "installed", path: [] },
            { purl: "pkg:npm/b@1", kind: "breadth", points: 1, own: 80, depth: 1, path_class: "installed", path: [] },
            { purl: "pkg:npm/c@1", kind: "breadth", points: 1, own: 80, depth: 1, path_class: "installed", path: [] },
          ],
        },
      }),
    );
    expect(s?.gates).toEqual([{ id: "no_provenance", hard: false, immutable: false, reason: "no verified build provenance" }]);
    expect(s?.dimensions.map((d) => d.id)).toEqual(["community", "practices", "security"]);
    expect(s?.advisoryIds).toHaveLength(10);
    expect(s?.weakest).toHaveLength(3);
    expect(s?.inheritedGates[0]?.gate).toBe("kev");
    expect(s?.withDependencies).toEqual({ state: "partial", score: 74, grade: "C", coverage: 82, drop: 8.8, atMost: true });
    expect(s?.security).toEqual({ score: 87, grade: "B", scored: true });
    expect(JSON.stringify(s).length).toBeLessThan(2000);
  });

  it("refuses ecosystems the extension does not handle", () => {
    expect(summarizeCard({ ...apiCard("npm", "x", "1.0.0"), ecosystem: "cargo" })).toBeUndefined();
  });
});

describe("summarizeListing", () => {
  it("keeps latest, healthy, the newest scored entry and every version string", () => {
    const s = summarizeListing(apiListing("npm", "lodash", ["4.18.1", "4.17.21", "0.1.0"], { healthy: "4.18.1" }));
    expect(s).toMatchObject({ id: { ecosystem: "npm", name: "lodash" }, latest: "4.18.1", healthy: "4.18.1", latestScored: "4.18.1", allVersions: ["4.18.1", "4.17.21", "0.1.0"] });
    expect(s?.versions.map((v) => v.version)).toEqual(["4.18.1"]);
    expect(s?.versions[0]?.firedGates).toEqual(["no_provenance"]);
  });

  it("grades on Semverity's bands", () => {
    expect([95, 85, 70, 55, 10].map(gradeFor)).toEqual(["A", "B", "C", "D", "F"]);
  });
});
