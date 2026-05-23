export interface WorkflowDefinition<TState extends string = string> {
  name: string;
  initialState: TState;
  states: Record<TState, WorkflowStateDefinition<TState>>;
}

export interface WorkflowStateDefinition<TState extends string = string> {
  context?: Record<string, unknown>;
  events?: Record<string, WorkflowEventDefinition<TState>>;
  onEnter?: WorkflowOnEnterDefinition<TState>;
  metadata?: Record<string, unknown>;
}

export interface WorkflowOnEnterDefinition<TState extends string = string> {
  targetState?: TState;
  errorState?: TState;
  commands?: WorkflowCommandRef[];
  metadata?: Record<string, unknown>;
}

export interface WorkflowEventDefinition<TState extends string = string> {
  guard?: WorkflowGuardRef;
  targetState?: TState;
  errorState?: TState;
  commands?: WorkflowCommandRef[];
  timeout?: WorkflowTimeoutDefinition;
  metadata?: Record<string, unknown>;
}

export interface WorkflowCommandRef {
  name: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowGuardRef {
  name: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowTimeoutDefinition {
  afterMinutes?: number;
  afterHours?: number;
  afterDays?: number;
}
