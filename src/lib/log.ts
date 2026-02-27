/* eslint-disable no-console */

/** Writes informational output to stdout. */
export function log(...args: unknown[]): void {
  console.log(...args);
}

/** Writes error output to stderr. */
export function logError(...args: unknown[]): void {
  console.error(...args);
}
