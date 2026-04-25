import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentInvocation } from "./types.js";

interface HelperSession {
  agent_id: string;
  status: string;
  started_at?: string;
  parent_metadata_path?: string;
  artifacts?: Record<string, string>;
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

  if (!runtimeDir || !afRunner || !afCli) {
    return { stop() {} };
  }
  const runtimeDirValue = runtimeDir;
  const afRunnerValue = afRunner;
  const afCliValue = afCli;

  const launched = new Set<string>();
  let stopped = false;

  async function poll(): Promise<void> {
    if (stopped) {
      return;
    }

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
    }
  };
}
