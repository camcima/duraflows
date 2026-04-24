import { State, Transition, Process, CallbackCondition } from "@camcima/finita";
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
    const stateNames = Object.keys(definition.states);
    const states = new Map<string, State>();

    // Create finita State for each workflow state
    for (const name of stateNames) {
      states.set(name, new State(name));
    }

    // Create transitions for each event
    for (const stateName of stateNames) {
      const stateDef = definition.states[stateName];
      if (!stateDef.events) continue;

      const sourceState = states.get(stateName)!;

      for (const [eventName, eventDef] of Object.entries(stateDef.events)) {
        if (eventDef.targetState) {
          const targetState = states.get(eventDef.targetState);
          if (!targetState) {
            throw new WorkflowDefinitionError(
              definition.name,
              `Target state "${eventDef.targetState}" referenced by event "${eventName}" on state "${stateName}" does not exist`,
            );
          }

          const successCondition = new CallbackCondition(
            `workflow:success:${stateName}:${eventName}`,
            (_subject: unknown, context: Map<string, unknown>) => context.get("workflow:eventOutcome") === "success",
          );

          const successTransition = new Transition(targetState, eventName, successCondition);
          sourceState.addTransition(successTransition);
        }

        if (eventDef.errorState) {
          const errorState = states.get(eventDef.errorState);
          if (!errorState) {
            throw new WorkflowDefinitionError(
              definition.name,
              `Error state "${eventDef.errorState}" referenced by event "${eventName}" on state "${stateName}" does not exist`,
            );
          }

          const failureCondition = new CallbackCondition(
            `workflow:failure:${stateName}:${eventName}`,
            (_subject: unknown, context: Map<string, unknown>) => context.get("workflow:eventOutcome") === "failure",
          );

          const failureTransition = new Transition(errorState, eventName, failureCondition);
          sourceState.addTransition(failureTransition);
        }
      }
    }

    // Register onEnter target/error states in the finita graph via never-matching
    // transitions so that states reachable only through onEnter hops are known
    // to the Process (finita only auto-registers states reachable via transitions
    // from the initial state).
    for (const stateName of stateNames) {
      const stateDef = definition.states[stateName];
      const onEnter = stateDef.onEnter;
      if (!onEnter) continue;

      const sourceState = states.get(stateName)!;

      if (onEnter.targetState) {
        const targetState = states.get(onEnter.targetState);
        if (targetState) {
          const neverCondition = new CallbackCondition(`workflow:onEnter:${stateName}`, () => false);
          sourceState.addTransition(new Transition(targetState, null, neverCondition));
        }
      }

      if (onEnter.errorState) {
        const errorState = states.get(onEnter.errorState);
        if (errorState) {
          const neverCondition = new CallbackCondition(`workflow:onEnter:error:${stateName}`, () => false);
          sourceState.addTransition(new Transition(errorState, null, neverCondition));
        }
      }
    }

    const initialState = states.get(definition.initialState);
    if (!initialState) {
      throw new WorkflowDefinitionError(definition.name, `Initial state "${definition.initialState}" does not exist`);
    }

    const process = new Process(definition.name, initialState);

    return { definition, process };
  }
}
