import { describe, expect, it } from "vitest";
import { pythonDistributionFor, pythonCandidates } from "../../../src/core/mapping/python";

const none = new Set<string>();

describe("pythonDistributionFor", () => {
  it("skips the standard library, relative imports and local modules", () => {
    expect(pythonDistributionFor("os.path", none)).toEqual({ skip: "builtin", detail: "os" });
    expect(pythonDistributionFor("__future__", none)).toEqual({ skip: "builtin", detail: "__future__" });
    expect(pythonDistributionFor("distutils.core", none)).toEqual({ skip: "builtin", detail: "distutils" });
    expect(pythonDistributionFor(".sibling", none)).toEqual({ skip: "relative" });
    expect(pythonDistributionFor("myapp.models", none, { localModules: new Set(["myapp"]) })).toEqual({ skip: "local-module", detail: "myapp" });
  });

  it("uses the curated table for common mismatches", () => {
    expect(pythonDistributionFor("yaml", none)).toEqual({ name: "PyYAML", declared: false });
    expect(pythonDistributionFor("cv2", none)).toEqual({ name: "opencv-python", declared: false });
    expect(pythonDistributionFor("sklearn.linear_model", none)).toEqual({ name: "scikit-learn", declared: false });
    expect(pythonDistributionFor("PIL.Image", none)).toEqual({ name: "Pillow", declared: false });
    expect(pythonDistributionFor("bs4", none)).toEqual({ name: "beautifulsoup4", declared: false });
  });

  it("matches the longest dotted prefix", () => {
    expect(pythonCandidates("google.cloud.storage.blob")).toEqual(["google-cloud-storage"]);
    expect(pythonCandidates("google.protobuf.message")).toEqual(["protobuf"]);
    expect(pythonCandidates("google.cloud.firestore")).toEqual(["google-cloud-firestore"]);
    expect(pythonCandidates("google.cloud.unknownthing")).toEqual(["google"]);
  });

  it("lets declared requirements disambiguate", () => {
    expect(pythonDistributionFor("cv2", new Set(["opencv-python-headless"]))).toEqual({ name: "opencv-python-headless", declared: true });
    expect(pythonDistributionFor("psycopg2", new Set(["psycopg2-binary"]))).toEqual({ name: "psycopg2-binary", declared: true });
    expect(pythonDistributionFor("google.cloud.firestore", new Set(["google-cloud-firestore"]))).toEqual({ name: "google-cloud-firestore", declared: true });
  });

  it("falls back to the top-level name, normalised when declared", () => {
    expect(pythonDistributionFor("requests.adapters", none)).toEqual({ name: "requests", declared: false });
    expect(pythonDistributionFor("typing_extensions", new Set(["typing-extensions"]))).toEqual({ name: "typing-extensions", declared: true });
    expect(pythonDistributionFor("zope_thing", new Set(["zope-thing"]))).toEqual({ name: "zope_thing", declared: true });
  });

  it("maps from-imports of namespace packages through the imported name", () => {
    const declared = new Set(["google-cloud-storage", "google-genai"]);
    expect(pythonDistributionFor("google.cloud", declared, {}, ["storage"])).toEqual({ name: "google-cloud-storage", declared: true });
    expect(pythonDistributionFor("google.cloud", none, {}, ["storage"])).toEqual({ name: "google-cloud-storage", declared: false });
    expect(pythonDistributionFor("google", declared, {}, ["genai"])).toEqual({ name: "google-genai", declared: true });
    expect(pythonDistributionFor("google", none, {}, ["genai"])).toEqual({ name: "google-genai", declared: false });
    // Declared under a dashed name the table does not know.
    expect(pythonDistributionFor("google.cloud", new Set(["google-cloud-run"]), {}, ["run_v2", "run"])).toEqual({ name: "google-cloud-run", declared: true });
    expect(pythonDistributionFor("azure", none, {}, ["identity"])).toEqual({ name: "azure-identity", declared: false });
    // A plain from-import still maps through the module.
    expect(pythonDistributionFor("requests", none, {}, ["Session"])).toEqual({ name: "requests", declared: false });
  });

  it("never falls back to a bare namespace root", () => {
    expect(pythonDistributionFor("google.cloud", none, {}, ["somethingnew"])).toEqual({ skip: "unmapped", detail: "google.cloud" });
    expect(pythonDistributionFor("google", none)).toEqual({ skip: "unmapped", detail: "google" });
    expect(pythonDistributionFor("azure.mgmt.compute", none)).toEqual({ skip: "unmapped", detail: "azure.mgmt.compute" });
    expect(pythonDistributionFor("backports", none, {}, ["zoneinfo"])).toEqual({ skip: "unmapped", detail: "backports" });
  });

  it("treats workspace directories as local unless a manifest declares the name", () => {
    const localDirs = new Set(["acme", "tools"]);
    expect(pythonDistributionFor("acme.platform", none, { localDirs }, ["util"])).toEqual({ skip: "local-module", detail: "acme" });
    expect(pythonDistributionFor("tools", none, { localDirs }, ["build"])).toEqual({ skip: "local-module", detail: "tools" });
    expect(pythonDistributionFor("tools", new Set(["tools"]), { localDirs })).toEqual({ name: "tools", declared: true });
  });

  it("skips the workspace's own project", () => {
    expect(pythonDistributionFor("my_project", none, { selfNames: new Set(["my-project"]) })).toEqual({ skip: "self" });
  });
});
