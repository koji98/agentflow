import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildPromptDiffEntries,
  renderPromptDiffReport
} from "../../src/evals/runner.js";
import type { EvalTrialResult, EvalVariant } from "../../src/evals/types.js";

function trialResult(options: {
  scenario: string;
  variant: string;
  trial: string;
  runRoot: string;
}): EvalTrialResult {
  return {
    scenario_id: options.scenario,
    variant_id: options.variant,
    trial_id: options.trial,
    trial_index: 1,
    status: "passed",
    passed: true,
    rendered_graph_file: "/tmp/rendered.json",
    trial_file: "/tmp/trial.json",
    scorecard_file: "/tmp/scorecard.json",
    summary_file: "/tmp/summary.md",
    run_root: options.runRoot
  };
}

describe("eval prompt diagnostics aggregation", () => {
  it("carries prompt diagnostics into prompt diff entries and markdown reports", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-eval-prompt-diagnostics-"));
    const baselineRoot = join(tempRoot, "baseline-run");
    const candidateRoot = join(tempRoot, "candidate-run");
    const promptRelativePath = join("nodes", "node-1", "executions", "001", "agent", "prompt.md");

    try {
      for (const root of [baselineRoot, candidateRoot]) {
        await mkdir(join(root, "nodes", "node-1", "executions", "001", "agent"), { recursive: true });
        await mkdir(join(root, "nodes", "node-1", "executions", "001", "human-debug"), { recursive: true });
      }

      await writeFile(join(baselineRoot, promptRelativePath), "## Role\nDo work.\n", "utf8");
      await writeFile(join(candidateRoot, promptRelativePath), "## Role\nDo better work.\n", "utf8");
      await writeFile(
        join(candidateRoot, "nodes", "node-1", "executions", "001", "human-debug", "prompt-diagnostics.json"),
        `${JSON.stringify({
          version: "1",
          prompt_kind: "agent",
          renderer: "renderHarnessPrompt",
          total_chars: 23,
          context_pointer_count: 22,
          context_pointer_kinds: ["artifact", "workspace_file"],
          sections: [
            { name: "Role", chars: 23 },
            { name: "Context", chars: 100 }
          ],
          warnings: ["context_many_pointers"]
        }, null, 2)}\n`,
        "utf8"
      );

      const variants: EvalVariant[] = [
        {
          id: "current",
          description: "Current prompts.",
          variant_path: "/tmp/current.json",
          env: {},
          prompt_pack: "current"
        },
        {
          id: "candidate",
          description: "Candidate prompts.",
          variant_path: "/tmp/candidate.json",
          env: {},
          prompt_pack: "candidate"
        }
      ];
      const entries = await buildPromptDiffEntries([
        trialResult({ scenario: "scenario", variant: "current", trial: "trial-001", runRoot: baselineRoot }),
        trialResult({ scenario: "scenario", variant: "candidate", trial: "trial-001", runRoot: candidateRoot })
      ], variants);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual(expect.objectContaining({
        prompt_path: promptRelativePath,
        candidate_diagnostics: expect.objectContaining({
          prompt_kind: "agent",
          context_pointer_count: 22,
          warnings: ["context_many_pointers"]
        })
      }));
      expect(entries[0]?.candidate_diagnostics?.largest_sections).toEqual([
        { name: "Context", chars: 100 },
        { name: "Role", chars: 23 }
      ]);

      const report = renderPromptDiffReport({ variants, entries });
      expect(report).toContain("## Prompt Diagnostics Warnings");
      expect(report).toContain("context_many_pointers");
      expect(report).toContain(promptRelativePath);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
