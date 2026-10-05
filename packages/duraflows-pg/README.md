# @duraflows/pg

PostgreSQL persistence adapter for [duraflows](https://github.com/camcima/duraflows), using the [`pg`](https://www.npmjs.com/package/pg) library.

Part of the [duraflows](https://github.com/camcima/duraflows) monorepo.

## Features

- Full implementation of `@duraflows/core` persistence interfaces
- Row-level locking with `SKIP LOCKED` for concurrent access safety
- JSONB storage for workflow context, metadata, and command results
- Schema migration generator with UUID strategy selection
- Pre-built dbmate migration included
- Supports PostgreSQL 13+ (PostgreSQL 18+ for `uuidv7()`)

## Installation

```bash
pnpm add @duraflows/core @duraflows/pg pg
```

> **Note:** `@duraflows/core` and `pg` are peer dependencies — you install them alongside this package so your app and the adapter share a single `Pool` driver and core instance.

## Quick Start

```ts
import { WorkflowRuntime, InMemoryDefinitionRegistry, InMemoryCommandRegistry } from "@duraflows/core";
import { pgWorkflowProviders } from "@duraflows/pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const persistence = pgWorkflowProviders(pool);

const runtime = new WorkflowRuntime({
  definitionRegistry,
  commandRegistry,
  ...persistence,
  clock: { now: () => new Date() },
});
await runtime.initialize(); // surfaces definition/version errors at boot
```

### With NestJS

```ts
import { WorkflowModule } from "@duraflows/nestjs";
import { pgWorkflowProviders } from "@duraflows/pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

@Module({
  imports: [
    WorkflowModule.forRoot({
      workflows: [orderWorkflow],
      commands: [{ name: "sendToWarehouse", useClass: SendToWarehouseCommand }],
      persistence: pgWorkflowProviders(pool),
    }),
  ],
})
export class AppModule {}
```

## Database Setup

### Option 1: Copy the reference migrations

Ready-made dbmate migrations are shipped at:

```
node_modules/@duraflows/pg/sql/dbmate/
```

Copy **all** files in that directory (`001_workflow_core.sql`, `002_replace_trigger_with_metadata.sql`, `003_event_guards.sql`, `004_definition_versions.sql`, `005_timeout_retries.sql`, `006_definition_version_index.sql`) into your migration directory and apply them in order. `001` through `005` are **required** before deploying 6.x or 7.x, and `006` is recommended for 7.0.0 — the runtime reads and writes the `definition_version` columns, the `workflow_definitions` table and the `timeout_*` columns on every operation. Applying only `001` produces a schema the current runtime cannot write to — `002`/`003` add the `metadata_json` handling and the `rejected_by` column / `guard-rejected` outcome that the history store requires, `004` adds the `workflow_definitions` table and `definition_version` columns that the definition store and every instance/history write require, and `005_timeout_retries.sql` adds the `timeout_attempts`, `timeout_retry_at`, `timeout_last_error` and `timeout_parked_at` columns that every instance read maps and that `create` and `update` write on every operation — it **must be applied before deploying 6.0.0**. `006_definition_version_index.sql` is recommended, not required: it adds an index on `(workflow_name, definition_version)` that keeps the 7.0.0 startup executability check and `listDefinitionVersions()` cheap on large tables (see [docs/persistence.md](https://github.com/camcima/duraflows/blob/main/docs/persistence.md#definition-version-index) for `CREATE INDEX CONCURRENTLY` advice). The migrations use `gen_random_uuid()` (PostgreSQL 13+) for history record UUIDs.

**Upgrading to 7.0.0:** `PgWorkflowInstanceStore` and `PgWorkflowDefinitionStore` already implement the two new required store methods (`countInstances()`, `listVersions()`), and instances now execute the definition version they were stamped with by default. Set `versionPolicy: "latest"` on a definition to keep 6.x behavior for that workflow. Read [Upgrading to 7.0.0](https://github.com/camcima/duraflows/blob/main/docs/workflow-definitions.md#upgrading-to-700) before deploying: it covers idle instances reverting to older versions' rules, the startup check, mixed 6.x/7.0 workers and a pre-upgrade query.

### Option 2: Generate with `generateMigrationSql()`

Choose between `gen_random_uuid()` (PG 13+) and `uuidv7()` (PG 18+, time-ordered):

```ts
import { generateMigrationSql } from "@duraflows/pg";

// PostgreSQL 18+ (time-ordered UUIDs)
const { up, down } = generateMigrationSql({ uuidStrategy: "uuidv7" });

// PostgreSQL 13-17 (random UUIDs, the default)
const { up, down } = generateMigrationSql();
```

**This choice affects history ordering, not just PostgreSQL-version support.** `workflow_history` reads are ordered `created_at DESC, uuid DESC`, and every row written inside one transaction (e.g. an event plus its `onEnter` chain) shares one `created_at` -- so `uuid` is the tiebreaker. `uuidv7()` makes that tiebreak monotonic, so a multi-hop transition reads back in the order it happened; `gen_random_uuid()` (Option 1's dbmate migrations, and `generateMigrationSql()`'s default) makes it arbitrary, though stable once written. `uuidv7()` needs PostgreSQL 18+ -- on PG 13-17 that ordering simply isn't recoverable from the returned records. See [docs/persistence.md](https://github.com/camcima/duraflows/blob/main/docs/persistence.md#ordering-within-a-multi-hop-transition) for the full explanation, including a verified empirical example.

Both options create three tables: `workflow_instances`, `workflow_history`, and `workflow_definitions`.

## Sharing a Transaction

Run workflow transitions and your own writes atomically with `PgTransactionContext.transaction`. It begins a transaction on a client from your pool, makes that client the active transaction for every duraflows call inside, and commits:

```ts
import { PgTransactionContext } from "@duraflows/pg";

await PgTransactionContext.transaction(pool, async (client) => {
  await client.query("UPDATE orders SET status = 'paid' WHERE id = $1", [orderId]);
  await runtime.triggerEvent({ workflowInstanceUuid, eventName: "PaymentReceived" });
});
// Both commit or both roll back. Observers fire after COMMIT, never after a rollback.
```

Each duraflows call inside runs in its own savepoint. If one fails, its writes are rolled back, and your transaction can carry on if you catch the error. Calling `transaction()` inside one that is already active joins it as a savepoint instead of opening a second transaction, so composed service methods stay atomic. If a statement failed and you swallowed its error, PostgreSQL rolls back on `COMMIT`: `transaction()` then rejects with a `WorkflowError` and fires no observers.

The runner's `lockTimeoutMs` / `statementTimeoutMs` don't apply inside `transaction()` or a seeded `run()`: you own those transaction settings, and nested duraflows calls run under them (use `SET LOCAL` inside the callback if you need them).

If you already manage `BEGIN`/`COMMIT` yourself, you can seed the context with `PgTransactionContext.run(pool, client, callback)` instead. Observers then fire when `callback`'s promise resolves, which is **before** your `COMMIT`, and duraflows calls they make join your still-open transaction. Prefer `transaction()` when observers must never see a rolled-back write. Don't run duraflows calls concurrently (`Promise.all`) on one transaction.

## API

### `pgWorkflowProviders(pool: Pool, options?): WorkflowPersistenceProvider`

Factory function that creates all required persistence providers from a `pg` Pool. Returns an object with:

- `instanceStore` -- `PgWorkflowInstanceStore`
- `historyStore` -- `PgWorkflowHistoryStore`
- `transactionRunner` -- `PgTransactionRunner`
- `definitionStore` -- `PgWorkflowDefinitionStore`

Options (all optional; omitting them keeps the previous behaviour):

- `lockTimeoutMs` -- sets `lock_timeout` for the duration of each transaction. Bounds how long a statement **waits for a row lock**, so a stuck lock holder cannot hang `triggerEvent()` while it keeps a pooled connection checked out. **This is the recommended setting.**
- `statementTimeoutMs` -- sets `statement_timeout` for the duration of each transaction. Bounds how long **any single statement** may run — including SQL your own commands issue inside the transaction, which is why it is left unset by default: a legitimately slow command statement would be aborted and take the whole transition with it.

```ts
const persistence = pgWorkflowProviders(pool, { lockTimeoutMs: 3000 });
```

Both are applied with `SET LOCAL` inside the transaction, so they are reverted on `COMMIT`/`ROLLBACK` and never leak to other users of the shared pool. Values must be non-negative integers in milliseconds (`0` means "no timeout"); anything else throws a `WorkflowError` at construction time.

### `generateMigrationSql(options?): { up: string; down: string }`

Generates SQL for creating/dropping the schema.

Options:

- `uuidStrategy` -- `"gen_random_uuid"` (default, PG 13+) or `"uuidv7"` (PG 18+)

## Documentation

See the full documentation in the [duraflows repository](https://github.com/camcima/duraflows).

## License

MIT

## Optional event idempotency

Apply `sql/dbmate/007_event_idempotency.sql` (or use `generateIdempotencyMigrationSql()`), then use `pgWorkflowProviders(pool, { idempotency: true })`. Fresh schemas can use `generateMigrationSql({ includeIdempotency: true })`. Default factories and schemas leave the feature disabled; deployments without keyed calls need no new table. `PgWorkflowIdempotencyStore` is also exported for custom wiring. Receipts join the same active transaction as workflow writes. Deploy supporting application code everywhere before enabling keyed traffic. See [the guide](../../docs/event-idempotency.md) for storage retention, rollback, and replay behavior.

## Optional durable command progress

Apply optional migration `008_durable_execution.sql` (or `generateDurableExecutionMigrationSql()`), then set `{ durableExecution: true }` on `pgWorkflowProviders`. Fresh schemas can use `generateMigrationSql({ includeDurableExecution: true })`. `PgWorkflowExecutionStore` is exported for custom wiring. See [Durable command progress](https://github.com/camcima/duraflows/blob/main/docs/durable-execution.md) for setup, worker polling, downstream idempotency, rollout and recovery limits.
