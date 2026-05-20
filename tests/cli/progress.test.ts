import { describe, expect, it } from "vitest";
import { createRuntimeProgressReporter } from "../../src/cli/progress.js";
import type { CompiledGraph } from "../../src/graph/compiled.js";
import type { RuntimeEventEnvelope } from "../../src/runtime/events.js";
function createCompiledGraph(): CompiledGraph {
    return {
        graph_id: "progress-graph",
        launch: {
            launch_profile: "default",
            workspace_backend: "inplace"
        },
        entry_node_ids: ["root__inspect"],
        nodes: [
            {
                compiled_id: "root__inspect",
                authored_id: "inspect",
                kind: "agent",
                label: "Inspect Repo",
                repo: "main",
                deps: [],
                scope_stack: ["root"],
                effective_policy: {
                    profile_name: "default",
                    harness: "codex-cli",
                    model: "gpt-5.4",
                    reasoning_effort: "high",
                    sandbox: "read-only",
                    timeout_sec: 60
                },
                context: [],
                declared_artifacts: {},
                intent: {
                    goal: "Inspect the repo.",
                    acceptance_criteria: ["The node satisfies its acceptance criteria."],
                    constraints: []
                },
            },
            {
                compiled_id: "root__verify",
                authored_id: "verify",
                kind: "check",
                label: "Quality Check",
                repo: "main",
                deps: ["root__inspect"],
                scope_stack: ["root", "retry"],
                repeat_scope_id: "scope__retry",
                effective_policy: {
                    profile_name: "default",
                    harness: "codex-cli",
                    model: "gpt-5.4",
                    reasoning_effort: "high",
                    sandbox: "read-only",
                    timeout_sec: 60
                },
                context: [],
                declared_artifacts: {},
                check_kind: "ai",
                intent: {
                    goal: "Check quality.",
                    acceptance_criteria: ["The node satisfies its acceptance criteria."],
                    constraints: []
                },
            }
        ],
        edges: [],
        scopes: [
            {
                scope_id: "root",
                authored_id: "root",
                kind: "sequence",
                parent_scope_id: null,
                scope_stack: [],
                entry_node_ids: ["root__inspect"],
                exit_node_ids: ["root__verify"],
                compiled_node_ids: ["root__inspect", "root__verify"]
            },
            {
                scope_id: "scope__retry",
                authored_id: "retry",
                kind: "repeat",
                parent_scope_id: "root",
                scope_stack: ["root"],
                entry_node_ids: ["root__verify"],
                exit_node_ids: ["root__verify"],
                compiled_node_ids: ["root__verify"],
                max_attempts: 3,
                until_compiled_id: "root__verify",
                body_entry_node_ids: ["root__verify"],
                body_exit_node_ids: ["root__verify"]
            }
        ],
        authored_to_compiled: {
            inspect: ["root__inspect"],
            verify: ["root__verify"]
        }
    };
}
describe("runtime progress reporter", () => {
    it("renders human-readable run progress lines to a writable stream", () => {
        const lines: string[] = [];
        const reporter = createRuntimeProgressReporter(createCompiledGraph(), {
            write(chunk: string) {
                lines.push(chunk);
                return true;
            }
        });
        const emit = (event: RuntimeEventEnvelope) => reporter.onEvent(event);
        emit({
            seq: 1,
            ts: new Date().toISOString(),
            run_id: "run-1",
            type: "graph.compiled",
            payload: {
                graph_id: "progress-graph",
                compiled_node_count: 2,
                scope_count: 2
            }
        });
        emit({
            seq: 2,
            ts: new Date().toISOString(),
            run_id: "run-1",
            type: "run.started",
            payload: {
                workspace_backend: "inplace"
            }
        });
        emit({
            seq: 3,
            ts: new Date().toISOString(),
            run_id: "run-1",
            type: "node.started",
            compiled_id: "root__inspect",
            payload: {
                kind: "agent",
                repo_alias: "main",
                profile_name: "default"
            }
        });
        emit({
            seq: 4,
            ts: new Date().toISOString(),
            run_id: "run-1",
            type: "node.completed",
            compiled_id: "root__inspect",
            payload: {
                outcome: "passed",
                duration_ms: 1234
            }
        });
        emit({
            seq: 5,
            ts: new Date().toISOString(),
            run_id: "run-1",
            type: "repeat.iteration.started",
            repeat_scope_id: "scope__retry",
            iteration_index: 2,
            payload: {
                max_attempts: 3
            }
        });
        emit({
            seq: 6,
            ts: new Date().toISOString(),
            run_id: "run-1",
            type: "check.evaluated",
            compiled_id: "root__verify",
            payload: {
                check_kind: "ai",
                passed: false,
                score: 0.62,
                summary: "Spec is not implementation-ready."
            }
        });
        emit({
            seq: 7,
            ts: new Date().toISOString(),
            run_id: "run-1",
            type: "supervisor.intervention.retry",
            compiled_id: "root__verify",
            payload: {
                action: "retry_with_guidance",
                attempt: 1,
                max_attempts: 3,
                delay_ms: 2500,
                summary: "Supervisor harness was temporarily unavailable."
            }
        });
        emit({
            seq: 8,
            ts: new Date().toISOString(),
            run_id: "run-1",
            type: "verification.started",
            compiled_id: "root__verify",
            payload: {
                verifier_kind: "check"
            }
        });
        emit({
            seq: 9,
            ts: new Date().toISOString(),
            run_id: "run-1",
            type: "verification.completed",
            compiled_id: "root__verify",
            payload: {
                verifier_kind: "check",
                passed: false,
                summary: "Spec is not implementation-ready."
            }
        });
        emit({
            seq: 10,
            ts: new Date().toISOString(),
            run_id: "run-1",
            type: "node.blocked",
            compiled_id: "root__verify",
            payload: {
                reason: "terminal_failure"
            }
        });
        emit({
            seq: 11,
            ts: new Date().toISOString(),
            run_id: "run-1",
            type: "run.completed",
            payload: {
                outcome: "failed",
                duration_ms: 6543,
                reason: "quality_check_failed"
            }
        });
        const rendered = lines.join("");
        expect(rendered).toContain('agentflow: compiled graph "progress-graph" with 2 executable nodes');
        expect(rendered).toContain("agentflow: RUN      run · workspace=inplace");
        expect(rendered).toContain("[0/2] RUN      agent Inspect Repo · repo=main");
        expect(rendered).toContain("[1/2] PASS     agent Inspect Repo · 1s");
        expect(rendered).toContain("  REPEAT   retry · iteration=2/3");
        expect(rendered).toContain("  FAIL     check Quality Check · score=0.62");
        expect(rendered).toContain("  RETRY    intervention Quality Check · retry_with_guidance · attempt=1/3 · delay=3s · Supervisor harness was temporarily unavailable.");
        expect(rendered).toContain("  VERIFY   start Quality Check · check");
        expect(rendered).toContain("  FAIL     verification Quality Check · Spec is not implementation-ready.");
        expect(rendered).toContain("[2/2] BLOCK    check Quality Check · terminal_failure");
        expect(rendered).toContain("agentflow: FAIL     run · 2/2 terminal nodes");
    });
    it("counts preserved nodes when reporting resumed runs", () => {
        const lines: string[] = [];
        const reporter = createRuntimeProgressReporter(createCompiledGraph(), {
            write(chunk: string) {
                lines.push(chunk);
                return true;
            }
        });
        reporter.onEvent({
            seq: 1,
            ts: new Date().toISOString(),
            run_id: "run-2",
            type: "run.started",
            payload: {
                resumed: true,
                previous_status: "failed",
                preserved_node_count: 1,
                restarted_node_count: 1,
                workspace_backend: "inplace"
            }
        });
        reporter.onEvent({
            seq: 2,
            ts: new Date().toISOString(),
            run_id: "run-2",
            type: "node.started",
            compiled_id: "root__verify",
            payload: {
                kind: "check",
                repo_alias: "main",
                profile_name: "default"
            }
        });
        reporter.onEvent({
            seq: 3,
            ts: new Date().toISOString(),
            run_id: "run-2",
            type: "node.completed",
            compiled_id: "root__verify",
            payload: {
                outcome: "passed",
                duration_ms: 500
            }
        });
        reporter.onEvent({
            seq: 4,
            ts: new Date().toISOString(),
            run_id: "run-2",
            type: "run.completed",
            payload: {
                outcome: "passed",
                duration_ms: 1000
            }
        });
        const rendered = lines.join("");
        expect(rendered).toContain("agentflow: RUN      resume · from=failed · preserved=1 restarted=1 · workspace=inplace");
        expect(rendered).toContain("[1/2] RUN      check Quality Check · repo=main");
        expect(rendered).toContain("[2/2] PASS     check Quality Check · 500ms");
        expect(rendered).toContain("agentflow: PASS     run · 2/2 terminal nodes · 1s");
    });
    it("counts skipped nodes as terminal progress", () => {
        const lines: string[] = [];
        const reporter = createRuntimeProgressReporter(createCompiledGraph(), {
            write(chunk: string) {
                lines.push(chunk);
                return true;
            }
        });
        reporter.onEvent({
            seq: 1,
            ts: new Date().toISOString(),
            run_id: "run-3",
            type: "run.started",
            payload: {
                workspace_backend: "inplace"
            }
        });
        reporter.onEvent({
            seq: 2,
            ts: new Date().toISOString(),
            run_id: "run-3",
            type: "node.skipped",
            compiled_id: "root__verify",
            payload: {
                reason: "operator_cancel"
            }
        });
        reporter.onEvent({
            seq: 3,
            ts: new Date().toISOString(),
            run_id: "run-3",
            type: "run.canceled",
            payload: {
                reason: "operator_cancel"
            }
        });
        const rendered = lines.join("");
        expect(rendered).toContain("agentflow: RUN      run · workspace=inplace");
        expect(rendered).toContain("[1/2] SKIP     check Quality Check · operator_cancel");
        expect(rendered).toContain("agentflow: CANCEL   run · operator_cancel");
    });
    it("adds ANSI color only for TTY-like streams", () => {
        const lines: string[] = [];
        const previousNoColor = process.env.NO_COLOR;
        const previousTerm = process.env.TERM;
        delete process.env.NO_COLOR;
        process.env.TERM = "xterm-256color";
        try {
            const reporter = createRuntimeProgressReporter(createCompiledGraph(), {
                isTTY: true,
                write(chunk: string) {
                    lines.push(chunk);
                    return true;
                }
            });
            reporter.onEvent({
                seq: 1,
                ts: new Date().toISOString(),
                run_id: "run-4",
                type: "node.started",
                compiled_id: "root__inspect",
                payload: {
                    kind: "agent",
                    repo_alias: "main"
                }
            });
            reporter.onEvent({
                seq: 2,
                ts: new Date().toISOString(),
                run_id: "run-4",
                type: "node.completed",
                compiled_id: "root__inspect",
                payload: {
                    outcome: "passed",
                    duration_ms: 100
                }
            });
            const rendered = lines.join("");
            expect(rendered).toContain("\u001b[36mRUN     \u001b[0m");
            expect(rendered).toContain("\u001b[32mPASS    \u001b[0m");
            expect(rendered).toContain("\u001b[2m · repo=main\u001b[0m");
        }
        finally {
            if (previousNoColor === undefined) {
                delete process.env.NO_COLOR;
            }
            else {
                process.env.NO_COLOR = previousNoColor;
            }
            if (previousTerm === undefined) {
                delete process.env.TERM;
            }
            else {
                process.env.TERM = previousTerm;
            }
        }
    });
    it("keeps TTY-like streams plain when color is disabled", () => {
        const lines: string[] = [];
        const previousNoColor = process.env.NO_COLOR;
        process.env.NO_COLOR = "1";
        try {
            const reporter = createRuntimeProgressReporter(createCompiledGraph(), {
                isTTY: true,
                write(chunk: string) {
                    lines.push(chunk);
                    return true;
                }
            });
            reporter.onEvent({
                seq: 1,
                ts: new Date().toISOString(),
                run_id: "run-5",
                type: "node.started",
                compiled_id: "root__inspect",
                payload: {
                    kind: "agent",
                    repo_alias: "main"
                }
            });
            const rendered = lines.join("");
            expect(rendered).toContain("[0/2] RUN      agent Inspect Repo · repo=main");
            expect(rendered).not.toContain("\u001b[");
        }
        finally {
            if (previousNoColor === undefined) {
                delete process.env.NO_COLOR;
            }
            else {
                process.env.NO_COLOR = previousNoColor;
            }
        }
    });
});
