import type {
  CompletionArtifactFinding,
  CompletionPacket,
  CompletionProjection,
  CompletionValidationEvidence,
  RuntimeLogEntry
} from "./types.js";

export interface BuildCompletionProjectionOptions {
  maxItems?: number;
}

function limit<T>(items: T[], maxItems: number): { values: T[]; omitted?: number } {
  if (items.length <= maxItems) {
    return { values: items };
  }
  return {
    values: items.slice(0, maxItems),
    omitted: items.length - maxItems
  };
}

function compactBlocker(log: RuntimeLogEntry): CompletionProjection["active_blockers"][number] {
  return {
    log_id: log.log_id,
    summary: log.summary,
    ...(log.finding_kind ? { finding_kind: log.finding_kind } : {}),
    ...(log.severity ? { severity: log.severity } : {}),
    ...(log.blocked_on ? { blocked_on: log.blocked_on } : {}),
    ...(log.recoverable_by ? { recoverable_by: log.recoverable_by } : {})
  };
}

export function buildCompletionProjection(
  packet: CompletionPacket,
  options: BuildCompletionProjectionOptions = {}
): CompletionProjection {
  const maxItems = Math.max(1, options.maxItems ?? 8);
  const blockingReasons = limit(packet.blocking_reasons, maxItems);
  const artifactFindings = limit<CompletionArtifactFinding>(packet.artifact_findings, maxItems);
  const validationEvidence = limit<CompletionValidationEvidence>(packet.validation_evidence, maxItems);
  const activeBlockers = limit(packet.active_blockers.map(compactBlocker), maxItems);
  const omitted = {
    ...(blockingReasons.omitted !== undefined ? { blocking_reasons: blockingReasons.omitted } : {}),
    ...(artifactFindings.omitted !== undefined ? { artifact_findings: artifactFindings.omitted } : {}),
    ...(validationEvidence.omitted !== undefined ? { validation_evidence: validationEvidence.omitted } : {}),
    ...(activeBlockers.omitted !== undefined ? { active_blockers: activeBlockers.omitted } : {})
  };

  return {
    version: "1",
    attempt_id: packet.attempt_id,
    execution_id: packet.execution_id,
    compiled_id: packet.compiled_id,
    authored_id: packet.authored_id,
    completion_status: packet.completion_status,
    ready_for_verification: packet.ready_for_verification,
    authority_requests: packet.authority_requests,
    blocking_reasons: blockingReasons.values,
    missing_artifacts: packet.missing_artifacts.slice(0, maxItems),
    artifact_findings: artifactFindings.values,
    validation_evidence: validationEvidence.values,
    orientation: packet.orientation,
    milestones: packet.milestones,
    active_blockers: activeBlockers.values,
    operator_observations: packet.operator_observations,
    supervisor_recovery: packet.supervisor_recovery,
    managed: packet.managed,
    helpers: packet.helpers,
    packet_path: packet.packet_path,
    ...(Object.keys(omitted).length > 0 ? { omitted } : {})
  };
}
