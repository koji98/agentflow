import { join } from "node:path";

import {
  resolveExecutionAgentAttemptMemoryPath,
  resolveExecutionAgentRecoveryBriefPath,
  resolveExecutionAgentResponsePath,
  resolveExecutionArtifactsDirectory,
  resolveExecutionHumanDebugHarnessDirectory,
  resolveExecutionHumanDebugVerifierDirectory,
  resolveExecutionRuntimeCompletionPacketPath,
  resolveExecutionRuntimeContextPath,
  resolveExecutionRuntimeResultPath,
  resolveExecutionRuntimeVerifierPath
} from "../artifacts/paths.js";
import type { AttemptEvidenceBundle } from "../supervisor/types.js";
import type { RuntimeNodeAttempt } from "./attempts.js";

export function buildAttemptEvidenceBundleFromAttempt(
  attempt: RuntimeNodeAttempt,
  options: {
    case_file_path?: string;
    recovery_plan_path?: string;
  } = {}
): AttemptEvidenceBundle {
  const harnessDir = resolveExecutionHumanDebugHarnessDirectory(attempt.execution_dir);
  const verifierDir = resolveExecutionHumanDebugVerifierDirectory(attempt.execution_dir);
  return {
    identity: {
      execution_id: attempt.execution_id,
      compiled_id: attempt.compiled_id,
      authored_id: attempt.authored_id
    },
    agent_paths: {
      attempt_root: attempt.execution_dir,
      response_path: resolveExecutionAgentResponsePath(attempt.execution_dir),
      artifacts_dir: resolveExecutionArtifactsDirectory(attempt.execution_dir),
      artifact_paths: attempt.artifacts,
      attempt_memory_path: resolveExecutionAgentAttemptMemoryPath(attempt.execution_dir),
      supervisor_recovery_path: resolveExecutionAgentRecoveryBriefPath(attempt.execution_dir)
    },
    audit_paths: {
      ...(attempt.prompt_path ? { prompt_path: attempt.prompt_path } : {}),
      ...(attempt.context_manifest_path ? { context_path: attempt.context_manifest_path } : {}),
      ...(attempt.result_path ? { result_path: attempt.result_path } : {
        result_path: resolveExecutionRuntimeResultPath(attempt.execution_dir)
      }),
      completion_packet_path: resolveExecutionRuntimeCompletionPacketPath(attempt.execution_dir),
      verifier_json_path: resolveExecutionRuntimeVerifierPath(attempt.execution_dir),
      verifier_verdict_path: join(verifierDir, "verdict.md"),
      ...(attempt.stdout_log_path ? { stdout_path: attempt.stdout_log_path } : {
        stdout_path: join(harnessDir, "stdout.log")
      }),
      ...(attempt.stderr_log_path ? { stderr_path: attempt.stderr_log_path } : {
        stderr_path: join(harnessDir, "stderr.log")
      }),
      ...(options.case_file_path ? { case_file_path: options.case_file_path } : {}),
      ...(options.recovery_plan_path ? { recovery_plan_path: options.recovery_plan_path } : {})
    }
  };
}

export function buildAttemptEvidenceBundleFromPaths(options: {
  execution_id: string;
  compiled_id: string;
  authored_id: string;
  attempt_root: string;
  artifact_paths?: Record<string, string>;
  case_file_path?: string;
  recovery_plan_path?: string;
}): AttemptEvidenceBundle {
  return {
    identity: {
      execution_id: options.execution_id,
      compiled_id: options.compiled_id,
      authored_id: options.authored_id
    },
    agent_paths: {
      attempt_root: options.attempt_root,
      response_path: resolveExecutionAgentResponsePath(options.attempt_root),
      artifacts_dir: resolveExecutionArtifactsDirectory(options.attempt_root),
      artifact_paths: options.artifact_paths ?? {},
      attempt_memory_path: resolveExecutionAgentAttemptMemoryPath(options.attempt_root),
      supervisor_recovery_path: resolveExecutionAgentRecoveryBriefPath(options.attempt_root)
    },
    audit_paths: {
      result_path: resolveExecutionRuntimeResultPath(options.attempt_root),
      context_path: resolveExecutionRuntimeContextPath(options.attempt_root),
      completion_packet_path: resolveExecutionRuntimeCompletionPacketPath(options.attempt_root),
      verifier_json_path: resolveExecutionRuntimeVerifierPath(options.attempt_root),
      verifier_verdict_path: join(resolveExecutionHumanDebugVerifierDirectory(options.attempt_root), "verdict.md"),
      ...(options.case_file_path ? { case_file_path: options.case_file_path } : {}),
      ...(options.recovery_plan_path ? { recovery_plan_path: options.recovery_plan_path } : {})
    }
  };
}

export function renderAttemptEvidenceMarkdown(
  bundle: AttemptEvidenceBundle,
  options: { heading?: string } = {}
): string[] {
  const heading = options.heading ?? "## Prior Attempt Evidence";
  const artifactEntries = Object.entries(bundle.agent_paths.artifact_paths)
    .sort(([left], [right]) => left.localeCompare(right));
  return [
    heading,
    `- Attempt root: \`${bundle.agent_paths.attempt_root}\``,
    ...(bundle.agent_paths.response_path ? [`- Response: \`${bundle.agent_paths.response_path}\``] : []),
    `- Artifacts directory: \`${bundle.agent_paths.artifacts_dir}\``,
    ...(artifactEntries.length > 0
      ? artifactEntries.map(([name, path]) => `- Artifact \`${name}\`: \`${path}\``)
      : ["- Artifacts: none recorded for the prior attempt."]),
    ...(bundle.agent_paths.attempt_memory_path
      ? [`- Attempt memory: \`${bundle.agent_paths.attempt_memory_path}\``]
      : []),
    ...(bundle.agent_paths.supervisor_recovery_path
      ? [`- Supervisor recovery brief: \`${bundle.agent_paths.supervisor_recovery_path}\``]
      : [])
  ];
}
