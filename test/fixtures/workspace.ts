// A small hand-written workspace for the resolver tests: an npm monorepo with
// a root lockfile and a private scope, a Python project with requirements,
// a private index and a local package, and a Go module with replaces. Kept as
// strings so nothing here is compiled, linted or picked up by npm.

export const ROOT = "file:///ws";

export const WORKSPACE: Record<string, string> = {
  "package.json": JSON.stringify(
    {
      name: "acme-monorepo",
      private: true,
      workspaces: ["packages/*"],
      devDependencies: { typescript: "^5.4.0" },
    },
    null,
    2,
  ),
  "package-lock.json": JSON.stringify({
    name: "acme-monorepo",
    lockfileVersion: 3,
    packages: {
      "": { name: "acme-monorepo" },
      "node_modules/lodash": { version: "4.17.21", resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz" },
      "packages/web/node_modules/lodash": { version: "4.17.20", resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz" },
      "node_modules/react": { version: "18.3.1", resolved: "https://registry.npmjs.org/react/-/react-18.3.1.tgz" },
      "node_modules/typescript": { version: "5.6.3", resolved: "https://registry.npmjs.org/typescript/-/typescript-5.6.3.tgz" },
      "node_modules/@acme/ui": { resolved: "packages/ui", link: true },
      "node_modules/@acme/private": { version: "1.4.0", resolved: "https://npm.acme.example/@acme/private/-/private-1.4.0.tgz" },
      "node_modules/chalk-alias": { name: "chalk", version: "5.3.0", resolved: "https://registry.npmjs.org/chalk/-/chalk-5.3.0.tgz" },
      "node_modules/left-pad": { version: "1.3.0", resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz" },
      "node_modules/mirror-only": { version: "2.0.0", resolved: "https://registry.mirror.example/mirror-only/-/mirror-only-2.0.0.tgz" },
    },
  }),
  ".npmrc": ["@acme:registry=https://npm.acme.example/", "//npm.acme.example/:_authToken=${NPM_TOKEN}"].join("\n"),
  "packages/web/package.json": `{
  "name": "@acme/web",
  "dependencies": {
    "lodash": "^4.17.0",
    "react": "^18.2.0",
    "@acme/ui": "workspace:*",
    "@acme/private": "^1.0.0",
    "chalk-alias": "npm:chalk@^5.3.0",
    "zod": "^3.23.0",
    "next": "latest"
  }
}`,
  "packages/web/tsconfig.json": `{
  // aliases
  "compilerOptions": { "baseUrl": "./src", "paths": { "@app/*": ["./src/app/*"] } }
}`,
  "packages/web/src/components/Button.tsx": "export const Button = () => null;\n",
  "packages/web/src/index.ts": [
    'import fp from "lodash/fp";',
    'import React from "react";',
    'import { Card } from "@acme/ui";',
    'import secret from "@acme/private";',
    'import local from "./local";',
    'import fs from "node:fs";',
    'import { store } from "@app/store";',
    'import { Button } from "components/Button";',
    'import chalk from "chalk-alias";',
    'import { z } from "zod";',
    'const pad = require("left-pad");',
    'import express from "express";',
    'import mirrored from "mirror-only";',
  ].join("\n"),
  "packages/ui/package.json": '{ "name": "@acme/ui", "version": "0.0.0" }',

  "py/requirements.txt": ["requests==2.31.0", "PyYAML>=6.0", "opencv-python-headless", "-e ./localpkg#egg=localpkg"].join("\n"),
  "py/requirements-private.txt": ["--index-url https://pypi.acme.example/simple", "internal-tool==1.0"].join("\n"),
  "py/pyproject.toml": '[project]\nname = "py-service"\ndependencies = ["httpx>=0.27"]\n',
  "py/uv.lock": 'version = 1\n\n[[package]]\nname = "httpx"\nversion = "0.27.2"\nsource = { registry = "https://pypi.org/simple" }\n',
  "py/app/__init__.py": "",
  "py/app/models.py": "",
  "py/app/main.py": [
    "import os",
    "import requests",
    "import yaml",
    "import cv2",
    "from app.models import User",
    "import httpx",
    "import numpy as np",
    "import internal_tool",
    "import py_service",
  ].join("\n"),

  "go/go.mod": `module example.com/acme/svc

go 1.22

require (
\tgithub.com/stretchr/testify v1.9.0
\tgithub.com/aws/aws-sdk-go-v2 v1.30.0
\tgithub.com/aws/aws-sdk-go-v2/service/s3 v1.58.0
\texample.com/forked v1.0.0
\texample.com/local v0.0.0-00010101000000-000000000000
\tgit.corp.example/team/lib v1.2.0
)

replace example.com/forked => github.com/someone/forked v1.1.0

replace example.com/local => ../local
`,
  "go/main.go": `package main

import (
\t"fmt"
\t"github.com/stretchr/testify/assert"
\t"github.com/aws/aws-sdk-go-v2/service/s3"
\t"github.com/aws/aws-sdk-go-v2/aws"
\t"example.com/forked/pkg"
\t"example.com/local"
\t"example.com/acme/svc/internal/db"
\t"github.com/spf13/cobra"
\t"git.unknown.example/x/y"
\t"git.corp.example/team/lib/sub"
)

func main() {}
`,
};
