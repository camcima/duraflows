import { PgWorkflowExecutionStore } from "./pg-execution-store.js";
export { PgWorkflowExecutionStore } from "./pg-execution-store.js";
import type { Pool } from "pg";
import type { WorkflowPersistenceProvider } from "@duraflows/core";
import { PgWorkflowInstanceStore } from "./pg-instance-store.js";
import { PgWorkflowHistoryStore } from "./pg-history-store.js";
import { PgWorkflowDefinitionStore } from "./pg-definition-store.js";
import { PgWorkflowIdempotencyStore } from "./pg-idempotency-store.js";
import { PgTransactionRunner, type PgTransactionRunnerOptions } from "./pg-transaction-runner.js";

export { PgTransactionContext } from "./pg-transaction-context.js";
export { PgTransactionRunner } from "./pg-transaction-runner.js";
export type { PgTransactionRunnerOptions } from "./pg-transaction-runner.js";
export { PgWorkflowInstanceStore } from "./pg-instance-store.js";
export { PgWorkflowHistoryStore } from "./pg-history-store.js";
export { PgWorkflowDefinitionStore } from "./pg-definition-store.js";
export { PgWorkflowIdempotencyStore } from "./pg-idempotency-store.js";
export {
  generateMigrationSql,
  generateIdempotencyMigrationSql,
  generateDurableExecutionMigrationSql,
} from "./pg-schema-manager.js";
export type { UuidStrategy, MigrationSqlOptions } from "./pg-schema-manager.js";

/**
 * Options accepted by {@link pgWorkflowProviders}. Every field is optional and
 * omitting the argument entirely reproduces the pre-existing behaviour.
 */
export interface PgWorkflowProvidersOptions extends PgTransactionRunnerOptions {
  /** Opt-in; apply the event-idempotency migration before keyed calls. */
  idempotency?: boolean;
  /** Apply migration 008 before enabling on every worker. */
  durableExecution?: boolean;
}

export function pgWorkflowProviders(pool: Pool, options: PgWorkflowProvidersOptions = {}): WorkflowPersistenceProvider {
  const transactionRunner = new PgTransactionRunner(pool, options);
  const instanceStore = new PgWorkflowInstanceStore(pool);
  const historyStore = new PgWorkflowHistoryStore(pool);
  const definitionStore = new PgWorkflowDefinitionStore(pool);
  return {
    instanceStore,
    historyStore,
    transactionRunner,
    definitionStore,
    ...(options.durableExecution ? { executionStore: new PgWorkflowExecutionStore(pool) } : {}),
    ...(options.idempotency ? { idempotencyStore: new PgWorkflowIdempotencyStore(pool) } : {}),
  };
}
