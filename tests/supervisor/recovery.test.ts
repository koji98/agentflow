import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CompiledAgentNode } from "../../src/graph/compiled.js";
import type { RuntimeNodeAttempt } from "../../src/runtime/attempts.js";
import type { RuntimeNodeExecutionResult } from "../../src/runtime/core/engine.js";
import type { HarnessAdapter } from "../../src/runtime/harness/types.js";
import { classifyNodeFailure } from "../../src/supervisor/classifier.js";
import type { SupervisorCausalContext } from "../../src/supervisor/causal.js";
import { runSupervisorRecoveryCycle } from "../../src/supervisor/recovery.js";
function node(): CompiledAgentNode {
    return {
        compiled_id: "root__node",
        authored_id: "node",
        kind: "agent",
        repo: "main",
        deps: [],
        scope_stack: ["scope__root"],
        effective_policy: {
            profile_name: "default",
            harness: "codex-cli",
            sandbox: "workspace-write",
            timeout_sec: 60,
            artifact_repair: { max_attempts: 1 }
        },
        context: [],
        declared_artifacts: {},
        intent: {
            goal: "Use the dependency correctly.",
            acceptance_criteria: ["The code follows the documented dependency API."],
            constraints: ["Do not change graph intent."]
        },
        tools: []
    };
}
function attempt(root: string): RuntimeNodeAttempt {
    return {
        execution_id: "exec__root__node__attempt_1",
        compiled_id: "root__node",
        authored_id: "node",
        kind: "agent",
        repo_alias: "main",
        execution_dir: root,
        attempt_index: 1,
        status: "failed",
        outcome: "failed",
        started_at: "2026-04-24T00:00:00.000Z",
        ended_at: "2026-04-24T00:00:01.000Z",
        duration_ms: 1000,
        prompt_path: join(root, "prompt.md"),
        prompt_sha256: createHash("sha256").update("exact failed prompt\n").digest("hex"),
        context_manifest_path: join(root, "context", "manifest.md"),
        artifacts: {},
        metadata: {}
    };
}
function result(): RuntimeNodeExecutionResult {
    return {
        status: "failed",
        outcome: "failed",
        result: { exit_code: 1 },
        stdout: "",
        stderr: "Build failed because the zod v4 API changed; missing dependency docs for package zod."
    };
}
function dependencyDocsVerifierResult(): RuntimeNodeExecutionResult {
    return {
        status: "passed",
        outcome: "failed",
        result: {
            outcome_verification: {
                passed: false,
                summary: "Verifier rejected the attempt because dependency documentation is missing.",
                findings: [
                    {
                        severity: "blocker",
                        category: "missing_dependency_docs",
                        evidence: "The failed attempt used an unverified dependency API.",
                        recommendation: "Gather version-matched dependency docs before retrying."
                    }
                ],
                blockers: [
                    {
                        severity: "blocker",
                        category: "missing_dependency_docs",
                        evidence: "The failed attempt used an unverified dependency API.",
                        recommendation: "Gather version-matched dependency docs before retrying."
                    }
                ]
            }
        }
    };
}
function wrongDirectionVerifierResult(): RuntimeNodeExecutionResult {
    return {
        status: "passed",
        outcome: "failed",
        result: {
            outcome_verification: {
                passed: false,
                summary: "Verifier rejected the attempt because the implementation went down an over-broad wrong direction.",
                findings: [
                    {
                        severity: "blocker",
                        category: "wrong_direction",
                        evidence: "The prior attempt rewrote unrelated surfaces instead of the assigned contract.",
                        recommendation: "Discard the contaminated attempt and restart inside the original node scope."
                    }
                ],
                blockers: [
                    {
                        severity: "blocker",
                        category: "wrong_direction",
                        evidence: "The prior attempt rewrote unrelated surfaces instead of the assigned contract.",
                        recommendation: "Discard the contaminated attempt and restart inside the original node scope."
                    }
                ]
            }
        }
    };
}
describe("supervisor recovery cycle", () => {
    it("writes a case file, parallel evidence patches, a recovery plan, and retry envelope", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-recovery-cycle-"));
        const runtimeAttempt = attempt(tempRoot);
        const runtimeResult = dependencyDocsVerifierResult();
        await writeFile(runtimeAttempt.prompt_path!, "exact failed prompt\n", "utf8");
        const classification = classifyNodeFailure({
            node: node(),
            attempt: runtimeAttempt,
            result: runtimeResult
        });
        const recovery = await runSupervisorRecoveryCycle({
            action: "rebuild_context",
            run_id: "run-1",
            graph_intent: {
                goal: "Graph goal.",
                acceptance_criteria: ["Graph acceptance stays intact."],
                constraints: []
            },
            node: node(),
            attempt: runtimeAttempt,
            result: runtimeResult,
            decision_id: "decision-1",
            intervention_id: "intervention-1",
            classification,
            failure_fingerprint: "fingerprint-1",
            repeated_fingerprint_count: 1,
            prior_interventions: [],
            workspace_path: tempRoot
        });
        expect(recovery.recovery_plan.apply_action).toBe("retry_with_evidence");
        expect(recovery.evidence_patches.map((patch) => patch.kind)).toEqual(["dependency_metadata", "external_context", "semantic_rejudge"]);
        expect(recovery.recovery_plan.runtime_overlay?.material_delta).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: "requirement_evidence_mapped"
            })
        ]));
        expect(recovery.recovery_plan.intervention_decision).toEqual(expect.objectContaining({
            decision_kind: "intervention",
            selected_strategy: "retry_with_evidence",
            restart_boundary: "node_attempt",
            material_delta: expect.arrayContaining([
                expect.objectContaining({ kind: "requirement_evidence_mapped" })
            ])
        }));
        expect(recovery.recovery_envelope?.resume_decision).toEqual(expect.objectContaining({
            resume_point: "fresh_retry",
            restart_boundary: "node_attempt",
            workspace_decision: "preserve",
            reason_code: "fresh_retry_required"
        }));
        expect(recovery.recovery_envelope?.retry_directive.unchanged_contract).toEqual({
            goal: true,
            acceptance_criteria: true,
            constraints: true,
            repo_authority: true,
            sandbox: true,
            declared_artifacts: true
        });
        await expect(readFile(recovery.intervention.artifact_paths.case_file_json, "utf8")).resolves.toContain("exact failed prompt");
        await expect(readFile(recovery.intervention.artifact_paths.case_file_json, "utf8")).resolves.toContain(runtimeAttempt.prompt_sha256!);
        await expect(readFile(recovery.intervention.artifact_paths.recovery_plan_markdown, "utf8")).resolves.toContain("Apply action: `retry_with_evidence`");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("fails contractually instead of repeating the same fingerprint strategy without material delta", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-recovery-anti-spin-"));
        const runtimeAttempt = attempt(tempRoot);
        const runtimeResult = dependencyDocsVerifierResult();
        await writeFile(runtimeAttempt.prompt_path!, "exact failed prompt\n", "utf8");
        const classification = classifyNodeFailure({
            node: node(),
            attempt: runtimeAttempt,
            result: runtimeResult
        });
        const firstRecovery = await runSupervisorRecoveryCycle({
            action: "rebuild_context",
            run_id: "run-1",
            graph_intent: {
                goal: "Graph goal.",
                acceptance_criteria: ["Graph acceptance stays intact."],
                constraints: []
            },
            node: node(),
            attempt: runtimeAttempt,
            result: runtimeResult,
            decision_id: "decision-1",
            intervention_id: "intervention-1",
            classification,
            failure_fingerprint: "fingerprint-anti-spin",
            repeated_fingerprint_count: 1,
            prior_interventions: [],
            workspace_path: tempRoot
        });
        const secondRecovery = await runSupervisorRecoveryCycle({
            action: "rebuild_context",
            run_id: "run-1",
            graph_intent: {
                goal: "Graph goal.",
                acceptance_criteria: ["Graph acceptance stays intact."],
                constraints: []
            },
            node: node(),
            attempt: runtimeAttempt,
            result: runtimeResult,
            decision_id: "decision-2",
            intervention_id: "intervention-2",
            classification,
            failure_fingerprint: "fingerprint-anti-spin",
            repeated_fingerprint_count: 2,
            prior_interventions: [firstRecovery.intervention],
            workspace_path: tempRoot
        });
        expect(secondRecovery.recovery_plan.apply_action).toBe("fail_contract_gap");
        expect(secondRecovery.recovery_plan.terminal_reason).toContain("Repeated failure fingerprint");
        expect(secondRecovery.recovery_envelope).toBeUndefined();
        expect(secondRecovery.intervention.status).toBe("failed");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("does not pause when helper output uses the old authority boolean", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-recovery-conflict-"));
        const runtimeAttempt = attempt(tempRoot);
        await writeFile(runtimeAttempt.prompt_path!, "exact failed prompt\n", "utf8");
        const classification = classifyNodeFailure({
            node: node(),
            attempt: runtimeAttempt,
            result: result()
        });
        const harness: HarnessAdapter = {
            kind: "codex-cli",
            capabilities: {
                supports_agent: true,
                supports_ai_check: true
            },
            async run() {
                return {
                    status: "passed",
                    exitCode: 0,
                    outputJson: {
                        claims: ["The requested fix requires changing the graph contract."],
                        retry_guidance: ["Do not retry without graph authority."],
                        conflicts: ["Graph contract change required."],
                        confidence: "high"
                    }
                };
            },
            async cancel() { }
        };
        const recovery = await runSupervisorRecoveryCycle({
            action: "rebuild_context",
            run_id: "run-1",
            graph_intent: {
                goal: "Graph goal.",
                acceptance_criteria: ["Graph acceptance stays intact."],
                constraints: []
            },
            node: node(),
            attempt: runtimeAttempt,
            result: result(),
            decision_id: "decision-1",
            intervention_id: "intervention-1",
            classification,
            failure_fingerprint: "fingerprint-1",
            repeated_fingerprint_count: 1,
            prior_interventions: [],
            workspace_path: tempRoot,
            harness
        });
        expect(recovery.recovery_plan.apply_action).toBe("retry_with_evidence");
        expect(recovery.recovery_plan.pause_request).toBeUndefined();
        expect(recovery.recovery_envelope).toBeDefined();
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("fails contractually when helper authority findings require graph changes", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-recovery-contract-gap-"));
        const runtimeAttempt = attempt(tempRoot);
        await writeFile(runtimeAttempt.prompt_path!, "exact failed prompt\n", "utf8");
        const classification = classifyNodeFailure({
            node: node(),
            attempt: runtimeAttempt,
            result: result()
        });
        const harness: HarnessAdapter = {
            kind: "codex-cli",
            capabilities: {
                supports_agent: true,
                supports_ai_check: true
            },
            async run() {
                return {
                    status: "passed",
                    exitCode: 0,
                    outputJson: {
                        claims: ["The requested fix requires changing the graph contract."],
                        retry_guidance: ["Fail the contract gap instead of asking a human from helper prose."],
                        conflicts: ["Graph contract change required."],
                        confidence: "high",
                        authority_findings: [
                            {
                                kind: "graph_contract_change",
                                summary: "The requested fix would require changing the graph contract.",
                                evidence: ["helper evidence"]
                            }
                        ]
                    }
                };
            },
            async cancel() { }
        };
        const recovery = await runSupervisorRecoveryCycle({
            action: "rebuild_context",
            run_id: "run-1",
            graph_intent: {
                goal: "Graph goal.",
                acceptance_criteria: ["Graph acceptance stays intact."],
                constraints: []
            },
            node: node(),
            attempt: runtimeAttempt,
            result: result(),
            decision_id: "decision-1",
            intervention_id: "intervention-1",
            classification,
            failure_fingerprint: "fingerprint-1",
            repeated_fingerprint_count: 1,
            prior_interventions: [],
            workspace_path: tempRoot,
            harness
        });
        expect(recovery.recovery_plan.apply_action).toBe("fail_contract_gap");
        expect(recovery.recovery_plan.pause_request).toBeUndefined();
        expect(recovery.recovery_envelope).toBeUndefined();
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("retries semantic artifact-set conflicts when the current contract can be repaired", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-recovery-artifact-consistency-"));
        const runtimeAttempt = attempt(tempRoot);
        await writeFile(runtimeAttempt.prompt_path!, "exact failed prompt\n", "utf8");
        const semanticResult: RuntimeNodeExecutionResult = {
            status: "passed",
            outcome: "failed",
            result: {
                outcome_verification: {
                    passed: false,
                    summary: "The public artifact set does not provide a single resolved plan.",
                    findings: [
                        {
                            severity: "blocker",
                            category: "incorrect_output",
                            evidence: "summary.md and plan.md contradict each other.",
                            recommendation: "Republish the declared artifacts with one controlling resolution."
                        }
                    ],
                    blockers: [
                        {
                            severity: "blocker",
                            category: "incorrect_output",
                            evidence: "summary.md and plan.md contradict each other.",
                            recommendation: "Republish the declared artifacts with one controlling resolution."
                        }
                    ]
                }
            }
        };
        const classification = classifyNodeFailure({
            node: node(),
            attempt: runtimeAttempt,
            result: semanticResult
        });
        const causalContext: SupervisorCausalContext = {
            symptom: {
                compiled_id: "root__node",
                authored_id: "node",
                kind: "agent",
                execution_id: runtimeAttempt.execution_id,
                failure_class: classification.class,
                summary: classification.summary
            },
            upstream_cone: [],
            target_candidates: [],
            selected_target: {
                operation: "repair_current_node",
                target_compiled_id: "root__node",
                target_authored_id: "node",
                target_kind: "agent",
                confidence: "medium",
                reason: "The current node owns the inconsistent public artifact set.",
                evidence: ["Verifier identified contradictions across declared artifacts."],
                resume_compiled_id: "root__node",
                resume_authored_id: "node",
                target_prior_execution_id: runtimeAttempt.execution_id,
                symptom_compiled_id: "root__node",
                symptom_authored_id: "node",
                symptom_execution_id: runtimeAttempt.execution_id,
                requires_investigation: false
            }
        };
        const harness: HarnessAdapter = {
            kind: "codex-cli",
            capabilities: {
                supports_agent: true,
                supports_ai_check: true
            },
            async run() {
                return {
                    status: "passed",
                    exitCode: 0,
                    outputJson: {
                        claims: ["The declared public artifacts contradict each other."],
                        retry_guidance: ["Republish the existing declared artifacts with one controlling resolution."],
                        conflicts: ["summary.md and plan.md disagree."],
                        confidence: "high",
                        authority_findings: [
                            {
                                kind: "graph_contract_change",
                                summary: "Adding a new artifact would change the graph contract, but rewriting existing artifacts is in-contract.",
                                evidence: ["The declared artifact names remain unchanged."]
                            }
                        ]
                    }
                };
            },
            async cancel() { }
        };
        const recovery = await runSupervisorRecoveryCycle({
            action: "semantic_evaluation",
            run_id: "run-1",
            graph_intent: {
                goal: "Graph goal.",
                acceptance_criteria: ["Graph acceptance stays intact."],
                constraints: []
            },
            node: node(),
            attempt: runtimeAttempt,
            result: semanticResult,
            decision_id: "decision-1",
            intervention_id: "intervention-1",
            classification,
            failure_fingerprint: "fingerprint-1",
            repeated_fingerprint_count: 1,
            prior_interventions: [],
            workspace_path: tempRoot,
            harness,
            causal_context: causalContext
        });
        expect(classification.class).toBe("semantic_misalignment");
        expect(recovery.recovery_plan.apply_action).toBe("retry_with_evidence");
        expect(recovery.recovery_plan.runtime_overlay?.material_delta).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: "public_artifact_consistency_repair"
            })
        ]));
        expect(recovery.recovery_plan.pause_request).toBeUndefined();
        expect(recovery.recovery_envelope).toBeDefined();
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("does not pause from helper credential, operator, or side-effect authority findings", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-recovery-helper-authority-mentions-"));
        const runtimeAttempt = attempt(tempRoot);
        await writeFile(runtimeAttempt.prompt_path!, "exact failed prompt\n", "utf8");
        const classification = classifyNodeFailure({
            node: node(),
            attempt: runtimeAttempt,
            result: result()
        });
        const harness: HarnessAdapter = {
            kind: "codex-cli",
            capabilities: {
                supports_agent: true,
                supports_ai_check: true
            },
            async run() {
                return {
                    status: "passed",
                    exitCode: 0,
                    outputJson: {
                        claims: ["The helper mentioned credentials, operator input, and side effects as possible concerns."],
                        retry_guidance: ["Recover using available local evidence instead of pausing from helper prose."],
                        conflicts: [],
                        confidence: "medium",
                        authority_findings: [
                            {
                                kind: "credential_or_auth_mention",
                                summary: "The failed output mentioned auth text.",
                                evidence: ["helper evidence"]
                            },
                            {
                                kind: "operator_input_mention",
                                summary: "The failed output suggested asking an operator.",
                                evidence: ["helper evidence"]
                            },
                            {
                                kind: "external_side_effect",
                                summary: "The helper mentioned a possible external action.",
                                evidence: ["helper evidence"]
                            }
                        ]
                    }
                };
            },
            async cancel() { }
        };
        const recovery = await runSupervisorRecoveryCycle({
            action: "semantic_evaluation",
            run_id: "run-1",
            graph_intent: {
                goal: "Graph goal.",
                acceptance_criteria: ["Graph acceptance stays intact."],
                constraints: []
            },
            node: node(),
            attempt: runtimeAttempt,
            result: result(),
            decision_id: "decision-1",
            intervention_id: "intervention-1",
            classification,
            failure_fingerprint: "fingerprint-1",
            repeated_fingerprint_count: 1,
            prior_interventions: [],
            workspace_path: tempRoot,
            harness
        });
        expect(recovery.recovery_plan.apply_action).not.toBe("pause_for_authority");
        expect(recovery.recovery_plan.pause_request).toBeUndefined();
        expect(recovery.recovery_envelope).toBeDefined();
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("writes a validation strategy overlay for diagnostic failures", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-recovery-validation-strategy-"));
        const runtimeAttempt = attempt(tempRoot);
        await writeFile(runtimeAttempt.prompt_path!, "exact failed prompt\n", "utf8");
        const classification = classifyNodeFailure({
            node: node(),
            attempt: runtimeAttempt,
            result: {
                status: "failed",
                outcome: "failed",
                result: { timed_out: true },
                stderr: "npm test timed out after 900s"
            }
        });
        const recovery = await runSupervisorRecoveryCycle({
            action: "run_diagnostic",
            run_id: "run-1",
            graph_intent: {
                goal: "Graph goal.",
                acceptance_criteria: ["Graph acceptance stays intact."],
                constraints: []
            },
            node: node(),
            attempt: runtimeAttempt,
            result: {
                status: "failed",
                outcome: "failed",
                result: { timed_out: true },
                stderr: "npm test timed out after 900s"
            },
            decision_id: "decision-1",
            intervention_id: "intervention-1",
            classification,
            failure_fingerprint: "fingerprint-1",
            repeated_fingerprint_count: 1,
            prior_interventions: [],
            workspace_path: tempRoot
        });
        expect(recovery.recovery_plan.apply_action).toBe("repair_validation_strategy");
        expect(recovery.recovery_plan.runtime_overlay?.validation_strategy?.focus.join("\n")).toContain("focused");
        expect(recovery.recovery_plan.runtime_overlay?.material_delta).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: "validation_strategy_changed"
            })
        ]));
        expect(recovery.recovery_envelope?.resume_decision).toEqual(expect.objectContaining({
            resume_point: "repair_validation_strategy",
            restart_boundary: "verification",
            workspace_decision: "preserve",
            reason_code: "validation_strategy_repair"
        }));
        expect(recovery.recovery_envelope?.retry_directive.must_do.join("\n")).toContain("focused validation command");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("uses verification-only resume decisions for verifier substrate failures", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-recovery-verifier-substrate-"));
        const runtimeAttempt = attempt(tempRoot);
        await writeFile(runtimeAttempt.prompt_path!, "exact failed prompt\n", "utf8");
        const runtimeResult: RuntimeNodeExecutionResult = {
            status: "failed",
            outcome: "failed",
            result: { failure_code: "verification_substrate_failure" },
            stdout: "",
            stderr: "verifier transport failed"
        };
        const classification = classifyNodeFailure({
            node: node(),
            attempt: runtimeAttempt,
            result: runtimeResult
        });
        const recovery = await runSupervisorRecoveryCycle({
            action: "run_diagnostic",
            run_id: "run-1",
            graph_intent: {
                goal: "Graph goal.",
                acceptance_criteria: ["Graph acceptance stays intact."],
                constraints: []
            },
            node: node(),
            attempt: runtimeAttempt,
            result: runtimeResult,
            decision_id: "decision-1",
            intervention_id: "intervention-1",
            classification,
            failure_fingerprint: "fingerprint-1",
            repeated_fingerprint_count: 1,
            prior_interventions: [],
            workspace_path: tempRoot
        });
        expect(recovery.recovery_plan.apply_action).toBe("rerun_verification");
        expect(recovery.recovery_envelope?.resume_decision).toEqual(expect.objectContaining({
            resume_point: "rerun_verification",
            restart_boundary: "verification",
            workspace_decision: "preserve",
            reason_code: "verification_substrate_failure"
        }));
        expect(recovery.recovery_envelope?.resume_decision.reuse.join("\n")).toContain("completed worker output");
        expect(recovery.recovery_envelope?.resume_decision.discard.join("\n")).toContain("failed verification");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("resets a wrong-direction attempt instead of preserving contaminated progress", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-recovery-wrong-direction-reset-"));
        const runtimeAttempt = attempt(tempRoot);
        await writeFile(runtimeAttempt.prompt_path!, "exact failed prompt\n", "utf8");
        runtimeAttempt.metadata = {
            node_workspace_changes: {
                baseline_path: join(tempRoot, "workspace-changes/baseline.json"),
                changed_files_path: join(tempRoot, "workspace-changes/changed-files.json"),
                changed_file_count: 4,
                diff_patch_path: join(tempRoot, "workspace-changes/diff.patch"),
                status_path: join(tempRoot, "workspace-changes/status.txt")
            }
        };
        const runtimeResult = wrongDirectionVerifierResult();
        const classification = classifyNodeFailure({
            node: node(),
            attempt: runtimeAttempt,
            result: runtimeResult
        });
        const recovery = await runSupervisorRecoveryCycle({
            action: "semantic_evaluation",
            run_id: "run-1",
            graph_intent: {
                goal: "Graph goal.",
                acceptance_criteria: ["Graph acceptance stays intact."],
                constraints: []
            },
            node: node(),
            attempt: runtimeAttempt,
            result: runtimeResult,
            decision_id: "decision-1",
            intervention_id: "intervention-1",
            classification,
            failure_fingerprint: "fingerprint-1",
            repeated_fingerprint_count: 1,
            prior_interventions: [],
            workspace_path: tempRoot
        });
        expect(classification.evidence.prior_progress_unsafe).toBe(true);
        expect(recovery.recovery_plan.apply_action).toBe("repair_workspace");
        expect(recovery.recovery_plan.runtime_overlay?.workspace_repair).toEqual(expect.objectContaining({
            strategy: "restore_failed_attempt_changes",
            changed_file_count: 4
        }));
        expect(recovery.recovery_envelope?.resume_decision).toEqual(expect.objectContaining({
            resume_point: "fresh_retry",
            restart_boundary: "node_attempt",
            workspace_decision: "reset",
            reason_code: "prior_progress_unsafe"
        }));
        expect(recovery.recovery_envelope?.resume_decision.reuse.join("\n")).toContain("original node contract");
        expect(recovery.recovery_envelope?.resume_decision.discard.join("\n")).toContain("failed attempt workspace changes");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("does not count changing recovery targets as a material delta by itself", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-recovery-target-only-delta-"));
        const runtimeAttempt = attempt(tempRoot);
        await writeFile(runtimeAttempt.prompt_path!, "exact failed prompt\n", "utf8");
        const classification = classifyNodeFailure({
            node: node(),
            attempt: runtimeAttempt,
            result: {
                status: "failed",
                outcome: "failed",
                result: { exit_code: 1 },
                stdout: "",
                stderr: "implementation failed without a recognized failure class"
            }
        });
        const causalContext: SupervisorCausalContext = {
            symptom: {
                compiled_id: "root__node",
                authored_id: "node",
                kind: "agent",
                execution_id: runtimeAttempt.execution_id,
                failure_class: classification.class,
                summary: classification.summary
            },
            upstream_cone: [],
            target_candidates: [],
            selected_target: {
                operation: "repair_upstream_node",
                target_compiled_id: "root__upstream",
                target_authored_id: "upstream",
                target_kind: "agent",
                confidence: "medium",
                reason: "Synthetic upstream target for material-delta regression.",
                evidence: [],
                resume_compiled_id: "root__node",
                resume_authored_id: "node",
                symptom_compiled_id: "root__node",
                symptom_authored_id: "node",
                symptom_execution_id: runtimeAttempt.execution_id,
                requires_investigation: false
            }
        };
        const recovery = await runSupervisorRecoveryCycle({
            action: "retry_with_guidance",
            run_id: "run-1",
            graph_intent: {
                goal: "Graph goal.",
                acceptance_criteria: ["Graph acceptance stays intact."],
                constraints: []
            },
            node: node(),
            attempt: runtimeAttempt,
            result: {
                status: "failed",
                outcome: "failed",
                result: { exit_code: 1 },
                stdout: "",
                stderr: "implementation failed without a recognized failure class"
            },
            decision_id: "decision-1",
            intervention_id: "intervention-1",
            classification,
            failure_fingerprint: "fingerprint-1",
            repeated_fingerprint_count: 1,
            prior_interventions: [],
            workspace_path: tempRoot,
            causal_context: causalContext
        });
        expect(recovery.recovery_plan.runtime_overlay?.material_delta).not.toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: "target_reranked_with_evidence"
            })
        ]));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("stops repeated semantic failures when no material evidence delta exists", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-recovery-no-delta-stop-"));
        const runtimeAttempt = attempt(tempRoot);
        delete runtimeAttempt.prompt_path;
        delete runtimeAttempt.context_manifest_path;
        const failedResult: RuntimeNodeExecutionResult = {
            status: "failed",
            outcome: "failed",
            result: { exit_code: 1 },
            stdout: "",
            stderr: "AI evaluator returned a failing judgment without evidence to prove the required behavior."
        };
        const classification = classifyNodeFailure({
            node: node(),
            attempt: runtimeAttempt,
            result: failedResult,
            repeated_fingerprint_count: 2
        });
        const recovery = await runSupervisorRecoveryCycle({
            action: "run_diagnostic",
            run_id: "run-1",
            graph_intent: {
                goal: "Graph goal.",
                acceptance_criteria: ["Graph acceptance stays intact."],
                constraints: []
            },
            node: node(),
            attempt: runtimeAttempt,
            result: failedResult,
            decision_id: "decision-1",
            intervention_id: "intervention-1",
            classification,
            failure_fingerprint: "fingerprint-1",
            repeated_fingerprint_count: 2,
            prior_interventions: [],
            workspace_path: tempRoot
        });
        expect(recovery.recovery_plan.apply_action).toBe("fail_contract_gap");
        expect(recovery.recovery_plan.terminal_reason).toContain("No available run evidence");
        expect(recovery.recovery_envelope).toBeUndefined();
        expect(recovery.intervention.status).toBe("failed");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("writes a workspace repair overlay when failed-attempt changes can be restored", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-recovery-workspace-repair-"));
        const runtimeAttempt = attempt(tempRoot);
        const workspaceChangesDir = join(tempRoot, "workspace-changes");
        const baselinePath = join(workspaceChangesDir, "baseline.json");
        const changedFilesPath = join(workspaceChangesDir, "changed-files.json");
        await writeFile(runtimeAttempt.prompt_path!, "exact failed prompt\n", "utf8");
        runtimeAttempt.metadata = {
            node_workspace_changes: {
                baseline_path: baselinePath,
                changed_files_path: changedFilesPath,
                changed_file_count: 1,
                diff_patch_path: join(workspaceChangesDir, "diff.patch"),
                status_path: join(workspaceChangesDir, "status.txt")
            }
        };
        const failedResult: RuntimeNodeExecutionResult = {
            status: "failed",
            outcome: "failed",
            result: { exit_code: 1, failure_code: "workspace_pollution" },
            stdout: "",
            stderr: "Workspace pollution detected in generated/noise.md",
            metadata: {
                failure_code: "workspace_pollution"
            }
        };
        const classification = classifyNodeFailure({
            node: node(),
            attempt: runtimeAttempt,
            result: failedResult
        });
        const recovery = await runSupervisorRecoveryCycle({
            action: "run_diagnostic",
            run_id: "run-1",
            graph_intent: {
                goal: "Graph goal.",
                acceptance_criteria: ["Graph acceptance stays intact."],
                constraints: []
            },
            node: node(),
            attempt: runtimeAttempt,
            result: failedResult,
            decision_id: "decision-1",
            intervention_id: "intervention-1",
            classification,
            failure_fingerprint: "fingerprint-1",
            repeated_fingerprint_count: 1,
            prior_interventions: [],
            workspace_path: tempRoot
        });
        expect(recovery.recovery_plan.apply_action).toBe("repair_workspace");
        expect(recovery.recovery_plan.runtime_overlay?.workspace_repair).toEqual(expect.objectContaining({
            strategy: "restore_failed_attempt_changes",
            baseline_path: baselinePath,
            changed_files_path: changedFilesPath
        }));
        expect(recovery.recovery_plan.runtime_overlay?.material_delta).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: "workspace_cleaned"
            })
        ]));
        expect(recovery.recovery_envelope?.retry_directive.must_do.join("\n")).toContain("workspace cleanup");
        await rm(tempRoot, { recursive: true, force: true });
    });
});
