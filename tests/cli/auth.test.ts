import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeCli } from "../../src/cli/index.js";

describe("auth CLI", () => {
  let tempRoot: string;
  let indexPath: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "agentflow-auth-cli-"));
    indexPath = join(tempRoot, "credentials.index.json");
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("sets, lists, and deletes non-secret credential fields without printing values", async () => {
    const set = await executeCli([
      "auth",
      "set",
      "--index",
      indexPath,
      "--scope",
      "github",
      "--key",
      "host",
      "--value",
      "api.github.com"
    ]);
    expect(set.exitCode, set.stdout).toBe(0);
    expect(set.stdout).not.toContain("api.github.com");

    const list = await executeCli(["auth", "list", "--index", indexPath]);
    expect(list.exitCode, list.stdout).toBe(0);
    expect(list.stdout).not.toContain("api.github.com");
    expect(JSON.parse(list.stdout).credentials).toEqual({
      github: {
        host: expect.objectContaining({
          configured: true,
          secret: false
        })
      }
    });

    const rawIndex = await readFile(indexPath, "utf8");
    expect(rawIndex).toContain("api.github.com");

    const deleted = await executeCli([
      "auth",
      "delete",
      "--index",
      indexPath,
      "--scope",
      "github",
      "--key",
      "host"
    ]);
    expect(deleted.exitCode, deleted.stdout).toBe(0);

    const empty = await executeCli(["auth", "list", "--index", indexPath]);
    expect(JSON.parse(empty.stdout).credentials.github ?? {}).toEqual({});
  });

  it("requires stdin for secret values so they are not placed in the CLI argv", async () => {
    const set = await executeCli([
      "auth",
      "set",
      "--index",
      indexPath,
      "--scope",
      "github",
      "--key",
      "token",
      "--secret",
      "--value",
      "ghp_should_not_be_argv"
    ]);

    expect(set.exitCode).toBe(2);
    expect(set.stdout).toContain("Secret values must be provided with --value-stdin");
    expect(set.stdout).not.toContain("ghp_should_not_be_argv");
  });

  it("rejects options that do not apply to the selected auth subcommand", async () => {
    const list = await executeCli(["auth", "list", "--index", indexPath, "--value", "unused"]);
    expect(list.exitCode).toBe(2);
    expect(list.stdout).toContain("Unexpected option(s) for auth subcommand: --value");

    const deleted = await executeCli([
      "auth",
      "delete",
      "--index",
      indexPath,
      "--scope",
      "github",
      "--key",
      "host",
      "--secret"
    ]);
    expect(deleted.exitCode).toBe(2);
    expect(deleted.stdout).toContain("Unexpected option(s) for auth subcommand: --secret");
  });

  it("fails loudly when the credential index is malformed", async () => {
    await writeFile(indexPath, "{not-json", "utf8");

    const list = await executeCli(["auth", "list", "--index", indexPath]);
    expect(list.exitCode).toBe(1);
    expect(list.stdout).toContain("Failed to read credential index");
  });
});
