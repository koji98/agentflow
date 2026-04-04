import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RunOwnerRecord {
  owner_pid?: number;
  owner_started_at?: string;
  owner_hostname?: string;
}

function readErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isProcessReachable(pid: number | undefined): boolean | undefined {
  if (!Number.isInteger(pid) || pid === undefined || pid <= 0) {
    return undefined;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = readErrorCode(error);

    if (code === "EPERM") {
      return true;
    }

    if (code === "ESRCH") {
      return false;
    }

    return undefined;
  }
}

async function readProcessStartedAt(pid: number): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }

  if (process.platform === "win32") {
    const command = `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString("o")`;

    for (const binary of ["powershell.exe", "pwsh.exe", "powershell", "pwsh"]) {
      try {
        const { stdout } = await execFileAsync(
          binary,
          ["-NoProfile", "-Command", command],
          {
            encoding: "utf8"
          }
        );
        const normalized = stdout.trim();

        if (normalized.length > 0) {
          return normalized;
        }
      } catch {
        // Try the next available shell.
      }
    }

    return undefined;
  }

  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "lstart="],
      {
        encoding: "utf8"
      }
    );
    const normalized = stdout.trim().replace(/\s+/g, " ");

    return normalized.length > 0 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

export async function createRunOwnerRecord(pid = process.pid): Promise<RunOwnerRecord> {
  const owner_started_at = await readProcessStartedAt(pid);

  return {
    owner_pid: pid,
    owner_hostname: hostname(),
    ...(owner_started_at ? { owner_started_at } : {})
  };
}

export async function isRecordedRunOwnerActive(
  owner: RunOwnerRecord
): Promise<boolean | undefined> {
  if (!Number.isInteger(owner.owner_pid) || owner.owner_pid === undefined || owner.owner_pid <= 0) {
    return undefined;
  }

  if (owner.owner_hostname && owner.owner_hostname !== hostname()) {
    return false;
  }

  const reachable = isProcessReachable(owner.owner_pid);

  if (reachable !== true) {
    return reachable;
  }

  if (!owner.owner_started_at) {
    return true;
  }

  const liveStartedAt = await readProcessStartedAt(owner.owner_pid);

  if (!liveStartedAt) {
    return undefined;
  }

  return liveStartedAt === owner.owner_started_at;
}
