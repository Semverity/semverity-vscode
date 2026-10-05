import { describe, expect, it } from "vitest";
import { goModuleFor, guessGoModule, isGoStdlib } from "../../../src/core/mapping/golang";

describe("goModuleFor", () => {
  const ctx = {
    mainModules: new Set(["example.com/me/app"]),
    requires: [
      { path: "github.com/aws/aws-sdk-go-v2", version: "v1.30.0" },
      { path: "github.com/aws/aws-sdk-go-v2/service/s3", version: "v1.58.0" },
      { path: "example.com/forked", version: "v1.0.0" },
      { path: "example.com/local", version: "v0.0.0" },
    ],
    replaces: [
      { from: "example.com/forked", to: "github.com/someone/forked", toVersion: "v1.1.0", local: false, line: 1 },
      { from: "example.com/local", to: "../local", local: true, line: 2 },
    ],
    lookupUndeclared: true,
  };

  it("skips the standard library and the main module", () => {
    expect(isGoStdlib("fmt")).toBe(true);
    expect(isGoStdlib("net/http")).toBe(true);
    expect(isGoStdlib("C")).toBe(true);
    expect(isGoStdlib("golang.org/x/mod")).toBe(false);
    expect(goModuleFor("net/http", ctx)).toEqual({ skip: "builtin", detail: "net/http" });
    expect(goModuleFor("example.com/me/app/internal/db", ctx)).toEqual({ skip: "self", detail: "example.com/me/app" });
  });

  it("picks the longest module prefix at a path boundary", () => {
    expect(goModuleFor("github.com/aws/aws-sdk-go-v2/service/s3/types", ctx)).toEqual({ module: "github.com/aws/aws-sdk-go-v2/service/s3", declared: true, version: "v1.58.0" });
    expect(goModuleFor("github.com/aws/aws-sdk-go-v2/aws", ctx)).toEqual({ module: "github.com/aws/aws-sdk-go-v2", declared: true, version: "v1.30.0" });
    expect(goModuleFor("github.com/aws/aws-sdk-go-v2x/thing", { ...ctx, lookupUndeclared: false })).toEqual({ skip: "undeclared" });
  });

  it("applies replaces", () => {
    expect(goModuleFor("example.com/forked/pkg", ctx)).toEqual({ module: "github.com/someone/forked", declared: true, version: "v1.1.0", requiredAs: "example.com/forked" });
    expect(goModuleFor("example.com/local", ctx)).toEqual({ skip: "non-registry", detail: "replaced by a local directory" });
  });

  it("guesses modules on well-known hosts only", () => {
    expect(guessGoModule("github.com/spf13/cobra/doc")).toBe("github.com/spf13/cobra");
    expect(guessGoModule("github.com/go-redis/redis/v9/internal")).toBe("github.com/go-redis/redis/v9");
    expect(guessGoModule("golang.org/x/sync/errgroup")).toBe("golang.org/x/sync");
    expect(guessGoModule("google.golang.org/grpc/codes")).toBe("google.golang.org/grpc");
    expect(guessGoModule("k8s.io/client-go/kubernetes")).toBe("k8s.io/client-go");
    expect(guessGoModule("gopkg.in/yaml.v3")).toBe("gopkg.in/yaml.v3");
    expect(guessGoModule("gopkg.in/user/name.v2/sub")).toBe("gopkg.in/user/name.v2");
    expect(guessGoModule("git.internal.example/team/lib")).toBeUndefined();
    expect(goModuleFor("git.internal.example/team/lib", ctx)).toEqual({ skip: "unmapped", detail: "not declared in go.mod" });
    expect(goModuleFor("github.com/spf13/cobra", ctx)).toEqual({ module: "github.com/spf13/cobra", declared: false });
  });
});
