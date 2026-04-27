import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { MissingCredentialError } from "./errors.js";
import { createMacOSKeychainAdapter, type KeychainAdapter } from "./keychain.js";
import type { CredentialScopeSpec } from "./types.js";

export const defaultCredentialIndexPath = join(homedir(), ".agentflow", "credentials.index.json");

interface CredentialIndexField {
  secret: boolean;
  value?: string;
  updated_at: string;
}

interface CredentialIndexScope {
  fields: Record<string, CredentialIndexField>;
}

interface CredentialIndexFile {
  version: "1";
  scopes: Record<string, CredentialIndexScope>;
}

export interface CredentialStoreOptions {
  index_path?: string;
  keychain?: KeychainAdapter;
}

export interface CredentialStore {
  readonly index_path: string;
  setField(options: {
    scope: string;
    key: string;
    value: string;
    secret: boolean;
  }): Promise<void>;
  deleteField(scope: string, key: string): Promise<void>;
  resolveScope(spec: CredentialScopeSpec, scope: string): Promise<Record<string, string>>;
  listMetadata(): Promise<Record<string, Record<string, { secret: boolean; configured: boolean; updated_at: string }>>>;
}

function createEmptyIndex(): CredentialIndexFile {
  return {
    version: "1",
    scopes: {}
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeIndex(value: unknown): CredentialIndexFile {
  const record = asRecord(value);
  const scopes = asRecord(record?.scopes);

  if (!record) {
    throw new Error("Credential index must be a JSON object.");
  }

  if (record.version !== "1") {
    throw new Error("Credential index version must be \"1\".");
  }

  if (!scopes) {
    throw new Error("Credential index scopes must be an object.");
  }

  const normalized = createEmptyIndex();
  for (const [scope, scopeValue] of Object.entries(scopes)) {
    const scopeRecord = asRecord(scopeValue);
    const fieldsRecord = asRecord(scopeRecord?.fields);
    if (!fieldsRecord) {
      throw new Error(`Credential index scope "${scope}" must declare object fields.`);
    }

    const fields: Record<string, CredentialIndexField> = {};
    for (const [key, fieldValue] of Object.entries(fieldsRecord)) {
      const fieldRecord = asRecord(fieldValue);
      if (!fieldRecord || typeof fieldRecord.secret !== "boolean") {
        throw new Error(`Credential index field "${scope}.${key}" must declare boolean secret metadata.`);
      }
      fields[key] = {
        secret: fieldRecord.secret,
        ...(typeof fieldRecord.value === "string" ? { value: fieldRecord.value } : {}),
        updated_at: typeof fieldRecord.updated_at === "string"
          ? fieldRecord.updated_at
          : new Date(0).toISOString()
      };
    }

    if (Object.keys(fields).length > 0) {
      normalized.scopes[scope] = { fields };
    }
  }

  return normalized;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

async function readIndex(path: string): Promise<CredentialIndexFile> {
  try {
    return normalizeIndex(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if (isMissingFileError(error)) {
      return createEmptyIndex();
    }

    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read credential index at ${path}: ${reason}`);
  }
}

async function writeIndex(path: string, index: CredentialIndexFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(index, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

export function createCredentialStore(options: CredentialStoreOptions = {}): CredentialStore {
  const index_path = options.index_path ?? defaultCredentialIndexPath;
  const keychain = options.keychain ?? createMacOSKeychainAdapter();

  async function setField(options: {
    scope: string;
    key: string;
    value: string;
    secret: boolean;
  }): Promise<void> {
    const index = await readIndex(index_path);
    const scope = index.scopes[options.scope] ?? { fields: {} };
    const now = new Date().toISOString();

    if (options.secret) {
      await keychain.setSecret({ scope: options.scope, key: options.key }, options.value);
      scope.fields[options.key] = {
        secret: true,
        updated_at: now
      };
    } else {
      await keychain.deleteSecret({ scope: options.scope, key: options.key });
      scope.fields[options.key] = {
        secret: false,
        value: options.value,
        updated_at: now
      };
    }

    index.scopes[options.scope] = scope;
    await writeIndex(index_path, index);
  }

  async function deleteField(scopeName: string, key: string): Promise<void> {
    const index = await readIndex(index_path);
    await keychain.deleteSecret({ scope: scopeName, key });
    delete index.scopes[scopeName]?.fields[key];
    if (index.scopes[scopeName] && Object.keys(index.scopes[scopeName].fields).length === 0) {
      delete index.scopes[scopeName];
    }
    await writeIndex(index_path, index);
  }

  async function resolveScope(spec: CredentialScopeSpec, scopeName: string): Promise<Record<string, string>> {
    const index = await readIndex(index_path);
    const resolved: Record<string, string> = {};

    for (const [key, fieldSpec] of Object.entries(spec.fields)) {
      let value: string | undefined;

      if (fieldSpec.secret) {
        value = await keychain.getSecret({ scope: scopeName, key });
      } else {
        value = index.scopes[scopeName]?.fields[key]?.value;
      }

      if ((value === undefined || value.length === 0) && fieldSpec.default !== undefined) {
        value = fieldSpec.default;
      }

      if ((value === undefined || value.length === 0) && fieldSpec.required) {
        throw new MissingCredentialError(scopeName, key);
      }

      if (value !== undefined && value.length > 0) {
        resolved[key] = value;
      }
    }

    return resolved;
  }

  async function listMetadata(): Promise<Record<string, Record<string, { secret: boolean; configured: boolean; updated_at: string }>>> {
    const index = await readIndex(index_path);
    const result: Record<string, Record<string, { secret: boolean; configured: boolean; updated_at: string }>> = {};

    for (const [scope, scopeEntry] of Object.entries(index.scopes)) {
      result[scope] = {};
      for (const [key, field] of Object.entries(scopeEntry.fields)) {
        result[scope][key] = {
          secret: field.secret,
          configured: true,
          updated_at: field.updated_at
        };
      }
    }

    return result;
  }

  return {
    index_path,
    setField,
    deleteField,
    resolveScope,
    listMetadata
  };
}
