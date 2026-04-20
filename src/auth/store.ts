import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import * as keychain from "./keychain.js";

export interface IndexedScope {
  scope: string;
  fields: Record<string, string>;
  secret_keys: string[];
  identity?: string;
  stored_at?: string;
  last_verified_at?: string;
}

export interface CredentialIndex {
  version: "1";
  scopes: Record<string, IndexedScope>;
}

export interface StoreOptions {
  index_path?: string;
  account?: string;
}

export interface StoredScopeFields {
  scope: string;
  fields: Record<string, string>;
  identity?: string;
  stored_at?: string;
  last_verified_at?: string;
}

export interface ResolvedFieldEntry {
  key: string;
  secret: boolean;
  value: string | undefined;
  source: "env" | "keychain" | "index" | "default" | "missing";
}

export interface PutScopeArgs {
  scope: string;
  identity?: string;
  fields: Array<{ key: string; secret: boolean; value: string }>;
  verified_at?: string;
}

const DEFAULT_INDEX_PATH = join(homedir(), ".agentflow", "credentials.index.json");

function indexPathFromOptions(options: StoreOptions): string {
  return options.index_path ?? DEFAULT_INDEX_PATH;
}

function keychainOptions(options: StoreOptions): keychain.KeychainOptions {
  return options.account !== undefined ? { account: options.account } : {};
}

function emptyIndex(): CredentialIndex {
  return { version: "1", scopes: {} };
}

async function readIndex(options: StoreOptions): Promise<CredentialIndex> {
  const path = indexPathFromOptions(options);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyIndex();
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as CredentialIndex;
    if (!parsed || typeof parsed !== "object" || parsed.version !== "1" || typeof parsed.scopes !== "object") {
      return emptyIndex();
    }
    return parsed;
  } catch {
    return emptyIndex();
  }
}

async function writeIndex(index: CredentialIndex, options: StoreOptions): Promise<void> {
  const path = indexPathFromOptions(options);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  try {
    await chmod(path, 0o600);
  } catch {
    /* ignore chmod failures on FS that don't support it */
  }
}

export async function listScopes(options: StoreOptions = {}): Promise<IndexedScope[]> {
  const index = await readIndex(options);
  return Object.values(index.scopes).sort((a, b) => a.scope.localeCompare(b.scope));
}

export async function getScope(scope: string, options: StoreOptions = {}): Promise<IndexedScope | undefined> {
  const index = await readIndex(options);
  return index.scopes[scope];
}

export async function putScope(args: PutScopeArgs, options: StoreOptions = {}): Promise<IndexedScope> {
  const index = await readIndex(options);
  const now = new Date().toISOString();

  const nonSecretFields: Record<string, string> = {};
  const secretKeys: string[] = [];

  const kcOptions = keychainOptions(options);
  for (const field of args.fields) {
    if (field.secret) {
      await keychain.setSecret(args.scope, field.key, field.value, kcOptions);
      secretKeys.push(field.key);
    } else {
      nonSecretFields[field.key] = field.value;
    }
  }

  secretKeys.sort();

  const stored: IndexedScope = {
    scope: args.scope,
    fields: nonSecretFields,
    secret_keys: secretKeys,
    ...(args.identity ? { identity: args.identity } : {}),
    stored_at: now,
    ...(args.verified_at ? { last_verified_at: args.verified_at } : {})
  };

  index.scopes[args.scope] = stored;
  await writeIndex(index, options);
  return stored;
}

export async function deleteScope(scope: string, options: StoreOptions = {}): Promise<boolean> {
  const index = await readIndex(options);
  const existing = index.scopes[scope];
  if (!existing) {
    return false;
  }

  const kcOptions = keychainOptions(options);
  for (const key of existing.secret_keys) {
    await keychain.deleteSecret(scope, key, kcOptions);
  }

  delete index.scopes[scope];
  await writeIndex(index, options);
  return true;
}

export async function recordVerification(
  scope: string,
  verifiedAt: string,
  options: StoreOptions = {}
): Promise<void> {
  const index = await readIndex(options);
  const existing = index.scopes[scope];
  if (!existing) {
    return;
  }
  existing.last_verified_at = verifiedAt;
  await writeIndex(index, options);
}

export async function getScopeFields(
  scope: string,
  options: StoreOptions = {}
): Promise<StoredScopeFields | undefined> {
  const stored = await getScope(scope, options);
  if (!stored) {
    return undefined;
  }

  const fields: Record<string, string> = { ...stored.fields };
  const kcOptions = keychainOptions(options);

  for (const key of stored.secret_keys) {
    const secret = await keychain.getSecret(scope, key, kcOptions);
    if (secret !== undefined) {
      fields[key] = secret;
    }
  }

  return {
    scope,
    fields,
    ...(stored.identity ? { identity: stored.identity } : {}),
    ...(stored.stored_at ? { stored_at: stored.stored_at } : {}),
    ...(stored.last_verified_at ? { last_verified_at: stored.last_verified_at } : {})
  };
}

export interface ResolveFieldDecl {
  key: string;
  secret: boolean;
  required: boolean;
  default?: string;
}

export interface ResolveScopeArgs {
  scope: string;
  fields: ResolveFieldDecl[];
}

export interface ResolveScopeResult {
  resolved: Record<string, string>;
  entries: ResolvedFieldEntry[];
  missing_required: string[];
}

function envVarName(scope: string, key: string): string {
  return `AGENTFLOW_CREDENTIAL_${scope.toUpperCase().replace(/-/g, "_")}_${key.toUpperCase()}`;
}

export async function resolveScope(
  args: ResolveScopeArgs,
  options: StoreOptions & { env?: NodeJS.ProcessEnv } = {}
): Promise<ResolveScopeResult> {
  const env = options.env ?? process.env;
  const stored = await getScope(args.scope, options);

  const resolved: Record<string, string> = {};
  const entries: ResolvedFieldEntry[] = [];
  const missing_required: string[] = [];

  for (const field of args.fields) {
    const overrideName = envVarName(args.scope, field.key);
    const overrideValue = env[overrideName];
    if (overrideValue !== undefined && overrideValue.length > 0) {
      resolved[field.key] = overrideValue;
      entries.push({ key: field.key, secret: field.secret, value: overrideValue, source: "env" });
      continue;
    }

    if (stored) {
      if (field.secret) {
        if (stored.secret_keys.includes(field.key)) {
          const secret = await keychain.getSecret(args.scope, field.key, keychainOptions(options));
          if (secret !== undefined && secret.length > 0) {
            resolved[field.key] = secret;
            entries.push({ key: field.key, secret: true, value: secret, source: "keychain" });
            continue;
          }
        }
      } else if (stored.fields[field.key] !== undefined) {
        const value = stored.fields[field.key]!;
        resolved[field.key] = value;
        entries.push({ key: field.key, secret: false, value, source: "index" });
        continue;
      }
    }

    if (field.default !== undefined) {
      resolved[field.key] = field.default;
      entries.push({ key: field.key, secret: field.secret, value: field.default, source: "default" });
      continue;
    }

    entries.push({ key: field.key, secret: field.secret, value: undefined, source: "missing" });
    if (field.required) {
      missing_required.push(field.key);
    }
  }

  return { resolved, entries, missing_required };
}

export function credentialEnvVarName(scope: string, key: string): string {
  return envVarName(scope, key);
}

export function defaultIndexPath(): string {
  return DEFAULT_INDEX_PATH;
}
