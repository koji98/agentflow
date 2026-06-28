import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
    parseDeliveryCuratorResponse,
    renderDeliveryCuratorPrompt,
    verifyCuratedDelivery,
    type DeliverySourcePacket
} from "../../src/runtime/delivery/curation.js";

function sourcePacket(): DeliverySourcePacket {
    return {
        version: "1",
        run: {
            run_id: "run-1",
            graph_id: "graph-1",
            status: "passed",
            evidence_status: "clean",
            duration: "1s"
        },
        intent: {
            goal: "Ship the reviewed change.",
            acceptance_criteria: ["The handoff is reviewable."],
            constraints: []
        },
        counts: {
            final_attempts: 1,
            active_failures: 0,
            recovered_issues: 0,
            supervisor_interventions: 0,
            changed_files: 0
        },
        final_declared_artifacts: [],
        superseded_declared_artifacts: [],
        changed_files: [],
        node_changed_files: [],
        validation: {
            milestone_validation_logs: [],
            outcome_verifications: []
        },
        failures: {
            active: [],
            recovered: [],
            historical: []
        },
        interventions: [],
        workspace_improvements: [],
        evidence_links: {
            artifact_index: "evidence/artifact-index.json",
            change_map: "evidence/change-map.json",
            validation_ledger: "evidence/validation-ledger.json",
            audit_index: "03-audit-index.md"
        }
    };
}

function validReviewBrief(overrides: {
    changedFiles?: string;
    validationEvidence?: string;
    recoveredIssues?: string;
} = {}): string {
    return [
        "# Review Brief",
        "## Outcome",
        "Run passed.",
        "## Reviewer Decision",
        "Review the evidence.",
        "## What To Inspect First",
        "- [Validation ledger](evidence/validation-ledger.json)",
        "## Success Contract",
        "Ship the reviewed change.",
        "## Changed Files",
        overrides.changedFiles ?? "- None.",
        "## Final Declared Artifacts",
        "- None.",
        "## Validation Evidence",
        overrides.validationEvidence ?? "- `npm test` fail - test suite failed.",
        "## Active Failures And Risks",
        "- No active failures remain.",
        "## Recovered Issues",
        overrides.recoveredIssues ?? "- No recovered issues were recorded.",
        "## Historical Attempts",
        "- No historical attempts require reviewer action.",
        "## Supervisor And Human Interventions",
        "- No supervisor or human interventions were recorded.",
        "## Supporting Evidence",
        "- [Validation ledger](evidence/validation-ledger.json)"
    ].join("\n");
}

function validRunLearnings(): string {
    return [
        "# Run Learnings",
        "## Where Agents Struggled",
        "- None.",
        "## Workspace Improvements",
        "| Area | Recommendation | Evidence | Priority | Confidence | Done When |",
        "| --- | --- | --- | --- | --- | --- |",
        "| none | No action. | source packet | low | medium | No action required. |",
        "## Graph Prompt And Support Improvements",
        "- None.",
        "## Plugin Skill And Eval Opportunities",
        "- None.",
        "## What Worked",
        "- Evidence was available.",
        "## Evidence Links",
        "- [Validation ledger](evidence/validation-ledger.json)"
    ].join("\n");
}

async function deliveryPaths(): Promise<{
    deliveryDir: string;
    reviewPath: string;
    learningsPath: string;
}> {
    const deliveryDir = await mkdtemp(join(tmpdir(), "agentflow-curation-test-"));
    await mkdir(join(deliveryDir, "evidence"), { recursive: true });
    await writeFile(join(deliveryDir, "evidence", "validation-ledger.json"), "{}\n", "utf8");
    return {
        deliveryDir,
        reviewPath: join(deliveryDir, "01-review-brief.md"),
        learningsPath: join(deliveryDir, "02-run-learnings.md")
    };
}

describe("delivery curation prompt", () => {
    it("requires the exact curated delivery heading outline", () => {
        const prompt = renderDeliveryCuratorPrompt({
            source: sourcePacket(),
            source_markdown: "# Delivery Source\n",
            source_json_path: "/tmp/run/delivery/evidence/delivery-source.json",
            source_markdown_path: "/tmp/run/delivery/evidence/delivery-source.md",
            review_brief_path: "/tmp/run/delivery/01-review-brief.md",
            run_learnings_path: "/tmp/run/delivery/02-run-learnings.md",
            delivery_dir: "/tmp/run/delivery"
        });

        expect(prompt).toContain("Required `review-brief` heading outline:");
        expect(prompt).toContain("Required `run-learnings` heading outline:");
        for (const heading of [
            "## Outcome",
            "## Reviewer Decision",
            "## What To Inspect First",
            "## Success Contract",
            "## Changed Files",
            "## Final Declared Artifacts",
            "## Validation Evidence",
            "## Active Failures And Risks",
            "## Recovered Issues",
            "## Historical Attempts",
            "## Supervisor And Human Interventions",
            "## Supporting Evidence",
            "## Where Agents Struggled",
            "## Workspace Improvements",
            "## Graph Prompt And Support Improvements",
            "## Plugin Skill And Eval Opportunities",
            "## What Worked",
            "## Evidence Links"
        ]) {
            expect(prompt).toContain(heading);
        }
        expect(prompt).not.toContain("Delivery source JSON:");
        expect(prompt).not.toContain("/tmp/run/delivery/evidence/delivery-source.json");
        expect(prompt).not.toContain("/tmp/run/delivery/evidence/delivery-source.md");
        expect(prompt).not.toContain("af orient");
        expect(prompt).not.toContain("af complete check");
    });

    it("parses a final fenced block when the model omits the trailing fence at EOF", () => {
        const parsed = parseDeliveryCuratorResponse([
            "```review-brief",
            "# Review Brief",
            "## Outcome",
            "Done.",
            "```",
            "```run-learnings",
            "# Run Learnings",
            "## Where Agents Struggled",
            "None."
        ].join("\n"));

        expect(parsed.review_brief_markdown).toContain("# Review Brief");
        expect(parsed.run_learnings_markdown).toContain("# Run Learnings");
        expect(parsed.run_learnings_markdown).toContain("Where Agents Struggled");
    });

    it("rejects invented validation commands and passing validation claims", async () => {
        const paths = await deliveryPaths();
        const source = sourcePacket();
        source.validation.milestone_validation_logs.push({
            execution_id: "exec-1",
            milestone_id: "m1",
            command: "npm test",
            result: "fail",
            summary: "test suite failed"
        });

        const verdict = await verifyCuratedDelivery({
            source,
            review_brief_markdown: validReviewBrief({
                validationEvidence: [
                    "- `npm test` passed.",
                    "- `npm run build` pass."
                ].join("\n")
            }),
            run_learnings_markdown: validRunLearnings(),
            review_brief_path: paths.reviewPath,
            run_learnings_path: paths.learningsPath,
            delivery_dir: paths.deliveryDir
        });

        expect(verdict.passed).toBe(false);
        expect(verdict.findings).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "invented_validation_pass" }),
            expect.objectContaining({ kind: "invented_validation_command" })
        ]));
    });

    it("allows command references that come from outcome verification summaries", async () => {
        const paths = await deliveryPaths();
        const source = sourcePacket();
        source.validation.outcome_verifications.push({
            node: "worker",
            execution_id: "exec-1",
            passed: true,
            summary: "The artifact captured output from `node scripts/fail-then-pass.mjs`.",
            findings_count: 0,
            blockers_count: 0,
            evidence_path: "evidence/validation-ledger.json"
        });
        const verdict = await verifyCuratedDelivery({
            source,
            review_brief_markdown: validReviewBrief({
                validationEvidence: [
                    "- Node `worker` passed.",
                    "- Summary: the artifact captured output from `node scripts/fail-then-pass.mjs`."
                ].join("\n")
            }),
            run_learnings_markdown: validRunLearnings(),
            review_brief_path: paths.reviewPath,
            run_learnings_path: paths.learningsPath,
            delivery_dir: paths.deliveryDir
        });

        expect(verdict.findings).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "invented_validation_command" })
        ]));
    });

    it("allows command references that are explicitly named in validation summaries", async () => {
        const paths = await deliveryPaths();
        const source = sourcePacket();
        source.validation.milestone_validation_logs.push({
            execution_id: "exec-1",
            milestone_id: "m1",
            command: "npm test",
            result: "pass",
            summary: "Exact npm test completed successfully: test script ran node scripts/validation-gate.js && node tests/recovery.test.js and exited 0."
        });

        const verdict = await verifyCuratedDelivery({
            source,
            review_brief_markdown: validReviewBrief({
                validationEvidence: [
                    "- `npm test` passed.",
                    "- Exact run completed with `node scripts/validation-gate.js && node tests/recovery.test.js` exiting 0."
                ].join("\n")
            }),
            run_learnings_markdown: validRunLearnings(),
            review_brief_path: paths.reviewPath,
            run_learnings_path: paths.learningsPath,
            delivery_dir: paths.deliveryDir
        });

        expect(verdict.findings).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "invented_validation_command" }),
            expect.objectContaining({ kind: "invented_validation_pass" })
        ]));
    });

    it("accepts human-readable command aliases and case-insensitive recovered issue labels", async () => {
        const paths = await deliveryPaths();
        const source = sourcePacket();
        source.validation.milestone_validation_logs.push({
            execution_id: "exec-1",
            milestone_id: "m1",
            command: "node scripts/validation-gate.js",
            result: "pass",
            summary: "Validation gate passed."
        });
        source.failures.recovered.push({
            node: "validation",
            execution_id: "exec-1",
            status: "failed",
            summary: "Check failed."
        });

        const verdict = await verifyCuratedDelivery({
            source,
            review_brief_markdown: validReviewBrief({
                validationEvidence: "- `validation-gate.js` passed.",
                recoveredIssues: "- Validation check failed, then recovered."
            }),
            run_learnings_markdown: validRunLearnings(),
            review_brief_path: paths.reviewPath,
            run_learnings_path: paths.learningsPath,
            delivery_dir: paths.deliveryDir
        });

        expect(verdict.findings).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "missing_validation_command" }),
            expect.objectContaining({ kind: "missing_recovered_issue" })
        ]));
    });

    it("does not treat recovered context in the active-risk section as an active failure", async () => {
        const paths = await deliveryPaths();
        const source = sourcePacket();
        source.failures.recovered.push({
            node: "validation",
            execution_id: "exec-1",
            status: "failed",
            summary: "Check failed."
        });

        const verdict = await verifyCuratedDelivery({
            source,
            review_brief_markdown: [
                "# Review Brief",
                "## Outcome",
                "Run passed.",
                "## Reviewer Decision",
                "Review the evidence.",
                "## What To Inspect First",
                "- [Validation ledger](evidence/validation-ledger.json)",
                "## Success Contract",
                "Ship the reviewed change.",
                "## Changed Files",
                "- None.",
                "## Final Declared Artifacts",
                "- None.",
                "## Validation Evidence",
                "- Evidence recorded.",
                "## Active Failures And Risks",
                "- No active risks beyond the recovered validation issue.",
                "## Recovered Issues",
                "- `validation`: check failed, then recovered.",
                "## Historical Attempts",
                "- None.",
                "## Supervisor And Human Interventions",
                "- None.",
                "## Supporting Evidence",
                "- [Validation ledger](evidence/validation-ledger.json)"
            ].join("\n"),
            run_learnings_markdown: validRunLearnings(),
            review_brief_path: paths.reviewPath,
            run_learnings_path: paths.learningsPath,
            delivery_dir: paths.deliveryDir
        });

        expect(verdict.findings).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "recovered_issue_marked_active" })
        ]));
    });

    it("rejects invented changed-file references", async () => {
        const paths = await deliveryPaths();
        const source = sourcePacket();
        source.changed_files.push({
            repo: "main",
            workspace_path: "/workspace",
            files: ["src/real.ts"]
        });
        const verdict = await verifyCuratedDelivery({
            source,
            review_brief_markdown: validReviewBrief({
                changedFiles: "- `src/real.ts`\n- `src/invented.ts`"
            }),
            run_learnings_markdown: validRunLearnings(),
            review_brief_path: paths.reviewPath,
            run_learnings_path: paths.learningsPath,
            delivery_dir: paths.deliveryDir
        });

        expect(verdict.passed).toBe(false);
        expect(verdict.findings).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "invented_changed_file" })
        ]));
    });

    it("accepts repo-qualified changed-file references from the change map", async () => {
        const paths = await deliveryPaths();
        const source = sourcePacket();
        source.changed_files.push({
            repo: "main",
            workspace_path: "/workspace",
            files: ["fix.txt"]
        });
        const verdict = await verifyCuratedDelivery({
            source,
            review_brief_markdown: validReviewBrief({
                changedFiles: "- `main/fix.txt`"
            }),
            run_learnings_markdown: validRunLearnings(),
            review_brief_path: paths.reviewPath,
            run_learnings_path: paths.learningsPath,
            delivery_dir: paths.deliveryDir
        });

        expect(verdict.findings).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "invented_changed_file" })
        ]));
    });

    it("warns instead of blocking when a failed validation command is summarized without the exact command", async () => {
        const paths = await deliveryPaths();
        const source = sourcePacket();
        source.validation.milestone_validation_logs.push({
            execution_id: "exec-1",
            milestone_id: "m1",
            command: "node scripts/fail-then-pass.mjs",
            result: "fail",
            summary: "Initial required validation failed because fix.txt was missing."
        });

        const verdict = await verifyCuratedDelivery({
            source,
            review_brief_markdown: validReviewBrief({
                validationEvidence: "- Required validation failed initially because `fix.txt` was missing."
            }),
            run_learnings_markdown: validRunLearnings(),
            review_brief_path: paths.reviewPath,
            run_learnings_path: paths.learningsPath,
            delivery_dir: paths.deliveryDir
        });

        expect(verdict.passed).toBe(true);
        expect(verdict.findings).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "missing_validation_command", severity: "warning" })
        ]));
    });

    it("does not attribute a later command pass claim to an earlier failed command in the same validation bullet", async () => {
        const paths = await deliveryPaths();
        const source = sourcePacket();
        source.validation.milestone_validation_logs.push(
            {
                execution_id: "exec-1",
                milestone_id: "m1",
                command: "oracle-probe --help",
                result: "fail",
                summary: "Managed tool hit an EPERM boundary."
            },
            {
                execution_id: "exec-1",
                milestone_id: "m1",
                command: "git status --short --untracked-files=all",
                result: "pass",
                summary: "Workspace was clean."
            }
        );

        const verdict = await verifyCuratedDelivery({
            source,
            review_brief_markdown: validReviewBrief({
                validationEvidence: [
                    "- `oracle-probe --help` failed with an EPERM boundary; `git status --short --untracked-files=all` passed clean."
                ].join("\n")
            }),
            run_learnings_markdown: validRunLearnings(),
            review_brief_path: paths.reviewPath,
            run_learnings_path: paths.learningsPath,
            delivery_dir: paths.deliveryDir
        });

        expect(verdict.findings).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "invented_validation_pass" })
        ]));
    });

    it("rejects claims that targeted validation was a full-suite pass", async () => {
        const paths = await deliveryPaths();
        const source = sourcePacket();
        source.validation.milestone_validation_logs.push({
            execution_id: "exec-1",
            milestone_id: "m1",
            command: "npm test -- tests/unit/checkout.test.ts",
            result: "pass",
            summary: "Targeted checkout test passed."
        });

        const verdict = await verifyCuratedDelivery({
            source,
            review_brief_markdown: validReviewBrief({
                validationEvidence: "- Full test suite passed with `npm test -- tests/unit/checkout.test.ts`."
            }),
            run_learnings_markdown: validRunLearnings(),
            review_brief_path: paths.reviewPath,
            run_learnings_path: paths.learningsPath,
            delivery_dir: paths.deliveryDir
        });

        expect(verdict.passed).toBe(false);
        expect(verdict.findings).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "overstated_validation_scope" })
        ]));
    });
});
