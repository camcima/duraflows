import type { CommandResult, WorkflowInstance } from "./runtime.js";

export interface WorkflowInstanceStore {
  create(instance: WorkflowInstance): Promise<void>;
  findByUuid(uuid: string): Promise<WorkflowInstance | null>;
  lockByUuid(uuid: string): Promise<WorkflowInstance | null>;
  update(instance: WorkflowInstance): Promise<void>;
  findExpired(limit: number, now: Date): Promise<WorkflowInstance[]>;
}

export interface WorkflowHistoryStore {
  append(entry: WorkflowHistoryRecord): Promise<string>;
  findByInstanceUuid(
    workflowInstanceUuid: string,
    options?: { limit?: number; offset?: number },
  ): Promise<WorkflowHistoryRecord[]>;
}

export interface WorkflowHistoryRecord {
  workflowInstanceUuid: string;
  fromState: string | null;
  eventName: string;
  toState: string;
  outcome: "success" | "failure";
  errorMessage?: string;
  commandResultsJson: CommandResult[];
  triggeredByType?: string;
  triggeredByUuid?: string;
}

export interface WorkflowTransactionRunner {
  runInTransaction<T>(callback: () => Promise<T>): Promise<T>;
}

export interface WorkflowClock {
  now(): Date;
}

export interface WorkflowPersistenceProvider {
  instanceStore: WorkflowInstanceStore;
  historyStore: WorkflowHistoryStore;
  transactionRunner: WorkflowTransactionRunner;
}
