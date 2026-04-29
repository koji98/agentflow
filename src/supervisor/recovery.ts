import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { ArtifactDefinition, SupervisionPolicy } from "../graph/authored.js";
import type { CompiledExecutableNode, CompiledGraph } from "../graph/compiled.js";
import type { SupervisorActionKind } from "../graph/schema.js";
import type { RuntimeNodeAttempt } from "../runtime/attempts.js";
import type { RuntimeNodeExecutionResult } from "../runtime/core/engine.js";
import type { HarnessAdapter } from "../runtime/harness/types.js";
import { renderHarnessPrompt } from "../runtime/harness/types.js";
import type { FailureClassification } from "./classifier.js";
import type {
  SupervisorCaseFile,
  SupervisorEvidenceGatherKind,
  SupervisorEvidenceGatherRequest,
  SupervisorEvidencePatch,
  SupervisorInterventionRecord,
  SupervisorRecoveryEnvelope,
  SupervisorRecoveryPlan
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
    "```"
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
        "Recovered the failed attempt prompt, context manifest/provenance, declared artifacts, logs, and result metadata from the local run tree.",
        "The retry should read the case file before making scope-affecting decisions."
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
        "Cite the external source in the final handoff or decision log.",
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
        "Run or inspect the smallest diagnostic that explains the failed symptom.",
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
        "Read the supervisor case file and evidence patches before retrying.",
        "Preserve the original node goal, acceptance criteria, constraints, sandbox, repo authority, and declared artifacts.",
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

  return {
    ...fallback,
    claims,
    retry_guidance: retryGuidance,
    conflicts,
    confidence,
    scope_or_authority_changed:
      typeof value.scope_or_authority_changed === "boolean"
        ? value.scope_or_authority_changed
        : fallback.scope_or_authority_changed,
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
    scope_or_authority_changed: false,
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
        contextPacketPath: options.caseFileJsonPath,
        contextManifestPath: options.contextManifestPath ?? options.caseFileJsonPath,
        contextManifest: options.contextManifest ?? `Case file: ${options.caseFileJsonPath}`,
        outputDir: gatherDir,
        artifacts: {},
        timeoutSec: 300,
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
  patches: SupervisorEvidencePatch[];
}): SupervisorRecoveryPlan["apply_action"] {
  if (options.classification.class === "non_recoverable" || options.classification.recommended_action === "fail") {
    return "fail_terminal";
  }

  if (!options.classification.retryable && options.classification.recommended_action === "pause_for_human") {
    return "pause_for_human";
  }

  if (options.patches.some((patch) => patch.scope_or_authority_changed)) {
    return "pause_for_human";
  }

  if (options.action === "repair_artifact" || options.classification.recommended_action === "repair_artifact") {
    return "repair_artifact";
  }

  return "retry_node";
}

function buildRetryDirective(options: {
  classification: FailureClassification;
  caseFile: SupervisorCaseFile;
  patches: SupervisorEvidencePatch[];
}): SupervisorRecoveryEnvelope["retry_directive"] {
  const retryGuidance = options.patches.flatMap((patch) => patch.retry_guidance);
  const evidenceToRead = [
    options.caseFile.prompt_path ?? "",
    ...options.patches.flatMap((patch) => Object.values(patch.artifact_paths).filter((path) => basename(path) === "evidence-patch.md"))
  ].filter(Boolean);
  const dedupedGuidance = [...new Set(retryGuidance)].slice(0, 12);

  return {
    summary: options.classification.summary,
    must_do: dedupedGuidance.length > 0
      ? dedupedGuidance
      : ["Read the supervisor case file, evidence patches, and failed attempt artifacts before retrying."],
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
}): SupervisorRecoveryPlan {
  const applyAction = selectApplyAction({
    action: options.action,
    classification: options.classification,
    patches: options.patches
  });
  const conflicts = options.patches.flatMap((patch) => patch.conflicts);
  const mergedClaims = [...new Set(options.patches.flatMap((patch) => patch.claims))];
  const retryDirective =
    applyAction === "retry_node"
      ? buildRetryDirective({
          classification: options.classification,
          caseFile: options.caseFile,
          patches: options.patches
        })
      : undefined;

  return {
    plan_id: options.planId,
    case_id: options.caseFile.case_id,
    classification: options.classification.class,
    apply_action: applyAction,
    ...(retryDirective ? { retry_directive: retryDirective } : {}),
    ...(applyAction === "repair_artifact"
      ? {
          repair_directive: {
            summary: options.classification.summary,
            evidence_to_read: options.patches.flatMap((patch) => Object.values(patch.artifact_paths))
          }
        }
      : {}),
    ...(applyAction === "pause_for_human"
      ? {
          pause_request: {
            reason: options.classification.summary,
            unblock_request: "Provide authority, credentials, scope clarification, or graph-contract changes that the supervisor cannot infer safely."
          }
        }
      : {}),
    ...(applyAction === "fail_terminal" ? { terminal_reason: options.classification.summary } : {}),
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
    "# Supervisor Recovery Envelope",
    "",
    "The original goal, acceptance criteria, constraints, repo authority, sandbox, and declared artifacts are unchanged.",
    "",
    `- Prior execution: \`${envelope.prior_execution_id}\``,
    `- Classification: \`${envelope.classification}\``,
    `- Case file: \`${envelope.case_file_path}\``,
    `- Recovery plan: \`${envelope.recovery_plan_path}\``,
    "",
    "## Summary",
    directive.summary,
    "",
    "## Must Do",
    ...directive.must_do.map((item) => `- ${item}`),
    "",
    "## Must Not Do",
    ...directive.must_not_do.map((item) => `- ${item}`)
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
  policy: SupervisionPolicy;
  workspace_path: string;
  harness?: HarnessAdapter;
  context_manifest_path?: string;
  signal?: AbortSignal;
}): Promise<{
  intervention: SupervisorInterventionRecord;
  case_file: SupervisorCaseFile;
  evidence_patches: SupervisorEvidencePatch[];
  recovery_plan: SupervisorRecoveryPlan;
  recovery_envelope?: SupervisorRecoveryEnvelope;
}> {
  const startedAt = nowIso();
  const interventionDir = join(options.attempt.execution_dir, "interventions", options.intervention_id);
  await mkdir(interventionDir, { recursive: true });
  const caseFileJsonPath = join(interventionDir, "case-file.json");
  const caseFileMarkdownPath = join(interventionDir, "case-file.md");
  const recoveryPlanJsonPath = join(interventionDir, "recovery-plan.json");
  const recoveryPlanMarkdownPath = join(interventionDir, "recovery-plan.md");
  const recoveryEnvelopeJsonPath = join(interventionDir, "recovery-envelope.json");
  const recoveryEnvelopeMarkdownPath = join(interventionDir, "recovery-envelope.md");
  const renderedPrompt = options.attempt.prompt_path
    ? await readFile(options.attempt.prompt_path, "utf8").catch(() => undefined)
    : undefined;

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
      ...(options.node.goal ? { goal: options.node.goal } : {}),
      ...(options.node.acceptance_criteria ? { acceptance_criteria: options.node.acceptance_criteria } : {}),
      ...(options.node.constraints ? { constraints: options.node.constraints } : {}),
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
    prior_interventions: options.prior_interventions,
    evidence: options.classification.evidence
  };
  await writeFile(caseFileJsonPath, `${JSON.stringify(caseFile, null, 2)}\n`, "utf8");
  await writeFile(caseFileMarkdownPath, `${renderCaseFileMarkdown(caseFile)}\n`, "utf8");

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
        ...(options.node.effective_policy.model ? { model: options.node.effective_policy.model } : {}),
        runId: options.run_id,
        workspacePath: options.workspace_path,
        ...(options.context_manifest_path ? { contextManifestPath: options.context_manifest_path } : {}),
        ...(contextManifest ? { contextManifest } : {}),
        ...(options.signal ? { signal: options.signal } : {})
      })
    )
  );

  const recoveryPlan = buildRecoveryPlan({
    planId: `${options.intervention_id}__plan`,
    action: options.action,
    classification: options.classification,
    caseFile,
    patches: evidencePatches
  });
  await writeFile(recoveryPlanJsonPath, `${JSON.stringify(recoveryPlan, null, 2)}\n`, "utf8");
  await writeFile(recoveryPlanMarkdownPath, `${renderRecoveryPlanMarkdown(recoveryPlan)}\n`, "utf8");

  const recoveryEnvelope =
    recoveryPlan.apply_action === "retry_node" && recoveryPlan.retry_directive
      ? {
          envelope_id: `${options.intervention_id}__envelope`,
          compiled_id: options.node.compiled_id,
          authored_id: options.node.authored_id,
          prior_execution_id: options.attempt.execution_id,
          recovery_plan_path: recoveryPlanJsonPath,
          case_file_path: caseFileJsonPath,
          action: "retry_node" as const,
          classification: options.classification.class,
          failure_fingerprint: options.failure_fingerprint,
          repeated_fingerprint_count: options.repeated_fingerprint_count,
          retry_directive: recoveryPlan.retry_directive,
          created_at: nowIso()
        }
      : undefined;

  if (recoveryEnvelope) {
    await writeFile(recoveryEnvelopeJsonPath, `${JSON.stringify(recoveryEnvelope, null, 2)}\n`, "utf8");
    await writeFile(recoveryEnvelopeMarkdownPath, `${renderRecoveryEnvelopeMarkdown(recoveryEnvelope)}\n`, "utf8");
  }

  const artifactPaths: Record<string, string> = {
    intervention_dir: interventionDir,
    case_file_json: caseFileJsonPath,
    case_file_markdown: caseFileMarkdownPath,
    recovery_plan_json: recoveryPlanJsonPath,
    recovery_plan_markdown: recoveryPlanMarkdownPath,
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
    status: recoveryPlan.apply_action === "fail_terminal" ? "failed" : "passed",
    target_compiled_id: options.node.compiled_id,
    target_execution_id: options.attempt.execution_id,
    started_at: startedAt,
    ended_at: nowIso(),
    reason: options.classification.summary,
    evidence: {
      ...options.classification.evidence,
      failure_fingerprint: options.failure_fingerprint,
      repeated_fingerprint_count: options.repeated_fingerprint_count,
      gather_plan: options.classification.gather_plan,
      recovery_plan: {
        plan_id: recoveryPlan.plan_id,
        apply_action: recoveryPlan.apply_action,
        confidence: recoveryPlan.confidence
      }
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
