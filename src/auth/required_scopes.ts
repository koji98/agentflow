import type { CompiledGraph, ResolvedTool } from "../graph/compiled.js";
import type { PluginCredentialDecl, ResolvedPlugin } from "../plugins/workflows.js";

export interface RequiredScopeField {
  key: string;
  secret: boolean;
  required: boolean;
  default?: string;
}

export interface RequiredScope {
  scope: string;
  description?: string;
  fields: RequiredScopeField[];
  used_by: string[];
  decl: PluginCredentialDecl;
}

export interface CollectRequiredScopesArgs {
  resolved_plugins: ResolvedPlugin[];
  compiled_graph: Pick<CompiledGraph, "nodes">;
}

function pluginByAlias(plugins: ResolvedPlugin[]): Map<string, ResolvedPlugin> {
  const map = new Map<string, ResolvedPlugin>();
  for (const plugin of plugins) {
    map.set(plugin.alias, plugin);
  }
  return map;
}

function* iterPluginTools(
  graph: Pick<CompiledGraph, "nodes">
): Iterable<{ tool: ResolvedTool; node_id: string }> {
  for (const node of graph.nodes) {
    if (node.kind !== "agent") {
      continue;
    }
    for (const tool of node.tools) {
      if (tool.source.kind === "plugin") {
        yield { tool, node_id: node.compiled_id };
      }
    }
  }
}

export function collectRequiredScopes(args: CollectRequiredScopesArgs): RequiredScope[] {
  const plugins = pluginByAlias(args.resolved_plugins);
  const accumulator = new Map<string, RequiredScope>();

  for (const { tool, node_id } of iterPluginTools(args.compiled_graph)) {
    if (tool.source.kind !== "plugin") {
      continue;
    }
    const plugin = plugins.get(tool.source.alias);
    if (!plugin) {
      continue;
    }

    const exported = plugin.manifest.tools[tool.source.tool];
    if (!exported || !exported.credentials || exported.credentials.length === 0) {
      continue;
    }

    const credentialDecls = plugin.manifest.credentials ?? {};
    const usedBy = `${node_id} (${tool.callable_name})`;

    for (const credentialId of exported.credentials) {
      const decl = credentialDecls[credentialId];
      if (!decl) {
        continue;
      }
      const existing = accumulator.get(decl.scope);
      if (existing) {
        if (!existing.used_by.includes(usedBy)) {
          existing.used_by.push(usedBy);
        }
        continue;
      }
      accumulator.set(decl.scope, {
        scope: decl.scope,
        ...(decl.description ? { description: decl.description } : {}),
        fields: decl.fields.map((field) => ({
          key: field.key,
          secret: field.secret,
          required: field.required,
          ...(field.default !== undefined ? { default: field.default } : {})
        })),
        used_by: [usedBy],
        decl
      });
    }
  }

  return [...accumulator.values()].sort((a, b) => a.scope.localeCompare(b.scope));
}
