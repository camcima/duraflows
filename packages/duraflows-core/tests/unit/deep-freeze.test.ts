import { describe, it, expect } from "vitest";
import { deepFreeze } from "../../src/util/deep-freeze.js";

describe("deepFreeze", () => {
  it("freezes plain objects so mutation throws in strict mode", () => {
    const obj = deepFreeze({ a: 1 });
    expect(() => {
      (obj as { a: number }).a = 2;
    }).toThrow(TypeError);
  });

  it("freezes nested objects and arrays", () => {
    const obj = deepFreeze({ nested: { list: [{ x: 1 }] } });
    expect(() => {
      (obj.nested.list[0] as { x: number }).x = 2;
    }).toThrow(TypeError);
    expect(() => {
      (obj.nested.list as unknown[]).push({});
    }).toThrow(TypeError);
  });

  it("makes Map.set/delete/clear throw", () => {
    const map = new Map([["k", { v: 1 }]]);
    const frozen = deepFreeze({ map }).map;
    expect(() => frozen.set("k2", { v: 2 })).toThrow(TypeError);
    expect(() => frozen.delete("k")).toThrow(TypeError);
    expect(() => frozen.clear()).toThrow(TypeError);
  });

  it("makes Set.add/delete/clear throw", () => {
    const set = new Set([1, 2]);
    const frozen = deepFreeze({ set }).set;
    expect(() => frozen.add(3)).toThrow(TypeError);
    expect(() => frozen.delete(1)).toThrow(TypeError);
    expect(() => frozen.clear()).toThrow(TypeError);
  });

  it("deep-freezes objects held inside Map values and Set members", () => {
    const map = new Map([["k", { v: 1 }]]);
    const set = new Set([{ s: 1 }]);
    deepFreeze({ map, set });
    expect(() => {
      map.get("k")!.v = 2;
    }).toThrow(TypeError);
    const member = set.values().next().value!;
    expect(() => {
      member.s = 2;
    }).toThrow(TypeError);
  });

  it("handles null, primitives, and already-frozen objects", () => {
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(42)).toBe(42);
    const pre = Object.freeze({ a: 1 });
    expect(deepFreeze(pre)).toBe(pre);
  });

  it("handles cyclic Maps and Sets without stack overflow", () => {
    const map = new Map<string, unknown>();
    map.set("self", map);
    const set = new Set<unknown>();
    set.add(set);
    expect(() => deepFreeze({ map, set })).not.toThrow();
    expect(() => map.set("x", 1)).toThrow(TypeError);
    expect(() => set.add(1)).toThrow(TypeError);
  });

  it("handles mutually-referencing Maps without stack overflow", () => {
    const a = new Map<string, unknown>();
    const b = new Map<string, unknown>();
    a.set("b", b);
    b.set("a", a);
    expect(() => deepFreeze(a)).not.toThrow();
    expect(() => b.set("x", 1)).toThrow(TypeError);
  });

  it("handles cycles through plain objects into collections", () => {
    const root: Record<string, unknown> = {};
    const map = new Map<string, unknown>([["root", root]]);
    root.map = map;
    expect(() => deepFreeze(root)).not.toThrow();
    expect(() => map.set("x", 1)).toThrow(TypeError);
    expect(Object.isFrozen(root)).toBe(true);
  });

  it("is idempotent when called twice on the same Map", () => {
    const map = new Map([["k", 1]]);
    deepFreeze(map);
    expect(() => deepFreeze(map)).not.toThrow();
    expect(() => map.set("x", 2)).toThrow(TypeError);
  });

  it("freezes entries of an externally pre-frozen Map without crashing (best effort)", () => {
    const entry = { v: 1 };
    const map = new Map([["k", entry]]);
    Object.freeze(map);
    expect(() => deepFreeze({ map })).not.toThrow();
    // Entries are still frozen; the frozen Map's own mutators cannot be
    // replaced (defineProperty on a frozen object throws) — documented
    // limitation, unreachable via the runtime's structuredClone call sites.
    expect(() => {
      entry.v = 2;
    }).toThrow(TypeError);
  });
});
