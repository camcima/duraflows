import type { WorkflowDefinition, WorkflowTimeoutDefinition } from "../types/definition.js";

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface WorkflowValidationOptions {
  knownCommandNames?: Set<string>;
  knownGuardNames?: Set<string>;
}

export class WorkflowValidator {
  validate(definition: WorkflowDefinition, options?: WorkflowValidationOptions): ValidationResult {
    const errors: ValidationError[] = [];

    if (!definition.name || definition.name.trim() === "") {
      errors.push({ path: "name", message: "Workflow name must be non-empty" });
    }

    const stateNames = Object.keys(definition.states);
    if (stateNames.length === 0) {
      errors.push({ path: "states", message: "Workflow must have at least one state" });
    }

    if (!definition.states[definition.initialState]) {
      errors.push({
        path: "initialState",
        message: `Initial state "${definition.initialState}" does not exist in states`,
      });
    }

    for (const stateName of stateNames) {
      const state = definition.states[stateName];

      // Validate onEnter
      if (state.onEnter) {
        const onEnterPath = `states.${stateName}.onEnter`;

        if (state.onEnter.targetState && !definition.states[state.onEnter.targetState]) {
          errors.push({
            path: `${onEnterPath}.targetState`,
            message: `Target state "${state.onEnter.targetState}" does not exist in states`,
          });
        }

        if (state.onEnter.errorState && !definition.states[state.onEnter.errorState]) {
          errors.push({
            path: `${onEnterPath}.errorState`,
            message: `Error state "${state.onEnter.errorState}" does not exist in states`,
          });
        }

        if (state.onEnter.commands && options?.knownCommandNames) {
          for (let i = 0; i < state.onEnter.commands.length; i++) {
            const cmdRef = state.onEnter.commands[i];
            if (!options.knownCommandNames.has(cmdRef.name)) {
              errors.push({
                path: `${onEnterPath}.commands[${i}]`,
                message: `Command "${cmdRef.name}" is not registered`,
              });
            }
          }
        }
      }

      if (!state.events) continue;

      let timeoutCount = 0;
      const eventNames = Object.keys(state.events);

      for (const eventName of eventNames) {
        const event = state.events[eventName];
        const eventPath = `states.${stateName}.events.${eventName}`;

        // An event must do something: transition state, route on error, or run commands.
        // A completely empty event is a declarative no-op and is rejected.
        if (!event.targetState && !event.errorState && (!event.commands || event.commands.length === 0)) {
          errors.push({
            path: eventPath,
            message: "Event must define at least one of: targetState, errorState, or commands",
          });
        }

        if (event.targetState && !definition.states[event.targetState]) {
          errors.push({
            path: `${eventPath}.targetState`,
            message: `Target state "${event.targetState}" does not exist in states`,
          });
        }

        if (event.errorState && !definition.states[event.errorState]) {
          errors.push({
            path: `${eventPath}.errorState`,
            message: `Error state "${event.errorState}" does not exist in states`,
          });
        }

        if (event.commands && options?.knownCommandNames) {
          for (let i = 0; i < event.commands.length; i++) {
            const cmdRef = event.commands[i];
            if (!options.knownCommandNames.has(cmdRef.name)) {
              errors.push({
                path: `${eventPath}.commands[${i}]`,
                message: `Command "${cmdRef.name}" is not registered`,
              });
            }
          }
        }

        if (event.guard && options?.knownGuardNames) {
          if (!options.knownGuardNames.has(event.guard.name)) {
            errors.push({
              path: `${eventPath}.guard`,
              message: `Guard "${event.guard.name}" is not registered`,
            });
          }
        }

        if (event.timeout) {
          timeoutCount++;
          const timeoutErrors = this.validateTimeout(event.timeout, `${eventPath}.timeout`);
          errors.push(...timeoutErrors);
        }
      }

      if (timeoutCount > 1) {
        errors.push({
          path: `states.${stateName}`,
          message: "At most one event per state may define a timeout",
        });
      }
    }

    // Validate onEnter cycles
    this.validateOnEnterCycles(definition, errors);

    return { valid: errors.length === 0, errors };
  }

  private validateOnEnterCycles(definition: WorkflowDefinition, errors: ValidationError[]): void {
    // Build adjacency list from onEnter targetState and errorState edges
    const edges = new Map<string, string[]>();
    for (const [stateName, state] of Object.entries(definition.states)) {
      if (!state.onEnter) continue;
      const targets: string[] = [];
      if (state.onEnter.targetState) targets.push(state.onEnter.targetState);
      if (state.onEnter.errorState) targets.push(state.onEnter.errorState);
      if (targets.length > 0) edges.set(stateName, targets);
    }

    // DFS cycle detection with path tracking
    const visited = new Set<string>();
    const inStack = new Set<string>();

    const dfs = (node: string, path: string[]): string[] | null => {
      if (inStack.has(node)) {
        // Found cycle — extract the cycle from the path
        const cycleStart = path.indexOf(node);
        return [...path.slice(cycleStart), node];
      }
      if (visited.has(node)) return null;

      visited.add(node);
      inStack.add(node);
      path.push(node);

      const neighbors = edges.get(node) ?? [];
      for (const neighbor of neighbors) {
        const cycle = dfs(neighbor, path);
        if (cycle) return cycle;
      }

      path.pop();
      inStack.delete(node);
      return null;
    };

    for (const startNode of edges.keys()) {
      if (visited.has(startNode)) continue;
      const cycle = dfs(startNode, []);
      if (cycle) {
        errors.push({
          path: "states",
          message: `Cycle detected in onEnter chain: ${cycle.join(" -> ")}`,
        });
        return; // Report first cycle only
      }
    }
  }

  private validateTimeout(timeout: WorkflowTimeoutDefinition, path: string): ValidationError[] {
    const errors: ValidationError[] = [];
    const fields: (keyof WorkflowTimeoutDefinition)[] = ["afterMinutes", "afterHours", "afterDays"];

    let hasField = false;
    for (const field of fields) {
      const value = timeout[field];
      if (value !== undefined) {
        hasField = true;
        if (typeof value !== "number" || value <= 0) {
          errors.push({
            path: `${path}.${field}`,
            message: `Timeout field "${field}" must be a positive number`,
          });
        }
      }
    }

    if (!hasField) {
      errors.push({
        path,
        message: "Timeout must define at least one duration field",
      });
    }

    return errors;
  }
}
