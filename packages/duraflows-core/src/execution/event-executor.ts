import { Statemachine } from "@camcima/finita";
import type { WorkflowEventDefinition } from "../types/definition.js";
import type { CommandResult, WorkflowExecutionContext } from "../types/runtime.js";
import type { CompiledWorkflow } from "../compilation/workflow-compiler.js";
import type { CommandExecutor } from "./command-executor.js";
import type { WorkflowGuardRegistry } from "../registry/guard-registry.js";
import { InvalidEventError, CommandFailureError } from "../errors/index.js";

export interface EventExecutionResult {
  outcome: "success" | "failure" | "guard-rejected";
  fromState: string;
  toState: string;
  commandResults: CommandResult[];
  rejectedBy?: string;
}

function deepFreeze<T extends Record<string, unknown>>(obj: T): Readonly<T> {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value as Record<string, unknown>);
    }
  }
  return obj;
}

export class EventExecutor {
  constructor(
    private readonly commandExecutor: CommandExecutor,
    private readonly guardRegistry?: WorkflowGuardRegistry,
  ) {}

  async execute(
    compiledWorkflow: CompiledWorkflow,
    currentState: string,
    eventName: string,
    instanceUuid: string,
    subject: unknown,
    context: WorkflowExecutionContext,
  ): Promise<EventExecutionResult> {
    const definition = compiledWorkflow.definition;
    const stateDef = definition.states[currentState];

    if (!stateDef?.events?.[eventName]) {
      throw new InvalidEventError(instanceUuid, currentState, eventName);
    }

    const eventDef: WorkflowEventDefinition = stateDef.events[eventName];
    const fromState = currentState;

    // Evaluate guard before any side effects.
    if (eventDef.guard) {
      if (!this.guardRegistry) {
        throw new Error(
          `Event "${eventName}" on state "${currentState}" declares guard "${eventDef.guard.name}" but no guard registry is configured`,
        );
      }
      const guard = this.guardRegistry.get(eventDef.guard.name);
      const guardContext: WorkflowExecutionContext = {
        ...context,
        commandMetadata: deepFreeze(structuredClone(eventDef.guard.metadata ?? {})),
      };
      const passed = await guard.evaluate(subject, guardContext);
      if (!passed) {
        return {
          outcome: "guard-rejected",
          fromState,
          toState: fromState,
          commandResults: [],
          rejectedBy: guard.name,
        };
      }
    }

    // Execute commands (if any)
    const commands = eventDef.commands ?? [];
    const commandExecResult = await this.commandExecutor.execute(commands, subject, context);

    const outcome = commandExecResult.outcome;

    // If failure and no errorState defined, throw CommandFailureError
    if (outcome === "failure" && !eventDef.errorState) {
      const failedResult = commandExecResult.commandResults[commandExecResult.commandResults.length - 1];
      const failedCommandName = commands[commandExecResult.commandResults.length - 1].name;
      throw new CommandFailureError(instanceUuid, eventName, failedCommandName, failedResult);
    }

    // Determine target state. For command-only events (no targetState, no errorState),
    // no transitions are registered in finita — skip the statemachine call and stay in place.
    let toState: string;

    if (!eventDef.targetState && !eventDef.errorState) {
      toState = fromState;
    } else {
      const finitaContext = new Map<string, unknown>();
      finitaContext.set("workflow:eventOutcome", outcome);

      const statemachine = new Statemachine(subject, compiledWorkflow.process, currentState);

      await statemachine.triggerEvent(eventName, finitaContext);

      toState = statemachine.getCurrentState().getName();
    }

    return {
      outcome,
      fromState,
      toState,
      commandResults: commandExecResult.commandResults,
    };
  }
}
