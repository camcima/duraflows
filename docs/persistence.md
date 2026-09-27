# Persistence

The workflow runtime is decoupled from any specific database library. The core package defines four persistence interfaces. The `@duraflows/pg` package provides a built-in PostgreSQL adapter using `pg`, but you can implement these interfaces with Prisma, Drizzle, TypeORM, or any other library.

## Persistence Interfaces

All four interfaces are defined in `@duraflows/core`:

```ts
import type {
  WorkflowInstanceStore,
  WorkflowHistoryStore,
  WorkflowTransactionRunner,
  WorkflowDefinitionStore,
  WorkflowPersistenceProvider,
} from "@duraflows/core";
```

### WorkflowInstanceStore

Manages workflow instance CRUD and locking.

```ts
interface WorkflowInstanceStore {
  create(instance: WorkflowInstance): Promise<void>;
  findByUuid(uuid: string): Promise<WorkflowInstance | null>;
  lockByUuid(uuid: string): Promise<WorkflowInstance | null>;
  update(instance: WorkflowInstance): Promise<void>;
  findExpired(limit: number, now: Date): Promise<WorkflowInstance[]>;
  findParkedTimeouts(input: { limit: number; workflowName?: string }): Promise<WorkflowInstance[]>;
}
```

| Method                                         | Tx required? | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create(instance)`                             | Recommended  | Insert a new workflow instance record. Typically called inside the same transaction as the initial history record append and any onEnter chain writes.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `findByUuid(uuid)`                             | Not required | Find an instance by UUID (no locking). Safe to call outside a transaction (read-only). Returns `null` if not found.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `lockByUuid(uuid)`                             | **Required** | Find and lock an instance for update (`SELECT ... FOR UPDATE`). **Adapters must throw if called outside an active transaction** — a lock without a transaction releases immediately and defeats its purpose. Returns `null` if not found.                                                                                                                                                                                                                                                                                                                  |
| `update(instance)`                             | Recommended  | Update mutable fields: `currentState`, `version`, `definitionVersion`, `expiresAt`, `timeoutRetry`, `lastTransitionAt`, `context`, `updatedAt`. Uses optimistic locking: the WHERE clause must include `AND version = $expectedVersion` (i.e., `instance.version - 1`). If no row is matched, throw `WorkflowError` to signal a concurrent modification. `metadata` is immutable and is NOT updated.                                                                                                                                                       |
| `findExpired(limit, now)`                      | **Required** | Find instances whose timeout is due, locked for update with skip-locked semantics (`FOR UPDATE SKIP LOCKED`). Due means `expiresAt < now` (the `now` parameter, not the database clock), not parked (`timeoutRetry?.parkedAt` is null), and no retry scheduled or `timeoutRetry.retryAt < now`. Order by `timeoutRetry.retryAt ?? expiresAt`, oldest first. **Adapters must throw if called outside an active transaction.** Multiple workers can call this concurrently without processing the same instance twice, because uncontested rows are skipped. |
| `findParkedTimeouts({ limit, workflowName? })` | **Required** | List parked instances (`timeoutRetry.parkedAt` set), optionally filtered by workflow name, ordered by `parkedAt` then `uuid`, at most `limit`. A plain read; no transaction required.                                                                                                                                                                                                                                                                                                                                                                      |

**`WorkflowInstance.timeoutRetry`** (`{ attempts, lastError, retryAt, parkedAt } | null`) must round-trip through `create`/`update`. `null` means no timeout attempt has failed since the last success. The bundled adapters store it in four columns (`timeout_attempts`, `timeout_retry_at`, `timeout_last_error`, `timeout_parked_at`), and `timeout_attempts = 0` maps to `null`.

### WorkflowHistoryStore

Manages the immutable audit log.

```ts
interface WorkflowHistoryStore {
  append(entry: WorkflowHistoryRecord): Promise<string>;
  findByInstanceUuid(
    workflowInstanceUuid: string,
    options?: { limit?: number; offset?: number },
  ): Promise<WorkflowHistoryRecord[]>;
}
```

| Method                               | Tx required? | Description                                                                                                                                                                                             |
| ------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `append(entry)`                      | Recommended  | Insert a history record. Returns the generated UUID of the new record. Typically inside the same transaction as the corresponding `update` call so history and instance state are committed atomically. |
| `findByInstanceUuid(uuid, options?)` | Not required | Find history records for an instance, ordered by creation time descending. Safe to call outside a transaction (read-only). Supports pagination via `limit` (default 50) and `offset` (default 0).       |

**WorkflowHistoryRecord:**

```ts
interface WorkflowHistoryRecord {
  workflowInstanceUuid: string;
  fromState: string | null; // null for creation events
  eventName: string;
  toState: string;
  outcome: "success" | "failure";
  errorMessage?: string; // extracted from last failed command's message/code
  commandResultsJson: CommandResult[];
  triggerMetadata?: Record<string, unknown>;
  definitionVersion?: number | null; // the definition version that governed this transition
  createdAt?: Date; // when the store recorded this transition; ignored on write
}
```

`createdAt` is populated by the store on read and ignored on `append()` -- the database assigns it. **Caveat:** every history row written inside the same database transaction (an event plus its entire `onEnter` chain) shares an identical `createdAt`, and stores tiebreak same-timestamp rows on a random UUID, so this field tells you roughly _when_ a transition happened but must not be used to reconstruct the order of steps within one multi-hop transition. See [Ordering within a multi-hop transition](#ordering-within-a-multi-hop-transition) below for why, and how to make it recoverable.

#### Ordering within a multi-hop transition

Both bundled stores read history with `ORDER BY created_at DESC, uuid DESC` (see [`PgWorkflowHistoryStore.findByInstanceUuid()`](#individual-classes) and the Kysely adapter's equivalent `.orderBy("created_at", "desc").orderBy("uuid", "desc")`). PostgreSQL's `now()` -- and therefore every `created_at DEFAULT now()` write -- is **transaction-scoped**, so every history row written inside one transaction (an event plus its entire `onEnter` chain) gets an identical `created_at`. That makes `uuid` the only tiebreaker, and its default, `gen_random_uuid()`, is random.

This was verified on PostgreSQL 18.4 by issuing five separate `INSERT`s inside one transaction and reading them back with the stores' exact ordering:

- `now()` produced **one** distinct value across all five rows, confirming transaction scoping.
- With `gen_random_uuid()`, rows inserted `1 → 5` came back as `1, 3, 4, 5, 2` -- scrambled.
- With `uuidv7()`, they came back as `5, 4, 3, 2, 1` -- exactly right for a newest-first read, including ties within a single millisecond.

So: pass `uuidStrategy: "uuidv7"` to [`generateMigrationSql()`](#schema-setup) to make multi-hop history ordering recoverable. Two caveats:

- **`uuidv7()` requires PostgreSQL 18+.** On PG 13-17 it doesn't exist, so this isn't an option there -- on those versions, the relative order of rows written in the same transaction cannot be recovered from the returned records.
- **The shipped dbmate migration uses the random default.** `sql/dbmate/001_workflow_core.sql` declares `uuid uuid primary key default gen_random_uuid()` with no strategy option. Copying the dbmate migrations as-is gets you the random default; use `generateMigrationSql({ uuidStrategy: "uuidv7" })` instead, or hand-edit that column default.

This only affects ordering **within** one multi-hop transition. A single-hop transition writes one history row, so there's nothing to tiebreak. Ordering **between** separate transitions is unaffected either way -- they have distinct `created_at` values.

### WorkflowTransactionRunner

Wraps operations in a database transaction.

```ts
interface WorkflowTransactionRunner {
  runInTransaction<T>(callback: () => Promise<T>): Promise<T>;
  afterCommit?(callback: () => Promise<void>): void;
}
```

| Method                       | Description                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runInTransaction(callback)` | Execute the callback within a transaction. Commit on success, rollback on error. The transaction-scoped connection must be propagated (e.g. via `AsyncLocalStorage`) so that store methods called within the callback automatically use the same connection. If a transaction is already active on the current async context, adapters should run the callback in a **savepoint** on that connection (see below). |
| `afterCommit(callback)`      | Optional. Queue `callback` to run after the transaction active on the current async context commits; discard it if that scope, or a savepoint enclosing it, rolls back. The runtime uses it to fire observers strictly post-commit. Without it, the runtime fires observers when its own `runInTransaction` call returns.                                                                                         |

The key contract: when `runInTransaction` is active, `lockByUuid()` and `findExpired()` must use the **same database connection** as the transaction — this is what makes row locks (`FOR UPDATE`) work correctly. Both methods **must throw** if called outside an active transaction. This is typically achieved via `AsyncLocalStorage` or a similar mechanism.

**Nested calls run in savepoints.** The bundled adapters run a `runInTransaction` that is nested in an active transaction inside `SAVEPOINT duraflows_sp_<n>`. On success they `RELEASE` it; on failure they `ROLLBACK TO` it and rethrow. So a failed nested workflow call leaves none of its writes behind, even when the caller catches the error and goes on to commit, and the outer transaction stays usable, even after a SQL error. (Without a savepoint this is not true: a JavaScript exception does not abort a PostgreSQL transaction, so a caught failure's partial writes would commit with the outer transaction.) A custom adapter that reuses the connection without a savepoint still works, but it gives nested calls no failure isolation.

**`afterCommit` and savepoints work together.** Callbacks queued inside a savepoint move to the enclosing scope when it is released and are dropped when it is rolled back. When duraflows or an owner helper (`PgTransactionContext.transaction`, `KyselyTransactionContext.transaction`) owns the root, it runs them in order after `COMMIT`, outside the finished transaction and after its connection is released. When you seed a transaction you commit yourself (`PgTransactionContext.run`, `KyselyTransactionContext.run`, `kyselyWorkflowProvidersFromTransaction`), they run in order once the seeded callback resolves, still inside your open transaction, so a duraflows call made from one of them joins it as a savepoint. A throwing callback is logged and does not affect the others.

**Don't run duraflows calls concurrently on one transaction.** `Promise.all` of two workflow calls sharing one transaction is not supported: their savepoints interleave on the one connection, and row locks don't separate callers that share a transaction anyway. Run them one after another, or in separate transactions.

**Don't start duraflows calls from detached async work inside a transaction.** The active transaction travels with Node's `AsyncLocalStorage`, which also carries it into timers and promises started inside the transaction, even ones that outlive it. A duraflows call made later from such detached work still sees the finished transaction as active and tries to join it, on a connection that has already been released. Start such work after the transaction resolves, or run it in its own transaction.

**Each nested call is a subtransaction.** Every savepoint is a PostgreSQL subtransaction. A nested `processExpiredWorkflows()` with the default `limit: 100` opens about 100 of them in one transaction, and past the 64 subtransactions PostgreSQL caches per backend this can degrade performance on busy primaries and their replicas. Prefer running sweeps in their own transactions, or pass a smaller `limit` when you nest one.

**Conformance.** `runTransactionRunnerConformance` from `@duraflows/core/testing` checks a runner's `afterCommit` delivery and nested-failure isolation, next to `runInstanceStoreConformance` and `runDefinitionStoreConformance`.

### WorkflowDefinitionStore

Stores one immutable snapshot per `(workflow_name, version)`:

```ts
interface WorkflowDefinitionStore {
  ensure(record: {
    workflowName: string;
    version: number;
    contentHash: string;
    definitionJson: WorkflowDefinition;
  }): Promise<StoredWorkflowDefinition>;
  findByNameAndVersion(workflowName: string, version: number): Promise<StoredWorkflowDefinition | null>;
}
```

| Method                                        | Tx required? | Description                                                                                                                                                                                                                                                |
| --------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ensure(record)`                              | Not required | Insert-if-absent and return the stored row -- **never overwrites** an existing row. Must be atomic under concurrent callers. Both bundled adapters implement this as `INSERT ... ON CONFLICT (workflow_name, version) DO NOTHING` followed by a re-select. |
| `findByNameAndVersion(workflowName, version)` | Not required | Fetch a snapshot. Returns `null` if that `(workflowName, version)` pair has never been synced.                                                                                                                                                             |

`ensure()` is what `WorkflowRuntime.initialize()` calls for every registered definition, and its "insert-if-absent, never overwrite" contract is what makes the version-bump guard meaningful: once a `(workflowName, version)` pair is stored, its snapshot is fixed forever, so a later registration with the same version but different content is detected as drift rather than silently accepted.

### WorkflowPersistenceProvider

A convenience type that groups all four interfaces:

```ts
interface WorkflowPersistenceProvider {
  instanceStore: WorkflowInstanceStore;
  historyStore: WorkflowHistoryStore;
  transactionRunner: WorkflowTransactionRunner;
  definitionStore?: WorkflowDefinitionStore;
}
```

`definitionStore` is optional so existing custom providers keep compiling without changes; without it, definition-versioning features (the version-bump guard, the `workflow_definitions` snapshot table) are simply inert. The bundled `pgWorkflowProviders()` and `kyselyWorkflowProviders()` always supply it.

This is what `WorkflowModuleOptions.persistence` expects and what `pgWorkflowProviders()` returns.

## Built-in PostgreSQL Adapter

### Schema Setup

The `@duraflows/pg` package includes a `generateMigrationSql()` helper that returns the DDL for the workflow tables. You can choose between `gen_random_uuid()` (PG 13+) and `uuidv7()` (PG 18+) for history record UUIDs:

```ts
import { generateMigrationSql } from "@duraflows/pg";

const { up, down } = generateMigrationSql({ uuidStrategy: "uuidv7" });
// Paste into your migration file
```

Ready-made dbmate migrations using `gen_random_uuid()` are also shipped under `sql/dbmate/` — apply all of them in order (`001` alone is not sufficient for the current runtime).

This is not just a PostgreSQL-version preference: it also determines whether `workflow_history` rows written inside one transaction read back in the order they happened. See [Ordering within a multi-hop transition](#ordering-within-a-multi-hop-transition).

### Guard rejections

`workflow_history.outcome` admits a third value `'guard-rejected'`, and a nullable `rejected_by text` column carries the name of the guard that blocked the event. Migration `003_event_guards.sql` (dbmate) extends the CHECK constraint and adds the column. Fresh installs via `generateMigrationSql()` already include both.

### Definition versions

Migration `004_definition_versions.sql` (dbmate) adds the schema that backs [`WorkflowDefinitionStore`](#workflowdefinitionstore) and definition-version stamping:

- a new `workflow_definitions` table (`workflow_name`, `version`, `content_hash`, `definition_json`, `registered_at`, primary key `(workflow_name, version)`), and
- a nullable `definition_version integer` column on both `workflow_instances` and `workflow_history`.

Existing deployments apply this migration like any other -- all pre-existing rows get `definition_version IS NULL`, which maps to `definitionVersion: null` on `WorkflowInstance` and `definitionVersion: undefined` on `WorkflowHistoryRecord`. Instances pick up a real version stamp on their next transition. Fresh installs via `generateMigrationSql()` already include all of it.

### Timeout retries

Migration `005_timeout_retries.sql` (dbmate) adds the columns that back `WorkflowInstance.timeoutRetry`, plus two partial indexes: one on `coalesce(timeout_retry_at, expires_at)` for the sweep's ordering, and one on `timeout_parked_at` for listing parked instances. **Apply it before deploying 6.0.0**, since the runtime reads and writes these columns on every operation. Existing rows get `timeout_attempts = 0`, meaning "never failed". Fresh installs via `generateMigrationSql()` already include it.

### pgWorkflowProviders()

The simplest way to use the pg adapter:

```ts
import { pgWorkflowProviders } from "@duraflows/pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const persistence = pgWorkflowProviders(pool);

// persistence.instanceStore   -> PgWorkflowInstanceStore
// persistence.historyStore    -> PgWorkflowHistoryStore
// persistence.transactionRunner -> PgTransactionRunner
// persistence.definitionStore -> PgWorkflowDefinitionStore
```

An optional second argument configures [transaction timeouts](#transaction-timeouts):

```ts
const persistence = pgWorkflowProviders(pool, { lockTimeoutMs: 3000 });
```

### Transaction Timeouts

Both adapters accept two optional, transaction-scoped PostgreSQL timeouts. They are applied with `SET LOCAL` (the Kysely adapter uses the equivalent `set_config(..., is_local => true)`) immediately after the transaction opens, so they are reverted on `COMMIT`/`ROLLBACK` and never leak to other users of the shared pool.

They apply only to transactions the runner opens itself. Inside `PgTransactionContext.transaction()` / `KyselyTransactionContext.transaction()`, a seeded `run()` or `kyselyWorkflowProvidersFromTransaction()`, you own the transaction's settings, and nested duraflows calls run under them.

| Option               | PostgreSQL setting  | What it bounds                                                  | Default |
| -------------------- | ------------------- | --------------------------------------------------------------- | ------- |
| `lockTimeoutMs`      | `lock_timeout`      | How long a statement **waits for a row lock** before it aborts. | unset   |
| `statementTimeoutMs` | `statement_timeout` | How long **any single statement** may run before it aborts.     | unset   |

```ts
import { pgWorkflowProviders } from "@duraflows/pg";
import { kyselyWorkflowProviders } from "@duraflows/kysely";

// @duraflows/pg
const pgPersistence = pgWorkflowProviders(pool, { lockTimeoutMs: 3000 });

// @duraflows/kysely
const kyselyPersistence = kyselyWorkflowProviders(db, { lockTimeoutMs: 3000 });
```

**`lockTimeoutMs` is the setting to reach for.** `triggerEvent()` opens a transaction and calls `lockByUuid()`, which issues a blocking `SELECT ... FOR UPDATE`. Without `lock_timeout` that statement waits indefinitely: if another transaction is holding the row (a stuck worker, a long-running peer transition), the call hangs _and_ keeps a pooled connection checked out for the whole wait. Under load, that is how a pool gets exhausted by a single stuck row. A few seconds is usually right — long enough to ride out normal contention, short enough that a caller gets a clear `canceling statement due to lock timeout` error instead of hanging.

**`statementTimeoutMs` is deliberately not enabled by default**, and you should think before turning it on. It bounds _every_ statement on the transaction's connection, including SQL your own commands issue inside the same transaction. A command that legitimately runs a slow query — a bulk write, a heavy aggregate, a report — gets aborted and takes the whole transition down with it. Set it only when you know the ceiling for the slowest statement your workflows can produce, and set it comfortably above that.

Note that neither setting bounds time spent _between_ statements. A command performing slow external I/O (an HTTP call to a payment provider, say) holds the transaction open for as long as it takes, and no PostgreSQL timeout will interrupt it. Keep slow external I/O out of the transaction, or bound it in your own command code.

Both values must be non-negative integers (milliseconds); `0` is PostgreSQL's own "no timeout". Anything else — a negative number, a fraction, `NaN`, `Infinity` — throws a `WorkflowError` at construction time, long before any SQL is built.

### Individual Classes

If you need more control, use the classes directly:

```ts
import {
  PgWorkflowInstanceStore,
  PgWorkflowHistoryStore,
  PgWorkflowDefinitionStore,
  PgTransactionRunner,
  PgTransactionContext,
} from "@duraflows/pg";
```

**PgTransactionRunner**

```ts
class PgTransactionRunner implements WorkflowTransactionRunner {
  constructor(pool: Pool, options?: { lockTimeoutMs?: number; statementTimeoutMs?: number });
  async runInTransaction<T>(callback: () => Promise<T>): Promise<T>;
  afterCommit(callback: () => Promise<void>): void;
}
```

Acquires a `PoolClient`, runs `BEGIN`, emits any configured [`SET LOCAL` timeouts](#transaction-timeouts), stores the client in `PgTransactionContext` (via `AsyncLocalStorage`), executes the callback, then `COMMIT` or `ROLLBACK`, and runs the `afterCommit` callbacks after `COMMIT`. If already within an active transaction (detected via `PgTransactionContext`), the callback runs in `SAVEPOINT duraflows_sp_<n>` on the existing client, which is released on success or rolled back to on failure. The outer transaction's timeouts stay in force, and nothing is re-applied.

**PgWorkflowInstanceStore**

```ts
class PgWorkflowInstanceStore implements WorkflowInstanceStore {
  constructor(pool: Pool);
}
```

- Uses the transaction-scoped client from `PgTransactionContext` when available; falls back to the pool for non-transactional reads
- `lockByUuid()` uses `SELECT ... FOR UPDATE` (requires active transaction)
- `update()` uses optimistic locking: `WHERE uuid = $1 AND version = $expectedVersion`. Throws `WorkflowError` if `rowCount === 0` (concurrent modification)
- `findExpired(limit, now)` uses `SELECT ... WHERE expires_at < $now FOR UPDATE SKIP LOCKED LIMIT $1` (requires active transaction). The `now` parameter comes from the application clock, not the database's `now()`

**PgWorkflowHistoryStore**

```ts
class PgWorkflowHistoryStore implements WorkflowHistoryStore {
  constructor(pool: Pool);
}
```

- `append()` uses `INSERT ... RETURNING uuid`
- `findByInstanceUuid()` uses `SELECT ... ORDER BY created_at DESC, uuid DESC LIMIT $2 OFFSET $3` -- see [Ordering within a multi-hop transition](#ordering-within-a-multi-hop-transition) for why `uuid` is part of the sort

**PgWorkflowDefinitionStore**

```ts
class PgWorkflowDefinitionStore implements WorkflowDefinitionStore {
  constructor(pool: Pool);
}
```

- `ensure()` uses `INSERT ... ON CONFLICT (workflow_name, version) DO NOTHING`, then re-selects the row -- so it always returns the pre-existing snapshot if one was already stored, and never overwrites it
- `findByNameAndVersion()` uses `SELECT ... WHERE workflow_name = $1 AND version = $2`

**PgTransactionContext**

An `AsyncLocalStorage`-based mechanism for propagating the transaction-scoped `PoolClient`. The context is scoped per pool instance:

```ts
const PgTransactionContext = {
  getClient(pool: Pool): PoolClient | undefined;
  run<T>(pool: Pool, client: PoolClient, callback: () => T): T;
  transaction<T>(pool: Pool, callback: (client: PoolClient) => Promise<T>): Promise<T>;
};
```

`transaction()` is the recommended way to share a transaction with duraflows: it owns `BEGIN`/`COMMIT`, observers fire after `COMMIT`, and inside an already-active transaction it joins it as a savepoint. `run()` seeds a transaction you manage yourself: observers fire when the callback resolves, before your `COMMIT`, and duraflows calls they make join your transaction. `getClient()` is for store implementations.

## Writing a Custom Adapter

To use a different database library, implement the three required interfaces and pass them as the `persistence` option. Optionally implement the fourth, [`WorkflowDefinitionStore`](#workflowdefinitionstore), to support definition versioning -- it's an optional field on `WorkflowPersistenceProvider`, so an adapter that omits it still compiles and runs, it just leaves definition versioning inert.

### Example: Prisma Adapter

```ts
import { PrismaClient } from "@prisma/client";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  WorkflowInstanceStore,
  WorkflowHistoryStore,
  WorkflowTransactionRunner,
  WorkflowDefinitionStore,
  WorkflowPersistenceProvider,
  WorkflowInstance,
  WorkflowHistoryRecord,
  StoredWorkflowDefinition,
  WorkflowDefinition,
} from "@duraflows/core";

// Transaction context for Prisma
type PrismaTx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;
const txStorage = new AsyncLocalStorage<PrismaTx>();

// Transaction runner
class PrismaTransactionRunner implements WorkflowTransactionRunner {
  constructor(private readonly prisma: PrismaClient) {}

  async runInTransaction<T>(callback: () => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      return txStorage.run(tx, callback);
    });
  }
}

// Instance store
class PrismaWorkflowInstanceStore implements WorkflowInstanceStore {
  constructor(private readonly prisma: PrismaClient) {}

  private get client(): PrismaClient | PrismaTx {
    return txStorage.getStore() ?? this.prisma;
  }

  async create(instance: WorkflowInstance): Promise<void> {
    await this.client.workflowInstance.create({
      data: {
        uuid: instance.uuid,
        workflowName: instance.workflowName,
        currentState: instance.currentState,
        version: instance.version,
        expiresAt: instance.expiresAt,
        lastTransitionAt: instance.lastTransitionAt,
        contextJson: instance.context,
        metadataJson: instance.metadata,
        createdAt: instance.createdAt,
        updatedAt: instance.updatedAt,
        timeoutAttempts: instance.timeoutRetry?.attempts ?? 0,
        timeoutRetryAt: instance.timeoutRetry?.retryAt ?? null,
        timeoutLastError: instance.timeoutRetry?.lastError ?? null,
        timeoutParkedAt: instance.timeoutRetry?.parkedAt ?? null,
      },
    });
  }

  async findByUuid(uuid: string): Promise<WorkflowInstance | null> {
    const row = await this.client.workflowInstance.findUnique({
      where: { uuid },
    });
    return row ? this.mapRow(row) : null;
  }

  async lockByUuid(uuid: string): Promise<WorkflowInstance | null> {
    const tx = txStorage.getStore();
    if (!tx) throw new Error("lockByUuid requires an active transaction");

    // Prisma doesn't natively support FOR UPDATE on findUnique,
    // so use $queryRaw
    const rows = await (tx as any).$queryRaw`
      SELECT * FROM workflow_instances WHERE uuid = ${uuid}::uuid FOR UPDATE
    `;
    if (!rows[0]) return null;
    return this.mapRow(rows[0]);
  }

  async update(instance: WorkflowInstance): Promise<void> {
    const expectedVersion = instance.version - 1;
    const result = await this.client.workflowInstance.updateMany({
      where: { uuid: instance.uuid, version: expectedVersion },
      data: {
        currentState: instance.currentState,
        version: instance.version,
        expiresAt: instance.expiresAt,
        lastTransitionAt: instance.lastTransitionAt,
        contextJson: instance.context,
        updatedAt: instance.updatedAt,
        timeoutAttempts: instance.timeoutRetry?.attempts ?? 0,
        timeoutRetryAt: instance.timeoutRetry?.retryAt ?? null,
        timeoutLastError: instance.timeoutRetry?.lastError ?? null,
        timeoutParkedAt: instance.timeoutRetry?.parkedAt ?? null,
      },
    });
    if (result.count === 0) {
      throw new WorkflowError(
        `Optimistic locking failure: workflow instance "${instance.uuid}" was modified concurrently (expected version ${expectedVersion})`,
      );
    }
  }

  async findExpired(limit: number, now: Date): Promise<WorkflowInstance[]> {
    const tx = txStorage.getStore();
    if (!tx) throw new Error("findExpired requires an active transaction");

    // Due: expired, not parked, and no retry scheduled or the retry is due.
    // Ordered by the retry time when one is scheduled, otherwise expiresAt --
    // same semantics as the bundled pg/Kysely adapters.
    const rows = await (tx as any).$queryRaw`
      SELECT * FROM workflow_instances
      WHERE expires_at IS NOT NULL AND expires_at < ${now}
        AND timeout_parked_at IS NULL
        AND (timeout_retry_at IS NULL OR timeout_retry_at < ${now})
      ORDER BY coalesce(timeout_retry_at, expires_at)
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    `;
    return rows.map((row: any) => this.mapRow(row));
  }

  async findParkedTimeouts(options: { limit: number; workflowName?: string }): Promise<WorkflowInstance[]> {
    const rows = await this.client.workflowInstance.findMany({
      where: {
        timeoutParkedAt: { not: null },
        ...(options.workflowName ? { workflowName: options.workflowName } : {}),
      },
      orderBy: [{ timeoutParkedAt: "asc" }, { uuid: "asc" }],
      take: options.limit,
    });
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: any): WorkflowInstance {
    return {
      uuid: row.uuid,
      workflowName: row.workflowName ?? row.workflow_name,
      currentState: row.currentState ?? row.current_state,
      version: row.version,
      expiresAt: row.expiresAt ?? row.expires_at ?? null,
      timeoutRetry: this.mapTimeoutRetry(row),
      lastTransitionAt: new Date(row.lastTransitionAt ?? row.last_transition_at),
      context: row.contextJson ?? row.context_json ?? {},
      metadata: row.metadataJson ?? row.metadata_json ?? {},
      createdAt: new Date(row.createdAt ?? row.created_at),
      updatedAt: new Date(row.updatedAt ?? row.updated_at),
    };
  }

  // Mirrors the bundled adapters: timeout_attempts = 0 means "never failed" -> null.
  private mapTimeoutRetry(row: any): WorkflowInstance["timeoutRetry"] {
    const attempts = row.timeoutAttempts ?? row.timeout_attempts ?? 0;
    if (attempts === 0) return null;
    const retryAt = row.timeoutRetryAt ?? row.timeout_retry_at;
    const parkedAt = row.timeoutParkedAt ?? row.timeout_parked_at;
    return {
      attempts,
      lastError: row.timeoutLastError ?? row.timeout_last_error ?? "",
      retryAt: retryAt ? new Date(retryAt) : null,
      parkedAt: parkedAt ? new Date(parkedAt) : null,
    };
  }
}

// History store (similar pattern)
class PrismaWorkflowHistoryStore implements WorkflowHistoryStore {
  constructor(private readonly prisma: PrismaClient) {}
  // ... implement append() and findByInstanceUuid()
}

// Definition store (optional -- required only to support definition versioning;
// omit it from the returned provider below and the adapter still compiles and runs).
class PrismaWorkflowDefinitionStore implements WorkflowDefinitionStore {
  constructor(private readonly prisma: PrismaClient) {}
  // ... implement ensure() as insert-if-absent (e.g. Prisma's `createMany` with
  // `skipDuplicates`, or `$queryRaw` with `ON CONFLICT DO NOTHING`) followed by a
  // re-select -- it must never overwrite an existing (workflowName, version) row --
  // and findByNameAndVersion() as a plain lookup returning null when absent.
}

// Convenience function
export function prismaWorkflowProviders(prisma: PrismaClient): WorkflowPersistenceProvider {
  return {
    instanceStore: new PrismaWorkflowInstanceStore(prisma),
    historyStore: new PrismaWorkflowHistoryStore(prisma),
    transactionRunner: new PrismaTransactionRunner(prisma),
    definitionStore: new PrismaWorkflowDefinitionStore(prisma), // optional
  };
}
```

### Usage

```ts
// NestJS
WorkflowModule.forRoot({
  workflows: [...],
  commands: [...],
  persistence: prismaWorkflowProviders(prisma),
})

// Standalone
const runtime = new WorkflowRuntime({
  definitionRegistry,
  commandRegistry,
  ...prismaWorkflowProviders(prisma),
  clock: { now: () => new Date() },
});
```

## Key Implementation Notes

### Transaction Propagation

The most important contract to get right: when `runInTransaction()` is active, all store methods called within the callback must use the **same database connection**. This is how row-level locks (`FOR UPDATE`) work -- they are held by the connection that acquired them.

The pattern is:

1. `TransactionRunner` acquires a connection and begins a transaction
2. Stores the connection in `AsyncLocalStorage`
3. Store methods check `AsyncLocalStorage` for an active connection
4. If found, use it; if not, use the default pool/client

### SKIP LOCKED

The `findExpired()` method should use `SKIP LOCKED` (or equivalent) to allow concurrent timeout processors. Without this, multiple processors would block each other waiting for the same rows.

### Atomicity

Each `triggerEvent()` call runs in a single transaction:

- Lock instance
- Execute commands
- Update instance state
- Append history record
- Commit

If any step fails (including command exceptions), the entire transaction rolls back. No partial state is persisted.

### Context serialization fidelity

`context` and `metadata` are persisted as JSONB via `JSON.stringify`. Only plain JSON survives the round-trip:

- `Date` values are serialized to ISO strings and come back as **strings** — store `ctx.now.toISOString()` explicitly rather than `Date` objects.
- Keys with `undefined` values are dropped on write and never restored.
- `bigint`, `Map`, `Set`, class instances, and circular references are not supported (`bigint` throws; the others silently lose data).

Store IDs and primitives, not rich objects.

## Adapter Conformance Tests

`@duraflows/core` ships a shared conformance suite that any adapter can import to verify it satisfies the cross-adapter contract. The helper is exported from the `@duraflows/core/testing` subpath (a dev-time entry point, not part of the main bundle).

```ts
import { runInstanceStoreConformance } from "@duraflows/core/testing";

runInstanceStoreConformance("my-adapter", {
  setup: async () => {
    const store = new MyInstanceStore();
    const transactionRunner = new MyTransactionRunner();
    return {
      store,
      transactionRunner,
      teardown: async () => {
        // close connections, flush state, etc.
      },
    };
  },
});
```

The suite covers:

| Test                                 | What it verifies                                                                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create` / `findByUuid` roundtrip    | Stored instance is retrievable by UUID                                                                                                                                           |
| `findByUuid` unknown UUID            | Returns `null`, not an error                                                                                                                                                     |
| `update` mutable fields              | `currentState`, `version`, `context`, `expiresAt` are persisted                                                                                                                  |
| `update` metadata immutability       | Mutating `metadata` on the locked object has no effect on the stored row                                                                                                         |
| `findExpired` filtering              | Past `expiresAt` → included; future / null → excluded                                                                                                                            |
| `findExpired` limit                  | Result length respects the `limit` parameter                                                                                                                                     |
| `timeoutRetry` roundtrip             | `create`, `update` (to `null`), and `update` (to parked) all preserve `timeoutRetry` through `findByUuid`                                                                        |
| `findExpired` retry/parked filtering | Instances with a future `timeoutRetry.retryAt` or a `timeoutRetry.parkedAt` are excluded; remaining results are ordered by `timeoutRetry.retryAt ?? expiresAt`, oldest due first |
| `findParkedTimeouts`                 | Only parked instances (`timeoutRetry.parkedAt` set) are returned, ordered by `parkedAt` ascending; `workflowName` filters and `limit` caps the result                            |
| `definitionVersion` roundtrip        | `create` → `findByUuid` → `update` → `findByUuid` all preserve it                                                                                                                |

A second, sibling suite covers `WorkflowDefinitionStore` -- the store that backs [definition versions](#definition-versions). It's exported the same way, from the same subpath:

```ts
import { runDefinitionStoreConformance } from "@duraflows/core/testing";

runDefinitionStoreConformance("my-adapter", {
  setup: async () => {
    const store = new MyDefinitionStore();
    return {
      store,
      teardown: async () => {
        // close connections, flush state, etc.
      },
    };
  },
});
```

Its harness (`DefinitionStoreConformanceHarness`) is smaller than the instance-store one -- no `transactionRunner`, since `ensure()`/`findByNameAndVersion()` don't require a transaction:

```ts
interface DefinitionStoreConformanceHarness {
  setup(): Promise<{
    store: WorkflowDefinitionStore;
    teardown: () => Promise<void>;
  }>;
}
```

The suite covers:

| Test                                | What it verifies                                                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ensure` inserts                    | A new `(workflowName, version)` snapshot is inserted and the stored row is returned                                                |
| `ensure` is insert-if-absent        | Calling `ensure` again for the same `(workflowName, version)` returns the pre-existing row unchanged, not the caller's new content |
| `findByNameAndVersion` roundtrip    | Retrieves a stored snapshot with a structurally equal `definitionJson`                                                             |
| `findByNameAndVersion` unknown pair | Returns `null` for an unknown version or an unknown workflow name                                                                  |
| Independent versions                | Two versions of the same workflow are stored and retrieved as independent rows                                                     |
