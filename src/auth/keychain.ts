import { execFile, spawn } from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";

import type { CredentialFieldRef } from "./types.js";

const execFileAsync = promisify(execFile);

export interface KeychainAdapter {
  getSecret(ref: CredentialFieldRef): Promise<string | undefined>;
  setSecret(ref: CredentialFieldRef, value: string): Promise<void>;
  deleteSecret(ref: CredentialFieldRef): Promise<void>;
}

export interface MacOSKeychainOptions {
  account?: string;
  service_prefix?: string;
}

function serviceName(ref: CredentialFieldRef, prefix: string): string {
  return `${prefix}.${ref.scope}.${ref.key}`;
}

const swiftSetGenericPasswordScript = `
import Darwin
import Foundation
import Security

let service = CommandLine.arguments[1]
let account = CommandLine.arguments[2]
let passwordData = FileHandle.standardInput.readDataToEndOfFile()

let query: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: service,
  kSecAttrAccount as String: account
]

let update: [String: Any] = [
  kSecValueData as String: passwordData
]
var status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
if status == errSecItemNotFound {
  var addQuery = query
  addQuery[kSecValueData as String] = passwordData
  status = SecItemAdd(addQuery as CFDictionary, nil)
}
if status != errSecSuccess {
  FileHandle.standardError.write("Keychain write failed with status \\(status)\\n".data(using: .utf8)!)
  exit(1)
}
`;

const swiftGetGenericPasswordScript = `
import Darwin
import Foundation
import Security

let service = CommandLine.arguments[1]
let account = CommandLine.arguments[2]

let query: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: service,
  kSecAttrAccount as String: account,
  kSecReturnData as String: true,
  kSecMatchLimit as String: kSecMatchLimitOne
]

var item: CFTypeRef?
let status = SecItemCopyMatching(query as CFDictionary, &item)
if status == errSecItemNotFound {
  exit(44)
}
if status != errSecSuccess {
  FileHandle.standardError.write("SecItemCopyMatching failed with status \\(status)\\n".data(using: .utf8)!)
  exit(1)
}
if let data = item as? Data {
  FileHandle.standardOutput.write(data)
}
`;

const swiftDeleteGenericPasswordScript = `
import Foundation
import Security

let service = CommandLine.arguments[1]
let account = CommandLine.arguments[2]

let query: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: service,
  kSecAttrAccount as String: account
]

SecItemDelete(query as CFDictionary)
`;

export function createMacOSKeychainAdapter(options: MacOSKeychainOptions = {}): KeychainAdapter {
  const account = options.account ?? userInfo().username;
  const servicePrefix = options.service_prefix ?? "agentflow";

  function runSwiftWithSecretOnStdin(args: string[], value: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn("swift", args, {
        stdio: ["pipe", "ignore", "pipe"]
      });
      const stderrChunks: Buffer[] = [];

      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(new Error(stderr || `security exited with status ${code ?? "unknown"}.`));
      });

      child.stdin.end(value);
    });
  }

  async function getSecret(ref: CredentialFieldRef): Promise<string | undefined> {
    if (process.platform !== "darwin") {
      return undefined;
    }

    try {
      const result = await execFileAsync("swift", [
        "-e",
        swiftGetGenericPasswordScript,
        serviceName(ref, servicePrefix),
        account
      ]);
      const value = String(result.stdout);
      return value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  async function setSecret(ref: CredentialFieldRef, value: string): Promise<void> {
    if (process.platform !== "darwin") {
      throw new Error("Agentflow credential secrets require macOS Keychain on this platform.");
    }

    await runSwiftWithSecretOnStdin([
      "-e",
      swiftSetGenericPasswordScript,
      serviceName(ref, servicePrefix),
      account
    ], value);
  }

  async function deleteSecret(ref: CredentialFieldRef): Promise<void> {
    if (process.platform !== "darwin") {
      return;
    }

    try {
      await execFileAsync("swift", [
        "-e",
        swiftDeleteGenericPasswordScript,
        serviceName(ref, servicePrefix),
        account
      ]);
    } catch {
      // Deleting a missing secret is idempotent from Agentflow's perspective.
    }
  }

  return {
    getSecret,
    setSecret,
    deleteSecret
  };
}
