# Persistence

The workflow runtime is decoupled from any specific database library. The core package defines three persistence interfaces. The `@camcima/duraflows-pg` package provides a built-in PostgreSQL adapter using `pg`, but you can implement these interfaces with Prisma, Drizzle, TypeORM, or any other library.

## Persistence Interfaces

All three interfaces are defined in `@camcima/duraflows-core`:

```ts
import type {
  WorkflowInstanceStore,
  WorkflowHistoryStore,
  WorkflowTransactionRunner,
  WorkflowPersistenceProvider,
} from "@camcima/duraflows-core";
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

| Method | Description |
|--------|-------------|
| `create(instance)` | Insert a new workflow instance record |
| `findByUuid(uuid)` | Find an instance by UUID (no locking). Returns `null` if not found |
| `lockByUuid(uuid)` | Find and lock an instance for update (e.g., `SELECT ... FOR UPDATE`). Must be called within a transaction. Returns `null` if not found |
| `update(instance)` | Update mutable fields: `currentState`, `version`, `expiresAt`, `lastTransitionAt`, `context`, `updatedAt`. Uses optimistic locking: the WHERE clause must include `AND version = $expectedVersion` (i.e., `instance.version - 1`). If no row is matched, throw `WorkflowError` to signal a concurrent modification. Note: `metadata` is immutable and not updated. |
| `findExpired(limit, now)` | Find instances where `expiresAt < now` (the `now` parameter, not the database's `now()`), locked for update with skip-locked semantics (e.g., `FOR UPDATE SKIP LOCKED`). Must be called within a transaction |

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

| Method | Description |
|--------|-------------|
| `append(entry)` | Insert a history record. Returns the generated UUID of the new record |
| `findByInstanceUuid(uuid, options?)` | Find history records for an instance, ordered by creation time descending. Supports pagination via `limit` (default 50) and `offset` (default 0) |

**WorkflowHistoryRecord:**

```ts
interface WorkflowHistoryRecord {
  workflowInstanceUuid: string;
  fromState: string | null;      // null for creation events
  eventName: string;
  toState: string;
  outcome: "success" | "failure";
  errorMessage?: string;          // extracted from last failed command's message/code
  commandResultsJson: CommandResult[];
  triggeredByType?: string;      // "user", "admin", "system", "timeout"
  triggeredByUuid?: string;      // actor UUID
}
```

### WorkflowTransactionRunner

Wraps operations in a database transaction.

```ts
interface WorkflowTransactionRunner {
  runInTransaction<T>(callback: () => Promise<T>): Promise<T>;
}
```

| Method | Description |
|--------|-------------|
| `runInTransaction(callback)` | Execute the callback within a transaction. Commit on success, rollback on error. The transaction-scoped connection must be available to store methods called within the callback |

The key contract: when `runInTransaction` is active, `lockByUuid()` and `findExpired()` must use the **same database connection** as the transaction. This is typically achieved via `AsyncLocalStorage` or a similar mechanism.

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

The `@camcima/duraflows-pg` package includes a `generateMigrationSql()` helper that returns the DDL for the workflow tables. You can choose between `gen_random_uuid()` (PG 13+) and `uuidv7()` (PG 18+) for history record UUIDs:

```ts
import { generateMigrationSql } from "@camcima/duraflows-pg";

const { up, down } = generateMigrationSql({ uuidStrategy: "uuidv7" });
// Paste into your migration file
```

A ready-made dbmate migration using `gen_random_uuid()` is also shipped at `sql/dbmate/001_workflow_core.sql`.

### pgWorkflowProviders()

The simplest way to use the pg adapter:

```ts
import { pgWorkflowProviders } from "@camcima/duraflows-pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const persistence = pgWorkflowProviders(pool);

// persistence.instanceStore  -> PgWorkflowInstanceStore
// persistence.historyStore   -> PgWorkflowHistoryStore
// persistence.transactionRunner -> PgTransactionRunner
```

### Individual Classes

If you need more control, use the classes directly:

```ts
import {
  PgWorkflowInstanceStore,
  PgWorkflowHistoryStore,
  PgTransactionRunner,
  PgTransactionContext,
} from "@camcima/duraflows-pg";
```

**PgTransactionRunner**

```ts
class PgTransactionRunner implements WorkflowTransactionRunner {
  constructor(pool: Pool);
  async runInTransaction<T>(callback: () => Promise<T>): Promise<T>;
}
```

Acquires a `PoolClient`, runs `BEGIN`, stores the client in `PgTransactionContext` (via `AsyncLocalStorage`), executes the callback, then `COMMIT` or `ROLLBACK`. If already within an active transaction (detected via `PgTransactionContext`), the existing client is reused and the callback runs without opening a nested transaction.

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

An `AsyncLocalStorage`-based mechanism for propagating the transaction-scoped `PoolClient`:

```ts
const PgTransactionContext = {
  getClient(): PoolClient | undefined;
  run<T>(client: PoolClient, callback: () => T): T;
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
} from "@camcima/duraflows-core";

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
