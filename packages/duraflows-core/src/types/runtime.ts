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

export interface WorkflowInstance<TState extends string = string> {
  uuid: string;
  workflowName: string;
  currentState: TState;
  version: number;
  expiresAt: Date | null;
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
}

export interface ProcessExpiredWorkflowsInput {
  limit?: number;
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
  /** Infrastructure failures: the per-instance transaction rolled back. */
  failed: Array<{ uuid: string; error: string }>;
}

export interface GetAvailableEventsInput {
  workflowInstanceUuid: string;
}
