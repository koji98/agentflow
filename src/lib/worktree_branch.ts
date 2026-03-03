import {
  DEFAULT_WORKTREE_BRANCH_TEMPLATE,
  WORKTREE_BRANCH_TEMPLATE_TOKENS,
} from './constants.ts';
import { safeSlug } from './utils.ts';

export type WorktreeBranchKind = 'task' | 'command';

export interface WorktreeBranchContext {
  runId: string;
  repoAlias: string;
  groupIndex: number;
  nodeId: string;
  attempt: number;
  kind: WorktreeBranchKind;
}

function validateBraceStructure(template: string, fieldName: string): void {
  let depth = 0;
  for (const ch of template) {
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (depth < 0) {
      throw new Error(`${fieldName} has an unmatched closing brace "}".`);
    }
  }
  if (depth !== 0) {
    throw new Error(`${fieldName} has an unmatched opening brace "{".`);
  }
}

/**
 * Validates options.worktree_branch_template structure and placeholders.
 * Requires `{group}` so each launch has a unique branch name.
 */
export function validateWorktreeBranchTemplate(template: string, fieldName: string): void {
  const normalized = String(template || '').trim();
  if (!normalized) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }

  validateBraceStructure(normalized, fieldName);
  const placeholders = Array.from(normalized.matchAll(/\{([^{}]+)\}/g)).map((m) => m[1]);

  for (const token of placeholders) {
    if (!WORKTREE_BRANCH_TEMPLATE_TOKENS.has(token)) {
      throw new Error(
        `${fieldName} contains unknown placeholder "{${token}}". Allowed: ${Array.from(
          WORKTREE_BRANCH_TEMPLATE_TOKENS,
        ).sort().join(', ')}`,
      );
    }
  }

  if (!placeholders.includes('group')) {
    throw new Error(`${fieldName} must include "{group}" to ensure unique per-launch branch names.`);
  }
}

/**
 * Renders a concrete worktree branch name from a validated template + context.
 */
export function renderWorktreeBranchName(
  template: string,
  context: WorktreeBranchContext,
): string {
  validateWorktreeBranchTemplate(template, 'options.worktree_branch_template');
  const values: Record<string, string> = {
    run_id: safeSlug(context.runId),
    repo: safeSlug(context.repoAlias),
    group: String(context.groupIndex),
    node: safeSlug(context.nodeId),
    attempt: String(context.attempt),
    kind: context.kind,
    kind_short: context.kind === 'task' ? 't' : 'c',
  };

  const rendered = template.replace(/\{([^{}]+)\}/g, (_full, token: string) => values[token]);
  const sanitized = rendered
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => safeSlug(segment))
    .join('/');
  if (!sanitized.trim()) {
    throw new Error('options.worktree_branch_template rendered an empty branch name.');
  }
  return sanitized;
}

export { DEFAULT_WORKTREE_BRANCH_TEMPLATE };
