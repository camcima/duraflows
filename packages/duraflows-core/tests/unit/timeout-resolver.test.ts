import { describe, it, expect } from "vitest";
import { TimeoutResolver } from "../../src/execution/timeout-resolver.js";
import type { WorkflowDefinition } from "../../src/types/definition.js";

const NOW = new Date("2026-01-01T00:00:00Z");

function makeDefinition(states: WorkflowDefinition["states"]): WorkflowDefinition {
  return { name: "test-workflow", initialState: "init", states };
}

describe("TimeoutResolver", () => {
  const resolver = new TimeoutResolver();

  describe("computeDeadline", () => {
    it("returns null when the state has no events", () => {
      const def = makeDefinition({
        waiting: {},
      });

      expect(resolver.computeDeadline(def, "waiting", NOW)).toBeNull();
    });

    it("returns null when the state has events but none with a timeout", () => {
      const def = makeDefinition({
        waiting: {
          events: {
            approve: { targetState: "approved" },
            reject: { targetState: "rejected" },
          },
        },
      });

      expect(resolver.computeDeadline(def, "waiting", NOW)).toBeNull();
    });

    it("returns now + 30 minutes for afterMinutes: 30", () => {
      const def = makeDefinition({
        waiting: {
          events: {
            expire: {
              targetState: "expired",
              timeout: { afterMinutes: 30 },
            },
          },
        },
      });

      const result = resolver.computeDeadline(def, "waiting", NOW);
      expect(result).toEqual(new Date("2026-01-01T00:30:00Z"));
    });

    it("returns now + 2 hours for afterHours: 2", () => {
      const def = makeDefinition({
        waiting: {
          events: {
            expire: {
              targetState: "expired",
              timeout: { afterHours: 2 },
            },
          },
        },
      });

      const result = resolver.computeDeadline(def, "waiting", NOW);
      expect(result).toEqual(new Date("2026-01-01T02:00:00Z"));
    });

    it("returns now + 10 days for afterDays: 10", () => {
      const def = makeDefinition({
        waiting: {
          events: {
            expire: {
              targetState: "expired",
              timeout: { afterDays: 10 },
            },
          },
        },
      });

      const result = resolver.computeDeadline(def, "waiting", NOW);
      expect(result).toEqual(new Date("2026-01-11T00:00:00Z"));
    });

    it("returns now + 90 minutes for combined afterHours: 1 and afterMinutes: 30", () => {
      const def = makeDefinition({
        waiting: {
          events: {
            expire: {
              targetState: "expired",
              timeout: { afterHours: 1, afterMinutes: 30 },
            },
          },
        },
      });

      const result = resolver.computeDeadline(def, "waiting", NOW);
      expect(result).toEqual(new Date("2026-01-01T01:30:00Z"));
    });

    it("returns null when the state does not exist in the definition", () => {
      const def = makeDefinition({
        waiting: {},
      });

      expect(resolver.computeDeadline(def, "nonexistent", NOW)).toBeNull();
    });

    it("returns null when the timeout sums to zero", () => {
      // All-zero components — defined but degenerate timeout.
      const def = makeDefinition({
        waiting: {
          events: {
            expire: {
              targetState: "expired",
              timeout: { afterMinutes: 0, afterHours: 0, afterDays: 0 },
            },
          },
        },
      });

      expect(resolver.computeDeadline(def, "waiting", NOW)).toBeNull();
    });
  });

  describe("getTimeoutEventName", () => {
    it("returns null when the state has no events", () => {
      const def = makeDefinition({
        waiting: {},
      });

      expect(resolver.getTimeoutEventName(def, "waiting")).toBeNull();
    });

    it("returns null when the state has events but none with a timeout", () => {
      const def = makeDefinition({
        waiting: {
          events: {
            approve: { targetState: "approved" },
            reject: { targetState: "rejected" },
          },
        },
      });

      expect(resolver.getTimeoutEventName(def, "waiting")).toBeNull();
    });

    it("returns the event name when a timeout event exists", () => {
      const def = makeDefinition({
        waiting: {
          events: {
            approve: { targetState: "approved" },
            expire: {
              targetState: "expired",
              timeout: { afterMinutes: 30 },
            },
          },
        },
      });

      expect(resolver.getTimeoutEventName(def, "waiting")).toBe("expire");
    });

    it("returns null when the state does not exist in the definition", () => {
      const def = makeDefinition({
        waiting: {},
      });

      expect(resolver.getTimeoutEventName(def, "nonexistent")).toBeNull();
    });
  });
});
