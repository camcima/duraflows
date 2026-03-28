import { Statemachine } from "@camcima/finita";
import type { WorkflowEventDefinition } from "../types/definition.js";
import type { CommandResult, WorkflowExecutionContext } from "../types/runtime.js";
import type { CompiledWorkflow } from "../compilation/workflow-compiler.js";
import type { CommandExecutor } from "./command-executor.js";
import { InvalidEventError, CommandFailureError } from "../errors/index.js";

export interface EventExecutionResult {
  outcome: "success" | "failure";
  fromState: string;
  toState: string;
  commandResults: CommandResult[];
}

export class EventExecutor {
  constructor(private readonly commandExecutor: CommandExecutor) {}

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

    // Execute commands (if any)
    const commands = eventDef.commands ?? [];
    const commandExecResult = await this.commandExecutor.execute(
      commands,
      subject,
      context,
    );

    const outcome = commandExecResult.outcome;

    // If failure and no errorState defined, throw CommandFailureError
    if (outcome === "failure" && !eventDef.errorState) {
      const failedResult = commandExecResult.commandResults[
        commandExecResult.commandResults.length - 1
      ];
      const failedCommandName = commands[commandExecResult.commandResults.length - 1].name;
      throw new CommandFailureError(
        instanceUuid,
        eventName,
        failedCommandName,
        failedResult,
      );
    }

    // Build finita context and trigger event
    const finitaContext = new Map<string, unknown>();
    finitaContext.set("workflow:eventOutcome", outcome);

    const statemachine = new Statemachine(
      subject,
      compiledWorkflow.process,
      currentState,
    );

    await statemachine.triggerEvent(eventName, finitaContext);

    const toState = statemachine.getCurrentState().getName();

    return {
      outcome,
      fromState,
      toState,
      commandResults: commandExecResult.commandResults,
    };
  }
}
