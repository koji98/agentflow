import fs from 'node:fs';
import path from 'node:path';

import {
  REASONING_EFFORT_ALIASES,
  REASONING_EFFORT_VALUES,
  PROVIDERS,
} from './constants.ts';
import type { Provider, ReasoningEffort } from './types.ts';

/** Returns UTC timestamp in stable short ISO form. */
export function nowUtcIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Builds a deterministic run id. */
export function nowRunId(): string {
  const d = new Date();
  const pad = (v: number): string => String(v).padStart(2, '0');
  return `run_${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(
    d.getUTCHours(),
  )}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** Converts text to a filesystem-safe slug. */
export function safeSlug(text: string): string {
  const cleaned = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'x';
}

/** Trims and returns `null` when empty. */
export function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

/** Ensures a non-empty string value. */
export function requiredString(value: unknown, fieldName: string): string {
  const trimmed = optionalString(value);
  if (!trimmed) throw new Error(`${fieldName} must be non-empty.`);
  return trimmed;
}

/** Validates and normalizes reasoning effort. */
export function normalizeReasoningEffort(value: unknown): ReasoningEffort | null {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;
  const normalized = REASONING_EFFORT_ALIASES.get(raw) || raw;
  if (!REASONING_EFFORT_VALUES.has(normalized)) {
    throw new Error(
      `reasoning_effort must be one of: ${Array.from(REASONING_EFFORT_VALUES).sort().join(', ')}`,
    );
  }
  return normalized as ReasoningEffort;
}

/** Validates and normalizes provider id. */
export function normalizeProvider(value: unknown): Provider | null {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  if (!PROVIDERS.has(normalized)) {
    throw new Error(`provider must be one of: ${Array.from(PROVIDERS).sort().join(', ')}`);
  }
  return normalized as Provider;
}

/** Normalizes an optional string list. */
export function normalizeStringArray(value: unknown, fieldName: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array of strings.`);
  return value.map((v) => String(v).trim()).filter(Boolean);
}

/** Validates a relative file path or returns null when empty. */
export function validateRelativePath(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (path.isAbsolute(trimmed)) throw new Error(`${fieldName} must be relative.`);
  if (trimmed.split(/[\\/]+/).includes('..')) {
    throw new Error(`${fieldName} must not contain parent traversal.`);
  }
  return trimmed;
}

/** Reads text safely. */
export function readText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/** Creates a capped excerpt for JSON report payloads. */
export function excerptText(filePath: string, maxChars = 4000): string {
  const text = readText(filePath);
  if (!text) return '';
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n...[truncated]`;
}

/** Returns tail lines/characters from a file. */
export function tailText(filePath: string, maxLines = 120, maxChars = 12000): string {
  const text = readText(filePath);
  if (!text) return '';
  let tail = text.split(/\r?\n/).slice(-maxLines).join('\n');
  if (tail.length > maxChars) tail = tail.slice(-maxChars);
  return tail;
}

/** Appends shared raw thought stream output. */
export function appendRawThoughts(rawPath: string, text: string): void {
  if (!rawPath || !text) return;
  fs.mkdirSync(path.dirname(rawPath), { recursive: true });
  fs.appendFileSync(rawPath, text, 'utf8');
}

/** Maps a project-relative path to worker cwd space for worktree mode. */
export function mapProjectPathToWorker(
  projectRoot: string,
  workerCwd: string,
  sourcePath: string,
): string {
  const absSource = path.resolve(sourcePath);
  const absRoot = path.resolve(projectRoot);
  if (!absSource.startsWith(absRoot + path.sep) && absSource !== absRoot) return absSource;
  return path.resolve(workerCwd, path.relative(absRoot, absSource));
}

/** Stable task key format used by state/events. */
export function taskKey(groupIndex: number, taskId: string): string {
  return `g${String(groupIndex).padStart(2, '0')}:${taskId}`;
}
