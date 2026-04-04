import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AuthoredGraphDocument } from "../../src/graph/authored.js";
import type { CompiledGraph } from "../../src/graph/compiled.js";
import type { GraphInspectionPayload } from "../../web-app/shared/contracts/graph";
import type { ArtifactRead, NodeDetail, NodeLogPayload, RunSnapshot, RunSummary } from "../../web-app/shared/contracts/runs";
import {
  App,
  buildGraphRoute,
  loadRecentGraphPaths,
  rememberGraphPath,
  resolveRoute
} from "../../web-app/client/src/app";
import {
  buildStaticInspectorModel,
  buildCompiledGraphCanvas,
  buildRunInspectorSections,
  createDiagnosticsList,
  createGraphKpis,
  createLaunchpadKpis,
  mergeRunEvents,
  pickDefaultCompiledId,
  selectNodeView
} from "../../web-app/client/src/lib/graph_view_model";
import { InspectorPanel } from "../../web-app/client/src/components/inspector_panel";
import { Launchpad } from "../../web-app/client/src/components/launchpad";
import { LogsPanel } from "../../web-app/client/src/components/logs_panel";

const authoredGraph: AuthoredGraphDocument = {
  version: "1",
  graph_id: "agentflow-demo",
  repos: {
    main: {
      path: "."
    }
  },
  defaults: {
    launch_profile: "default",
    workspace_backend: "worktree"
  },
  profiles: {
    default: {
      harness: "codex-cli",
      model: "gpt-5-codex",
      sandbox: "workspace-write",
      timeout_sec: 1800,
      input_rules: {
        max_files: 32,
        max_total_bytes: 262144,
        max_bytes_per_item: 65536
      }
    }
  },
  graph: {
    type: "sequence",
    id: "root",
    steps: [
      {
        type: "agent",
        id: "inspect-graph",
        label: "Inspect Graph",
        prompt: "Inspect the repository and summarize graph work."
      },
      {
        type: "repeat",
        id: "repair-loop",
        label: "Repair Loop",
        max_attempts: 2,
        body: {
          type: "sequence",
          id: "repair-body",
          steps: [
            {
              type: "exec",
              id: "apply-fix",
              label: "Apply Fix",
              command: "npm",
              args: ["run", "lint:fix"]
            },
            {
              type: "check",
              id: "verify-fix",
              label: "Verify Fix",
              check_kind: "deterministic",
              command: "npm",
              args: ["test"]
            }
          ]
        },
        until: {
          node: "verify-fix"
        }
      },
      {
        type: "exec",
        id: "finalize",
        label: "Finalize",
        command: "git",
        args: ["status", "--short"]
      }
    ]
  }
};

const compiledGraph: CompiledGraph = {
  graph_id: "agentflow-demo",
  launch: {
    launch_profile: "default",
    workspace_backend: "worktree"
  },
  entry_node_ids: ["root__inspect-graph"],
  nodes: [
    {
      compiled_id: "root__inspect-graph",
      authored_id: "inspect-graph",
      kind: "agent",
      label: "Inspect Graph",
      repo: "main",
      deps: [],
      scope_stack: ["scope__root"],
      effective_policy: {
        profile_name: "default",
        workspace_backend: "worktree",
        harness: "codex-cli",
        model: "gpt-5-codex",
        sandbox: "workspace-write",
        timeout_sec: 1800,
        input_rules: {
          max_files: 32,
          max_total_bytes: 262144,
          max_bytes_per_item: 65536
        }
      },
      inputs: [],
      context_from: [],
      declared_outputs: [],
      prompt: "Inspect the repository and summarize graph work."
    },
    {
      compiled_id: "root__repair-loop__apply-fix",
      authored_id: "apply-fix",
      kind: "exec",
      label: "Apply Fix",
      repo: "main",
      deps: ["root__inspect-graph"],
      scope_stack: ["scope__root", "scope__repair-loop"],
      repeat_scope_id: "scope__repair-loop",
      effective_policy: {
        profile_name: "default",
        workspace_backend: "worktree",
        timeout_sec: 1800,
        input_rules: {
          max_files: 32,
          max_total_bytes: 262144,
          max_bytes_per_item: 65536
        }
      },
      inputs: [],
      context_from: [],
      declared_outputs: [],
      command: "npm",
      args: ["run", "lint:fix"]
    },
    {
      compiled_id: "root__repair-loop__verify-fix",
      authored_id: "verify-fix",
      kind: "check",
      label: "Verify Fix",
      repo: "main",
      deps: ["root__repair-loop__apply-fix"],
      scope_stack: ["scope__root", "scope__repair-loop"],
      repeat_scope_id: "scope__repair-loop",
      effective_policy: {
        profile_name: "default",
        workspace_backend: "worktree",
        timeout_sec: 1800,
        input_rules: {
          max_files: 32,
          max_total_bytes: 262144,
          max_bytes_per_item: 65536
        }
      },
      inputs: [],
      context_from: [],
      declared_outputs: [],
      check_kind: "deterministic",
      command: "npm",
      args: ["test"]
    },
    {
      compiled_id: "root__finalize",
      authored_id: "finalize",
      kind: "exec",
      label: "Finalize",
      repo: "main",
      deps: ["root__repair-loop__verify-fix"],
      scope_stack: ["scope__root"],
      effective_policy: {
        profile_name: "default",
        workspace_backend: "worktree",
        timeout_sec: 1800,
        input_rules: {
          max_files: 32,
          max_total_bytes: 262144,
          max_bytes_per_item: 65536
        }
      },
      inputs: [],
      context_from: [],
      declared_outputs: [],
      command: "git",
      args: ["status", "--short"]
    }
  ],
  edges: [
    {
      edge_id: "edge-1",
      from: "root__inspect-graph",
      to: "root__repair-loop__apply-fix",
      on: "passed",
      kind: "flow"
    },
    {
      edge_id: "edge-2",
      from: "root__repair-loop__apply-fix",
      to: "root__repair-loop__verify-fix",
      on: "passed",
      kind: "flow"
    },
    {
      edge_id: "edge-3",
      from: "root__repair-loop__verify-fix",
      to: "root__repair-loop__apply-fix",
      on: "failed",
      kind: "repeat-back",
      repeat_scope_id: "scope__repair-loop"
    },
    {
      edge_id: "edge-4",
      from: "root__repair-loop__verify-fix",
      to: "root__finalize",
      on: "passed",
      kind: "flow"
    }
  ],
  scopes: [
    {
      scope_id: "scope__root",
      authored_id: "root",
      kind: "sequence",
      parent_scope_id: null,
      scope_stack: [],
      entry_node_ids: ["root__inspect-graph"],
      exit_node_ids: ["root__finalize"],
      compiled_node_ids: [
        "root__inspect-graph",
        "root__repair-loop__apply-fix",
        "root__repair-loop__verify-fix",
        "root__finalize"
      ]
    },
    {
      scope_id: "scope__repair-loop",
      authored_id: "repair-loop",
      kind: "repeat",
      parent_scope_id: "scope__root",
      scope_stack: ["scope__root"],
      entry_node_ids: ["root__repair-loop__apply-fix"],
      exit_node_ids: ["root__repair-loop__verify-fix"],
      compiled_node_ids: ["root__repair-loop__apply-fix", "root__repair-loop__verify-fix"],
      max_attempts: 2,
      until_compiled_id: "root__repair-loop__verify-fix",
      body_entry_node_ids: ["root__repair-loop__apply-fix"],
      body_exit_node_ids: ["root__repair-loop__verify-fix"]
    }
  ],
  authored_to_compiled: {
    "inspect-graph": ["root__inspect-graph"],
    "apply-fix": ["root__repair-loop__apply-fix"],
    "verify-fix": ["root__repair-loop__verify-fix"],
    finalize: ["root__finalize"]
  }
};

const inspection: GraphInspectionPayload = {
  graph_path: "/tmp/agentflow/agentflow.graph.json",
  graph_id: "agentflow-demo",
  launch_profile: "default",
  workspace_backend: "worktree",
  compile_status: "Ready",
  validation_diagnostics: [],
  compile_diagnostics: [],
  launch_resolution: {
    launch_profile: "default",
    workspace_backend: "worktree",
    available_profiles: ["default"],
    diagnostics: []
  },
  repos: [
    {
      alias: "main",
      authored_path: ".",
      source_path: "/tmp/agentflow",
      workspace_path_preview: "<run-root>/workspaces/main"
    }
  ],
  authored_summary: {
    graph_id: "agentflow-demo",
    node_count: 6,
    executable_node_count: 4,
    container_node_count: 2,
    profile_count: 1,
    repo_count: 1,
    repeat_count: 1,
    node_kind_counts: {
      agent: 1,
      exec: 2,
      check: 1,
      sequence: 2,
      parallel: 0,
      repeat: 1
    }
  },
  authored_graph: authoredGraph,
  compiled_graph: compiledGraph,
  kpis: [
    { label: "Graph Id", value: "agentflow-demo" },
    { label: "Node Count", value: "6" },
    { label: "Profiles", value: "1" },
    { label: "Compile", value: "Ready" }
  ],
  modes: ["Authored", "Compiled"],
  authored_nodes: [
    {
      authored_id: "inspect-graph",
      label: "Inspect Graph",
      kind: "agent",
      scope_stack: ["root"],
      badge: "default"
    },
    {
      authored_id: "repair-loop",
      label: "Repair Loop",
      kind: "repeat",
      scope_stack: ["root"],
      badge: "max 2"
    },
    {
      authored_id: "apply-fix",
      label: "Apply Fix",
      kind: "exec",
      scope_stack: ["root", "repair-loop"],
      badge: "npm"
    }
  ],
  compiled_nodes: [
    {
      authored_id: "inspect-graph",
      compiled_id: "root__inspect-graph",
      label: "Inspect Graph",
      kind: "agent",
      scope_stack: ["scope__root"],
      repo_alias: "main",
      badge: "codex-cli"
    },
    {
      authored_id: "apply-fix",
      compiled_id: "root__repair-loop__apply-fix",
      label: "Apply Fix",
      kind: "exec",
      scope_stack: ["scope__root", "scope__repair-loop"],
      repo_alias: "main",
      repeat_scope_id: "scope__repair-loop",
      badge: "npm"
    },
    {
      authored_id: "verify-fix",
      compiled_id: "root__repair-loop__verify-fix",
      label: "Verify Fix",
      kind: "check",
      scope_stack: ["scope__root", "scope__repair-loop"],
      repo_alias: "main",
      repeat_scope_id: "scope__repair-loop",
      badge: "deterministic"
    }
  ],
  nodes: [
    {
      authored_id: "inspect-graph",
      compiled_id: "root__inspect-graph",
      label: "Inspect Graph",
      kind: "agent",
      scope_stack: ["scope__root"],
      repo_alias: "main",
      badge: "codex-cli"
    },
    {
      authored_id: "apply-fix",
      compiled_id: "root__repair-loop__apply-fix",
      label: "Apply Fix",
      kind: "exec",
      scope_stack: ["scope__root", "scope__repair-loop"],
      repo_alias: "main",
      repeat_scope_id: "scope__repair-loop",
      badge: "npm"
    },
    {
      authored_id: "verify-fix",
      compiled_id: "root__repair-loop__verify-fix",
      label: "Verify Fix",
      kind: "check",
      scope_stack: ["scope__root", "scope__repair-loop"],
      repo_alias: "main",
      repeat_scope_id: "scope__repair-loop",
      badge: "deterministic"
    }
  ]
};

const recentRuns: RunSummary[] = [
  {
    run_id: "run-123",
    graph_id: "agentflow-demo",
    run_root: "/tmp/agentflow/.agentflow/runs/run-123",
    status: "Passed",
    launch_profile: "default",
    workspace_backend: "worktree",
    snapshot_seq: 22,
    active_nodes: 0,
    passed_nodes: 4,
    failed_nodes: 0,
    current_repeat_depth: 0,
    counts: {
      total: 4,
      pending: 0,
      ready: 0,
      running: 0,
      passed: 4,
      failed: 0,
      blocked: 0,
      canceled: 0,
      skipped: 0
    },
    started_at: "2025-04-02T00:00:00.000Z",
    ended_at: "2025-04-02T00:05:00.000Z"
  }
];

const runSnapshot: RunSnapshot = {
  run: {
    run_id: "run-live",
    graph_id: "agentflow-demo",
    run_root: "/tmp/agentflow/.agentflow/runs/run-live",
    status: "Running",
    launch_profile: "default",
    workspace_backend: "worktree",
    snapshot_seq: 12,
    active_nodes: 1,
    passed_nodes: 1,
    failed_nodes: 0,
    current_repeat_depth: 1,
    counts: {
      total: 4,
      pending: 2,
      ready: 0,
      running: 1,
      passed: 1,
      failed: 0,
      blocked: 0,
      canceled: 0,
      skipped: 0
    },
    started_at: "2025-04-02T00:00:00.000Z"
  },
  authored_graph: authoredGraph,
  compiled_graph: compiledGraph,
  execution_manifest: {
    run_id: "run-live",
    graph_id: "agentflow-demo",
    launch_profile: "default",
    workspace_backend: "worktree",
    repo_workspaces: {
      main: {
        repo_alias: "main",
        source_path: "/tmp/agentflow",
        workspace_path: "/tmp/agentflow/.agentflow/runs/run-live/workspaces/main",
        backend: "worktree"
      }
    },
    nodes: [
      {
        compiled_id: "root__inspect-graph",
        authored_id: "inspect-graph",
        kind: "agent",
        repo_alias: "main",
        scope_stack: ["scope__root"],
        effective_policy: compiledGraph.nodes[0]!.effective_policy
      }
    ]
  },
  snapshot_seq: 12,
  overlay_nodes: [
    {
      authored_id: "inspect-graph",
      compiled_id: "root__inspect-graph",
      label: "Inspect Graph",
      kind: "agent",
      repo_alias: "main",
      scope_stack: ["scope__root"],
      status: "Passed",
      latest_execution_id: "root__inspect-graph-a1",
      badge: "codex-cli"
    },
    {
      authored_id: "apply-fix",
      compiled_id: "root__repair-loop__apply-fix",
      label: "Apply Fix",
      kind: "exec",
      repo_alias: "main",
      scope_stack: ["scope__root", "scope__repair-loop"],
      status: "Running",
      repeat_scope_id: "scope__repair-loop",
      active_execution_id: "root__repair-loop__apply-fix-i1-a1",
      latest_execution_id: "root__repair-loop__apply-fix-i1-a1",
      iteration_index: 1,
      attempt_index: 1,
      badge: "i1/a1"
    },
    {
      authored_id: "verify-fix",
      compiled_id: "root__repair-loop__verify-fix",
      label: "Verify Fix",
      kind: "check",
      repo_alias: "main",
      scope_stack: ["scope__root", "scope__repair-loop"],
      status: "Pending",
      repeat_scope_id: "scope__repair-loop",
      badge: "deterministic"
    }
  ],
  run_diagnostics: [
    {
      seq: 10,
      ts: "2025-04-02T00:01:55.000Z",
      severity: "warning",
      event_type: "check.evaluated",
      summary: "AI check harness timed out and required a force kill.",
      compiled_id: "root__repair-loop__verify-fix",
      authored_id: "verify-fix",
      execution_id: "root__repair-loop__verify-fix-i1-a1",
      node_label: "Verify Fix"
    }
  ],
  recent_events: [
    {
      seq: 11,
      ts: "2025-04-02T00:02:00.000Z",
      type: "node.started",
      run_id: "run-live",
      compiled_id: "root__repair-loop__apply-fix",
      authored_id: "apply-fix",
      execution_id: "root__repair-loop__apply-fix-i1-a1",
      repeat_scope_id: "scope__repair-loop",
      iteration_index: 1,
      attempt_index: 1,
      node_label: "Apply Fix",
      summary: "exec node started",
      payload: {
        kind: "exec",
        repo_alias: "main",
        profile_name: "default"
      }
    },
    {
      seq: 12,
      ts: "2025-04-02T00:02:20.000Z",
      type: "repeat.iteration.started",
      run_id: "run-live",
      repeat_scope_id: "scope__repair-loop",
      iteration_index: 1,
      summary: "repair loop iteration started",
      payload: {
        max_attempts: 2
      }
    }
  ]
};

const nodeDetail: NodeDetail = {
  run_id: "run-live",
  graph_id: "agentflow-demo",
  snapshot_seq: 12,
  node: runSnapshot.overlay_nodes[1]!,
  deps: ["root__inspect-graph"],
  effective_policy: compiledGraph.nodes[1]!.effective_policy,
  definition: {
    inputs: [],
    context_from: [],
    declared_outputs: [],
    command: "npm",
    args: ["run", "lint:fix"]
  },
  executions: [
    {
      execution_id: "root__repair-loop__apply-fix-i1-a1",
      authored_id: "apply-fix",
      compiled_id: "root__repair-loop__apply-fix",
      kind: "exec",
      repo_alias: "main",
      status: "Running",
      repeat_scope_id: "scope__repair-loop",
      iteration_index: 1,
      attempt_index: 1,
      started_at: "2025-04-02T00:02:00.000Z",
      artifact_count: 3,
      output_artifacts: {}
    }
  ],
  selected_execution_id: "root__repair-loop__apply-fix-i1-a1",
  artifacts: [
    {
      execution_id: "root__repair-loop__apply-fix-i1-a1",
      relative_path: "stdout.log",
      absolute_path: "/tmp/stdout.log",
      label: "stdout.log",
      kind: "stdout",
      content_type: "text/plain",
      size_bytes: 18
    },
    {
      execution_id: "root__repair-loop__apply-fix-i1-a1",
      relative_path: "patch.diff",
      absolute_path: "/tmp/patch.diff",
      label: "patch.diff",
      kind: "artifact",
      content_type: "text/plain",
      size_bytes: 42
    }
  ],
  check_evaluations: [],
  events: runSnapshot.recent_events
};

const nodeLogs: NodeLogPayload = {
  run_id: "run-live",
  compiled_id: "root__repair-loop__apply-fix",
  selected_execution_id: "root__repair-loop__apply-fix-i1-a1",
  executions: nodeDetail.executions,
  stdout: {
    relative_path: "stdout.log",
    absolute_path: "/tmp/stdout.log",
    content: "running lint fix\n",
    truncated: false
  },
  stderr: {
    relative_path: "stderr.log",
    absolute_path: "/tmp/stderr.log",
    content: "",
    truncated: false
  },
  artifacts: nodeDetail.artifacts
};

const artifact: ArtifactRead = {
  run_id: "run-live",
  compiled_id: "root__repair-loop__apply-fix",
  execution_id: "root__repair-loop__apply-fix-i1-a1",
  artifact: nodeDetail.artifacts[1]!,
  content: "diff --git a/src/app.tsx b/src/app.tsx\n",
  truncated: false
};

describe("web client", () => {
  it("renders the graph-native launchpad with authored and compiled inspection surfaces", () => {
    const markup = renderToStaticMarkup(
      <App
        initialRoute="/?path=%2Ftmp%2Fagentflow%2Fagentflow.graph.json"
        initialInspection={inspection}
        initialRecentRuns={recentRuns}
      />
    );

    expect(markup).toContain("Graph launchpad");
    expect(markup).toContain("Resolve graph launch");
    expect(markup).toContain("Authored");
    expect(markup).toContain("Compiled");
    expect(markup).toContain("Operator source");
    expect(markup).toContain("Run-only");
    expect(markup).toContain("Repair Loop");
    expect(markup).toContain("Latest runs for agentflow-demo");
    expect(markup).toContain("Validation, compile output, and workspace mapping");
  });

  it("renders the live monitor with overlay graph, inspector, timeline, and logs", () => {
    const markup = renderToStaticMarkup(
      <App
        initialRoute="/runs/run-live"
        initialRunSnapshot={runSnapshot}
        initialNodeDetail={nodeDetail}
        initialNodeLogs={nodeLogs}
        initialArtifact={artifact}
      />
    );

    expect(markup).toContain("Run monitor");
    expect(markup).toContain("Overlay");
    expect(markup).toContain("Runtime overlay");
    expect(markup).toContain("Run Activity");
    expect(markup).toContain("Logs and Artifacts");
    expect(markup).toContain("Cancel in CLI");
    expect(markup).toContain("Run diagnostics");
    expect(markup).toContain("AI check harness timed out and required a force kill.");
    expect(markup).toContain("Apply Fix");
    expect(markup).toContain("Overview");
    expect(markup).toContain("Executions");
    expect(markup).toContain("Timeline");
    expect(markup).toContain("root__repair-loop__apply-fix-i1-a1");
    expect(markup).toContain("patch.diff");
  });

  it("builds stable graph selection, KPI, and inspector models across authored and compiled layers", () => {
    const authoredSelection = selectNodeView(inspection, "Authored", {
      authored_id: "apply-fix"
    });
    const compiledSelection = selectNodeView(inspection, "Compiled", {
      authored_id: "apply-fix"
    });
    const inspector = buildStaticInspectorModel(inspection, "Compiled", {
      authored_id: "verify-fix",
      compiled_id: "root__repair-loop__verify-fix"
    });

    expect(authoredSelection).toEqual(
      expect.objectContaining({
        authored_id: "apply-fix",
        kind: "exec"
      })
    );
    expect(compiledSelection).toEqual(
      expect.objectContaining({
        authored_id: "apply-fix",
        compiled_id: "root__repair-loop__apply-fix",
        badge: "npm"
      })
    );
    expect(pickDefaultCompiledId(runSnapshot.compiled_graph, runSnapshot.overlay_nodes)).toBe(
      "root__repair-loop__apply-fix"
    );
    expect(createLaunchpadKpis(inspection)).toEqual(inspection.kpis);
    expect(createGraphKpis(runSnapshot)).toEqual([
      { label: "Run Status", value: "Running" },
      { label: "Active Nodes", value: "1" },
      { label: "Passed / Failed", value: "1 / 0" },
      { label: "Repeat Depth", value: "1" }
    ]);
    expect(createDiagnosticsList(inspection)).toEqual([]);
    expect(inspector).toEqual(
      expect.objectContaining({
        label: "Verify Fix",
        kind: "check",
        authored_id: "verify-fix",
        compiled_id: "root__repair-loop__verify-fix",
        profile_name: "default"
      })
    );
    expect(inspector?.sections.find((section) => section.title === "Definition")?.rows).toEqual(
      expect.arrayContaining([
        {
          label: "Check Kind",
          value: "deterministic"
        },
        {
          label: "Command",
          value: "npm test"
        }
      ])
    );
    expect(inspector?.sections.find((section) => section.title === "Profile")?.rows).toEqual(
      expect.arrayContaining([
        {
          label: "Effective Profile",
          value: "default"
        },
        {
          label: "Workspace Backend",
          value: "worktree"
        }
      ])
    );
  });

  it("resolves and rebuilds launchpad, inspect, and run routes without dropping launch state", () => {
    expect(resolveRoute("/")).toEqual({
      kind: "launchpad"
    });
    expect(
      resolveRoute("/graphs/inspect?path=%2Ftmp%2Fgraph.json&launch_profile=repair&workspace_backend=inplace&compiled=1")
    ).toEqual({
      kind: "inspect",
      graph_path: "/tmp/graph.json",
      launch_profile: "repair",
      workspace_backend: "inplace",
      compiled: true
    });
    expect(resolveRoute("/runs/run-123")).toEqual({
      kind: "run",
      run_id: "run-123"
    });
    expect(
      buildGraphRoute("inspect", {
        graph_path: "/tmp/graph.json",
        launch_profile: "repair",
        workspace_backend: "worktree",
        compiled: true
      })
    ).toBe("/graphs/inspect?path=%2Ftmp%2Fgraph.json&launch_profile=repair&workspace_backend=worktree&compiled=1");
  });

  it("deduplicates recent graph paths and reads persisted launch history defensively", () => {
    expect(rememberGraphPath(["/tmp/a.graph.json", "/tmp/b.graph.json"], " /tmp/a.graph.json ")).toEqual([
      "/tmp/a.graph.json",
      "/tmp/b.graph.json"
    ]);

    const globalWithWindow = globalThis as typeof globalThis & {
      window?: Window & typeof globalThis;
    };
    const previousWindow = globalWithWindow.window;
    globalWithWindow.window = {
      localStorage: {
        getItem() {
          return JSON.stringify(["/tmp/a.graph.json", 1, "/tmp/b.graph.json"]);
        }
      }
    } as Window & typeof globalThis;

    try {
      expect(loadRecentGraphPaths()).toEqual(["/tmp/a.graph.json", "/tmp/b.graph.json"]);
    } finally {
      globalWithWindow.window = previousWindow;
    }
  });

  it("derives run inspector sections, graph canvas overlays, and merged event history from runtime artifacts", () => {
    const sections = buildRunInspectorSections(nodeDetail);
    const canvas = buildCompiledGraphCanvas(runSnapshot.compiled_graph, runSnapshot.overlay_nodes, ["active", "checks"]);
    const mergedEvents = mergeRunEvents(runSnapshot.recent_events, [
      runSnapshot.recent_events[0]!,
      {
        seq: 13,
        ts: "2025-04-02T00:02:30.000Z",
        type: "node.completed",
        run_id: "run-live",
        compiled_id: "root__repair-loop__apply-fix",
        authored_id: "apply-fix",
        execution_id: "root__repair-loop__apply-fix-i1-a1",
        node_label: "Apply Fix",
        summary: "exec node completed",
        payload: {
          outcome: "passed"
        }
      }
    ]);

    expect(sections.find((section) => section.title === "Artifacts")?.rows).toEqual(
      expect.arrayContaining([
        {
          label: "stdout.log",
          value: "stdout · 18 bytes"
        },
        {
          label: "patch.diff",
          value: "artifact · 42 bytes"
        }
      ])
    );
    expect(canvas.nodes.map((node) => node.id)).toEqual([
      "root__repair-loop__apply-fix",
      "root__repair-loop__verify-fix"
    ]);
    expect(canvas.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "edge-3",
          active: true
        })
      ])
    );
    expect(mergedEvents.map((event) => event.seq)).toEqual([13, 12, 11]);
  });

  it("renders direct component states for picker, inspector, and logs surfaces", () => {
    const launchpadMarkup = renderToStaticMarkup(
      <Launchpad
        surface="inspect"
        graph={inspection}
        graph_path={inspection.graph_path}
        launch_profile="default"
        workspace_backend="worktree"
        recent_graph_paths={["/tmp/agentflow/agentflow.graph.json"]}
        busy_action={null}
        picker_open
        onOpenPicker={() => undefined}
        onClosePicker={() => undefined}
        onConfirmPicker={() => undefined}
        onLaunchProfileChange={() => undefined}
        onWorkspaceBackendChange={() => undefined}
        onValidate={() => undefined}
        onCompile={() => undefined}
      />
    );
    const inspectorMarkup = renderToStaticMarkup(
      <InspectorPanel
        surface="run"
        detail={nodeDetail}
        logs={nodeLogs}
        selected_log_tab="artifacts"
        loading={false}
        error={null}
        timeline_panel_id="timeline-panel"
        logs_panel_id="logs-panel"
        onSelectExecution={() => undefined}
        onSelectLogTab={() => undefined}
        onSelectArtifact={() => undefined}
      />
    );
    const logsMarkup = renderToStaticMarkup(
      <LogsPanel
        surface="run"
        panel_id="logs-panel"
        node_label="Apply Fix"
        logs={nodeLogs}
        artifact={artifact}
        selected_tab="artifacts"
        selected_artifact_path="patch.diff"
        loading={false}
        error={null}
        onTabChange={() => undefined}
        onExecutionSelect={() => undefined}
        onArtifactSelect={() => undefined}
      />
    );

    expect(launchpadMarkup).toContain("Choose an authored graph path");
    expect(launchpadMarkup).toContain("Recent graph files");
    expect(inspectorMarkup).toContain("Runtime Overlay");
    expect(inspectorMarkup).toContain("Events");
    expect(logsMarkup).toContain("patch.diff");
    expect(logsMarkup).toContain("diff --git");
  });
});
