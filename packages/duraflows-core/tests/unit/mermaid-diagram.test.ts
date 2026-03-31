import { describe, it, expect } from "vitest";
import { toMermaidDiagram } from "../../src/diagram/mermaid-diagram.js";
import type { WorkflowDefinition } from "../../src/types/definition.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const minimalWorkflow: WorkflowDefinition = {
  name: "minimal",
  initialState: "only",
  states: {
    only: {},
  },
};

const twoStateWorkflow: WorkflowDefinition = {
  name: "two-state",
  initialState: "open",
  states: {
    open: {
      events: {
        Close: { targetState: "closed" },
      },
    },
    closed: {},
  },
};

const orderWorkflow: WorkflowDefinition = {
  name: "order",
  initialState: "new",
  states: {
    new: {
      context: { paymentStatus: "pending", isActive: true },
      events: {
        PaymentReceived: { targetState: "exportable" },
        Cancel: { targetState: "cancelled" },
      },
    },
    exportable: {
      context: { paymentStatus: "paid" },
      events: {
        Export: {
          targetState: "exported",
          errorState: "export_failed",
          commands: [{ name: "sendOrderToWarehouse" }, { name: "notifyCustomer" }],
        },
      },
    },
    exported: {
      context: { shipmentStatus: "shipped" },
      events: {
        Deliver: { targetState: "delivered" },
      },
    },
    delivered: {
      context: { shipmentStatus: "delivered", isActive: false },
      events: {
        TimeOut: { targetState: "closed", timeout: { afterDays: 14 } },
      },
    },
    closed: {},
    cancelled: { context: { isActive: false } },
    export_failed: {
      events: {
        RetryExport: { targetState: "exportable" },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("toMermaidDiagram", () => {
  it("renders a minimal single-state workflow", () => {
    const result = toMermaidDiagram(minimalWorkflow);
    expect(result).toContain("flowchart TB");
    expect(result).toContain("_start@{ shape: sm-circ }");
    expect(result).toContain('only["<b>only</b>"]:::stateNode');
    expect(result).toContain("_start --> only");
    expect(result).toContain("only --> _end");
    expect(result).toContain("_end@{ shape: framed-circle }");
  });

  it("renders a simple two-state workflow with event nodes", () => {
    const result = toMermaidDiagram(twoStateWorkflow);
    expect(result).toContain('open["<b>open</b>"]:::stateNode');
    expect(result).toContain('closed["<b>closed</b>"]:::stateNode');
    expect(result).toContain('open__Close(["Close"])');
    expect(result).toContain("open --> open__Close");
    expect(result).toContain("open__Close --> closed");
    expect(result).toContain("closed --> _end");
  });

  it("renders the full order workflow (golden-file test)", () => {
    const result = toMermaidDiagram(orderWorkflow);
    expect(result).toBe(
      [
        "flowchart TB",
        "",
        "    classDef stateNode fill:#f1f5f9,stroke:#64748b,stroke-width:2px,color:#1e293b,font-size:20px",
        "",
        "    _start@{ shape: sm-circ }",
        '    new["<b>new</b>"]:::stateNode',
        '    exportable["<b>exportable</b>"]:::stateNode',
        '    exported["<b>exported</b>"]:::stateNode',
        '    delivered["<b>delivered</b>"]:::stateNode',
        '    closed["<b>closed</b>"]:::stateNode',
        '    cancelled["<b>cancelled</b>"]:::stateNode',
        '    export_failed["<b>export_failed</b>"]:::stateNode',
        "    _end@{ shape: framed-circle }",
        "",
        "    _start --> new",
        "",
        '    new__PaymentReceived(["PaymentReceived"])',
        "    new --> new__PaymentReceived",
        "    new__PaymentReceived --> exportable",
        '    new__Cancel(["Cancel"])',
        "    new --> new__Cancel",
        "    new__Cancel --> cancelled",
        "",
        '    exportable__Export(["Export"])',
        "    exportable --> exportable__Export",
        "    exportable__Export --> exported",
        "    exportable__Export --> export_failed",
        "",
        '    exported__Deliver(["Deliver"])',
        "    exported --> exported__Deliver",
        "    exported__Deliver --> delivered",
        "",
        '    delivered__TimeOut(["TimeOut fa:fa-hourglass 14d"])',
        "    delivered --> delivered__TimeOut",
        "    delivered__TimeOut --> closed",
        "",
        '    export_failed__RetryExport(["RetryExport"])',
        "    export_failed --> export_failed__RetryExport",
        "    export_failed__RetryExport --> exportable",
        "",
        "    closed --> _end",
        "    cancelled --> _end",
        "",
        "    linkStyle 0,1,3,5,8,10,12,14,15 stroke-width:3px",
        "    linkStyle 2,4,6,9,11,13 stroke:#22c55e,stroke-width:3px",
        "    linkStyle 7 stroke:#dc3545,stroke-width:3px,stroke-dasharray:5",
        "",
      ].join("\n"),
    );
  });

  it("uses separate arrows for success and error paths", () => {
    const def: WorkflowDefinition = {
      name: "error-test",
      initialState: "a",
      states: {
        a: {
          events: {
            Go: { targetState: "b", errorState: "c" },
          },
        },
        b: {},
        c: {},
      },
    };
    const result = toMermaidDiagram(def);
    expect(result).toContain('a__Go(["Go"])');
    expect(result).toContain("a --> a__Go");
    expect(result).toContain("a__Go --> b");
    expect(result).toContain("a__Go --> c");
    expect(result).toContain("stroke:#22c55e");
    expect(result).toContain("stroke:#dc3545");
  });

  it("renders event with only errorState (no targetState)", () => {
    const def: WorkflowDefinition = {
      name: "error-only",
      initialState: "a",
      states: {
        a: {
          events: {
            Fail: { errorState: "err" },
          },
        },
        err: {},
      },
    };
    const result = toMermaidDiagram(def);
    expect(result).toContain("a__Fail --> err");
    expect(result).toContain("stroke:#dc3545");
    expect(result).not.toContain("stroke:#22c55e");
  });
});

describe("edge coloring", () => {
  it("applies green linkStyle to success edges and red to error edges", () => {
    const def: WorkflowDefinition = {
      name: "multi-error",
      initialState: "a",
      states: {
        a: {
          events: {
            Go: { targetState: "b", errorState: "c" },
            Try: { targetState: "d", errorState: "e" },
          },
        },
        b: {},
        c: {},
        d: {},
        e: {},
      },
    };
    const result = toMermaidDiagram(def);
    // Edge 0: _start --> a (plain)
    // Edge 1: a --> a__Go (plain)
    // Edge 2: a__Go --> b (green)
    // Edge 3: a__Go --> c (red)
    // Edge 4: a --> a__Try (plain)
    // Edge 5: a__Try --> d (green)
    // Edge 6: a__Try --> e (red)
    // Edge 7: b --> _end (plain)
    // Edge 8: c --> _end (plain)
    // Edge 9: d --> _end (plain)
    // Edge 10: e --> _end (plain)
    expect(result).toContain("linkStyle 0,1,4,7,8,9,10 stroke-width:3px");
    expect(result).toContain("linkStyle 2,5 stroke:#22c55e,stroke-width:3px");
    expect(result).toContain("linkStyle 3,6 stroke:#dc3545,stroke-width:3px,stroke-dasharray:5");
  });

  it("omits colored linkStyle when there are no events with targets", () => {
    const result = toMermaidDiagram(minimalWorkflow);
    expect(result).not.toContain("stroke:#22c55e");
    expect(result).not.toContain("stroke:#dc3545");
    // But still has plain linkStyle
    expect(result).toContain("linkStyle");
  });
});

describe("timeout formatting", () => {
  it("formats days with hourglass emoji", () => {
    const def: WorkflowDefinition = {
      name: "t",
      initialState: "a",
      states: {
        a: {
          events: {
            Expire: { targetState: "b", timeout: { afterDays: 14 } },
          },
        },
        b: {},
      },
    };
    expect(toMermaidDiagram(def)).toContain("Expire fa:fa-hourglass 14d");
  });

  it("formats hours and minutes", () => {
    const def: WorkflowDefinition = {
      name: "t",
      initialState: "a",
      states: {
        a: {
          events: {
            Expire: {
              targetState: "b",
              timeout: { afterHours: 2, afterMinutes: 30 },
            },
          },
        },
        b: {},
      },
    };
    expect(toMermaidDiagram(def)).toContain("Expire fa:fa-hourglass 2h 30m");
  });

  it("formats days and hours", () => {
    const def: WorkflowDefinition = {
      name: "t",
      initialState: "a",
      states: {
        a: {
          events: {
            Expire: {
              targetState: "b",
              timeout: { afterDays: 1, afterHours: 12 },
            },
          },
        },
        b: {},
      },
    };
    expect(toMermaidDiagram(def)).toContain("Expire fa:fa-hourglass 1d 12h");
  });
});

describe("showCommands option", () => {
  const def: WorkflowDefinition = {
    name: "cmd-test",
    initialState: "a",
    states: {
      a: {
        events: {
          Go: {
            targetState: "b",
            commands: [{ name: "doX" }, { name: "doY" }],
          },
        },
      },
      b: {},
    },
  };

  it("hides commands by default", () => {
    const result = toMermaidDiagram(def);
    expect(result).toContain('(["Go"])');
    expect(result).not.toContain("doX");
  });

  it("shows commands on separate lines in small italic when enabled", () => {
    const result = toMermaidDiagram(def, { showCommands: true });
    expect(result).toContain("Go<br/><small><i>doX<br/>doY</i></small>");
  });
});

describe("onEnter transitions", () => {
  it("renders onEnter as fa:fa-bolt event node", () => {
    const def: WorkflowDefinition = {
      name: "on-enter",
      initialState: "a",
      states: {
        a: {
          events: { Go: { targetState: "b" } },
        },
        b: {
          onEnter: { targetState: "c" },
        },
        c: {},
      },
    };
    const result = toMermaidDiagram(def);
    expect(result).toContain('b__onEnter(["fa:fa-bolt"])');
    expect(result).toContain("b --> b__onEnter");
    expect(result).toContain("b__onEnter --> c");
  });

  it("renders onEnter error as red arrow from event node", () => {
    const def: WorkflowDefinition = {
      name: "on-enter-err",
      initialState: "a",
      states: {
        a: {
          events: { Go: { targetState: "b" } },
        },
        b: {
          onEnter: {
            targetState: "c",
            errorState: "d",
            commands: [{ name: "validate" }],
          },
        },
        c: {},
        d: {},
      },
    };
    const result = toMermaidDiagram(def);
    expect(result).toContain("b__onEnter --> c");
    expect(result).toContain("b__onEnter --> d");
    expect(result).toContain("stroke:#22c55e");
    expect(result).toContain("stroke:#dc3545");
  });

  it("shows commands on separate lines in small italic on onEnter when showCommands is true", () => {
    const def: WorkflowDefinition = {
      name: "on-enter-cmds",
      initialState: "a",
      states: {
        a: {
          onEnter: {
            targetState: "b",
            commands: [{ name: "init" }, { name: "setup" }],
          },
        },
        b: {},
      },
    };
    const result = toMermaidDiagram(def, { showCommands: true });
    expect(result).toContain("fa:fa-bolt<br/><small><i>init<br/>setup</i></small>");
  });
});

describe("terminal state detection", () => {
  it("marks states with no events and no onEnter targetState as terminal", () => {
    const result = toMermaidDiagram(twoStateWorkflow);
    expect(result).toContain("closed --> _end");
  });

  it("does not mark states with events as terminal", () => {
    const result = toMermaidDiagram(twoStateWorkflow);
    expect(result).not.toContain("open --> _end");
  });

  it("does not mark states with onEnter targetState as terminal", () => {
    const def: WorkflowDefinition = {
      name: "pass-through",
      initialState: "a",
      states: {
        a: {
          onEnter: { targetState: "b" },
        },
        b: {},
      },
    };
    const result = toMermaidDiagram(def);
    expect(result).not.toContain("a --> _end");
    expect(result).toContain("b --> _end");
  });
});

describe("direction option", () => {
  it("uses TB by default", () => {
    const result = toMermaidDiagram(minimalWorkflow);
    expect(result).toContain("flowchart TB");
  });

  it("uses LR when specified", () => {
    const result = toMermaidDiagram(minimalWorkflow, { direction: "LR" });
    expect(result).toContain("flowchart LR");
  });
});

describe("node shapes", () => {
  it("uses styled rectangles with bold text for states", () => {
    const result = toMermaidDiagram(twoStateWorkflow);
    expect(result).toContain('open["<b>open</b>"]:::stateNode');
    expect(result).toContain('closed["<b>closed</b>"]:::stateNode');
    expect(result).toContain(
      "classDef stateNode fill:#f1f5f9,stroke:#64748b,stroke-width:2px,color:#1e293b,font-size:20px",
    );
  });

  it("uses stadium (rounded) shape for event nodes", () => {
    const result = toMermaidDiagram(twoStateWorkflow);
    expect(result).toContain('open__Close(["Close"])');
  });

  it("uses sm-circ for start and framed-circle for end", () => {
    const result = toMermaidDiagram(minimalWorkflow);
    expect(result).toContain("_start@{ shape: sm-circ }");
    expect(result).toContain("_end@{ shape: framed-circle }");
  });
});

describe("state with both events and onEnter", () => {
  it("emits onEnter node before event nodes", () => {
    const def: WorkflowDefinition = {
      name: "mixed",
      initialState: "a",
      states: {
        a: {
          onEnter: { targetState: "b" },
          events: {
            Skip: { targetState: "c" },
          },
        },
        b: {},
        c: {},
      },
    };
    const result = toMermaidDiagram(def);
    const autoIdx = result.indexOf("a__onEnter");
    const skipIdx = result.indexOf("a__Skip");
    expect(autoIdx).toBeLessThan(skipIdx);
  });
});
