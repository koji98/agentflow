import { spawn } from "node:child_process";
import { userInfo } from "node:os";

export interface KeychainEntry {
  scope: string;
  field: string;
}

export class KeychainError extends Error {
  readonly code: string;
  readonly stderr: string;

  constructor(message: string, code: string, stderr: string) {
    super(message);
    this.name = "KeychainError";
    this.code = code;
    this.stderr = stderr;
  }
}

function serviceName(scope: string, field: string): string {
  return `agentflow.${scope}.${field}`;
}

function defaultAccount(): string {
  try {
    const info = userInfo();
    return info.username || "agentflow";
  } catch {
    return "agentflow";
  }
}

interface SecurityResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface SecurityRunOptions {
  args: string[];
  stdin?: string;
}

function runSecurityCommand(options: SecurityRunOptions): Promise<SecurityResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("security", options.args, {
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}

export interface KeychainCommandRunner {
  (options: SecurityRunOptions): Promise<SecurityResult>;
}

let runner: KeychainCommandRunner = runSecurityCommand;

export function setKeychainRunnerForTesting(testRunner: KeychainCommandRunner | undefined): void {
  runner = testRunner ?? runSecurityCommand;
}

export interface KeychainOptions {
  account?: string;
}

export async function getSecret(
  scope: string,
  field: string,
  options: KeychainOptions = {}
): Promise<string | undefined> {
  const account = options.account ?? defaultAccount();
  const result = await runner({
    args: ["find-generic-password", "-s", serviceName(scope, field), "-a", account, "-w"]
  });

  if (result.exitCode === 0) {
    return result.stdout.replace(/\n$/, "");
  }

  if (
    result.exitCode === 44 ||
    /could not be found/i.test(result.stderr) ||
    /SecKeychainSearchCopyNext/i.test(result.stderr)
  ) {
    return undefined;
  }

  throw new KeychainError(
    `Keychain read failed for ${scope}.${field}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    `EXIT_${result.exitCode}`,
    result.stderr
  );
}

export async function setSecret(
  scope: string,
  field: string,
  value: string,
  options: KeychainOptions = {}
): Promise<void> {
  const account = options.account ?? defaultAccount();
  // We pass the secret via argv because `security add-generic-password` does
  // not accept the password on stdin. macOS scopes process arg listings to
  // the same user (ps aux from another user does not see the value), but
  // operators on a shared workstation should still keep this in mind.
  const result = await runner({
    args: [
      "add-generic-password",
      "-U",
      "-s",
      serviceName(scope, field),
      "-a",
      account,
      "-l",
      `Agentflow ${scope} ${field}`,
      "-w",
      value
    ]
  });

  if (result.exitCode !== 0) {
    throw new KeychainError(
      `Keychain write failed for ${scope}.${field}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      `EXIT_${result.exitCode}`,
      result.stderr
    );
  }
}

export async function deleteSecret(
  scope: string,
  field: string,
  options: KeychainOptions = {}
): Promise<boolean> {
  const account = options.account ?? defaultAccount();
  const result = await runner({
    args: ["delete-generic-password", "-s", serviceName(scope, field), "-a", account]
  });

  if (result.exitCode === 0) {
    return true;
  }

  if (
    result.exitCode === 44 ||
    /could not be found/i.test(result.stderr) ||
    /SecKeychainSearchCopyNext/i.test(result.stderr)
  ) {
    return false;
  }

  throw new KeychainError(
    `Keychain delete failed for ${scope}.${field}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    `EXIT_${result.exitCode}`,
    result.stderr
  );
}

export function keychainServiceName(scope: string, field: string): string {
  return serviceName(scope, field);
}
