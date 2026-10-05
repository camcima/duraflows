# Plan: fix the 7.4.0 review findings

Status: implemented and validated on 2026-10-05.

The release review reproduced three defects against PostgreSQL: queued definition snapshots are missing from retirement counts, omitted subjects reach handlers as `null`, and error messages containing NUL prevent retry-state persistence. This plan fixes each defect and adds permanent regressions to the existing suites.

## 1. Count queued snapshots when reporting definition usage

**Required behavior:** `listDefinitionVersions(name).activeInstances` counts distinct instances that still require each version. An instance requires a version when either it is stamped with that version in a nonterminal state, or it owns a pending, running, or parked execution whose captured definition uses that version. Count an instance once per version, even when both conditions match. One instance can require two different versions.

### Implementation

1. Add an optional `countInstancesUsingDefinition` capability to `WorkflowExecutionStore`. Its arguments are `workflowName`, `definitionVersion`, and `excludeStates`; the state exclusions apply only to the stamped-instance branch. Its result is the distinct union described above, calculated from one consistent database statement.
2. Implement the capability in the pg and Kysely execution stores, plus the shared in-memory test store. Read the queued version from `execution_json.definition.version`, defaulting an omitted version to 1. Match workflow name as well as version. Include pending, running, and parked records; completed, cancelled, and guard-rejected completed records contribute nothing through the execution branch.
3. Use this capability in `WorkflowRuntime.listDefinitionVersions()` when an execution store is enabled. Keep the existing instance-store count for runtimes without durable execution.
4. If a custom execution store lacks the capability, make version inspection throw a descriptive `WorkflowError` explaining how to implement it. The optional method preserves source compatibility and normal execution; inspection must not silently report an incomplete count as evidence that retirement is safe.
5. Update `DefinitionVersionSummary.activeInstances` and runtime API comments to describe the broader count. Update retirement examples in `docs/core-runtime.md`, `docs/workflow-definitions.md`, `docs/durable-execution.md`, and `references/api-reference.md`, plus the relevant repository skill guidance.

Use the existing schema and active-execution index initially. Inspect the query plan with representative completed and active execution rows; add an index only if the measured plan warrants one. No data rewrite or instance-version change is needed. The instance stays stamped with its pre-event version until finalization, as the durable API promises.

### Regression coverage

- Create a v1 instance, register v2 with `versionPolicy: "latest"`, and queue a v2 event. Both versions report one dependent instance before finalization.
- A stamped instance and its queued execution using the same version count once.
- Pending, running, and parked executions retain their captured version. Completion and cancellation release that execution's contribution; any remaining stamped-instance contribution still counts.
- Completed guard rejection contributes no queued dependency. Workflow names with the same version number do not affect each other's counts. An omitted definition version is treated as 1.
- Preserve existing counts with durable execution disabled and verify the explicit unsupported-capability error for a custom durable store.
- Run these cases through the core versioning suite and both real database adapters. Exercise acceptance and finalization across separate runtimes, including visibility before and after transaction commit or rollback.

Relevant files: `src/types/durable.ts`, `src/types/runtime.ts`, `src/runtime/workflow-runtime.ts` in core; both adapter execution stores; `tests/helpers/in-memory-persistence.ts`, `tests/integration/workflow-runtime-versioning.test.ts`, and `tests/helpers/database-durable-cases.ts` in core.

Retirement remains an operational check: stop producers from accepting work under a version before retiring its handlers. A count is a point-in-time observation, not a lock against future acceptance.

## 2. Preserve omitted subjects

**Required behavior:** guards, event commands, and entry commands receive `undefined` when the subject is omitted, and receive `null` only when the caller explicitly supplies `null`.

### Implementation

1. Replace the `subject ?? null` conversion at guard evaluation and command invocation with a small shared subject-snapshot helper.
2. Return `undefined` directly for an absent subject; JSON-clone and deep-freeze every supplied JSON value, including explicit `null`.
3. Preserve acceptance-time copying, existing JSON validation, and immutable object subjects. The stored optional field already distinguishes omission from explicit null, so existing execution records need no migration.

### Regression coverage

- A handler with a default subject parameter completes through both `triggerEvent()` and `enqueueEvent()` when no subject is supplied.
- An acceptance guard with a default parameter receives the same value through both APIs; an accepted guard is still evaluated only once.
- Cover event and `onEnter` commands, external and transactional execution, worker recreation, and retry after a thrown error.
- Verify explicit null, false, zero, empty string, arrays, and object subjects retain their values. Object subjects remain immutable and isolated from caller mutation.

Relevant files: core `src/runtime/durable-execution.ts` and `tests/integration/durable-execution.test.ts`.

## 3. Make persisted diagnostics safe for PostgreSQL

**Required behavior:** arbitrary thrown error text cannot prevent the engine from recording a retry, parking an execution, or checkpointing a converted best-effort failure.

### Implementation

1. Add a dedicated utility for persisted diagnostic text. Preserve `describeThrown()` as the nonthrowing error formatter; sanitize its output at persistence boundaries.
2. Replace NUL with U+FFFD, replace unpaired UTF-16 surrogates with U+FFFD, and truncate to at most 2,000 UTF-16 code units without leaving a split surrogate pair. Preserve valid Unicode, including emoji.
3. Apply the utility to both exception-derived `lastError` assignments in the durable runner and the generated `BEST_EFFORT_THROWN.message`. The latter is also persisted in execution checkpoints and transition history.
4. Reuse the utility in `TimeoutRetryPolicy.next()` so the existing timeout protection and durable protection share one implementation. Preserve retry timing, attempt limits, and ordinary diagnostic text.
5. Document bounded, sanitized diagnostics. Keep sanitation scoped to runtime-generated diagnostics; application subjects, context, fingerprints, and returned business data must retain their existing semantics.

### Regression coverage

- A command throwing an error containing NUL produces `retrying` with a persisted deadline, cleared lease, and sanitized `lastError`, rather than a persistence failure.
- At `maxAttempts`, the same error produces a parked execution immediately and retains its diagnostic.
- A best-effort thrown error containing NUL checkpoints its generated failure, allows subsequent work, and finalizes valid history.
- Exercise the plan-error parking path after a checkpoint as well as the command-exception retry path.
- Cover lone high/low surrogates, valid supplementary characters, a surrogate pair crossing the truncation boundary, long messages, and unusual thrown values already supported by `describeThrown()`.
- Verify transactional business writes roll back on a propagated command exception while its sanitized retry state commits separately. Earlier successful checkpoints remain intact.
- Run the persistence cases through both pg and Kysely. In-memory tests alone cannot reproduce PostgreSQL's JSONB rejection.

Relevant files: core `src/runtime/durable-execution.ts`, `src/runtime/timeout-retry-policy.ts`, a shared diagnostic utility, and the durable/timeout tests plus `tests/helpers/database-durable-cases.ts`.

## Implementation sequence and validation

1. Turn the review reproductions into permanent failing regressions in the existing suites. The temporary review file at `/tmp/duraflows-7.4-review.test.ts` is a reference, not a required build input.
2. Implement subject preservation and its focused tests.
3. Implement diagnostic sanitation and verify both database adapters.
4. Implement definition-usage counting, adapter compatibility behavior, and versioning regressions.
5. Update the affected API documentation, release notes, and repository skill guidance to match the final behavior.
6. Run `pnpm run build`, `pnpm run lint`, `pnpm run format:check`, and `pnpm exec vitest run --typecheck.enabled --coverage`. Preserve the current coverage thresholds.
7. Run all three database integration suites with `DATABASE_URL` and `REQUIRE_INTEGRATION_DB=1` against an isolated database. Include the existing sequential migration tests even though this plan requires no schema migration.

The review baseline was 1,013 passing local tests and 156 passing database tests, plus a successful build and lint. Completion requires the new regressions to pass alongside those suites, supported custom-adapter behavior to be documented, and all three original reproductions to demonstrate the corrected behavior.

## Implementation results

All three fixes are implemented, with permanent regression coverage, updated API documentation, release notes, and all five repository skills. The optional retirement-inspection capability is supported by both bundled adapters; custom stores without it retain ordinary processing and receive an explicit inspection error. No schema migration is needed. Kysely continues to use type-only imports so its CommonJS build remains loadable.

Validation completed:

- Full coverage/typecheck run: 1,031 tests passed, no type errors. The three database suites were run separately.
- Real PostgreSQL integration: 168 tests passed across pg, Kysely, and sequential migrations.
- The original three review reproductions passed against the fixed implementation.
- Dual ESM/CommonJS build, lint, formatting, and diff whitespace checks passed.
- Coverage: 99.17% statements, 97.65% branches, 100% functions, 99.53% lines; thresholds unchanged.
- Query-plan inspection with 10,000 instances and 10,000 execution rows (200 active, 9,800 completed) used the existing instance-definition and active-execution indexes. The sampled union count took about 0.26 ms; no additional index was warranted for this workload.

All database validation used isolated temporary schemas and a temporary PostgreSQL server. Temporary review tests were removed after verification.
