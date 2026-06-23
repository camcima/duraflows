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

Copy **all** files in that directory (`001_workflow_core.sql`, `002_replace_trigger_with_metadata.sql`, `003_event_guards.sql`) into your migration directory and apply them in order. Applying only `001` produces a schema the current runtime cannot write to — `002`/`003` add the `metadata_json` handling and the `rejected_by` column / `guard-rejected` outcome that the history store requires. The migrations use `gen_random_uuid()` (PostgreSQL 13+) for history record UUIDs.

### Option 2: Generate with `generateMigrationSql()`

Choose between `gen_random_uuid()` (PG 13+) and `uuidv7()` (PG 18+, time-ordered):

```ts
import { generateMigrationSql } from "@duraflows/pg";

// PostgreSQL 18+ (time-ordered UUIDs)
const { up, down } = generateMigrationSql({ uuidStrategy: "uuidv7" });

// PostgreSQL 13-17 (random UUIDs, the default)
const { up, down } = generateMigrationSql();
```

Both options create two tables: `workflow_instances` and `workflow_history`.

## API

### `pgWorkflowProviders(pool: Pool): WorkflowPersistenceProvider`

Factory function that creates all required persistence providers from a `pg` Pool. Returns an object with:

- `instanceStore` -- `PgWorkflowInstanceStore`
- `historyStore` -- `PgWorkflowHistoryStore`
- `transactionRunner` -- `PgTransactionRunner`

### `generateMigrationSql(options?): { up: string; down: string }`

Generates SQL for creating/dropping the schema.

Options:

- `uuidStrategy` -- `"gen_random_uuid"` (default, PG 13+) or `"uuidv7"` (PG 18+)

## Documentation

See the full documentation in the [duraflows repository](https://github.com/camcima/duraflows).

## License

MIT
