import { describe, expect, it } from "vitest";
import { runSupervisorRecoveryCycleWithBackoff } from "../../src/runtime/core/supervisor_recovery_retry.js";

describe("runSupervisorRecoveryCycleWithBackoff", () => {
  it("retries a transient supervisor recovery-cycle failure with backoff", async () => {
    let calls = 0;
    const sleepCalls: number[] = [];
    const retryEvents: Array<{ attempt: number; max_attempts: number; delay_ms: number; summary: string }> = [];

    const result = await runSupervisorRecoveryCycleWithBackoff({
      maxAttempts: 3,
      delayForAttempt: (attempt) => attempt * 5,
      sleep: async (delayMs) => {
        sleepCalls.push(delayMs);
      },
      onRetry: (event) => {
        retryEvents.push(event);
      },
      run: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("transient supervisor failure");
        }
        return "ok";
      }
    });

    expect(result).toEqual({
      status: "passed",
      value: "ok",
      attempts: 2,
      errors: ["transient supervisor failure"]
    });
    expect(sleepCalls).toEqual([5]);
    expect(retryEvents).toEqual([
      {
        attempt: 1,
        max_attempts: 3,
        delay_ms: 5,
        summary: "transient supervisor failure"
      }
    ]);
  });

  it("fails closed after exhausting supervisor recovery-cycle retries", async () => {
    const sleepCalls: number[] = [];

    const result = await runSupervisorRecoveryCycleWithBackoff({
      maxAttempts: 2,
      delayForAttempt: (attempt) => attempt * 5,
      sleep: async (delayMs) => {
        sleepCalls.push(delayMs);
      },
      run: async () => {
        throw new Error("supervisor infrastructure still unavailable");
      }
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.attempts).toBe(2);
      expect(result.errors).toEqual([
        "supervisor infrastructure still unavailable",
        "supervisor infrastructure still unavailable"
      ]);
      expect(result.summary).toContain("supervisor infrastructure still unavailable");
    }
    expect(sleepCalls).toEqual([5]);
  });

  it("normalizes invalid retry counts to one failed attempt with non-Error summaries", async () => {
    const sleepCalls: number[] = [];

    const result = await runSupervisorRecoveryCycleWithBackoff({
      maxAttempts: 0,
      delayForAttempt: () => 5,
      sleep: async (delayMs) => {
        sleepCalls.push(delayMs);
      },
      run: async () => {
        throw "plain supervisor failure";
      }
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.attempts).toBe(1);
      expect(result.errors).toEqual(["plain supervisor failure"]);
      expect(result.summary).toBe("plain supervisor failure");
      expect(result.error).toBe("plain supervisor failure");
    }
    expect(sleepCalls).toEqual([]);
  });

  it("clamps negative retry delays before sleeping", async () => {
    let calls = 0;
    const sleepCalls: number[] = [];
    const retryEvents: Array<{ delay_ms: number; summary: string }> = [];

    const result = await runSupervisorRecoveryCycleWithBackoff({
      maxAttempts: 2,
      delayForAttempt: () => -25,
      sleep: async (delayMs) => {
        sleepCalls.push(delayMs);
      },
      onRetry: (event) => {
        retryEvents.push({ delay_ms: event.delay_ms, summary: event.summary });
      },
      run: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("temporary supervisor transport failure");
        }
        return "recovered";
      }
    });

    expect(result).toEqual({
      status: "passed",
      value: "recovered",
      attempts: 2,
      errors: ["temporary supervisor transport failure"]
    });
    expect(sleepCalls).toEqual([0]);
    expect(retryEvents).toEqual([
      {
        delay_ms: 0,
        summary: "temporary supervisor transport failure"
      }
    ]);
  });
});
