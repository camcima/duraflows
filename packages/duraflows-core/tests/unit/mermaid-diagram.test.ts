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
    expect(result).toBe(["stateDiagram-v2", "", "    [*] --> only", "", "    only --> [*]", ""].join("\n"));
  });

  it("renders a simple two-state workflow", () => {
    const result = toMermaidDiagram(twoStateWorkflow);
    expect(result).toBe(
      ["stateDiagram-v2", "", "    [*] --> open", "", "    open --> closed : Close", "", "    closed --> [*]", ""].join(
        "\n",
      ),
    );
  });

  it("renders the full order workflow (golden-file test)", () => {
    const result = toMermaidDiagram(orderWorkflow);
    expect(result).toBe(
      [
        "stateDiagram-v2",
        "",
        "    [*] --> new",
        "",
        "    new --> exportable : PaymentReceived",
        "    new --> cancelled : Cancel",
        "",
        "    exportable --> exported : Export",
        "    exportable --> export_failed : Export [error]",
        "",
        "    exported --> delivered : Deliver",
        "",
        "    delivered --> closed : TimeOut (14d)",
        "",
        "    export_failed --> exportable : RetryExport",
        "",
        "    closed --> [*]",
        "    cancelled --> [*]",
        "",
      ].join("\n"),
    );
  });

  it("shows error transitions with [error] suffix", () => {
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
    expect(result).toContain("a --> b : Go");
    expect(result).toContain("a --> c : Go [error]");
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
    expect(result).toContain("a --> err : Fail [error]");
    expect(result).not.toContain("a --> undefined");
  });
});

describe("timeout formatting", () => {
  it("formats days only", () => {
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
    expect(toMermaidDiagram(def)).toContain("Expire (14d)");
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
    expect(toMermaidDiagram(def)).toContain("Expire (2h 30m)");
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
    expect(toMermaidDiagram(def)).toContain("Expire (1d 12h)");
  });

  it("hides timeout when showTimeouts is false", () => {
    const def: WorkflowDefinition = {
      name: "t",
      initialState: "a",
      states: {
        a: {
          events: {
            Expire: { targetState: "b", timeout: { afterDays: 7 } },
          },
        },
        b: {},
      },
    };
    const result = toMermaidDiagram(def, { showTimeouts: false });
    expect(result).toContain("a --> b : Expire");
    expect(result).not.toContain("7d");
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
    expect(result).toContain("a --> b : Go");
    expect(result).not.toContain("doX");
  });

  it("shows commands when enabled", () => {
    const result = toMermaidDiagram(def, { showCommands: true });
    expect(result).toContain("a --> b : Go<br/>doX, doY");
  });
});

describe("onEnter transitions", () => {
  it("renders onEnter auto-transition with &#171;auto&#187; label", () => {
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
    expect(result).toContain("b --> c : &#171;auto&#187;");
  });

  it("renders onEnter error transition", () => {
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
    expect(result).toContain("b --> c : &#171;auto&#187;");
    expect(result).toContain("b --> d : &#171;auto&#187; [error]");
  });

  it("hides onEnter when showOnEnter is false", () => {
    const def: WorkflowDefinition = {
      name: "on-enter-hidden",
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
    const result = toMermaidDiagram(def, { showOnEnter: false });
    expect(result).not.toContain("&#171;auto&#187;");
    expect(result).not.toContain("b --> c");
  });

  it("shows commands on onEnter when showCommands is true", () => {
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
    expect(result).toContain("a --> b : &#171;auto&#187;<br/>init, setup");
  });
});

describe("terminal state detection", () => {
  it("marks states with no events and no onEnter targetState as terminal", () => {
    const result = toMermaidDiagram(twoStateWorkflow);
    expect(result).toContain("closed --> [*]");
  });

  it("does not mark states with events as terminal", () => {
    const result = toMermaidDiagram(twoStateWorkflow);
    expect(result).not.toContain("open --> [*]");
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
    expect(result).not.toContain("a --> [*]");
    expect(result).toContain("b --> [*]");
  });

  it("hides terminal markers when showTerminalStates is false", () => {
    const result = toMermaidDiagram(twoStateWorkflow, {
      showTerminalStates: false,
    });
    expect(result).not.toContain("--> [*]");
  });
});

describe("direction option", () => {
  it("omits direction line for default TB", () => {
    const result = toMermaidDiagram(minimalWorkflow);
    expect(result).not.toContain("direction");
  });

  it("emits direction LR when specified", () => {
    const result = toMermaidDiagram(minimalWorkflow, { direction: "LR" });
    expect(result).toContain("    direction LR");
  });
});

describe("state with both events and onEnter", () => {
  it("emits onEnter transitions before event transitions", () => {
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
    const autoIdx = result.indexOf("&#171;auto&#187;");
    const skipIdx = result.indexOf("Skip");
    expect(autoIdx).toBeLessThan(skipIdx);
  });
});
