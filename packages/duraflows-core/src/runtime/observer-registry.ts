import type { StateEnterEvent, WorkflowObserver } from "../types/observer.js";

export class ObserverRegistry {
  private readonly observers: WorkflowObserver[];

  constructor(initial: readonly WorkflowObserver[] = []) {
    this.observers = [...initial];
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
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[duraflows] observer "${observer.name}" failed on onEnter for instance ${event.instanceUuid}: ${message}`,
        );
      }
    }
  }
}
