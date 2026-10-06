# Mutation testing

Stryker changes production expressions and runs the existing Vitest tests against
each change. A killed mutation means a test detected that change. A surviving
mutation needs inspection: it can identify a missing assertion or leave observable
behavior unchanged. Ordinary line coverage only establishes that code ran.

## Run the suite

Use Node.js 22 or later, as required by Stryker 10, and install the workspace:

```bash
pnpm install --frozen-lockfile
pnpm test:mutation
```

The first run tests the full scope. Later runs reuse an incremental report and
retest affected mutations. To force a fresh run:

```bash
pnpm exec stryker run --force
node scripts/check-mutation-report.mjs
```

To inspect a particular module:

```bash
pnpm exec stryker run --mutate packages/duraflows-core/src/runtime/durable-execution.ts
node scripts/check-mutation-report.mjs
```

The HTML report is `reports/mutation/mutation.html`; the machine-readable report is
`reports/mutation/mutation.json`. Scoped runs overwrite those reports, so retain a
copy of a full report before running a focused investigation. Reports, incremental
results, and Stryker sandboxes are ignored by Git.

## Scope and interpretation

The configuration mutates executable TypeScript in all four packages, including
the runtime, persistence adapters, NestJS integration, validation, and diagrams.
It excludes package export barrels, core type declarations, core test/conformance
helpers, and NestJS DTO declarations. Tests themselves are never mutated.

All unit and in-memory integration tests run. The three PostgreSQL-dependent
integration suites are explicitly excluded, regardless of `DATABASE_URL`.
The results therefore measure assertions against mocked database adapters, not
real SQL execution, locking, or transaction isolation. Run the ordinary database
integration suite separately; this mutation configuration cannot establish those
guarantees. NestJS HTTP tests still need permission to bind local ports.

Stryker uses per-test mutation coverage, four workers, and Vitest's transformed
module cache. Test isolation remains enabled. Static mutations are included.
There is no TypeScript mutation checker: this measures runtime assertions, while
the ordinary build and typecheck remain separate checks.

The reported mutation score includes killed and timed-out mutations as detected,
and includes survivors and uncovered mutations as undetected. Compile and runtime
errors are not evidence of a successful assertion. Inspect the status counts and
timeouts alongside the score. Threshold colors use Stryker's default 80/60 bands;
there is no mutation-score build gate until a baseline has been reviewed.

## Vitest 5 compatibility

Stryker's Vitest runner 10.0.0 builds test identities with space-separated suite
names, but Vitest 5 filters names using `>` separators. This can silently run
zero tests for a covered mutation and report a false survivor.

The development dependency has a pnpm patch under `patches/` that uses Vitest 5's
canonical `fullTestName` for both coverage identities and runner filtering,
retaining the legacy fallback for older versions. The patch is applied by
`pnpm install`. Remove it after an upstream runner release supports Vitest 5 and a
focused mutation run verifies test selection. See
[Vitest's testNamePattern documentation](https://vitest.dev/config/testnamepattern).

`scripts/check-mutation-report.mjs` rejects reports with survivors that completed
zero tests. `pnpm test:mutation` runs this validation automatically; run it manually
after using `pnpm exec stryker run` with custom options.

## PostgreSQL-backed pass

Point `DATABASE_URL` at a disposable PostgreSQL 16 database, then run:

```bash
DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/duraflows_test' pnpm test:mutation:postgres
```

This separate configuration mutates both persistence adapters and the durable
execution runtime. It retains all tests from the original baseline, including
NestJS HTTP tests, and adds all three real database suites, including the
sequential dbmate migrations. Static mutations
remain included. The configuration requires `DATABASE_URL` and sets
`REQUIRE_INTEGRATION_DB=1`, so missing database setup cannot silently skip the
integration suites.

This mutation configuration allows 30 seconds per test and setup/cleanup hook
because instrumentation adds overhead to multi-row database cases. Stryker's
own mutation timeout remains based on measured baseline durations plus its
configured five-second allowance.

The runner requires a database role with `CREATEDB` privileges. Each Stryker
worker receives a fresh database with a random run prefix and its process ID.
Four workers can therefore run without sharing the suites' fixed schemas.
Vitest files run serially within each worker. Replacement workers after timeouts
also receive fresh databases. The runner removes only databases with its own run
prefix after Stryker exits, including on failures and handled interrupts.
The tests create, drop, and truncate their dedicated test schemas.

Reports and incremental results go under `reports/mutation/postgres/`, preserving
the database-independent report. For a fresh run:

```bash
pnpm test:mutation:postgres --force
```

Export `DATABASE_URL` before running the command above. The wrapper forwards
additional Stryker arguments and validates the report automatically; use it
instead of calling the PostgreSQL Stryker configuration directly. This focused pass
does not mutate the rest of core or NestJS. Compare its results with the same
files and mutations from the original baseline, rather than comparing the two
overall scores, which cover different source scopes.

## Baseline: 7.4.1, 2026-10-06

The first complete run used the existing 1,029 tests against source commit
`267adab700cf49e5c4e5f3440a76876753a2560a`, with no changes to production code or
test assertions. It included 56 source files and all 405 static mutations, and
completed in 39 minutes 52 seconds. Report validation passed: every survivor
completed at least one test.

| Result      | Mutations |
| ----------- | --------: |
| Killed      |     3,212 |
| Timed out   |        24 |
| Survived    |       476 |
| No coverage |         6 |
| Total       |     3,718 |

The Stryker score is **87.04%**: `(3212 + 24) / 3718`. Counting only killed
mutations gives **86.39%**. There were no compile or runtime error results.
The ordinary V8 coverage run passed with 99.17% statement coverage, 97.65% branch
coverage, 100% function coverage, and 99.53% line coverage. These metrics answer
different questions, and their source scopes differ: ordinary coverage also
includes the core testing helpers that mutation testing excludes.

| Package             | Mutations | Killed | Timed out | Survived | No coverage |  Score |
| ------------------- | --------: | -----: | --------: | -------: | ----------: | -----: |
| `@duraflows/core`   |     2,722 |  2,388 |        24 |      306 |           4 | 88.61% |
| `@duraflows/nestjs` |       247 |    228 |         0 |       17 |           2 | 92.31% |
| `@duraflows/pg`     |       291 |    262 |         0 |       29 |           0 | 90.03% |
| `@duraflows/kysely` |       458 |    334 |         0 |      124 |           0 | 72.93% |

### Prioritized follow-up tests

The following are assertion gaps observed in this baseline, rather than proof of
bugs in the unmodified implementation. Mutation IDs refer to this report; they
can change when source files change. The survivors have been sampled for this
triage, not all classified as meaningful or equivalent.

1. **Kysely execution-store persistence and selection.**
   `kysely-execution-store.ts` scores **31.03%** (36 killed, 80 survived).
   Emptying the entire `.values(...)` payload (mutant 2969) or `.set(...)`
   payload (2976) survives. Empty active-status lists (3013) and changes to due
   time, instance UUID, idempotency-key, and definition-usage predicates also
   survive. The fluent mock always returns configured rows and does not verify
   most builder arguments. Assert complete write payloads and compiled queries;
   add a PostgreSQL mutation pass to exercise actual selection and persistence.
   The pg execution store also needs attention at **70.73%** (12 survivors).

2. **Durable worker ownership and lease fencing.**
   `durable-execution.ts` scores **79.91%** (374 killed, 92 survived, two uncovered).
   Removing the complete ownership check in `owned` survives 35 tests (1225).
   Existing expiry tests also encounter the separate checkpoint expiry check,
   which can mask removal of the earlier protection. Test a replaced lease token
   or changed execution status before checkpointing and heartbeats, and verify
   that a stale worker cannot update the journal, history, instance, or lease.
   Include expiry exactly at the clock boundary (1245).

3. **Retry timing across multiple failures.**
   Replacing exponential multiplication with division survives 11 tests (1120).
   The durable test fixture normally parks after two attempts, and its retry
   assertions do not distinguish a growing delay from a shrinking one. Use at
   least three allowed attempts and assert exact `availableAt` values, rejection
   before the due time, and the delay cap. This gap concerns durable execution;
   the separate timeout retry policy already checks multiple backoff values.

4. **Guard context, persisted history, and transition identities.**
   Replacing durable guard context with `{}` (1030), guard-rejection history with
   `{}` (1037), or `onEnter` trigger metadata with `{}` (1340) survives.
   Removing observer transition fields also survives (1344).
   Deleting `transitionUuid` entirely also survives 35 tests (941). Assert guard
   inputs and full history fields, including trigger metadata and definition
   version. Check valid, distinct transition UUIDs for each hop and stability
   across recovery. Real database tests should also reject invalid history rows.

5. **Worker result counts and input boundaries.**
   Changing `result.processed++` to `result.processed--` survives 35 tests (1069),
   because existing assertions mainly check zero work and result UUID arrays.
   Assert nonzero batch counts. Also cover the exact 256-byte idempotency-key
   limit (934) and surrogate-pair truncation with high surrogates at both ends
   of the `0xD800`–`0xDBFF` range (1742, 1745).

Of the 476 survivors, 211 are string mutations. These include SQL identifiers and
predicates as well as diagnostics; they should not all be dismissed as cosmetic.
Some other survivors are equivalent or redundant checks and need individual
review before adding tests. The 24 timeouts occur in migration paging (11),
workflow validation (11), onEnter execution (one), and diagram traversal (one).
Loop mutations explain several of these, but the baseline does not establish
that every timeout represents a behavioral assertion.

### PostgreSQL follow-up scope

The existing real-database suites use fixed schema names and drop or truncate
tables during setup and cleanup. Running copies in concurrent Stryker workers
would share those schemas and can cause interference. A database-backed mutation
pass should use a disposable database and worker-specific schemas, or run
serially. Its sandbox must also include `packages/duraflows-pg/sql/dbmate/*.sql`
for the sequential migration suite. Record that pass separately from this
database-independent baseline; the current scores cannot establish SQL execution,
row-locking, rollback, or transaction-isolation guarantees.

## PostgreSQL baseline: 2026-10-06

The completed database-backed pass used PostgreSQL **16.14** and unchanged
production source and test assertions from the 7.4.1 baseline. Its initial run
passed **1,197 tests**: the original 1,029 plus 168 real PostgreSQL tests. It
instrumented 17 source files with 1,217 mutations. Adding the database tests
increased the observed static mutations in this scope from nine to 57; all were
included. The fresh pass completed in **38 minutes 17 seconds**, using four
workers with separate databases. No incremental outcomes were reused.

| Result        | Without database tests | With database tests |
| ------------- | ---------------------: | ------------------: |
| Killed        |                    970 |               1,090 |
| Timed out     |                      0 |                  14 |
| Survived      |                    245 |                 111 |
| No coverage   |                      2 |                   2 |
| Total         |                  1,217 |               1,217 |
| Stryker score |                 79.70% |              90.71% |

This compares exactly the same mutations and production source. The original
test files and their case counts were retained. Parameterized test names that
embed class/function bodies can change with Stryker's instrumentation, so those
generated strings are not suitable for identifying unchanged test cases.
The original full-repository score of 87.04% covers a larger source scope and
should not be compared directly with this focused score.

| Scope                     | Without database tests | With database tests |
| ------------------------- | ---------------------: | ------------------: |
| Durable execution runtime |                 79.91% |              80.13% |
| Kysely adapter            |                 72.93% |              96.29% |
| pg adapter                |                 90.03% |              98.97% |
| Kysely execution store    |                 31.03% |              88.79% |
| pg execution store        |                 70.73% |             100.00% |

**130 original survivors were killed**, four became timeouts, and 111 remained
survivors. Ten previously killed mutations became timeouts. All remaining
survivors completed tests; there were no compile or runtime error results.
Counting only killed mutations gives **89.56%**, compared with 79.70% before.

The timeout count deserves separate review: 11 of the 14 timeouts are static
mutations requiring broader reruns. Nine occur in schema-generation code, and
the others occur in durable policy validation, definition/history/execution
store access, and transaction configuration. Timing or collection effects may
contribute; these outcomes do not establish that an assertion detected the
change. In particular, the runtime's small score increase comes entirely from
one timeout, with its killed count unchanged.

### What the database pass establishes

- Empty Kysely insert/update payloads are now killed (original IDs 2969/2976;
  database report IDs 574/581). Empty active-status selection is also killed
  (3013/618). Most adapter survivors from the first baseline were already
  covered by the existing real-database suites.
- The durable runtime's ownership-check deletion still survives **62 tests**
  (1225/368). Existing stale-worker scenarios still encounter the separate
  checkpoint expiry check, so they do not independently establish ownership
  protection. Add an overlapping-owner case in which the replacement worker
  retains a valid lease while the stale worker attempts a heartbeat or write.
- Retry multiplication changed to division (1120/263), decremented worker
  counts (1069/212), deleted transition UUID generation (941/84), empty guard
  context/history (1030/173 and 1037/180), and omitted observer fields
  (1344/487) all remain survivors. The corresponding hardening tests remain
  necessary.
- The Kysely execution store has 13 remaining survivors. They concern lease
  column serialization, active-status selection, the captured-version fallback,
  and empty exclusion lists. Add direct store tests with pending/running/parked
  and terminal rows, future and expired leases, and an unnumbered captured
  definition. Inspect SQL columns as well as `execution_json`: a correct JSON
  round trip or the runtime's later checks can mask incorrect query columns.
  Review empty-list mutations for equivalence before adding assertions.

The full report is `reports/mutation/postgres/mutation.html`, with JSON beside
it. `reports/mutation/postgres/comparison.json` records per-file scores, mutation
matches, transitions, and remaining cases. IDs vary between scopes; matching used
source path, location, mutator, and replacement.

The runner removed all **18** databases created for the completed run, including
replacement workers. A database inspection confirmed no mutation worker
databases remained, and the disposable container was stopped and removed.

## Integration test hardening: 2026-10-06

The shared database durable-execution suite now adds 15 cases, run against the
pg adapter, the Kysely adapter, and sequential dbmate migrations: 45 additional
PostgreSQL test runs. Each case resets its dedicated schema's workflow data,
uses an injected clock, and exercises real persistence and transactions.

The additional guarantees cover:

- A stale worker cannot heartbeat or checkpoint while a replacement worker
  retains a live lease. Its attempts must leave the replacement's entire
  execution record, instance, history, and observer notifications unchanged.
- A heartbeat and checkpoint lose ownership exactly at lease expiry.
- Retry deadlines increase exponentially, stop at the configured cap, survive
  worker reconstruction, and prevent command invocation before the deadline.
  Successful recovery retains command identity and records the attempt count.
- Guards receive complete frozen acceptance inputs; rejection writes the full
  history payload once without running commands or notifying state observers.
- State-entry identities are valid, distinct between entries and executions,
  and stable through retries and worker reconstruction. Each hop retains its
  history fields and frozen observer payload, delivered after the final state
  commits.
- Direct store queries distinguish every active and terminal status, filter
  leased work before applying a limit, and include an expired lease exactly at
  its deadline. Raw SQL reads verify both populated and cleared lease columns
  independently of the execution JSON.
- Captured definitions without an explicit version still count as version 1
  when their stamped instance is excluded from retirement inspection.

The two existing bulk instance-migration cases have a 30-second timeout because
hundreds of real SQL operations can exceed Vitest's five-second default under
load. The other ordinary test timeouts are unchanged.

The final ordinary suite passed **1,242 tests**, including all **213** database
integration tests. Formatting, lint, and a TypeScript check of the shared helper
also passed. Production code is unchanged.

Fresh mutation verification covered selected durable-runtime expressions and
both complete execution-store implementations, followed by focused PostgreSQL
checks of the transition-ID generator and empty exclusion lists. Results were
matched to the previous PostgreSQL baseline by source path, location, mutator,
and replacement; production source was byte-identical. The combined cohort
contains 258 distinct mutations:

| Result      | Before | After |
| ----------- | -----: | ----: |
| Killed      |    199 |   249 |
| Timed out   |      1 |     0 |
| Survived    |     57 |     8 |
| No coverage |      1 |     1 |
| Total       |    258 |   258 |

**49 previous survivors are now killed.** The Stryker score for this matched
cohort rose from **77.52% to 96.51%**; this is not a new full-repository score.
The pg execution store's 41 mutations and the Kysely execution store's 116
mutations are all killed by the combined verification.

The first 248-mutation pass killed 236 mutations with no timeouts. A supplemental
16-mutation pass killed 15 and timed out on an invalid hash algorithm: blocked
worker tests were waiting for a command that processing never reached. Their
startup synchronization now also waits for early worker completion, failing
promptly instead of waiting indefinitely. A fresh single-mutation PostgreSQL
recheck killed that mutation. A final four-mutation PostgreSQL pass killed both
previously surviving empty-exclusion conditions. Kysely's compiled `NOT IN ()`
predicate is invalid PostgreSQL SQL, so the empty-list condition is observable
and needs a direct assertion.

Eight runtime survivors and one uncovered guard-registry error branch remain in
this cohort. The survivors concern missing-row/status/null-lease checks, a
registry-presence check, and an overwritten history UUID initializer. Review
reachability and ownership invariants before treating each as a production
fault or requiring additional tests.

The original baseline reports are preserved under `reports/mutation/postgres/`.
The focused HTML/JSON reports, supplementary results, timeout recheck, empty-list
results, and `combined-comparison.json` are retained separately under
`reports/mutation/postgres-hardening/`. These local artifacts are ignored by Git.
