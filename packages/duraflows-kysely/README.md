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

"Never after a rollback" has one caveat: if a statement failed and you swallowed its error, PostgreSQL silently turns kysely's `COMMIT` into a rollback, and kysely can't see that. Observers then fire for writes that were never persisted. Don't swallow SQL errors inside a transaction: let them propagate, or run the statement in a nested `KyselyTransactionContext.transaction()` and catch its rejection, which rolls back only that savepoint.

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

## Database Setup

This package uses the same database schema as `@duraflows/pg`. Use the migration generator from `@duraflows/pg` or copy the reference migration:

```ts
import { generateMigrationSql } from "@duraflows/pg";

const { up, down } = generateMigrationSql();
```

See the [`@duraflows/pg` README](https://github.com/camcima/duraflows/tree/main/packages/duraflows-pg#database-setup) for full details.

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

### `KyselyTransactionContext`

The context is scoped per Kysely instance:

- `getTransaction(db)` -- Returns the active `Transaction<WorkflowDatabase>` for the given `db` instance, or `undefined`
- `run(db, trx, callback)` -- Executes `callback` with `trx` as the active transaction context for the given `db` instance
- `transaction(db, callback)` -- Runs `callback(trx)` in a new transaction on `db` with `trx` active for workflow calls; observers fire after it commits. Inside an already-active transaction for `db`, it joins that transaction as a savepoint instead

## Documentation

See the full documentation in the [duraflows repository](https://github.com/camcima/duraflows).

## License

MIT
