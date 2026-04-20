import { describe, expect, it } from "vitest";

import { collectRequiredScopes } from "../../src/auth/required_scopes.js";
import type { CompiledAgentNode, CompiledExecutableNode } from "../../src/graph/compiled.js";
import type { PluginCredentialDecl, ResolvedPlugin } from "../../src/plugins/workflows.js";

function droneCredential(): PluginCredentialDecl {
  return {
    scope: "reddit-drone",
    description: "Drone CI",
    fields: [{ key: "token", secret: true, required: true }],
    login: {
      type: "pat-paste",
      verify: {
        method: "GET",
        url: "https://drone.example.com/api/user",
        auth: { kind: "header", header_name: "Authorization", header_value_template: "Bearer {token}" },
        ok_when_status: 200
      }
    }
  };
}

function jiraCredential(): PluginCredentialDecl {
  return {
    scope: "reddit-jira",
    fields: [
      { key: "email", secret: false, required: true },
      { key: "token", secret: true, required: true }
    ],
    login: {
      type: "pat-paste",
      verify: {
        method: "GET",
        url: "https://example.atlassian.net/rest/api/3/myself",
        auth: { kind: "basic", username_template: "{email}", password_template: "{token}" },
        ok_when_status: 200
      }
    }
  };
}

function buildPlugin(): ResolvedPlugin {
  return {
    alias: "reddit",
    source: ".",
    ref: "HEAD",
    commit: "deadbeef",
    manifest_digest: "digest",
    root: "/tmp/plugins/reddit",
    manifest: {
      schema: "agentflow.plugin/1",
      id: "reddit",
      version: "0.1.0",
      workflows: {},
      tools: {
        "build-status": {
          executable: "scripts/build-status.sh",
          credentials: ["drone"]
        },
        "ticket-fetch": {
          executable: "scripts/ticket-fetch.sh",
          credentials: ["jira"]
        },
        "no-creds": {
          executable: "scripts/noop.sh"
        }
      },
      credentials: {
        drone: droneCredential(),
        jira: jiraCredential()
      }
    }
  };
}

function agentNode(
  compiledId: string,
  tools: CompiledAgentNode["tools"]
): CompiledExecutableNode {
  return {
    compiled_id: compiledId,
    authored_id: compiledId.split("__").pop()!,
    kind: "agent",
    repo: "main",
    deps: [],
    scope_stack: [],
    effective_policy: {} as CompiledAgentNode["effective_policy"],
    context: [],
    declared_artifacts: {},
    prompt: "do something",
    tools
  };
}

describe("collectRequiredScopes", () => {
  it("returns an empty list when no plugin tools are used", () => {
    const result = collectRequiredScopes({
      resolved_plugins: [buildPlugin()],
      compiled_graph: { nodes: [agentNode("root__draft", [])] }
    });
    expect(result).toEqual([]);
  });

  it("returns scopes for plugin tools that declare credentials", () => {
    const plugin = buildPlugin();
    const result = collectRequiredScopes({
      resolved_plugins: [plugin],
      compiled_graph: {
        nodes: [
          agentNode("root__build", [
            {
              callable_name: "reddit-build-status",
              executable_path: "/tmp/scripts/build-status.sh",
              args: [],
              config: {},
              source: {
                kind: "plugin",
                alias: "reddit",
                tool: "build-status",
                plugin_root: "/tmp/plugins/reddit",
                declared_at: "graph",
                declaration_path: "$.tools[0]"
              }
            }
          ])
        ]
      }
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.scope).toBe("reddit-drone");
    expect(result[0]?.fields).toEqual([{ key: "token", secret: true, required: true }]);
    expect(result[0]?.used_by).toEqual(["root__build (reddit-build-status)"]);
  });

  it("deduplicates scopes when multiple agents need the same credential", () => {
    const plugin = buildPlugin();
    const tool = {
      callable_name: "reddit-build-status",
      executable_path: "/tmp/scripts/build-status.sh",
      args: [],
      config: {},
      source: {
        kind: "plugin" as const,
        alias: "reddit",
        tool: "build-status",
        plugin_root: "/tmp/plugins/reddit",
        declared_at: "graph" as const,
        declaration_path: "$.tools[0]"
      }
    };

    const result = collectRequiredScopes({
      resolved_plugins: [plugin],
      compiled_graph: {
        nodes: [
          agentNode("root__draft", [tool]),
          agentNode("root__refine", [tool])
        ]
      }
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.used_by).toEqual([
      "root__draft (reddit-build-status)",
      "root__refine (reddit-build-status)"
    ]);
  });

  it("collects multiple distinct scopes sorted alphabetically", () => {
    const plugin = buildPlugin();
    const result = collectRequiredScopes({
      resolved_plugins: [plugin],
      compiled_graph: {
        nodes: [
          agentNode("root__build", [
            {
              callable_name: "reddit-build-status",
              executable_path: "/tmp/scripts/build-status.sh",
              args: [],
              config: {},
              source: {
                kind: "plugin",
                alias: "reddit",
                tool: "build-status",
                plugin_root: "/tmp/plugins/reddit",
                declared_at: "graph",
                declaration_path: "$.tools[0]"
              }
            }
          ]),
          agentNode("root__ticket", [
            {
              callable_name: "reddit-ticket-fetch",
              executable_path: "/tmp/scripts/ticket-fetch.sh",
              args: [],
              config: {},
              source: {
                kind: "plugin",
                alias: "reddit",
                tool: "ticket-fetch",
                plugin_root: "/tmp/plugins/reddit",
                declared_at: "graph",
                declaration_path: "$.tools[1]"
              }
            }
          ])
        ]
      }
    });

    expect(result.map((scope) => scope.scope)).toEqual(["reddit-drone", "reddit-jira"]);
  });

  it("ignores plugin tools that do not declare credentials", () => {
    const plugin = buildPlugin();
    const result = collectRequiredScopes({
      resolved_plugins: [plugin],
      compiled_graph: {
        nodes: [
          agentNode("root__draft", [
            {
              callable_name: "reddit-no-creds",
              executable_path: "/tmp/scripts/noop.sh",
              args: [],
              config: {},
              source: {
                kind: "plugin",
                alias: "reddit",
                tool: "no-creds",
                plugin_root: "/tmp/plugins/reddit",
                declared_at: "graph",
                declaration_path: "$.tools[0]"
              }
            }
          ])
        ]
      }
    });
    expect(result).toEqual([]);
  });
});
