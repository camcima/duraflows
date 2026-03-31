import type {
  WorkflowDefinition,
  WorkflowStateDefinition,
  WorkflowEventDefinition,
  WorkflowOnEnterDefinition,
  WorkflowTimeoutDefinition,
} from "../types/definition.js";

export interface MermaidDiagramOptions {
  /** Include command names on transition labels. Default: false */
  showCommands?: boolean;
  /** Include timeout durations on transition labels. Default: true */
  showTimeouts?: boolean;
  /** Show onEnter auto-transitions. Default: true */
  showOnEnter?: boolean;
  /** Mark terminal states with [*] end nodes. Default: true */
  showTerminalStates?: boolean;
  /** Diagram direction: "TB" (top-to-bottom) or "LR" (left-to-right). Default: "TB" */
  direction?: "TB" | "LR";
}

const INDENT = "    ";

export function toMermaidDiagram(definition: WorkflowDefinition, options?: MermaidDiagramOptions): string {
  const opts: Required<MermaidDiagramOptions> = {
    showCommands: false,
    showTimeouts: true,
    showOnEnter: true,
    showTerminalStates: true,
    direction: "TB",
    ...options,
  };

  const lines: string[] = [];

  // Header
  lines.push("stateDiagram-v2");
  if (opts.direction !== "TB") {
    lines.push(`${INDENT}direction ${opts.direction}`);
  }
  lines.push("");

  // Initial state
  lines.push(`${INDENT}[*] --> ${definition.initialState}`);
  lines.push("");

  // State transitions
  for (const [stateName, stateDef] of Object.entries(definition.states)) {
    const stateLines: string[] = [];

    // onEnter transitions (fire first at runtime, listed first)
    if (opts.showOnEnter && stateDef.onEnter) {
      if (stateDef.onEnter.targetState) {
        const label = formatOnEnterLabel(stateDef.onEnter, opts, false);
        stateLines.push(`${INDENT}${stateName} --> ${stateDef.onEnter.targetState} : ${label}`);
      }
      if (stateDef.onEnter.errorState) {
        const label = formatOnEnterLabel(stateDef.onEnter, opts, true);
        stateLines.push(`${INDENT}${stateName} --> ${stateDef.onEnter.errorState} : ${label}`);
      }
    }

    // Event transitions
    if (stateDef.events) {
      for (const [eventName, eventDef] of Object.entries(stateDef.events)) {
        if (eventDef.targetState) {
          const label = formatEventLabel(eventName, eventDef, opts, false);
          stateLines.push(`${INDENT}${stateName} --> ${eventDef.targetState} : ${label}`);
        }
        if (eventDef.errorState) {
          const label = formatEventLabel(eventName, eventDef, opts, true);
          stateLines.push(`${INDENT}${stateName} --> ${eventDef.errorState} : ${label}`);
        }
      }
    }

    if (stateLines.length > 0) {
      lines.push(...stateLines);
      lines.push("");
    }
  }

  // Terminal states
  if (opts.showTerminalStates) {
    const terminals: string[] = [];
    for (const [stateName, stateDef] of Object.entries(definition.states)) {
      if (isTerminalState(stateDef)) {
        terminals.push(stateName);
      }
    }
    if (terminals.length > 0) {
      for (const terminal of terminals) {
        lines.push(`${INDENT}${terminal} --> [*]`);
      }
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}

function formatEventLabel(
  eventName: string,
  eventDef: WorkflowEventDefinition,
  opts: Required<MermaidDiagramOptions>,
  isError: boolean,
): string {
  let label = eventName;

  if (opts.showTimeouts && eventDef.timeout) {
    label += ` (${formatTimeout(eventDef.timeout)})`;
  }

  if (isError) {
    label += " [error]";
  }

  if (opts.showCommands && eventDef.commands && eventDef.commands.length > 0) {
    const cmdNames = eventDef.commands.map((c) => c.name).join(", ");
    label += `<br/>${cmdNames}`;
  }

  return label;
}

function formatOnEnterLabel(
  onEnterDef: WorkflowOnEnterDefinition,
  opts: Required<MermaidDiagramOptions>,
  isError: boolean,
): string {
  let label = "&#171;auto&#187;";

  if (isError) {
    label += " [error]";
  }

  if (opts.showCommands && onEnterDef.commands && onEnterDef.commands.length > 0) {
    const cmdNames = onEnterDef.commands.map((c) => c.name).join(", ");
    label += `<br/>${cmdNames}`;
  }

  return label;
}

function formatTimeout(timeout: WorkflowTimeoutDefinition): string {
  const parts: string[] = [];
  if (timeout.afterDays) {
    parts.push(`${timeout.afterDays}d`);
  }
  if (timeout.afterHours) {
    parts.push(`${timeout.afterHours}h`);
  }
  if (timeout.afterMinutes) {
    parts.push(`${timeout.afterMinutes}m`);
  }
  return parts.join(" ");
}

function isTerminalState(stateDef: WorkflowStateDefinition): boolean {
  const hasEvents = stateDef.events && Object.keys(stateDef.events).length > 0;
  const hasOnEnterTarget = stateDef.onEnter?.targetState != null;
  return !hasEvents && !hasOnEnterTarget;
}
