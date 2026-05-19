import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { ArtifactDefinition } from "../graph/authored.js";
import {
  resolveExecutionRuntimeSupervisorDirectory,
  resolveInterventionDirectory
} from "../artifacts/paths.js";
import type { CompiledExecutableNode, CompiledGraph } from "../graph/compiled.js";
import type { EffectiveSupervisorPolicy } from "../graph/profiles.js";
import type { RuntimeNodeAttempt } from "../runtime/attempts.js";
import {
  analyzeNodeContext,
  createCompactContextIndex,
  renderContextAnalysisMarkdown,
  type ContextAnalysisReport,
  type ContextAnalysisNode
} from "../runtime/context/analyze.js";
import type { RuntimeNodeExecutionResult } from "../runtime/core/engine.js";
import type { HarnessAdapter } from "../runtime/harness/types.js";
import { renderHarnessPrompt } from "../runtime/harness/types.js";
import type { SupervisorCausalContext, SupervisorRecoveryTarget } from "./causal.js";
import type { FailureClassification } from "./classifier.js";
import {
  buildRequirementEvidenceMap,
  evidenceMapHasActionableEvidence,
  renderRequirementEvidenceMapMarkdown,
  selectEvidenceMapDelta
} from "./evidence_map.js";
import type {
  SupervisorCaseFile,
  SupervisorContextRepairPatch,
  SupervisorActionKind,
  SupervisorAuthorityFinding,
  SupervisorEvidenceGatherKind,
  SupervisorEvidenceGatherRequest,
  SupervisorEvidencePatch,
  SupervisorInterventionRecord,
  SupervisorMaterialDelta,
  SupervisorRecoveryEnvelope,
  SupervisorRecoveryPlan,
  SupervisorRuntimeOverlay,
  SupervisorValidationStrategyRepair,
  SupervisorWorkspaceRepairPatch,
  SupervisorEnvironmentRepair,
  SupervisorCausalCaseFile,
  SupervisorCausalTargetRecord,
  SupervisorRequirementEvidenceMap,
  RecoveryResumeDecision
} from "./types.js";

const evidenceConcurrencyCap = 4;
const externalUrlPattern = /https?:\/\/[^\s`"'<>),]+/gu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { value };
}

function readAttemptContextPaths(attempt: RuntimeNodeAttempt): SupervisorCaseFile["context"] {
  const metadata = isRecord(attempt.metadata) ? attempt.metadata : {};
  const contextPacketPath = typeof metadata.context_packet_path === "string" ? metadata.context_packet_path : undefined;
  const contextManifestPath = typeof metadata.context_manifest_path === "string" ? metadata.context_manifest_path : undefined;
  const contextProvenancePath =
    typeof metadata.context_provenance_path === "string" ? metadata.context_provenance_path : undefined;

  return {
    ...(contextPacketPath ? { packet_path: contextPacketPath } : {}),
    ...(contextManifestPath ?? attempt.context_manifest_path ? { manifest_path: contextManifestPath ?? attempt.context_manifest_path } : {}),
    ...(contextProvenancePath ? { provenance_path: contextProvenancePath } : {})
  };
}

function toCausalTargetRecord(target: SupervisorRecoveryTarget): SupervisorCausalTargetRecord {
  return {
    operation: target.operation,
    target_compiled_id: target.target_compiled_id,
    target_authored_id: target.target_authored_id,
    target_kind: target.target_kind,
    confidence: target.confidence,
    reason: target.reason,
    evidence: target.evidence,
    resume_compiled_id: target.resume_compiled_id,
    resume_authored_id: target.resume_authored_id,
    ...(target.target_prior_execution_id ? { target_prior_execution_id: target.target_prior_execution_id } : {}),
    symptom_compiled_id: target.symptom_compiled_id,
    symptom_authored_id: target.symptom_authored_id,
    symptom_execution_id: target.symptom_execution_id,
    requires_investigation: target.requires_investigation
  };
}

function toCausalCaseFile(context: SupervisorCausalContext): SupervisorCausalCaseFile {
  return {
    symptom: {
      compiled_id: context.symptom.compiled_id,
      authored_id: context.symptom.authored_id,
      kind: context.symptom.kind,
      execution_id: context.symptom.execution_id,
      failure_class: context.symptom.failure_class as SupervisorCausalCaseFile["symptom"]["failure_class"],
      summary: context.symptom.summary
    },
    upstream_cone: context.upstream_cone,
    target_candidates: context.target_candidates.map(toCausalTargetRecord),
    selected_target: toCausalTargetRecord(context.selected_target)
  };
}

function renderCausalSectionMarkdown(caseFile: SupervisorCaseFile): string[] {
  if (!caseFile.causal) {
    return [];
  }

  const selected = caseFile.causal.selected_target;
  return [
    "",
    "## Causal Recovery",
    `- Symptom node: \`${caseFile.causal.symptom.authored_id}\` (\`${caseFile.causal.symptom.compiled_id}\`)`,
    `- Selected target: \`${selected.target_authored_id}\` (\`${selected.target_compiled_id}\`)`,
    `- Operation: \`${selected.operation}\``,
    `- Confidence: \`${selected.confidence}\``,
    `- Requires investigation: \`${selected.requires_investigation}\``,
    "",
    "### Selected Target Reason",
    selected.reason,
    "",
    "### Upstream Cone",
    ...(caseFile.causal.upstream_cone.length > 0
      ? caseFile.causal.upstream_cone.map(
          (node) =>
            `- distance ${node.distance}: \`${node.authored_id}\` (\`${node.compiled_id}\`, ${node.kind}, status ${node.status ?? "unknown"})`
        )
      : ["- No upstream executable nodes were found."])
  ];
}

function renderCaseFileMarkdown(caseFile: SupervisorCaseFile): string {
  return [
    "# Supervisor Case File",
    "",
    `- Case: \`${caseFile.case_id}\``,
    `- Node: \`${caseFile.authored_id}\` (\`${caseFile.compiled_id}\`)`,
    `- Prior execution: \`${caseFile.prior_execution_id}\``,
    `- Failure class: \`${caseFile.failure_class}\``,
    `- Fingerprint: \`${caseFile.failure_fingerprint}\``,
    `- Repeated fingerprint count: \`${caseFile.repeated_fingerprint_count}\``,
    ...(caseFile.prompt_path ? [`- Exact prompt: \`${caseFile.prompt_path}\``] : []),
    "",
    "## Failure Summary",
    caseFile.failure_summary,
    "",
    "## Node Contract",
    "```json",
    JSON.stringify(caseFile.node_contract, null, 2),
    "```",
    "",
    "## Context",
    "```json",
    JSON.stringify(caseFile.context, null, 2),
    "```",
    "",
    "## Result",
    "```json",
    JSON.stringify(caseFile.result, null, 2),
    "```",
    "",
    "## Requirement Evidence Map",
    "```json",
    JSON.stringify(caseFile.requirement_evidence_map, null, 2),
    "```",
    ...(caseFile.retry_blocked_reason
      ? [
          "",
          "## Retry Blocked Reason",
          caseFile.retry_blocked_reason
        ]
      : []),
    ...renderCausalSectionMarkdown(caseFile)
  ].join("\n");
}

function renderEvidencePrompt(options: {
  gather: SupervisorEvidenceGatherRequest;
  caseFilePath: string;
  evidencePatchPath: string;
}): string {
  return renderHarnessPrompt({
    promptKind: "supervisor_evidence",
    runId: "supervisor",
    executionId: options.gather.gather_id,
    repoAlias: "supervisor",
    repoPath: "/",
    sandbox: "read-only",
    model: undefined,
    contextPacketPath: options.caseFilePath,
    contextManifestPath: options.caseFilePath,
    contextManifest: `Case file: ${options.caseFilePath}`,
    outputDir: dirname(options.evidencePatchPath),
    artifacts: {},
    timeoutSec: 300,
    signal: undefined,
    supervisorEvidence: {
      gatherKind: options.gather.kind,
      caseFilePath: options.caseFilePath,
      evidencePatchPath: options.evidencePatchPath,
      instructions: [
        options.gather.reason,
        "Gather only read-only evidence.",
        "Do not change the graph contract, repo authority, sandbox authority, or declared artifacts."
      ]
    }
  });
}

function patchClaims(kind: SupervisorEvidenceGatherKind, caseFile: SupervisorCaseFile): string[] {
  switch (kind) {
    case "local_context":
      return [
        "Recovered the failed attempt prompt, agent context/provenance, declared artifacts, logs, and result metadata from the local run tree.",
        "The retry should read the supervisor recovery brief before making scope-affecting decisions."
      ];
    case "pattern_mining":
      return [
        "The retry should inspect nearby repo patterns and upstream artifacts before inventing a new approach.",
        "Pattern evidence is advisory and cannot override the unchanged node contract."
      ];
    case "dependency_metadata":
      return [
        "The retry should inspect local dependency metadata, installed versions, lockfiles, and package manifests before using API assumptions.",
        "Dependency metadata can identify candidate official docs for external context gathering."
      ];
    case "external_context":
      return [
        "External context is allowed for read-only evidence gathering.",
        "External docs, release notes, public source, and examples may clarify missing API or workflow knowledge, but cannot change graph intent or declared artifacts."
      ];
    case "diagnostic_probe":
      return [
        "The retry should change strategy based on focused diagnostics instead of repeating the same failed tactic.",
        "Diagnostics should be scoped to the failed symptom and the unchanged node contract."
      ];
    case "semantic_rejudge":
      return [
        "The failed attempt should be rejudged against the original goal, acceptance criteria, constraints, and artifact contract.",
        "Semantic evidence can clarify intent alignment but cannot grant new authority."
      ];
    case "investigate_failure":
      return [
        "The failure is actionable only if the retry reads the failed output, stderr/stdout, artifacts, and case-file evidence first.",
        "If the same symptom appears again, the retry must change tactics or surface a precise blocker."
      ];
  }
}

function patchGuidance(kind: SupervisorEvidenceGatherKind, caseFile: SupervisorCaseFile): string[] {
  const promptGuidance = caseFile.prompt_path ? [`Read exact failed prompt: ${caseFile.prompt_path}`] : [];
  switch (kind) {
    case "external_context":
      return [
        "Use read-only external docs or public examples to resolve missing knowledge.",
        "Cite the external source in the final handoff or milestone evidence.",
        ...promptGuidance
      ];
    case "dependency_metadata":
      return [
        "Inspect package manifests and lockfiles before choosing dependency-specific APIs.",
        "Prefer official docs that match the installed or declared dependency version.",
        ...promptGuidance
      ];
    case "diagnostic_probe":
      return [
        "Run or inspect the best-scoped diagnostic that explains the failed symptom.",
        "Do not repeat a prior failed command or tactic unless the diagnostic evidence changed.",
        ...promptGuidance
      ];
    case "semantic_rejudge":
      return [
        "Restate how the retry will satisfy the unchanged acceptance criteria before editing.",
        "Treat verifier or semantic findings as blockers to address, not as optional commentary.",
        ...promptGuidance
      ];
    default:
      return [
        "Read the supervisor recovery brief and current artifact state before retrying.",
        "Preserve the original node intent, sandbox, repo authority, and declared artifacts.",
        ...promptGuidance
      ];
  }
}

function renderEvidencePatchMarkdown(patch: SupervisorEvidencePatch): string {
  return [
    "# Supervisor Evidence Patch",
    "",
    `- Patch: \`${patch.patch_id}\``,
    `- Gather: \`${patch.gather_id}\``,
    `- Kind: \`${patch.kind}\``,
    `- Status: \`${patch.status}\``,
    `- Confidence: \`${patch.confidence}\``,
    "",
    "## Claims",
    ...patch.claims.map((claim) => `- ${claim}`),
    "",
    "## Sources",
    ...(patch.sources.length > 0
      ? patch.sources.map((source) => `- ${source.label}${source.path ? `: \`${source.path}\`` : source.url ? `: ${source.url}` : ""}`)
      : ["- No source paths were available."]),
    "",
    "## Retry Guidance",
    ...patch.retry_guidance.map((item) => `- ${item}`),
    "",
    "## Conflicts",
    ...(patch.conflicts.length > 0 ? patch.conflicts.map((conflict) => `- ${conflict}`) : ["- None."])
  ].join("\n");
}

function parseHarnessPatch(
  value: unknown,
  fallback: SupervisorEvidencePatch
): SupervisorEvidencePatch {
  if (!isRecord(value)) {
    return fallback;
  }

  const claims = Array.isArray(value.claims)
    ? value.claims.filter((item): item is string => typeof item === "string")
    : fallback.claims;
  const retryGuidance = Array.isArray(value.retry_guidance)
    ? value.retry_guidance.filter((item): item is string => typeof item === "string")
    : fallback.retry_guidance;
  const conflicts = Array.isArray(value.conflicts)
    ? value.conflicts.filter((item): item is string => typeof item === "string")
    : fallback.conflicts;
  const confidence =
    value.confidence === "low" || value.confidence === "medium" || value.confidence === "high"
      ? value.confidence
      : fallback.confidence;
  const authorityFindings = Array.isArray(value.authority_findings)
    ? value.authority_findings.filter((item): item is SupervisorAuthorityFinding =>
        isRecord(item) &&
        (
          item.kind === "graph_contract_change" ||
          item.kind === "sandbox_expansion" ||
          item.kind === "repo_scope_expansion" ||
          item.kind === "external_side_effect" ||
          item.kind === "credential_or_auth_mention" ||
          item.kind === "operator_input_mention"
        ) &&
        typeof item.summary === "string" &&
        (item.evidence === undefined || Array.isArray(item.evidence))
      ).map((item) => ({
        kind: item.kind,
        summary: item.summary,
        ...(Array.isArray(item.evidence)
          ? { evidence: item.evidence.filter((evidence): evidence is string => typeof evidence === "string") }
          : {})
      }))
    : fallback.authority_findings;

  return {
    ...fallback,
    claims,
    retry_guidance: retryGuidance,
    conflicts,
    confidence,
    authority_findings: authorityFindings,
    metadata: {
      ...(fallback.metadata ?? {}),
      harness_output_json: value
    }
  };
}

function caseFileExternalUrls(caseFile: SupervisorCaseFile): string[] {
  const haystack = [
    caseFile.rendered_prompt ?? "",
    caseFile.failure_summary,
    JSON.stringify(caseFile.node_contract),
    JSON.stringify(caseFile.evidence)
  ].join("\n");

  return [
    ...new Set(
      Array.from(haystack.matchAll(externalUrlPattern), (match) =>
        match[0].replace(/[.;:]+$/u, "")
      )
    )
  ];
}

async function fetchExternalContext(caseFile: SupervisorCaseFile): Promise<
  | {
      url: string;
      status: number;
      excerpt: string;
    }
  | undefined
> {
  for (const url of caseFileExternalUrls(caseFile)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: controller.signal
      });
      const text = await response.text();

      if (!response.ok || text.trim().length === 0) {
        continue;
      }

      return {
        url,
        status: response.status,
        excerpt: text.trim().slice(0, 2000)
      };
    } catch {
      continue;
    } finally {
      clearTimeout(timeout);
    }
  }

  return undefined;
}

async function enrichExternalContextPatch(
  patch: SupervisorEvidencePatch,
  caseFile: SupervisorCaseFile
): Promise<SupervisorEvidencePatch> {
  if (patch.kind !== "external_context") {
    return patch;
  }

  const fetched = await fetchExternalContext(caseFile);
  if (!fetched) {
    return patch;
  }

  const excerptGuidance = `External context excerpt from ${fetched.url}: ${fetched.excerpt}`;

  return {
    ...patch,
    status: "passed",
    confidence: "high",
    claims: [
      ...patch.claims,
      `Fetched read-only external context from ${fetched.url}.`,
      `The fetched external context returned HTTP ${fetched.status}.`
    ],
    sources: [
      ...patch.sources,
      {
        label: "read-only external context",
        url: fetched.url
      }
    ],
    retry_guidance: [
      `Use read-only external context from ${fetched.url}.`,
      excerptGuidance,
      ...patch.retry_guidance
    ],
    metadata: {
      ...(patch.metadata ?? {}),
      external_context: fetched
    }
  };
}

async function writeEvidencePatch(options: {
  interventionDir: string;
  gather: SupervisorEvidenceGatherRequest;
  caseFile: SupervisorCaseFile;
  caseFileJsonPath: string;
  harness?: HarnessAdapter;
  model?: string;
  reasoning_effort?: EffectiveSupervisorPolicy["reasoning_effort"];
  harness_config?: EffectiveSupervisorPolicy["harness_config"];
  timeout_sec?: number;
  runId: string;
  workspacePath: string;
  contextManifestPath?: string;
  contextManifest?: string;
  signal?: AbortSignal;
}): Promise<SupervisorEvidencePatch> {
  const gatherDir = join(options.interventionDir, "evidence", options.gather.gather_id);
  await mkdir(gatherDir, { recursive: true });
  const promptPath = join(gatherDir, "prompt.md");
  const patchJsonPath = join(gatherDir, "evidence-patch.json");
  const patchMdPath = join(gatherDir, "evidence-patch.md");
  const stdoutPath = join(gatherDir, "stdout.log");
  const stderrPath = join(gatherDir, "stderr.log");
  const resultPath = join(gatherDir, "result.json");
  const prompt = renderEvidencePrompt({
    gather: options.gather,
    caseFilePath: options.caseFileJsonPath,
    evidencePatchPath: patchJsonPath
  });
  await writeFile(promptPath, `${prompt}\n`, "utf8");

  let status: SupervisorEvidencePatch["status"] = "passed";
  let stdout = "";
  let stderr = "";
  let resultMetadata: Record<string, unknown> = {
    mode: "deterministic"
  };

  const fallbackPatch: SupervisorEvidencePatch = await enrichExternalContextPatch({
    patch_id: `${options.caseFile.case_id}__${options.gather.gather_id}`,
    gather_id: options.gather.gather_id,
    kind: options.gather.kind,
    case_id: options.caseFile.case_id,
    status,
    claims: patchClaims(options.gather.kind, options.caseFile),
    sources: [
      {
        label: "supervisor case file",
        path: options.caseFileJsonPath
      },
      ...(options.caseFile.prompt_path
        ? [
            {
              label: "exact failed node prompt",
              path: options.caseFile.prompt_path
            }
          ]
        : [])
    ],
    confidence: options.gather.kind === "external_context" ? "medium" : "high",
    conflicts: [],
    retry_guidance: patchGuidance(options.gather.kind, options.caseFile),
    authority_findings: [],
    created_at: nowIso(),
    artifact_paths: {
      prompt: promptPath,
      patch_json: patchJsonPath,
      patch_markdown: patchMdPath,
      stdout: stdoutPath,
      stderr: stderrPath,
      result: resultPath
    }
  }, options.caseFile);

  let patch = fallbackPatch;

  if (options.harness && ["external_context", "semantic_rejudge", "investigate_failure"].includes(options.gather.kind)) {
    try {
      const harnessResult = await options.harness.run({
        promptKind: "supervisor_evidence",
        runId: options.runId,
        executionId: `${options.caseFile.prior_execution_id}__${options.gather.gather_id}`,
        repoAlias: options.caseFile.node_contract.repo_alias,
        repoPath: options.workspacePath,
        sandbox: "read-only",
        model: options.model,
        ...(options.reasoning_effort ? { reasoningEffort: options.reasoning_effort } : {}),
        ...(options.harness_config ? { harnessConfig: options.harness_config } : {}),
        contextPacketPath: options.caseFileJsonPath,
        contextManifestPath: options.contextManifestPath ?? options.caseFileJsonPath,
        contextManifest: options.contextManifest ?? `Case file: ${options.caseFileJsonPath}`,
        outputDir: gatherDir,
        artifacts: {},
        timeoutSec: Math.min(options.timeout_sec ?? 300, 300),
        signal: options.signal,
        promptPath,
        supervisorEvidence: {
          gatherKind: options.gather.kind,
          caseFilePath: options.caseFileJsonPath,
          evidencePatchPath: patchJsonPath,
          instructions: [
            options.gather.reason,
            "Return compact JSON evidence. External context is read-only and always allowed.",
            "Do not change graph intent, repo authority, sandbox authority, acceptance criteria, or declared artifacts."
          ]
        }
      });
      stdout = harnessResult.stdout ?? "";
      stderr = harnessResult.stderr ?? "";
      status = harnessResult.status === "passed" ? "passed" : "failed";
      resultMetadata = {
        mode: "harness",
        exit_code: harnessResult.exitCode,
        metadata: harnessResult.metadata ?? {}
      };
      patch = parseHarnessPatch(harnessResult.outputJson, {
        ...fallbackPatch,
        status,
        metadata: {
          ...(fallbackPatch.metadata ?? {}),
          ...resultMetadata
        }
      });
    } catch (error) {
      stderr = error instanceof Error ? error.message : String(error);
      const hasFetchedExternalContext = isRecord(fallbackPatch.metadata) && isRecord(fallbackPatch.metadata.external_context);
      status = hasFetchedExternalContext ? "passed" : "failed";
      resultMetadata = {
        mode: "harness",
        error: stderr,
        fallback_used: true
      };
      patch = {
        ...fallbackPatch,
        status,
        confidence: hasFetchedExternalContext ? fallbackPatch.confidence : "low",
        conflicts: hasFetchedExternalContext
          ? fallbackPatch.conflicts
          : [...fallbackPatch.conflicts, "Supervisor evidence harness failed; deterministic fallback evidence was used."],
        metadata: {
          ...(fallbackPatch.metadata ?? {}),
          ...resultMetadata
        }
      };
    }
  }

  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  await writeFile(resultPath, `${JSON.stringify(resultMetadata, null, 2)}\n`, "utf8");
  await writeFile(patchJsonPath, `${JSON.stringify(patch, null, 2)}\n`, "utf8");
  await writeFile(patchMdPath, `${renderEvidencePatchMarkdown(patch)}\n`, "utf8");
  return patch;
}

function selectApplyAction(options: {
  action: SupervisorActionKind;
  classification: FailureClassification;
  caseFile?: SupervisorCaseFile;
  requirementEvidenceMap?: SupervisorRequirementEvidenceMap;
  patches: SupervisorEvidencePatch[];
  causalContext?: SupervisorCausalContext;
}): SupervisorRecoveryPlan["apply_action"] {
  if (
    options.classification.class === "graph_context_gap" ||
    options.classification.class === "unprovable_requirement"
  ) {
    return "fail_contract_gap";
  }

  if (options.classification.class === "non_recoverable") {
    return "fail_terminal";
  }

  if (options.classification.class === "authority_required") {
    return "pause_for_authority";
  }

  const operation = options.causalContext?.selected_target.operation;
  const graphContractFinding = options.patches.some((patch) =>
    patch.authority_findings.some((finding) => finding.kind === "graph_contract_change")
  );
  const hardAuthorityFinding = options.patches.some((patch) =>
    patch.authority_findings.some((finding) =>
      finding.kind === "sandbox_expansion" ||
      finding.kind === "repo_scope_expansion"
    )
  );
  if (hardAuthorityFinding) {
    return "fail_contract_gap";
  }

  const retryableCurrentContractOperation =
    operation === "repair_current_node" ||
    operation === "repair_upstream_node" ||
    operation === "investigate_causal_cone";
  const retryableCurrentContractFailure =
    options.classification.class === "semantic_misalignment" ||
    options.classification.class === "completion_contract_failure" ||
    options.classification.class === "artifact_contract_failure" ||
    options.classification.class === "missing_dependency_docs" ||
    options.classification.class === "wrong_local_pattern" ||
    options.classification.class === "unknown";
  if (graphContractFinding && !(retryableCurrentContractOperation && retryableCurrentContractFailure)) {
    return "fail_contract_gap";
  }

  if (operation === "pause_for_authority") {
    return "pause_for_authority";
  }
  if (operation === "repair_context") {
    return "repair_context";
  }
  if (operation === "repair_evidence_context") {
    return "repair_evidence_context";
  }
  if (operation === "repair_artifact") {
    return "repair_artifact";
  }
  if (operation === "repair_validation_strategy") {
    return "repair_validation_strategy";
  }
  if (operation === "repair_workspace") {
    return "repair_workspace";
  }
  if (operation === "repair_environment") {
    return "repair_environment";
  }
  if (operation === "rerun_verification") {
    return "rerun_verification";
  }
  if (operation === "fail_contract_gap") {
    return "fail_contract_gap";
  }
  if (options.classification.evidence.verification_substrate_failure === true) {
    return "rerun_verification";
  }
  const repeated = options.caseFile ? options.caseFile.repeated_fingerprint_count >= 2 : false;
  const hasActionableEvidenceMap = options.requirementEvidenceMap
    ? evidenceMapHasActionableEvidence(options.requirementEvidenceMap)
    : false;
  const hasMaterialEvidencePatch = options.patches.some((patch) =>
    patch.status === "passed" &&
    patch.sources.some((source) =>
      Boolean(source.url) ||
      (
        Boolean(source.path) &&
        !["supervisor case file", "exact failed node prompt"].includes(source.label.toLowerCase())
      )
    )
  );
  if (
    repeated &&
    ["semantic_misalignment", "repeated_failure", "unknown"].includes(options.classification.class) &&
    !hasActionableEvidenceMap &&
    !hasMaterialEvidencePatch
  ) {
    return "fail_contract_gap";
  }
  if (operation === "repair_current_node" || operation === "repair_upstream_node" || operation === "investigate_causal_cone") {
    return "retry_with_evidence";
  }

  if (options.classification.class === "diagnostic_needed") {
    return "repair_validation_strategy";
  }

  if (options.classification.evidence.workspace_repair_candidate === true) {
    return "repair_workspace";
  }

  if (options.classification.evidence.environment_repair_candidate === true) {
    return "repair_environment";
  }

  if (options.action === "repair_artifact" || options.classification.recommended_action === "repair_artifact") {
    return "repair_artifact";
  }

  if (options.action === "fail" || options.classification.recommended_action === "fail") {
    return options.classification.retryable ? "retry_with_evidence" : "fail_terminal";
  }

  return "retry_with_evidence";
}

function retryableApplyAction(action: SupervisorRecoveryPlan["apply_action"]): boolean {
  return [
    "repair_context",
    "repair_evidence_context",
    "repair_validation_strategy",
    "repair_workspace",
    "repair_environment",
    "rerun_verification",
    "retry_with_evidence"
  ].includes(action);
}

function workspaceDecisionForRecoveryPlan(plan: SupervisorRecoveryPlan): SupervisorRecoveryEnvelope["workspace_decision"] {
  if (plan.apply_action === "repair_workspace") {
    return "partial_cleanup";
  }

  return "preserve";
}

function isUnsafePriorProgress(classification: FailureClassification): boolean {
  return classification.evidence.prior_progress_unsafe === true;
}

function buildRecoveryResumeDecision(options: {
  recoveryPlan: SupervisorRecoveryPlan;
  classification: FailureClassification;
  workspaceRepairPatch?: SupervisorWorkspaceRepairPatch;
}): RecoveryResumeDecision {
  const plan = options.recoveryPlan;
  const requiredNextAction = requiredNextActionForRecoveryPlan(plan);
  const validationGate = plan.retry_directive?.validation_focus.length
    ? plan.retry_directive.validation_focus
    : ["Rerun the validation named by the original task when feasible."];
  const operation = plan.recovery_target?.operation;
  const unsafePriorProgress = isUnsafePriorProgress(options.classification);

  if (plan.apply_action === "rerun_verification") {
    return {
      resume_point: "rerun_verification",
      restart_boundary: "verification",
      workspace_decision: "preserve",
      reuse: ["Reuse completed worker output and declared artifacts from the prior attempt."],
      discard: ["Discard only the failed verification substrate attempt."],
      reason_code: "verification_substrate_failure",
      confidence: "high",
      evidence: ["Runtime reported a structured verification substrate failure."],
      required_next_action: requiredNextAction,
      validation_gate: validationGate
    };
  }

  if (plan.apply_action === "repair_validation_strategy") {
    return {
      resume_point: "repair_validation_strategy",
      restart_boundary: "verification",
      workspace_decision: "preserve",
      reuse: ["Reuse prior implementation progress unless focused validation proves a work defect."],
      discard: ["Discard the prior broad or ambiguous validation tactic."],
      reason_code: "validation_strategy_repair",
      confidence: "high",
      evidence: ["Supervisor selected a validation-strategy material delta."],
      required_next_action: requiredNextAction,
      validation_gate: validationGate
    };
  }

  if (plan.apply_action === "repair_workspace" && unsafePriorProgress) {
    return {
      resume_point: "fresh_retry",
      restart_boundary: "node_attempt",
      workspace_decision: "reset",
      reuse: ["Reuse the original node contract, context pointers, and any upstream accepted artifacts."],
      discard: [
        "Discard failed attempt workspace changes before retrying.",
        ...(options.workspaceRepairPatch
          ? [`Restore the failed attempt diff recorded at ${options.workspaceRepairPatch.changed_files_path}.`]
          : [])
      ],
      reason_code: "prior_progress_unsafe",
      confidence: "high",
      evidence: [
        "Structured verifier categories marked prior progress unsafe.",
        ...(options.workspaceRepairPatch
          ? [`Workspace repair can restore ${options.workspaceRepairPatch.changed_file_count} failed-attempt changed file(s).`]
          : [])
      ],
      required_next_action: requiredNextAction,
      validation_gate: validationGate
    };
  }

  if (plan.apply_action === "repair_workspace") {
    return {
      resume_point: "repair_workspace",
      restart_boundary: "node_attempt",
      workspace_decision: "partial_cleanup",
      reuse: ["Preserve in-scope prior progress that is not part of the failed attempt cleanup."],
      discard: [
        "Remove failed attempt workspace pollution before retrying.",
        ...(options.workspaceRepairPatch
          ? [`Restore the failed attempt diff recorded at ${options.workspaceRepairPatch.changed_files_path}.`]
          : [])
      ],
      reason_code: "workspace_pollution_cleanup",
      confidence: "high",
      evidence: [
        "Runtime reported a structured workspace repair candidate.",
        ...(options.workspaceRepairPatch
          ? [`Workspace repair can restore ${options.workspaceRepairPatch.changed_file_count} failed-attempt changed file(s).`]
          : [])
      ],
      required_next_action: requiredNextAction,
      validation_gate: validationGate
    };
  }

  if (operation === "repair_upstream_node") {
    return {
      resume_point: plan.recovery_target?.target_prior_execution_id
        ? "continue_from_prior_progress"
        : "fresh_retry",
      restart_boundary: "upstream_target",
      workspace_decision: "preserve",
      reuse: ["Reuse current-node failure evidence to repair the selected upstream target."],
      discard: ["Discard assumptions made from the stale or invalid upstream artifact."],
      reason_code: "upstream_target_selected",
      confidence: plan.confidence,
      evidence: plan.recovery_target?.evidence ?? ["Supervisor selected an upstream recovery target."],
      required_next_action: requiredNextAction,
      validation_gate: validationGate
    };
  }

  if (plan.apply_action === "fail_contract_gap" || plan.apply_action === "fail_terminal") {
    return {
      resume_point: "fail_contract_gap",
      restart_boundary: "node_attempt",
      workspace_decision: "preserve",
      reuse: ["Preserve evidence for the terminal contract failure."],
      discard: ["No retry should be attempted without a new material delta or graph change."],
      reason_code: "contract_gap",
      confidence: plan.confidence,
      evidence: [plan.terminal_reason ?? "Supervisor selected terminal contract failure."],
      required_next_action: requiredNextAction,
      validation_gate: validationGate
    };
  }

  return {
    resume_point: plan.recovery_target?.target_prior_execution_id
      ? "continue_from_prior_progress"
      : "fresh_retry",
    restart_boundary: "node_attempt",
    workspace_decision: workspaceDecisionForRecoveryPlan(plan),
    reuse: preserveProgressForRecoveryPlan(plan),
    discard: doNotRedoForRecoveryPlan(plan),
    reason_code: plan.recovery_target?.target_prior_execution_id
      ? "evidence_delta_retry"
      : "fresh_retry_required",
    confidence: plan.confidence,
    evidence: plan.runtime_overlay?.material_delta.map((delta) => delta.summary) ?? plan.merged_claims,
    required_next_action: requiredNextAction,
    validation_gate: validationGate
  };
}

function preserveProgressForRecoveryPlan(plan: SupervisorRecoveryPlan): string[] {
  const items = [
    plan.recovery_target?.target_prior_execution_id
      ? `Preserve in-scope progress and declared artifacts from prior execution ${plan.recovery_target.target_prior_execution_id} unless the recovery brief identifies them as unsafe.`
      : "No useful prior execution progress was identified for this target.",
    ...(plan.runtime_overlay?.material_delta ?? []).map((delta) => `Runtime delta: ${delta.summary}`)
  ];

  return [...new Set(items.filter((item) => item.trim().length > 0))].slice(0, 8);
}

function requiredNextActionForRecoveryPlan(plan: SupervisorRecoveryPlan): string {
  return plan.retry_directive?.must_do[0]
    ?? plan.repair_directive?.summary
    ?? plan.terminal_reason
    ?? "Use the recovery brief to continue from the selected resume point.";
}

function doNotRedoForRecoveryPlan(plan: SupervisorRecoveryPlan): string[] {
  const items = [
    ...(plan.retry_directive?.must_not_do ?? []),
    plan.apply_action === "rerun_verification"
      ? "Do not rerun or rewrite completed worker output unless verification produces a structured work-defect finding."
      : "Do not restart from scratch when prior in-scope progress can be preserved."
  ];

  return [...new Set(items.filter((item) => item.trim().length > 0))].slice(0, 8);
}

function buildContextRepairPatch(options: {
  caseFile: SupervisorCaseFile;
  analysis: ContextAnalysisNode;
  analysisPath: string;
}): SupervisorContextRepairPatch {
  const text = createCompactContextIndex(options.analysis);
  return {
    patch_id: `${options.caseFile.case_id}__context_repair`,
    strategy: "replace_authored_context",
    reason: "Supervisor provided a compact pointer index and omission provenance for the authored context.",
    materials: [
      {
        key: "supervisor_context_repair",
        title: "Supervisor context repair package",
        text
      }
    ],
    omitted: options.analysis.items.map((item) => ({
      key: item.key,
      reason: `Original ${item.kind} context "${item.name}" was not provided directly after context repair. Use the compact index and live workspace paths when more detail is needed.`,
      source_name: item.name,
      ...(item.path ? { source_path: item.path } : {})
    })),
    analysis_path: options.analysisPath,
    created_at: nowIso()
  };
}

function readWorkspaceRepairPatch(options: {
  caseFile: SupervisorCaseFile;
  attempt: RuntimeNodeAttempt;
  resultPath: string;
}): SupervisorWorkspaceRepairPatch | undefined {
  const metadata = isRecord(options.attempt.metadata) ? options.attempt.metadata : {};
  const changes = isRecord(metadata.node_workspace_changes) ? metadata.node_workspace_changes : undefined;
  const baselinePath = typeof changes?.baseline_path === "string" ? changes.baseline_path : undefined;
  const changedFilesPath =
    typeof changes?.changed_files_path === "string" ? changes.changed_files_path : undefined;
  const changedFileCount =
    typeof changes?.changed_file_count === "number" ? changes.changed_file_count : undefined;
  const statusPath = typeof changes?.status_path === "string" ? changes.status_path : undefined;
  const diffPatchPath = typeof changes?.diff_patch_path === "string" ? changes.diff_patch_path : undefined;

  if (!baselinePath || !changedFilesPath || !changedFileCount || changedFileCount <= 0) {
    return undefined;
  }

  return {
    patch_id: `${options.caseFile.case_id}__workspace_repair`,
    strategy: "restore_failed_attempt_changes",
    reason: "The failed attempt changed workspace files outside the intended scope; restore that attempt-owned diff before retry.",
    baseline_path: baselinePath,
    changed_files_path: changedFilesPath,
    ...(statusPath ? { status_path: statusPath } : {}),
    ...(diffPatchPath ? { diff_patch_path: diffPatchPath } : {}),
    changed_file_count: changedFileCount,
    result_path: options.resultPath,
    created_at: nowIso()
  };
}

function buildRuntimeOverlay(options: {
  overlayId: string;
  applyAction: SupervisorRecoveryPlan["apply_action"];
  classification: FailureClassification;
  symptomCompiledId: string;
  causalContext?: SupervisorCausalContext;
  requirementEvidenceMap?: SupervisorRequirementEvidenceMap;
  selectedDelta?: SupervisorMaterialDelta;
  contextRepairPatch?: SupervisorContextRepairPatch;
  workspaceRepairPatch?: SupervisorWorkspaceRepairPatch;
  evidencePatches: SupervisorEvidencePatch[];
}): SupervisorRuntimeOverlay | undefined {
  const deltas: SupervisorMaterialDelta[] = [];
  let validationStrategy: SupervisorValidationStrategyRepair | undefined;
  let environmentRepair: SupervisorEnvironmentRepair | undefined;

  if (options.contextRepairPatch) {
    deltas.push({
      kind: "context_changed",
      summary: "Replaced the authored context pointer packet with a compact supervisor context repair package."
    });
  }

  if (
    options.selectedDelta &&
    options.applyAction === "retry_with_evidence" &&
    !deltas.some((delta) => delta.kind === options.selectedDelta?.kind)
  ) {
    deltas.push(options.selectedDelta);
  }

  const selectedTarget = options.causalContext?.selected_target;
  if (
    selectedTarget &&
    options.applyAction === "retry_with_evidence" &&
    selectedTarget.target_compiled_id !== options.symptomCompiledId &&
    selectedTarget.evidence.length > 0
  ) {
    deltas.push({
      kind: "target_reranked_with_evidence",
      summary: `Reranked recovery from symptom ${options.symptomCompiledId} to ${selectedTarget.target_compiled_id} using causal evidence.`,
      artifact_paths: {}
    });
  }

  if (
    options.requirementEvidenceMap &&
    evidenceMapHasActionableEvidence(options.requirementEvidenceMap) &&
    options.applyAction === "retry_with_evidence" &&
    !deltas.some((delta) => delta.kind === "requirement_evidence_mapped")
  ) {
    deltas.push({
      kind: "requirement_evidence_mapped",
      summary: "Mapped failed requirements to current run evidence so the retry has a concrete evidence target."
    });
  }

  if (
    options.applyAction === "retry_with_evidence" &&
    options.classification.class === "semantic_misalignment" &&
    options.evidencePatches.some((patch) => patch.conflicts.length > 0) &&
    !deltas.some((delta) => delta.kind === "public_artifact_consistency_repair")
  ) {
    deltas.push({
      kind: "public_artifact_consistency_repair",
      summary: "Mapped public artifact conflicts so the retry can republish a mutually consistent artifact set."
    });
  }

  if (options.workspaceRepairPatch) {
    deltas.push({
      kind: "workspace_cleaned",
      summary: `Restore ${options.workspaceRepairPatch.changed_file_count} file change(s) from the failed attempt before retry.`,
      artifact_paths: {
        baseline: options.workspaceRepairPatch.baseline_path,
        changed_files: options.workspaceRepairPatch.changed_files_path,
        ...(options.workspaceRepairPatch.diff_patch_path ? { diff: options.workspaceRepairPatch.diff_patch_path } : {}),
        ...(options.workspaceRepairPatch.result_path ? { result: options.workspaceRepairPatch.result_path } : {})
      }
    });
  }

  if (options.applyAction === "repair_environment") {
    environmentRepair = {
      reason: options.classification.summary,
      safe_repairs: [
        "Regenerate per-execution Agentflow tool wrappers.",
        "Refresh runtime PATH and Agentflow metadata for the next attempt.",
        "Validate local runtime/tool availability through the normal executor setup path."
      ],
      retry_effect: "The next attempt receives freshly generated wrappers and runtime metadata without changing graph authority."
    };
    deltas.push({
      kind: "environment_repaired",
      summary: "Refresh safe per-execution runtime wrappers and PATH metadata before retry."
    });
  }

  if (options.applyAction === "repair_validation_strategy") {
    validationStrategy = {
      reason: options.classification.summary,
      focus: [
        "Use the narrowest validation command or diagnostic that proves the failed symptom.",
        "Capture the exact command, exit code, and relevant stdout/stderr before final handoff.",
        "If a broad validation command timed out or failed ambiguously, run a focused check first and then the broader command only when practical."
      ],
      avoid_repeating: [
        "Do not rerun the same timeout-prone or ambiguous command as the only validation step.",
        "Do not claim validation passed without command evidence."
      ],
      required_handoff_evidence: [
        "focused validation command",
        "result or exit code",
        "remaining broad-suite risk, if any"
      ]
    };
    deltas.push({
      kind: "validation_strategy_changed",
      summary: "Changed retry validation guidance to use focused diagnostics before broad validation."
    });
  }

  if (options.applyAction === "rerun_verification") {
    deltas.push({
      kind: "validation_strategy_changed",
      summary: "Retry is limited to the verification substrate; do not rerun completed worker output unless verification produces a structured work-defect finding."
    });
  }

  if (!retryableApplyAction(options.applyAction) && options.applyAction !== "repair_artifact") {
    return undefined;
  }

  return {
    overlay_id: options.overlayId,
    apply_action: options.applyAction,
    material_delta: deltas,
    ...(options.contextRepairPatch ? { context_repair: options.contextRepairPatch } : {}),
    ...(validationStrategy ? { validation_strategy: validationStrategy } : {}),
    ...(options.workspaceRepairPatch ? { workspace_repair: options.workspaceRepairPatch } : {}),
    ...(environmentRepair ? { environment_repair: environmentRepair } : {}),
    created_at: nowIso()
  };
}

function isAgentFacingEvidencePath(value: string): boolean {
  if (value.trim().length === 0) {
    return false;
  }
  return !/(^|[/\\])(human-debug|runtime)([/\\]|$)/u.test(value)
    && !/(^|[/\\])agent[/\\](prompt|context|attempt-memory|supervisor-recovery|response)\.md$/u.test(value)
    && !/(^|[/\\])(case-file|recovery-plan|recovery-envelope)\.json$/u.test(value);
}

function isAgentFacingGuidance(value: string): boolean {
  const lower = value.toLowerCase();
  return !/(human-debug|evidence-patch|case-file|recovery-plan|recovery-envelope|runtime[/\\]supervisor|intervention bundle|exact failed prompt|[/\\]agent[/\\](prompt|context|attempt-memory|supervisor-recovery|response)\.md|[/\\]runtime[/\\])/u.test(lower);
}

function buildRetryDirective(options: {
  classification: FailureClassification;
  caseFile: SupervisorCaseFile;
  patches: SupervisorEvidencePatch[];
  runtimeOverlay?: SupervisorRuntimeOverlay;
  requirementEvidenceMapPath?: string;
}): SupervisorRecoveryEnvelope["retry_directive"] {
  const retryGuidance = options.patches.flatMap((patch) => patch.retry_guidance).filter(isAgentFacingGuidance);
  const overlayGuidance = options.runtimeOverlay?.context_repair
    ? [
        "Use the supervisor context repair package as the active context index.",
        "Open live workspace files listed in the repair package when additional detail is needed."
      ]
    : [];
  const workspaceGuidance = options.runtimeOverlay?.workspace_repair
    ? [
        "Treat the retry as a clean attempt after supervisor workspace cleanup.",
        "Stay inside the intended node scope and avoid recreating unrelated or forbidden edits."
      ]
    : [];
  const environmentGuidance = options.runtimeOverlay?.environment_repair
    ? [
        "Use the refreshed Agentflow runtime wrappers and PATH metadata from this retry.",
        "If a local tool is still unavailable, capture exact command evidence before final handoff."
      ]
    : [];
  const validationGuidance = options.runtimeOverlay?.validation_strategy
    ? [
        ...options.runtimeOverlay.validation_strategy.focus,
        ...options.runtimeOverlay.validation_strategy.avoid_repeating,
        `Final handoff must include: ${options.runtimeOverlay.validation_strategy.required_handoff_evidence.join(", ")}.`
      ]
    : [];
  const evidenceMapGuidance = options.runtimeOverlay?.material_delta.some((delta) => delta.kind === "requirement_evidence_mapped")
    ? [
        "Use the recovery summary and artifact evidence pointers to address each failed or missing requirement before retry completion.",
        "Do not retry by only rereading the recovery brief; cite current artifacts or produce new valid evidence."
      ]
    : [];
  const evidenceToRead = (options.runtimeOverlay?.material_delta ?? [])
    .flatMap((delta) => Object.values(delta.artifact_paths ?? {}))
    .filter(isAgentFacingEvidencePath);
  const dedupedGuidance = [
    ...new Set([
      ...overlayGuidance,
      ...workspaceGuidance,
      ...environmentGuidance,
      ...validationGuidance,
      ...evidenceMapGuidance,
      ...retryGuidance
    ])
  ].slice(0, 12);

  return {
    summary: options.classification.summary,
    must_do: dedupedGuidance.length > 0
      ? dedupedGuidance
      : ["Read the supervisor recovery brief and current artifact state before retrying."],
    must_not_do: [
      "Do not change the original goal, acceptance criteria, constraints, repo authority, sandbox, or declared artifacts.",
      "Do not repeat the exact failed tactic without new evidence.",
      "Do not treat external context as authority to alter graph intent."
    ],
    evidence_to_read: [...new Set(evidenceToRead)],
    validation_focus: [
      "Run the validation named by the original task or context when feasible.",
      "Address the concrete failed symptom before writing the final handoff."
    ],
    unchanged_contract: {
      goal: true,
      acceptance_criteria: true,
      constraints: true,
      repo_authority: true,
      sandbox: true,
      declared_artifacts: true
    }
  };
}

function renderRecoveryPlanMarkdown(plan: SupervisorRecoveryPlan): string {
  return [
    "# Supervisor Recovery Plan",
    "",
    `- Plan: \`${plan.plan_id}\``,
    `- Case: \`${plan.case_id}\``,
    `- Classification: \`${plan.classification}\``,
    `- Apply action: \`${plan.apply_action}\``,
    `- Confidence: \`${plan.confidence}\``,
    "",
    "## Merged Claims",
    ...(plan.merged_claims.length > 0 ? plan.merged_claims.map((claim) => `- ${claim}`) : ["- None."]),
    "",
    "## Conflicts",
    ...(plan.conflicts.length > 0 ? plan.conflicts.map((conflict) => `- ${conflict}`) : ["- None."]),
    ...(plan.retry_directive
      ? [
          "",
          "## Retry Directive",
          plan.retry_directive.summary,
          "",
          "### Must Do",
          ...plan.retry_directive.must_do.map((item) => `- ${item}`)
        ]
      : [])
  ].join("\n");
}

function buildRecoveryPlan(options: {
  planId: string;
  action: SupervisorActionKind;
  classification: FailureClassification;
  caseFile: SupervisorCaseFile;
  patches: SupervisorEvidencePatch[];
  runtimeOverlay?: SupervisorRuntimeOverlay;
  causalContext?: SupervisorCausalContext;
  requirementEvidenceMapPath?: string;
}): SupervisorRecoveryPlan {
  const applyAction = selectApplyAction({
    action: options.action,
    classification: options.classification,
    caseFile: options.caseFile,
    requirementEvidenceMap: options.caseFile.requirement_evidence_map,
    patches: options.patches,
    ...(options.causalContext ? { causalContext: options.causalContext } : {})
  });
  const conflicts = options.patches.flatMap((patch) => patch.conflicts);
  const mergedClaims = [...new Set(options.patches.flatMap((patch) => patch.claims))];
  const retryDirective =
    retryableApplyAction(applyAction)
      ? buildRetryDirective({
          classification: options.classification,
          caseFile: options.caseFile,
          patches: options.patches,
          ...(options.runtimeOverlay ? { runtimeOverlay: options.runtimeOverlay } : {}),
          ...(options.requirementEvidenceMapPath ? { requirementEvidenceMapPath: options.requirementEvidenceMapPath } : {})
        })
      : undefined;

  return {
    plan_id: options.planId,
    case_id: options.caseFile.case_id,
    classification: options.classification.class,
    apply_action: applyAction,
    ...(options.causalContext
      ? {
          operation: options.causalContext.selected_target.operation,
          recovery_target: toCausalTargetRecord(options.causalContext.selected_target)
        }
      : {}),
    ...(retryDirective ? { retry_directive: retryDirective } : {}),
    ...(options.runtimeOverlay ? { runtime_overlay: options.runtimeOverlay } : {}),
    ...(applyAction === "repair_artifact"
      ? {
          repair_directive: {
            summary: options.classification.summary,
            evidence_to_read: options.patches.flatMap((patch) => Object.values(patch.artifact_paths))
          }
        }
      : {}),
    ...(applyAction === "pause_for_authority"
      ? {
	          pause_request: {
	            reason: options.classification.summary,
	            unblock_request: "Provide the specific credential, harness authentication, planned checkpoint decision, external side-effect approval, or operator-authored input requested by the typed authority request."
	          }
	        }
      : {}),
    ...(applyAction === "fail_terminal" || applyAction === "fail_contract_gap"
      ? { terminal_reason: options.caseFile.retry_blocked_reason ?? options.classification.summary }
      : {}),
    confidence: conflicts.length > 0 ? "medium" : "high",
    merged_claims: mergedClaims,
    provenance: options.patches.map((patch) => ({
      patch_id: patch.patch_id,
      kind: patch.kind,
      sources: patch.sources
    })),
    conflicts,
    created_at: nowIso()
  };
}

function renderRecoveryEnvelopeMarkdown(envelope: SupervisorRecoveryEnvelope): string {
  const directive = envelope.retry_directive;
  return [
    "# Supervisor Recovery Case",
    "",
    "The original goal, acceptance criteria, constraints, repo authority, sandbox, and declared artifacts are unchanged.",
    "",
    `- Prior execution: \`${envelope.prior_execution_id}\``,
    `- Classification: \`${envelope.classification}\``,
    `- Selected action: \`${envelope.action}\``,
    `- Resume point: \`${envelope.resume_point}\``,
    `- Restart boundary: \`${envelope.resume_decision.restart_boundary}\``,
    `- Workspace decision: \`${envelope.workspace_decision}\``,
    `- Resume reason: \`${envelope.resume_decision.reason_code}\``,
    `- Failure fingerprint: \`${envelope.failure_fingerprint}\``,
    `- Repeated fingerprint count: \`${envelope.repeated_fingerprint_count}\``,
    "",
    "## Summary",
    directive.summary,
    "",
    "## Must Do",
    ...directive.must_do.map((item) => `- ${item}`),
    "",
    "## Preserve Progress",
    ...(envelope.preserve_progress.length > 0
      ? envelope.preserve_progress.map((item) => `- ${item}`)
      : ["- Preserve in-scope prior progress unless the recovery evidence says it is unsafe."]),
    "",
    "## Reuse",
    ...envelope.resume_decision.reuse.map((item) => `- ${item}`),
    "",
    "## Discard",
    ...envelope.resume_decision.discard.map((item) => `- ${item}`),
    "",
    "## Must Not Do",
    ...[...new Set([...directive.must_not_do, ...envelope.do_not_redo])].map((item) => `- ${item}`),
    "",
    "## Required Next Action",
    envelope.required_next_action,
    "",
    "",
    "## Evidence To Inspect",
    ...(directive.evidence_to_read.length > 0
      ? directive.evidence_to_read.map((item) => `- ${item}`)
      : ["- None beyond the active context pointers and prior attempt artifacts."]),
    "",
    "## Validation Focus",
    ...(directive.validation_focus.length > 0
      ? directive.validation_focus.map((item) => `- ${item}`)
      : ["- Re-run the validation named by the original task when feasible."])
  ].join("\n");
}

function renderCausalTargetsMarkdown(causal: SupervisorCausalCaseFile): string {
  return [
    "# Supervisor Causal Targets",
    "",
    `- Symptom: \`${causal.symptom.authored_id}\` (\`${causal.symptom.compiled_id}\`)`,
    `- Selected target: \`${causal.selected_target.target_authored_id}\` (\`${causal.selected_target.target_compiled_id}\`)`,
    "",
    "## Candidates",
    ...causal.target_candidates.map((target, index) => [
      `${index + 1}. \`${target.target_authored_id}\` (\`${target.target_compiled_id}\`)`,
      `   - Operation: \`${target.operation}\``,
      `   - Confidence: \`${target.confidence}\``,
      `   - Reason: ${target.reason}`
    ].join("\n"))
  ].join("\n");
}

function renderRecoveryChainMarkdown(options: {
  causal?: SupervisorCausalCaseFile;
  recoveryPlan: SupervisorRecoveryPlan;
  materialDelta: SupervisorMaterialDelta[];
}): string {
  return [
    "# Supervisor Recovery Chain",
    "",
    ...(options.causal
      ? [
          `- Symptom: \`${options.causal.symptom.authored_id}\` (\`${options.causal.symptom.compiled_id}\`)`,
          `- Selected target: \`${options.causal.selected_target.target_authored_id}\` (\`${options.causal.selected_target.target_compiled_id}\`)`,
          `- Operation: \`${options.causal.selected_target.operation}\``
        ]
      : ["- Causal target: symptom node"]),
    `- Apply action: \`${options.recoveryPlan.apply_action}\``,
    "",
    "## Material Deltas",
    ...(options.materialDelta.length > 0
      ? options.materialDelta.map((delta) => `- \`${delta.kind}\`: ${delta.summary}`)
      : ["- None recorded."])
  ].join("\n");
}

export async function runSupervisorRecoveryCycle(options: {
  action: SupervisorActionKind;
  run_id: string;
  graph_intent: CompiledGraph["intent"];
  node: CompiledExecutableNode;
  attempt: RuntimeNodeAttempt;
  result: RuntimeNodeExecutionResult;
  decision_id: string;
  intervention_id: string;
  classification: FailureClassification;
  failure_fingerprint: string;
  repeated_fingerprint_count: number;
  prior_interventions: SupervisorInterventionRecord[];
  workspace_path: string;
  repo_workspaces?: Record<string, string>;
  harness?: HarnessAdapter;
  supervisor_policy?: EffectiveSupervisorPolicy;
  context_manifest_path?: string;
  causal_context?: SupervisorCausalContext;
  signal?: AbortSignal;
}): Promise<{
  intervention: SupervisorInterventionRecord;
  case_file: SupervisorCaseFile;
  evidence_patches: SupervisorEvidencePatch[];
  recovery_plan: SupervisorRecoveryPlan;
  recovery_envelope?: SupervisorRecoveryEnvelope;
}> {
  const startedAt = nowIso();
  const interventionDir = resolveInterventionDirectory(options.attempt.execution_dir, options.intervention_id);
  const supervisorRuntimeDir = join(
    resolveExecutionRuntimeSupervisorDirectory(options.attempt.execution_dir),
    basename(interventionDir)
  );
  await mkdir(interventionDir, { recursive: true });
  await mkdir(supervisorRuntimeDir, { recursive: true });
  const caseFileJsonPath = join(supervisorRuntimeDir, "case-file.json");
  const caseFileMarkdownPath = join(interventionDir, "case-file.md");
  const requirementEvidenceMapJsonPath = join(supervisorRuntimeDir, "requirement-evidence-map.json");
  const requirementEvidenceMapMarkdownPath = join(interventionDir, "requirement-evidence-map.md");
  const causalCaseFileJsonPath = join(supervisorRuntimeDir, "causal-case-file.json");
  const causalCaseFileMarkdownPath = join(interventionDir, "causal-case-file.md");
  const causalTargetsJsonPath = join(supervisorRuntimeDir, "causal-targets.json");
  const causalTargetsMarkdownPath = join(interventionDir, "causal-targets.md");
  const contextAnalysisJsonPath = join(supervisorRuntimeDir, "context-analysis.json");
  const contextAnalysisMarkdownPath = join(interventionDir, "context-analysis.md");
  const contextRepairPatchPath = join(supervisorRuntimeDir, "context-repair-patch.json");
  const workspaceRepairPatchPath = join(supervisorRuntimeDir, "workspace-repair-patch.json");
  const workspaceRepairResultPath = join(supervisorRuntimeDir, "workspace-repair-result.json");
  const runtimeOverlayPath = join(supervisorRuntimeDir, "runtime-overlay.json");
  const materialDeltaPath = join(supervisorRuntimeDir, "material-delta.json");
  const recoveryPlanJsonPath = join(supervisorRuntimeDir, "recovery-plan.json");
  const recoveryPlanMarkdownPath = join(interventionDir, "recovery-plan.md");
  const recoveryChainJsonPath = join(supervisorRuntimeDir, "recovery-chain.json");
  const recoveryChainMarkdownPath = join(interventionDir, "recovery-chain.md");
  const recoveryEnvelopeJsonPath = join(supervisorRuntimeDir, "recovery-envelope.json");
  const recoveryEnvelopeMarkdownPath = join(interventionDir, "recovery-envelope.md");
  const renderedPrompt = options.attempt.prompt_path
    ? await readFile(options.attempt.prompt_path, "utf8").catch(() => undefined)
    : undefined;
  const causalCase = options.causal_context ? toCausalCaseFile(options.causal_context) : undefined;
  const requirementEvidenceMap = buildRequirementEvidenceMap({
    node: options.node,
    attempt: options.attempt,
    result: options.result,
    generatedAt: startedAt
  });
  const evidenceMapDelta = selectEvidenceMapDelta(requirementEvidenceMap);

  const caseFile: SupervisorCaseFile = {
    case_id: options.intervention_id,
    compiled_id: options.node.compiled_id,
    authored_id: options.node.authored_id,
    prior_execution_id: options.attempt.execution_id,
    attempt_index: options.attempt.attempt_index,
    failed_at: options.attempt.ended_at ?? startedAt,
    failure_class: options.classification.class,
    failure_summary: options.classification.summary,
    failure_fingerprint: options.failure_fingerprint,
    repeated_fingerprint_count: options.repeated_fingerprint_count,
    ...(options.attempt.prompt_path ? { prompt_path: options.attempt.prompt_path } : {}),
    ...(options.attempt.prompt_sha256 ? { prompt_sha256: options.attempt.prompt_sha256 } : {}),
    ...(renderedPrompt ? { rendered_prompt: renderedPrompt } : {}),
    node_contract: {
      intent: options.node.intent,
      declared_artifacts: options.node.declared_artifacts as Record<string, ArtifactDefinition>,
      sandbox: options.node.effective_policy.sandbox ?? "workspace-write",
      repo_alias: options.node.repo
    },
    context: readAttemptContextPaths(options.attempt),
    result: {
      outcome: options.result.outcome,
      status: options.result.status,
      result: asRecord(options.result.result),
      metadata: options.result.metadata ?? {},
      stdout_path: options.attempt.stdout_log_path,
      stderr_path: options.attempt.stderr_log_path
    },
    artifacts: options.attempt.artifacts,
    requirement_evidence_map: requirementEvidenceMap,
    available_evidence: requirementEvidenceMap.available_evidence,
    missing_evidence: requirementEvidenceMap.missing_evidence,
    ...(evidenceMapDelta.delta ? { selected_delta: evidenceMapDelta.delta } : {}),
    ...(evidenceMapDelta.blockedReason ? { retry_blocked_reason: evidenceMapDelta.blockedReason } : {}),
    prior_interventions: options.prior_interventions,
    evidence: options.classification.evidence,
    ...(causalCase ? { causal: causalCase } : {}),
    ...(options.supervisor_policy
      ? {
          supervisor_profile: {
            profile_name: options.supervisor_policy.profile_name,
            ...(options.supervisor_policy.harness ? { harness: options.supervisor_policy.harness } : {}),
            ...(options.supervisor_policy.model ? { model: options.supervisor_policy.model } : {}),
            ...(options.supervisor_policy.reasoning_effort
              ? { reasoning_effort: options.supervisor_policy.reasoning_effort }
              : {}),
            timeout_sec: options.supervisor_policy.timeout_sec
          }
        }
      : {})
  };
  await writeFile(requirementEvidenceMapJsonPath, `${JSON.stringify(requirementEvidenceMap, null, 2)}\n`, "utf8");
  await writeFile(requirementEvidenceMapMarkdownPath, renderRequirementEvidenceMapMarkdown(requirementEvidenceMap), "utf8");
  await writeFile(caseFileJsonPath, `${JSON.stringify(caseFile, null, 2)}\n`, "utf8");
  await writeFile(caseFileMarkdownPath, `${renderCaseFileMarkdown(caseFile)}\n`, "utf8");
  if (causalCase) {
    await writeFile(causalCaseFileJsonPath, `${JSON.stringify(causalCase, null, 2)}\n`, "utf8");
    await writeFile(causalCaseFileMarkdownPath, `${renderCaseFileMarkdown({ ...caseFile, causal: causalCase })}\n`, "utf8");
    await writeFile(causalTargetsJsonPath, `${JSON.stringify(causalCase.target_candidates, null, 2)}\n`, "utf8");
    await writeFile(causalTargetsMarkdownPath, `${renderCausalTargetsMarkdown(causalCase)}\n`, "utf8");
  }

  const repoWorkspaces = options.repo_workspaces ?? {
    [options.node.repo]: options.workspace_path
  };
  const contextAnalysis =
    options.classification.class === "context_contract_failure"
      ? await analyzeNodeContext({
          node: options.node,
          repo_workspaces: repoWorkspaces
        })
      : undefined;
  if (contextAnalysis) {
    const contextAnalysisReport: ContextAnalysisReport = {
      status: contextAnalysis.warnings.length > 0 ? "warnings" : "passed",
      nodes: [contextAnalysis],
      diagnostics: []
    };
    await writeFile(contextAnalysisJsonPath, `${JSON.stringify(contextAnalysis, null, 2)}\n`, "utf8");
    await writeFile(contextAnalysisMarkdownPath, renderContextAnalysisMarkdown(contextAnalysisReport), "utf8");
  }
  const contextRepairPatch = contextAnalysis
    ? buildContextRepairPatch({
        caseFile,
        analysis: contextAnalysis,
        analysisPath: contextAnalysisJsonPath
      })
    : undefined;
  if (contextRepairPatch) {
    await writeFile(contextRepairPatchPath, `${JSON.stringify(contextRepairPatch, null, 2)}\n`, "utf8");
  }

  const contextManifest = options.context_manifest_path
    ? await readFile(options.context_manifest_path, "utf8").catch(() => undefined)
    : undefined;
  const gathers = options.classification.gather_plan.gathers.slice(0, evidenceConcurrencyCap);
  const evidencePatches = await Promise.all(
    gathers.map((gatherRequest) =>
      writeEvidencePatch({
        interventionDir,
        gather: gatherRequest,
        caseFile,
        caseFileJsonPath,
        ...(options.harness ? { harness: options.harness } : {}),
        ...(options.supervisor_policy?.model ?? options.node.effective_policy.model
          ? { model: options.supervisor_policy?.model ?? options.node.effective_policy.model }
          : {}),
        ...(options.supervisor_policy?.reasoning_effort
          ? { reasoning_effort: options.supervisor_policy.reasoning_effort }
          : {}),
        ...(options.supervisor_policy?.harness_config ? { harness_config: options.supervisor_policy.harness_config } : {}),
        ...(options.supervisor_policy?.timeout_sec ? { timeout_sec: options.supervisor_policy.timeout_sec } : {}),
        runId: options.run_id,
        workspacePath: options.workspace_path,
        ...(options.context_manifest_path ? { contextManifestPath: options.context_manifest_path } : {}),
        ...(contextManifest ? { contextManifest } : {}),
        ...(options.signal ? { signal: options.signal } : {})
      })
    )
  );
  const plannedApplyAction = selectApplyAction({
    action: options.action,
    classification: options.classification,
    caseFile,
    requirementEvidenceMap,
    patches: evidencePatches,
    ...(options.causal_context ? { causalContext: options.causal_context } : {})
  });
  const workspaceRepairPatch = plannedApplyAction === "repair_workspace"
    ? readWorkspaceRepairPatch({
        caseFile,
        attempt: options.attempt,
        resultPath: workspaceRepairResultPath
      })
    : undefined;
  if (workspaceRepairPatch) {
    await writeFile(workspaceRepairPatchPath, `${JSON.stringify(workspaceRepairPatch, null, 2)}\n`, "utf8");
  }
  const runtimeOverlay = buildRuntimeOverlay({
    overlayId: `${options.intervention_id}__overlay`,
    applyAction: plannedApplyAction,
    classification: options.classification,
    symptomCompiledId: options.node.compiled_id,
    ...(options.causal_context ? { causalContext: options.causal_context } : {}),
    requirementEvidenceMap,
    ...(evidenceMapDelta.delta ? { selectedDelta: evidenceMapDelta.delta } : {}),
    ...(contextRepairPatch ? { contextRepairPatch } : {}),
    ...(workspaceRepairPatch ? { workspaceRepairPatch } : {}),
    evidencePatches
  });
  if (runtimeOverlay) {
    await writeFile(runtimeOverlayPath, `${JSON.stringify(runtimeOverlay, null, 2)}\n`, "utf8");
    await writeFile(materialDeltaPath, `${JSON.stringify(runtimeOverlay.material_delta, null, 2)}\n`, "utf8");
  }

  const recoveryPlan = buildRecoveryPlan({
    planId: `${options.intervention_id}__plan`,
    action: options.action,
    classification: options.classification,
    caseFile,
    patches: evidencePatches,
    ...(runtimeOverlay ? { runtimeOverlay } : {}),
    ...(options.causal_context ? { causalContext: options.causal_context } : {}),
    requirementEvidenceMapPath: requirementEvidenceMapMarkdownPath
  });
  await writeFile(recoveryPlanJsonPath, `${JSON.stringify(recoveryPlan, null, 2)}\n`, "utf8");
  await writeFile(recoveryPlanMarkdownPath, `${renderRecoveryPlanMarkdown(recoveryPlan)}\n`, "utf8");

  const resumeDecision = buildRecoveryResumeDecision({
    recoveryPlan,
    classification: options.classification,
    ...(workspaceRepairPatch ? { workspaceRepairPatch } : {})
  });
  const recoveryEnvelope =
    retryableApplyAction(recoveryPlan.apply_action) && recoveryPlan.retry_directive
      ? {
          envelope_id: `${options.intervention_id}__envelope`,
          compiled_id: recoveryPlan.recovery_target?.target_compiled_id ?? options.node.compiled_id,
          authored_id: recoveryPlan.recovery_target?.target_authored_id ?? options.node.authored_id,
          prior_execution_id: recoveryPlan.recovery_target?.target_prior_execution_id ?? options.attempt.execution_id,
          symptom_compiled_id: options.node.compiled_id,
          symptom_authored_id: options.node.authored_id,
          symptom_execution_id: options.attempt.execution_id,
          recovery_plan_path: recoveryPlanJsonPath,
          case_file_path: caseFileJsonPath,
          action: "retry_node" as const,
          classification: options.classification.class,
          failure_fingerprint: options.failure_fingerprint,
          repeated_fingerprint_count: options.repeated_fingerprint_count,
          resume_point: resumeDecision.resume_point,
          workspace_decision: resumeDecision.workspace_decision,
          resume_decision: resumeDecision,
          preserve_progress: preserveProgressForRecoveryPlan(recoveryPlan),
          do_not_redo: doNotRedoForRecoveryPlan(recoveryPlan),
          required_next_action: requiredNextActionForRecoveryPlan(recoveryPlan),
          retry_directive: recoveryPlan.retry_directive,
          ...(recoveryPlan.runtime_overlay ? { runtime_overlay: recoveryPlan.runtime_overlay } : {}),
          created_at: nowIso()
        }
      : undefined;

  if (recoveryEnvelope) {
    await writeFile(recoveryEnvelopeJsonPath, `${JSON.stringify(recoveryEnvelope, null, 2)}\n`, "utf8");
    await writeFile(recoveryEnvelopeMarkdownPath, `${renderRecoveryEnvelopeMarkdown(recoveryEnvelope)}\n`, "utf8");
  }

  const recoveryChain = {
    chain_id: `${options.intervention_id}__chain`,
    intervention_id: options.intervention_id,
    decision_id: options.decision_id,
    symptom: {
      compiled_id: options.node.compiled_id,
      authored_id: options.node.authored_id,
      execution_id: options.attempt.execution_id,
      failure_class: options.classification.class,
      summary: options.classification.summary
    },
    ...(causalCase
      ? {
          upstream_cone: causalCase.upstream_cone,
          target_candidates: causalCase.target_candidates,
          selected_target: causalCase.selected_target
        }
      : {}),
    recovery_plan: {
      plan_id: recoveryPlan.plan_id,
      apply_action: recoveryPlan.apply_action,
      confidence: recoveryPlan.confidence
    },
    material_delta: runtimeOverlay?.material_delta ?? [],
    ...(recoveryEnvelope
      ? {
          retry_target: {
            compiled_id: recoveryEnvelope.compiled_id,
            authored_id: recoveryEnvelope.authored_id,
            prior_execution_id: recoveryEnvelope.prior_execution_id
          }
        }
      : {}),
    created_at: nowIso()
  };
  await writeFile(recoveryChainJsonPath, `${JSON.stringify(recoveryChain, null, 2)}\n`, "utf8");
  await writeFile(
    recoveryChainMarkdownPath,
    `${renderRecoveryChainMarkdown({
      ...(causalCase ? { causal: causalCase } : {}),
      recoveryPlan,
      materialDelta: runtimeOverlay?.material_delta ?? []
    })}\n`,
    "utf8"
  );

  const artifactPaths: Record<string, string> = {
    intervention_dir: interventionDir,
    case_file_json: caseFileJsonPath,
    case_file_markdown: caseFileMarkdownPath,
    requirement_evidence_map_json: requirementEvidenceMapJsonPath,
    requirement_evidence_map_markdown: requirementEvidenceMapMarkdownPath,
    ...(causalCase
      ? {
          causal_case_file_json: causalCaseFileJsonPath,
          causal_case_file_markdown: causalCaseFileMarkdownPath,
          causal_targets_json: causalTargetsJsonPath,
          causal_targets_markdown: causalTargetsMarkdownPath
        }
      : {}),
    ...(contextAnalysis
      ? {
          context_analysis_json: contextAnalysisJsonPath,
          context_analysis_markdown: contextAnalysisMarkdownPath
        }
      : {}),
    ...(contextRepairPatch ? { context_repair_patch_json: contextRepairPatchPath } : {}),
    ...(workspaceRepairPatch
      ? {
          workspace_repair_patch_json: workspaceRepairPatchPath,
          workspace_repair_result_json: workspaceRepairResultPath
        }
      : {}),
    ...(runtimeOverlay
      ? {
          runtime_overlay_json: runtimeOverlayPath,
          material_delta_json: materialDeltaPath
        }
      : {}),
    recovery_plan_json: recoveryPlanJsonPath,
    recovery_plan_markdown: recoveryPlanMarkdownPath,
    recovery_chain_json: recoveryChainJsonPath,
    recovery_chain_markdown: recoveryChainMarkdownPath,
    ...Object.fromEntries(
      evidencePatches.flatMap((patch, index) =>
        Object.entries(patch.artifact_paths).map(([key, path]) => [`evidence_${index + 1}_${key}`, path])
      )
    ),
    ...(recoveryEnvelope
      ? {
          recovery_envelope_json: recoveryEnvelopeJsonPath,
          recovery_envelope_markdown: recoveryEnvelopeMarkdownPath
        }
      : {})
  };

  const intervention: SupervisorInterventionRecord = {
    intervention_id: options.intervention_id,
    decision_id: options.decision_id,
    action: options.action,
    status: recoveryPlan.apply_action === "fail_terminal" || recoveryPlan.apply_action === "fail_contract_gap" ? "failed" : "passed",
    target_compiled_id: recoveryPlan.recovery_target?.target_compiled_id ?? options.node.compiled_id,
    target_execution_id: recoveryPlan.recovery_target?.target_prior_execution_id ?? options.attempt.execution_id,
    started_at: startedAt,
    ended_at: nowIso(),
    reason: options.classification.summary,
    evidence: {
      ...options.classification.evidence,
      failure_fingerprint: options.failure_fingerprint,
      repeated_fingerprint_count: options.repeated_fingerprint_count,
      symptom_compiled_id: options.node.compiled_id,
      symptom_execution_id: options.attempt.execution_id,
      gather_plan: options.classification.gather_plan,
      recovery_plan: {
        plan_id: recoveryPlan.plan_id,
        apply_action: recoveryPlan.apply_action,
        confidence: recoveryPlan.confidence
      },
      requirement_evidence_map: {
        map_id: requirementEvidenceMap.map_id,
        missing_count: requirementEvidenceMap.missing_evidence.length,
        path: requirementEvidenceMapJsonPath
      },
      ...(recoveryPlan.recovery_target ? { recovery_target: recoveryPlan.recovery_target } : {})
    },
    artifact_paths: artifactPaths
  };

  return {
    intervention,
    case_file: caseFile,
    evidence_patches: evidencePatches,
    recovery_plan: recoveryPlan,
    ...(recoveryEnvelope ? { recovery_envelope: recoveryEnvelope } : {})
  };
}
