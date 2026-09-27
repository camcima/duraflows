import { InvalidArgumentError } from "../errors/index.js";

export function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidArgumentError(`${name} must be a positive integer, got ${value}`);
  }
}

export function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidArgumentError(`${name} must be a non-negative integer, got ${value}`);
  }
}
