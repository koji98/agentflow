import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  TIMEOUT_CLASSIFICATION,
  TIMEOUT_EXIT_CODE,
} from './constants.ts';
import { log } from './log.ts';
import type { RunCommandParams, RunCommandResult } from './types.ts';

/**
 * Runs one provider command and streams output to task log.
 *
 * @param params Command execution parameters.
 * @param params.cmd Command tokens to spawn.
 * @param params.cwd Working directory for the child process.
 * @param params.stdinText Text piped to stdin when `useStdin` is true.
 * @param params.logPath Path for combined stdout/stderr log.
 * @param params.dryRun When true, prints command and returns simulated success.
 * @param params.timeoutSeconds Optional wall-clock timeout in seconds.
 * @param params.timeoutGraceSeconds Grace period before SIGKILL after SIGTERM.
 * @param params.useStdin Whether to pipe `stdinText` to the process.
 * @param params.stdoutCapturePath Optional separate path to capture raw stdout.
 * @returns Promise resolving to the command execution result.
 */
export function runCommand({
  cmd,
  cwd,
  stdinText,
  logPath,
  dryRun,
  timeoutSeconds,
  timeoutGraceSeconds,
  useStdin,
  stdoutCapturePath,
  teeOutput = false,
}: RunCommandParams): Promise<RunCommandResult> {
  const banner = `$ (cd ${JSON.stringify(cwd)} && ${cmd.map((c) => JSON.stringify(c)).join(' ')})`;

  if (dryRun) {
    log(banner);
    return Promise.resolve({
      exitCode: 0,
      timedOut: false,
      timeoutSeconds,
      timeoutClassification: null,
      timeoutTerminationOutcome: null,
    });
  }

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logStream = fs.createWriteStream(logPath, { encoding: 'utf8' });
  logStream.write(`${banner}\n\n`);

  return new Promise<RunCommandResult>((resolve) => {
    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: RunCommandResult, trailer: string | null = null) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (trailer) {
        logStream.write(trailer);
      }
      if (stdoutCapturePath && stdoutChunks.length > 0) {
        fs.mkdirSync(path.dirname(stdoutCapturePath), { recursive: true });
        fs.writeFileSync(stdoutCapturePath, stdoutChunks.join(''), 'utf8');
      }
      logStream.end();
      resolve(result);
    };

    const child = spawn(cmd[0], cmd.slice(1), {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let timedOut = false;
    let timeoutTerminationOutcome: string | null = null;
    const stdoutChunks: string[] = [];

    const onStdout = (chunk: Buffer | string) => {
      const text = chunk.toString();
      logStream.write(text);
      if (stdoutCapturePath) stdoutChunks.push(text);
      if (teeOutput) process.stdout.write(text);
    };
    const onStderr = (chunk: Buffer | string) => {
      const text = chunk.toString();
      logStream.write(text);
      if (teeOutput) process.stderr.write(text);
    };

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);

    if (useStdin) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();

    if (timeoutSeconds && timeoutSeconds > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;

        if (process.platform !== 'win32' && child.pid != null) {
          const pid = child.pid;
          try {
            process.kill(-pid, 'SIGTERM');
            timeoutTerminationOutcome = 'sigterm';
          } catch {
            timeoutTerminationOutcome = 'already_exited';
          }

          setTimeout(() => {
            if (child.exitCode === null) {
              try {
                process.kill(-pid, 'SIGKILL');
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
