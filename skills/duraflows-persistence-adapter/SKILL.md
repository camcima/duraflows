---
name: duraflows-persistence-adapter
description: "Guides implementation of custom duraflows persistence adapters for Prisma, Drizzle, TypeORM, or other ORMs. Use when implementing WorkflowInstanceStore, WorkflowHistoryStore, or WorkflowTransactionRunner interfaces, or when the user wants to replace @duraflows/pg with a different database library."
---

# duraflows Persistence Adapter Guide

How to implement custom persistence adapters for duraflows. The core runtime is fully decoupled from any database library -- you implement three required interfaces (plus an optional fourth for definition versioning) and plug them in.

> **v1.0.0 — verify with the conformance suite.** `@duraflows/core/testing` ships `runInstanceStoreConformance(label, harness)`, the canonical test suite for `WorkflowInstanceStore` implementations. It exercises create/read round-trips, optimistic concurrency, expiration filtering and ordering, the metadata-write-once contract, timeout-retry and definition-version round-trips, `countInstances` and the optional `findInstanceUuids`; `runTransactionRunnerConformance` covers the runner's `afterCommit` delivery and savepoint isolation. Neither exercises row locking or `SKIP LOCKED` -- test those yourself. Reference adapters: `@duraflows/pg` and `@duraflows/kysely` (v0.4.0+) — both pass it in CI. See [Testing Your Adapter](#testing-your-adapter).
>
> **Definition versioning — `WorkflowDefinitionStore` is part of the contract.** Every `WorkflowDefinition` carries an explicit `version` (defaulting to `1`), and `WorkflowRuntime.initialize()` snapshots each registered definition into a `WorkflowDefinitionStore` so it can fail fast when a version's content drifts from what was previously registered. Implement `WorkflowDefinitionStore` and add `definition_version` columns to `workflow_instances` and `workflow_history` so instances and history rows record the definition version that governed them. It's optional on `WorkflowPersistenceProvider` — an adapter that omits it still compiles and runs, it just leaves definition versioning inert. `@duraflows/core/testing` ships `runDefinitionStoreConformance(label, harness)` to verify your implementation; both reference adapters pass it in CI. **(v7.0.0) Resolution is no longer unconditional: instances are pinned to the version they were stamped with by default (see below).** See [WorkflowDefinitionStore](#4-workflowdefinitionstore-optional) and [Testing Your Adapter](#testing-your-adapter).
>
> **v6.0.0 — timeout retry state is part of the instance contract (breaking).** `WorkflowInstance.timeoutRetry: WorkflowTimeoutRetry | null` is required and must round-trip through four columns (`timeout_attempts`, `timeout_retry_at`, `timeout_last_error`, `timeout_parked_at`); `findExpired` must skip parked and not-yet-due rows and order by `coalesce(timeout_retry_at, expires_at)`; and `WorkflowInstanceStore.findParkedTimeouts({ limit, workflowName? })` is a new required method. `@duraflows/pg` ships the schema change as `005_timeout_retries.sql`. See [findExpired](#findexpired----concurrent-batch-processing), [findParkedTimeouts](#findparkedtimeouts----operator-listing), [WorkflowInstance Fields](#workflowinstance-fields) and [Adding timeout retries to an existing schema](#v600--adding-timeout-retries-to-an-existing-schema).
>
> **v7.0.0 — definition-version pinning; two new required store methods (breaking).** Instances now execute the definition version they were stamped with by default, loaded from the store when it differs from the latest registered one (`versionPolicy: "latest"` opts a workflow back into always-latest execution). This needs `WorkflowInstanceStore.countInstances({ workflowName, definitionVersion, excludeStates })` -- a **new required method on every adapter**, not just ones with a `WorkflowDefinitionStore` -- plus `WorkflowDefinitionStore.listVersions(workflowName)` for adapters that implement the optional definition store. Both back `WorkflowRuntime.initialize()`'s startup executability check and `runtime.listDefinitionVersions()`. `@duraflows/pg` ships a recommended (not required) index as `006_definition_version_index.sql`. See [countInstances](#countinstances----active-instance-counting), [listVersions](#listversions----all-stored-snapshots), and [Adding definition-version pinning to an existing adapter](#v700--adding-definition-version-pinning-to-an-existing-adapter).
>
> **v7.1.0 — `findInstanceUuids`, one new _optional_ store method (non-breaking).** `runtime.migrateInstances()` relabels instances from one stored definition version to another. Without an explicit `instanceUuids` list, it needs `WorkflowInstanceStore.findInstanceUuids({ workflowName, definitionVersion, limit, afterUuid? })` to find candidates -- unlike `countInstances()`, this one is optional: an adapter that omits it still compiles and runs, migration just requires callers to pass `instanceUuids` themselves. See [findInstanceUuids](#findinstanceuuids----optional-migration-support-v710).
>
> **v7.2.0 — `findInstanceUuids` gains `states`/`excludeStates`, two more optional hint parameters (non-breaking).** `migrateInstances()` can now filter candidates by current state; it forwards `states`/`excludeStates` to `findInstanceUuids` as hints so a store can filter server-side, but honoring them is optional the same way the method itself is -- `migrateInstances()` re-checks the same condition on every candidate regardless, so a store that ignores the new parameters is still correct, just slower. An adapter that already implements `findInstanceUuids` without them still compiles and runs unchanged against 7.2.0. Also new: a `transformContext` result whose prototype isn't a plain object prototype (a `Date`, `Map`, class instance) now fails that one instance instead of being silently serialized (non-objects and arrays already did in 7.1; cross-realm plain objects, such as Jest's, are accepted) -- no adapter change -- and a bad page from `findInstanceUuids` (not ascending, or an entry that is not a non-empty string) now throws `MigrationInterruptedError` instead of being trusted. That page check compares UUID strings with JavaScript's `>`, so **"ascending" now means ascending by string comparison of the returned UUID strings**: PostgreSQL's `uuid` order already agrees, but an adapter whose native UUID order differs (SQL Server `uniqueidentifier`, MySQL `UUID_TO_BIN(u, 1)`) must order and compare by the canonical lowercase text form -- see the requirements below. See [findInstanceUuids](#findinstanceuuids----optional-migration-support-v710) and [v7.2.0 — Adding the state hints to an existing `findInstanceUuids`](#v720--adding-the-state-hints-to-an-existing-findinstanceuuids).

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
  findParkedTimeouts(options: { limit: number; workflowName?: string }): Promise<WorkflowInstance[]>; // v6.0.0
  countInstances(options: {
    workflowName: string;
    definitionVersion: number;
    excludeStates: readonly string[];
  }): Promise<number>; // v7.0.0
  findInstanceUuids?(options: {
    workflowName: string;
    definitionVersion: number;
    limit: number;
    afterUuid?: string;
    states?: readonly string[]; // v7.2.0, hint -- honoring it is optional
    excludeStates?: readonly string[]; // v7.2.0, hint -- honoring it is optional
  }): Promise<string[]>; // v7.1.0, optional
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

### 4. WorkflowDefinitionStore (optional)

```ts
interface WorkflowDefinitionStore {
  ensure(record: {
    workflowName: string;
    version: number;
    contentHash: string;
    definitionJson: WorkflowDefinition;
  }): Promise<StoredWorkflowDefinition>;
  findByNameAndVersion(workflowName: string, version: number): Promise<StoredWorkflowDefinition | null>;
  listVersions(workflowName: string): Promise<StoredWorkflowDefinition[]>; // v7.0.0
}
```

Optional on `WorkflowPersistenceProvider` -- an adapter that omits it still compiles and the runtime still runs, it just leaves definition versioning (the version-bump guard, the `workflow_definitions` snapshot table) inert. Implement it so your adapter supports the feature: `ensure()` backs `WorkflowRuntime.initialize()`'s per-definition sync and (v7.2.0) runs inside every instance-stamping transaction, so it must be cheap, use the active transaction's connection, and never overwrite an existing `(workflow_name, version)` row.

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

Called by `processExpiredWorkflows()` to find instances whose timeout is due.

**Requirements:**

- **Must require an active transaction**
- **Must skip rows locked by other processes** (e.g., `FOR UPDATE SKIP LOCKED`)
- **(v6.0.0)** Due filter: `expires_at IS NOT NULL AND expires_at < now AND timeout_parked_at IS NULL AND (timeout_retry_at IS NULL OR timeout_retry_at < now)` -- parked instances and instances whose next retry is still in the future are excluded
- **(v6.0.0)** Order by `coalesce(timeout_retry_at, expires_at)`, oldest first, so instances whose timeout keeps failing move behind healthy ones
- Respect `limit` parameter
- `now` is the parameter (the application clock), never the database's `now()`

**SQL pattern:**

```sql
SELECT * FROM workflow_instances
WHERE expires_at IS NOT NULL AND expires_at < $2
  AND timeout_parked_at IS NULL
  AND (timeout_retry_at IS NULL OR timeout_retry_at < $2)
  -- Redundant (every due row already satisfies it), but it gives the planner a
  -- range condition on the coalesce index instead of filtering every entry.
  AND coalesce(timeout_retry_at, expires_at) < $2
ORDER BY coalesce(timeout_retry_at, expires_at)
FOR UPDATE SKIP LOCKED
LIMIT $1
```

Back it with a partial expression index -- `CREATE INDEX workflow_instances_timeout_due_idx ON workflow_instances ((coalesce(timeout_retry_at, expires_at))) WHERE expires_at IS NOT NULL AND timeout_parked_at IS NULL` -- and keep the redundant `coalesce(...) < now` condition: without it, PostgreSQL walks the whole index in order and filters every entry against the heap once many rows carry retry state.

**Why SKIP LOCKED?** Multiple workers can call `processExpiredWorkflows()` concurrently. Without SKIP LOCKED, they'd block each other on the same rows. `SKIP LOCKED` does not by itself prevent double processing: the scan runs in a short transaction and its locks end with it. The runtime then re-locks each instance with `lockByUuid` and re-checks that it is still due before processing it; that re-lock is what gives each instance's timeout a single worker.

### findParkedTimeouts -- Operator Listing

**(v6.0.0)** Backs `WorkflowRuntime.findParkedTimeouts()`: lists instances parked after `timeoutRetry.maxAttempts` consecutive failed timeout attempts, so an operator can inspect them and `rearmTimeout()` them.

**Requirements:**

- Filter: `timeout_parked_at IS NOT NULL`, plus `workflow_name = workflowName` when `workflowName` is given
- Order by `timeout_parked_at, uuid` (oldest-parked first, ties by `uuid`)
- Return at most `limit` rows
- A plain read: **no transaction required** (use the transaction's connection when one is active, the pool otherwise)

**SQL pattern:**

```sql
SELECT * FROM workflow_instances
WHERE timeout_parked_at IS NOT NULL
  AND ($2::text IS NULL OR workflow_name = $2)
ORDER BY timeout_parked_at, uuid
LIMIT $1
```

Back it with `CREATE INDEX workflow_instances_timeout_parked_idx ON workflow_instances (timeout_parked_at) WHERE timeout_parked_at IS NOT NULL`.

### countInstances -- Active Instance Counting

**(v7.0.0)** Backs `WorkflowRuntime.initialize()`'s startup executability check and `runtime.listDefinitionVersions()`: counts non-terminal instances stamped with a given definition version, so the runtime knows whether an old version has drained.

**Requirements:**

- Filter: `workflow_name = workflowName AND definition_version = definitionVersion`, excluding rows whose `current_state` is in `excludeStates`
- **An empty `excludeStates` must exclude nothing** -- every matching row is counted, not zero
- Instances with a `null` `definition_version` never match (they're legacy rows, never counted as "active" for a specific version)
- A plain read: **no transaction required**

**SQL pattern (what `@duraflows/pg` uses):**

```sql
SELECT count(*)::int FROM workflow_instances
WHERE workflow_name = $1 AND definition_version = $2
  AND NOT (current_state = ANY($3::text[]))
```

With an empty array bound to `$3`, `NOT (current_state = ANY('{}'))` evaluates to `true` for every row, so nothing is excluded -- no special-casing needed in the SQL itself.

**Kysely equivalent** (Kysely rejects `.where(col, "not in", [])`, so the empty case needs an explicit branch):

```ts
let query = db
  .selectFrom("workflow_instances")
  .select((eb) => eb.fn.countAll<number>().as("count"))
  .where("workflow_name", "=", workflowName)
  .where("definition_version", "=", definitionVersion);
if (excludeStates.length > 0) {
  query = query.where("current_state", "not in", [...excludeStates]);
}
const row = await query.executeTakeFirst();
return Number(row?.count ?? 0);
```

**Drizzle equivalent:**

```ts
await db
  .select({ count: sql<number>`count(*)::int` })
  .from(workflowInstances)
  .where(
    and(
      eq(workflowInstances.workflowName, workflowName),
      eq(workflowInstances.definitionVersion, definitionVersion),
      excludeStates.length > 0 ? notInArray(workflowInstances.currentState, excludeStates) : undefined,
    ),
  );
```

Back it with the recommended index `workflow_instances_definition_version_idx ON workflow_instances (workflow_name, definition_version)` (`@duraflows/pg`'s migration `006`) so this stays cheap as the table grows.

### findInstanceUuids -- Optional Migration Support (v7.1.0)

**(v7.1.0)** Backs `runtime.migrateInstances()`'s candidate paging when a caller doesn't pass `instanceUuids` explicitly. **Optional** -- omit it and your adapter still compiles and runs; migration then requires `instanceUuids`.

**Requirements:**

- Filter: `workflow_name = workflowName AND definition_version = definitionVersion`, and `uuid > afterUuid` when `afterUuid` is given
- Order **ascending** by `uuid`, capped at `limit` -- **(v7.2.0)** ascending by string comparison of the UUID strings you return, and `uuid > afterUuid` in that same order: `migrateInstances()` checks each page with JavaScript's `>` and throws `MigrationInterruptedError` on one that doesn't advance. PostgreSQL's `uuid` type (and a text column of lowercase UUIDs) already orders this way; SQL Server's `uniqueidentifier` and MySQL's `UUID_TO_BIN(u, 1)` don't -- order and compare by the canonical lowercase text form there
- Instances with a `null` `definition_version` never match
- **(v7.2.0)** `states`/`excludeStates` are **hints, not a contract**: filter by them if you can (`current_state IN states`, `current_state NOT IN excludeStates`), but it's fine to ignore either or both -- `migrateInstances()` re-checks the same condition on every candidate itself, so an adapter that skips server-side filtering is still correct, just slower. If you do filter: an empty `states` array must match nothing (not "no filter"); an empty `excludeStates` array must exclude nothing, same as `countInstances()`'s contract
- A plain read: **no transaction required**

**SQL pattern (what `@duraflows/pg` uses):**

```sql
SELECT uuid FROM workflow_instances
WHERE workflow_name = $1 AND definition_version = $2
  AND ($3::uuid IS NULL OR uuid > $3::uuid)
  AND ($5::text[] IS NULL OR current_state = ANY($5::text[]))
  AND ($6::text[] IS NULL OR NOT (current_state = ANY($6::text[])))
ORDER BY uuid
LIMIT $4
```

An empty `states` array binds `$5` to `'{}'`; `current_state = ANY('{}')` is never true, so every row is filtered out, matching the "empty `states` matches nothing" contract. PostgreSQL orders `uuid` the same way as comparing lowercase hex strings, so an in-memory string-comparison implementation pages identically.

**Kysely equivalent** (the `afterUuid` filter is added only when given, same shape as `countInstances`'s empty-array branch; `states`/`excludeStates` are optional, so a minimal implementation can skip both `if` blocks entirely and still be correct):

```ts
if (states !== undefined && states.length === 0) {
  return []; // empty `states` matches nothing
}
let query = db
  .selectFrom("workflow_instances")
  .select("uuid")
  .where("workflow_name", "=", workflowName)
  .where("definition_version", "=", definitionVersion);
if (afterUuid !== undefined) {
  query = query.where("uuid", ">", afterUuid);
}
if (states !== undefined) {
  query = query.where("current_state", "in", [...states]);
}
if (excludeStates !== undefined && excludeStates.length > 0) {
  query = query.where("current_state", "not in", [...excludeStates]);
}
const rows = await query.orderBy("uuid").limit(limit).execute();
return rows.map((row) => row.uuid);
```

Back it with the same `workflow_instances_definition_version_idx` recommended for `countInstances()` -- it covers this filter too.

**Tolerant conformance.** `runInstanceStoreConformance`'s state-hints case accepts either a store that filters exactly (returns only the matching UUIDs) or one that ignores `states`/`excludeStates` entirely (returns every UUID) -- both pass, because `migrateInstances()` applies the same filter itself either way. See [Testing Your Adapter](#testing-your-adapter).

### runInTransaction -- Nested Transaction Support

**Requirements:**

- If already inside a transaction, run the callback in a **savepoint** on that same connection (don't start a new transaction): release it on success; on error, roll back to it and re-throw. A failed nested call then leaves no partial writes and the outer transaction stays usable. (Reusing the connection without a savepoint still conforms, but gives nested calls no failure isolation -- a caught failure's writes would commit with the outer transaction.)
- On success: commit
- On error: rollback and re-throw
- **Reject a COMMIT that PostgreSQL rolled back.** After a statement fails and its error is caught, PostgreSQL answers `COMMIT` with `ROLLBACK` and no error. Check the command tag, or (if your driver discards it, as Kysely does) probe `SELECT 1` just before `COMMIT` -- it fails in an aborted transaction -- and throw `WorkflowError`, so the caller never sees a success and no observers fire.
- The callback may call store methods that need the transaction context

**Pattern (using AsyncLocalStorage; shown with the `pg` driver -- adapt the client calls to yours):**

```ts
import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient } from "pg";
import { WorkflowError, type WorkflowTransactionRunner } from "@duraflows/core";

const storage = new AsyncLocalStorage<{ client: PoolClient; savepoints: number }>();

class MyTransactionRunner implements WorkflowTransactionRunner {
  constructor(private readonly pool: Pool) {}

  async runInTransaction<T>(callback: () => Promise<T>): Promise<T> {
    // Nested: isolate the callback in a savepoint on the active connection
    const active = storage.getStore();
    if (active) {
      const savepoint = `my_sp_${++active.savepoints}`;
      await active.client.query(`SAVEPOINT ${savepoint}`);
      try {
        const result = await callback();
        await active.client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        await active.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        throw error;
      }
    }

    // Start new transaction on a dedicated connection
    const client = await this.pool.connect();
    let brokenConnection: Error | undefined;
    try {
      await client.query("BEGIN");
      const result = await storage.run({ client, savepoints: 0 }, callback);
      const commit = await client.query("COMMIT");
      // A swallowed statement error turns COMMIT into a silent ROLLBACK
      if (commit.command === "ROLLBACK") {
        throw new WorkflowError(
          "COMMIT was rolled back by PostgreSQL because an earlier statement in the transaction failed",
        );
      }
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        // Never mask the original error; destroy the connection instead of pooling it
        brokenConnection = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
      throw error;
    } finally {
      client.release(brokenConnection);
    }
  }
}
```

**Store methods must detect the transaction context:**

```ts
class MyInstanceStore implements WorkflowInstanceStore {
  private getClient(): PoolClient | Pool {
    return storage.getStore()?.client ?? this.pool; // use transaction client if available
  }
}
```

The reference implementations live in the adapters' source (internal helpers, not exported): `packages/duraflows-pg/src/pg-transaction-context.ts` (command-tag check) and `packages/duraflows-kysely/src/kysely-transaction-context.ts` (`SELECT 1` probe). Verify yours with `runTransactionRunnerConformance` (see [Testing Your Adapter](#testing-your-adapter)).

### ensure -- Insert-If-Absent, Never Overwrite

Backs `WorkflowRuntime.initialize()`'s definition sync, and **(v7.2.0)** also runs inside every transaction that stamps an instance with a definition version -- `createInstance()`, a legacy or `"latest"`-policy instance adopting the latest version, and each instance `migrateInstances()` moves -- so the snapshot commits or rolls back with the instance row. It must therefore be cheap (a no-op insert plus a primary-key read once the row exists) and, like the instance and history stores, use the active transaction's connection when there is one. The runtime relies on `ensure()` being a true insert-if-absent: it calls `ensure()` for every registered definition on every startup, then compares the returned row's `contentHash` against the freshly-computed one to detect drift. If `ensure()` ever overwrote an existing row with the caller's new content instead of returning what was already stored, the drift check would always pass and the version-bump guard would be silently defeated.

**Requirements:**

- **Insert if `(workflowName, version)` is absent**, otherwise leave the existing row untouched
- **Must be atomic under concurrent callers** -- two processes racing to `ensure()` the same `(workflowName, version)` for the first time must not both "win" and insert conflicting rows
- **Return the stored row** -- the pre-existing one if it was already there, the newly inserted one otherwise
- **Never overwrite** an existing row's `contentHash` or `definitionJson`, no matter what the caller passes

**SQL pattern (what both shipped adapters use):**

```sql
INSERT INTO workflow_definitions (workflow_name, version, content_hash, definition_json)
VALUES ($1, $2, $3, $4)
ON CONFLICT (workflow_name, version) DO NOTHING;

-- then re-select to get the authoritative row, whichever call inserted it:
SELECT * FROM workflow_definitions WHERE workflow_name = $1 AND version = $2;
```

`ON CONFLICT DO NOTHING` makes the insert a no-op when the row already exists (instead of erroring or overwriting), and the primary key on `(workflow_name, version)` is what makes the whole sequence atomic under concurrent callers -- the database, not application code, arbitrates who "wins" the insert. The re-select then returns whichever row is actually stored, regardless of which caller (if either) inserted it.

**Drizzle equivalent:**

```ts
await db.insert(workflowDefinitions).values(record).onConflictDoNothing();
const [stored] = await db
  .select()
  .from(workflowDefinitions)
  .where(
    and(eq(workflowDefinitions.workflowName, record.workflowName), eq(workflowDefinitions.version, record.version)),
  );
```

### listVersions -- All Stored Snapshots

**(v7.0.0)** Backs `WorkflowRuntime.initialize()`'s startup executability check and `runtime.listDefinitionVersions()`. A plain, ordered read -- no upsert semantics to get right, unlike `ensure()`.

**Requirements:**

- Return every stored snapshot of `workflowName`, ordered by `version` ascending
- Return an empty array (not `null`/`undefined`) when the workflow has no stored versions
- A plain read: **no transaction required**

**SQL pattern:**

```sql
SELECT * FROM workflow_definitions WHERE workflow_name = $1 ORDER BY version
```

**Drizzle equivalent:**

```ts
await db
  .select()
  .from(workflowDefinitions)
  .where(eq(workflowDefinitions.workflowName, workflowName))
  .orderBy(asc(workflowDefinitions.version));
```

---

## WorkflowInstance Fields

All fields must be persisted and restored correctly:

| Field               | Type                           | Storage Notes                                                                                                                                                                                                                                                               |
| ------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uuid`              | `string`                       | PK, application-generated (not DB-generated)                                                                                                                                                                                                                                |
| `workflowName`      | `string`                       | Text column                                                                                                                                                                                                                                                                 |
| `currentState`      | `string`                       | Text column                                                                                                                                                                                                                                                                 |
| `version`           | `number`                       | Integer, starts at 0, incremented on each update                                                                                                                                                                                                                            |
| `definitionVersion` | `number \| null`               | Nullable integer. The definition version currently governing this instance. `null` on legacy rows created before definition versioning existed; the runtime stamps a real value on the instance's next transition. `update()` must persist it like any other mutable field. |
| `expiresAt`         | `Date \| null`                 | Nullable timestamp                                                                                                                                                                                                                                                          |
| `timeoutRetry`      | `WorkflowTimeoutRetry \| null` | **(v6.0.0)** Failed-timeout retry state (`{ attempts, lastError, retryAt, parkedAt }`), stored in four columns -- see [Timeout retry mapping](#timeout-retry-mapping) below. `create()` and `update()` must write it on every call.                                         |
| `lastTransitionAt`  | `Date`                         | Timestamp                                                                                                                                                                                                                                                                   |
| `context`           | `Record<string, unknown>`      | JSON/JSONB column                                                                                                                                                                                                                                                           |
| `metadata`          | `Record<string, unknown>`      | JSON/JSONB column                                                                                                                                                                                                                                                           |
| `createdAt`         | `Date`                         | Timestamp                                                                                                                                                                                                                                                                   |
| `updatedAt`         | `Date`                         | Timestamp                                                                                                                                                                                                                                                                   |

### Timeout retry mapping

**(v6.0.0)** `timeoutRetry` maps to four columns on `workflow_instances`:

| `WorkflowTimeoutRetry` field | Column               | Type                         |
| ---------------------------- | -------------------- | ---------------------------- |
| `attempts`                   | `timeout_attempts`   | `integer NOT NULL DEFAULT 0` |
| `retryAt`                    | `timeout_retry_at`   | `timestamptz NULL`           |
| `lastError`                  | `timeout_last_error` | `text NULL`                  |
| `parkedAt`                   | `timeout_parked_at`  | `timestamptz NULL`           |

- `timeout_attempts = 0` ⇔ `timeoutRetry: null` ("never failed", or cleared by a successful transition or `rearmTimeout`).
- Writing `timeoutRetry: null`: `timeout_attempts = 0` and the other three columns `NULL`.
- Reading `timeout_attempts > 0`: build the object; a `NULL` `timeout_last_error` reads as `lastError: ""`.
- `lastError` arrives truncated to 2000 characters with NUL characters already replaced by U+FFFD (PostgreSQL `text` rejects NUL), so store it as-is.

```ts
// On read
timeoutRetry:
  row.timeout_attempts > 0
    ? {
        attempts: row.timeout_attempts,
        lastError: row.timeout_last_error ?? "",
        retryAt: row.timeout_retry_at ? new Date(row.timeout_retry_at) : null,
        parkedAt: row.timeout_parked_at ? new Date(row.timeout_parked_at) : null,
      }
    : null,
```

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

| Field                  | Type                                         | Storage Notes                                                                                                                                                                                                                                                           |
| ---------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflowInstanceUuid` | `string`                                     | FK to workflow_instances                                                                                                                                                                                                                                                |
| `fromState`            | `string \| null`                             | Null for creation records                                                                                                                                                                                                                                               |
| `eventName`            | `string`                                     | "onEnter" for auto-transitions                                                                                                                                                                                                                                          |
| `toState`              | `string`                                     | Target state (== `fromState` for guard-rejected and command-only events)                                                                                                                                                                                                |
| `outcome`              | `"success" \| "failure" \| "guard-rejected"` | Constrained string. **(v1.1.0)** `"guard-rejected"` was added; CHECK constraint must accept it.                                                                                                                                                                         |
| `errorMessage`         | `string \| undefined`                        | Optional. Map DB `NULL` → `undefined` on read.                                                                                                                                                                                                                          |
| `rejectedBy`           | `string \| undefined`                        | **(v1.1.0)** declared `eventDef.guard.name` for guard-rejected rows; `undefined` otherwise. Map `NULL → undefined` on read, the same convention as `errorMessage`.                                                                                                      |
| `commandResultsJson`   | `CommandResult[]`                            | JSON array. Empty `[]` for guard-rejected rows. (Field name on the public type ends in `Json` — distinct from the runtime's `WorkflowExecutionResult.commandResults`.)                                                                                                  |
| `triggerMetadata`      | `Record<string, unknown> \| undefined`       | JSON object. Optional on the public type — map DB `NULL` → `undefined` on read.                                                                                                                                                                                         |
| `definitionVersion`    | `number \| null \| undefined`                | The definition version that governed this transition. Optional on the public type — map DB `NULL` → `undefined` on read, the same convention as `errorMessage`.                                                                                                         |
| `createdAt`            | `Date \| undefined`                          | **(v5.0.0)** When the store recorded this transition. Populated on read from the `created_at` column; ignored on write (`append()` never sends it — the database assigns it via its column default). Optional on the public type so pre-v5.0.0 adapters keep compiling. |

`append()` must return a string UUID for the created record.

`findByInstanceUuid()` should default `limit` to 50 and `offset` to 0 when not provided. Order by `created_at DESC, uuid DESC` -- both reference adapters use this exact two-column sort, and a custom adapter must match it (or an equivalent monotonic-tiebreak scheme) to return a well-defined order.

**Why `uuid` is part of the sort:** PostgreSQL's `now()` is transaction-scoped, so every history row written inside the same database transaction (an event plus its entire `onEnter` chain) shares an identical `created_at`. `uuid` is therefore the only tiebreaker, and whether that tiebreak is _correct_ (matches write order) or merely _stable_ (consistent but arbitrary) depends entirely on how your adapter's `uuid` column is generated -- a monotonic scheme (e.g. PostgreSQL's `uuidv7()`, PG 18+) sorts rows in write order; a random one (e.g. `gen_random_uuid()`, the `@duraflows/pg` default) sorts them arbitrarily. If your adapter delegates UUID generation to the database (as both reference adapters do), this is a migration-level choice, not something adapter code can fix at read time. See [docs/persistence.md](https://github.com/camcima/duraflows/blob/main/docs/persistence.md#ordering-within-a-multi-hop-transition) for the full explanation, including a verified empirical example (`ORDER BY created_at DESC, uuid DESC` recovered a five-row transaction as `1,3,4,5,2` with `gen_random_uuid()` vs. `5,4,3,2,1` with `uuidv7()`).

`createdAt` caveat: every history row written inside the same database transaction (an event plus its entire `onEnter` chain) shares an identical `created_at`, and ties are broken on a random UUID by default, so `createdAt` must never be used to reconstruct the order of steps within one multi-hop transition — only to know roughly when the transition happened.

---

## Database Schema Reference

Use this as a guide for your migration:

```sql
CREATE TABLE workflow_instances (
  uuid                uuid PRIMARY KEY,
  workflow_name       text NOT NULL,
  current_state       text NOT NULL,
  version             integer NOT NULL DEFAULT 0,
  -- Definition versioning: NULL on legacy rows, stamped on next transition.
  definition_version  integer,
  expires_at          timestamptz,
  last_transition_at  timestamptz NOT NULL DEFAULT now(),
  context_json        jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- v6.0.0: timeout retry state (WorkflowInstance.timeoutRetry); 0 attempts = null.
  timeout_attempts    integer NOT NULL DEFAULT 0,
  timeout_retry_at    timestamptz,
  timeout_last_error  text,
  timeout_parked_at   timestamptz
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
  -- Definition versioning: the definition version that governed this transition.
  definition_version      integer,
  created_at              timestamptz NOT NULL DEFAULT now()
);

-- Definition versioning: one immutable snapshot per (workflow_name, version).
-- Backs WorkflowDefinitionStore -- see "4. WorkflowDefinitionStore (optional)" above.
CREATE TABLE workflow_definitions (
  workflow_name    text NOT NULL,
  version          integer NOT NULL,
  content_hash     text NOT NULL,
  definition_json  jsonb NOT NULL,
  registered_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_name, version)
);

-- Recommended indexes
CREATE INDEX workflow_instances_workflow_name_idx ON workflow_instances (workflow_name);
CREATE INDEX workflow_instances_expires_at_idx ON workflow_instances (expires_at)
  WHERE expires_at IS NOT NULL;
-- v6.0.0: findExpired's due scan and findParkedTimeouts' listing.
CREATE INDEX workflow_instances_timeout_due_idx ON workflow_instances ((coalesce(timeout_retry_at, expires_at)))
  WHERE expires_at IS NOT NULL AND timeout_parked_at IS NULL;
CREATE INDEX workflow_instances_timeout_parked_idx ON workflow_instances (timeout_parked_at)
  WHERE timeout_parked_at IS NOT NULL;
CREATE INDEX workflow_history_instance_created_idx ON workflow_history (workflow_instance_uuid, created_at DESC);
-- v7.0.0 (recommended, not required): keeps countInstances() cheap for the
-- startup executability check and listDefinitionVersions().
CREATE INDEX workflow_instances_definition_version_idx ON workflow_instances (workflow_name, definition_version);
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

`workflow_instances` had no schema changes for v1.1.0 -- that stopped being true with definition versioning, below, which adds a column to both tables plus a new table.

### Adding definition versioning to an existing schema

Upgrading an existing adapter to support definition versioning needs three changes:

```sql
-- 1. New table: one immutable snapshot per (workflow_name, version).
CREATE TABLE workflow_definitions (
  workflow_name    text NOT NULL,
  version          integer NOT NULL,
  content_hash     text NOT NULL,
  definition_json  jsonb NOT NULL,
  registered_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_name, version)
);

-- 2. Add definition_version to workflow_instances.
ALTER TABLE workflow_instances ADD COLUMN definition_version integer;

-- 3. Add definition_version to workflow_history.
ALTER TABLE workflow_history ADD COLUMN definition_version integer;
```

`@duraflows/pg` ships this as `004_definition_versions.sql`; `@duraflows/kysely` bootstraps its test schema from `@duraflows/pg`'s `generateMigrationSql()`, so both adapters share one schema definition. If you wrap a different ORM, mirror the three operations in the migration tool of your choice. There's no backfill for either column — pre-existing rows keep `definition_version IS NULL`, which maps to `definitionVersion: null` on `WorkflowInstance` and `definitionVersion: undefined` on `WorkflowHistoryRecord`. Instances pick up a real version stamp the next time they transition; history rows written before the upgrade stay `null`/`undefined` forever, since history is immutable.

Implementing the schema alone isn't enough — you also need a `WorkflowDefinitionStore` implementation (see [4. WorkflowDefinitionStore (optional)](#4-workflowdefinitionstore-optional) and [ensure -- Insert-If-Absent, Never Overwrite](#ensure----insert-if-absent-never-overwrite) above) and to wire it into your `WorkflowPersistenceProvider`'s `definitionStore` field, or the new table and columns will sit unused.

### v6.0.0 — Adding timeout retries to an existing schema

Upgrading an existing adapter to 6.0.0 needs four columns and two partial indexes on `workflow_instances`:

```sql
ALTER TABLE workflow_instances
  ADD COLUMN IF NOT EXISTS timeout_attempts   integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS timeout_retry_at   timestamptz NULL,
  ADD COLUMN IF NOT EXISTS timeout_last_error text        NULL,
  ADD COLUMN IF NOT EXISTS timeout_parked_at  timestamptz NULL;

CREATE INDEX IF NOT EXISTS workflow_instances_timeout_due_idx
  ON workflow_instances ((coalesce(timeout_retry_at, expires_at)))
  WHERE expires_at IS NOT NULL AND timeout_parked_at IS NULL;

CREATE INDEX IF NOT EXISTS workflow_instances_timeout_parked_idx
  ON workflow_instances (timeout_parked_at)
  WHERE timeout_parked_at IS NOT NULL;
```

`@duraflows/pg` ships this as `005_timeout_retries.sql`, and it must be applied **before** deploying 6.0.0: `create()` and `update()` write these columns on every call. Existing rows get `timeout_attempts = 0`, which maps to `timeoutRetry: null`. On large tables, set `lock_timeout` for the migration, and consider pre-building both indexes with `CREATE INDEX CONCURRENTLY` (same names and definitions) after adding the columns; the `IF NOT EXISTS` clauses then skip them. The schema alone isn't enough -- the adapter must also map `timeoutRetry` (see [Timeout retry mapping](#timeout-retry-mapping)), apply the new `findExpired` filter and ordering, and implement `findParkedTimeouts`.

### v7.0.0 — Adding definition-version pinning to an existing adapter

No schema change is required -- `definition_version` already exists on `workflow_instances` from `004_definition_versions.sql`. Two methods are new, and the `@duraflows/core` types require both:

1. **Add `WorkflowInstanceStore.countInstances()`.** This is required on **every** adapter, whether or not it implements `WorkflowDefinitionStore` -- see [countInstances](#countinstances----active-instance-counting).
2. **If you implement `WorkflowDefinitionStore`, add `listVersions()`** -- see [listVersions](#listversions----all-stored-snapshots).

The runtime calls both in `initialize()` (for the startup executability check, when a definition store is configured) and in `runtime.listDefinitionVersions()`. An adapter missing either fails to typecheck against 7.0.0; one built without type checking fails at those calls. Definition-version pinning itself needs no further adapter changes -- `DefinitionResolver` reads existing snapshots through `findByNameAndVersion()`, already implemented for the version-bump guard.

Separately, a new index is **recommended, not required**: it keeps `countInstances()` cheap on large tables. `@duraflows/pg` ships it as `006_definition_version_index.sql`:

```sql
CREATE INDEX IF NOT EXISTS workflow_instances_definition_version_idx
  ON workflow_instances (workflow_name, definition_version);
```

### v7.1.0 — Adding findInstanceUuids to an existing adapter

No schema or type change is required -- `findInstanceUuids` is a new **optional** method on `WorkflowInstanceStore`, so an adapter that skips it still typechecks and runs against 7.1.0; `runtime.migrateInstances()` simply requires its callers to pass `instanceUuids` explicitly. Add it only to support migrating without an explicit UUID list -- see [findInstanceUuids](#findinstanceuuids----optional-migration-support-v710). It reuses the same `(workflow_name, definition_version)` index migration `006` already recommends.

### v7.2.0 — Adding the state hints to an existing findInstanceUuids

No schema or type change is required either -- if your adapter already implements `findInstanceUuids`, it still typechecks and runs against 7.2.0 without touching `states`/`excludeStates` at all; `migrateInstances()` just filters those candidates itself, a little less efficiently. Add server-side filtering only as an optimization -- see [findInstanceUuids](#findinstanceuuids----optional-migration-support-v710) for the SQL pattern and the empty-array contract (`states: []` matches nothing, `excludeStates: []` excludes nothing). If your adapter doesn't implement `findInstanceUuids` at all, this doesn't apply to you.

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
  definitionStore: new MyDefinitionStore(orm), // optional -- omit to leave versioning inert
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
    definitionStore: new MyDefinitionStore(orm), // optional -- omit to leave versioning inert
  },
});
```

With `definitionStore` supplied, `WorkflowModule` calls `WorkflowRuntime.initialize()` automatically at module init, so a version-bump violation fails application startup rather than surfacing on the first workflow operation.

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
      definitionStore: new PrismaDefinitionStore(prisma), // optional
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
- [ ] **(v6.0.0)** `findExpired()` excludes parked rows and rows whose `timeout_retry_at` is still in the future, adds the redundant `coalesce(timeout_retry_at, expires_at) < now` condition, and orders by `coalesce(timeout_retry_at, expires_at)`
- [ ] **(v6.0.0)** `findParkedTimeouts({ limit, workflowName? })` returns only parked rows (optionally filtered by `workflow_name`), ordered by `timeout_parked_at, uuid`, at most `limit`, without requiring a transaction
- [ ] **(v6.0.0)** The four `timeout_*` columns exist; `create()`/`update()` persist `timeoutRetry` (`null` ⇔ `timeout_attempts = 0` and the other three `NULL`); a `NULL` `timeout_last_error` with attempts > 0 reads as `lastError: ""`
- [ ] `runInTransaction()` supports nesting: a nested call runs in a savepoint on the active connection (released on success, rolled back to on error)
- [ ] `runInTransaction()` rolls back on error
- [ ] `runInTransaction()` rejects with `WorkflowError` when PostgreSQL answers `COMMIT` with `ROLLBACK` (check the command tag, or probe `SELECT 1` before `COMMIT`)
- [ ] If your runner implements the optional `afterCommit`: `runTransactionRunnerConformance` from `@duraflows/core/testing` passes against it (the suite requires `afterCommit`)
- [ ] `append()` returns a generated UUID string
- [ ] `findByInstanceUuid()` supports `limit`/`offset` pagination, returns newest-first (`created_at DESC, uuid DESC` -- see the ordering contract above)
- [ ] All Date fields are stored and retrieved as `Date` objects
- [ ] JSON fields (`context`, `metadata`, `commandResults`, `triggerMetadata`) survive round-trips
- [ ] `null` handling for `expiresAt`, `timeoutRetry`, `fromState`, `errorMessage`
- [ ] **(v1.0.0)** `runInstanceStoreConformance` from `@duraflows/core/testing` passes against your adapter
- [ ] **(v1.1.0)** `workflow_history.outcome` CHECK constraint accepts `'guard-rejected'` (in addition to `'success'`/`'failure'`)
- [ ] **(v1.1.0)** `rejected_by` column exists on `workflow_history`; persisted on `append()` for guard-rejected rows; mapped `NULL → undefined` on read (same convention as `errorMessage`)
- [ ] **(v1.1.0)** Guard-rejected rows are persisted with `commandResults: []` and `toState === fromState` — verify your write path doesn't strip or rewrite either
- [ ] **(v5.0.0)** `definition_version` column exists on both `workflow_instances` and `workflow_history`; `create()`/`update()` persist `WorkflowInstance.definitionVersion` (mapped `null` on legacy rows); `append()` persists `WorkflowHistoryRecord.definitionVersion` (mapped `NULL → undefined` on read)
- [ ] **(v5.0.0)** `WorkflowDefinitionStore` implemented: `ensure()` is insert-if-absent, atomic under concurrent callers, and never overwrites an existing `(workflow_name, version)` row; `findByNameAndVersion()` returns `null` for unknown pairs
- [ ] **(v5.0.0)** `workflow_definitions` table exists with primary key `(workflow_name, version)`
- [ ] **(v5.0.0)** `definitionStore` wired into your `WorkflowPersistenceProvider` — it's optional (an adapter that omits it still compiles), but versioning stays inert without it
- [ ] **(v5.0.0)** `runDefinitionStoreConformance` from `@duraflows/core/testing` passes against your `WorkflowDefinitionStore`
- [ ] **(v5.0.0)** `findByInstanceUuid()` maps `created_at` into `WorkflowHistoryRecord.createdAt` (a `Date`); `append()` does NOT send it — the field is optional, so a forgotten mapping compiles fine and silently returns `undefined` for every caller (there's no history-store conformance suite to catch this)
- [ ] **(v7.0.0)** `WorkflowInstanceStore.countInstances({ workflowName, definitionVersion, excludeStates })` implemented on **every** adapter (not just ones with a `WorkflowDefinitionStore`); an empty `excludeStates` counts every matching row, not zero
- [ ] **(v7.0.0)** If you implement `WorkflowDefinitionStore`: `listVersions(workflowName)` returns snapshots ordered by `version` ascending, `[]` when none exist
- [ ] **(v7.0.0)** `runInstanceStoreConformance` and (if applicable) `runDefinitionStoreConformance` still pass -- both suites now cover `countInstances`/`listVersions`
- [ ] **(v7.0.0)** Recommended: index `(workflow_name, definition_version)` on `workflow_instances` so `countInstances()` stays cheap on large tables
- [ ] **(v7.1.0, optional)** If implemented, `findInstanceUuids({ workflowName, definitionVersion, limit, afterUuid? })` orders ascending by `uuid` -- **(v7.2.0)** by string comparison of the returned UUID strings -- filters `uuid > afterUuid` only when given, and never matches a `null` `definition_version`
- [ ] **(v7.1.0)** `runInstanceStoreConformance` still passes -- its `findInstanceUuids` case exercises the method when present and calls `ctx.skip()` when it's absent
- [ ] **(v7.2.0, optional)** If `findInstanceUuids` filters by `states`/`excludeStates`, an empty `states` matches nothing and an empty `excludeStates` excludes nothing; if it doesn't filter by them at all, that's fine too -- both are correct
- [ ] **(v7.2.0)** `runInstanceStoreConformance` still passes -- its state-hints case accepts either an exact-filtering store or one that ignores `states`/`excludeStates` entirely

---

## Testing Your Adapter

### v1.0.0 — Use the Conformance Suite

The shipped `runInstanceStoreConformance(label, harness)` from `@duraflows/core/testing` is the canonical contract test. Run it against your adapter and you can rely on the runtime working with it. `@duraflows/pg` and `@duraflows/kysely` both run this in CI.

```ts
import { describe } from "vitest";
import { runInstanceStoreConformance } from "@duraflows/core/testing";
import { MyInstanceStore } from "../src/my-instance-store.js";
import { MyTransactionRunner } from "../src/my-transaction-runner.js";

describe("MyInstanceStore (conformance)", () => {
  runInstanceStoreConformance("my-adapter", {
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

The suite verifies the persistence contract: `create`/`findByUuid` round-trips (and `null` for an unknown UUID), `update` persisting the mutable fields, optimistic concurrency on `version`, the `metadata` write-once contract, `findExpired` returning past-due instances within `limit`, the `timeoutRetry` round-trip, retry/parked filtering and due-time ordering in `findExpired`, `findParkedTimeouts` filtering and ordering, the `definitionVersion` round-trip, **(v7.0.0)** `countInstances` filtering by workflow, definition version and excluded states (including that an empty `excludeStates` counts everything), **(v7.1.0)** `findInstanceUuids` paging by workflow and definition version honoring `afterUuid`/`limit`, and **(v7.2.0)** its `states`/`excludeStates` hints (tolerant: exact filtering and ignoring the hints both pass) -- both `findInstanceUuids` cases are skipped (`ctx.skip()`) when your adapter doesn't implement the optional method. It does **not** exercise row locking, `SKIP LOCKED` or nested transactions: cover locking in your own integration tests, and the runner with the suite below.

### Transaction Runner — Use the Runner Conformance Suite

`runTransactionRunnerConformance(label, harness)` (also from `@duraflows/core/testing`) verifies a runner that implements `afterCommit`: callbacks run after the outermost commit, in order, are dropped on rollback, and a throwing one doesn't stop the rest; a failed nested call rolls back only its own writes and callbacks (savepoints); the outer transaction stays usable after a caught nested database error (supply `failWithDatabaseError`, e.g. running `SELECT 1/0`, or that case is skipped); `afterCommit` outside a transaction throws `WorkflowError`; and a transaction started from a callback is a fresh outermost one. Its harness is `{ setup() }`, where `setup()` resolves to `{ runner, store, failWithDatabaseError?, teardown }` for each test.

### Definition Versioning — Use the Definition-Store Conformance Suite

If you implement `WorkflowDefinitionStore`, verify it with `runDefinitionStoreConformance(label, harness)`, also from `@duraflows/core/testing`:

```ts
import { describe } from "vitest";
import { runDefinitionStoreConformance } from "@duraflows/core/testing";
import { MyDefinitionStore } from "../src/my-definition-store.js";

describe("MyDefinitionStore (conformance)", () => {
  runDefinitionStoreConformance("my-adapter", {
    setup: async () => {
      const store = new MyDefinitionStore(db);
      return {
        store,
        teardown: async () => {
          await db.destroy();
        },
      };
    },
  });
});
```

It verifies: `ensure()` inserts a new snapshot and returns it, `ensure()` returns the pre-existing row unchanged (not the caller's new content) when `(workflowName, version)` already exists, `findByNameAndVersion()` round-trips a structurally equal definition and returns `null` for unknown pairs, different versions of the same workflow are stored as independent rows, and **(v7.0.0)** `listVersions()` returns only the named workflow's snapshots ordered by `version` ascending.

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
