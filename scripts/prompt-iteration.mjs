#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const iterations = Number.parseInt(process.argv.find((arg) => arg.startsWith("--iterations="))?.split("=")[1] ?? "10", 10);
const outDir = resolve(rootDir, process.argv.find((arg) => arg.startsWith("--out="))?.split("=")[1] ?? "prompt-iteration-runs/latest");
const reportPath = resolve(rootDir, process.argv.find((arg) => arg.startsWith("--report="))?.split("=")[1] ?? "docs/technical-implementation/prompt-iteration-report.md");

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function baseInvocation(overrides = {}) {
  return {
    promptKind: "agent",
    runId: "prompt-iteration",
    executionId: "exec-prompt-iteration",
    repoAlias: "main",
    repoPath: "/workspace/repo",
    sandbox: "workspace-write",
    model: "gpt-5.4-mini",
    graphGoal: "Ship a local-first Agentflow graph node with durable evidence.",
    graphAcceptanceCriteria: ["Node output can be reviewed from artifacts.", "Validation evidence is captured."],
    graphConstraints: ["Do not widen scope beyond the node contract."],
    nodeGoal: "Inspect context, complete the requested implementation slice, and publish the declared handoff.",
    nodeAcceptanceCriteria: ["Declared artifacts exist.", "Final handoff cites validation."],
    nodeConstraints: ["Keep changes scoped to the task."],
    contextPacketPath: "/run/context/packet.json",
    contextManifestPath: "/run/context/manifest.md",
    contextManifest: [
      "# Context Manifest",
      "",
      "This is an index of materialized context for the current node.",
      "",
      "## Materials",
      "",
      "- `requirements` -> `/run/context/materialized/requirements/brief.md` (240 tokens): Task brief"
    ].join("\n"),
    outputDir: "/run/nodes/agent/executions/001/artifacts",
    artifacts: {},
    timeoutSec: 300,
    signal: undefined,
    ...overrides
  };
}

const tool = {
  callable_name: "fixture-tool",
  description: "Looks up fixture metadata and emits JSON.",
  executable_path: "/tools/fixture-tool",
  config: { mode: "strict" },
  credentials: ["FIXTURE_TOKEN"],
  source: {
    kind: "plugin",
    alias: "fixture",
    tool: "lookup",
    plugin_root: "/plugins/fixture",
    declared_at: "agent",
    declaration_path: "tools[0]"
  }
};

const recoveryEnvelope = {
  envelope_id: "env-1",
  compiled_id: "root__agent",
  authored_id: "agent",
  prior_execution_id: "exec-0",
  recovery_plan_path: "/run/interventions/recovery-plan.json",
  case_file_path: "/run/interventions/case-file.json",
  action: "retry_node",
  classification: "missing_dependency_docs",
  failure_fingerprint: "abc123",
  repeated_fingerprint_count: 2,
  created_at: "2026-04-29T00:00:00.000Z",
  retry_directive: {
    summary: "The failed attempt used an unsupported API because dependency docs were missing.",
    must_do: [
      "Read the external evidence patch before retrying.",
      "Use the documented stable API in the current artifact."
    ],
    must_not_do: [
      "Do not change the original goal or declared artifacts.",
      "Do not repeat the unsupported API call."
    ],
    evidence_to_read: ["/run/interventions/evidence/external/evidence-patch.md"],
    validation_focus: ["Run the package smoke command after updating the artifact."],
    unchanged_contract: {
      goal: true,
      acceptance_criteria: true,
      constraints: true,
      repo_authority: true,
      sandbox: true,
      declared_artifacts: true
    }
  }
};

function includes(...needles) {
  return (text) => needles.every((needle) => text.includes(needle));
}

function before(left, right) {
  return (text) => text.indexOf(left) >= 0 && text.indexOf(right) >= 0 && text.indexOf(left) < text.indexOf(right);
}

function rule(id, description, test, weight = 1) {
  return { id, description, test, weight };
}

function standardAgentRules(extra = []) {
  return [
    rule("contract-priority", "states source priority and conflict behavior", includes("## Contract Priority", "Apply these sources in this order", "preserve the contract")),
    rule("start-here", "gives first actions before the loop", includes("## Start Here", "Read the context manifest", "Inspect the artifact contract")),
    rule("working-loop", "requires inspect/execute/validate/fix loop", includes("## Working Loop", "Repeat until every acceptance criterion is satisfied")),
    rule("context-evidence", "frames context as evidence, not overriding instructions", includes("Treat context as evidence", "packet/provenance")),
    rule("runtime-cli", "surfaces af status/context/artifact/log", includes("## Agentflow Runtime CLI", "af status", "af artifact write", "af log --type decision")),
    rule("handoff", "requires outcome/artifacts/validation handoff", includes("## Final Handoff", "Artifacts produced", "Validation")),
    ...extra
  ];
}

async function renderScenario(kind, renderHarnessPrompt, renderOutcomeVerificationPrompt) {
  switch (kind) {
    case "agent-no-tools":
      return renderHarnessPrompt(baseInvocation());
    case "agent-declared-artifact":
      return renderHarnessPrompt(baseInvocation({
        artifacts: {
          handoff: {
            from: "output_dir",
            path: "handoff.md",
            description: "Reviewer handoff with validation evidence."
          }
        }
      }));
    case "agent-with-tools":
      return renderHarnessPrompt(baseInvocation({ tools: [tool] }));
    case "agent-read-only":
      return renderHarnessPrompt(baseInvocation({
        sandbox: "read-only",
        artifacts: {
          readout: {
            from: "output_dir",
            path: "readout.md",
            description: "Read-only summary."
          }
        }
      }));
    case "agent-recovery-retry":
      return renderHarnessPrompt(baseInvocation({
        supervisorRecoveryEnvelope: recoveryEnvelope,
        artifacts: {
          fixed_handoff: {
            from: "output_dir",
            path: "fixed-handoff.md",
            description: "Recovered handoff."
          }
        }
      }));
    case "supervisor-evidence-external":
      return renderHarnessPrompt(baseInvocation({
        promptKind: "supervisor_evidence",
        sandbox: "read-only",
        supervisorEvidence: {
          gatherKind: "external_context",
          caseFilePath: "/run/interventions/case-file.json",
          evidencePatchPath: "/run/interventions/evidence/external/evidence-patch.json",
          instructions: ["Gather official docs for missing dependency behavior."]
        }
      }));
    case "supervisor-evidence-local":
      return renderHarnessPrompt(baseInvocation({
        promptKind: "supervisor_evidence",
        sandbox: "read-only",
        supervisorEvidence: {
          gatherKind: "local_context",
          caseFilePath: "/run/interventions/case-file.json",
          evidencePatchPath: "/run/interventions/evidence/local/evidence-patch.json",
          instructions: ["Recover the exact local prompt, context, logs, artifacts, and result evidence."]
        }
      }));
    case "supervisor-evidence-pattern":
      return renderHarnessPrompt(baseInvocation({
        promptKind: "supervisor_evidence",
        sandbox: "read-only",
        supervisorEvidence: {
          gatherKind: "pattern_mining",
          caseFilePath: "/run/interventions/case-file.json",
          evidencePatchPath: "/run/interventions/evidence/pattern/evidence-patch.json",
          instructions: ["Inspect nearby repository patterns related to the failed symptom."]
        }
      }));
    case "supervisor-evidence-dependency":
      return renderHarnessPrompt(baseInvocation({
        promptKind: "supervisor_evidence",
        sandbox: "read-only",
        supervisorEvidence: {
          gatherKind: "dependency_metadata",
          caseFilePath: "/run/interventions/case-file.json",
          evidencePatchPath: "/run/interventions/evidence/dependency/evidence-patch.json",
          instructions: ["Inspect local dependency metadata and versioned API hints."]
        }
      }));
    case "supervisor-evidence-diagnostic":
      return renderHarnessPrompt(baseInvocation({
        promptKind: "supervisor_evidence",
        sandbox: "read-only",
        supervisorEvidence: {
          gatherKind: "diagnostic_probe",
          caseFilePath: "/run/interventions/case-file.json",
          evidencePatchPath: "/run/interventions/evidence/diagnostic/evidence-patch.json",
          instructions: ["Find the smallest non-mutating diagnostic for the failed command."]
        }
      }));
    case "supervisor-evidence-semantic":
      return renderHarnessPrompt(baseInvocation({
        promptKind: "supervisor_evidence",
        sandbox: "read-only",
        supervisorEvidence: {
          gatherKind: "semantic_rejudge",
          caseFilePath: "/run/interventions/case-file.json",
          evidencePatchPath: "/run/interventions/evidence/semantic/evidence-patch.json",
          instructions: ["Rejudge the failed attempt against acceptance criteria and artifacts."]
        }
      }));
    case "supervisor-evidence-investigate":
      return renderHarnessPrompt(baseInvocation({
        promptKind: "supervisor_evidence",
        sandbox: "read-only",
        supervisorEvidence: {
          gatherKind: "investigate_failure",
          caseFilePath: "/run/interventions/case-file.json",
          evidencePatchPath: "/run/interventions/evidence/investigate/evidence-patch.json",
          instructions: ["Identify the failed tactic and the next different tactic."]
        }
      }));
    case "artifact-repair":
      return renderHarnessPrompt(baseInvocation({
        promptKind: "artifact_repair",
        artifacts: {
          handoff: {
            from: "output_dir",
            path: "handoff.md",
            description: "Recovered handoff."
          }
        },
        repair: {
          repairAttempt: 1,
          maxAttempts: 2,
          missingArtifacts: [{
            name: "handoff",
            from: "output_dir",
            path: "handoff.md",
            description: "Recovered handoff.",
            expectedPath: "/run/nodes/agent/executions/001/artifacts/handoff.md"
          }],
          priorResponsePath: "/run/nodes/agent/executions/001/artifacts/agent-response.md",
          stdoutLogPath: "/run/nodes/agent/executions/001/logs/stdout.log",
          stderrLogPath: "/run/nodes/agent/executions/001/logs/stderr.log",
          previousAttemptEvidencePaths: ["/run/nodes/agent/executions/000/artifacts/handoff.md"]
        }
      }));
    case "ai-check":
      return renderHarnessPrompt(baseInvocation({
        promptKind: "ai_check",
        sandbox: "read-only",
        nodeGoal: "Evaluate whether the handoff satisfies the review rubric.",
        rubric: "Pass only if validation evidence is cited."
      }));
    case "outcome-verifier":
      return renderOutcomeVerificationPrompt({
        graph_goal: "Ship the graph node safely.",
        graph_acceptance_criteria: ["A declared handoff artifact exists."],
        graph_constraints: ["Do not claim success without evidence."],
        node_authored_id: "implement",
        node_compiled_id: "root__implement",
        node_goal: "Implement and validate the slice.",
        node_acceptance_criteria: ["Handoff includes validation command output."],
        node_constraints: ["Keep scope narrow."],
        agent_response_snippet: {
          name: "agent_response",
          description: "Final response",
          path: "/run/artifacts/agent-response.md",
          content: "Done. Validation: npm test passed."
        },
        declared_artifact_snippets: [{
          name: "handoff",
          description: "Reviewer handoff",
          path: "/run/artifacts/handoff.md",
          content: "Validation: npm test passed."
        }],
        decision_log_entries: [{
          decision: "Used existing helper",
          rationale: "Repo pattern already existed.",
          evidence: ["src/helper.ts"]
        }],
        workspace_path: "/workspace/repo",
        attempt: {
          execution_id: "exec-1",
          attempt_index: 1
        }
      });
    case "context-manifest-source":
      return readFile(resolve(rootDir, "src/runtime/context/resolve.ts"), "utf8");
    case "helper-prompt-source":
      return readFile(resolve(rootDir, "src/af/index.ts"), "utf8");
    default:
      throw new Error(`Unknown scenario: ${kind}`);
  }
}

const scenarioRules = {
  "agent-no-tools": standardAgentRules(),
  "agent-declared-artifact": standardAgentRules([
    rule("artifact-required", "declared artifacts are mandatory", includes("Every declared artifact must exist", "Missing declared artifacts fail this node")),
    rule("artifact-write", "surfaces af artifact write and exact paths", includes("af artifact write", "/run/nodes/agent/executions/001/artifacts/handoff.md")),
    rule("no-final-substitute", "final response cannot replace artifact", includes("Do not use the final response as a substitute"))
  ]),
  "agent-with-tools": standardAgentRules([
    rule("tool-help", "requires tool help before first use", includes("Run `<tool> --help`", "Do not invent tool names")),
    rule("tool-json", "prefers structured stdout", includes("structured stdout (JSON)")),
    rule("tool-decision-log", "requires logging direction-changing tool results", includes("tool result changes your implementation direction", "af log --type decision"))
  ]),
  "agent-read-only": standardAgentRules([
    rule("read-only-blocker", "read-only prompt prevents writes and asks for blocker", includes("read-only sandbox prevents file writes", "Treat this as a blocker")),
    rule("inspect-only", "read-only workspace says inspect/report only", includes("Inspect and report only", "Do not attempt source edits"))
  ]),
  "agent-recovery-retry": standardAgentRules([
    rule("recovery-before-task", "recovery envelope appears before authored task", before("## Supervisor Recovery Envelope", "## Original Authored Node Task (Still Binding)")),
    rule("unchanged-contract", "states unchanged contract repeatedly", includes("original goal, acceptance criteria, constraints", "Contract Preservation")),
    rule("evidence-first", "requires reading recovery evidence first", includes("Evidence To Read First", "Read the supervisor recovery envelope")),
    rule("current-artifacts", "current retry must write current attempt artifacts", includes("current-attempt declared artifact", "current output directory"))
  ]),
  "supervisor-evidence-external": [
    rule("role", "supervisor evidence gatherer role", includes("Agentflow supervisor evidence gatherer")),
    rule("external-specific", "external context gathers docs hints and sources", includes("external_context", "package names", "official docs")),
    rule("json-schema", "exact JSON output schema", includes('"claims"', '"sources"', '"retry_guidance"', '"scope_or_authority_changed"')),
    rule("no-authority-change", "does not change authority or graph intent", includes("Do not change graph intent", "sandbox authority"))
  ],
  "supervisor-evidence-local": [
    rule("local-kind", "local context gather is explicit", includes("local_context", "exact prompt", "context manifest")),
    rule("case-first", "case file comes first", includes("Read the case file first")),
    rule("json-schema", "exact JSON output schema", includes('"claims"', '"sources"', '"retry_guidance"'))
  ],
  "supervisor-evidence-pattern": [
    rule("pattern-kind", "pattern mining is explicit", includes("pattern_mining", "repository patterns", "without broadening scope")),
    rule("case-first", "case file comes first", includes("Read the case file first")),
    rule("json-schema", "exact JSON output schema", includes('"claims"', '"sources"', '"retry_guidance"'))
  ],
  "supervisor-evidence-dependency": [
    rule("dependency-kind", "dependency metadata gather is explicit", includes("dependency_metadata", "package manifests", "lockfiles")),
    rule("version-docs", "version matched docs are requested", includes("version-matched docs")),
    rule("json-schema", "exact JSON output schema", includes('"claims"', '"sources"', '"retry_guidance"'))
  ],
  "supervisor-evidence-diagnostic": [
    rule("diagnostic-specific", "smallest non-mutating diagnostic", includes("diagnostic_probe", "smallest command", "do not run mutating commands")),
    rule("json-schema", "exact JSON output schema", includes('"claims"', '"conflicts"', '"confidence"')),
    rule("case-first", "case file comes first", includes("Read the case file first"))
  ],
  "supervisor-evidence-semantic": [
    rule("semantic-kind", "semantic rejudge is explicit", includes("semantic_rejudge", "original acceptance criteria", "artifact contract")),
    rule("smallest-correction", "semantic prompt asks for correction", includes("smallest semantic correction")),
    rule("json-schema", "exact JSON output schema", includes('"claims"', '"conflicts"', '"confidence"'))
  ],
  "supervisor-evidence-investigate": [
    rule("investigate-kind", "failure investigation is explicit", includes("investigate_failure", "failed tactic", "first changed tactic")),
    rule("evidence-sources", "investigation uses concrete evidence", includes("logs", "artifacts", "prompt text", "context provenance")),
    rule("json-schema", "exact JSON output schema", includes('"claims"', '"conflicts"', '"confidence"'))
  ],
  "artifact-repair": [
    rule("repair-role", "repair role is scoped", includes("repairing one previously executed Agentflow node", "Do not redo unrelated work")),
    rule("exact-path", "exact expected path is emphasized", includes("exact expected paths", "/run/nodes/agent/executions/001/artifacts/handoff.md")),
    rule("available-evidence", "prior response/logs/attempts are visible", includes("Prior final response artifact", "Previous attempts for this same node")),
    rule("artifact-contract", "artifact contract remains present", includes("Every declared artifact must exist", "af artifact write"))
  ],
  "ai-check": [
    rule("read-only-evaluator", "AI check is read-only evaluator", includes("AI evaluator", "Never modify the workspace")),
    rule("json-only", "AI check requires JSON only", includes("Return JSON only", '"passed":true')),
    rule("context", "AI check gets context contract", includes("Read the manifest first", "Context packet"))
  ],
  "outcome-verifier": [
    rule("external-verifier", "outcome verifier role", includes("external Agentflow outcome verifier")),
    rule("decision-rule", "strong pass/fail decision rule", includes("## Decision Rule", "One blocker finding means passed=false")),
    rule("artifact-blocker", "declared artifact quality can block", includes("required declared artifact", "placeholder-only")),
    rule("path-citations", "requires exact evidence citations", includes("Cite exact artifact paths")),
    rule("fenced-json", "requires fenced JSON output", includes("fenced ```json``` block"))
  ],
  "context-manifest-source": [
    rule("manifest-evidence", "manifest frames context as evidence", includes("Context is evidence")),
    rule("read-order", "manifest contains recommended read order", includes("Recommended Read Order", "Runtime supervisor recovery material")),
    rule("omitted-guidance", "omitted guidance prevents guessing", includes("Do not guess required facts"))
  ],
  "helper-prompt-source": [
    rule("helper-priority", "helper prompt has contract priority", includes("## Contract Priority", "Do not widen the parent node scope")),
    rule("helper-start", "helper prompt has start checklist", includes("## Start Here", "Publish the required artifact")),
    rule("helper-artifact", "helper prompt requires artifact publishing", includes("Required Artifact", "af artifact write")),
    rule("helper-tools", "helper prompt includes tool contract", includes("formatToolContract"))
  ]
};

async function main() {
  if (!Number.isFinite(iterations) || iterations < 10) {
    throw new Error("--iterations must be at least 10.");
  }

  const harnessModule = await import(pathToFileURL(resolve(rootDir, "dist/runtime/harness/types.js")).href);
  const verifierModule = await import(pathToFileURL(resolve(rootDir, "dist/runtime/verification/prompt.js")).href);
  const { renderHarnessPrompt } = harnessModule;
  const { renderOutcomeVerificationPrompt } = verifierModule;
  await mkdir(outDir, { recursive: true });

  const scenarios = Object.keys(scenarioRules);
  const results = [];

  for (const scenario of scenarios) {
    const rules = scenarioRules[scenario];
    const scenarioDir = join(outDir, scenario);
    await mkdir(scenarioDir, { recursive: true });

    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      const output = await renderScenario(scenario, renderHarnessPrompt, renderOutcomeVerificationPrompt);
      const checks = rules.map((entry) => ({
        id: entry.id,
        description: entry.description,
        passed: entry.test(output),
        weight: entry.weight
      }));
      const earned = checks.filter((entry) => entry.passed).reduce((sum, entry) => sum + entry.weight, 0);
      const possible = checks.reduce((sum, entry) => sum + entry.weight, 0);
      const score = possible === 0 ? 1 : earned / possible;
      const outputDigest = digest(output);

      if (iteration === 1) {
        await writeFile(join(scenarioDir, "output.txt"), output, "utf8");
      }

      results.push({
        scenario,
        iteration,
        score,
        output_digest: outputDigest,
        checks
      });
    }
  }

  const grouped = scenarios.map((scenario) => {
    const runs = results.filter((result) => result.scenario === scenario);
    const average = runs.reduce((sum, result) => sum + result.score, 0) / runs.length;
    const failedRules = new Set(runs.flatMap((result) => result.checks.filter((check) => !check.passed).map((check) => check.id)));
    return {
      scenario,
      runs: runs.length,
      average_score: Number(average.toFixed(4)),
      failed_rules: [...failedRules]
    };
  });

  const payload = {
    generated_at: new Date().toISOString(),
    iterations_per_scenario: iterations,
    scenario_count: scenarios.length,
    total_runs: results.length,
    grouped,
    results
  };

  await writeFile(join(outDir, "results.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const report = [
    "# Prompt Iteration Report",
    "",
    `Generated: ${payload.generated_at}`,
    "",
    `Ran ${payload.total_runs} prompt/context scenario iterations: ${iterations} iterations across ${scenarios.length} scenarios.`,
    "",
    "## Method",
    "",
    "- Used production prompt rendering and context/prompt source surfaces after `npm run build`.",
    "- Scored each scenario with explicit pass/fail rules for contract clarity, context priority, artifact behavior, tool discipline, recovery semantics, and verifier strictness.",
    "- Wrote first rendered output for each scenario under the run directory for manual inspection.",
    "",
    "## Results",
    "",
    "| Scenario | Runs | Avg Score | Failed Rules |",
    "| --- | ---: | ---: | --- |",
    ...grouped.map((entry) =>
      `| ${entry.scenario} | ${entry.runs} | ${entry.average_score.toFixed(4)} | ${entry.failed_rules.length > 0 ? entry.failed_rules.join(", ") : "none"} |`
    ),
    "",
    "## Changed Context/Prompt Surfaces",
    "",
    "- Agent node prompt: added contract priority, explicit start checklist, stronger context uncertainty handling, stronger tool discipline, and clearer retry/current-artifact rules.",
    "- Supervisor evidence prompt: added gather-kind-specific instructions and an exact JSON schema with source/conflict requirements.",
    "- Context manifest: added context-as-evidence framing, recommended read order, and omitted/truncated uncertainty guidance.",
    "- Outcome verifier prompt: added stricter declared-artifact blocker rules, full-artifact-read guidance for truncated snippets, and exact evidence citation requirements.",
    "- Helper prompt: added contract priority, start checklist, and clearer helper artifact/log guidance.",
    "",
    `Raw results: \`${join(outDir, "results.json")}\``
  ].join("\n");

  await writeFile(reportPath, `${report}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    passed: grouped.every((entry) => entry.failed_rules.length === 0),
    iterations_per_scenario: iterations,
    scenario_count: scenarios.length,
    total_runs: results.length,
    report_path: reportPath,
    results_path: join(outDir, "results.json"),
    grouped
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
