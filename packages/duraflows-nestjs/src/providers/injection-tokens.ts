export const WORKFLOW_RUNTIME = Symbol("WORKFLOW_RUNTIME");
export const WORKFLOW_INSTANCE_STORE = Symbol("WORKFLOW_INSTANCE_STORE");
export const WORKFLOW_HISTORY_STORE = Symbol("WORKFLOW_HISTORY_STORE");
export const WORKFLOW_COMMAND_REGISTRY = Symbol("WORKFLOW_COMMAND_REGISTRY");
export const WORKFLOW_DEFINITION_REGISTRY = Symbol("WORKFLOW_DEFINITION_REGISTRY");
export const WORKFLOW_TRANSACTION_RUNNER = Symbol("WORKFLOW_TRANSACTION_RUNNER");
export const WORKFLOW_CLOCK = Symbol("WORKFLOW_CLOCK");
export const WORKFLOW_GUARD_REGISTRY = Symbol("WORKFLOW_GUARD_REGISTRY");

/**
 * The resolved module configuration. Deliberately not re-exported from the
 * package barrel: it exists so `forRoot` and `forRootAsync` can publish their
 * config under one token and share a single provider graph, not as a supported
 * extension point.
 */
export const WORKFLOW_MODULE_OPTIONS = Symbol("WORKFLOW_MODULE_OPTIONS");
