import type { Pool } from "pg";
import type { WorkflowPersistenceProvider } from "@camcima/duraflows-core";
import { PgWorkflowInstanceStore } from "./pg-instance-store.js";
import { PgWorkflowHistoryStore } from "./pg-history-store.js";
import { PgTransactionRunner } from "./pg-transaction-runner.js";

export { PgTransactionContext } from "./pg-transaction-context.js";
export { PgTransactionRunner } from "./pg-transaction-runner.js";
export { PgWorkflowInstanceStore } from "./pg-instance-store.js";
export { PgWorkflowHistoryStore } from "./pg-history-store.js";
export { generateMigrationSql } from "./pg-schema-manager.js";
export type { UuidStrategy, MigrationSqlOptions } from "./pg-schema-manager.js";

export function pgWorkflowProviders(pool: Pool): WorkflowPersistenceProvider {
  const transactionRunner = new PgTransactionRunner(pool);
  const instanceStore = new PgWorkflowInstanceStore(pool);
  const historyStore = new PgWorkflowHistoryStore(pool);
  return { instanceStore, historyStore, transactionRunner };
}
