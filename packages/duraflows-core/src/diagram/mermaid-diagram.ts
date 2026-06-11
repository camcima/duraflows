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

function sanitizeId(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * Per-diagram node-id allocator. Sanitization is lossy ("a b" and "a_b" both
 * sanitize to "a_b"), so ids are allocated per logical key with a numeric
 * suffix on collision — distinct names always get distinct ids, and the same
 * key always resolves to the same id wherever it is referenced.
 */
function createIdAllocator(): (key: string, rawName: string) => string {
  // _start/_end are synthetic nodes emitted unconditionally — reserve them so
  // a state that sanitizes to the same token cannot merge with them.
  const used = new Set(["_start", "_end"]);
  const byKey = new Map<string, string>();
  return (key, rawName) => {
    const existing = byKey.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const base = sanitizeId(rawName) || "_node";
    let id = base;
    for (let n = 2; used.has(id); n++) {
      id = `${base}_${n}`;
    }
    used.add(id);
    byKey.set(key, id);
    return id;
  };
}

function escapeLabel(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

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

  const allocateId = createIdAllocator();
  const stateId = (name: string): string => allocateId(`state:${name}`, name);

  // Header
  lines.push(`flowchart ${opts.direction}`);
  lines.push("");

  // Class definitions
  lines.push(`${INDENT}classDef stateNode fill:#f1f5f9,stroke:#64748b,stroke-width:2px,color:#1e293b,font-size:20px`);
  lines.push("");

  // State node definitions
  lines.push(`${INDENT}_start@{ shape: sm-circ }`);
  for (const stateName of Object.keys(definition.states)) {
    lines.push(`${INDENT}${stateId(stateName)}["<b>${escapeLabel(stateName)}</b>"]:::stateNode`);
  }
  const hasTerminals = Object.values(definition.states).some((sd) => isTerminalState(sd));
  if (hasTerminals) {
    lines.push(`${INDENT}_end@{ shape: framed-circle }`);
  }
  lines.push("");

  // Start edge
  lines.push(`${INDENT}_start --> ${stateId(definition.initialState)}`);
  plainEdgeIndices.push(edgeIndex);
  edgeIndex++;
  lines.push("");

  // State transitions
  for (const [stateName, stateDef] of Object.entries(definition.states)) {
    const stateLines: string[] = [];

    // onEnter
    if (stateDef.onEnter && (stateDef.onEnter.targetState || stateDef.onEnter.errorState)) {
      const nId = allocateId(`onEnter:${stateName}`, `${stateId(stateName)}__onEnter`);
      const label = formatOnEnterNodeLabel(stateDef.onEnter, opts);
      stateLines.push(`${INDENT}${nId}${label}`);
      stateLines.push(`${INDENT}${stateId(stateName)} --> ${nId}`);
      plainEdgeIndices.push(edgeIndex);
      edgeIndex++;
      if (stateDef.onEnter.targetState) {
        stateLines.push(`${INDENT}${nId} --> ${stateId(stateDef.onEnter.targetState)}`);
        successEdgeIndices.push(edgeIndex);
        edgeIndex++;
      }
      if (stateDef.onEnter.errorState) {
        stateLines.push(`${INDENT}${nId} --> ${stateId(stateDef.onEnter.errorState)}`);
        errorEdgeIndices.push(edgeIndex);
        edgeIndex++;
      }
    }

    // Events
    if (stateDef.events) {
      for (const [eventName, eventDef] of Object.entries(stateDef.events)) {
        if (!eventDef.targetState && !eventDef.errorState) continue;
        // The (state, event) pair is JSON-encoded so names containing any
        // separator character cannot produce ambiguous allocator keys.
        const nId = allocateId(
          `event:${JSON.stringify([stateName, eventName])}`,
          `${stateId(stateName)}__${eventName}`,
        );
        const label = formatEventNodeLabel(eventName, eventDef, opts);
        stateLines.push(`${INDENT}${nId}${label}`);
        stateLines.push(`${INDENT}${stateId(stateName)} --> ${nId}`);
        plainEdgeIndices.push(edgeIndex);
        edgeIndex++;
        if (eventDef.targetState) {
          stateLines.push(`${INDENT}${nId} --> ${stateId(eventDef.targetState)}`);
          successEdgeIndices.push(edgeIndex);
          edgeIndex++;
        }
        if (eventDef.errorState) {
          stateLines.push(`${INDENT}${nId} --> ${stateId(eventDef.errorState)}`);
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
        lines.push(`${INDENT}${stateId(stateName)} --> _end`);
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
  let label = escapeLabel(eventName);

  if (eventDef.timeout) {
    label += ` ⧖${formatTimeout(eventDef.timeout)}`;
  }

  if (opts.showCommands && eventDef.commands && eventDef.commands.length > 0) {
    const cmdLines = eventDef.commands.map((c) => escapeLabel(c.name)).join("<br/>");
    label += `<br/><small><i>${cmdLines}</i></small>`;
  }

  return `(["${label}"])`;
}

function formatOnEnterNodeLabel(onEnterDef: WorkflowOnEnterDefinition, opts: Required<MermaidDiagramOptions>): string {
  let label = "🗲";

  if (opts.showCommands && onEnterDef.commands && onEnterDef.commands.length > 0) {
    const cmdLines = onEnterDef.commands.map((c) => escapeLabel(c.name)).join("<br/>");
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
