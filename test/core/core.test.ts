import { describe, expect, it } from "vitest";
import { createCore, targetKey, type CoreOptions } from "../../src/core";
import { fromPurl } from "../../src/core/api/purl";
import { FakeClock } from "../helpers/fakeClock";
import { FakeFetch, json } from "../helpers/fakeFetch";
import { MemoryFiles } from "../helpers/memoryFiles";
import { MemoryStore } from "../helpers/memoryStore";
import { ROOT, WORKSPACE } from "../fixtures/workspace";
import { apiCard, must } from "./builders";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const options: CoreOptions = {
  apiBaseUrl: "https://api.semverity.dev",
  userAgent: "semverity-vscode/0.1.0",
  ecosystems: { npm: true, pypi: true, golang: true },
  networkEnabled: true,
  excludePatterns: [],
  excludeNpmrcScopes: true,
  trustedRegistryHosts: [],
  lookupUndeclaredImports: true,
  cacheTtlMs: 24 * 3_600_000,
  negativeTtlMs: 3_600_000,
  maxRequestsPerMinute: 20,
  goPrivate: "",
};

function setup() {
  const clock = new FakeClock();
  const fake = new FakeFetch(() => clock.now());
  fake.on("POST", "/v1/packages:batch", (req) => {
    const purls = (JSON.parse(req.body ?? "{}") as { purls: string[] }).purls;
    return json(200, {
      cards: purls.map((p) => {
        const c = must(fromPurl(p));
        return apiCard(c.ecosystem, c.name, c.version);
      }),
    });
  });
  fake.on("GET", /\/versions\//, (req) => {
    const m = must(/^\/v1\/packages\/(npm|pypi|golang)\/(.+)\/versions\/(.+)$/.exec(req.path));
    return json(200, apiCard(m[1] as "npm", must(m[2]), decodeURIComponent(must(m[3]))));
  });
  const files = new MemoryFiles([ROOT]).add(WORKSPACE);
  const core = createCore({ options, fetch: fake.fetch, clock, store: new MemoryStore(), files, secrets: { getApiKey: () => Promise.resolve(undefined) }, logger: silent });
  return { clock, fake, files, core };
}

describe("createCore", () => {
  it("analyses a document and looks up its targets", async () => {
    const { clock, fake, files, core } = setup();
    // Without the private index file, the undeclared numpy import is looked up too.
    files.files.delete(`${ROOT}/py/requirements-private.txt`);
    let changed = 0;
    core.workspace.onDidChange(() => changed++);
    await core.workspace.rebuild();
    expect(changed).toBe(1);
    const uri = `${ROOT}/py/app/main.py`;
    const analysis = core.analyze({ uri, languageId: "python", text: must(files.files.get(uri)) });
    const targets = analysis.entries.flatMap((e) => (e.target ? [e.target] : []));
    expect(targets.map((t) => t.id.name)).toEqual(["requests", "PyYAML", "opencv-python-headless", "httpx", "numpy", "internal_tool"]);
    const versioned = targets.filter((t) => t.version !== undefined);
    const updated: string[] = [];
    core.lookups.onDidUpdate((keys) => updated.push(...keys));
    core.lookups.request(versioned, "visible");
    await clock.advance(200);
    expect(fake.requests).toHaveLength(1);
    expect(updated.sort()).toEqual(versioned.map(targetKey).sort());
    expect(core.lookups.peek(must(versioned[0]))?.state).toBe("scored");
    core.dispose();
  });

  it("applies new options: exclusions drop queued work and the network switch", async () => {
    const { clock, fake, files, core } = setup();
    await core.workspace.rebuild();
    const uri = `${ROOT}/py/app/main.py`;
    const targets = core.analyze({ uri, languageId: "python", text: must(files.files.get(uri)) }).entries.flatMap((e) => (e.target?.version ? [e.target] : []));
    core.lookups.request(targets, "visible");
    core.updateOptions({ ...options, excludePatterns: ["pypi:requests"] });
    await clock.advance(200);
    expect(fake.requests.map((r) => r.path)).toEqual(["/v1/packages/pypi/httpx/versions/0.27.2"]);
    const after = core.analyze({ uri, languageId: "python", text: must(files.files.get(uri)) });
    expect(after.entries.find((e) => e.label === "requests")?.excluded).toEqual({ rule: { kind: "pattern", pattern: "pypi:requests" } });
    core.updateOptions({ ...options, networkEnabled: false });
    expect(core.lookups.status().state).toBe("disabled");
    core.dispose();
  });
});
