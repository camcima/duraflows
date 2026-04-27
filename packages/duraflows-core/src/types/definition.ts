export interface WorkflowDefinition {
  name: string;
  initialState: string;
  states: Record<string, WorkflowStateDefinition>;
}

export interface WorkflowStateDefinition {
  context?: Record<string, unknown>;
  events?: Record<string, WorkflowEventDefinition>;
  onEnter?: WorkflowOnEnterDefinition;
  metadata?: Record<string, unknown>;
}

export interface WorkflowOnEnterDefinition {
  targetState?: string;
  errorState?: string;
  commands?: WorkflowCommandRef[];
  metadata?: Record<string, unknown>;
}

export interface WorkflowEventDefinition {
  guard?: WorkflowGuardRef;
  targetState?: string;
  errorState?: string;
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
