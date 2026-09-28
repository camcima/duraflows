export interface WorkflowDefinition<TState extends string = string> {
  name: string;
  /**
   * Explicit definition version. Defaults to 1 when omitted. Must be a
   * positive safe integer. Bump it whenever the definition's content changes;
   * `WorkflowRuntime.initialize()` enforces this against the definition store.
   */
  version?: number;
  /**
   * Which definition governs existing instances. `"pinned"` (the default):
   * each instance executes the version it was stamped with, loaded from the
   * definition store. `"latest"`: every instance executes this definition,
   * and one whose current state it lacks fails with
   * `IncompatibleDefinitionError`. The latest registered definition's policy
   * governs all instances of the workflow. Excluded from the content hash.
   */
  versionPolicy?: "pinned" | "latest";
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
