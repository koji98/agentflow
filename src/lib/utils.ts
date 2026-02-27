import fs from 'node:fs';
import path from 'node:path';

import {
  REASONING_EFFORT_ALIASES,
  REASONING_EFFORT_VALUES,
  PROVIDERS,
} from './constants.ts';
import type { Provider, ReasoningEffort, SandboxMode } from './types.ts';

/**
 * Returns the current UTC timestamp in stable short ISO format.
 * @returns Timestamp like `2026-02-26T01:23:45Z`.
 */
export function nowUtcIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Builds a deterministic run id from current UTC time.
 * @returns Run id like `run_20260226T012345Z`.
 */
export function nowRunId(): string {
  const d = new Date();
  const pad = (v: number): string => String(v).padStart(2, '0');
  return `run_${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(
    d.getUTCHours(),
  )}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/**
 * Converts arbitrary text to a filesystem-safe slug.
 * @param text Source text to sanitize.
 * @returns Lowercased slug containing `[a-z0-9-]` only.
 */
export function safeSlug(text: string): string {
  const cleaned = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'x';
}

/**
 * Normalizes an optional text-like value.
 * @param value Input value.
 * @returns Trimmed string or `null` when missing/empty.
 */
export function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

/**
 * Requires a non-empty string value.
 * @param value Input value.
 * @param fieldName Field name used in thrown validation errors.
 * @returns Trimmed non-empty string.
 * @throws {Error} When value is missing or empty.
 */
export function requiredString(value: unknown, fieldName: string): string {
  const trimmed = optionalString(value);
  if (!trimmed) throw new Error(`${fieldName} must be non-empty.`);
  return trimmed;
}

/**
 * Validates and normalizes reasoning effort input.
 * @param value Raw reasoning effort value.
 * @returns Canonical reasoning effort value or `null`.
 * @throws {Error} When value is not in supported set.
 */
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

/**
 * Validates and normalizes provider identifier.
 * @param value Raw provider value.
 * @returns Canonical provider id or `null`.
 * @throws {Error} When provider is unsupported.
 */
export function normalizeProvider(value: unknown): Provider | null {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  if (!PROVIDERS.has(normalized)) {
    throw new Error(`provider must be one of: ${Array.from(PROVIDERS).sort().join(', ')}`);
  }
  return normalized as Provider;
}

/**
 * Normalizes an optional string array by trimming/removing empties.
 * @param value Raw array input.
 * @param fieldName Field name used in validation errors.
 * @returns Normalized array of non-empty strings.
 * @throws {Error} When value is not an array.
 */
export function normalizeStringArray(value: unknown, fieldName: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array of strings.`);
  return value.map((v) => String(v).trim()).filter(Boolean);
}

/**
 * Validates a relative path and blocks traversal.
 * @param value Raw path input.
 * @param fieldName Field name used in validation errors.
 * @returns Validated relative path or `null` when absent/empty.
 * @throws {Error} When path is absolute or contains parent traversal.
 */
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

/**
 * Reads UTF-8 text from disk without throwing.
 * @param filePath File path to read.
 * @returns File contents or empty string when unreadable.
 */
export function readText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Returns a bounded excerpt from a text file.
 * @param filePath Source file path.
 * @param maxChars Maximum number of characters.
 * @returns File text truncated to `maxChars` with suffix when needed.
 */
export function excerptText(filePath: string, maxChars = 4000): string {
  const text = readText(filePath);
  if (!text) return '';
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n...[truncated]`;
}

/**
 * Returns a tail excerpt using line and char caps.
 * @param filePath Source file path.
 * @param maxLines Maximum trailing lines to include.
 * @param maxChars Maximum trailing characters after line cap.
 * @returns Tail text or empty string when file is unreadable/empty.
 */
export function tailText(filePath: string, maxLines = 120, maxChars = 12000): string {
  const text = readText(filePath);
  if (!text) return '';
  let tail = text.split(/\r?\n/).slice(-maxLines).join('\n');
  if (tail.length > maxChars) tail = tail.slice(-maxChars);
  return tail;
}

/**
 * Appends text to the shared raw-thoughts stream file.
 * @param rawPath Destination raw-thoughts file path.
 * @param text Text chunk to append.
 * @returns Nothing.
 */
export function appendRawThoughts(rawPath: string, text: string): void {
  if (!rawPath || !text) return;
  fs.mkdirSync(path.dirname(rawPath), { recursive: true });
  fs.appendFileSync(rawPath, text, 'utf8');
}

/**
 * Maps a project path into worker cwd space when using worktrees.
 * @param projectRoot Canonical project root.
 * @param workerCwd Worker execution cwd (possibly worktree path).
 * @param sourcePath Source path to map.
 * @returns Worker-visible absolute path.
 */
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

/**
 * Maps agentflow's 3-tier sandbox mode to Cursor CLI's binary sandbox flag.
 * Returns `'disabled'` only for `danger-full-access`. Returns `null` for
 * other modes so the `--sandbox` flag is omitted entirely, avoiding failures
 * on systems where cursor's sandbox feature is unavailable.
 * @param mode Agentflow sandbox mode.
 * @returns `'disabled'` for full access, `null` otherwise (omit the flag).
 */
export function mapSandboxForCursor(mode: SandboxMode): 'disabled' | null {
  return mode === 'danger-full-access' ? 'disabled' : null;
}

/**
 * Builds stable task key identifiers for run state/events.
 * @param groupIndex Numeric group index.
 * @param taskId Task id or id+attempt segment.
 * @returns Stable key like `g01:task_a#a1`.
 */
export function taskKey(groupIndex: number, taskId: string): string {
  return `g${String(groupIndex).padStart(2, '0')}:${taskId}`;
}
