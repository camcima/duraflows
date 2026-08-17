import type { Pool } from "pg";
import type { WorkflowPersistenceProvider } from "@duraflows/core";
import { PgWorkflowInstanceStore } from "./pg-instance-store.js";
import { PgWorkflowHistoryStore } from "./pg-history-store.js";
import { PgWorkflowDefinitionStore } from "./pg-definition-store.js";
import { PgTransactionRunner, type PgTransactionRunnerOptions } from "./pg-transaction-runner.js";

export { PgTransactionContext } from "./pg-transaction-context.js";
export { PgTransactionRunner } from "./pg-transaction-runner.js";
export type { PgTransactionRunnerOptions } from "./pg-transaction-runner.js";
export { PgWorkflowInstanceStore } from "./pg-instance-store.js";
export { PgWorkflowHistoryStore } from "./pg-history-store.js";
export { PgWorkflowDefinitionStore } from "./pg-definition-store.js";
export { generateMigrationSql } from "./pg-schema-manager.js";
export type { UuidStrategy, MigrationSqlOptions } from "./pg-schema-manager.js";

/**
 * Options accepted by {@link pgWorkflowProviders}. Every field is optional and
 * omitting the argument entirely reproduces the pre-existing behaviour.
 */
export type PgWorkflowProvidersOptions = PgTransactionRunnerOptions;

export function pgWorkflowProviders(pool: Pool, options: PgWorkflowProvidersOptions = {}): WorkflowPersistenceProvider {
  const transactionRunner = new PgTransactionRunner(pool, options);
  const instanceStore = new PgWorkflowInstanceStore(pool);
  const historyStore = new PgWorkflowHistoryStore(pool);
  const definitionStore = new PgWorkflowDefinitionStore(pool);
  return { instanceStore, historyStore, transactionRunner, definitionStore };
}
