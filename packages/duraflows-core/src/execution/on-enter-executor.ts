import type { WorkflowDefinition } from "../types/definition.js";
import type { CommandResult, WorkflowExecutionContext } from "../types/runtime.js";
import type { CommandExecutor } from "./command-executor.js";
import { CommandFailureError, OnEnterDepthExceededError } from "../errors/index.js";

export interface OnEnterHopResult {
  fromState: string;
  toState: string;
  outcome: "success" | "failure";
  commandResults: CommandResult[];
}

export interface OnEnterChainResult {
  finalState: string;
  hops: OnEnterHopResult[];
}

export class OnEnterExecutor {
  constructor(private readonly commandExecutor: CommandExecutor) {}

  async executeChain(
    definition: WorkflowDefinition,
    startingState: string,
    instanceUuid: string,
    subject: unknown,
    context: WorkflowExecutionContext,
    maxDepth: number,
  ): Promise<OnEnterChainResult> {
    const hops: OnEnterHopResult[] = [];
    let currentState = startingState;
    let depth = 0;

    while (true) {
      const stateDef = definition.states[currentState];
      if (!stateDef?.onEnter) break;

      depth++;
      if (depth > maxDepth) {
        throw new OnEnterDepthExceededError(instanceUuid, currentState, maxDepth);
      }

      const onEnter = stateDef.onEnter;
      const fromState = currentState;

      // Execute commands (if any)
      const commands = onEnter.commands ?? [];
      const commandExecResult = await this.commandExecutor.execute(
        commands,
        subject,
        context,
      );

      const outcome = commandExecResult.outcome;

      if (outcome === "failure") {
        if (onEnter.errorState) {
          // Transition to error state
          hops.push({
            fromState,
            toState: onEnter.errorState,
            outcome: "failure",
            commandResults: commandExecResult.commandResults,
          });
          currentState = onEnter.errorState;
          continue;
        }
        // No errorState — throw CommandFailureError (same as EventExecutor)
        const failedResult = commandExecResult.commandResults[
          commandExecResult.commandResults.length - 1
        ];
        const failedCommandName = commands[commandExecResult.commandResults.length - 1].name;
        throw new CommandFailureError(
          instanceUuid,
          "onEnter",
          failedCommandName,
          failedResult,
        );
      }

      // Success
      if (onEnter.targetState) {
        hops.push({
          fromState,
          toState: onEnter.targetState,
          outcome: "success",
          commandResults: commandExecResult.commandResults,
        });
        currentState = onEnter.targetState;
        continue;
      }

      // No targetState — commands ran, stay in current state
      if (commandExecResult.commandResults.length > 0) {
        hops.push({
          fromState,
          toState: currentState,
          outcome: "success",
          commandResults: commandExecResult.commandResults,
        });
      }
      break;
    }

    return { finalState: currentState, hops };
  }
}
