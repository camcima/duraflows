export interface StateEnterEvent {
  readonly workflowName: string;
  readonly instanceUuid: string;
  readonly state: string;
  readonly fromState: string | null;
  readonly toState: string;
  readonly transitionUuid: string;
  readonly triggerEvent: string | null;
  readonly context: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly triggerMetadata: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
}

export interface WorkflowObserver {
  readonly name: string;
  onEnter?(event: StateEnterEvent): void | Promise<void>;
}

export type ObserverErrorHandler = (
  error: unknown,
  observer: { readonly name: string },
  event: StateEnterEvent,
) => void | Promise<void>;
