import { writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";

import { compileAuthoredGraph } from "../../graph/compile.js";
import { buildManagedExpansionSummaries } from "../../graph/managed_expansion.js";
import { renderCompiledGraphMermaid } from "../../graph/mermaid.js";
import { resolveLaunchConfig } from "../../graph/profiles.js";
import { reviewCompiledGraph } from "../../graph/review.js";
import { workspaceBackends } from "../../graph/schema.js";
import { loadAuthoredGraphDocument, summarizeAuthoredGraph } from "../../graph/validate.js";
import { createCodexCliHarness } from "../../runtime/harness/codex_cli.js";
import { createCursorCliHarness } from "../../runtime/harness/cursor_cli.js";
import { evaluateGraphReadiness } from "../../runtime/readiness.js";
import {
  collectGraphConfigOverrides,
  createGraphCliInvocation,
  createGraphPathResolution,
  renderCommandUsageError
} from "../command_support.js";
import { collectReferencedRepoAliases, resolveRepoSources } from "../repo_sources.js";

export const validateCommand = {
  name: "validate",
  summary: "Validate and compile an authored graph without launching a run.",
  usage:
    "agentflow validate --graph <path/to/agentflow.graph.json> [--run-ready] [--show-compiled] [--review] [--strict-review] [--diagram] [--diagram-output <path>]",
  examples: [
    "agentflow validate --graph ./agentflow.graph.json",
    "agentflow validate --graph ./agentflow.graph.json --run-ready",
    "agentflow validate --graph ./agentflow.graph.json --show-compiled",
    "agentflow validate --graph ./agentflow.graph.json --review",
    "agentflow validate --graph ./agentflow.graph.json --diagram-output graph.mmd"
  ] as const,
  optionNames: [
    "graph",
    "run-ready",
    "show-compiled",
    "review",
    "strict-review",
    "diagram",
    "diagram-output",
    "config",
    "config-file",
    "help"
  ] as const,
  helpNotes: [
    "--graph validation resolves from the launch shell current working directory.",
    "--run-ready also checks local runtime dependencies such as git, node commands, and harness binaries.",
    "--show-compiled emits the full compiled graph payload alongside the summary.",
    "--review emits deeper authoring guidance; --strict-review fails when serious review findings are present.",
    "--diagram emits Mermaid for the compiled graph; --diagram-output writes the same Mermaid to a file.",
    "Use run when you want durable artifacts after validation passes.",
    "Use --config key=value (repeatable) and --config-file <path> to override top-level graph config; values like 1, true, [\"a\"] parse as JSON, others stay strings."
  ] as const,
  async run(
    options: Record<string, string | boolean | string[] | undefined>,
    currentWorkingDirectory: string
  ) {
    const graphPath = typeof options.graph === "string" ? options.graph : undefined;
    const runReady = options["run-ready"] === true;
    const showCompiled = options["show-compiled"] === true;
    const review = options.review === true;
    const strictReview = options["strict-review"] === true;
    const includeDiagram = options.diagram === true;
    const diagramOutput = typeof options["diagram-output"] === "string" ? options["diagram-output"] : undefined;

    if (!graphPath) {
      return {
        exitCode: 2,
        stdout: renderCommandUsageError({
          message: "Missing required option: --graph",
          commandName: this.name,
          usage: this.usage,
          includeGraphHelp: true
        })
      };
    }

    if (options["diagram-output"] === true || Array.isArray(options["diagram-output"])) {
      return {
        exitCode: 2,
        stdout: renderCommandUsageError({
          message: "Option --diagram-output requires a file path.",
          commandName: this.name,
          usage: this.usage,
          includeGraphHelp: true
        })
      };
    }

    const configCollection = await collectGraphConfigOverrides(options, currentWorkingDirectory);

    if (configCollection.diagnostics.length > 0) {
      return {
        exitCode: 2,
        output: {
          command: "validate",
          status: "failed",
          message: "Graph config overrides could not be parsed.",
          diagnostics: configCollection.diagnostics
        }
      };
    }

    const loaded = await loadAuthoredGraphDocument(currentWorkingDirectory, graphPath, {
      ...(configCollection.config_overrides
        ? { config_overrides: configCollection.config_overrides }
        : {})
    });
    const pathResolution = createGraphPathResolution(
      currentWorkingDirectory,
      graphPath,
      loaded.absolute_path
    );

    if (!loaded.document) {
      return {
        exitCode: 1,
        output: {
          command: "validate",
          status: "failed",
          message: "Graph could not be loaded or normalized from --graph.",
          graph_path: loaded.absolute_path,
          path_resolution: pathResolution,
          diagnostics: loaded.diagnostics,
          authored_validation: {
            status: "failed",
            diagnostics: loaded.diagnostics
          },
          next_steps: {
            graph_help: "agentflow graph-help"
          }
        }
      };
    }

    const launch = resolveLaunchConfig(loaded.document);

    if (launch.diagnostics.length > 0) {
      return {
        exitCode: 1,
        output: {
          command: "validate",
          status: "failed",
          message: "Launch settings could not be resolved from the graph for validation.",
          graph_path: loaded.absolute_path,
          path_resolution: pathResolution,
          diagnostics: launch.diagnostics,
          authored_validation: {
            status: "passed",
            diagnostics: []
          },
          compiled_validation: {
            status: "failed",
            diagnostics: launch.diagnostics
          },
          available_profiles: Object.keys(loaded.document.profiles ?? {}),
          supported_workspace_backends: workspaceBackends,
          next_steps: {
            graph_help: "agentflow graph-help",
            retry_validate: createGraphCliInvocation("validate", {
              graphPath: loaded.absolute_path
            })
          }
        }
      };
    }

    const compilation = compileAuthoredGraph(
      loaded.document,
      launch,
      loaded.lowered_managed_nodes,
      {
        ...(loaded.resolved_plugins ? { resolved_plugins: loaded.resolved_plugins } : {}),
        graph_dir: dirname(loaded.absolute_path)
      }
    );

    if (compilation.diagnostics.length > 0) {
      return {
        exitCode: 1,
        output: {
          command: "validate",
          status: "failed",
          message: "Graph validation reached compile-time diagnostics.",
          graph_path: loaded.absolute_path,
          path_resolution: pathResolution,
          diagnostics: compilation.diagnostics,
          authored_validation: {
            status: "passed",
            diagnostics: []
          },
          compiled_validation: {
            status: "failed",
            diagnostics: compilation.diagnostics,
            ...(compilation.compiled_graph
              ? {
                  compiled_summary: {
                    entry_node_count: compilation.compiled_graph.entry_node_ids.length,
                    node_count: compilation.compiled_graph.nodes.length,
                    edge_count: compilation.compiled_graph.edges.length,
                    scope_count: compilation.compiled_graph.scopes.length
                  },
                  managed_expansion: buildManagedExpansionSummaries(
                    compilation.compiled_graph,
                    loaded.lowered_managed_nodes
                  )
                }
              : {})
          },
          ...(compilation.compiled_graph
            ? {
                compiled_summary: {
                  entry_node_count: compilation.compiled_graph.entry_node_ids.length,
                  node_count: compilation.compiled_graph.nodes.length,
                  edge_count: compilation.compiled_graph.edges.length,
                  scope_count: compilation.compiled_graph.scopes.length
                },
                managed_expansion: buildManagedExpansionSummaries(
                  compilation.compiled_graph,
                  loaded.lowered_managed_nodes
                )
              }
            : {}),
          ...(showCompiled && compilation.compiled_graph
            ? { compiled_graph: compilation.compiled_graph }
            : {}),
          next_steps: {
            graph_help: "agentflow graph-help",
            retry_validate: createGraphCliInvocation("validate", {
              graphPath: loaded.absolute_path
            })
          }
        }
      };
    }

    const repoResolution = await resolveRepoSources(
      loaded.absolute_path,
      loaded.document,
      collectReferencedRepoAliases(compilation.compiled_graph!)
    );
    const readiness = await evaluateGraphReadiness({
      graph: compilation.compiled_graph!,
      repo_sources: repoResolution.repo_sources ?? {},
      repo_source_diagnostics: repoResolution.diagnostics,
      machine_checks: runReady,
      ...(runReady
        ? {
            harnesses: {
              "codex-cli": createCodexCliHarness(),
              "cursor-cli": createCursorCliHarness()
            }
          }
        : {})
    });
    const authoringReview = reviewCompiledGraph(loaded.document, compilation.compiled_graph!, {
      mode: strictReview ? "strict-review" : review ? "review" : "standard"
    });
    const strictReviewBlocked = strictReview && authoringReview.summary.serious_count > 0;
    const mermaidDiagram = includeDiagram || diagramOutput
      ? renderCompiledGraphMermaid(compilation.compiled_graph!)
      : undefined;
    const diagramOutputPath = diagramOutput
      ? resolvePath(currentWorkingDirectory, diagramOutput)
      : undefined;

    if (diagramOutputPath && mermaidDiagram) {
      await writeFile(diagramOutputPath, mermaidDiagram, "utf8");
    }

    const compiledValidation = {
      status: "passed",
      diagnostics: [] as Array<{ path: string; message: string }>,
      compiled_summary: {
        entry_node_count: compilation.compiled_graph!.entry_node_ids.length,
        node_count: compilation.compiled_graph!.nodes.length,
        edge_count: compilation.compiled_graph!.edges.length,
        scope_count: compilation.compiled_graph!.scopes.length
      },
      managed_expansion: buildManagedExpansionSummaries(
        compilation.compiled_graph!,
        loaded.lowered_managed_nodes
      )
    };

    return {
      exitCode: readiness.status === "blocked" || strictReviewBlocked ? 1 : 0,
      output: {
        command: "validate",
        status: readiness.status === "blocked" || strictReviewBlocked ? "failed" : "passed",
        message:
          readiness.status === "blocked"
            ? `Graph compiled, but readiness validation is blocked for launch profile "${launch.launch_profile}" and workspace backend "${launch.workspace_backend}".`
            : strictReviewBlocked
              ? `Graph compiled, but strict authoring review found ${authoringReview.summary.serious_count} serious finding(s) for launch profile "${launch.launch_profile}" and workspace backend "${launch.workspace_backend}".`
            : readiness.status === "warnings"
              ? `Graph validated with readiness warnings for launch profile "${launch.launch_profile}" and workspace backend "${launch.workspace_backend}".`
              : runReady
                ? `Graph validated and run-ready checks passed for launch profile "${launch.launch_profile}" and workspace backend "${launch.workspace_backend}".`
                : `Graph contract validated for launch profile "${launch.launch_profile}" and workspace backend "${launch.workspace_backend}".`,
        graph_path: loaded.absolute_path,
        path_resolution: pathResolution,
        authored_summary: summarizeAuthoredGraph(loaded.document),
        launch,
        readiness_mode: runReady ? "run-ready" : "declared",
        compiled_summary: compiledValidation.compiled_summary,
        managed_expansion: compiledValidation.managed_expansion,
        authoring_review: authoringReview,
        authored_validation: {
          status: "passed",
          diagnostics: []
        },
        compiled_validation: compiledValidation,
        readiness,
        ...(mermaidDiagram && includeDiagram
          ? {
              diagram: {
                format: "mermaid",
                graph: mermaidDiagram
              }
            }
          : {}),
        ...(diagramOutputPath
          ? {
              diagram_output_path: diagramOutputPath
            }
          : {}),
        ...(showCompiled
          ? {
              compiled_graph: compilation.compiled_graph!,
              lowered_managed_nodes: loaded.lowered_managed_nodes
            }
          : {}),
        next_steps: {
          run: createGraphCliInvocation("run", {
            graphPath: loaded.absolute_path
          }),
          graph_help: "agentflow graph-help"
        }
      }
    };
  }
};
