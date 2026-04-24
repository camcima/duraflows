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
  now: Date;
  context: Record<string, unknown>;
  metadata: Readonly<Record<string, unknown>>;
  readonly fromState: string | null;
  readonly toState: string;
  readonly transitionUuid: string;
}

export interface WorkflowInstance {
  uuid: string;
  workflowName: string;
  currentState: string;
  version: number;
  expiresAt: Date | null;
  lastTransitionAt: Date;
  context: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowExecutionResult {
  outcome: "success" | "failure";
  fromState: string;
  toState: string;
  commandResults: CommandResult[];
  historyUuid: string;
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
  failed: Array<{ uuid: string; error: string }>;
}

export interface GetAvailableEventsInput {
  workflowInstanceUuid: string;
}
