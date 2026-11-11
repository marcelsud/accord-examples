import assert from "node:assert/strict";
import type { Result, Tagged } from "@marcelsud/accord";

export function success<T, E extends Tagged>(result: Result<T, E>): T {
  const [value, error] = result;
  assert.equal(error, null);
  if (error !== null) throw error;
  return value as T;
}
export function failure<T, E extends Tagged>(result: Result<T, E>): E {
  const [, error] = result;
  assert.notEqual(error, null);
  if (error === null) throw new Error("Expected failure");
  return error;
}
