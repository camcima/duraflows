import type { ObserverErrorHandler, StateEnterEvent, WorkflowObserver } from "../types/observer.js";

const defaultObserverErrorHandler: ObserverErrorHandler = (error, observer, event) => {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(
    `[duraflows] observer "${observer.name}" failed on onEnter for instance ${event.instanceUuid}: ${message}`,
  );
};

export class ObserverRegistry {
  private readonly observers: WorkflowObserver[];
  private readonly onError: ObserverErrorHandler;

  constructor(initial: readonly WorkflowObserver[] = [], onError?: ObserverErrorHandler) {
    this.observers = [...initial];
    this.onError = onError ?? defaultObserverErrorHandler;
  }

  add(observer: WorkflowObserver): void {
    this.observers.push(observer);
  }

  list(): readonly WorkflowObserver[] {
    return this.observers;
  }

  async fireOnEnter(event: StateEnterEvent): Promise<void> {
    for (const observer of this.observers) {
      if (!observer.onEnter) continue;
      try {
        await observer.onEnter(event);
      } catch (error: unknown) {
        try {
          this.onError(error, { name: observer.name }, event);
        } catch (handlerError: unknown) {
          // The error handler must never break the containment boundary:
          // fall back to the default handler and keep firing observers.
          defaultObserverErrorHandler(error, { name: observer.name }, event);
          const message = handlerError instanceof Error ? handlerError.message : String(handlerError);
          console.warn(`[duraflows] onObserverError handler threw while handling the error above: ${message}`);
        }
      }
    }
  }
}
