import { CallbackCondition, FinitaError, ProcessBuilder } from "@camcima/finita";
import type { ProcessInterface } from "@camcima/finita";
import type { WorkflowDefinition } from "../types/definition.js";
import { WorkflowDefinitionError } from "../errors/index.js";

export interface CompiledWorkflow {
  definition: WorkflowDefinition;
  process: ProcessInterface;
}

export class WorkflowCompiler {
  private readonly cache = new Map<string, { hash: string; compiled: CompiledWorkflow }>();

  compile(definition: WorkflowDefinition): CompiledWorkflow {
    const hash = JSON.stringify(definition);
    const cached = this.cache.get(definition.name);
    if (cached && cached.hash === hash) {
      return cached.compiled;
    }

    const compiled = this.buildProcess(definition);
    this.cache.set(definition.name, { hash, compiled });
    return compiled;
  }

  private buildProcess(definition: WorkflowDefinition): CompiledWorkflow {
    try {
      const builder = new ProcessBuilder(definition.name);

      // Register every state in the definition. ProcessBuilder requires explicit
      // declaration; states reachable only via runtime onEnter chains (which
      // duraflows handles outside the FSM) would otherwise be missing.
      for (const stateName of Object.keys(definition.states)) {
        builder.addState(stateName, { initial: stateName === definition.initialState });
      }

      // Declare event-driven transitions. Each event with a targetState gets a
      // success-guarded transition; each with an errorState gets a failure-guarded
      // one. The condition reads the per-call outcome that EventExecutor stuffs
      // into the finita context map under "workflow:eventOutcome".
      for (const [stateName, stateDef] of Object.entries(definition.states)) {
        if (!stateDef.events) continue;

        for (const [eventName, eventDef] of Object.entries(stateDef.events)) {
          if (eventDef.targetState) {
            const successCondition = new CallbackCondition(
              `workflow:success:${stateName}:${eventName}`,
              (_subject: unknown, context: Map<string, unknown>) => context.get("workflow:eventOutcome") === "success",
            );
            builder.addTransition(stateName, eventDef.targetState, {
              event: eventName,
              condition: successCondition,
            });
          }

          if (eventDef.errorState) {
            const failureCondition = new CallbackCondition(
              `workflow:failure:${stateName}:${eventName}`,
              (_subject: unknown, context: Map<string, unknown>) => context.get("workflow:eventOutcome") === "failure",
            );
            builder.addTransition(stateName, eventDef.errorState, {
              event: eventName,
              condition: failureCondition,
            });
          }
        }
      }

      const process = builder.build();
      return { definition, process };
    } catch (err: unknown) {
      if (err instanceof FinitaError) {
        throw new WorkflowDefinitionError(definition.name, err.message);
      }
      throw err;
    }
  }
}
