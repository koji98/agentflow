export interface SupervisorRecoveryCycleRetryEvent {
  attempt: number;
  max_attempts: number;
  delay_ms: number;
  summary: string;
}

export type SupervisorRecoveryCycleRetryResult<T> =
  | {
      status: "passed";
      value: T;
      attempts: number;
      errors: string[];
    }
  | {
      status: "failed";
      attempts: number;
      errors: string[];
      summary: string;
      error: unknown;
    };

function summarizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

export async function runSupervisorRecoveryCycleWithBackoff<T>(options: {
  maxAttempts: number;
  run: () => Promise<T>;
  delayForAttempt: (failedAttempt: number) => number;
  sleep: (delayMs: number) => Promise<void>;
  onRetry?: (event: SupervisorRecoveryCycleRetryEvent) => Promise<void> | void;
}): Promise<SupervisorRecoveryCycleRetryResult<T>> {
  const configuredMaxAttempts = Math.floor(options.maxAttempts);
  const maxAttempts = Number.isFinite(configuredMaxAttempts) && configuredMaxAttempts >= 1 ? configuredMaxAttempts : 1;
  const errors: string[] = [];
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return {
        status: "passed",
        value: await options.run(),
        attempts: attempt,
        errors
      };
    } catch (error) {
      lastError = error;
      const summary = summarizeError(error);
      errors.push(summary);

      if (attempt >= maxAttempts) {
        return {
          status: "failed",
          attempts: attempt,
          errors,
          summary,
          error
        };
      }

      const delayMs = Math.max(0, options.delayForAttempt(attempt));
      await options.onRetry?.({
        attempt,
        max_attempts: maxAttempts,
        delay_ms: delayMs,
        summary
      });
      await options.sleep(delayMs);
    }
  }

  /* c8 ignore next 7 -- defensive fallback for future loop-shape changes; current loop returns from pass/fail paths. */
  return {
    status: "failed",
    attempts: maxAttempts,
    errors,
    summary: summarizeError(lastError),
    error: lastError
  };
}
