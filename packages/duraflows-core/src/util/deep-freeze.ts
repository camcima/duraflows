function throwMutation(type: string): () => never {
  return () => {
    throw new TypeError(`Cannot mutate a frozen ${type} inside a workflow execution context`);
  };
}

const MAP_MUTATORS = ["set", "delete", "clear"] as const;
const SET_MUTATORS = ["add", "delete", "clear"] as const;

export function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== "object" || Object.isFrozen(obj)) {
    return obj;
  }

  // Object.freeze does not stop Map/Set mutation (it works on internal
  // slots, not properties), so replace the mutator methods before freezing
  // to uphold the "mutations throw" contract.
  if (obj instanceof Map) {
    for (const [key, value] of obj) {
      deepFreeze(key);
      deepFreeze(value);
    }
    for (const method of MAP_MUTATORS) {
      Object.defineProperty(obj, method, { value: throwMutation("Map") });
    }
  } else if (obj instanceof Set) {
    for (const value of obj) {
      deepFreeze(value);
    }
    for (const method of SET_MUTATORS) {
      Object.defineProperty(obj, method, { value: throwMutation("Set") });
    }
  }

  Object.freeze(obj);
  for (const value of Object.values(obj as Record<string, unknown>)) {
    deepFreeze(value);
  }
  return obj;
}
