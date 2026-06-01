export function parseDurationMs(value) {
  if (value.endsWith("m")) {
    return Number(value.slice(0, -1)) * 60 * 1000;
  }

  return Number(value);
}
