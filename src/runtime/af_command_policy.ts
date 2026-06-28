export type AfCommandPolicy = "worker" | "diagnostic" | "orchestrator";

export interface AfCommandDecision {
  allowed: boolean;
  reason?: string;
}

function commandPath(argv: string[]): string {
  return argv.slice(0, 2).join(" ");
}

function isWorkerCommand(argv: string[]): boolean {
  const [command, subcommand] = argv;
  return (
    command === "orient" ||
    command === "milestone" ||
    (command === "artifact" && subcommand === "write") ||
    (command === "complete" && subcommand === "check")
  );
}

function isDiagnosticCommand(argv: string[]): boolean {
  const [command] = argv;
  return command === "diagnose" || command === "learn";
}

function isOrchestratorCommand(argv: string[]): boolean {
  return argv[0] === "spawn";
}

export function normalizeAfCommandPolicy(value: unknown): AfCommandPolicy {
  return value === "diagnostic" || value === "orchestrator" ? value : "worker";
}

export function decideAfCommand(
  argv: string[],
  policy: AfCommandPolicy
): AfCommandDecision {
  if (argv.length === 0) {
    return { allowed: true };
  }

  if (argv[0] === "_helper-run") {
    return {
      allowed: false,
      reason: "`af _helper-run` is internal runtime transport and cannot be invoked by agents."
    };
  }

  if (isWorkerCommand(argv)) {
    return { allowed: true };
  }

  if (policy === "diagnostic" || policy === "orchestrator") {
    if (isDiagnosticCommand(argv)) {
      return { allowed: true };
    }
  }

  if (policy === "orchestrator" && isOrchestratorCommand(argv)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `af command "${commandPath(argv)}" is not allowed by the ${policy} command policy.`
  };
}
