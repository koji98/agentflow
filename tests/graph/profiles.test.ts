import { describe, expect, it } from "vitest";

import type {
  AgentNode,
  AuthoredGraphDocument,
  CheckNode,
  ExecNode,
  GraphDefaults,
  GraphProfile
} from "../../src/graph/authored.js";
import {
  builtInCodexReasoningEffort,
  builtInInputRules,
  builtInTimeoutSeconds,
  resolveLaunchConfig,
  resolveNodePolicy
} from "../../src/graph/profiles.js";

function createDocument(
  profiles: Record<string, GraphProfile>,
  defaults?: GraphDefaults
): AuthoredGraphDocument {
  return {
    version: "1",
    graph_id: "profile-resolution",
    repos: {
      main: {
        path: "."
      }
    },
    ...(defaults ? { defaults } : {}),
    profiles,
    graph: {
      type: "sequence",
      id: "root",
      steps: []
    }
  };
}

describe("graph profile resolution", () => {
  it("falls back to the default profile and built-in node policy defaults", () => {
    const document = createDocument({
      default: {
        harness: "codex-cli"
      }
    });

    const launch = resolveLaunchConfig(document);
    const resolution = resolveNodePolicy(document, launch, {
      type: "agent",
      id: "implement",
      prompt: "Implement the change."
    } satisfies AgentNode);

    expect(launch).toEqual({
      launch_profile: "default",
      workspace_backend: "worktree",
      profile: document.profiles!.default,
      diagnostics: []
    });
    expect(resolution.diagnostics).toEqual([]);
    expect(resolution.policy).toEqual(
      expect.objectContaining({
        profile_name: "default",
        workspace_backend: "worktree",
        harness: "codex-cli",
        reasoning_effort: builtInCodexReasoningEffort,
        timeout_sec: builtInTimeoutSeconds,
        input_rules: builtInInputRules,
        sandbox: "workspace-write"
      })
    );
  });

  it("keeps invalid launch overrides explicit while falling back to a supported workspace backend", () => {
    const document = createDocument({
      default: {
        harness: "codex-cli"
      }
    });

    const launch = resolveLaunchConfig(document, {
      launchProfile: "missing",
      workspaceBackend: "remote-devbox"
    });

    expect(launch.launch_profile).toBe("missing");
    expect(launch.workspace_backend).toBe("worktree");
    expect(launch.profile).toBeUndefined();
    expect(launch.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.defaults.launch_profile",
          message: 'Unknown launch profile "missing".'
        }),
        expect.objectContaining({
          path: "$.defaults.workspace_backend",
          message: 'Unsupported workspace backend "remote-devbox".'
        })
      ])
    );
  });

  it("merges launch and node profiles field-by-field without adding harness-only policy to exec nodes", () => {
    const document = createDocument(
      {
        default: {
          harness: "codex-cli",
          timeout_sec: 900,
          input_rules: {
            max_total_bytes: 262144
          }
        },
        review: {
          timeout_sec: 120,
          input_rules: {
            max_total_bytes: 65536,
            max_bytes_per_item: 2048
          }
        }
      },
      {
        launch_profile: "default",
        workspace_backend: "inplace"
      }
    );

    const launch = resolveLaunchConfig(document);
    const resolution = resolveNodePolicy(document, launch, {
      type: "exec",
      id: "format",
      profile: "review",
      command: "npm",
      timeout_sec: 15
    } satisfies ExecNode);

    expect(resolution.diagnostics).toEqual([]);
    expect(resolution.policy).toEqual({
      profile_name: "review",
      workspace_backend: "inplace",
      timeout_sec: 15,
      input_rules: {
        max_total_bytes: 65536,
        max_bytes_per_item: 2048
      }
    });
    expect(resolution.policy.harness).toBeUndefined();
    expect(resolution.policy.model).toBeUndefined();
    expect(resolution.policy.sandbox).toBeUndefined();
  });

  it("inherits launch AI-check models only when the node profile stays on the same harness", () => {
    const document = createDocument(
      {
        default: {
          harness: "codex-cli",
          model: "gpt-5-codex",
          ai_check_defaults: {
            model: "gpt-5-judge"
          }
        },
        same_harness: {
          harness: "codex-cli"
        },
        different_harness: {
          harness: "cursor-cli",
          ai_check_defaults: {
            rubric: "Review the patch carefully."
          }
        }
      },
      {
        launch_profile: "default"
      }
    );

    const launch = resolveLaunchConfig(document);
    const inherited = resolveNodePolicy(document, launch, {
      type: "check",
      id: "judge_same",
      profile: "same_harness",
      check_kind: "ai",
      prompt: "Judge the patch."
    } satisfies CheckNode);
    const isolated = resolveNodePolicy(document, launch, {
      type: "check",
      id: "judge_cross",
      profile: "different_harness",
      check_kind: "ai",
      prompt: "Judge the patch."
    } satisfies CheckNode);

    expect(inherited.diagnostics).toEqual([]);
    expect(inherited.policy).toEqual(
      expect.objectContaining({
        profile_name: "same_harness",
        harness: "codex-cli",
        model: "gpt-5-judge",
        reasoning_effort: builtInCodexReasoningEffort,
        sandbox: "read-only"
      })
    );

    expect(isolated.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.judge_cross.profile",
          message: expect.stringContaining("AI checks require codex-cli")
        })
      ])
    );
    expect(isolated.policy).toEqual(
      expect.objectContaining({
        profile_name: "different_harness",
        harness: "cursor-cli",
        sandbox: "read-only"
      })
    );
    expect(isolated.policy.model).toBeUndefined();
  });

  it("lets codex profiles override the default reasoning effort explicitly, including xhigh", () => {
    const document = createDocument(
      {
        default: {
          harness: "codex-cli",
          reasoning_effort: "low"
        }
      },
      {
        launch_profile: "default"
      }
    );

    const launch = resolveLaunchConfig(document);
    const resolution = resolveNodePolicy(document, launch, {
      type: "agent",
      id: "implement",
      prompt: "Implement the change.",
      reasoning_effort: "xhigh"
    } satisfies AgentNode);

    expect(resolution.diagnostics).toEqual([]);
    expect(resolution.policy.reasoning_effort).toBe("xhigh");
  });
});
