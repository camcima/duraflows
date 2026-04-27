---
name: duraflows-persistence-adapter
description: "Guides implementation of custom duraflows persistence adapters for Prisma, Drizzle, TypeORM, or other ORMs. Use when implementing WorkflowInstanceStore, WorkflowHistoryStore, or WorkflowTransactionRunner interfaces, or when the user wants to replace @duraflows/pg with a different database library."
---

# duraflows Persistence Adapter Guide

How to implement custom persistence adapters for duraflows. The core runtime is fully decoupled from any database library -- you implement three interfaces and plug them in.

> **v1.0.0 — verify with the conformance suite.** `@duraflows/core/testing` ships `runInstanceStoreConformance(factory)`, the canonical test suite for `WorkflowInstanceStore` implementations. It exercises locking, optimistic concurrency, expiration ordering, the metadata-write-once contract, and nested transactions. Reference adapters: `@duraflows/pg` and `@duraflows/kysely` (v0.4.0+) — both pass it in CI. See [Testing Your Adapter](#testing-your-adapter).

---

## Interfaces to Implement

### 1. WorkflowInstanceStore

```ts
interface WorkflowInstanceStore {
  create(instance: WorkflowInstance): Promise<void>;
  findByUuid(uuid: string): Promise<WorkflowInstance | null>;
  lockByUuid(uuid: string): Promise<WorkflowInstance | null>;
  update(instance: WorkflowInstance): Promise<void>;
  findExpired(limit: number, now: Date): Promise<WorkflowInstance[]>;
}
```

### 2. WorkflowHistoryStore

```ts
interface WorkflowHistoryStore {
  append(entry: WorkflowHistoryRecord): Promise<string>; // returns generated UUID
  findByInstanceUuid(
    workflowInstanceUuid: string,
    options?: { limit?: number; offset?: number },
  ): Promise<WorkflowHistoryRecord[]>;
}
```

### 3. WorkflowTransactionRunner

```ts
interface WorkflowTransactionRunner {
  runInTransaction<T>(callback: () => Promise<T>): Promise<T>;
}
```

---

## Critical Contract Requirements

### lockByUuid -- Pessimistic Row-Level Locking

This is the most important method to get right. The runtime calls it inside `triggerEvent()` to prevent concurrent modifications.

**Requirements:**

- **Must acquire a row-level lock** (e.g., `SELECT ... FOR UPDATE`)
- **Must require an active transaction** -- throw if called outside one
- **Lock held until transaction commits/rolls back**

**PostgreSQL reference:**

```sql
SELECT * FROM workflow_instances WHERE uuid = $1 FOR UPDATE
```

**Prisma equivalent:**

```ts
// Prisma doesn't have native FOR UPDATE. Options:
// 1. Use $queryRaw with FOR UPDATE
// 2. Use Prisma's interactive transactions with serializable isolation
await prisma.$queryRaw`SELECT * FROM workflow_instances WHERE uuid = ${uuid} FOR UPDATE`;
```

**Drizzle equivalent:**

```ts
await db.select().from(workflowInstances).where(eq(workflowInstances.uuid, uuid)).for("update");
```

### update -- Optimistic Concurrency Control

Prevents lost updates when two processes modify the same instance.

**Requirements:**

- Check that the stored version matches `instance.version - 1`
- If mismatch, throw `WorkflowError` with a descriptive message
- Increment version on success
- **(v1.0.0) MUST NOT modify `metadata_json`** — metadata is write-once after `create()`. `@duraflows/pg` and `@duraflows/kysely` both omit `metadata_json` from their UPDATE statements; `runInstanceStoreConformance` asserts on this.

**SQL pattern:**

```sql
UPDATE workflow_instances
SET current_state = $2, version = $3, expires_at = $4, ...
    -- DO NOT set metadata_json here (write-once after create)
WHERE uuid = $1 AND version = $9   -- $9 is instance.version - 1
```

**Error on mismatch:**

```ts
import { WorkflowError } from "@duraflows/core";

if (affectedRows === 0) {
  throw new WorkflowError(
    `Optimistic locking failure: workflow instance "${instance.uuid}" was modified concurrently (expected version ${instance.version - 1})`,
  );
}
```

### findExpired -- Concurrent Batch Processing

Called by `processExpiredWorkflows()` to find instances whose timeout has passed.

**Requirements:**

- **Must require an active transaction**
- **Must skip rows locked by other processes** (e.g., `FOR UPDATE SKIP LOCKED`)
- Filter: `expires_at IS NOT NULL AND expires_at <= now`
- Respect `limit` parameter

**SQL pattern:**

```sql
SELECT * FROM workflow_instances
WHERE expires_at IS NOT NULL AND expires_at <= $2
ORDER BY expires_at
FOR UPDATE SKIP LOCKED
LIMIT $1
```

**Why SKIP LOCKED?** Multiple workers can call `processExpiredWorkflows()` concurrently. Without SKIP LOCKED, they'd block each other. With it, each worker picks up different expired instances.

### runInTransaction -- Nested Transaction Support

**Requirements:**

- If already inside a transaction, **reuse** it (don't start a new one)
- On success: commit
- On error: rollback and re-throw
- The callback may call store methods that need the transaction context

**Pattern (using AsyncLocalStorage):**

```ts
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<TransactionClient>();

class MyTransactionRunner implements WorkflowTransactionRunner {
  async runInTransaction<T>(callback: () => Promise<T>): Promise<T> {
    // Reuse existing transaction if nested
    const existing = storage.getStore();
    if (existing) {
      return callback();
    }

    // Start new transaction
    const client = await this.getClient();
    try {
      await client.beginTransaction();
      const result = await storage.run(client, callback);
      await client.commit();
      return result;
    } catch (error) {
      await client.rollback();
      throw error;
    } finally {
      client.release();
    }
  }
}
```

**Store methods must detect the transaction context:**

```ts
class MyInstanceStore implements WorkflowInstanceStore {
  private getClient(): TransactionClient | PoolClient {
    return storage.getStore() ?? this.pool; // use transaction client if available
  }
}
```

---

## WorkflowInstance Fields

All fields must be persisted and restored correctly:

| Field              | Type                      | Storage Notes                                    |
| ------------------ | ------------------------- | ------------------------------------------------ |
| `uuid`             | `string`                  | PK, application-generated (not DB-generated)     |
| `workflowName`     | `string`                  | Text column                                      |
| `currentState`     | `string`                  | Text column                                      |
| `version`          | `number`                  | Integer, starts at 0, incremented on each update |
| `expiresAt`        | `Date \| null`            | Nullable timestamp                               |
| `lastTransitionAt` | `Date`                    | Timestamp                                        |
| `context`          | `Record<string, unknown>` | JSON/JSONB column                                |
| `metadata`         | `Record<string, unknown>` | JSON/JSONB column                                |
| `createdAt`        | `Date`                    | Timestamp                                        |
| `updatedAt`        | `Date`                    | Timestamp                                        |

### Date Handling

Always convert to/from `Date` objects:

```ts
// On write: pass Date directly (most ORMs handle this)
// On read: ensure you get Date objects back, not strings
expiresAt: row.expires_at ? new Date(row.expires_at) : null,
```

### JSON Handling

`context` and `metadata` must survive a JSON round-trip:

```ts
// On write: serialize to JSON
contextJson: JSON.stringify(instance.context),

// On read: parse back (most ORMs with JSONB do this automatically)
context: row.context_json as Record<string, unknown>,
```

---

## WorkflowHistoryRecord Fields

| Field                  | Type                                         | Storage Notes                                                                                                                                                      |
| ---------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workflowInstanceUuid` | `string`                                     | FK to workflow_instances                                                                                                                                           |
| `fromState`            | `string \| null`                             | Null for creation records                                                                                                                                          |
| `eventName`            | `string`                                     | "onEnter" for auto-transitions                                                                                                                                     |
| `toState`              | `string`                                     | Target state (== `fromState` for guard-rejected and command-only events)                                                                                           |
| `outcome`              | `"success" \| "failure" \| "guard-rejected"` | Constrained string. **(v1.1.0)** `"guard-rejected"` was added; CHECK constraint must accept it.                                                                    |
| `errorMessage`         | `string \| undefined`                        | Optional. Map DB `NULL` → `undefined` on read.                                                                                                                     |
| `rejectedBy`           | `string \| undefined`                        | **(v1.1.0)** declared `eventDef.guard.name` for guard-rejected rows; `undefined` otherwise. Map `NULL → undefined` on read, the same convention as `errorMessage`. |
| `commandResults`       | `CommandResult[]`                            | JSON array. Empty `[]` for guard-rejected rows.                                                                                                                    |
| `triggerMetadata`      | `Record<string, unknown> \| undefined`       | JSON object                                                                                                                                                        |

`append()` must return a string UUID for the created record.

`findByInstanceUuid()` should default `limit` to 50 and `offset` to 0 when not provided. Order by `created_at DESC`.

---

## Database Schema Reference

Use this as a guide for your migration:

```sql
CREATE TABLE workflow_instances (
  uuid                uuid PRIMARY KEY,
  workflow_name       text NOT NULL,
  current_state       text NOT NULL,
  version             integer NOT NULL DEFAULT 0,
  expires_at          timestamptz,
  last_transition_at  timestamptz NOT NULL DEFAULT now(),
  context_json        jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workflow_history (
  uuid                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_instance_uuid  uuid NOT NULL REFERENCES workflow_instances(uuid),
  from_state              text,
  event_name              text NOT NULL,
  to_state                text NOT NULL,
  -- v1.1.0: CHECK extended to allow 'guard-rejected'.
  outcome                 text NOT NULL CHECK (outcome IN ('success', 'failure', 'guard-rejected')),
  error_message           text,
  -- v1.1.0: declared eventDef.guard.name for guard-rejected rows; NULL otherwise.
  rejected_by             text,
  command_results_json    jsonb NOT NULL DEFAULT '[]'::jsonb,
  trigger_metadata_json   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now()
);

-- Recommended indexes
CREATE INDEX workflow_instances_workflow_name_idx ON workflow_instances (workflow_name);
CREATE INDEX workflow_instances_expires_at_idx ON workflow_instances (expires_at)
  WHERE expires_at IS NOT NULL;
CREATE INDEX workflow_history_instance_created_idx ON workflow_history (workflow_instance_uuid, created_at DESC);
```

Adapt column types for your database (e.g., MySQL uses `JSON` instead of `JSONB`, `DATETIME` instead of `TIMESTAMPTZ`).

### v1.1.0 — Adding event guards to an existing schema

If you're upgrading an existing v1.0.x adapter to v1.1.0, you need two changes to `workflow_history`:

```sql
-- 1. Drop the old CHECK constraint and add the extended one
ALTER TABLE workflow_history DROP CONSTRAINT workflow_history_outcome_check;
ALTER TABLE workflow_history
  ADD CONSTRAINT workflow_history_outcome_check
  CHECK (outcome IN ('success', 'failure', 'guard-rejected'));

-- 2. Add the rejected_by column (NULL for all pre-v1.1.0 rows)
ALTER TABLE workflow_history ADD COLUMN rejected_by text;
```

`@duraflows/pg` ships this as `003_event_guards.sql`. If you wrap a different ORM, mirror the two operations in the migration tool of your choice. There's no backfill — pre-v1.1.0 rows keep `rejected_by IS NULL`, which maps cleanly to `rejectedBy: undefined` on read.

`workflow_instances` has no schema changes for v1.1.0.

---

## Wiring the Adapter

### Standalone

```ts
const runtime = new WorkflowRuntime({
  definitionRegistry,
  commandRegistry,
  instanceStore: new MyInstanceStore(orm),
  historyStore: new MyHistoryStore(orm),
  transactionRunner: new MyTransactionRunner(orm),
  clock: { now: () => new Date() },
});
```

### NestJS

```ts
WorkflowModule.forRoot({
  workflows: [orderWorkflow],
  persistence: {
    instanceStore: new MyInstanceStore(orm),
    historyStore: new MyHistoryStore(orm),
    transactionRunner: new MyTransactionRunner(orm),
  },
});
```

Or use `forRootAsync()` to resolve the ORM client from DI:

```ts
WorkflowModule.forRootAsync({
  imports: [DatabaseModule],
  useFactory: (prisma: PrismaClient) => ({
    workflows: [orderWorkflow],
    persistence: {
      instanceStore: new PrismaInstanceStore(prisma),
      historyStore: new PrismaHistoryStore(prisma),
      transactionRunner: new PrismaTransactionRunner(prisma),
    },
  }),
  inject: [PrismaClient],
});
```

---

## Checklist for Adapter Authors

- [ ] `lockByUuid()` acquires a row-level lock (`FOR UPDATE` or equivalent)
- [ ] `lockByUuid()` throws if called outside a transaction
- [ ] `update()` checks version (optimistic locking) and throws `WorkflowError` on mismatch
- [ ] **(v1.0.0)** `update()` does NOT modify `metadata_json` — metadata is write-once after `create()`
- [ ] `findExpired()` uses `SKIP LOCKED` or equivalent to avoid blocking concurrent workers
- [ ] `findExpired()` throws if called outside a transaction
- [ ] `runInTransaction()` supports nesting (reuses existing transaction)
- [ ] `runInTransaction()` rolls back on error
- [ ] `append()` returns a generated UUID string
- [ ] `findByInstanceUuid()` supports `limit`/`offset` pagination, returns newest-first
- [ ] All Date fields are stored and retrieved as `Date` objects
- [ ] JSON fields (`context`, `metadata`, `commandResults`, `triggerMetadata`) survive round-trips
- [ ] `null` handling for `expiresAt`, `fromState`, `errorMessage`
- [ ] **(v1.0.0)** `runInstanceStoreConformance` from `@duraflows/core/testing` passes against your adapter
- [ ] **(v1.1.0)** `workflow_history.outcome` CHECK constraint accepts `'guard-rejected'` (in addition to `'success'`/`'failure'`)
- [ ] **(v1.1.0)** `rejected_by` column exists on `workflow_history`; persisted on `append()` for guard-rejected rows; mapped `NULL → undefined` on read (same convention as `errorMessage`)
- [ ] **(v1.1.0)** Guard-rejected rows are persisted with `commandResults: []` and `toState === fromState` — verify your write path doesn't strip or rewrite either

---

## Testing Your Adapter

### v1.0.0 — Use the Conformance Suite

The shipped `runInstanceStoreConformance(factory)` from `@duraflows/core/testing` is the canonical contract test. Run it against your adapter and you can rely on the runtime working with it. `@duraflows/pg` and `@duraflows/kysely` both run this in CI.

```ts
import { describe } from "vitest";
import { runInstanceStoreConformance } from "@duraflows/core/testing";
import { MyInstanceStore } from "../src/my-instance-store.js";
import { MyTransactionRunner } from "../src/my-transaction-runner.js";

describe("MyInstanceStore (conformance)", () => {
  runInstanceStoreConformance({
    setup: async () => {
      // Construct your store + transaction runner against a real database
      // (or an in-memory mock that supports transactions, e.g., pglite for postgres-shaped APIs).
      const store = new MyInstanceStore(db);
      const transactionRunner = new MyTransactionRunner(db);
      return {
        store,
        transactionRunner,
        teardown: async () => {
          await db.destroy();
        },
      };
    },
  });
});
```

The suite verifies the persistence contract end-to-end: row-level locking, transaction-required behavior, optimistic concurrency on `version`, the `metadata` write-once contract, expiration ordering + limit + `SKIP LOCKED`, and nested-transaction reuse.

### Reference Implementations

Both reference adapters are worth reading when you build a new one:

- **`@duraflows/pg`** — raw `pg` Pool with `AsyncLocalStorage`-backed transaction propagation. Best mirror for adapters that wrap a low-level driver.
- **`@duraflows/kysely`** (v0.4.0+) — Kysely-based; idiomatic query builder usage. Best mirror for ORM/query-builder adapters.

### Custom Tests (in addition to the conformance suite)

If your adapter exposes adapter-specific behavior (custom indexes, materialized views, multi-schema support), keep targeted unit tests alongside the conformance suite:

```ts
describe("MyInstanceStore (custom)", () => {
  it("uses the configured schema", async () => {
    /* ... */
  });
  it("handles connection-pool exhaustion gracefully", async () => {
    /* ... */
  });
});
```

Don't re-test the contract — let `runInstanceStoreConformance` own that.
