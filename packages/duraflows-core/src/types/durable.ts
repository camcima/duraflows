import type { WorkflowDefinition } from "./definition.js";
import type { CommandResult, TriggerWorkflowEventInput, WorkflowExecutionResult } from "./runtime.js";

export interface EnqueueWorkflowEventInput extends TriggerWorkflowEventInput {
  /** Required stable request identity; scoped to the instance and the queued API. */
  idempotencyKey: string;
}

export interface DurableExecutionOptions {
  leaseDurationMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
}

export interface WorkflowCommandCheckpoint {
  id: string;
  name: string;
  result: CommandResult;
  context: Record<string, unknown>;
  attempts: number;
  completedAt: string;
}

/** Durable execution record. Timestamps are ISO strings, including on first return. */
export interface DurableWorkflowExecution {
  uuid: string;
  workflowInstanceUuid: string;
  workflowName: string;
  eventName: string;
  idempotencyKey: string;
  idempotencyFingerprint?: string;
  status: "pending" | "running" | "parked" | "completed" | "cancelled";
  revision: number;
  definition: WorkflowDefinition;
  bestEffortCommands: string[];
  instanceVersion: number;
  fromState: string;
  initialContext: Record<string, unknown>;
  metadata: Record<string, unknown>;
  subject?: unknown;
  triggerMetadata: Record<string, unknown>;
  journal: WorkflowCommandCheckpoint[];
  rejectedBy?: string;
  result: WorkflowExecutionResult | null;
  attempts: number;
  lastError: string | null;
  availableAt: string;
  leaseToken: string | null;
  leaseUntil: string | null;
  createdAt: string;
  updatedAt: string;
  policy: Required<DurableExecutionOptions>;
  maxOnEnterDepth: number;
}

export interface ProcessPendingExecutionsInput {
  limit?: number;
}
export interface ProcessPendingExecutionsResult {
  processed: number;
  completed: string[];
  progressed: string[];
  retrying: string[];
  parked: string[];
  skipped: string[];
  failed: Array<{ uuid: string; error: string }>;
}

/**
 * Insert/update require the active workflow transaction and the instance row lock.
 * Reads use the same connection inside a transaction, otherwise a normal read.
 * Enforce unique (instance,key), one pending/running/parked execution per instance,
 * and optimistic revision updates (new revision - 1). Never overwrite on insert.
 * Store independent JSON copies; findDue is a hint, always rechecked under lock.
 */
export interface WorkflowExecutionStore {
  create(execution: DurableWorkflowExecution): Promise<void>;
  update(execution: DurableWorkflowExecution): Promise<void>;
  findByUuid(uuid: string): Promise<DurableWorkflowExecution | null>;
  findByKey(instanceUuid: string, key: string): Promise<DurableWorkflowExecution | null>;
  findActive(instanceUuid: string): Promise<DurableWorkflowExecution | null>;
  findDue(limit: number, now: Date): Promise<DurableWorkflowExecution[]>;
}
