import { randomUUID } from "node:crypto";
import type { WorkflowDefinition } from "../types/definition.js";
import type { CommandResult, WorkflowExecutionContext } from "../types/runtime.js";
import type { CommandExecutor } from "./command-executor.js";
import { CommandFailureError, OnEnterDepthExceededError } from "../errors/index.js";

export interface OnEnterHopResult {
  fromState: string;
  toState: string;
  transitionUuid: string;
  outcome: "success" | "failure";
  commandResults: CommandResult[];
}

export interface OnEnterChainResult {
  finalState: string;
  outcome: "success" | "failure";
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
    let predecessor: string | null = context.fromState;
    let chainOutcome: "success" | "failure" = "success";

    while (true) {
      const stateDef = definition.states[currentState];
      if (!stateDef?.onEnter) break;

      depth++;
      if (depth > maxDepth) {
        throw new OnEnterDepthExceededError(instanceUuid, currentState, maxDepth);
      }

      const onEnter = stateDef.onEnter;
      const fromState = currentState;

      const hopContext: WorkflowExecutionContext = {
        ...context,
        fromState: predecessor,
        toState: currentState,
        transitionUuid: randomUUID(),
      };
      const hopTransitionUuid = hopContext.transitionUuid;

      const commands = onEnter.commands ?? [];
      const commandExecResult = await this.commandExecutor.execute(commands, subject, hopContext);

      const outcome = commandExecResult.outcome;

      if (outcome === "failure") {
        if (onEnter.errorState) {
          hops.push({
            fromState,
            toState: onEnter.errorState,
            transitionUuid: hopTransitionUuid,
            outcome: "failure",
            commandResults: commandExecResult.commandResults,
          });
          chainOutcome = "failure";
          predecessor = currentState;
          currentState = onEnter.errorState;
          continue;
        }
        const failedResult = commandExecResult.commandResults[commandExecResult.commandResults.length - 1];
        const failedCommandName = commands[commandExecResult.commandResults.length - 1].name;
        throw new CommandFailureError(instanceUuid, "onEnter", failedCommandName, failedResult);
      }

      if (onEnter.targetState) {
        hops.push({
          fromState,
          toState: onEnter.targetState,
          transitionUuid: hopTransitionUuid,
          outcome: "success",
          commandResults: commandExecResult.commandResults,
        });
        predecessor = currentState;
        currentState = onEnter.targetState;
        continue;
      }

      if (commandExecResult.commandResults.length > 0) {
        hops.push({
          fromState,
          toState: currentState,
          transitionUuid: hopTransitionUuid,
          outcome: "success",
          commandResults: commandExecResult.commandResults,
        });
      }
      break;
    }

    return { finalState: currentState, outcome: chainOutcome, hops };
  }
}
