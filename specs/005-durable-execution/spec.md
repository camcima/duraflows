# Durable command execution

Status: implemented and validated. Opt-in additive API; not yet released.

`enqueueEvent` persists a JSON input and frozen definition snapshot under the instance lock. A request key (required) identifies one queued execution per instance; this namespace is separate from synchronous event receipts. Matching duplicates return that execution; event/fingerprint mismatch conflicts. Guards run once on acceptance. One pending/running/parked execution owns an instance. Every participating application worker must enable the execution store before accepting queued traffic.

`processPendingExecutions` processes at most one command per selected execution, using a short claim transaction and a renewable lease with a fencing token. External commands run outside database transactions and receive a stable per-occurrence idempotency key, attempt and heartbeat. `transactional: true` command references run their database writes and checkpoint in one transaction. Processing must be called outside an ambient transaction and requires a runner that can detect one. Enqueue may join a caller-owned transaction; workers cannot see the work before commit.

Each checkpoint stores the normalized result and mutated context. The runner reconstructs the declarative event/onEnter plan from the original snapshot and recorded commands, never re-invoking completed handlers or guards. This supports existing failure branching, best-effort handlers and onEnter chains without replaying arbitrary application code. The definition and best-effort policy are pinned; deployments must preserve compatible registered handlers.

Business state/history remain at the pre-event state until finalization. Finalization applies all transitions/history and completes the execution atomically; observer callbacks retain their existing non-durable delivery semantics. Earlier transactional command writes are already committed and cannot be rolled back by later failure. External effects use downstream idempotency to handle the effect/checkpoint uncertainty window. Inputs, results and context must be JSON-safe; subjects are immutable snapshots.

Transient exceptions retry with persisted backoff and eventually park. Routed business failures finish along errorState, including any compensation commands explicitly modeled there. Unrouted business failure or invalid execution plans park for inspection; replay never erases completed command records. Operators may retry parked executions or cancel inactive executions to release the instance; cancellation does not undo effects. Lease expiry allows takeover and prevents stale checkpoint/finalization writes.

Optional execution store, additive migration 008, provider flag durableExecution, core/handle/NestJS service APIs and controller routes, read/worker/retry/cancel APIs. Existing triggerEvent, timeouts, rearm and migration refuse/skip busy instances. Defaults work without the new table. Custom adapters implement transaction-bound insert/update, revision checks, active-instance/key uniqueness, due scans, and ambient-transaction detection.

Validation: core failure/recovery/context/version/reentry and lease tests; real pg/Kysely concurrency, rollback and migrations; NestJS DI/HTTP; build/typecheck/lint/format/coverage; docs and all five repository skills.

Validation completed:

- 1,015 tests passed in the combined coverage/typecheck run; no type errors. The three database suites were skipped in this run and executed separately below.
- 156 real PostgreSQL integration tests passed across pg, Kysely, and the incremental dbmate migrations, including concurrent acceptance, lease takeover/fencing and transactional checkpoint rollback.
- Coverage: 99.16% statements, 97.56% branches, 100% functions, 99.53% lines; existing thresholds unchanged.
- Dual ESM/CommonJS builds, lint, repository formatting, and packed ESM/CommonJS NestJS 12 consumer smoke tests passed.
- Documentation, API reference, all package READMEs and all five repository skills updated; all five skills passed quick validation.

Independent review completed with a fresh-context subagent on 2026-10-04. The review and follow-up inspection resulted in:

- Fixed timeout starvation: durable adapters exclude active executions before the candidate batch limit, with regressions in core and both real PostgreSQL adapters.
- Clarified transactional rollback semantics: propagated exceptions and checkpoint/finalization failures roll back; recorded business outcomes and converted best-effort failures may commit writes.
- Added real-database failures after successful checkpoint/history writes, proving rollback of business writes and partial finalization.
- Added durable entry-error routing and repeated-command occurrence identity tests.

The reviewer inspected the fixes and reported no further defects. Final validation above includes these changes.
