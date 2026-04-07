import type { ChildProcess } from "node:child_process";

export const forceKillGraceMs = 500;

export interface ProcessTerminationState {
  timed_out: boolean;
  canceled: boolean;
  force_killed: boolean;
}

export interface ProcessTerminationController {
  state: ProcessTerminationState;
  requestTimeout(): void;
  requestCancel(): void;
  dispose(): void;
}

export function createProcessTerminationController(
  child: ChildProcess
): ProcessTerminationController {
  const state: ProcessTerminationState = {
    timed_out: false,
    canceled: false,
    force_killed: false
  };
  let stop_requested = false;
  let force_kill_timer: NodeJS.Timeout | undefined;

  function requestStop(reason: "timeout" | "cancel"): void {
    if (stop_requested) {
      return;
    }

    stop_requested = true;
    state.timed_out = reason === "timeout";
    state.canceled = reason === "cancel";
    child.kill("SIGTERM");
    force_kill_timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        state.force_killed = child.kill("SIGKILL");
      }
    }, forceKillGraceMs);
    force_kill_timer.unref?.();
  }

  return {
    state,
    requestTimeout() {
      requestStop("timeout");
    },
    requestCancel() {
      requestStop("cancel");
    },
    dispose() {
      if (force_kill_timer) {
        clearTimeout(force_kill_timer);
      }
    }
  };
}
