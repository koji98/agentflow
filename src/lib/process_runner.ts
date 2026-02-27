import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  TIMEOUT_CLASSIFICATION,
  TIMEOUT_EXIT_CODE,
} from './constants.ts';
import type { RunCommandParams, RunCommandResult } from './types.ts';
import { appendRawThoughts, nowUtcIso } from './utils.ts';

/**
 * Runs one provider command and streams output to task log and raw thoughts.
 * @param params Subprocess launch parameters.
 * @param params.cmd Command vector (`cmd[0]` executable, rest args).
 * @param params.cwd Working directory for subprocess execution.
 * @param params.stdinText Text piped to stdin.
 * @param params.logPath Destination file for combined stdout/stderr stream.
 * @param params.dryRun When true, prints command and returns synthetic success.
 * @param params.timeoutSeconds Soft timeout; null disables timeout logic.
 * @param params.timeoutGraceSeconds Grace period between SIGTERM and SIGKILL.
 * @param params.rawThoughtsPath Shared raw-thoughts log file path.
 * @param params.rawThoughtsTaskLabel Task label used in raw-thoughts headers.
 * @returns Promise resolving to normalized execution outcome metadata.
 */
export function runCommand({
  cmd,
  cwd,
  stdinText,
  logPath,
  dryRun,
  timeoutSeconds,
  timeoutGraceSeconds,
  rawThoughtsPath,
  rawThoughtsTaskLabel,
}: RunCommandParams): Promise<RunCommandResult> {
  const banner = `$ (cd ${JSON.stringify(cwd)} && ${cmd.map((c) => JSON.stringify(c)).join(' ')})`;

  if (dryRun) {
    // eslint-disable-next-line no-console
    console.log(banner);
    return Promise.resolve({
      exitCode: 0,
      timedOut: false,
      timeoutSeconds,
      timeoutClassification: null,
      timeoutTerminationOutcome: null,
    });
  }

  appendRawThoughts(rawThoughtsPath, `\n\n## ${nowUtcIso()} | ${rawThoughtsTaskLabel}\n\n${banner}\n\n`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logStream = fs.createWriteStream(logPath, { encoding: 'utf8' });
  logStream.write(`${banner}\n\n`);

  return new Promise<RunCommandResult>((resolve) => {
    let settled = false;
    let timeoutTimer = null;

    const finish = (result: RunCommandResult, trailer: string | null = null) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (trailer) {
        logStream.write(trailer);
        appendRawThoughts(rawThoughtsPath, trailer);
      }
      logStream.end();
      appendRawThoughts(rawThoughtsPath, `\n[end task at ${nowUtcIso()}]\n`);
      resolve(result);
    };

    const child = spawn(cmd[0], cmd.slice(1), {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let timedOut = false;
    let timeoutTerminationOutcome = null;

    const onChunk = (chunk: Buffer | string) => {
      const text = chunk.toString();
      logStream.write(text);
      appendRawThoughts(rawThoughtsPath, text);
    };

    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.stdin.write(stdinText);
    child.stdin.end();

    if (timeoutSeconds && timeoutSeconds > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;

        if (process.platform !== 'win32') {
          try {
            process.kill(-child.pid, 'SIGTERM');
            timeoutTerminationOutcome = 'sigterm';
          } catch {
            timeoutTerminationOutcome = 'already_exited';
          }

          setTimeout(() => {
            if (child.exitCode === null) {
              try {
                process.kill(-child.pid, 'SIGKILL');
                timeoutTerminationOutcome = 'sigterm_then_sigkill';
              } catch {
                // keep best effort status
              }
            }
          }, Math.max(1000, timeoutGraceSeconds * 1000));
        } else {
          try {
            child.kill('SIGTERM');
            timeoutTerminationOutcome = 'terminate';
          } catch {
            timeoutTerminationOutcome = 'already_exited';
          }
        }
      }, timeoutSeconds * 1000);
    }

    child.on('error', (error) => {
      finish(
        {
          exitCode: 127,
          timedOut: false,
          timeoutSeconds: timeoutSeconds || null,
          timeoutClassification: null,
          timeoutTerminationOutcome: 'spawn_error',
        },
        `\n[spawn_error] ${String(error)}\n`,
      );
    });

    child.on('close', (code) => {
      if (timedOut) {
        finish(
          {
            exitCode: TIMEOUT_EXIT_CODE,
            timedOut,
            timeoutSeconds: timeoutSeconds || null,
            timeoutClassification: TIMEOUT_CLASSIFICATION,
            timeoutTerminationOutcome,
          },
          `\n[timeout] classification=${TIMEOUT_CLASSIFICATION} timeoutSeconds=${timeoutSeconds} terminationOutcome=${timeoutTerminationOutcome}\n`,
        );
        return;
      }

      finish({
        exitCode: Number(code ?? 0),
        timedOut,
        timeoutSeconds: timeoutSeconds || null,
        timeoutClassification: null,
        timeoutTerminationOutcome,
      });
    });
  });
}
