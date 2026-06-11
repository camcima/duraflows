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
});
