import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import type { AuthoredGraphDocument, ExecNode, SequenceNode } from "../../src/graph/authored.js";
import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";
import { reviewCompiledGraph } from "../../src/graph/review.js";
import { withNodeIntentDefaults } from "../helpers/graph.js";

const execFileAsync = promisify(execFile);

const TEST_INTENT = {
  goal: "Select a candidate strategy.",
  acceptance_criteria: ["The candidate-selection pattern publishes a selected strategy."]
};

function buildPatternStep(overrides = {}) {
  return {
    type: "pattern_candidate_selection",
    id: "checkout_strategy",
    runtime: {
      repo: "main",
      profile: "default"
    },
    intent: {
      goal: "Select the checkout timeout strategy that best fits this repository.",
      acceptance_criteria: [
        "Each candidate is compared against the same criteria.",
        "The selected candidate is implementation-ready and cites evidence.",
        "Rejected candidates include rationale."
      ],
      constraints: ["Do not edit source files."]
    },
    selection: {
      candidates: [
        {
          id: "minimal_patch",
          intent: {
            goal: "Develop the smallest safe timeout strategy using existing architecture.",
            acceptance_criteria: [
              "The candidate identifies the minimal code surface.",
              "The candidate explains validation and rollout risk."
            ],
            constraints: ["Do not introduce new infrastructure."]
          }
        },
        {
          id: "central_policy",
          intent: {
            goal: "Develop a centralized timeout policy strategy.",
            acceptance_criteria: [
              "The candidate defines the shared policy boundary.",
              "The candidate explains migration and validation steps."
            ],
            constraints: ["Do not assume every caller can migrate at once."]
          }
        }
      ],
      pass_threshold: 0.8,
      criteria: [
        {
          id: "repo_fit",
          weight: 0.4,
          required: true,
          rubric: "The candidate fits existing repository architecture and conventions."
        },
        {
          id: "risk",
          weight: 0.35,
          rubric: "The candidate minimizes implementation and rollout risk."
        },
        {
          id: "testability",
          weight: 0.25,
          rubric: "The candidate has a clear focused validation path."
        }
      ]
    },
    ...overrides
  };
}

function buildDocument(steps: unknown[]): AuthoredGraphDocument {
  return {
    version: "1",
    graph_id: "pattern-candidate-selection-test",
    intent: TEST_INTENT,
    repos: {
      main: {
        path: "."
      }
    },
    defaults: {
      launch_profile: "default"
    },
    profiles: {
      default: {
        harness: "codex-cli",
        sandbox: "read-only"
      },
      supervisor: {
        harness: "codex-cli",
        sandbox: "read-only"
      }
    },
    supervision: {
      profile: "supervisor",
      max_total_interventions: 3
    },
    graph: {
      type: "sequence",
      id: "root",
      steps
    }
  };
}

function normalizedWorkflow(): SequenceNode {
  const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(buildDocument([buildPatternStep()])));
  expect(normalized.diagnostics).toEqual([]);
  expect(normalized.lowered_managed_nodes).toEqual([
    {
      authored_id: "checkout_strategy",
      managed_kind: "pattern_candidate_selection",
      lowered_to: "sequence"
    }
  ]);

  const root = normalized.document?.graph;
  if (!root || root.type !== "sequence") {
    throw new Error("Expected normalized graph root to be a sequence.");
  }
  const workflow = root.steps[0];
  if (!workflow || workflow.type !== "sequence") {
    throw new Error("Expected pattern_candidate_selection to lower into a sequence workflow.");
  }
  return workflow;
}

function selectorNode(): ExecNode {
  const workflow = normalizedWorkflow();
  const selector = workflow.steps[3];
  if (!selector || selector.type !== "exec") {
    throw new Error("Expected fourth lowered step to be the deterministic selector exec.");
  }
  return selector;
}

function candidateJson(id: string, title: string) {
  return {
    schema_version: 1,
    id,
    title,
    summary: `${title} summary.`,
    approach: `${title} approach.`,
    implementation_outline: [`Implement ${title}.`],
    validation_plan: [`Validate ${title}.`],
    risks: [`Risk for ${title}.`],
    assumptions: [`Assumption for ${title}.`],
    evidence: [{ ref: "src/checkout.ts", summary: `Evidence for ${title}.` }],
    residual_uncertainty: []
  };
}

async function runSelector(options: {
  minimalScores: Record<string, { passed: boolean; score: number }>;
  centralScores: Record<string, { passed: boolean; score: number }>;
  minimalCandidate?: Record<string, unknown>;
  centralCandidate?: Record<string, unknown>;
  diversity?: { passed: boolean; score: number; summary: string; issues: string[] };
}) {
  const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-candidate-selection-selector-"));
  const outputDir = join(tempRoot, "out");
  const selector = selectorNode();
  await mkdir(outputDir, { recursive: true });

  const paths: Record<string, string> = {};
  async function writeJson(name: string, value: unknown) {
    const filePath = join(tempRoot, `${name}.json`);
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    paths[name] = filePath;
  }

  await writeJson("candidate_minimal_patch", options.minimalCandidate ?? candidateJson("minimal_patch", "Minimal patch"));
  await writeJson("candidate_central_policy", options.centralCandidate ?? candidateJson("central_policy", "Central policy"));
  await writeJson("diversity_result", options.diversity ?? {
    passed: true,
    score: 0.95,
    summary: "Candidates are materially distinct.",
    issues: []
  });

  for (const [candidate, scores] of [
    ["minimal_patch", options.minimalScores],
    ["central_policy", options.centralScores]
  ] as const) {
    for (const criterion of ["repo_fit", "risk", "testability"]) {
      const score = scores[criterion] ?? { passed: true, score: 1 };
      await writeJson(`criterion_${candidate}_${criterion}`, {
        passed: score.passed,
        score: score.score,
        summary: `${candidate} ${criterion} score ${score.score}.`,
        issues: []
      });
    }
  }

  const env = {
    ...process.env,
    AGENTFLOW_OUTPUT_DIR: outputDir,
    AGENTFLOW_CONTEXT_CANDIDATE_MINIMAL_PATCH: paths.candidate_minimal_patch,
    AGENTFLOW_CONTEXT_CANDIDATE_CENTRAL_POLICY: paths.candidate_central_policy,
    AGENTFLOW_CONTEXT_DIVERSITY_RESULT: paths.diversity_result,
    AGENTFLOW_CONTEXT_CRITERION_MINIMAL_PATCH_REPO_FIT: paths.criterion_minimal_patch_repo_fit,
    AGENTFLOW_CONTEXT_CRITERION_MINIMAL_PATCH_RISK: paths.criterion_minimal_patch_risk,
    AGENTFLOW_CONTEXT_CRITERION_MINIMAL_PATCH_TESTABILITY: paths.criterion_minimal_patch_testability,
    AGENTFLOW_CONTEXT_CRITERION_CENTRAL_POLICY_REPO_FIT: paths.criterion_central_policy_repo_fit,
    AGENTFLOW_CONTEXT_CRITERION_CENTRAL_POLICY_RISK: paths.criterion_central_policy_risk,
    AGENTFLOW_CONTEXT_CRITERION_CENTRAL_POLICY_TESTABILITY: paths.criterion_central_policy_testability
  };

  let exitCode = 0;
  let stderr = "";
  try {
    await execFileAsync("node", ["-e", selector.args?.[1] ?? ""], { env });
  } catch (error) {
    exitCode = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
    stderr = String((error as { stderr?: unknown }).stderr ?? "");
  }

  const selectionPath = join(outputDir, "selection.json");
  const selection = JSON.parse(await readFile(selectionPath, "utf8")) as Record<string, unknown>;
  await rm(tempRoot, { recursive: true, force: true });
  return { exitCode, stderr, selection };
}

describe("pattern candidate selection", () => {
  it("lowers into candidate fanout, diversity check, criterion fanout, and deterministic selector", () => {
    const workflow = normalizedWorkflow();
    expect(workflow.steps.map((step) => step.id)).toEqual([
      "checkout_strategy__managed__pattern_candidate_selection__candidates",
      "checkout_strategy__managed__pattern_candidate_selection__diversity",
      "checkout_strategy__managed__pattern_candidate_selection__criteria",
      "checkout_strategy"
    ]);

    const candidates = workflow.steps[0];
    const diversity = workflow.steps[1];
    const criteria = workflow.steps[2];
    const selector = workflow.steps[3];
    if (!candidates || candidates.type !== "parallel") {
      throw new Error("Expected candidate fanout to be a parallel node.");
    }
    if (!diversity || diversity.type !== "check") {
      throw new Error("Expected diversity to be an AI check node.");
    }
    if (!criteria || criteria.type !== "parallel") {
      throw new Error("Expected criterion fanout to be a parallel node.");
    }

    expect(candidates.steps.map((step) => step.id)).toEqual([
      "checkout_strategy__managed__pattern_candidate_selection__candidate_minimal_patch",
      "checkout_strategy__managed__pattern_candidate_selection__candidate_central_policy"
    ]);
    expect(candidates.steps[0]).toEqual(expect.objectContaining({
      type: "agent",
      managed_runtime: expect.objectContaining({
        kind: "pattern_candidate_selection",
        root_id: "checkout_strategy",
        phase: "candidate",
        config: expect.objectContaining({ candidate_id: "minimal_patch" })
      }),
      artifacts: expect.objectContaining({
        candidate_json: expect.objectContaining({ path: "candidate.json" })
      })
    }));

    const candidatePrompt = JSON.stringify(candidates.steps[0]);
    expect(candidatePrompt).toContain("Develop the smallest safe timeout strategy");
    expect(candidatePrompt).toContain("Candidate Output Contract");
    expect(candidatePrompt).toContain("Do not edit source files.");
    expect(candidatePrompt).not.toContain("managed pattern");
    expect(candidatePrompt).not.toContain("public artifact");
    expect(candidatePrompt).not.toContain("private artifact");
    expect(candidatePrompt).not.toContain("runtime coordinator");

    expect(diversity).toEqual(expect.objectContaining({
      type: "check",
      check_kind: "ai",
      managed_runtime: expect.objectContaining({
        kind: "pattern_candidate_selection",
        root_id: "checkout_strategy",
        phase: "diversity"
      })
    }));
    expect(JSON.stringify(diversity)).toContain("candidate_minimal_patch");
    expect(JSON.stringify(diversity)).toContain("candidate_central_policy");
    expect(JSON.stringify(diversity)).toContain("fail wording variants");

    expect(criteria.steps).toHaveLength(6);
    expect(criteria.steps[0]).toEqual(expect.objectContaining({
      type: "check",
      check_kind: "ai",
      managed_runtime: expect.objectContaining({
        kind: "pattern_candidate_selection",
        root_id: "checkout_strategy",
        phase: "criterion",
        config: expect.objectContaining({
          candidate_id: "minimal_patch",
          criterion_id: "repo_fit"
        })
      })
    }));
    expect(JSON.stringify(criteria.steps[0])).toContain("candidate_minimal_patch");
    expect(JSON.stringify(criteria.steps[0])).toContain("The candidate fits existing repository architecture and conventions.");

    expect(selector).toEqual(expect.objectContaining({
      id: "checkout_strategy",
      type: "exec",
      command: "node",
      artifacts: expect.objectContaining({
        selection: expect.objectContaining({ path: "selection.json" })
      })
    }));
    expect(JSON.stringify(selector)).toContain("diversity_result");
    expect(JSON.stringify(selector)).toContain("criterion_minimal_patch_repo_fit");
  });

  it("rejects first-pass knobs that are not part of the small authoring contract", () => {
    const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(buildDocument([
      buildPatternStep({
        runtime: {
          repo: "main",
          profile: "default",
          max_concurrency: 4
        },
        artifacts: {
          summary: {
            from: "output_dir",
            path: "summary.md",
            description: "Unsupported public summary."
          }
        },
        selection: {
          candidate_count: 3,
          candidate_kind: "design",
          selection_policy: "highest_score_with_required_pass",
          candidates: [
            {
              id: "minimal_patch",
              mode: "deep_work",
              intent: { goal: "Develop a minimal strategy." }
            },
            {
              id: "central_policy",
              intent: { goal: "Develop a central strategy." }
            }
          ],
          criteria: [
            {
              id: "repo_fit",
              kind: "command",
              command: "npm test",
              weight: 1,
              rubric: "The candidate fits the repository."
            }
          ]
        }
      })
    ])));

    expect(normalized.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "$.graph.steps[0].artifacts",
        message: "pattern_candidate_selection publishes only the selection artifact; candidate packets, diversity checks, and scorecards remain internal run evidence."
      }),
      expect.objectContaining({
        path: "$.graph.steps[0].selection.candidate_count",
        message: "Unknown field \"candidate_count\" is not part of the graph contract."
      }),
      expect.objectContaining({
        path: "$.graph.steps[0].selection.candidate_kind",
        message: "Unknown field \"candidate_kind\" is not part of the graph contract."
      }),
      expect.objectContaining({
        path: "$.graph.steps[0].selection.selection_policy",
        message: "Unknown field \"selection_policy\" is not part of the graph contract."
      }),
      expect.objectContaining({
        path: "$.graph.steps[0].selection.candidates[0].mode",
        message: "Unknown field \"mode\" is not part of the graph contract."
      }),
      expect.objectContaining({
        path: "$.graph.steps[0].selection.criteria[0].kind",
        message: "Unknown field \"kind\" is not part of the graph contract."
      }),
      expect.objectContaining({
        path: "$.graph.steps[0].selection.criteria[0].command",
        message: "Unknown field \"command\" is not part of the graph contract."
      }),
      expect.objectContaining({
        path: "$.graph.steps[0].runtime.max_concurrency",
        message: "Unknown field \"max_concurrency\" is not part of the graph contract."
      })
    ]));
  });

  it("validates candidate and criterion authoring boundaries", () => {
    const manyCandidates = Array.from({ length: 9 }, (_, index) => ({
      id: `candidate_${index + 1}`,
      intent: {
        goal: `Develop candidate ${index + 1}.`,
        acceptance_criteria: [`Candidate ${index + 1} is concrete.`]
      }
    }));
    const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(buildDocument([
      buildPatternStep({
        selection: {
          candidates: [
            {
              id: "duplicate",
              intent: {
                goal: "Develop first strategy.",
                acceptance_criteria: ["The first strategy is concrete."]
              }
            },
            {
              id: "duplicate",
              intent: {
                goal: "Develop second strategy.",
                acceptance_criteria: ["The second strategy is concrete."]
              }
            },
            { id: "missing_intent" }
          ],
          criteria: [
            { id: "repo_fit", weight: 0.7, rubric: "Fits the repo." },
            { id: "repo_fit", weight: 0.2, rubric: "Still fits the repo." }
          ]
        }
      }),
      buildPatternStep({
        id: "too_many",
        selection: {
          candidates: manyCandidates,
          criteria: [{ id: "repo_fit", weight: 1, rubric: "Fits the repo." }]
        }
      }),
      buildPatternStep({
        id: "too_few",
        selection: {
          candidates: [
            {
              id: "only_one",
              intent: {
                goal: "Develop one strategy.",
                acceptance_criteria: ["The strategy is concrete."]
              }
            }
          ],
          criteria: []
        }
      })
    ])));

    expect(normalized.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "$.graph.steps[0].selection.candidates[1].id",
        message: "Duplicate candidate id \"duplicate\"."
      }),
      expect.objectContaining({
        path: "$.graph.steps[0].selection.candidates[2].intent",
        message: "Executable nodes require intent."
      }),
      expect.objectContaining({
        path: "$.graph.steps[0].selection.criteria[1].id",
        message: "Duplicate selection criterion id \"repo_fit\"."
      }),
      expect.objectContaining({
        path: "$.graph.steps[0].selection.criteria",
        message: "Selection criterion weights must sum to 1. Current total is 0.9."
      }),
      expect.objectContaining({
        path: "$.graph.steps[1].selection.candidates",
        message: "pattern_candidate_selection.selection.candidates supports at most 8 candidates."
      }),
      expect.objectContaining({
        path: "$.graph.steps[2].selection.candidates",
        message: "pattern_candidate_selection.selection.candidates must include at least 2 candidates."
      }),
      expect.objectContaining({
        path: "$.graph.steps[2].selection.criteria",
        message: "pattern_candidate_selection.selection.criteria must include at least one criterion."
      })
    ]));
  });

  it("selects the highest eligible candidate deterministically", async () => {
    const { exitCode, selection } = await runSelector({
      minimalScores: {
        repo_fit: { passed: true, score: 0.85 },
        risk: { passed: true, score: 0.7 },
        testability: { passed: true, score: 0.8 }
      },
      centralScores: {
        repo_fit: { passed: true, score: 0.95 },
        risk: { passed: true, score: 0.9 },
        testability: { passed: true, score: 0.85 }
      }
    });

    expect(exitCode).toBe(0);
    expect(selection).toEqual(expect.objectContaining({
      schema_version: 1,
      status: "selected",
      selected_candidate_id: "central_policy",
      pass_threshold: 0.8
    }));
    expect(selection.selected).toEqual(expect.objectContaining({ id: "central_policy" }));
    expect(selection.ranking).toEqual([
      expect.objectContaining({ candidate_id: "central_policy", eligible: true, total_score: 0.9075 }),
      expect.objectContaining({ candidate_id: "minimal_patch", eligible: false, total_score: 0.785 })
    ]);
  });

  it("blocks candidates when required criteria miss the threshold", async () => {
    const { exitCode, selection } = await runSelector({
      minimalScores: {
        repo_fit: { passed: true, score: 0.9 },
        risk: { passed: true, score: 0.85 },
        testability: { passed: true, score: 0.85 }
      },
      centralScores: {
        repo_fit: { passed: true, score: 0.75 },
        risk: { passed: true, score: 1 },
        testability: { passed: true, score: 1 }
      }
    });

    expect(exitCode).toBe(0);
    expect(selection.selected_candidate_id).toBe("minimal_patch");
    expect(selection.ranking).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidate_id: "central_policy",
        eligible: false,
        blockers: [
          expect.objectContaining({
            criterion_id: "repo_fit",
            summary: expect.stringContaining("below the pass threshold")
          })
        ]
      })
    ]));
  });

  it("writes failure evidence and exits nonzero when no candidate is eligible", async () => {
    const { exitCode, stderr, selection } = await runSelector({
      minimalScores: {
        repo_fit: { passed: false, score: 0.4 },
        risk: { passed: true, score: 0.4 },
        testability: { passed: true, score: 0.4 }
      },
      centralScores: {
        repo_fit: { passed: true, score: 0.7 },
        risk: { passed: true, score: 0.7 },
        testability: { passed: true, score: 0.7 }
      }
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("No candidate reached the selection threshold.");
    expect(selection).toEqual(expect.objectContaining({
      status: "no_eligible_candidate",
      selected_candidate_id: null
    }));
  });

  it("rejects candidate packets with mismatched ids", async () => {
    const { exitCode, stderr, selection } = await runSelector({
      minimalCandidate: candidateJson("wrong_id", "Wrong id"),
      minimalScores: {
        repo_fit: { passed: true, score: 1 },
        risk: { passed: true, score: 1 },
        testability: { passed: true, score: 1 }
      },
      centralScores: {
        repo_fit: { passed: true, score: 1 },
        risk: { passed: true, score: 1 },
        testability: { passed: true, score: 1 }
      }
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Candidate packet id "wrong_id" does not match authored candidate "minimal_patch".');
    expect(selection).toEqual(expect.objectContaining({
      status: "invalid_candidate_packets"
    }));
  });

  it("records authored-order tie breaks for equal eligible scores", async () => {
    const { exitCode, selection } = await runSelector({
      minimalScores: {
        repo_fit: { passed: true, score: 0.9 },
        risk: { passed: true, score: 0.9 },
        testability: { passed: true, score: 0.9 }
      },
      centralScores: {
        repo_fit: { passed: true, score: 0.9 },
        risk: { passed: true, score: 0.9 },
        testability: { passed: true, score: 0.9 }
      }
    });

    expect(exitCode).toBe(0);
    expect(selection.selected_candidate_id).toBe("minimal_patch");
    expect(selection.tie_breaker).toEqual({
      kind: "authored_order",
      tied_candidate_ids: ["minimal_patch", "central_policy"]
    });
  });

  it("reviews candidate intents and selection criteria as prompt-facing fields", () => {
    const authored = withNodeIntentDefaults(buildDocument([
      buildPatternStep({
        selection: {
          candidates: [
            {
              id: "minimal_patch",
              intent: {
                goal: "Use this downstream node to develop a minimal checkout timeout strategy.",
                acceptance_criteria: ["The candidate is concrete."],
                constraints: ["Do not edit source files."]
              }
            },
            {
              id: "central_policy",
              intent: {
                goal: "Develop a centralized checkout timeout policy strategy.",
                acceptance_criteria: ["The candidate is concrete."],
                constraints: ["Do not edit source files."]
              }
            }
          ],
          pass_threshold: 0.8,
          criteria: [
            {
              id: "repo_fit",
              weight: 0.4,
              required: true,
              rubric: "Judge whether pattern_candidate_selection picked the repository-shaped option."
            },
            {
              id: "risk",
              weight: 0.35,
              rubric: "The candidate minimizes implementation and rollout risk."
            },
            {
              id: "testability",
              weight: 0.25,
              rubric: "The candidate has a clear focused validation path."
            }
          ]
        }
      })
    ]));
    const normalized = normalizeAuthoredGraphDocument(authored);
    expect(normalized.diagnostics).toEqual([]);
    const launch = resolveLaunchConfig(normalized.document!);
    const compilation = compileAuthoredGraph(normalized.document!, launch, normalized.lowered_managed_nodes);
    expect(compilation.diagnostics).toEqual([]);
    if (!compilation.compiled_graph) {
      throw new Error("Expected candidate-selection graph to compile.");
    }

    const review = reviewCompiledGraph(normalized.document!, compilation.compiled_graph, {
      authored_document: authored
    });

    expect(review.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: "prompt_surface",
        path: "$.graph.steps[0].selection.candidates[0].intent.goal",
        message: expect.stringContaining("candidate strategy worker")
      }),
      expect.objectContaining({
        category: "prompt_surface",
        path: "$.graph.steps[0].selection.criteria[0].rubric",
        message: expect.stringContaining("candidate criterion evaluator")
      })
    ]));
  });

  it("compiles downstream refs against the stable selection artifact", () => {
    const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(buildDocument([
      buildPatternStep(),
      {
        type: "agent",
        id: "implement_selected",
        runtime: {
          repo: "main",
          profile: "default"
        },
        support: {
          context: [
            {
              name: "selected_strategy",
              kind: "artifact",
              ref: "checkout_strategy.selection",
              what: "The selected candidate strategy packet.",
              why: "The implementation worker should preserve the selected strategy and rejection rationale."
            }
          ]
        },
        intent: {
          goal: "Implement the selected checkout timeout strategy.",
          acceptance_criteria: ["The selected strategy is implemented."],
          constraints: ["Do not implement rejected strategies."]
        }
      }
    ])));
    expect(normalized.diagnostics).toEqual([]);
    const launch = resolveLaunchConfig(normalized.document!);
    const compilation = compileAuthoredGraph(normalized.document!, launch, normalized.lowered_managed_nodes);
    expect(compilation.diagnostics).toEqual([]);

    expect(compilation.compiled_graph?.nodes.find((node) => node.authored_id === "checkout_strategy")).toEqual(expect.objectContaining({
      declared_artifacts: expect.objectContaining({
        selection: expect.objectContaining({ path: "selection.json" })
      })
    }));
    expect(compilation.compiled_graph?.nodes.find((node) => node.authored_id === "implement_selected")).toEqual(expect.objectContaining({
      context: expect.arrayContaining([
        expect.objectContaining({
          name: "selected_strategy",
          ref: "checkout_strategy.selection"
        })
      ])
    }));
  });
});
