# Changelog

## [4.0.1](https://github.com/camcima/duraflows/compare/v4.0.0...v4.0.1) (2026-08-15)

### Bug Fixes

* **adapters:** throw WorkflowError from transaction-scoped store methods ([#73](https://github.com/camcima/duraflows/issues/73)) ([0b43ad2](https://github.com/camcima/duraflows/commit/0b43ad2a59ee3b42738cb9f4ffade655615dbdcd))

## [4.0.0](https://github.com/camcima/duraflows/compare/v3.1.0...v4.0.0) (2026-07-10)

### ⚠ BREAKING CHANGES

* **core:** ProcessExpiredWorkflowsResult gains a required `businessFailed` field.
* **core:** stricter input validation — `processExpiredWorkflows` `limit`, `getHistory` `limit`/`offset`, and the `WorkflowRuntime` `maxOnEnterDepth` option now throw `InvalidArgumentError` for non-positive or unsafe-integer values, and non-finite timeout durations now fail definition validation.
* **kysely:** KyselyTransactionContext.getTransaction() and .run() now require the owning Kysely instance (or bound transaction) as their first argument.
* **pg:** PgTransactionContext.getClient() and .run() now require the owning Pool as their first argument.

### Bug Fixes

* **core:** contain async onObserverError handler rejections ([5601550](https://github.com/camcima/duraflows/commit/5601550a75f7da8de522c3131135e2b4b84b6cde))
* **core:** contain throwing onObserverError handlers (AR-02) ([32b302c](https://github.com/camcima/duraflows/commit/32b302c1e00d457406b37b9af59acd16ba9eb6a5))
* **core:** reject NaN and infinite timeout durations (AR-04) ([431d3c5](https://github.com/camcima/duraflows/commit/431d3c5a5727ba1cf0f42bac8d08fdb535c35f95))
* **core:** report timeout on-enter business failures in batch result (AR-03) ([5ef087d](https://github.com/camcima/duraflows/commit/5ef087dce2f7f83bd26073fdbc4b9311bc8402e6))
* **core,nestjs:** validate limit/offset/maxOnEnterDepth at public boundaries (AR-05) ([4ac6690](https://github.com/camcima/duraflows/commit/4ac6690e3f631a2c8bf99c18c6a7ad6a81bcd779))
* **kysely:** scope transaction context to its Kysely instance (AR-01) ([c79b10e](https://github.com/camcima/duraflows/commit/c79b10e6767d0e477b371af9f3d96d222214d876))
* **pg:** do not mask transaction errors with ROLLBACK failures ([b2f058f](https://github.com/camcima/duraflows/commit/b2f058f3953f13d611c85808f14fb793a386187a))
* **pg:** scope transaction context to its Pool instance (AR-01) ([88e6673](https://github.com/camcima/duraflows/commit/88e6673f7b96f2f9647f87a354cd9b98b50af587))

## [3.1.0](https://github.com/camcima/duraflows/compare/v3.0.0...v3.1.0) (2026-06-23)

### Bug Fixes

* **deps:** upgrade @camcima/finita to v4 ([99c0464](https://github.com/camcima/duraflows/commit/99c04645c0a19a506dedbfb5c1dd00ca98823896))

## [3.0.0](https://github.com/camcima/duraflows/compare/v2.1.0...v3.0.0) (2026-06-23)

### ⚠ BREAKING CHANGES

* **deps:** pg (^8.13.0) is now a peerDependency of @duraflows/pg and kysely (^0.29.2) a peerDependency of @duraflows/kysely. Consumers already install both per the documented setup, so most projects need no change.
* **deps:** @nestjs/common, @nestjs/core, and @duraflows/core are now peerDependencies of the adapter packages; vitest is an optional peer of @duraflows/core (required only for @duraflows/core/testing). The unused pg peer of @duraflows/kysely was removed.

### Features

* **core:** surface validation warnings at registration time ([73aa15d](https://github.com/camcima/duraflows/commit/73aa15de0601e109bf12670ee286f36d2f02274a))
* **core:** warn about states unreachable from the initial state ([bf80428](https://github.com/camcima/duraflows/commit/bf80428382c8d35e89e42003d7d4f0b8ec156206))
* **nestjs:** map workflow domain errors to 404/409 via exception filter ([87d8db8](https://github.com/camcima/duraflows/commit/87d8db81918eef6e7cdae7a55049527c608f51d3))
* **core:** add WorkflowInstanceNotFoundError for typed not-found handling ([2944a3c](https://github.com/camcima/duraflows/commit/2944a3cf3b4dc277e9174125fb6ca39d7addf197))

### Bug Fixes

* **nestjs:** scope-aware command-resolution errors and log the real cause ([c72567d](https://github.com/camcima/duraflows/commit/c72567d20982345ecaebc34a823f19edde8ee0a7))
* **deps:** make pg and kysely peerDependencies of their adapters ([eaab37c](https://github.com/camcima/duraflows/commit/eaab37c9fee4262ad832a5b07582947c73441af8))
* **nestjs:** accept OptionalFactoryDependency in forRootAsync inject ([2ba9b30](https://github.com/camcima/duraflows/commit/2ba9b304084cee503dbdb35331029fcac3f91620))
* **core:** allocate collision-free mermaid node ids ([bf548cd](https://github.com/camcima/duraflows/commit/bf548cdb7ffd9276a8e4371f7be667032f006021))
* **core:** make deepFreeze cycle-safe for Maps and Sets ([2e3ed65](https://github.com/camcima/duraflows/commit/2e3ed6552ea22efcb23fb5072399cb43d3c735b5))
* **nestjs:** make exception filter platform-agnostic and log unmapped errors ([0b1774d](https://github.com/camcima/duraflows/commit/0b1774dfdd7a446695da0f4a6f54d3160d89b4ea))
* **core:** mark WorkflowExecutionContext.now readonly ([4ab843a](https://github.com/camcima/duraflows/commit/4ab843a4ff9086b2c985cb0c46cce6a193084e3e))
* exclude build cache and dead source maps from tarballs, add sideEffects flag ([d74fe39](https://github.com/camcima/duraflows/commit/d74fe3972f13224c4626c234ead3630a0d32e3a8))
* **nestjs:** clear error when a command provider is not singleton-scoped ([df31c72](https://github.com/camcima/duraflows/commit/df31c72ce14420cae745abe0229ff05167a1523b))
* **nestjs:** type-correlate forRootAsync inject tuple with factory params ([6428a9a](https://github.com/camcima/duraflows/commit/6428a9a7d7a1aec2c84101d7bbb040476dbf1adf))
* **core:** sanitize mermaid node ids and escape diagram labels ([e230ce9](https://github.com/camcima/duraflows/commit/e230ce95cf576d925980bb52377865e2f6eb9455))
* **core:** clone triggerMetadata into history, run no-onEnter create in a transaction ([80a095f](https://github.com/camcima/duraflows/commit/80a095f3dfdc89d9c4606bdc1081af09397e37fb))
* **adapters:** stable history ordering with uuid tie-breaker ([ab2f745](https://github.com/camcima/duraflows/commit/ab2f74582270d9f520deeb2c9654c7ff285a373d))
* **core:** make deepFreeze neutralize Map/Set mutators and freeze their entries ([a4c86db](https://github.com/camcima/duraflows/commit/a4c86db49391399a0a95df3e2a02de6d03f2fe07))
* **nestjs:** bound and type numeric query params, reject unknown fields ([6e385c9](https://github.com/camcima/duraflows/commit/6e385c9af36e0af146681355d25f8abb5ed0a59b))
* **deps:** reclassify framework and core packages as peerDependencies ([a917257](https://github.com/camcima/duraflows/commit/a9172579fecbf5ce48d5ae370ae65ab49341b63d))
* **pg:** ship sql/ migrations in the npm tarball and document the full migration set ([bd58fbb](https://github.com/camcima/duraflows/commit/bd58fbb196ada4db8d392a2147d956026b354e4b))

## [2.1.0](https://github.com/camcima/duraflows/compare/v1.1.0...v2.1.0) (2026-05-30)

### ⚠ BREAKING CHANGES

* **core:** @duraflows/core now depends on @camcima/finita ^3.0.0,
which requires Node.js >= 20. The duraflows error contract is unchanged:
WorkflowCompiler.compile() still throws WorkflowDefinitionError and
EventExecutor.execute() still throws WorkflowError / InvalidEventError /
CommandFailureError. Specific message text for "unknown target state",
"unknown error state", and "missing initial state" cases now originates
from ProcessBuilder.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

### Features

* **core:** upgrade to @camcima/finita v3 ([ddfa91c](https://github.com/camcima/duraflows/commit/ddfa91c97667da21eba458dad59821f80ba39a45))
* improve type-safety and others minor changes ([#36](https://github.com/camcima/duraflows/issues/36)) ([d65993b](https://github.com/camcima/duraflows/commit/d65993b74455d38b142ff8d73ee02270d4f60eac))

### Bug Fixes

* **core:** merge target/error transitions when both lead to the same state ([8dbbf6b](https://github.com/camcima/duraflows/commit/8dbbf6bf204925519c504d45348ad3016c49ddab))

## [1.1.0](https://github.com/camcima/duraflows/compare/v1.0.0...v1.1.0) (2026-04-27)

### Features

* complete public guard API exports ([ceb79f8](https://github.com/camcima/duraflows/commit/ceb79f843518446e2401db46c886b2df82fde727))
* **core:** add guard types and widen outcome to include "guard-rejected" ([8238d47](https://github.com/camcima/duraflows/commit/8238d4713b3bded723d9478d2c7f7001cae1d2cf))
* **core:** add WorkflowGuardRegistry and InMemoryGuardRegistry ([19e16d6](https://github.com/camcima/duraflows/commit/19e16d6d9349cdf32df6c7b0f502ddcaeeee3491))
* **core:** eventExecutor evaluates guard before commands ([9f765cc](https://github.com/camcima/duraflows/commit/9f765cc7c43234314f96c04ee48f101b8f25f457))
* **core:** validate guard refs against knownGuardNames ([3196811](https://github.com/camcima/duraflows/commit/3196811fe2f82c115f062e2a7fa28f4f31945212))
* **core:** wire guardRegistry into WorkflowRuntime; persist rejections ([1843499](https://github.com/camcima/duraflows/commit/1843499b52b8c1bb5af123eca6be3634d50f5885))
* **nestjs:** add guards/guardRegistry options to WorkflowModule ([d9c248b](https://github.com/camcima/duraflows/commit/d9c248b4978a29ca4759a658a63479ccb9495e77))
* **pg:** persist guard-rejected outcome with rejected_by column ([b136672](https://github.com/camcima/duraflows/commit/b136672393dc2f79476998fc2b0ecbb6983b0535))

### Bug Fixes

* address copilot review feedback on event guards ([33040e2](https://github.com/camcima/duraflows/commit/33040e205cd012545fa612b057f5d51fc945bf4c))
* address final code-review blockers for event guards ([55bf4fd](https://github.com/camcima/duraflows/commit/55bf4fd0b93210b6323bb9e91f81c183d4e35669))
* **core:** apply Task 5 review fixes ([66db778](https://github.com/camcima/duraflows/commit/66db77856f9c6e92ae8f35af94481ea717fbf969))
* **core:** isolate guard's context.context from the persisted state ([3bb6369](https://github.com/camcima/duraflows/commit/3bb6369876692414b250b175ae98acf4315318b2))
* **kysely:** persist and read rejectedBy on history records ([91f7d4c](https://github.com/camcima/duraflows/commit/91f7d4c936bed22651a2d7f6c27fded4614f9498))
* **nestjs:** branch guard-name validation on guardRegistry, not guards ([324a165](https://github.com/camcima/duraflows/commit/324a1650428fb5f970eaad539e770909901064cb))
* **nestjs:** export WORKFLOW_GUARD_REGISTRY token from public index ([4c2bdef](https://github.com/camcima/duraflows/commit/4c2bdef7f18001b0c84650f6a9a052d2b6f095a9))
* update pnpm lockfile core version ([3cd5ea5](https://github.com/camcima/duraflows/commit/3cd5ea5531e3e4f5d438758b4ab3aea98c739208))

## [1.0.0](https://github.com/camcima/duraflows/compare/v0.5.1...v1.0.0) (2026-04-24)

### ⚠ BREAKING CHANGES

* **nestjs:** consumers who relied on implicit any typing for
useFactory args now get unknown[] by default. Either parameterize
forRootAsync<[ServiceA, ServiceB]>({ useFactory: (a, b) => ... })
or cast inside the factory.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
* **nestjs:** WorkflowModuleAsyncOptions.observers has been removed.
Return observers from the useFactory's WorkflowModuleFactoryConfig instead.
forRoot's WorkflowModuleOptions.observers is unchanged.

### Features

* **core:** add aggregate outcome field to OnEnterChainResult ([c5efe67](https://github.com/camcima/duraflows/commit/c5efe67fa7eeebd105a439f2014c72f98ddcb056))
* **core:** add fromState, toState, transitionUuid to WorkflowExecutionContext type ([7008271](https://github.com/camcima/duraflows/commit/7008271d5d1f73f1e4b31584ebb3f0007b4b459f))
* **core:** add ObserverRegistry to WorkflowRuntime with addObserver method ([9624dd5](https://github.com/camcima/duraflows/commit/9624dd561ee506b78a25ed22a9a6d4ae9dbcb118))
* **core:** add ObserverRegistry with sequential fire and error containment ([e8a6a1a](https://github.com/camcima/duraflows/commit/e8a6a1a805318e9e9bb4a181fada3bba3f3cc88e))
* **core:** add optional bestEffort flag to WorkflowCommand interface ([db9dbba](https://github.com/camcima/duraflows/commit/db9dbba18ae448ec17b234b0b65a9c079fa1a7ab))
* **core:** add optional onObserverError handler on runtime options ([031fb10](https://github.com/camcima/duraflows/commit/031fb10f91b13cc9948b6354c3411ca32a4f9a4b))
* **core:** allow best-effort commands to fail without aborting transition ([6450e87](https://github.com/camcima/duraflows/commit/6450e872aa76f4d9b71b17915a0cfd2bd7c12d22))
* **core:** allow command-only and failure-only events (optional targetState) ([7bbaf1a](https://github.com/camcima/duraflows/commit/7bbaf1a300619a38e2464152511d7463b37f0a6c))
* **core:** collect post-commit observer events in triggerEvent and onEnter chain ([da1b606](https://github.com/camcima/duraflows/commit/da1b606e38b70f9cec98792fa09edbe544a0b323))
* **core:** deep-clone and deep-freeze definitions on register ([16b0829](https://github.com/camcima/duraflows/commit/16b0829d68f386d15282dd382641fca8adb52446))
* **core:** expose WorkflowCommandRef.metadata to commands via ctx.commandMetadata ([4acef2b](https://github.com/camcima/duraflows/commit/4acef2bb35de862f06b11a9236a60a065c227300))
* **core:** fire observer events for createInstance initial state entry ([9747800](https://github.com/camcima/duraflows/commit/9747800bfe34c1c4d5e1ce498db4258ab6440a1d))
* **core:** fire observer events on timeout-driven transitions ([56fd399](https://github.com/camcima/duraflows/commit/56fd399e24490ecdf5cdc3232b929ac52fdb522f))
* **core:** introduce WorkflowObserver and StateEnterEvent types ([79fe178](https://github.com/camcima/duraflows/commit/79fe178604385c279f2507a3121e09a582decc8a))
* **core:** populate context transition fields in createInstance for initial onEnter ([d9eb4a4](https://github.com/camcima/duraflows/commit/d9eb4a47941ef9f3ed0ff058d9efcc2bcde2c815))
* **core:** populate context transition fields in processTimeoutEvent ([84acb84](https://github.com/camcima/duraflows/commit/84acb841b633afd09f6bad7b3ae781803a6f45d5))
* **core:** populate fromState/toState/transitionUuid in triggerEvent context ([1fce60f](https://github.com/camcima/duraflows/commit/1fce60fe415eda72f59cdf039e446da4cd34f167))
* **core:** re-export observer types and ObserverRegistry from package barrel ([ba43613](https://github.com/camcima/duraflows/commit/ba4361359967ac4acc69d2df9430fb7e742212bd))
* **core:** regenerate transitionUuid per onEnter hop and update from/toState ([0321ebf](https://github.com/camcima/duraflows/commit/0321ebfcad045f1e86ede798ddf948ac74e2b4ec))
* **core:** strengthen persistence contract with JSDoc and shared conformance tests ([71d7b0f](https://github.com/camcima/duraflows/commit/71d7b0f1f79f1390f65a73b6da296cf4bebd87dd))
* **nestjs:** forward optional observers from WorkflowModule to runtime ([c9694b5](https://github.com/camcima/duraflows/commit/c9694b55f5fad2d80b7b727461ae82f9e8961b40))
* **nestjs:** move forRootAsync observers into factory config; re-export types ([f7b4817](https://github.com/camcima/duraflows/commit/f7b4817026bd6bbfc6901c63666af5a5d9cdcbc2))

### Bug Fixes

* add @types/node devDep and override undici for pnpm strict resolution ([5c98923](https://github.com/camcima/duraflows/commit/5c98923ecea1e477428c1e27c1604b2d2cd7cef6))
* **ci:** pin pnpm to 9.15.0 and override basic-ftp to clear CVEs ([af82390](https://github.com/camcima/duraflows/commit/af8239059f442c69f19873718fd59cb1d1d95f90))
* **core:** aggregate triggerEvent outcome from chain outcome not last command result ([941bd1a](https://github.com/camcima/duraflows/commit/941bd1afb5b059d411782af79b520f73ff6719ec))
* **core:** count processed only when timeout event actually fires ([213a9b5](https://github.com/camcima/duraflows/commit/213a9b54743ccc416cb9048a97b5391b9e70930c))
* **core:** deep-clone context and metadata at runtime boundaries ([2f559ba](https://github.com/camcima/duraflows/commit/2f559baf58c650b44c2a0c4138aed7b3971dc4c4))
* **core:** deep-clone metadata and triggerMetadata in execution context ([05834b9](https://github.com/camcima/duraflows/commit/05834b941796f6e7576d985a5c7928be386c776c))
* **core:** deep-clone observer snapshots to avoid freezing live instance state ([88f4d4c](https://github.com/camcima/duraflows/commit/88f4d4cbe4a475f5a7c80369ba3752c6ee2fab8d))
* **core:** per-instance transactions in processExpiredWorkflows for isolation ([6c00dc6](https://github.com/camcima/duraflows/commit/6c00dc64ca778ab84f19a49e22cfa49e9a4b4e62))
* **core:** register onEnter.errorState targets in finita process graph ([f069770](https://github.com/camcima/duraflows/commit/f0697701d8cc066e9dbed00e7f22dab05db19eee))
* **core:** relax deepFreeze signature to accept WorkflowDefinition without double-cast ([c869f5d](https://github.com/camcima/duraflows/commit/c869f5d2af626ad361592d33454bb5746512e2cf))
* **core:** resolve timeout eventName from freshly-locked instance state ([30d7f73](https://github.com/camcima/duraflows/commit/30d7f7368f7fa4d3fe15aeb2e609822f50cdf15b))
* **core:** share per-hop transitionUuid between onEnter commands and observer events ([0405a3b](https://github.com/camcima/duraflows/commit/0405a3b61385320851dea4d979c3a95443f4a757))
* **core:** store serializable {name,message,stack} for best-effort thrown errors ([814e841](https://github.com/camcima/duraflows/commit/814e841fc2fac2b058290697da1461984a93bc39))
* **core:** uuid identifies a state entry; first onEnter hop reuses caller uuid ([d46bbae](https://github.com/camcima/duraflows/commit/d46bbaef4ee6877a9897142fb82d29bd1c4c1eb0))
* **kysely:** align @duraflows/core dep range with package version (0.5.1) ([1104e7c](https://github.com/camcima/duraflows/commit/1104e7ccbd03a1feb55479d6b8f25d11f0693355))
* **pg:** make migration 002 idempotent for fresh and legacy schemas ([35358a6](https://github.com/camcima/duraflows/commit/35358a6215aed0783d5b3b4af3311fe502361f53))
* **pg:** remove metadata_json from UPDATE — metadata is write-once ([b638a7c](https://github.com/camcima/duraflows/commit/b638a7cd2c06e5fa50e35aa66d715b836de56604))

### Code Refactoring

* **nestjs:** make WorkflowModuleAsyncOptions generic over factory args ([d60d67f](https://github.com/camcima/duraflows/commit/d60d67fa53f5fa1f1da2420335d65a73b59f76e5))

## [Unreleased]

### Features

- add `WorkflowObserver`, `StateEnterEvent`, and `ObserverRegistry` to `@duraflows/core` — post-commit, at-most-once, sequential, error-contained ([79fe178](https://github.com/camcima/duraflows/commit/79fe178604385c279f2507a3121e09a582decc8a))
- attach `ObserverRegistry` to `WorkflowRuntime` and fire events on `triggerEvent`, `createInstance`, and timeout-driven transitions ([9624dd5](https://github.com/camcima/duraflows/commit/9624dd561ee506b78a25ed22a9a6d4ae9dbcb118))
- re-export `WorkflowObserver`, `StateEnterEvent`, and `ObserverRegistry` from `@duraflows/core` barrel ([ba43613](https://github.com/camcima/duraflows/commit/ba4361359967ac4acc69d2df9430fb7e742212bd))
- accept optional `observers` array in `WorkflowModule.forRoot` and forward to runtime ([c9694b5](https://github.com/camcima/duraflows/commit/c9694b55f5fad2d80b7b727461ae82f9e8961b40))
- add `fromState`, `toState`, and `transitionUuid` to `WorkflowExecutionContext` — UUID identifies the state entry and is shared across all onEnter hops for that entry ([7008271](https://github.com/camcima/duraflows/commit/7008271d5d1f73f1e4b31584ebb3f0007b4b459f))
- add `bestEffort?: boolean` flag to `WorkflowCommand` — fire-and-forget commands whose failures don't abort the chain ([db9dbba](https://github.com/camcima/duraflows/commit/db9dbba18ae448ec17b234b0b65a9c079fa1a7ab))
- add `outcome: "success" | "failure"` aggregate field to `OnEnterChainResult` ([c5efe67](https://github.com/camcima/duraflows/commit/c5efe67fa7eeebd105a439f2014c72f98ddcb056))
- register `onEnter.errorState` targets in the finita process graph so events can be triggered from error-recovery states ([f069770](https://github.com/camcima/duraflows/commit/f0697701d8cc066e9dbed00e7f22dab05db19eee))
- allow command-only and failure-only events (optional `targetState`) — event must still define at least one of `targetState`, `errorState`, or `commands` ([7bbaf1a](https://github.com/camcima/duraflows/commit/7bbaf1a300619a38e2464152511d7463b37f0a6c))
- add optional `onObserverError` handler on `WorkflowRuntimeOptions` and NestJS module config — replaces the hard-coded `console.warn` fallback so observer failures can be routed to a structured logger ([031fb10](https://github.com/camcima/duraflows/commit/031fb10f91b13cc9948b6354c3411ca32a4f9a4b))
- deep-clone and deep-freeze workflow definitions on register — post-registration caller mutations can no longer corrupt stored definitions ([16b0829](https://github.com/camcima/duraflows/commit/16b0829d68f386d15282dd382641fca8adb52446))
- expose `WorkflowCommandRef.metadata` to commands via `WorkflowExecutionContext.commandMetadata` (deep-cloned and frozen per command) ([4acef2b](https://github.com/camcima/duraflows/commit/4acef2bb35de862f06b11a9236a60a065c227300))
- strengthen persistence contract with JSDoc distinguishing transactional-only methods and ship `@duraflows/core/testing` subpath export with `runInstanceStoreConformance` for adapter conformance tests ([71d7b0f](https://github.com/camcima/duraflows/commit/71d7b0f1f79f1390f65a73b6da296cf4bebd87dd))

### Bug Fixes

- `triggerEvent` now derives its outcome from `eventResult.outcome` and `onEnterChain.outcome` instead of the last command result — fixes false failures when a best-effort command is last, and surfaces earlier failures ([941bd1a](https://github.com/camcima/duraflows/commit/941bd1afb5b059d411782af79b520f73ff6719ec))
- observer event snapshots (`context`, `metadata`, `triggerMetadata`) are deep-cloned before freezing — live instance state is no longer frozen as a side effect ([88f4d4c](https://github.com/camcima/duraflows/commit/88f4d4cbe4a475f5a7c80369ba3752c6ee2fab8d))
- execution-context `metadata` and `triggerMetadata` are deep-cloned before freezing — caller-owned nested objects no longer get frozen as a side effect ([05834b9](https://github.com/camcima/duraflows/commit/05834b941796f6e7576d985a5c7928be386c776c))
- best-effort thrown errors are stored as serializable `{ name, message, stack }` — survives JSON persistence without crashing on circular references or BigInt values ([814e841](https://github.com/camcima/duraflows/commit/814e841fc2fac2b058290697da1461984a93bc39))
- `processExpiredWorkflows` uses per-instance transactions — a failing instance's rollback no longer corrupts other instances or fires observer events for partial state changes ([6c00dc6](https://github.com/camcima/duraflows/commit/6c00dc64ca778ab84f19a49e22cfa49e9a4b4e62))
- `processExpiredWorkflows` resolves the timeout event name from the freshly-locked instance state — concurrent state transitions between `findExpired` and `lockByUuid` no longer cause stale timeout events to fire ([30d7f73](https://github.com/camcima/duraflows/commit/30d7f7368f7fa4d3fe15aeb2e609822f50cdf15b))
- `processExpiredWorkflows.processed` counter only increments when a timeout event actually fires — skipped and cleared cases no longer inflate the metric ([213a9b5](https://github.com/camcima/duraflows/commit/213a9b54743ccc416cb9048a97b5391b9e70930c))
- `transitionUuid` is shared between onEnter commands and observer events within the same hop — observer events now report the same UUID as the command context ([0405a3b](https://github.com/camcima/duraflows/commit/0405a3b61385320851dea4d979c3a95443f4a757))
- first onEnter hop reuses the caller's `transitionUuid`; subsequent hops get fresh UUIDs — UUID correctly identifies a state entry boundary ([d46bbae](https://github.com/camcima/duraflows/commit/d46bbaef4ee6877a9897142fb82d29bd1c4c1eb0))
- deep-clone context and metadata at runtime boundaries — state-defined nested context from `WorkflowDefinition.states[...].context` is no longer aliased into live instance state, so commands mutating `instance.context.nested` no longer corrupt definition defaults ([2f559ba](https://github.com/camcima/duraflows/commit/2f559baf58c650b44c2a0c4138aed7b3971dc4c4))
- make migration `002_replace_trigger_with_metadata.sql` idempotent — fresh installs skip the legacy column replacement body; legacy installs still migrate `triggered_by_type`/`triggered_by_uuid` to `trigger_metadata_json` ([35358a6](https://github.com/camcima/duraflows/commit/35358a6215aed0783d5b3b4af3311fe502361f53))
- align `@duraflows/core` dependency range in `@duraflows/kysely` to `^0.5.1` (was stale at `^0.3.0`) ([1104e7c](https://github.com/camcima/duraflows/commit/1104e7ccbd03a1feb55479d6b8f25d11f0693355))
- remove `metadata_json` from `UPDATE` in `@duraflows/pg` and `@duraflows/kysely` instance stores — enforces the documented immutability of `metadata` after creation ([b638a7c](https://github.com/camcima/duraflows/commit/b638a7cd2c06e5fa50e35aa66d715b836de56604))
- relax `deepFreeze` generic signature so `WorkflowDefinition` no longer needs a double cast at the registration site ([c869f5d](https://github.com/camcima/duraflows/commit/c869f5d2af626ad361592d33454bb5746512e2cf))

### Documentation

- add `@duraflows/kysely` to the root `README.md` package list and adapter comparison ([d61253f](https://github.com/camcima/duraflows/commit/d61253f7851c0647854d6f5a807a8d1b15cfaac8))
- add changelog and expanded `docs/core-runtime.md`, `docs/error-handling.md`, `docs/nestjs-integration.md` covering observers, `bestEffort`, context transition fields, `outcome` aggregation, and the NestJS observer breaking change ([99fe14d](https://github.com/camcima/duraflows/commit/99fe14da31d65ceb1dffbbaba6d0bf98b4b6f20d))
- add npm discovery metadata (`description`, `keywords`, `author`, `homepage`, `repository`, `bugs`) to every `@duraflows/*` package and fix a missing `@duraflows/kysely` dep-range update in `.release-it.json`'s `before:bump` hook ([dbe5aa0](https://github.com/camcima/duraflows/commit/dbe5aa030e6092428aa0296c92315a0a095ac30e))

### BREAKING CHANGES

- `WorkflowModuleAsyncOptions.observers` field removed — pass observers inside the `WorkflowModuleFactoryConfig` returned by `useFactory` instead; `forRoot` (sync) is unchanged ([f7b4817](https://github.com/camcima/duraflows/commit/f7b4817026bd6bbfc6901c63666af5a5d9cdcbc2))
- `WorkflowModuleAsyncOptions` is now generic over factory args (`<TArgs extends unknown[] = unknown[]>`); consumers who relied on implicit `any` typing for `useFactory` args now receive `unknown[]` by default. Either parameterize `forRootAsync<[ServiceA, ServiceB]>({ ... })` or cast inside the factory ([d60d67f](https://github.com/camcima/duraflows/commit/d60d67fa53f5fa1f1da2420335d65a73b59f76e5))
- `WorkflowService` constructor now takes a single `WorkflowRuntime` argument instead of the previous `(runtime, instanceStore, historyStore)` triple — queries delegate to runtime methods. Invisible under normal NestJS DI usage; affects only consumers who manually instantiate `WorkflowService` outside the container ([9787a0c](https://github.com/camcima/duraflows/commit/9787a0cbcf70cb2d56dfe9f3d91836d039c20b87))

> This release includes breaking changes; the next version will be **0.6.0**.

## [0.5.1](https://github.com/camcima/duraflows/compare/v0.5.0...v0.5.1) (2026-04-06)

## [0.5.0](https://github.com/camcima/duraflows/compare/v0.4.0...v0.5.0) (2026-04-06)

### Bug Fixes

* override path-to-regexp to ^8.4.0 (CVE fix) ([cc86be5](https://github.com/camcima/duraflows/commit/cc86be5442d354f3677d5c7255c3f59b897fddac))

## [0.4.0](https://github.com/camcima/duraflows/compare/v0.3.0...v0.4.0) (2026-04-04)

### Features

- **kysely:** add factory functions and complete barrel exports ([adb047a](https://github.com/camcima/duraflows/commit/adb047a75f96a39baf7c17847477d795132f3ce0))
- **kysely:** add KyselyTransactionContext with AsyncLocalStorage ([bd6b169](https://github.com/camcima/duraflows/commit/bd6b169834838b64a44608ce9ccb4e078cf86c93))
- **kysely:** add KyselyTransactionRunner with re-entrancy support ([43147ae](https://github.com/camcima/duraflows/commit/43147aed4a98e25925ca175c8af55630f7a3416b))
- **kysely:** add KyselyWorkflowHistoryStore ([d57d489](https://github.com/camcima/duraflows/commit/d57d4896d414e4233cd536716ac80ee4812a6319))
- **kysely:** add KyselyWorkflowInstanceStore ([568c257](https://github.com/camcima/duraflows/commit/568c257bbe32cc4fbad0ad417a301cccd76e7ca0))
- **kysely:** add WorkflowDatabase type definitions ([6c20027](https://github.com/camcima/duraflows/commit/6c200272bf220c7f113a647fb8ec7bbabf8c4ffd))
- **kysely:** scaffold @duraflows/kysely package ([58557f6](https://github.com/camcima/duraflows/commit/58557f67058102fe2d96212d50d34575c2a27c43))

### Bug Fixes

- **kysely:** accept intersection-typed Kysely instances and fix uuid column type ([e5577f6](https://github.com/camcima/duraflows/commit/e5577f65c7ecc0843070159366a6f5a0f417fd0a))

## [0.3.0](https://github.com/camcima/duraflows/compare/v0.2.0...v0.3.0) (2026-04-04)

### Features

- add CommonJS dual-publish support ([f331cc9](https://github.com/camcima/duraflows/commit/f331cc9e580765d0dd9639c892378656675be6eb))
- add mermaid diagram generation from workflow definitions ([9b37d33](https://github.com/camcima/duraflows/commit/9b37d33045002b1925285e77336ce4a33f432139))
- refine mermaid diagram visual design and add documentation ([cd8e8bf](https://github.com/camcima/duraflows/commit/cd8e8bf262f428ff252e1bda7f78c150c97c0447))

### Bug Fixes

- correct copyright year in LICENSE to 2026 ([6c6d2ca](https://github.com/camcima/duraflows/commit/6c6d2ca14384da56282c14d4576ad680dba1ed1b))
- replace Font Awesome icons with emojis for GitHub compatibility ([96eac35](https://github.com/camcima/duraflows/commit/96eac3546b910faaf26a601557162755a9ed68c7))

## [0.2.0](https://github.com/camcima/duraflows/compare/v0.1.0...v0.2.0) (2026-03-30)

### Bug Fixes

- remove stale @duraflows/core@0.0.2 nested in nestjs package ([60d3682](https://github.com/camcima/duraflows/commit/60d36828efc953f6a3a6efcd400dd9cc08e8319a))

## [0.1.0](https://github.com/camcima/duraflows/compare/v0.0.2...v0.1.0) (2026-03-30)

### Features

- add WorkflowHandle thin-proxy pattern ([c1fd11b](https://github.com/camcima/duraflows/commit/c1fd11b925058a493faa80412a4827042a81bc99))

## [0.0.2](https://github.com/camcima/duraflows/compare/v0.0.1...v0.0.2) (2026-03-28)

## 0.0.1 (2026-03-28)
