import type { WorkflowDefinition, WorkflowTimeoutDefinition } from "../types/definition.js";

export class TimeoutResolver {
  computeDeadline(definition: WorkflowDefinition, stateName: string, now: Date): Date | null {
    const timeout = this.findTimeout(definition, stateName);
    if (!timeout) return null;

    const totalMs = this.computeTotalMs(timeout);
    if (totalMs <= 0) return null;

    return new Date(now.getTime() + totalMs);
  }

  getTimeoutEventName(definition: WorkflowDefinition, stateName: string): string | null {
    const stateDef = definition.states[stateName];
    if (!stateDef?.events) return null;

    for (const [eventName, eventDef] of Object.entries(stateDef.events)) {
      if (eventDef.timeout) return eventName;
    }
    return null;
  }

  private findTimeout(definition: WorkflowDefinition, stateName: string): WorkflowTimeoutDefinition | null {
    const stateDef = definition.states[stateName];
    if (!stateDef?.events) return null;

    for (const eventDef of Object.values(stateDef.events)) {
      if (eventDef.timeout) return eventDef.timeout;
    }
    return null;
  }

  private computeTotalMs(timeout: WorkflowTimeoutDefinition): number {
    let total = 0;
    if (timeout.afterMinutes) total += timeout.afterMinutes * 60_000;
    if (timeout.afterHours) total += timeout.afterHours * 3_600_000;
    if (timeout.afterDays) total += timeout.afterDays * 86_400_000;
    return total;
  }
}
