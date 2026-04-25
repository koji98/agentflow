import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCredentialStore } from "../../src/auth/store.js";

describe("credential store", () => {
  let tempRoot: string;
  let indexPath: string;
  let secrets: Map<string, string>;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "agentflow-auth-store-"));
    await mkdir(tempRoot, { recursive: true });
    indexPath = join(tempRoot, "credentials.index.json");
    secrets = new Map<string, string>();
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("stores secret fields in the keychain adapter and keeps only metadata in the index", async () => {
    const store = createCredentialStore({
      index_path: indexPath,
      keychain: {
        async getSecret(ref) {
          return secrets.get(`${ref.scope}.${ref.key}`);
        },
        async setSecret(ref, value) {
          secrets.set(`${ref.scope}.${ref.key}`, value);
        },
        async deleteSecret(ref) {
          secrets.delete(`${ref.scope}.${ref.key}`);
        }
      }
    });

    await store.setField({ scope: "github", key: "token", value: "ghp_real", secret: true });
    await store.setField({ scope: "github", key: "host", value: "api.github.com", secret: false });

    const rawIndex = await readFile(indexPath, "utf8");
    expect(rawIndex).not.toContain("ghp_real");
    expect(rawIndex).toContain("api.github.com");
    expect(secrets.get("github.token")).toBe("ghp_real");

    await expect(
      store.resolveScope({
        fields: {
          token: { secret: true, required: true },
          host: { secret: false, required: true }
        }
      }, "github")
    ).resolves.toEqual({
      token: "ghp_real",
      host: "api.github.com"
    });
  });

  it("reports missing required credential fields without including secret values", async () => {
    const store = createCredentialStore({
      index_path: indexPath,
      keychain: {
        async getSecret() {
          return undefined;
        },
        async setSecret() {},
        async deleteSecret() {}
      }
    });

    await expect(
      store.resolveScope({
        fields: {
          token: { secret: true, required: true }
        }
      }, "github")
    ).rejects.toThrow('Missing required credential "github.token".');
  });

  it("removes empty scopes after the final field is deleted", async () => {
    const store = createCredentialStore({
      index_path: indexPath,
      keychain: {
        async getSecret(ref) {
          return secrets.get(`${ref.scope}.${ref.key}`);
        },
        async setSecret(ref, value) {
          secrets.set(`${ref.scope}.${ref.key}`, value);
        },
        async deleteSecret(ref) {
          secrets.delete(`${ref.scope}.${ref.key}`);
        }
      }
    });

    await store.setField({ scope: "github", key: "token", value: "ghp_real", secret: true });
    await store.deleteField("github", "token");

    await expect(store.listMetadata()).resolves.toEqual({});
    expect(secrets.has("github.token")).toBe(false);
    expect(await readFile(indexPath, "utf8")).not.toContain("github");
  });
});
