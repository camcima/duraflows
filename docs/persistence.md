# Persistence

The workflow runtime is decoupled from any specific database library. The core package defines three persistence interfaces. The `@duraflows/pg` package provides a built-in PostgreSQL adapter using `pg`, but you can implement these interfaces with Prisma, Drizzle, TypeORM, or any other library.

## Persistence Interfaces

All three interfaces are defined in `@duraflows/core`:

```ts
import type {
  WorkflowInstanceStore,
  WorkflowHistoryStore,
  WorkflowTransactionRunner,
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
}
```

| Method                    | Tx required? | Description                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create(instance)`        | Recommended  | Insert a new workflow instance record. Typically called inside the same transaction as the initial history record append and any onEnter chain writes.                                                                                                                                                                                                          |
| `findByUuid(uuid)`        | Not required | Find an instance by UUID (no locking). Safe to call outside a transaction (read-only). Returns `null` if not found.                                                                                                                                                                                                                                             |
| `lockByUuid(uuid)`        | **Required** | Find and lock an instance for update (`SELECT ... FOR UPDATE`). **Adapters must throw if called outside an active transaction** — a lock without a transaction releases immediately and defeats its purpose. Returns `null` if not found.                                                                                                                       |
| `update(instance)`        | Recommended  | Update mutable fields: `currentState`, `version`, `expiresAt`, `lastTransitionAt`, `context`, `updatedAt`. Uses optimistic locking: the WHERE clause must include `AND version = $expectedVersion` (i.e., `instance.version - 1`). If no row is matched, throw `WorkflowError` to signal a concurrent modification. `metadata` is immutable and is NOT updated. |
| `findExpired(limit, now)` | **Required** | Find instances where `expiresAt < now` (the `now` parameter — not the database clock), locked for update with skip-locked semantics (`FOR UPDATE SKIP LOCKED`). **Adapters must throw if called outside an active transaction.** Multiple workers can call this concurrently without processing the same instance twice because uncontested rows are skipped.   |

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
}
```

### WorkflowTransactionRunner

Wraps operations in a database transaction.

```ts
interface WorkflowTransactionRunner {
  runInTransaction<T>(callback: () => Promise<T>): Promise<T>;
}
```

| Method                       | Description                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runInTransaction(callback)` | Execute the callback within a transaction. Commit on success, rollback on error. The transaction-scoped connection must be propagated (e.g. via `AsyncLocalStorage`) so that store methods called within the callback automatically use the same connection. If already within an active transaction on the current async context, adapters should reuse the existing connection rather than opening a nested transaction. |

The key contract: when `runInTransaction` is active, `lockByUuid()` and `findExpired()` must use the **same database connection** as the transaction — this is what makes row locks (`FOR UPDATE`) work correctly. Both methods **must throw** if called outside an active transaction. This is typically achieved via `AsyncLocalStorage` or a similar mechanism.

**Nesting is flat, not nested.** Because a nested `runInTransaction` reuses the outer connection instead of opening a savepoint, there is no inner scope to roll back independently: a failure anywhere inside the callback aborts the **whole** transaction. Catching that error does not recover it — PostgreSQL puts the connection in a failed state and rejects every subsequent statement with `current transaction is aborted` until the outermost transaction rolls back. Do not write code that catches an error from an inner `runInTransaction` and carries on issuing queries; let the error propagate to the outermost caller.

### WorkflowPersistenceProvider

A convenience type that groups all three interfaces:

```ts
interface WorkflowPersistenceProvider {
  instanceStore: WorkflowInstanceStore;
  historyStore: WorkflowHistoryStore;
  transactionRunner: WorkflowTransactionRunner;
}
```

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

### Guard rejections

`workflow_history.outcome` admits a third value `'guard-rejected'`, and a nullable `rejected_by text` column carries the name of the guard that blocked the event. Migration `003_event_guards.sql` (dbmate) extends the CHECK constraint and adds the column. Fresh installs via `generateMigrationSql()` already include both.

### pgWorkflowProviders()

The simplest way to use the pg adapter:

```ts
import { pgWorkflowProviders } from "@duraflows/pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const persistence = pgWorkflowProviders(pool);

// persistence.instanceStore  -> PgWorkflowInstanceStore
// persistence.historyStore   -> PgWorkflowHistoryStore
// persistence.transactionRunner -> PgTransactionRunner
```

An optional second argument configures [transaction timeouts](#transaction-timeouts):

```ts
const persistence = pgWorkflowProviders(pool, { lockTimeoutMs: 3000 });
```

### Transaction Timeouts

Both adapters accept two optional, transaction-scoped PostgreSQL timeouts. They are applied with `SET LOCAL` (the Kysely adapter uses the equivalent `set_config(..., is_local => true)`) immediately after the transaction opens, so they are reverted on `COMMIT`/`ROLLBACK` and never leak to other users of the shared pool.

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
  PgTransactionRunner,
  PgTransactionContext,
} from "@duraflows/pg";
```

**PgTransactionRunner**

```ts
class PgTransactionRunner implements WorkflowTransactionRunner {
  constructor(pool: Pool, options?: { lockTimeoutMs?: number; statementTimeoutMs?: number });
  async runInTransaction<T>(callback: () => Promise<T>): Promise<T>;
}
```

Acquires a `PoolClient`, runs `BEGIN`, emits any configured [`SET LOCAL` timeouts](#transaction-timeouts), stores the client in `PgTransactionContext` (via `AsyncLocalStorage`), executes the callback, then `COMMIT` or `ROLLBACK`. If already within an active transaction (detected via `PgTransactionContext`), the existing client is reused and the callback runs without opening a nested transaction — the outer transaction's timeouts stay in force and are not re-applied.

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
- `findByInstanceUuid()` uses `SELECT ... ORDER BY created_at DESC LIMIT $2 OFFSET $3`

**PgTransactionContext**

An `AsyncLocalStorage`-based mechanism for propagating the transaction-scoped `PoolClient`. The context is scoped per pool instance:

```ts
const PgTransactionContext = {
  getClient(pool: Pool): PoolClient | undefined;
  run<T>(pool: Pool, client: PoolClient, callback: () => T): T;
};
```

This is an implementation detail -- you typically don't interact with it directly.

## Writing a Custom Adapter

To use a different database library, implement the three interfaces and pass them as the `persistence` option.

### Example: Prisma Adapter

```ts
import { PrismaClient } from "@prisma/client";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  WorkflowInstanceStore,
  WorkflowHistoryStore,
  WorkflowTransactionRunner,
  WorkflowPersistenceProvider,
  WorkflowInstance,
  WorkflowHistoryRecord,
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

    const rows = await (tx as any).$queryRaw`
      SELECT * FROM workflow_instances
      WHERE expires_at IS NOT NULL AND expires_at < ${now}
      ORDER BY expires_at
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    `;
    return rows.map((row: any) => this.mapRow(row));
  }

  private mapRow(row: any): WorkflowInstance {
    return {
      uuid: row.uuid,
      workflowName: row.workflowName ?? row.workflow_name,
      currentState: row.currentState ?? row.current_state,
      version: row.version,
      expiresAt: row.expiresAt ?? row.expires_at ?? null,
      lastTransitionAt: new Date(row.lastTransitionAt ?? row.last_transition_at),
      context: row.contextJson ?? row.context_json ?? {},
      metadata: row.metadataJson ?? row.metadata_json ?? {},
      createdAt: new Date(row.createdAt ?? row.created_at),
      updatedAt: new Date(row.updatedAt ?? row.updated_at),
    };
  }
}

// History store (similar pattern)
class PrismaWorkflowHistoryStore implements WorkflowHistoryStore {
  constructor(private readonly prisma: PrismaClient) {}
  // ... implement append() and findByInstanceUuid()
}

// Convenience function
export function prismaWorkflowProviders(prisma: PrismaClient): WorkflowPersistenceProvider {
  return {
    instanceStore: new PrismaWorkflowInstanceStore(prisma),
    historyStore: new PrismaWorkflowHistoryStore(prisma),
    transactionRunner: new PrismaTransactionRunner(prisma),
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

| Test                              | What it verifies                                                         |
| --------------------------------- | ------------------------------------------------------------------------ |
| `create` / `findByUuid` roundtrip | Stored instance is retrievable by UUID                                   |
| `findByUuid` unknown UUID         | Returns `null`, not an error                                             |
| `update` mutable fields           | `currentState`, `version`, `context`, `expiresAt` are persisted          |
| `update` metadata immutability    | Mutating `metadata` on the locked object has no effect on the stored row |
| `findExpired` filtering           | Past `expiresAt` → included; future / null → excluded                    |
| `findExpired` limit               | Result length respects the `limit` parameter                             |
