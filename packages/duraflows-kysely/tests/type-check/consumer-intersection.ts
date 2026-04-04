/**
 * Type-level probe: verifies that factory functions and KyselyTransactionContext
 * accept Kysely<AppDb & WorkflowDatabase> (intersection-typed consumer databases).
 *
 * This file is compiled but never executed — it exists to catch invariance regressions.
 */
import type { Kysely, Transaction } from "kysely";
import {
  kyselyWorkflowProviders,
  kyselyWorkflowProvidersFromTransaction,
  KyselyTransactionContext,
} from "../../src/index.js";
import type { WorkflowDatabase } from "../../src/kysely-database.js";

// Consumer's app database
interface OrdersTable {
  id: string;
  status: string;
}

interface AppDb extends WorkflowDatabase {
  orders: OrdersTable;
}

// These must compile — the main consumer use case
declare const db: Kysely<AppDb>;
declare const trx: Transaction<AppDb>;

// Factory functions accept intersection-typed db/trx
const _providers1 = kyselyWorkflowProviders(db);
const _providers2 = kyselyWorkflowProvidersFromTransaction(trx);

// Transaction context accepts intersection-typed trx
KyselyTransactionContext.run(trx, () => {});

// Also verify the narrow case still works
declare const narrowDb: Kysely<WorkflowDatabase>;
declare const narrowTrx: Transaction<WorkflowDatabase>;

const _providers3 = kyselyWorkflowProviders(narrowDb);
const _providers4 = kyselyWorkflowProvidersFromTransaction(narrowTrx);
KyselyTransactionContext.run(narrowTrx, () => {});
