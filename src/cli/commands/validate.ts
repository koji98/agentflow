import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";

import { compileAuthoredGraph } from "../../graph/compile.js";
import { buildManagedExpansionSummaries } from "../../graph/managed_expansion.js";
import { renderCompiledGraphMermaid } from "../../graph/mermaid.js";
import { resolveLaunchConfig } from "../../graph/profiles.js";
import { reviewCompiledGraph } from "../../graph/review.js";
import { workspaceBackends } from "../../graph/schema.js";
import { loadAuthoredGraphDocument, summarizeAuthoredGraph } from "../../graph/validate.js";
import {
  analyzeGraphContext,
  renderContextAnalysisMarkdown,
  type ContextAnalysisReport
} from "../../runtime/context/analyze.js";
import { createCodexCliHarness } from "../../runtime/harness/codex_cli.js";
import { createCursorCliHarness } from "../../runtime/harness/cursor_cli.js";
import { evaluateGraphReadiness, type GraphReadinessResult } from "../../runtime/readiness.js";
import {
  collectGraphConfigOverrides,
  createGraphCliInvocation,
  createGraphPathResolution,
  renderCommandUsageError
} from "../command_support.js";
import { collectReferencedRepoAliases, resolveRepoSources } from "../repo_sources.js";

const execFileAsync = promisify(execFile);
type MermaidImageRenderer = "npx" | "mmdc";
type ValidateFormat = "json" | "summary";

const mermaidRendererEnvironmentVariable = "AGENTFLOW_MERMAID_RENDERER";
const mermaidCliEnvironmentVariable = "AGENTFLOW_MERMAID_CLI_BIN";
const mermaidNpxPackageEnvironmentVariable = "AGENTFLOW_MERMAID_NPX_PACKAGE";
const defaultMermaidImageRenderer: MermaidImageRenderer = "npx";
const defaultMermaidCliBinary = "mmdc";
const defaultMermaidNpxPackage = "@mermaid-js/mermaid-cli";
const mermaidCliTimeoutMs = 120_000;

interface MermaidCliError extends Error {
  code?: string | number;
  signal?: string;
  stdout?: string;
  stderr?: string;
}

interface ValidationFinding {
  source: "authored" | "launch" | "compiled" | "authoring_review" | "readiness" | "context";
  severity: "blocker" | "warning" | "advice" | "serious";
  kind: string;
  message: string;
  path?: string;
  target?: string;
  node_id?: string;
  recommendation?: string;
}

interface ValidationFindings {
  blockers: ValidationFinding[];
  warnings: ValidationFinding[];
  advice: ValidationFinding[];
}

function readMermaidCliBinary(): string {
  const configured = process.env[mermaidCliEnvironmentVariable]?.trim();
  return configured && configured.length > 0 ? configured : defaultMermaidCliBinary;
}

function readMermaidNpxPackage(input?: string): string {
  const configured = input?.trim() || process.env[mermaidNpxPackageEnvironmentVariable]?.trim();
  return configured && configured.length > 0 ? configured : defaultMermaidNpxPackage;
}

function readMermaidImageRenderer(input?: string): MermaidImageRenderer {
  const configured = input?.trim() || process.env[mermaidRendererEnvironmentVariable]?.trim();
  if (!configured) {
    return defaultMermaidImageRenderer;
  }

  if (configured === "npx" || configured === "mmdc") {
    return configured;
  }

  throw new Error('Expected --diagram-image-renderer to be "npx" or "mmdc".');
}

function readValidateFormat(input?: string): ValidateFormat {
  if (!input || input === "json") {
    return "json";
  }
  if (input === "summary") {
    return "summary";
  }

  throw new Error('Expected --format to be "json" or "summary".');
}

function describeMermaidCliError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cliError = error as MermaidCliError;
  const details = [
    cliError.stderr?.trim(),
    cliError.stdout?.trim(),
    cliError.signal ? `signal ${cliError.signal}` : undefined,
    cliError.code !== undefined ? `code ${cliError.code}` : undefined,
    error.message
  ].find((entry) => entry && entry.length > 0);

  return details ?? error.message;
}

async function exportMermaidDiagramImage(options: {
  mermaid: string;
  outputPath: string;
  renderer: MermaidImageRenderer;
  npxPackage: string;
}): Promise<{
  renderer: MermaidImageRenderer;
  cli_binary?: string;
  npx_package?: string;
  output_path: string;
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "agentflow-mermaid-"));
  const inputPath = join(tempDir, "compiled-graph.mmd");

  try {
    await writeFile(inputPath, options.mermaid, "utf8");
    const command = options.renderer === "npx"
      ? process.platform === "win32" ? "npx.cmd" : "npx"
      : readMermaidCliBinary();
    const args = options.renderer === "npx"
      ? ["-y", options.npxPackage, "-i", inputPath, "-o", options.outputPath]
      : ["-i", inputPath, "-o", options.outputPath];

    await execFileAsync(command, args, {
      cwd: dirname(options.outputPath),
      timeout: mermaidCliTimeoutMs,
      maxBuffer: 10 * 1024 * 1024
    });
  } catch (error) {
    const rendererDescription = options.renderer === "npx"
      ? `npx -y ${options.npxPackage}`
      : readMermaidCliBinary();
    throw new Error(
      `Mermaid image export failed using "${rendererDescription}". Use --diagram-image-renderer npx to download a package on demand, --diagram-image-package to choose the npx package, or --diagram-image-renderer mmdc with ${mermaidCliEnvironmentVariable}. ${describeMermaidCliError(error)}`
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  return {
    renderer: options.renderer,
    ...(options.renderer === "npx"
      ? { npx_package: options.npxPackage }
      : { cli_binary: readMermaidCliBinary() }),
    output_path: options.outputPath
  };
}

function diagnosticFindings(
  source: ValidationFinding["source"],
  diagnostics: Array<{ path?: string; message: string }>
): ValidationFindings {
  return {
    blockers: diagnostics.map((diagnostic) => ({
      source,
      severity: "blocker",
      kind: "diagnostic",
      message: diagnostic.message,
      ...(diagnostic.path ? { path: diagnostic.path } : {})
    })),
    warnings: [],
    advice: []
  };
}

function buildValidationFindings(options: {
  strict: boolean;
  authoringReview: ReturnType<typeof reviewCompiledGraph>;
  readiness: GraphReadinessResult;
  context: ContextAnalysisReport;
}): ValidationFindings {
  const blockers: ValidationFinding[] = [];
  const warnings: ValidationFinding[] = [];
  const advice: ValidationFinding[] = [];

  for (const check of options.readiness.checks) {
    if (check.status === "blocked") {
      blockers.push({
        source: "readiness",
        severity: "blocker",
        kind: check.kind,
        target: check.target,
        message: check.message
      });
    } else if (check.status === "warning") {
      warnings.push({
        source: "readiness",
        severity: "warning",
        kind: check.kind,
        target: check.target,
        message: check.message
      });
    }
  }

  for (const diagnostic of options.context.diagnostics) {
    const finding: ValidationFinding = {
      source: "context",
      severity: diagnostic.severity === "error" ? "blocker" : "warning",
      kind: "context",
      path: diagnostic.path,
      target: diagnostic.compiled_id,
      node_id: diagnostic.authored_id,
      message: diagnostic.message
    };
    if (diagnostic.severity === "error") {
      blockers.push(finding);
    } else {
      warnings.push(finding);
    }
  }

  for (const finding of options.authoringReview.findings) {
    const validationFinding: ValidationFinding = {
      source: "authoring_review",
      severity: finding.severity === "serious" ? "serious" : finding.severity === "warning" ? "warning" : "advice",
      kind: finding.category,
      message: finding.message,
      recommendation: finding.recommendation,
      ...(finding.path ? { path: finding.path } : {}),
      ...(finding.node_id ? { node_id: finding.node_id } : {}),
      ...(finding.compiled_id ? { target: finding.compiled_id } : {})
    };

    if (options.strict && finding.severity === "serious") {
      blockers.push({ ...validationFinding, severity: "blocker" });
    } else if (finding.severity === "info") {
      advice.push(validationFinding);
    } else {
      warnings.push(validationFinding);
    }
  }

  return { blockers, warnings, advice };
}

function renderReadinessMarkdown(readiness: GraphReadinessResult): string {
  return `${[
    "# Readiness",
    "",
    `- Status: \`${readiness.status}\``,
    `- Passed: \`${readiness.passed_count}\``,
    `- Warnings: \`${readiness.warning_count}\``,
    `- Blocked: \`${readiness.blocked_count}\``,
    "",
    "## Checks",
    ...readiness.checks.map((check) => [
      "",
      `### ${check.kind}: ${check.target}`,
      "",
      `- Status: \`${check.status}\``,
      `- Required: \`${check.required}\``,
      `- Message: ${check.message}`
    ].join("\n"))
  ].join("\n")}\n`;
}

function renderAuthoringReviewMarkdown(review: ReturnType<typeof reviewCompiledGraph>): string {
  const lines = [
    "# Authoring Review",
    "",
    `- Status: \`${review.status}\``,
    `- Mode: \`${review.mode}\``,
    `- Findings: \`${review.summary.finding_count}\``,
    `- Serious: \`${review.summary.serious_count}\``,
    `- Warnings: \`${review.summary.warning_count}\``,
    "",
    "## Findings"
  ];

  if (review.findings.length === 0) {
    lines.push("", "No authoring review findings.");
  } else {
    review.findings.forEach((finding, index) => {
      lines.push(
        "",
        `### ${index + 1}. ${finding.category}`,
        "",
        `- Severity: \`${finding.severity}\``,
        ...(finding.node_id ? [`- Node: \`${finding.node_id}\``] : []),
        ...(finding.path ? [`- Path: \`${finding.path}\``] : []),
        `- Message: ${finding.message}`,
        `- Recommendation: ${finding.recommendation}`
      );
    });
  }

  return `${lines.join("\n")}\n`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeValidationPackage(options: {
  outputDir: string;
  validation: Record<string, unknown>;
  compiledGraph: unknown;
  mermaid: string;
  authoredSummary: unknown;
  compiledSummary: unknown;
  managedExpansion: unknown;
  authoringReview: ReturnType<typeof reviewCompiledGraph>;
  readiness: GraphReadinessResult;
  context: ContextAnalysisReport;
}): Promise<{ output_dir: string; files: string[] }> {
  await mkdir(options.outputDir, { recursive: true });
  const files: string[] = [];
  const writePackageJson = async (filename: string, value: unknown) => {
    const path = resolvePath(options.outputDir, filename);
    await writeJson(path, value);
    files.push(path);
  };
  const writePackageText = async (filename: string, value: string) => {
    const path = resolvePath(options.outputDir, filename);
    await writeFile(path, value, "utf8");
    files.push(path);
  };

  await writePackageJson("validation.json", options.validation);
  await writePackageJson("authored-summary.json", options.authoredSummary);
  await writePackageJson("compiled-summary.json", options.compiledSummary);
  await writePackageJson("managed-expansion.json", options.managedExpansion);
  await writePackageJson("compiled-graph.json", options.compiledGraph);
  await writePackageText("compiled-graph.mmd", options.mermaid);
  await writePackageJson("authoring-review.json", options.authoringReview);
  await writePackageText("authoring-review.md", renderAuthoringReviewMarkdown(options.authoringReview));
  await writePackageJson("readiness.json", options.readiness);
  await writePackageText("readiness.md", renderReadinessMarkdown(options.readiness));
  await writePackageJson("context-analysis.json", options.context);
  await writePackageText("context-analysis.md", renderContextAnalysisMarkdown(options.context));

  const manifestPath = resolvePath(options.outputDir, "manifest.json");
  const manifest = {
    command: "validate",
    status: options.validation.status,
    graph_path: options.validation.graph_path,
    validation_level: options.validation.validation_level,
    files
  };
  await writeJson(manifestPath, manifest);

  return {
    output_dir: options.outputDir,
    files: [manifestPath, ...files]
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderValidateSummary(output: Record<string, unknown>): string {
  const status = typeof output.status === "string" ? output.status : "unknown";
  const message = typeof output.message === "string" ? output.message.trim() : undefined;
  const graphPath = typeof output.graph_path === "string" ? output.graph_path : undefined;
  const launch = isRecord(output.launch) ? output.launch : undefined;
  const launchProfile = typeof launch?.launch_profile === "string" ? launch.launch_profile : undefined;
  const workspaceBackend = typeof launch?.workspace_backend === "string" ? launch.workspace_backend : undefined;
  const compiledSummary = isRecord(output.compiled_summary) ? output.compiled_summary : undefined;
  const nodeCount = typeof compiledSummary?.node_count === "number" ? compiledSummary.node_count : undefined;
  const edgeCount = typeof compiledSummary?.edge_count === "number" ? compiledSummary.edge_count : undefined;
  const checks = isRecord(output.checks) ? output.checks : {};
  const readiness = isRecord(checks.readiness) ? checks.readiness : undefined;
  const context = isRecord(checks.context) ? checks.context : undefined;
  const review = isRecord(checks.authoring_review) ? checks.authoring_review : undefined;
  const reviewSummary = isRecord(review?.summary) ? review.summary : undefined;
  const findings = isRecord(output.findings) ? output.findings : undefined;
  const blockers = Array.isArray(findings?.blockers) ? findings.blockers : [];
  const warnings = Array.isArray(findings?.warnings) ? findings.warnings : [];
  const nextSteps = isRecord(output.next_steps) ? output.next_steps : undefined;
  const runStep = typeof nextSteps?.run === "string" ? nextSteps.run : undefined;

  return [
    status === "passed" ? "Graph validated and run-ready." : "Graph validation failed.",
    ...(message && status !== "passed" ? [`Message: ${message}`] : []),
    ...(graphPath ? [`Graph: ${graphPath}`] : []),
    ...(launchProfile || workspaceBackend
      ? [`Launch: ${launchProfile ?? "unknown"} · workspace: ${workspaceBackend ?? "unknown"}`]
      : []),
    ...(nodeCount !== undefined || edgeCount !== undefined
      ? [`Compiled: ${nodeCount ?? "?"} nodes · ${edgeCount ?? "?"} edges`]
      : []),
    ...(readiness
      ? [`Readiness: ${String(readiness.status ?? "unknown")} (${String(readiness.passed_count ?? 0)} passed, ${String(readiness.warning_count ?? 0)} warnings, ${String(readiness.blocked_count ?? 0)} blocked)`]
      : []),
    ...(context ? [`Context: ${String(context.status ?? "unknown")}`] : []),
    ...(review && reviewSummary
      ? [`Authoring review: ${String(review.status ?? "unknown")} (${String(reviewSummary.serious_count ?? 0)} serious, ${String(reviewSummary.warning_count ?? 0)} warnings; mode: ${String(review.mode ?? "review")})`]
      : []),
    ...(blockers.length > 0 || warnings.length > 0
      ? [
          "Issues:",
          ...[...blockers, ...warnings].slice(0, 8).map((finding) => {
            if (!isRecord(finding)) {
              return `- ${String(finding)}`;
            }
            return `- ${String(finding.severity ?? "warning")} ${String(finding.source ?? "validate")} ${String(finding.target ?? finding.node_id ?? finding.path ?? "")}: ${String(finding.message ?? "")}`;
          })
        ]
      : []),
    ...(runStep && status === "passed" ? [`Run: ${runStep}`] : [])
  ].join("\n");
}

function buildCompiledSummary(compiledGraph: NonNullable<ReturnType<typeof compileAuthoredGraph>["compiled_graph"]>) {
  return {
    entry_node_count: compiledGraph.entry_node_ids.length,
    node_count: compiledGraph.nodes.length,
    edge_count: compiledGraph.edges.length,
    scope_count: compiledGraph.scopes.length
  };
}

export const validateCommand = {
  name: "validate",
  summary: "Validate launch readiness for an authored graph without launching a run.",
  usage:
    "agentflow validate --graph <path/to/agentflow.graph.json> [--strict] [--format json|summary] [--show-compiled] [--output-dir <path>] [--diagram-output <path>] [--diagram-image-output <path>] [--diagram-image-renderer <npx|mmdc>] [--diagram-image-package <package>]",
  examples: [
    "agentflow validate --graph ./agentflow.graph.json",
    "agentflow validate --graph ./agentflow.graph.json --strict",
    "agentflow validate --graph ./agentflow.graph.json --format summary",
    "agentflow validate --graph ./agentflow.graph.json --show-compiled",
    "agentflow validate --graph ./agentflow.graph.json --output-dir .agentflow/validation/latest",
    "agentflow validate --graph ./agentflow.graph.json --diagram-output graph.mmd",
    "agentflow validate --graph ./agentflow.graph.json --diagram-image-output graph.svg",
    "agentflow validate --graph ./agentflow.graph.json --diagram-image-output graph.svg --diagram-image-package @mermaid-js/mermaid-cli@latest"
  ] as const,
  optionNames: [
    "graph",
    "strict",
    "format",
    "show-compiled",
    "output-dir",
    "diagram-output",
    "diagram-image-output",
    "diagram-image-renderer",
    "diagram-image-package",
    "config",
    "config-file",
    "help"
  ] as const,
  helpNotes: [
    "--graph validation resolves from the launch shell current working directory.",
    "Default validate runs every cheap local non-mutating launch readiness check, including context analysis and plugin tool help.",
    "--strict fails when serious authoring review findings are present.",
    "--format summary prints the same validation result as a compact text report; JSON is the default.",
    "--show-compiled emits the full compiled graph payload alongside the summary.",
    "--output-dir writes a validation package with compiled graph, Mermaid, review, readiness, and context analysis files.",
    "--diagram-output writes Mermaid for the compiled graph to a file.",
    `--diagram-image-output renders through npx by default using ${defaultMermaidNpxPackage}; use --diagram-image-package to choose a package.`,
    `--diagram-image-renderer mmdc uses a local ${defaultMermaidCliBinary} binary instead; set ${mermaidCliEnvironmentVariable} to override the binary.`,
    "Use run when validation passes and you want durable run artifacts.",
    "Use --config key=value (repeatable) and --config-file <path> to override top-level graph config; values like 1, true, [\"a\"] parse as JSON, others stay strings."
  ] as const,
  async run(
    options: Record<string, string | boolean | string[] | undefined>,
    currentWorkingDirectory: string
  ) {
    const graphPath = typeof options.graph === "string" ? options.graph : undefined;
    const strict = options.strict === true;
    const showCompiled = options["show-compiled"] === true;
    const outputDir = typeof options["output-dir"] === "string"
      ? resolvePath(currentWorkingDirectory, options["output-dir"])
      : undefined;
    const diagramOutput = typeof options["diagram-output"] === "string" ? options["diagram-output"] : undefined;
    const diagramImageOutput = typeof options["diagram-image-output"] === "string"
      ? options["diagram-image-output"]
      : undefined;
    const diagramImageRendererInput = typeof options["diagram-image-renderer"] === "string"
      ? options["diagram-image-renderer"]
      : undefined;
    const diagramImagePackage = typeof options["diagram-image-package"] === "string"
      ? readMermaidNpxPackage(options["diagram-image-package"])
      : readMermaidNpxPackage();
    const formatInput = typeof options.format === "string" ? options.format : undefined;

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

    if (options.strict !== undefined && options.strict !== true) {
      return {
        exitCode: 2,
        stdout: renderCommandUsageError({
          message: "Option --strict does not take a value.",
          commandName: this.name,
          usage: this.usage,
          includeGraphHelp: true
        })
      };
    }

    if (options.format === true || Array.isArray(options.format)) {
      return {
        exitCode: 2,
        stdout: renderCommandUsageError({
          message: "Option --format requires json or summary.",
          commandName: this.name,
          usage: this.usage,
          includeGraphHelp: true
        })
      };
    }

    let format: ValidateFormat;
    try {
      format = readValidateFormat(formatInput);
    } catch (error) {
      return {
        exitCode: 2,
        stdout: renderCommandUsageError({
          message: error instanceof Error ? error.message : String(error),
          commandName: this.name,
          usage: this.usage,
          includeGraphHelp: true
        })
      };
    }

    if (options["output-dir"] === true || Array.isArray(options["output-dir"])) {
      return {
        exitCode: 2,
        stdout: renderCommandUsageError({
          message: "Option --output-dir requires a directory path.",
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

    if (options["diagram-image-output"] === true || Array.isArray(options["diagram-image-output"])) {
      return {
        exitCode: 2,
        stdout: renderCommandUsageError({
          message: "Option --diagram-image-output requires a file path.",
          commandName: this.name,
          usage: this.usage,
          includeGraphHelp: true
        })
      };
    }

    if (options["diagram-image-renderer"] === true || Array.isArray(options["diagram-image-renderer"])) {
      return {
        exitCode: 2,
        stdout: renderCommandUsageError({
          message: "Option --diagram-image-renderer requires npx or mmdc.",
          commandName: this.name,
          usage: this.usage,
          includeGraphHelp: true
        })
      };
    }

    if (options["diagram-image-package"] === true || Array.isArray(options["diagram-image-package"])) {
      return {
        exitCode: 2,
        stdout: renderCommandUsageError({
          message: "Option --diagram-image-package requires an npm package spec.",
          commandName: this.name,
          usage: this.usage,
          includeGraphHelp: true
        })
      };
    }

    let diagramImageRenderer: MermaidImageRenderer;
    try {
      diagramImageRenderer = readMermaidImageRenderer(diagramImageRendererInput);
    } catch (error) {
      return {
        exitCode: 2,
        stdout: renderCommandUsageError({
          message: error instanceof Error ? error.message : String(error),
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
          validation_level: "run-ready",
          message: "Graph config overrides could not be parsed.",
          findings: diagnosticFindings("authored", configCollection.diagnostics),
          checks: {
            authored: {
              status: "failed",
              diagnostics: configCollection.diagnostics
            }
          }
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
          validation_level: "run-ready",
          message: "Graph could not be loaded or normalized from --graph.",
          graph_path: loaded.absolute_path,
          path_resolution: pathResolution,
          findings: diagnosticFindings("authored", loaded.diagnostics),
          checks: {
            authored: {
              status: "failed",
              diagnostics: loaded.diagnostics
            }
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
          validation_level: "run-ready",
          message: "Launch settings could not be resolved from the graph for validation.",
          graph_path: loaded.absolute_path,
          path_resolution: pathResolution,
          authored_summary: summarizeAuthoredGraph(loaded.document),
          findings: diagnosticFindings("launch", launch.diagnostics),
          checks: {
            authored: {
              status: "passed",
              diagnostics: []
            },
            launch: {
              status: "failed",
              diagnostics: launch.diagnostics
            }
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
        ...(loaded.resolved_skill_sources ? { resolved_skill_sources: loaded.resolved_skill_sources } : {}),
        graph_dir: dirname(loaded.absolute_path)
      }
    );

    if (compilation.diagnostics.length > 0) {
      const compiledSummary = compilation.compiled_graph
        ? buildCompiledSummary(compilation.compiled_graph)
        : undefined;
      const managedExpansion = compilation.compiled_graph
        ? buildManagedExpansionSummaries(compilation.compiled_graph, loaded.lowered_managed_nodes)
        : undefined;

      return {
        exitCode: 1,
        output: {
          command: "validate",
          status: "failed",
          validation_level: "run-ready",
          message: "Graph validation reached compile-time diagnostics.",
          graph_path: loaded.absolute_path,
          path_resolution: pathResolution,
          authored_summary: summarizeAuthoredGraph(loaded.document),
          launch,
          findings: diagnosticFindings("compiled", compilation.diagnostics),
          checks: {
            authored: {
              status: "passed",
              diagnostics: []
            },
            launch: {
              status: "passed",
              launch
            },
            compiled: {
              status: "failed",
              diagnostics: compilation.diagnostics,
              ...(compiledSummary ? { compiled_summary: compiledSummary } : {}),
              ...(managedExpansion ? { managed_expansion: managedExpansion } : {})
            }
          },
          ...(compiledSummary ? { compiled_summary: compiledSummary } : {}),
          ...(managedExpansion ? { managed_expansion: managedExpansion } : {}),
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

    const compiledGraph = compilation.compiled_graph!;
    const repoResolution = await resolveRepoSources(
      loaded.absolute_path,
      loaded.document,
      collectReferencedRepoAliases(compiledGraph)
    );
    const readiness = await evaluateGraphReadiness({
      graph: compiledGraph,
      repo_sources: repoResolution.repo_sources ?? {},
      repo_source_diagnostics: repoResolution.diagnostics,
      machine_checks: true,
      harnesses: {
        "codex-cli": createCodexCliHarness(
          process.env.AGENTFLOW_CODEX_CLI_BIN ? { binary: process.env.AGENTFLOW_CODEX_CLI_BIN } : {}
        ),
        "cursor-cli": createCursorCliHarness(
          process.env.AGENTFLOW_CURSOR_CLI_BIN ? { binary: process.env.AGENTFLOW_CURSOR_CLI_BIN } : {}
        )
      }
    });
    const contextAnalysis = await analyzeGraphContext({
      graph: compiledGraph,
      repo_workspaces: repoResolution.repo_sources ?? {}
    });
    const authoringReview = reviewCompiledGraph(loaded.document, compiledGraph, {
      mode: strict ? "strict" : "review"
    });
    const strictAuthoringBlocked = strict && authoringReview.summary.serious_count > 0;
    const mermaidDiagram = diagramOutput || diagramImageOutput || outputDir
      ? renderCompiledGraphMermaid(compiledGraph)
      : undefined;
    const diagramOutputPath = diagramOutput
      ? resolvePath(currentWorkingDirectory, diagramOutput)
      : undefined;
    const diagramImageOutputPath = diagramImageOutput
      ? resolvePath(currentWorkingDirectory, diagramImageOutput)
      : undefined;

    if (diagramOutputPath && mermaidDiagram) {
      await writeFile(diagramOutputPath, mermaidDiagram, "utf8");
    }

    const compiledValidation = {
      status: "passed",
      diagnostics: [] as Array<{ path: string; message: string }>,
      compiled_summary: buildCompiledSummary(compiledGraph),
      managed_expansion: buildManagedExpansionSummaries(compiledGraph, loaded.lowered_managed_nodes)
    };
    const findings = buildValidationFindings({
      strict,
      authoringReview,
      readiness,
      context: contextAnalysis
    });
    const statusFailed = readiness.status === "blocked" || strictAuthoringBlocked;
    const checks = {
      authored: {
        status: "passed",
        diagnostics: [] as Array<{ path: string; message: string }>
      },
      launch: {
        status: "passed",
        launch
      },
      compiled: compiledValidation,
      authoring_review: authoringReview,
      readiness,
      context: contextAnalysis
    };

    let diagramImageExport: Awaited<ReturnType<typeof exportMermaidDiagramImage>> | undefined;
    if (diagramImageOutputPath && mermaidDiagram) {
      try {
        diagramImageExport = await exportMermaidDiagramImage({
          mermaid: mermaidDiagram,
          outputPath: diagramImageOutputPath,
          renderer: diagramImageRenderer,
          npxPackage: diagramImagePackage
        });
      } catch (error) {
        return {
          exitCode: 1,
          output: {
            command: "validate",
            status: "failed",
            validation_level: "run-ready",
            message: error instanceof Error ? error.message : String(error),
            graph_path: loaded.absolute_path,
            path_resolution: pathResolution,
            authored_summary: summarizeAuthoredGraph(loaded.document),
            launch,
            findings,
            checks
          }
        };
      }
    }

    const exports: Record<string, unknown> = {};
    if (diagramOutputPath) {
      exports.diagram_output_path = diagramOutputPath;
    }
    if (diagramImageExport) {
      exports.diagram_image_output_path = diagramImageExport.output_path;
      exports.diagram_image_renderer = {
        renderer: diagramImageExport.renderer,
        ...(diagramImageExport.cli_binary ? { cli_binary: diagramImageExport.cli_binary } : {}),
        ...(diagramImageExport.npx_package ? { npx_package: diagramImageExport.npx_package } : {})
      };
    }

    const output: Record<string, unknown> = {
      command: "validate",
      status: statusFailed ? "failed" : "passed",
      validation_level: "run-ready",
      message:
        readiness.status === "blocked"
            ? `Graph compiled, but readiness validation is blocked for launch profile "${launch.launch_profile}" and workspace backend "${launch.workspace_backend}".`
            : strictAuthoringBlocked
              ? `Graph compiled, but strict authoring review found ${authoringReview.summary.serious_count} serious finding(s) for launch profile "${launch.launch_profile}" and workspace backend "${launch.workspace_backend}".`
              : findings.warnings.length > 0
                ? `Graph validated with warnings for launch profile "${launch.launch_profile}" and workspace backend "${launch.workspace_backend}".`
                : `Graph validated and run-ready checks passed for launch profile "${launch.launch_profile}" and workspace backend "${launch.workspace_backend}".`,
      graph_path: loaded.absolute_path,
      path_resolution: pathResolution,
      authored_summary: summarizeAuthoredGraph(loaded.document),
      launch,
      compiled_summary: compiledValidation.compiled_summary,
      managed_expansion: compiledValidation.managed_expansion,
      findings,
      checks,
      next_steps: {
        run: createGraphCliInvocation("run", {
          graphPath: loaded.absolute_path
        }),
        graph_help: "agentflow graph-help"
      }
    };

    if (showCompiled) {
      output.compiled_graph = compiledGraph;
      output.lowered_managed_nodes = loaded.lowered_managed_nodes;
    }

    if (outputDir) {
      exports.output_dir = outputDir;
      const packageExport = await writeValidationPackage({
        outputDir,
        validation: {
          ...output,
          exports: {
            ...exports,
            output_dir: outputDir
          }
        },
        compiledGraph,
        mermaid: mermaidDiagram ?? renderCompiledGraphMermaid(compiledGraph),
        authoredSummary: output.authored_summary,
        compiledSummary: compiledValidation.compiled_summary,
        managedExpansion: compiledValidation.managed_expansion,
        authoringReview,
        readiness,
        context: contextAnalysis
      });
      exports.files = packageExport.files;
    }

    if (Object.keys(exports).length > 0) {
      output.exports = exports;
    }

    return {
      exitCode: statusFailed ? 1 : 0,
      output,
      ...(format === "summary" ? { stdout: renderValidateSummary(output) } : {})
    };
  }
};
