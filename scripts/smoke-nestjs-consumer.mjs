#!/usr/bin/env node
// Smoke-tests the *published* shape of @duraflows/nestjs against the NestJS
// major installed in the workspace.
//
// vitest runs the TypeScript sources through aliases, so it never loads
// dist/ or dist/cjs/. This script packs @duraflows/core and @duraflows/nestjs,
// installs the tarballs into a throwaway consumer next to the same
// @nestjs/{common,core,platform-express} versions the workspace resolved, and
// boots a real HTTP app twice: once through require() (CJS build) and once
// through import (ESM build). On NestJS 12, whose packages are ESM-only, the
// CJS run exercises Node's require(esm).
//
// Run after `pnpm run build`:  node scripts/smoke-nestjs-consumer.mjs

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const nestjsPkgDir = join(repoRoot, "packages/duraflows-nestjs");
const corePkgDir = join(repoRoot, "packages/duraflows-core");

// Read versions from disk: NestJS 12 no longer exports ./package.json, so
// require("@nestjs/core/package.json") is not an option.
function installedVersion(name) {
  const manifest = join(nestjsPkgDir, "node_modules", name, "package.json");
  return JSON.parse(readFileSync(manifest, "utf8")).version;
}

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

const nestVersions = {
  "@nestjs/common": installedVersion("@nestjs/common"),
  "@nestjs/core": installedVersion("@nestjs/core"),
  "@nestjs/platform-express": installedVersion("@nestjs/platform-express"),
};

const workDir = mkdtempSync(join(tmpdir(), "duraflows-nestjs-smoke-"));
const tarballDir = join(workDir, "tarballs");
const consumerDir = join(workDir, "consumer");

// Shared by both entrypoints. Plain JS (no TS decorators) so it runs as-is
// under Node; decorators are applied as functions.
const SCENARIO = String.raw`
"use strict";
module.exports = async function scenario({ common, core, duraflows }) {
  const { Module } = common;
  const { NestFactory } = core;
  const { WorkflowModule, WorkflowCommand } = duraflows;

  const instances = new Map();
  const history = [];
  const persistence = {
    instanceStore: {
      async create(i) { instances.set(i.uuid, structuredClone(i)); },
      async findByUuid(u) { return instances.get(u) ?? null; },
      async lockByUuid(u) { return instances.get(u) ?? null; },
      async update(i) { instances.set(i.uuid, structuredClone(i)); },
      async findExpired() { return []; },
    },
    historyStore: {
      async append(e) { history.push(e); return "h-" + history.length; },
      async findByInstanceUuid(u) { return history.filter((h) => h.workflowInstanceUuid === u); },
    },
    transactionRunner: { async runInTransaction(cb) { return cb(); } },
  };

  class ApproveCommand {
    async execute() { return { ok: true, code: "APPROVED" }; }
  }
  WorkflowCommand("smoke-approve")(ApproveCommand);

  const workflow = {
    name: "smoke-order",
    initialState: "pending",
    states: {
      pending: { events: { approve: { targetState: "approved", commands: [{ name: "smoke-approve" }] } } },
      approved: {},
    },
  };

  class AppModule {}
  Module({
    imports: [
      WorkflowModule.forRootAsync({
        enableControllers: true,
        useFactory: async () => ({ workflows: [workflow], persistence }),
      }),
    ],
    providers: [ApproveCommand],
  })(AppModule);

  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, "127.0.0.1");
  const base = "http://127.0.0.1:" + app.getHttpServer().address().port;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const failures = [];
  const expectStatus = (label, actual, expected) => {
    if (actual !== expected) failures.push(label + ": expected " + expected + ", got " + actual);
  };

  try {
    const created = await call("POST", "/workflows", { workflowName: "smoke-order" });
    expectStatus("create", created.status, 201);
    const uuid = created.body && created.body.uuid;

    expectStatus("get", (await call("GET", "/workflows/" + uuid)).status, 200);
    expectStatus("get malformed uuid", (await call("GET", "/workflows/not-a-uuid")).status, 400);
    expectStatus("validation", (await call("POST", "/workflows", { workflowName: 1, extra: true })).status, 400);
    expectStatus("available events", (await call("GET", "/workflows/" + uuid + "/events")).status, 200);
    expectStatus("trigger", (await call("POST", "/workflows/" + uuid + "/events/approve", {})).status, 201);
    expectStatus("trigger again (filter 409)", (await call("POST", "/workflows/" + uuid + "/events/approve", {})).status, 409);
    expectStatus("history @Type coercion", (await call("GET", "/workflows/" + uuid + "/history?limit=5")).status, 200);
    expectStatus("history @Max", (await call("GET", "/workflows/" + uuid + "/history?limit=9999")).status, 400);
    expectStatus("timeouts", (await call("POST", "/workflows/timeouts/process?limit=10")).status, 201);
    const state = instances.get(uuid) && instances.get(uuid).currentState;
    if (state !== "approved") failures.push("final state: expected approved, got " + state);
  } finally {
    await app.close();
  }
  return failures;
};
`;

const CJS_ENTRY = String.raw`
"use strict";
require("reflect-metadata");
const scenario = require("./scenario.cjs");
scenario({ common: require("@nestjs/common"), core: require("@nestjs/core"), duraflows: require("@duraflows/nestjs") })
  .then((failures) => {
    console.log(JSON.stringify({ entry: require.resolve("@duraflows/nestjs"), failures }));
  })
  .catch((error) => { console.error(error); process.exit(1); });
`;

const ESM_ENTRY = String.raw`
import "reflect-metadata";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const scenario = createRequire(import.meta.url)("./scenario.cjs");
const failures = await scenario({
  common: await import("@nestjs/common"),
  core: await import("@nestjs/core"),
  duraflows: await import("@duraflows/nestjs"),
});
console.log(JSON.stringify({ entry: fileURLToPath(import.meta.resolve("@duraflows/nestjs")), failures }));
`;

let failed = false;
try {
  console.log(`NestJS under test: ${JSON.stringify(nestVersions)} on Node ${process.version}`);

  run("pnpm", ["pack", "--pack-destination", tarballDir], corePkgDir);
  run("pnpm", ["pack", "--pack-destination", tarballDir], nestjsPkgDir);
  const tarballs = readdirSync(tarballDir).map((f) => join(tarballDir, f));

  mkdirSync(consumerDir);
  writeFileSync(join(consumerDir, "package.json"), JSON.stringify({ name: "smoke-consumer", private: true }));
  writeFileSync(join(consumerDir, "scenario.cjs"), SCENARIO);
  writeFileSync(join(consumerDir, "main.cjs"), CJS_ENTRY);
  writeFileSync(join(consumerDir, "main.mjs"), ESM_ENTRY);

  run(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      ...Object.entries(nestVersions).map(([name, version]) => `${name}@${version}`),
      "reflect-metadata@^0.2.0",
      "rxjs@^7.1.0",
      ...tarballs,
    ],
    consumerDir,
  );

  const cases = [
    { name: "CJS (require)", file: "main.cjs", expectedEntry: join("dist", "cjs", "index.js") },
    { name: "ESM (import)", file: "main.mjs", expectedEntry: join("dist", "index.js") },
  ];
  for (const c of cases) {
    const output = run(process.execPath, [c.file], consumerDir).trim().split("\n").pop();
    const { entry, failures } = JSON.parse(output);
    const problems = [...failures];
    if (!entry.endsWith(join("@duraflows", "nestjs", c.expectedEntry))) {
      problems.push(`resolved ${entry}, expected .../${c.expectedEntry}`);
    }
    if (problems.length > 0) {
      failed = true;
      console.error(`✗ ${c.name}\n  - ${problems.join("\n  - ")}`);
    } else {
      console.log(`✓ ${c.name} → ${c.expectedEntry}`);
    }
  }
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
