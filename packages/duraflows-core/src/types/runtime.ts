export interface WorkflowCommand<TSubject = unknown> {
  readonly bestEffort?: boolean;
  execute(subject: TSubject, context: WorkflowExecutionContext): Promise<CommandResult> | CommandResult;
}

export interface CommandResult {
  ok: boolean;
  code?: string;
  message?: string;
  metadata?: Record<string, unknown>;
  error?: unknown;
}

export interface WorkflowExecutionContext {
  triggerMetadata: Readonly<Record<string, unknown>>;
  /** Injected clock value for this transition. Treat as immutable — do not call Date mutators on it. */
  readonly now: Date;
  context: Record<string, unknown>;
  metadata: Readonly<Record<string, unknown>>;
  readonly commandMetadata: Readonly<Record<string, unknown>>;
  readonly fromState: string | null;
  readonly toState: string;
  readonly transitionUuid: string;
}

/**
 * Retry state of an instance whose timeout processing has failed. The runtime
 * owns it: `processExpiredWorkflows` sets it after a failed attempt, and any
 * successful transition, `rearmTimeout`, or deadline clear resets it to `null`.
 */
export interface WorkflowTimeoutRetry {
  /** Consecutive failed timeout attempts since the last success (>= 1). */
  attempts: number;
  /** Message of the most recent failure, truncated to 2000 characters. */
  lastError: string;
  /** When the sweep may try again; `null` once parked. */
  retryAt: Date | null;
  /** When the instance was parked after `maxAttempts` failures; `null` while retrying. */
  parkedAt: Date | null;
}

/** How `processExpiredWorkflows` retries an instance whose timeout processing fails. */
export interface WorkflowTimeoutRetryOptions {
  /** Delay before the first retry, in ms. Default 60 000 (1 minute). */
  initialDelayMs?: number;
  /** Upper bound on the delay between retries, in ms. Default 3 600 000 (1 hour). */
  maxDelayMs?: number;
  /** Consecutive failures after which the instance is parked. Default 10. */
  maxAttempts?: number;
}

export interface WorkflowInstance<TState extends string = string> {
  uuid: string;
  workflowName: string;
  currentState: TState;
  version: number;
  /**
   * The definition version that currently governs this instance. `null` for
   * legacy rows created before definition versioning existed; such instances
   * are stamped on their next successful transition.
   */
  definitionVersion: number | null;
  expiresAt: Date | null;
  /**
   * Retry state after failed timeout processing; `null` when no timeout attempt
   * has failed since the last success. See {@link WorkflowTimeoutRetry}.
   */
  timeoutRetry: WorkflowTimeoutRetry | null;
  lastTransitionAt: Date;
  context: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowExecutionResult<TState extends string = string> {
  outcome: "success" | "failure" | "guard-rejected";
  fromState: TState;
  toState: TState;
  commandResults: CommandResult[];
  historyUuid: string;
  rejectedBy?: string;
}

export interface WorkflowGuard<TSubject = unknown> {
  readonly name: string;
  evaluate(subject: TSubject, context: WorkflowExecutionContext): boolean | Promise<boolean>;
}

export interface AvailableWorkflowEvent {
  eventName: string;
  targetState?: string;
  errorState?: string;
  hasCommands: boolean;
  hasTimeout: boolean;
  metadata?: Record<string, unknown>;
}

export interface CreateWorkflowInstanceInput {
  workflowName: string;
  context?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  triggerMetadata?: Record<string, unknown>;
}

export interface TriggerWorkflowEventInput {
  workflowInstanceUuid: string;
  eventName: string;
  subject?: unknown;
  triggerMetadata?: Record<string, unknown>;
  /** Stable identity of one request, scoped to this workflow instance. */
  idempotencyKey?: string;
  /** Optional caller-supplied identity of business inputs; compared exactly, including presence. */
  idempotencyFingerprint?: string;
}

export interface ProcessExpiredWorkflowsInput {
  limit?: number;
}

export interface FindParkedTimeoutsInput {
  /** Maximum instances to return. Default 100. */
  limit?: number;
  /** Only instances of this workflow. */
  workflowName?: string;
}

export interface ProcessExpiredWorkflowsResult {
  processed: number;
  rejected: number;
  /**
   * Subset of `processed` whose timeout event or subsequent on-enter chain
   * ended on an error path (a command returned `ok: false` and routed to
   * `errorState`). These instances transitioned, but to a failure state.
   */
  businessFailed: Array<{ uuid: string; finalState: string }>;
  /**
   * Infrastructure failures: the instance's timeout transaction rolled back.
   * When the failure was recorded, `attempts` is the consecutive failure count
   * and `retryAt` the next retry (`null` when this failure parked it).
   */
  failed: Array<{ uuid: string; error: string; attempts?: number; retryAt?: Date | null }>;
  /** Subset of `failed` parked by this sweep after reaching `maxAttempts`. */
  parked: Array<{ uuid: string; error: string }>;
}

export interface GetAvailableEventsInput {
  workflowInstanceUuid: string;
}

/** A stored definition version, as reported by `WorkflowRuntime.listDefinitionVersions`. */
export interface DefinitionVersionSummary {
  version: number;
  contentHash: string;
  registeredAt: Date;
  /** Instances stamped with this version whose current state is not terminal. */
  activeInstances: number;
}

/** Input for `WorkflowRuntime.migrateInstances`. */
export interface MigrateInstancesInput {
  workflowName: string;
  fromVersion: number;
  toVersion: number;
  /** Only renamed or removed states need entries: current state → target state. */
  stateMapping?: Record<string, string>;
  /** Optional and pure: returns the migrated instance's context. Must be a plain object; stored as its JSON round trip. */
  transformContext?: (
    context: Record<string, unknown>,
    instance: Readonly<WorkflowInstance>,
  ) => Record<string, unknown>;
  /** Optional scope-down. Omit to migrate every instance on `fromVersion` (needs `findInstanceUuids`). */
  instanceUuids?: readonly string[];
  /** Optional cap on how many candidates one call examines. Default: no cap. */
  limit?: number;
  /** Validate and report; write nothing and fire no observers. */
  dryRun?: boolean;
  /** Only instances whose current state is one of these. Must not be empty. */
  states?: readonly string[];
  /** Never instances whose current state is one of these. */
  excludeStates?: readonly string[];
  /** Resume paging strictly after this UUID (a previous result's `nextCursor`). Not with `instanceUuids`. */
  cursor?: string;
}

/** Result of `WorkflowRuntime.migrateInstances`. */
export interface MigrateInstancesResult {
  dryRun: boolean;
  /** In a dry run: the instances that would migrate. */
  migrated: Array<{ uuid: string; fromState: string; toState: string }>;
  skipped: Array<{ uuid: string; reason: string }>;
  failed: Array<{ uuid: string; error: string }>;
  /**
   * The last UUID examined when the call stopped at `limit` while paging; pass
   * it as `cursor` to continue. null when every candidate was examined, or
   * when `instanceUuids` was given.
   */
  nextCursor: string | null;
  /** Non-fatal problems, such as a target version that references commands or guards this process hasn't registered. */
  warnings: string[];
}
