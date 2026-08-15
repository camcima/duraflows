import { CallbackCondition, FinitaError, ProcessBuilder } from "@camcima/finita";
import type { ProcessInterface } from "@camcima/finita";
import type { WorkflowDefinition } from "../types/definition.js";
import { WorkflowDefinitionError } from "../errors/index.js";

export interface CompiledWorkflow {
  definition: WorkflowDefinition;
  process: ProcessInterface;
}

export class WorkflowCompiler {
  // Identity cache. The registry freezes each definition once at registration,
  // so the runtime's per-event compile() calls always arrive with the same
  // object and skip hashing entirely. WeakMap keeps definitions that were never
  // registered collectable.
  private readonly byIdentity = new WeakMap<WorkflowDefinition, CompiledWorkflow>();

  // Content cache. WorkflowCompiler is public API, so a caller outside the
  // registry may hand it a fresh-but-equal object on every call; identity
  // caching alone would recompile each time. Keyed by name so that a changed
  // definition reusing a name still invalidates.
  private readonly byName = new Map<string, { hash: string; compiled: CompiledWorkflow }>();

  compile(definition: WorkflowDefinition): CompiledWorkflow {
    const known = this.byIdentity.get(definition);
    if (known) {
      return known;
    }

    const hash = JSON.stringify(definition);
    const cached = this.byName.get(definition.name);
    if (cached && cached.hash === hash) {
      this.byIdentity.set(definition, cached.compiled);
      return cached.compiled;
    }

    const compiled = this.buildProcess(definition);
    this.byIdentity.set(definition, compiled);
    this.byName.set(definition.name, { hash, compiled });
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
          const target = eventDef.targetState;
          const error = eventDef.errorState;

          // When both branches lead to the same state, ProcessBuilder rejects
          // two transitions with identical (from, event, to) and conflicting
          // conditions. Register a single transition with a permissive
          // condition that matches either outcome — the executor still
          // distinguishes success vs failure for history and error semantics.
          if (target && error && target === error) {
            const anyOutcomeCondition = new CallbackCondition(
              `workflow:any:${stateName}:${eventName}`,
              (_subject: unknown, context: Map<string, unknown>) => {
                const outcome = context.get("workflow:eventOutcome");
                return outcome === "success" || outcome === "failure";
              },
            );
            builder.addTransition(stateName, target, {
              event: eventName,
              condition: anyOutcomeCondition,
            });
            continue;
          }

          if (target) {
            const successCondition = new CallbackCondition(
              `workflow:success:${stateName}:${eventName}`,
              (_subject: unknown, context: Map<string, unknown>) => context.get("workflow:eventOutcome") === "success",
            );
            builder.addTransition(stateName, target, {
              event: eventName,
              condition: successCondition,
            });
          }

          if (error) {
            const failureCondition = new CallbackCondition(
              `workflow:failure:${stateName}:${eventName}`,
              (_subject: unknown, context: Map<string, unknown>) => context.get("workflow:eventOutcome") === "failure",
            );
            builder.addTransition(stateName, error, {
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
