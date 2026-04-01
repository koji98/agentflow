export interface FsItem {
  name: string;
  path: string;
  type: string; // 'file' | 'dir'
  size: number;
  mtime: string;
  hidden: boolean;
}

export interface PlanInspection {
  planPath: string;
  valid: boolean;
  errors: string[];
  plan?: Record<string, unknown>;
  repos: Array<{ alias: string; root: string; exists: boolean; isGitRepo: boolean }>;
  runRootCandidates: string[];
  contextFiles: Array<{ path: string; exists: boolean }>;
  nearbyDocs: string[];
  workflow: {
    totalNodes: number;
    executableCount: number;
    tasks: string[];
    commands: string[];
    groups: string[];
    loops: Array<{ id: string; type: string; passThreshold?: number | null }>;
  };
}

export interface LoopJudgeMeta {
  loopId: string;
  passThreshold: number;
  latestScore: number | null;
  latestReasons: string[];
  iteration: number | null;
}

export interface RunConsoleEntry {
  atUtc: string;
  source: 'stdout' | 'stderr';
  text: string;
}

export interface MonitorMeta {
  runDir: string;
  planPath: string | null;
  isActive: boolean;
  cancelRequested: boolean;
  lastExitCode: number | null;
  recentConsole: RunConsoleEntry[];
}

export type RunSummary = {
  runId: string;
  runDir: string;
  updatedAtUtc: string | null;
  totals: { tasks: number; done: number; running: number; failed: number };
  latestDecisions: Array<Record<string, unknown>>;
};

export type RunStateResponse = Record<string, any> & MonitorMeta;
export type DecisionTraceResponse = Array<Record<string, unknown>>;

export type SseEvent = any;

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface StartRunBody {
  planPath: string;
  settings?: {
    skipGitRepoCheck?: boolean;
    sandbox?: SandboxMode;
    dryRun?: boolean;
  };
  worktrees?: boolean;
}

export interface OpenRunBody { runDir: string }
export interface ResumeRunBody { runDir: string; planPath?: string; settings?: StartRunBody['settings'] }
export interface CancelRunBody { runId: string }

export interface RunArtifactItem {
  key: string;
  label: string;
  path: string;
  exists: boolean;
}
