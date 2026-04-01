import fs from 'node:fs';

import { isPathAllowed } from './fs_access.ts';

export type RawOutputSource = {
  kind: 'log' | 'last_message';
  path: string;
  label: string;
};

function candidateSources(row: Record<string, unknown>): RawOutputSource[] {
  const logPath = typeof row.logPath === 'string' ? row.logPath.trim() : '';
  const lastMessagePath = typeof row.lastMessagePath === 'string' ? row.lastMessagePath.trim() : '';
  const candidates: RawOutputSource[] = [];

  if (logPath) {
    candidates.push({
      kind: 'log',
      path: logPath,
      label: 'Execution log',
    });
  }
  if (lastMessagePath) {
    candidates.push({
      kind: 'last_message',
      path: lastMessagePath,
      label: 'Last message / stdout',
    });
  }

  return candidates;
}

export function resolvePreferredRawOutputSource(row: Record<string, unknown>): RawOutputSource | null {
  const candidates = candidateSources(row);
  if (candidates.length === 0) return null;

  const allowedCandidates = candidates.filter((candidate) => isPathAllowed(candidate.path));
  const existingAllowedCandidate = allowedCandidates.find((candidate) => fs.existsSync(candidate.path));
  if (existingAllowedCandidate) return existingAllowedCandidate;
  if (allowedCandidates.length > 0) return allowedCandidates[0];
  return candidates[0];
}
