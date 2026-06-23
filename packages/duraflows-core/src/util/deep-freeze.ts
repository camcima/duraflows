function throwMutation(type: string): () => never {
  return () => {
    throw new TypeError(`Cannot mutate a frozen ${type} inside a workflow execution context`);
  };
}

const MAP_MUTATORS = ["set", "delete", "clear"] as const;
const SET_MUTATORS = ["add", "delete", "clear"] as const;

export function deepFreeze<T>(obj: T): Readonly<T> {
  return freezeRecursive(obj, new WeakSet());
}

function freezeRecursive<T>(obj: T, seen: WeakSet<object>): Readonly<T> {
  if (obj === null || typeof obj !== "object" || seen.has(obj)) {
    return obj;
  }
  seen.add(obj);

  // Object.freeze does not stop Map/Set mutation (it works on internal slots,
  // not properties), so the mutator methods are replaced before freezing to
  // uphold the "mutations throw" contract. Freezing happens BEFORE recursing
  // into entries so cyclic collections terminate (the `seen` set guards the
  // re-entry). A Map/Set frozen externally BEFORE reaching deepFreeze cannot
  // have its mutators replaced (defineProperty on a frozen object throws), so
  // its entries are frozen best-effort while its own mutators stay callable —
  // in practice unreachable from the runtime, which always clones via
  // structuredClone first (clones are never frozen).
  if (obj instanceof Map) {
    neutralizeMutators(obj, MAP_MUTATORS, "Map");
    Object.freeze(obj);
    for (const [key, value] of obj) {
      freezeRecursive(key, seen);
      freezeRecursive(value, seen);
    }
    return obj;
  }
  if (obj instanceof Set) {
    neutralizeMutators(obj, SET_MUTATORS, "Set");
    Object.freeze(obj);
    for (const value of obj) {
      freezeRecursive(value, seen);
    }
    return obj;
  }

  if (Object.isFrozen(obj)) {
    return obj;
  }
  Object.freeze(obj);
  for (const value of Object.values(obj as Record<string, unknown>)) {
    freezeRecursive(value, seen);
  }
  return obj;
}

function neutralizeMutators(obj: object, methods: readonly string[], typeName: string): void {
  if (Object.isFrozen(obj) || Object.getOwnPropertyDescriptor(obj, methods[0])) {
    return;
  }
  for (const method of methods) {
    Object.defineProperty(obj, method, { value: throwMutation(typeName) });
  }
}
