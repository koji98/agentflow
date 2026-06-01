export function retryDelayMs(headers = {}) {
  const retryAfter = headers["retry-after"] ?? headers["Retry-After"];

  if (!retryAfter) {
    return 0;
  }

  return Number(retryAfter);
}
