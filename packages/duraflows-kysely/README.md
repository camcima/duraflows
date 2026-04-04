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
npm install @duraflows/core @duraflows/kysely kysely pg
```

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

// Seed the transaction context so Duraflows participates in your transaction
await db.transaction().execute(async (trx) => {
  await KyselyTransactionContext.run(trx, async () => {
    // Your own writes -- uses trx
    await trx.insertInto("orders").values({ id: "ORD-1", status: "paid" }).execute();

    // Duraflows writes -- also uses trx (same transaction)
    await runtime.triggerEvent({
      workflowInstanceUuid: instanceUuid,
      eventName: "PaymentReceived",
    });
  });
});
// Both commit or both rollback -- no split-brain
```

### How It Works

`KyselyTransactionContext` uses Node.js `AsyncLocalStorage` to propagate the active Kysely transaction through the async call chain. When Duraflows' internal `WorkflowTransactionRunner.runInTransaction()` is called, it checks for an existing transaction in the context:

- **Found:** Reuses it (no nested transaction)
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

### `kyselyWorkflowProviders(db): WorkflowPersistenceProvider`

Factory function that creates all required persistence providers from a `Kysely<WorkflowDatabase>` instance. Returns:

- `instanceStore` -- `KyselyWorkflowInstanceStore`
- `historyStore` -- `KyselyWorkflowHistoryStore`
- `transactionRunner` -- `KyselyTransactionRunner`

### `kyselyWorkflowProvidersFromTransaction(trx): WorkflowPersistenceProvider`

Convenience factory for short-lived runtimes pre-bound to an existing transaction. The returned transaction runner seeds the context with the bound `trx` if no context already exists.

### `KyselyTransactionContext`

- `getTransaction()` -- Returns the active `Transaction<WorkflowDatabase>` or `undefined`
- `run(trx, callback)` -- Executes `callback` with `trx` as the active transaction context

## Documentation

See the full documentation in the [duraflows repository](https://github.com/camcima/duraflows).

## License

MIT
