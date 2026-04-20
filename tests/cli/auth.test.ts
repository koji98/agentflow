import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  setAuthCommandHooksForTesting,
  type AuthCommandHooks
} from "../../src/cli/commands/auth.js";
import { executeCli } from "../../src/cli/index.js";
import {
  setKeychainRunnerForTesting,
  type KeychainCommandRunner
} from "../../src/auth/keychain.js";
import { listScopes } from "../../src/auth/store.js";

const execFileAsync = promisify(execFile);

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

async function initGitRepo(repoDir: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "agentflow@example.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "Agentflow Tests"], { cwd: repoDir });
}

async function commitAll(repoDir: string, message: string): Promise<void> {
  await execFileAsync("git", ["add", "."], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", message], { cwd: repoDir });
}

interface PluginFixture {
  pluginDir: string;
  graphPath: string;
  repoDir: string;
}

async function createCredentialPluginFixture(tempRoot: string): Promise<PluginFixture> {
  const pluginDir = join(tempRoot, "drone-plugin");
  await mkdir(join(pluginDir, "workflows", "ping"), { recursive: true });

  await writeFile(
    join(pluginDir, "agentflow.plugin.json"),
    JSON.stringify(
      {
        schema: "agentflow.plugin/1",
        id: "drone",
        version: "0.1.0",
        credentials: {
          drone_user: {
            scope: "reddit-drone",
            fields: [{ key: "token", secret: true, required: true, prompt: "Drone token" }],
            login: {
              type: "pat-paste",
              open_url: "https://drone.example.com/account",
              instructions: "Copy the token from the Drone UI.",
              verify: {
                method: "GET",
                url: "https://drone.example.com/api/user",
                auth: {
                  kind: "header",
                  header_name: "Authorization",
                  header_value_template: "Bearer {token}"
                },
                ok_when_status: 200,
                extract_identity: "$.login"
              }
            }
          }
        },
        workflows: {
          ping: {
            path: "./workflows/ping/workflow.json",
            description: "Plugin workflow that uses the drone credential."
          }
        }
      },
      null,
      2
    )
  );
  await writeFile(
    join(pluginDir, "workflows", "ping", "workflow.json"),
    JSON.stringify(
      {
        schema: "agentflow.workflow/1",
        id: "ping",
        config_schema: "./config.schema.json",
        graph: "./workflow.graph.json",
        publish_node: "ping",
        published_artifacts: {
          packet: { from: "output_dir", path: "packet.json", description: "Packet." }
        }
      },
      null,
      2
    )
  );
  await writeFile(
    join(pluginDir, "workflows", "ping", "config.schema.json"),
    JSON.stringify(
      {
        type: "object",
        properties: {},
        additionalProperties: false
      },
      null,
      2
    )
  );
  await writeFile(
    join(pluginDir, "workflows", "ping", "workflow.graph.json"),
    JSON.stringify(
      {
        type: "agent",
        id: "ping",
        repo: "main",
        prompt: "Ping the drone API."
      },
      null,
      2
    )
  );

  await initGitRepo(pluginDir);
  await commitAll(pluginDir, "fixture plugin");

  const repoDir = join(tempRoot, "repo");
  await mkdir(repoDir, { recursive: true });
  await initGitRepo(repoDir);
  await writeFile(join(repoDir, "README.md"), "repo\n");
  await commitAll(repoDir, "fixture repo");

  const graphPath = join(tempRoot, "graph.json");
  await writeFile(
    graphPath,
    JSON.stringify(
      {
        version: "1",
        graph_id: "auth-cli-test",
        plugins: { drone: { source: pluginDir, ref: "HEAD" } },
        repos: { main: { path: "./repo" } },
        defaults: { launch_profile: "default", workspace_backend: "inplace" },
        profiles: { default: { harness: "codex-cli" } },
        graph: {
          type: "sequence",
          id: "root",
          steps: [{ type: "plugin", id: "ping", uses: "drone/ping" }]
        }
      },
      null,
      2
    )
  );

  return { pluginDir, graphPath, repoDir };
}

interface SilentStreams {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  stderr: NodeJS.WritableStream & { isTTY?: boolean };
}

function silentStreams(): SilentStreams {
  const sink = {
    write: () => true,
    end: () => true
  } as unknown as NodeJS.WritableStream & { isTTY?: boolean };
  return {
    stdin: process.stdin,
    stdout: sink,
    stderr: sink
  };
}

describe("agentflow auth CLI", () => {
  let tempRoot: string;
  let indexPath: string;
  let keychain: FakeKeychainHandle;
  let activeHooks: AuthCommandHooks;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "agentflow-auth-cli-"));
    indexPath = join(tempRoot, "credentials.index.json");
    keychain = setupFakeKeychain();
    activeHooks = {
      account: "tester",
      index_path: indexPath,
      env: {},
      streams: silentStreams()
    };
    setAuthCommandHooksForTesting(activeHooks);
  });

  afterEach(async () => {
    setAuthCommandHooksForTesting(undefined);
    setKeychainRunnerForTesting(undefined);
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("requires a subcommand", async () => {
    const result = await executeCli(["auth"], tempRoot);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("Missing auth subcommand");
  });

  it("rejects unknown subcommands", async () => {
    const result = await executeCli(["auth", "weird"], tempRoot);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("Unknown auth subcommand: weird");
  });

  it("login fails fast when --graph is missing", async () => {
    const result = await executeCli(["auth", "login", "reddit-drone"], tempRoot);
    expect(result.exitCode).toBe(2);
    const payload = JSON.parse(result.stdout);
    expect(payload.command).toBe("auth login");
    expect(payload.scope).toBe("reddit-drone");
    expect(payload.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "--graph",
          message: expect.stringContaining("require --graph")
        })
      ])
    );
  });

  it("login fails when the scope is not declared by any resolved plugin", async () => {
    const fixture = await createCredentialPluginFixture(tempRoot);
    await executeCli(["plugin", "resolve", "--graph", fixture.graphPath], tempRoot);

    const result = await executeCli(
      ["auth", "login", "ghost-scope", "--graph", fixture.graphPath],
      tempRoot
    );
    expect(result.exitCode).toBe(2);
    const payload = JSON.parse(result.stdout);
    expect(payload.diagnostics[0].message).toContain('"ghost-scope"');
  });

  it("login verifies, stores secrets in the keychain, and surfaces the identity", async () => {
    const fixture = await createCredentialPluginFixture(tempRoot);
    await executeCli(["plugin", "resolve", "--graph", fixture.graphPath], tempRoot);

    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    activeHooks.fetchImpl = (async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({ url, headers });
      return new Response(JSON.stringify({ login: "chidi-drone-user" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
    activeHooks.promptValue = async () => "drone_token_value";
    activeHooks.openUrl = async () => undefined;

    const result = await executeCli(
      ["auth", "login", "reddit-drone", "--graph", fixture.graphPath],
      tempRoot
    );

    expect(result.exitCode, result.stdout).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      command: "auth login",
      status: "passed",
      scope: "reddit-drone",
      identity: "chidi-drone-user"
    });
    expect(payload.fields_stored).toEqual([{ key: "token", secret: true }]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://drone.example.com/api/user");
    expect(requests[0]?.headers.Authorization).toBe("Bearer drone_token_value");

    expect(keychain.store.get("agentflow.reddit-drone.token::tester")).toBe(
      "drone_token_value"
    );

    const stored = await listScopes({ index_path: indexPath, account: "tester" });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.identity).toBe("chidi-drone-user");
    expect(stored[0]?.secret_keys).toEqual(["token"]);
  });

  it("login reports a verify failure without storing credentials", async () => {
    const fixture = await createCredentialPluginFixture(tempRoot);
    await executeCli(["plugin", "resolve", "--graph", fixture.graphPath], tempRoot);

    activeHooks.fetchImpl = (async () =>
      new Response("nope", { status: 401 })) as typeof fetch;
    activeHooks.promptValue = async () => "bad_token";
    activeHooks.openUrl = async () => undefined;

    const result = await executeCli(
      ["auth", "login", "reddit-drone", "--graph", fixture.graphPath],
      tempRoot
    );

    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout);
    expect(payload.status).toBe("failed");
    expect(payload.verify_status).toBe(401);
    expect(keychain.store.has("agentflow.reddit-drone.token::tester")).toBe(false);
  });

  it("login reports missing required fields when prompts are skipped", async () => {
    const fixture = await createCredentialPluginFixture(tempRoot);
    await executeCli(["plugin", "resolve", "--graph", fixture.graphPath], tempRoot);

    activeHooks.promptValue = async () => undefined;
    activeHooks.openUrl = async () => undefined;
    activeHooks.fetchImpl = (async () => new Response("", { status: 200 })) as typeof fetch;

    const result = await executeCli(
      ["auth", "login", "reddit-drone", "--graph", fixture.graphPath],
      tempRoot
    );

    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout);
    expect(payload.status).toBe("failed");
    expect(payload.missing_fields).toEqual(["token"]);
  });

  it("list reports an empty array when nothing is stored", async () => {
    const result = await executeCli(["auth", "list"], tempRoot);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({ command: "auth list", status: "passed", scopes: [] });
  });

  it("list reports stored scopes after login", async () => {
    const fixture = await createCredentialPluginFixture(tempRoot);
    await executeCli(["plugin", "resolve", "--graph", fixture.graphPath], tempRoot);

    activeHooks.fetchImpl = (async () =>
      new Response(JSON.stringify({ login: "chidi" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })) as typeof fetch;
    activeHooks.promptValue = async () => "drone_token_value";
    activeHooks.openUrl = async () => undefined;

    const loginResult = await executeCli(
      ["auth", "login", "reddit-drone", "--graph", fixture.graphPath],
      tempRoot
    );
    expect(loginResult.exitCode, loginResult.stdout).toBe(0);

    const list = await executeCli(["auth", "list"], tempRoot);
    expect(list.exitCode).toBe(0);
    const payload = JSON.parse(list.stdout);
    expect(payload.scopes).toHaveLength(1);
    expect(payload.scopes[0]).toMatchObject({
      scope: "reddit-drone",
      identity: "chidi",
      non_secret_fields: [],
      secret_keys: ["token"]
    });
  });

  it("status fails when no credentials have been stored for the scope", async () => {
    const fixture = await createCredentialPluginFixture(tempRoot);
    await executeCli(["plugin", "resolve", "--graph", fixture.graphPath], tempRoot);

    const result = await executeCli(
      ["auth", "status", "reddit-drone", "--graph", fixture.graphPath],
      tempRoot
    );
    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout);
    expect(payload.message).toContain("No credentials stored");
  });

  it("status re-runs the verify call against stored credentials", async () => {
    const fixture = await createCredentialPluginFixture(tempRoot);
    await executeCli(["plugin", "resolve", "--graph", fixture.graphPath], tempRoot);

    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    activeHooks.fetchImpl = (async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, headers });
      return new Response(JSON.stringify({ login: "chidi" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
    activeHooks.promptValue = async () => "drone_token_value";
    activeHooks.openUrl = async () => undefined;

    await executeCli(
      ["auth", "login", "reddit-drone", "--graph", fixture.graphPath],
      tempRoot
    );

    const result = await executeCli(
      ["auth", "status", "reddit-drone", "--graph", fixture.graphPath],
      tempRoot
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      command: "auth status",
      status: "passed",
      scope: "reddit-drone",
      verify_status: 200
    });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[1]?.headers.Authorization).toBe("Bearer drone_token_value");
  });

  it("logout removes a stored scope", async () => {
    const fixture = await createCredentialPluginFixture(tempRoot);
    await executeCli(["plugin", "resolve", "--graph", fixture.graphPath], tempRoot);

    activeHooks.fetchImpl = (async () =>
      new Response(JSON.stringify({ login: "chidi" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })) as typeof fetch;
    activeHooks.promptValue = async () => "drone_token_value";
    activeHooks.openUrl = async () => undefined;

    await executeCli(
      ["auth", "login", "reddit-drone", "--graph", fixture.graphPath],
      tempRoot
    );

    expect(keychain.store.has("agentflow.reddit-drone.token::tester")).toBe(true);

    const result = await executeCli(["auth", "logout", "reddit-drone"], tempRoot);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      command: "auth logout",
      status: "passed",
      scope: "reddit-drone",
      removed: true
    });
    expect(keychain.store.has("agentflow.reddit-drone.token::tester")).toBe(false);
  });

  it("logout reports a noop when nothing was stored", async () => {
    const result = await executeCli(["auth", "logout", "ghost"], tempRoot);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({ status: "noop", removed: false });
  });

  it("set requires both --scope and --key", async () => {
    const result = await executeCli(["auth", "set"], tempRoot);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("Missing required option");
  });

  it("set updates a single field via the keychain", async () => {
    const fixture = await createCredentialPluginFixture(tempRoot);
    await executeCli(["plugin", "resolve", "--graph", fixture.graphPath], tempRoot);

    activeHooks.promptValue = async () => "rotated_token";

    const result = await executeCli(
      [
        "auth",
        "set",
        "--scope",
        "reddit-drone",
        "--key",
        "token",
        "--graph",
        fixture.graphPath
      ],
      tempRoot
    );
    expect(result.exitCode, result.stdout).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      command: "auth set",
      status: "passed",
      scope: "reddit-drone",
      key: "token",
      secret: true
    });
    expect(keychain.store.get("agentflow.reddit-drone.token::tester")).toBe("rotated_token");
  });

  it("set rejects unknown field keys", async () => {
    const fixture = await createCredentialPluginFixture(tempRoot);
    await executeCli(["plugin", "resolve", "--graph", fixture.graphPath], tempRoot);

    const result = await executeCli(
      [
        "auth",
        "set",
        "--scope",
        "reddit-drone",
        "--key",
        "no_such_key",
        "--graph",
        fixture.graphPath
      ],
      tempRoot
    );
    expect(result.exitCode).toBe(2);
    const payload = JSON.parse(result.stdout);
    expect(payload.message).toContain('"no_such_key"');
  });
});
