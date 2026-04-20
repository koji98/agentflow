import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  credentialEnvVarName,
  deleteScope,
  getScopeFields,
  listScopes,
  putScope,
  resolveScope
} from "../../src/auth/store.js";
import { setKeychainRunnerForTesting, type KeychainCommandRunner } from "../../src/auth/keychain.js";

interface FakeKeychainHandle {
  store: Map<string, string>;
}

function setupFakeKeychain(): FakeKeychainHandle {
  const store = new Map<string, string>();

  const runner: KeychainCommandRunner = async (options) => {
    const args = options.args;
    const command = args[0];
    const sIdx = args.indexOf("-s");
    const aIdx = args.indexOf("-a");
    if (sIdx === -1 || aIdx === -1) {
      return { exitCode: 1, stdout: "", stderr: "missing args" };
    }
    const service = args[sIdx + 1]!;
    const account = args[aIdx + 1]!;
    const key = `${service}::${account}`;

    if (command === "find-generic-password") {
      const value = store.get(key);
      if (value === undefined) {
        return {
          exitCode: 44,
          stdout: "",
          stderr: "security: could not be found in the keychain"
        };
      }
      return { exitCode: 0, stdout: `${value}\n`, stderr: "" };
    }

    if (command === "add-generic-password") {
      const wIdx = args.indexOf("-w");
      if (wIdx === -1 || args[wIdx + 1] === undefined) {
        return { exitCode: 1, stdout: "", stderr: "missing -w value" };
      }
      store.set(key, args[wIdx + 1]!);
      return { exitCode: 0, stdout: "", stderr: "" };
    }

    if (command === "delete-generic-password") {
      if (!store.has(key)) {
        return { exitCode: 44, stdout: "", stderr: "could not be found" };
      }
      store.delete(key);
      return { exitCode: 0, stdout: "", stderr: "" };
    }

    return { exitCode: 1, stdout: "", stderr: `unknown command ${command ?? ""}` };
  };

  setKeychainRunnerForTesting(runner);
  return { store };
}

describe("auth store", () => {
  let tempRoot: string;
  let indexPath: string;
  let keychain: FakeKeychainHandle;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "agentflow-store-"));
    indexPath = join(tempRoot, "credentials.index.json");
    keychain = setupFakeKeychain();
  });

  afterEach(async () => {
    setKeychainRunnerForTesting(undefined);
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("stores secrets in keychain and non-secret fields in the index file", async () => {
    await putScope(
      {
        scope: "reddit-jira",
        identity: "Chidi",
        fields: [
          { key: "email", secret: false, value: "chidi@example.com" },
          { key: "token", secret: true, value: "atlassian_token_value" }
        ],
        verified_at: "2026-04-19T00:00:00.000Z"
      },
      { index_path: indexPath, account: "tester" }
    );

    const indexed = JSON.parse(await readFile(indexPath, "utf8"));
    expect(indexed.version).toBe("1");
    expect(indexed.scopes["reddit-jira"]).toEqual(
      expect.objectContaining({
        scope: "reddit-jira",
        identity: "Chidi",
        fields: { email: "chidi@example.com" },
        secret_keys: ["token"],
        last_verified_at: "2026-04-19T00:00:00.000Z"
      })
    );
    expect(indexed.scopes["reddit-jira"].stored_at).toBeDefined();

    const fileStat = await stat(indexPath);
    expect(fileStat.mode & 0o777).toBe(0o600);

    expect(keychain.store.get("agentflow.reddit-jira.token::tester")).toBe("atlassian_token_value");
    expect(keychain.store.has("agentflow.reddit-jira.email::tester")).toBe(false);
  });

  it("lists stored scopes sorted alphabetically", async () => {
    await putScope(
      {
        scope: "zeta",
        fields: [{ key: "token", secret: true, value: "z" }]
      },
      { index_path: indexPath, account: "tester" }
    );
    await putScope(
      {
        scope: "alpha",
        fields: [{ key: "token", secret: true, value: "a" }]
      },
      { index_path: indexPath, account: "tester" }
    );

    const scopes = await listScopes({ index_path: indexPath, account: "tester" });
    expect(scopes.map((s) => s.scope)).toEqual(["alpha", "zeta"]);
  });

  it("getScopeFields merges keychain secrets with index fields", async () => {
    await putScope(
      {
        scope: "reddit-jira",
        identity: "Chidi",
        fields: [
          { key: "email", secret: false, value: "chidi@example.com" },
          { key: "token", secret: true, value: "atlassian_token_value" }
        ]
      },
      { index_path: indexPath, account: "tester" }
    );

    const result = await getScopeFields("reddit-jira", { index_path: indexPath, account: "tester" });
    expect(result?.fields).toEqual({
      email: "chidi@example.com",
      token: "atlassian_token_value"
    });
    expect(result?.identity).toBe("Chidi");
  });

  it("deleteScope removes both the keychain secret and the index entry", async () => {
    await putScope(
      {
        scope: "reddit-drone",
        fields: [{ key: "token", secret: true, value: "drone_token" }]
      },
      { index_path: indexPath, account: "tester" }
    );

    expect(keychain.store.get("agentflow.reddit-drone.token::tester")).toBe("drone_token");

    const removed = await deleteScope("reddit-drone", { index_path: indexPath, account: "tester" });
    expect(removed).toBe(true);
    expect(keychain.store.has("agentflow.reddit-drone.token::tester")).toBe(false);

    const list = await listScopes({ index_path: indexPath });
    expect(list).toEqual([]);
  });

  it("deleteScope returns false when the scope is not stored", async () => {
    const removed = await deleteScope("ghost", { index_path: indexPath, account: "tester" });
    expect(removed).toBe(false);
  });

  it("computes credential env var names with uppercased scope and key", () => {
    expect(credentialEnvVarName("reddit-drone", "token")).toBe(
      "AGENTFLOW_CREDENTIAL_REDDIT_DRONE_TOKEN"
    );
  });

  it("resolveScope prefers env var override over keychain", async () => {
    await putScope(
      {
        scope: "reddit-drone",
        fields: [{ key: "token", secret: true, value: "stored_value" }]
      },
      { index_path: indexPath, account: "tester" }
    );

    const result = await resolveScope(
      {
        scope: "reddit-drone",
        fields: [{ key: "token", secret: true, required: true }]
      },
      {
        index_path: indexPath,
        account: "tester",
        env: { AGENTFLOW_CREDENTIAL_REDDIT_DRONE_TOKEN: "env_override_value" }
      }
    );

    expect(result.resolved.token).toBe("env_override_value");
    expect(result.entries[0]?.source).toBe("env");
    expect(result.missing_required).toEqual([]);
  });

  it("resolveScope falls back to keychain when env override is absent", async () => {
    await putScope(
      {
        scope: "reddit-drone",
        fields: [{ key: "token", secret: true, value: "stored_value" }]
      },
      { index_path: indexPath, account: "tester" }
    );

    const result = await resolveScope(
      {
        scope: "reddit-drone",
        fields: [{ key: "token", secret: true, required: true }]
      },
      { index_path: indexPath, account: "tester", env: {} }
    );

    expect(result.resolved.token).toBe("stored_value");
    expect(result.entries[0]?.source).toBe("keychain");
    expect(result.missing_required).toEqual([]);
  });

  it("resolveScope falls back to defaults and reports missing required fields", async () => {
    const result = await resolveScope(
      {
        scope: "reddit-drone",
        fields: [
          { key: "token", secret: true, required: true },
          { key: "mode", secret: false, required: false, default: "production" }
        ]
      },
      { index_path: indexPath, account: "tester", env: {} }
    );

    expect(result.resolved).toEqual({ mode: "production" });
    expect(result.missing_required).toEqual(["token"]);
    expect(result.entries.find((e) => e.key === "mode")?.source).toBe("default");
    expect(result.entries.find((e) => e.key === "token")?.source).toBe("missing");
  });

  it("resolveScope reads non-secret fields from the index", async () => {
    await putScope(
      {
        scope: "reddit-jira",
        fields: [
          { key: "email", secret: false, value: "chidi@example.com" },
          { key: "token", secret: true, value: "jira_token" }
        ]
      },
      { index_path: indexPath, account: "tester" }
    );

    const result = await resolveScope(
      {
        scope: "reddit-jira",
        fields: [
          { key: "email", secret: false, required: true },
          { key: "token", secret: true, required: true }
        ]
      },
      { index_path: indexPath, account: "tester", env: {} }
    );

    expect(result.resolved).toEqual({
      email: "chidi@example.com",
      token: "jira_token"
    });
    const emailEntry = result.entries.find((e) => e.key === "email");
    expect(emailEntry?.source).toBe("index");
  });
});
