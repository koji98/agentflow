import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentInvocation } from "./types.js";

interface HelperSession {
  agent_id: string;
  status: string;
  started_at?: string;
  parent_metadata_path?: string;
  artifacts?: Record<string, string>;
}

interface AfBrokerRequest {
  id: string;
  argv: string[];
  cwd?: string;
  stdin_path?: string;
}

function helperArtifactName(session: HelperSession): string {
  return Object.keys(session.artifacts ?? {})[0] ?? "helper-report.md";
}

async function readHelperSession(path: string): Promise<HelperSession | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as HelperSession;
  } catch {
    return undefined;
  }
}

export function startSpawnBroker(invocation: AgentInvocation): { stop(): void } {
  const runtimeDir = invocation.runtimeDir;
  const afRunner = invocation.toolEnv?.AGENTFLOW_AF_RUNNER;
  const afCli = invocation.toolEnv?.AGENTFLOW_AF_CLI;
  const afBrokerDir = invocation.toolEnv?.AGENTFLOW_AF_BROKER_DIR;

  if (!runtimeDir || !afRunner || !afCli) {
    return { stop() {} };
  }
  const runtimeDirValue = runtimeDir;
  const afRunnerValue = afRunner;
  const afCliValue = afCli;
  const afBrokerDirValue = afBrokerDir;

  const launched = new Set<string>();
  const handledAfRequests = new Set<string>();
  let stopped = false;

  async function runAfBrokerRequest(request: AfBrokerRequest): Promise<void> {
    if (!afBrokerDirValue || handledAfRequests.has(request.id)) {
      return;
    }

    handledAfRequests.add(request.id);
    const responsePath = join(afBrokerDirValue, "responses", `${request.id}.json`);
    let stdin = "";
    if (request.stdin_path) {
      stdin = await readFile(request.stdin_path, "utf8").catch(() => "");
    }

    const result = await new Promise<{
      exit_code: number;
      stdout: string;
      stderr: string;
      error?: string;
    }>((resolveResult) => {
      const child = spawn(
        afRunnerValue,
        [afCliValue, ...request.argv],
        {
          cwd: request.cwd || invocation.repoPath,
          env: {
            ...process.env,
            ...invocation.toolEnv,
            AGENTFLOW_AF_BROKER_CHILD: "1"
          },
          stdio: ["pipe", "pipe", "pipe"]
        }
      );
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.on("error", (error) => {
        resolveResult({
          exit_code: 127,
          stdout: "",
          stderr: "",
          error: error instanceof Error ? error.message : String(error)
        });
      });
      child.on("close", (code) => {
        resolveResult({
          exit_code: typeof code === "number" ? code : 1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8")
        });
      });
      child.stdin.end(stdin);
    });

    await mkdir(join(afBrokerDirValue, "responses"), { recursive: true });
    await writeFile(responsePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }

  async function pollAfBroker(): Promise<void> {
    if (!afBrokerDirValue || stopped) {
      return;
    }

    const requestsDir = join(afBrokerDirValue, "requests");
    let entries: string[];
    try {
      entries = await readdir(requestsDir);
    } catch {
      return;
    }

    await Promise.all(entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => {
        const requestId = entry.replace(/\.json$/u, "");
        if (handledAfRequests.has(requestId)) {
          return;
        }
        const request = await readFile(join(requestsDir, entry), "utf8")
          .then((content) => JSON.parse(content) as AfBrokerRequest)
          .catch(() => undefined);
        if (!request || request.id !== requestId || !Array.isArray(request.argv)) {
          return;
        }
        await runAfBrokerRequest(request);
      }));
  }

  async function poll(): Promise<void> {
    if (stopped) {
      return;
    }

    await pollAfBroker();

    const helpersDir = join(runtimeDirValue, "helpers");
    let entries: string[];
    try {
      entries = await readdir(helpersDir);
    } catch {
      return;
    }

    await Promise.all(entries.map(async (entry) => {
      if (launched.has(entry)) {
        return;
      }

      const sessionPath = join(helpersDir, entry, "session.json");
      const session = await readHelperSession(sessionPath);
      if (!session || session.status !== "starting" || session.started_at || !session.parent_metadata_path) {
        return;
      }

      launched.add(entry);
      const child = spawn(
        afRunnerValue,
        [
          afCliValue,
          "_helper-run",
          "--metadata",
          session.parent_metadata_path,
          "--helper",
          session.agent_id,
          "--artifact",
          helperArtifactName(session)
        ],
        {
          cwd: invocation.repoPath,
          detached: true,
          stdio: "ignore",
          env: {
            ...process.env,
            AGENTFLOW_RUNTIME_METADATA: session.parent_metadata_path
          }
        }
      );
      child.unref();
    }));
  }

  const timer = setInterval(() => {
    void poll();
  }, 250);
  void poll();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      if (afBrokerDirValue) {
        void rm(afBrokerDirValue, { recursive: true, force: true });
      }
    }
  };
}
