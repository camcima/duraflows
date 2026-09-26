# Spec: NestJS v12 support in `@duraflows/nestjs` (keeping v11)

| Field          | Value                                                             |
| -------------- | ----------------------------------------------------------------- |
| Status         | Implemented (see §10 for deviations)                              |
| Affected pkg   | `@duraflows/nestjs` (the only package that depends on NestJS)     |
| Release impact | **Minor** (lockstep `5.0.0` → `5.1.0`). No breaking changes       |
| NestJS ranges  | `@nestjs/common` and `@nestjs/core`: `^11.0.0 \|\| ^12.0.0`       |
| References     | [NestJS v11 → v12 migration guide][guide], NestJS `12.1.0` on npm |

[guide]: https://docs.nestjs.com/migration-guide

## 1. Goal

Let applications on NestJS 12 install `@duraflows/nestjs` without peer-dependency
conflicts and use it without behavior changes. Applications on NestJS 11 must keep
working on the same `5.x` line. We are not dropping v11 in this release, so the
release stays a minor.

### Non-goals

- Dropping NestJS 11 or raising `engines.node`. Both would be breaking.
- Using features that exist only in v12, such as Standard Schema `@Body({ schema })`,
  `StandardSchemaValidationPipe`, the `errorCode` in `HttpExceptionOptions`, or
  `routeConflictPolicy`. Any of these would split the code by major version. See §8.
- Replacing `class-validator`/`class-transformer` in the optional REST controllers.
  v12 still supports both.
- Changing how we build: we keep one source tree and the dual ESM + CJS `dist`.

## 2. Current state

`@duraflows/nestjs` is the only package that imports `@nestjs/*`.

```jsonc
// packages/duraflows-nestjs/package.json (today)
"peerDependencies": {
  "@duraflows/core": "^5.0.0",
  "@nestjs/common": "^11.0.0",
  "@nestjs/core": "^11.0.0",
  "reflect-metadata": "^0.2.0"
},
"devDependencies": {
  "@nestjs/common": "^11.1.29",
  "@nestjs/core": "^11.1.29",
  "@nestjs/testing": "^11.1.29",
  ...
}
```

NestJS APIs the package uses:

| Area             | APIs                                                                                                                                    | Files                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Dynamic module   | `Module`, `DynamicModule`, `Provider`, `InjectionToken`, `OptionalFactoryDependency`, `Type`                                            | `src/workflow.module.ts`                                 |
| Discovery        | `DiscoveryModule`, `DiscoveryService.createDecorator`, `getProviders({ metadataKey })`, `getMetadataByDecorator`                        | `src/decorators/*`, `src/providers/command-discovery.ts` |
| DI lookups       | `ModuleRef.get(cls, { strict: false })`, and matching on the `InvalidClassScopeException` name or message                               | `src/providers/nest-command-registry.ts`                 |
| Lifecycle        | `OnModuleInit` (`WorkflowRuntimeInitializer` calls `runtime.initialize()`)                                                              | `src/providers/workflow-runtime-initializer.ts`          |
| HTTP (optional)  | `Controller`, `Get`, `Post`, `Param`, `Query`, `Body`, `UsePipes`, `UseFilters`, `ValidationPipe`, `ParseUUIDPipe`, `NotFoundException` | `src/controllers/*`                                      |
| Exception filter | `Catch`, `ExceptionFilter`, `ArgumentsHost`, `HttpStatus`, `Logger`, and `response.status().send()` (works on Express and Fastify)      | `src/filters/workflow-exception.filter.ts`               |
| DTO validation   | `class-validator` decorators, `class-transformer` `@Type(() => Number)` (a direct dependency)                                           | `src/controllers/dto/*`                                  |

The package compiles twice. The ESM build uses `Node16` resolution and goes to `dist/`.
The CJS build uses `moduleResolution: "Node"` and goes to `dist/cjs/`.

## 3. Impact of each item in the migration guide

| Migration guide item                                                                  | Affects us?            | Why / evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Core packages ship as ESM only**                                                    | **Yes, low risk**      | Our CJS build (`dist/cjs`) calls `require("@nestjs/common")`. In v12 that relies on Node's `require(esm)`, which works without a flag from **Node 20.19+ / 22.12+**. The v12 packages still set top-level `main`/`types`, so the CJS build with `moduleResolution: "Node"` still finds them. Verified in §4.                                                                                                                                                                                                                                                                                                                                               |
| Node.js ≥ 20.19 / 22.12 to run v12                                                    | Docs only              | Our `engines.node` is `>=20`. Raising it would be breaking. NestJS enforces this requirement itself, so we only document it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Lifecycle hooks called by hierarchy level                                             | Review, no code change | Inside a module, v12 now runs `onModuleInit` one hierarchy level at a time, from the lowest level up. v11 called every hook in the module concurrently. Within `WorkflowModule`, `WorkflowRuntimeInitializer` sits above the options, persistence, and registry providers. **Correction (§10):** across modules nothing changes, and `WorkflowModule` is global, so its hooks run before those of non-global modules on both majors. Command classes listed in `commands` are providers of `WorkflowModule`, so any `onModuleInit` they have now runs in a fixed order instead of concurrently. That is safe for us. We will add a regression test (§5.3). |
| `@Optional()` no longer inherited                                                     | No                     | We do not use `@Optional()` and we do not subclass injectables.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Pipe transform signatures / `ArgumentMetadata<T>`                                     | No                     | We have no custom pipes. We only create `ValidationPipe` and `ParseUUIDPipe`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ValidationPipe` loads `class-validator`/`class-transformer` with an async `import()` | **Yes, verify**        | v12 `loadPackage()` now uses `() => import("class-validator")`, where v11 used `require`. Our DTOs register their metadata through our own `class-transformer` import (`@Type(() => Number)`). If the pipe loaded a different copy, `?limit=5` would stay a string and fail `@IsInt()`. §4 shows this does not happen, and §5.3 adds a test so it cannot regress unnoticed.                                                                                                                                                                                                                                                                                |
| HTTP adapter error mapping reworked                                                   | Verify                 | Our filter builds its own response bodies with `status().send()`. §4 shows the same status codes and bodies on v11 and v12, for both Express and our own filter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Structured logging params (`ConsoleLogger`)                                           | No                     | We call `logger.warn(string)` and `logger.error(message, stack: string)`. Only _plain objects_ passed after the message change behavior. A string stack is printed the same way (checked in §4).                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Route conflict diagnostics                                                            | No (opt-in)            | The option is off by default. Our routes do not overlap (see §5.3 for an optional check).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `errorCode` in `HttpExceptionOptions`                                                 | No                     | Our filter builds its own bodies. Possible future work (§8).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `DiscoveryService.createDecorator` / `getMetadataByDecorator`                         | No                     | Both still exist in `@nestjs/core@12.1.0` (checked at runtime).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `InvalidClassScopeException` name and message                                         | No                     | Still exported in v12 with the same message (`"... is marked as a scoped provider ..."`), so `isScopedProviderError()` still matches.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `@nestjs/*/package.json` no longer in `exports`                                       | Tests only             | v12 `exports` has no `./package.json` entry. Our source never reads it. Test helpers must not read it either (see §4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| TypeScript 6 (`nest upgrade` bumps it)                                                | No                     | The v12 `.d.ts` files type-check with our TypeScript `5.9.3`, even with `skipLibCheck: false`. We can move to TS 6 later on its own schedule.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Standard Schema, GraphQL, NATS, Config, Terminus, CLI/webpack/rspack, observability   | No                     | We do not use these packages.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Peer dependencies of `@nestjs/common@12`                                              | No                     | `reflect-metadata: ^0.1.12 \|\| ^0.2.0` fits our `^0.2.0`. `class-validator >=0.13.2` and `class-transformer >=0.4.1` (both optional) fit our `^0.15.1` and `^0.5.1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**Conclusion:** no changes to `src/` are needed. The work is in package metadata,
CI coverage, tests, and docs.

## 4. Evidence (spike run while writing this spec)

Environment: Node `22.22.2`, pnpm `9.15.0`, TypeScript `5.9.3`, NestJS `11.1.29`/`11.2.6` and `12.1.0`.

1. **Monorepo against v12.** Bumped the three `@nestjs/*` devDependencies to `^12.1.0` and widened
   the peers. Results:
   - `pnpm run build` (ESM + CJS): ✅
   - `pnpm run lint`: ✅
   - `pnpm run typecheck`: ✅ (604 passed / 3 skipped, no type errors)
   - `pnpm vitest run packages/duraflows-nestjs`: ✅ 13 files, 103 tests (same as on v11)
   - `tsc -p packages/duraflows-nestjs/tsconfig{,.cjs}.json --noEmit --skipLibCheck false`: ✅
2. **Real consumer apps using the packed tarballs** (`pnpm pack` of `core` + `nestjs`, installed with npm
   next to `@nestjs/{common,core,platform-express}`). We ran the same script four ways: {v11, v12} × {CJS `require`, ESM `import`}.
   It boots `WorkflowModule.forRootAsync({ enableControllers: true })` with in-memory persistence
   and a `@WorkflowCommand`-discovered command, then sends HTTP requests:

   | Request                                                                  | Expected    | v11 CJS | v11 ESM | v12 CJS | v12 ESM |
   | ------------------------------------------------------------------------ | ----------- | ------- | ------- | ------- | ------- |
   | `POST /workflows` (valid)                                                | 201         | ✅      | ✅      | ✅      | ✅      |
   | `POST /workflows` (bad type + unknown prop) → `ValidationPipe`           | 400         | ✅      | ✅      | ✅      | ✅      |
   | `GET /workflows/:uuid` / bad uuid / missing                              | 200/400/404 | ✅      | ✅      | ✅      | ✅      |
   | `GET /:id/events`, `GET /:id/history?limit=5` (`@Type` coercion)         | 200         | ✅      | ✅      | ✅      | ✅      |
   | `GET /:id/history?limit=9999` (`@Max`)                                   | 400         | ✅      | ✅      | ✅      | ✅      |
   | `POST /:id/events/approve` (discovered command runs)                     | 201         | ✅      | ✅      | ✅      | ✅      |
   | Same event again → `InvalidEventError` via filter                        | 409         | ✅      | ✅      | ✅      | ✅      |
   | Event on missing instance → filter                                       | 404         | ✅      | ✅      | ✅      | ✅      |
   | `POST /workflows/timeouts/process?limit=10`                              | 201         | ✅      | ✅      | ✅      | ✅      |
   | Definition warning via `Logger.warn` / `Logger.error(msg, stack)` output | same        | ✅      | ✅      | ✅      | ✅      |

   The CJS runs resolved `dist/cjs/index.js` and the ESM runs resolved `dist/index.js`. On v12,
   both loaded the one ESM copy of `@nestjs/*`, so there are not two copies of the package in memory.
   The only failure in the spike was in the test script itself: it did `require("@nestjs/core/package.json")`,
   which v12's `exports` map blocks. See §3.

## 5. Changes

### 5.1 `packages/duraflows-nestjs/package.json`

```diff
   "peerDependencies": {
     "@duraflows/core": "^5.0.0",
-    "@nestjs/common": "^11.0.0",
-    "@nestjs/core": "^11.0.0",
+    "@nestjs/common": "^11.0.0 || ^12.0.0",
+    "@nestjs/core": "^11.0.0 || ^12.0.0",
     "reflect-metadata": "^0.2.0"
   },
   "devDependencies": {
     "@duraflows/core": "workspace:*",
-    "@nestjs/common": "^11.1.29",
-    "@nestjs/core": "^11.1.29",
-    "@nestjs/testing": "^11.1.29",
+    "@nestjs/common": "^12.1.0",
+    "@nestjs/core": "^12.1.0",
+    "@nestjs/testing": "^12.1.0",
+    "@nestjs/platform-express": "^12.1.0",
     "reflect-metadata": "^0.2.2"
   }
```

- The default workspace (lockfile) targets **v12**, the newest major. A CI matrix job covers
  **v11** (§5.2). Dependabot keeps updating the v12 line without further setup.
- `@nestjs/platform-express` is a new **devDependency only**. The HTTP test in §5.3 needs it.
  It is not a peer, because the filter works on both Express and Fastify.
- Leave `reflect-metadata`, `class-validator`, and `class-transformer` as they are.
- Regenerate `pnpm-lock.yaml` with `pnpm install`. Do not edit it by hand.

### 5.2 CI: NestJS version matrix (`.github/workflows/ci.yml`)

Add a `nestjs-compat` job. It runs the NestJS-related checks once per supported major:

```yaml
nestjs-compat:
  name: nestjs-compat (NestJS ${{ matrix.nest }}, Node ${{ matrix.node }})
  runs-on: ubuntu-latest
  strategy:
    fail-fast: false
    matrix:
      include:
        - { nest: "11", node: "20" }
        - { nest: "12", node: "20" } # 20.x latest ≥ 20.19 → require(esm) unflagged
        - { nest: "12", node: "22" }
  steps:
    - uses: actions/checkout@v7
    - uses: pnpm/action-setup@v6
      with:
        version: 9.15.0
    - uses: actions/setup-node@v7
      with:
        node-version: ${{ matrix.node }}
        cache: "pnpm"
    - run: pnpm install --frozen-lockfile
    - name: Pin NestJS ${{ matrix.nest }}
      if: matrix.nest != '12'
      run: >
        pnpm --filter @duraflows/nestjs add -D
        @nestjs/common@^${{ matrix.nest }}
        @nestjs/core@^${{ matrix.nest }}
        @nestjs/testing@^${{ matrix.nest }}
        @nestjs/platform-express@^${{ matrix.nest }}
    - run: pnpm run build
    - run: pnpm run typecheck
    - run: pnpm vitest run packages/duraflows-nestjs
    - run: node scripts/smoke-nestjs-consumer.mjs # §5.4
```

Notes:

- The pin step changes the lockfile only inside the CI job. Nothing is committed.
- The existing `ci` job (lint, format, coverage on the default v12 workspace) stays as it is.
- Optionally add `{ nest: "11.0.0", node: "20" }` (exact version) to check the lower bound
  we declare. The `^11.0.0` peer range already claims support for it. (Implemented: see §10.3.)

### 5.3 Tests

New file: `packages/duraflows-nestjs/tests/integration/workflow-http.e2e.test.ts`. It starts a real
`NestFactory.create(...)` app on Express, calls `app.listen(0)`, and uses `fetch`. Every current
test uses `Test.createTestingModule()` and calls controller methods directly, so none of them go
through the HTTP pipeline. That pipeline is where v12 changed behavior: the `ValidationPipe` package
loading and the HTTP adapter error mapping. Cases (taken from §4):

1. `ValidationPipe` with `whitelist` + `forbidNonWhitelisted` → 400 for an unknown property or a wrong type.
2. `class-transformer` `@Type(() => Number)` coercion: `?limit=5` → 200, `?limit=9999` → 400.
3. `ParseUUIDPipe` → 400; `NotFoundException` → 404.
4. `WorkflowExceptionFilter`: 404 (`WorkflowInstanceNotFoundError`), 409 (`InvalidEventError`),
   400 (`InvalidArgumentError`), and a sanitized 500 for any other `WorkflowError`. Check both the status and the JSON body.
5. A command discovered through `@WorkflowCommand` runs and the instance moves to the next state.

Lifecycle regression test (in `workflow-module-forrootasync.test.ts`): a `forRootAsync` config
injects a provider from an imported module. ~~That provider's `onModuleInit` must finish before
`WorkflowRuntimeInitializer` calls `runtime.initialize()`.~~ That assumption was wrong: see §10.1.
The test pins the actual ordering instead. Also add one command in `commands` that has its own `onModuleInit`, and check
that `app.init()` still resolves. This case is where v11 (concurrent) and v12 (by level) differ.

Optional, v12 only (skip when the major is below 12): create the app with
`routeConflictPolicy: { duplicate: "error", shadow: "error" }` to show that our controllers
have no overlapping routes.

Tests must not import or `require` `@nestjs/*/package.json`. v12 does not export it (§3).
To branch on the NestJS major, use a `NEST_MAJOR` environment variable that the CI matrix sets,
and default to the lockfile's major when it is not set.

### 5.4 Smoke test of the packed `dist` (`scripts/smoke-nestjs-consumer.mjs`)

vitest runs the TypeScript source through aliases (see `vitest.config.ts`). That means the
**published** `dist/` and `dist/cjs/`, together with the ESM-only v12 packages, are never tested.
That combination is the main new risk (`require(esm)`). The script:

1. Runs `pnpm pack` for `@duraflows/core` and `@duraflows/nestjs` into a temporary directory.
2. Installs both tarballs in a temporary consumer project, next to `@nestjs/{common,core,platform-express}`
   at the job's major, plus `reflect-metadata` and `rxjs`.
3. Runs the same boot-and-request scenario once with `require()` (a `.cjs` entry) and once with
   `import` (a `.mjs` entry). Neither entry uses TypeScript decorators, only
   `WorkflowCommand("x")(Cls)` and `Module({...})(Cls)`.
4. Checks that the CJS run resolved `dist/cjs/index.js` and the ESM run resolved `dist/index.js`.
   Exits non-zero if either run fails.

Because it is a script, the `ci` job does not have to pay for it. Only `nestjs-compat` runs it.

### 5.5 Documentation

- `packages/duraflows-nestjs/README.md` and `docs/nestjs-integration.md`: add a
  "Compatibility" section:
  - Supports NestJS **11 and 12**.
  - With NestJS 12, CommonJS apps need **Node ≥ 20.19 or ≥ 22.12**, because NestJS 12
    is ESM-only and uses `require(esm)`. Jest users on CJS need Node ≥ 24.9 (from the
    migration guide). This is a NestJS requirement, not a duraflows one.
  - No duraflows code changes are needed when you move an app from NestJS 11 to 12.
- `CONTRIBUTING.md`: explain how to run the NestJS 11 test suite locally (the pin command from §5.2).
- `CHANGELOG.md` is generated by release-it from the conventional commit
  (`feat(nestjs): support NestJS v12 alongside v11`), which gives a minor bump.

## 6. Release and versioning

- Lockstep release (`RELEASING.md`): all packages go from `5.0.0` to **`5.1.0`**. A `feat` commit
  gives a minor under the conventionalcommits preset. Widening a peer range is additive, so it is not breaking.
- Keep `engines.node` at `>=20`.
- Before we stop supporting v11 (in a future major), announce it in a minor release's changelog.

## 7. Acceptance criteria

- [ ] `npm i @duraflows/nestjs` next to `@nestjs/{common,core}@12` reports no peer conflict.
      The same holds with `@11`.
- [ ] Default CI (`ci`, `integration`, `osv-scanner`) is green on the v12 lockfile.
- [ ] `nestjs-compat` is green for NestJS 11 and 12: build, typecheck, nestjs tests, and the `dist` smoke test in both CJS and ESM.
- [ ] The new HTTP e2e test and the lifecycle test pass on both majors.
- [ ] Coverage thresholds in `vitest.config.ts` still hold.
- [ ] README and docs describe the supported NestJS and Node versions.
- [ ] No changes to the public API or the runtime behavior of `@duraflows/nestjs`.

## 8. Risks and future work

| Risk / idea                                                                                                           | Mitigation / plan                                                                         |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| An app on NestJS 12 + CJS + Node < 20.19 fails at `require("@nestjs/common")`                                         | It is a NestJS requirement and fails before our code runs. Documented in §5.5.            |
| An app has two copies of `class-transformer`, so the `@Type` metadata our DTOs register is not the one the pipe reads | Same risk as on v11. §5.3 case 2 catches it for our own dependency layout.                |
| A future 12.x minor changes the discovery or lifecycle internals we rely on                                           | `nestjs-compat` runs on every PR. Dependabot bumps v12 in the lockfile.                   |
| The v11 leg of the matrix drifts out of date                                                                          | It resolves `^11` fresh on every run. Drop it in the next major.                          |
| Future: v12 Standard Schema (`@Body({ schema })`) for controller DTOs, `errorCode` in filter bodies                   | Only possible after dropping v11, or behind runtime feature detection. Out of scope here. |

## 9. Implementation checklist (for the follow-up PR)

1. `feat(nestjs): support NestJS v12 alongside v11`: widen the peers, move the devDependencies to v12, add `@nestjs/platform-express`, run `pnpm install`.
2. `test(nestjs): add HTTP e2e and lifecycle-order coverage` (§5.3).
3. `ci: add nestjs-compat matrix and packed-dist smoke test` (§5.2, §5.4).
4. `docs(nestjs): document NestJS 11/12 and Node compatibility` (§5.5).
5. Run `pnpm test && pnpm run lint && pnpm run format:check && pnpm run typecheck` locally. Also run the v11 pin
   locally before opening the PR.

## 10. Implementation notes

Implemented as specified, except for the points below.

### 10.1 Lifecycle ordering: the spec's assumption was wrong (pre-existing, not a v12 change)

§3 and §5.3 assumed that the `onModuleInit` of a module passed to `forRootAsync({ imports })` finishes
before `runtime.initialize()`. It does not, on **either** major. `WorkflowModule` is `global: true`,
and `NestContainer` sets `distance = Number.MAX_VALUE` on every global module. Hooks run by
descending distance, so a global module's hooks run before those of every non-global module.
The v12 by-hierarchy-level change only affects ordering _within_ one module.

- The test in `workflow-module-forrootasync.test.ts` is now a characterization test. It asserts
  `["runtime:initialize", "db:onModuleInit"]`, and it passes on 11.0.0, 11.2.6 and 12.1.0.
  If a future NestJS major changes this, the test fails.
- `docs/nestjs-integration.md` → "Startup Validation" now says that the persistence returned
  from the factory must work as soon as it is constructed. The bundled `pg` `Pool` and Kysely
  adapters connect lazily, so they are fine.
- Out of scope: moving `runtime.initialize()` to `onApplicationBootstrap` would remove this
  limitation, but it changes when startup errors are raised. That belongs in a separate change.

### 10.2 HTTP e2e coverage

- The `InvalidArgumentError` → 400 case cannot be reached over HTTP. The DTOs already reject every
  out-of-range `limit`/`offset` before the runtime sees it. The filter mapping stays covered by
  `tests/unit/workflow-exception.filter.test.ts`.
- The sanitized 500 is reached with an unregistered `workflowName` on `POST /workflows`.
- We skipped the optional `routeConflictPolicy` check and the `NEST_MAJOR` switch. No test needs
  to branch on the NestJS major.

### 10.3 CI matrix

`.github/workflows/ci.yml` → `nestjs-compat` uses a `range` field, so it can also pin the exact
floor version: `11.0.0` (floor), `^11`, and lockfile 12 on Node 20 and on Node 22. Every leg was run
locally before pushing, including the smoke script under Node 20.20.2.

### 10.4 Observed but not actionable

`@nestjs/common@12` depends on `file-type@22`, which declares `engines.node >=22`. On Node 20,
`npm install` prints an `EBADENGINE` warning. Everything still works (smoke test green on Node
20.20.2). The dependency is NestJS's, and Node 20 has been EOL since April 2026.
