import type {
  WorkflowDefinition,
  WorkflowStateDefinition,
  WorkflowEventDefinition,
  WorkflowOnEnterDefinition,
  WorkflowTimeoutDefinition,
} from "../types/definition.js";

export interface MermaidDiagramOptions {
  /** Include command names on event nodes. Default: false */
  showCommands?: boolean;
  /** Diagram direction: "TB" (top-to-bottom) or "LR" (left-to-right). Default: "TB" */
  direction?: "TB" | "LR";
}

const INDENT = "    ";

export function toMermaidDiagram(definition: WorkflowDefinition, options?: MermaidDiagramOptions): string {
  const opts: Required<MermaidDiagramOptions> = {
    showCommands: false,
    direction: "TB",
    ...options,
  };

  const lines: string[] = [];
  const plainEdgeIndices: number[] = [];
  const successEdgeIndices: number[] = [];
  const errorEdgeIndices: number[] = [];
  let edgeIndex = 0;

  // Header
  lines.push(`flowchart ${opts.direction}`);
  lines.push("");

  // Class definitions
  lines.push(`${INDENT}classDef stateNode fill:#f1f5f9,stroke:#64748b,stroke-width:2px,color:#1e293b,font-size:20px`);
  lines.push("");

  // State node definitions
  lines.push(`${INDENT}_start@{ shape: sm-circ }`);
  for (const stateName of Object.keys(definition.states)) {
    lines.push(`${INDENT}${stateName}["<b>${stateName}</b>"]:::stateNode`);
  }
  const hasTerminals = Object.values(definition.states).some((sd) => isTerminalState(sd));
  if (hasTerminals) {
    lines.push(`${INDENT}_end@{ shape: framed-circle }`);
  }
  lines.push("");

  // Start edge
  lines.push(`${INDENT}_start --> ${definition.initialState}`);
  plainEdgeIndices.push(edgeIndex);
  edgeIndex++;
  lines.push("");

  // State transitions
  for (const [stateName, stateDef] of Object.entries(definition.states)) {
    const stateLines: string[] = [];

    // onEnter
    if (stateDef.onEnter && (stateDef.onEnter.targetState || stateDef.onEnter.errorState)) {
      const nodeId = `${stateName}__onEnter`;
      const label = formatOnEnterNodeLabel(stateDef.onEnter, opts);
      stateLines.push(`${INDENT}${nodeId}${label}`);
      stateLines.push(`${INDENT}${stateName} --> ${nodeId}`);
      plainEdgeIndices.push(edgeIndex);
      edgeIndex++;
      if (stateDef.onEnter.targetState) {
        stateLines.push(`${INDENT}${nodeId} --> ${stateDef.onEnter.targetState}`);
        successEdgeIndices.push(edgeIndex);
        edgeIndex++;
      }
      if (stateDef.onEnter.errorState) {
        stateLines.push(`${INDENT}${nodeId} --> ${stateDef.onEnter.errorState}`);
        errorEdgeIndices.push(edgeIndex);
        edgeIndex++;
      }
    }

    // Events
    if (stateDef.events) {
      for (const [eventName, eventDef] of Object.entries(stateDef.events)) {
        if (!eventDef.targetState && !eventDef.errorState) continue;
        const nodeId = `${stateName}__${eventName}`;
        const label = formatEventNodeLabel(eventName, eventDef, opts);
        stateLines.push(`${INDENT}${nodeId}${label}`);
        stateLines.push(`${INDENT}${stateName} --> ${nodeId}`);
        plainEdgeIndices.push(edgeIndex);
        edgeIndex++;
        if (eventDef.targetState) {
          stateLines.push(`${INDENT}${nodeId} --> ${eventDef.targetState}`);
          successEdgeIndices.push(edgeIndex);
          edgeIndex++;
        }
        if (eventDef.errorState) {
          stateLines.push(`${INDENT}${nodeId} --> ${eventDef.errorState}`);
          errorEdgeIndices.push(edgeIndex);
          edgeIndex++;
        }
      }
    }

    if (stateLines.length > 0) {
      lines.push(...stateLines);
      lines.push("");
    }
  }

  // Terminal state edges
  if (hasTerminals) {
    for (const [stateName, stateDef] of Object.entries(definition.states)) {
      if (isTerminalState(stateDef)) {
        lines.push(`${INDENT}${stateName} --> _end`);
        plainEdgeIndices.push(edgeIndex);
        edgeIndex++;
      }
    }
    lines.push("");
  }

  // Link styles
  if (plainEdgeIndices.length > 0) {
    lines.push(`${INDENT}linkStyle ${plainEdgeIndices.join(",")} stroke-width:3px`);
  }
  if (successEdgeIndices.length > 0) {
    lines.push(`${INDENT}linkStyle ${successEdgeIndices.join(",")} stroke:#22c55e,stroke-width:3px`);
  }
  if (errorEdgeIndices.length > 0) {
    lines.push(`${INDENT}linkStyle ${errorEdgeIndices.join(",")} stroke:#dc3545,stroke-width:3px,stroke-dasharray:5`);
  }
  lines.push("");

  return lines.join("\n").trimEnd() + "\n";
}

function formatEventNodeLabel(
  eventName: string,
  eventDef: WorkflowEventDefinition,
  opts: Required<MermaidDiagramOptions>,
): string {
  let label = eventName;

  if (eventDef.timeout) {
    label += ` ⏳${formatTimeout(eventDef.timeout)}`;
  }

  if (opts.showCommands && eventDef.commands && eventDef.commands.length > 0) {
    const cmdLines = eventDef.commands.map((c) => c.name).join("<br/>");
    label += `<br/><small><i>${cmdLines}</i></small>`;
  }

  return `(["${label}"])`;
}

function formatOnEnterNodeLabel(onEnterDef: WorkflowOnEnterDefinition, opts: Required<MermaidDiagramOptions>): string {
  let label = "⚡";

  if (opts.showCommands && onEnterDef.commands && onEnterDef.commands.length > 0) {
    const cmdLines = onEnterDef.commands.map((c) => c.name).join("<br/>");
    label += `<br/><small><i>${cmdLines}</i></small>`;
  }

  return `(["${label}"])`;
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
