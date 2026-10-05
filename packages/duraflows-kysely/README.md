# @duraflows/kysely

[Kysely](https://kysely.dev/) persistence adapter for [duraflows](https://github.com/camcima/duraflows).

Part of the [duraflows](https://github.com/camcima/duraflows) monorepo.

## Features

- Full implementation of `@duraflows/core` persistence interfaces using Kysely query builder
- Row-level locking with `SKIP LOCKED` for concurrent access safety
- JSONB storage for workflow context, metadata, and command results
- Transaction sharing via `AsyncLocalStorage` -- run Duraflows and your own queries in a single Kysely transaction
- Type-safe `WorkflowDatabase` interface for composing with your own Kysely database types

## Installation

```bash
pnpm add @duraflows/core @duraflows/kysely kysely pg
```

> **Note:** `@duraflows/core` and `kysely` are peer dependencies — you install them alongside this package so your app and the adapter share a single copy. There is intentionally no `pg` peer: Kysely's `PostgresDialect` requires a driver, but the choice is yours — install `pg` (or your preferred Postgres driver) and configure it on your `Kysely` instance.

## Quick Start

```ts
import { WorkflowRuntime, InMemoryDefinitionRegistry, InMemoryCommandRegistry } from "@duraflows/core";
import { kyselyWorkflowProviders } from "@duraflows/kysely";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

const db = new Kysely({
  dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_URL }) }),
});

const persistence = kyselyWorkflowProviders(db);

const runtime = new WorkflowRuntime({
  definitionRegistry,
  commandRegistry,
  ...persistence,
  clock: { now: () => new Date() },
});
await runtime.initialize(); // surfaces definition/version errors at boot
```

## Sharing a Transaction

The primary use case for this package is running Duraflows workflow transitions and your own database writes in a single atomic transaction.

```ts
import { KyselyTransactionContext } from "@duraflows/kysely";

await KyselyTransactionContext.transaction(db, async (trx) => {
  // Your own writes -- uses trx
  await trx.insertInto("orders").values({ id: "ORD-1", status: "paid" }).execute();

  // Duraflows writes -- also uses trx (same transaction)
  await runtime.triggerEvent({
    workflowInstanceUuid: instanceUuid,
    eventName: "PaymentReceived",
  });
});
// Both commit or both roll back. Observers fire after COMMIT, never after a rollback.
```

Each duraflows call inside runs in its own savepoint. If one fails, its writes are rolled back, and your transaction can carry on if you catch the error. Calling `transaction()` inside one that is already active joins it as a savepoint instead of opening a second transaction, so composed service methods stay atomic.

If a statement failed and you swallowed its error, PostgreSQL would silently turn `COMMIT` into a rollback, and kysely discards `COMMIT`'s command tag. So before committing, `transaction()` (and the transaction runner) probes the transaction with `SELECT 1`; in an aborted transaction the probe fails, the transaction rolls back, and the call rejects with a `WorkflowError` ("COMMIT was rolled back by PostgreSQL because an earlier statement in the transaction failed", the probe's error as `cause`) and fires no observers. To recover from a failing statement instead, run it in a nested `KyselyTransactionContext.transaction()` and catch its rejection, which rolls back only that savepoint.

The runner's `lockTimeoutMs` / `statementTimeoutMs` don't apply inside `transaction()` or a seeded `run()`: you own those transaction settings, and nested duraflows calls run under them.

If you already open the transaction yourself, you can still seed the context:

```ts
await db.transaction().execute((trx) =>
  KyselyTransactionContext.run(db, trx, async () => {
    await runtime.triggerEvent({ workflowInstanceUuid: instanceUuid, eventName: "PaymentReceived" });
  }),
);
```

Observers then fire when the seeded callback resolves, which is **before** kysely commits, and duraflows calls they make join your still-open transaction. Prefer `transaction()` when observers must never see a rolled-back write. Don't run duraflows calls concurrently (`Promise.all`) on one transaction.

### How It Works

`KyselyTransactionContext` uses Node.js `AsyncLocalStorage` to propagate the active Kysely transaction through the async call chain. When Duraflows' internal `WorkflowTransactionRunner.runInTransaction()` is called, it checks for an existing transaction in the context:

- **Found:** Runs the call in a savepoint on it (`SAVEPOINT` … `RELEASE`, or `ROLLBACK TO` on failure)
- **Not found:** Starts a new Kysely transaction and seeds the context

This re-entrancy contract means your application code controls the transaction boundary.

## Composing Database Types

Merge `WorkflowDatabase` with your own Kysely database type:

```ts
import type { WorkflowDatabase } from "@duraflows/kysely";

interface MyDatabase extends WorkflowDatabase {
  orders: OrdersTable;
  products: ProductsTable;
}

const db = new Kysely<MyDatabase>({ ... });
```

A database type declared as `interface AppDb extends WorkflowDatabase` picks up the `workflow_instances` columns automatically, including `timeout_attempts`, `timeout_retry_at`, `timeout_last_error` and `timeout_parked_at`. If you instead hand-write your own `workflow_instances` table type rather than extending `WorkflowDatabase`, it must declare all four: `timeout_attempts: Generated<number>`, `timeout_retry_at: Date | null`, `timeout_last_error: string | null`, `timeout_parked_at: Date | null`.

## Database Setup

This package uses the same database schema as `@duraflows/pg`, including migration `006_definition_version_index.sql` (recommended, not required -- it keeps the 7.0.0 startup executability check and `listDefinitionVersions()` cheap on large tables). Use the migration generator from `@duraflows/pg` or copy the reference migration:

```ts
import { generateMigrationSql } from "@duraflows/pg";

const { up, down } = generateMigrationSql();
```

See the [`@duraflows/pg` README](https://github.com/camcima/duraflows/tree/main/packages/duraflows-pg#database-setup) for full details.

`KyselyWorkflowInstanceStore` and `KyselyWorkflowDefinitionStore` implement the two store methods (`countInstances()`, `listVersions()`) that back 7.0.0's definition-version pinning and startup executability check. See [Definition versions](https://github.com/camcima/duraflows/blob/main/docs/workflow-definitions.md#definition-versions), and [Upgrading to 7.0.0](https://github.com/camcima/duraflows/blob/main/docs/workflow-definitions.md#upgrading-to-700) before deploying.

## API

### `kyselyWorkflowProviders(db, options?): WorkflowPersistenceProvider`

Factory function that creates all required persistence providers from a `Kysely<WorkflowDatabase>` instance. Returns:

- `instanceStore` -- `KyselyWorkflowInstanceStore`
- `historyStore` -- `KyselyWorkflowHistoryStore`
- `transactionRunner` -- `KyselyTransactionRunner`
- `definitionStore` -- `KyselyWorkflowDefinitionStore`

Options (all optional; omitting them keeps the previous behaviour):

- `lockTimeoutMs` -- sets `lock_timeout` for the duration of each transaction. Bounds how long a statement **waits for a row lock**, so a stuck lock holder cannot hang `triggerEvent()` while it keeps a pooled connection checked out. **This is the recommended setting.**
- `statementTimeoutMs` -- sets `statement_timeout` for the duration of each transaction. Bounds how long **any single statement** may run — including SQL your own commands issue inside the transaction, which is why it is left unset by default: a legitimately slow command statement would be aborted and take the whole transition with it.

```ts
const persistence = kyselyWorkflowProviders(db, { lockTimeoutMs: 3000 });
```

Both are applied transaction-locally via `set_config(name, value, true)` — the function form of `SET LOCAL` — so they are reverted on `COMMIT`/`ROLLBACK` and never leak to other users of the shared pool. Values must be non-negative integers in milliseconds (`0` means "no timeout"); anything else throws a `WorkflowError` at construction time.

`kyselyWorkflowProvidersFromTransaction()` takes no timeout options: the transaction is owned by the caller, so its settings are the caller's to configure.

### `kyselyWorkflowProvidersFromTransaction(trx): WorkflowPersistenceProvider`

Convenience factory for short-lived runtimes pre-bound to an existing transaction. Each workflow call runs in a savepoint on `trx`, so a failed call leaves no partial writes behind even if you catch its error. Observers fire when the call resolves, before your transaction commits, and duraflows calls they make join `trx`. For strictly post-commit observers, use `KyselyTransactionContext.transaction(db, …)` with the long-lived providers instead.

Don't mix these providers with the long-lived `kyselyWorkflowProviders(db)` (or `KyselyTransactionContext.transaction(db, …)`) inside one transaction. The two track their active transaction separately, one per `trx` and the other per `db`, so a call through one doesn't see a transaction opened through the other. It starts a second transaction on another connection instead, which can wait on row locks the first one holds. Use one style per transaction.

### `KyselyTransactionContext`

The context is scoped per Kysely instance:

- `getTransaction(db)` -- Returns the active `Transaction<WorkflowDatabase>` for the given `db` instance, or `undefined`
- `run(db, trx, callback)` -- Executes `callback` with `trx` as the active transaction context for the given `db` instance
- `transaction(db, callback)` -- Runs `callback(trx)` in a new transaction on `db` with `trx` active for workflow calls; observers fire after it commits. Inside an already-active transaction for `db`, it joins that transaction as a savepoint instead

## Documentation

See the full documentation in the [duraflows repository](https://github.com/camcima/duraflows).

## License

MIT

## Optional event idempotency

Apply migration `007_event_idempotency.sql` from `@duraflows/pg`, or use its `generateIdempotencyMigrationSql()`, then enable `kyselyWorkflowProviders(db, { idempotency: true })`. Transaction-bound providers support `kyselyWorkflowProvidersFromTransaction(trx, { idempotency: true })`. Both default to disabled. `KyselyWorkflowIdempotencyStore`, `WorkflowEventIdempotencyTable`, and the optional `WorkflowDatabaseWithIdempotency` extension are exported; existing `WorkflowDatabase` consumer types remain valid. Receipts use the same transaction and roll back with it. See [the guide](../../docs/event-idempotency.md) for deployment and guarantees.

## Optional durable command progress

Apply optional migration 008 from `@duraflows/pg`, then set `{ durableExecution: true }` on `kyselyWorkflowProviders`. `KyselyWorkflowExecutionStore`, `WorkflowExecutionsTable` and optional `WorkflowDatabaseWithExecutions` are exported; the existing `WorkflowDatabase` type is unchanged. Transaction-bound providers can enqueue, but workers must use ordinary providers outside any transaction. See [Durable command progress](https://github.com/camcima/duraflows/blob/main/docs/durable-execution.md) for setup, worker polling, downstream idempotency, rollout and recovery limits.
