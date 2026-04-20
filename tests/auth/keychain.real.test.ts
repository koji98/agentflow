import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";

import { describe, expect, it } from "vitest";

import {
  deleteSecret,
  getSecret,
  setSecret,
  setKeychainRunnerForTesting
} from "../../src/auth/keychain.js";

const isDarwin = process.platform === "darwin";
const realKeychainEnabled = process.env.AGENTFLOW_TEST_REAL_KEYCHAIN === "1";

describe.skipIf(!isDarwin || !realKeychainEnabled)("keychain (real macOS keychain)", () => {
  it("round-trips set -> get -> delete against the macOS keychain", async () => {
    setKeychainRunnerForTesting(undefined);
    const account = userInfo().username || "agentflow";
    const scope = `agentflow.test.${randomUUID().replace(/-/g, "")}`;
    const field = "token";
    const value = `agentflow_test_value_${randomUUID()}`;

    try {
      expect(await getSecret(scope, field, { account })).toBeUndefined();
      await setSecret(scope, field, value, { account });
      expect(await getSecret(scope, field, { account })).toBe(value);
      const removed = await deleteSecret(scope, field, { account });
      expect(removed).toBe(true);
      expect(await getSecret(scope, field, { account })).toBeUndefined();
    } finally {
      try {
        await deleteSecret(scope, field, { account });
      } catch {
        /* ignore */
      }
    }
  });
});
