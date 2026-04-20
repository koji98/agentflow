import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  KeychainError,
  deleteSecret,
  getSecret,
  keychainServiceName,
  setKeychainRunnerForTesting,
  setSecret,
  type KeychainCommandRunner
} from "../../src/auth/keychain.js";

interface RecordedInvocation {
  args: string[];
  stdin?: string;
}

interface FakeRunnerHandle {
  invocations: RecordedInvocation[];
  setResponses: (
    responses: Array<{ exitCode: number; stdout?: string; stderr?: string }>
  ) => void;
}

function setupFakeRunner(): FakeRunnerHandle {
  const invocations: RecordedInvocation[] = [];
  const responses: Array<{ exitCode: number; stdout?: string; stderr?: string }> = [];

  const runner: KeychainCommandRunner = async (options) => {
    invocations.push({ args: options.args, ...(options.stdin !== undefined ? { stdin: options.stdin } : {}) });
    const next = responses.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
    return {
      exitCode: next.exitCode,
      stdout: next.stdout ?? "",
      stderr: next.stderr ?? ""
    };
  };

  setKeychainRunnerForTesting(runner);

  return {
    invocations,
    setResponses(next) {
      responses.length = 0;
      responses.push(...next);
    }
  };
}

describe("keychain", () => {
  let runner: FakeRunnerHandle;

  beforeEach(() => {
    runner = setupFakeRunner();
  });

  afterEach(() => {
    setKeychainRunnerForTesting(undefined);
  });

  it("computes service names with the agentflow prefix", () => {
    expect(keychainServiceName("reddit-drone", "token")).toBe("agentflow.reddit-drone.token");
  });

  it("returns the trimmed stdout when reading an existing secret", async () => {
    runner.setResponses([{ exitCode: 0, stdout: "ghp_token_value\n" }]);
    const value = await getSecret("reddit-drone", "token", { account: "tester" });
    expect(value).toBe("ghp_token_value");
    expect(runner.invocations).toHaveLength(1);
    expect(runner.invocations[0]?.args).toEqual([
      "find-generic-password",
      "-s",
      "agentflow.reddit-drone.token",
      "-a",
      "tester",
      "-w"
    ]);
  });

  it("returns undefined when the keychain reports a missing entry", async () => {
    runner.setResponses([
      {
        exitCode: 44,
        stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain."
      }
    ]);
    const value = await getSecret("reddit-drone", "token", { account: "tester" });
    expect(value).toBeUndefined();
  });

  it("throws KeychainError on unexpected non-zero exits", async () => {
    runner.setResponses([{ exitCode: 51, stderr: "operation aborted" }]);
    await expect(getSecret("reddit-drone", "token", { account: "tester" })).rejects.toBeInstanceOf(
      KeychainError
    );
  });

  it("writes secrets via security add-generic-password with -U so updates overwrite", async () => {
    runner.setResponses([{ exitCode: 0 }]);
    await setSecret("reddit-drone", "token", "ghp_secret_value", { account: "tester" });
    const invocation = runner.invocations[0]!;
    expect(invocation.args).toEqual([
      "add-generic-password",
      "-U",
      "-s",
      "agentflow.reddit-drone.token",
      "-a",
      "tester",
      "-l",
      "Agentflow reddit-drone token",
      "-w",
      "ghp_secret_value"
    ]);
    expect(invocation.stdin).toBeUndefined();
  });

  it("throws KeychainError when writes fail", async () => {
    runner.setResponses([{ exitCode: 1, stderr: "permission denied" }]);
    await expect(setSecret("reddit-drone", "token", "v", { account: "tester" })).rejects.toBeInstanceOf(
      KeychainError
    );
  });

  it("returns true when delete succeeds", async () => {
    runner.setResponses([{ exitCode: 0 }]);
    const removed = await deleteSecret("reddit-drone", "token", { account: "tester" });
    expect(removed).toBe(true);
  });

  it("returns false when the entry to delete is missing", async () => {
    runner.setResponses([{ exitCode: 44, stderr: "could not be found" }]);
    const removed = await deleteSecret("reddit-drone", "token", { account: "tester" });
    expect(removed).toBe(false);
  });
});
