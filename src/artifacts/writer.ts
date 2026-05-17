import { access, appendFile, copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { resolveSubpathWithinRoot } from "../path_rules.js";
import type { ArtifactDefinition, AuthoredGraphDocument } from "../graph/authored.js";
import type { CompiledExecutableNode, CompiledGraph } from "../graph/compiled.js";
import type { GraphDiagnostic } from "../graph/schema.js";
import {
  type ExecutionDirectoryOptions,
  type NodeArtifactDirectoryOptions,
  resolveExecutionArtifactsDirectory,
  resolveExecutionHumanDebugHarnessDirectory,
  resolveExecutionRuntimeDirectory,
  resolveExecutionRuntimeResultPath,
  resolveNodeExecutionDirectory,
  resolveRunArtifactPaths
} from "./paths.js";
import type { RuntimeNodeAttempt } from "../runtime/attempts.js";
import type { RuntimeEventEnvelope } from "../runtime/events.js";
import type {
  ExecutionManifest,
  RuntimeStateSnapshot,
  WorkspaceBinding
} from "../runtime/session.js";
import type { RunOwnerRecord } from "./owner.js";
import type { SupervisorDecision, SupervisorInterventionRecord } from "../supervisor/types.js";

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function writeText(filePath: string, contents: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
}

function executionRuntimePaths(executionDir: string): {
  execution_json_path: string;
  stdout_log_path: string;
  stderr_log_path: string;
  result_path: string;
} {
  return {
    execution_json_path: join(resolveExecutionRuntimeDirectory(executionDir), "execution.json"),
    stdout_log_path: join(resolveExecutionHumanDebugHarnessDirectory(executionDir), "stdout.log"),
    stderr_log_path: join(resolveExecutionHumanDebugHarnessDirectory(executionDir), "stderr.log"),
    result_path: resolveExecutionRuntimeResultPath(executionDir)
  };
}

export class ArtifactWriter {
  readonly run_root: string;
  readonly paths: ReturnType<typeof resolveRunArtifactPaths>;
  private readonly node_directory_options: Map<string, NodeArtifactDirectoryOptions>;

  constructor(runRoot: string, graph?: Pick<CompiledGraph, "nodes">) {
    this.run_root = runRoot;
    this.paths = resolveRunArtifactPaths(runRoot);
    this.node_directory_options = new Map(
      graph?.nodes.map((node, nodeIndex) => [
        node.compiled_id,
        {
          nodeIndex,
          nodeCount: graph.nodes.length,
          label: node.label ?? node.authored_id
        } satisfies NodeArtifactDirectoryOptions
      ]) ?? []
    );
  }

  async writeRunRecord(options: {
    run_id: string;
    graph_id: string;
    launch_profile: string;
    workspace_backend: ExecutionManifest["workspace_backend"];
    graph_path?: string;
    status: RuntimeStateSnapshot["status"];
    started_at: string;
    ended_at?: string;
  } & RunOwnerRecord): Promise<void> {
    await writeJson(this.paths.run_file, {
      run_id: options.run_id,
      graph_id: options.graph_id,
      launch_profile: options.launch_profile,
      workspace_backend: options.workspace_backend,
      ...(options.graph_path ? { graph_path: options.graph_path } : {}),
      status: options.status,
      started_at: options.started_at,
      ...(options.ended_at ? { ended_at: options.ended_at } : {}),
      ...(options.owner_pid !== undefined ? { owner_pid: options.owner_pid } : {}),
      ...(options.owner_started_at ? { owner_started_at: options.owner_started_at } : {}),
      ...(options.owner_hostname ? { owner_hostname: options.owner_hostname } : {})
    });
  }

  async initializeRunArtifacts(options: {
    run_id: string;
    graph: CompiledGraph;
    authored_graph?: AuthoredGraphDocument;
    manifest: ExecutionManifest;
    compile_diagnostics: GraphDiagnostic[];
    state: RuntimeStateSnapshot;
  } & RunOwnerRecord): Promise<void> {
    await mkdir(this.run_root, { recursive: true });
    await mkdir(this.paths.workspaces_dir, { recursive: true });
    await mkdir(this.paths.workspace_changes_dir, { recursive: true });
    await mkdir(this.paths.nodes_dir, { recursive: true });

    await this.writeRunRecord({
      run_id: options.run_id,
      graph_id: options.graph.graph_id,
      launch_profile: options.graph.launch.launch_profile,
      workspace_backend: options.graph.launch.workspace_backend,
      status: options.state.status,
      started_at: options.state.started_at,
      ...(options.owner_pid !== undefined ? { owner_pid: options.owner_pid } : {}),
      ...(options.owner_started_at ? { owner_started_at: options.owner_started_at } : {}),
      ...(options.owner_hostname ? { owner_hostname: options.owner_hostname } : {})
    });

    if (options.authored_graph) {
      await writeJson(this.paths.authored_graph_file, options.authored_graph);
    }

    await writeJson(this.paths.compiled_graph_file, options.graph);
    await writeJson(this.paths.execution_manifest_file, options.manifest);
    await writeJson(this.paths.compile_diagnostics_file, options.compile_diagnostics);
    await writeJson(this.paths.state_file, options.state);

    try {
      await access(this.paths.events_file);
    } catch {
      await writeText(this.paths.events_file, "");
    }

    await this.initializeSupervisorLedger();
  }

  async appendEvent(event: RuntimeEventEnvelope): Promise<void> {
    await appendFile(this.paths.events_file, `${JSON.stringify(event)}\n`);
  }

  async initializeSupervisorLedger(): Promise<void> {
    try {
      await access(this.paths.interventions_file);
    } catch {
      await writeText(this.paths.interventions_file, "");
    }
    try {
      await access(this.paths.runtime_log_file);
    } catch {
      await writeText(this.paths.runtime_log_file, "");
    }
    try {
      await access(this.paths.supervisor_timeline_file);
    } catch {
      await writeText(this.paths.supervisor_timeline_file, "");
    }
  }

  async appendSupervisorDecision(record: SupervisorDecision): Promise<void> {
    await mkdir(dirname(this.paths.supervisor_timeline_file), { recursive: true });
    await appendFile(this.paths.supervisor_timeline_file, `${JSON.stringify(record)}\n`);
  }

  async appendSupervisorIntervention(record: SupervisorInterventionRecord): Promise<void> {
    await mkdir(dirname(this.paths.interventions_file), { recursive: true });
    await appendFile(this.paths.interventions_file, `${JSON.stringify(record)}\n`);
  }

  async writeState(state: RuntimeStateSnapshot): Promise<void> {
    await writeJson(this.paths.state_file, state);
  }

  async writeRunSummary(summary: string): Promise<void> {
    await writeText(this.paths.summary_file, summary);
  }

  getExecutionDirectory(
    compiledId: string,
    executionId: string,
    options: Pick<ExecutionDirectoryOptions, "attemptIndex" | "iterationIndex" | "iterationAttemptIndex"> = {}
  ): string {
    return resolveNodeExecutionDirectory(
      this.run_root,
      compiledId,
      executionId,
      {
        ...this.node_directory_options.get(compiledId),
        ...options
      }
    );
  }

  async writeExecutionStart(
    attempt: RuntimeNodeAttempt,
    context?: {
      packet_path: string;
      manifest_path: string;
      provenance_path?: string;
    }
  ): Promise<{
    execution_json_path: string;
    stdout_log_path: string;
    stderr_log_path: string;
    result_path: string;
  }> {
    const executionDir = attempt.execution_dir;
    const paths = executionRuntimePaths(executionDir);
    await writeJson(paths.execution_json_path, {
      execution_id: attempt.execution_id,
      compiled_id: attempt.compiled_id,
      authored_id: attempt.authored_id,
      kind: attempt.kind,
      repo_alias: attempt.repo_alias,
      attempt_index: attempt.attempt_index,
      ...(attempt.repeat_scope_id ? { repeat_scope_id: attempt.repeat_scope_id } : {}),
      ...(attempt.iteration_index !== undefined ? { iteration_index: attempt.iteration_index } : {}),
      ...(attempt.iteration_attempt_index !== undefined
        ? { iteration_attempt_index: attempt.iteration_attempt_index }
        : {}),
      status: attempt.status,
      started_at: attempt.started_at,
      ...(context?.packet_path ? { context_packet_path: context.packet_path } : {}),
      ...(context?.manifest_path ? { context_manifest_path: context.manifest_path } : {}),
      ...(context?.provenance_path ? { context_provenance_path: context.provenance_path } : {})
    });
    await writeText(paths.stdout_log_path, "");
    await writeText(paths.stderr_log_path, "");
    await mkdir(resolveExecutionArtifactsDirectory(executionDir), { recursive: true });

    return paths;
  }

  async writeExecutionCompletion(
    attempt: RuntimeNodeAttempt,
    payload: {
      result: unknown;
      stdout?: string;
      stderr?: string;
    }
  ): Promise<void> {
    const paths = executionRuntimePaths(attempt.execution_dir);

    await writeJson(paths.execution_json_path, attempt);
    await writeJson(paths.result_path, payload.result);

    if (payload.stdout !== undefined) {
      await writeText(paths.stdout_log_path, payload.stdout);
    }

    if (payload.stderr !== undefined) {
      await writeText(paths.stderr_log_path, payload.stderr);
    }
  }

  async appendExecutionLogChunk(logPath: string, chunk: string): Promise<void> {
    if (chunk.length === 0) {
      return;
    }

    await appendFile(logPath, chunk);
  }

  async materializeDeclaredArtifacts(
    node: CompiledExecutableNode,
    attempt: RuntimeNodeAttempt,
    workspacePath: string,
    automaticArtifacts: Record<string, string>
  ): Promise<Record<string, string>> {
    const artifacts: Record<string, string> = { ...automaticArtifacts };

    for (const [name, definition] of Object.entries(node.declared_artifacts)) {
      const materialized = await this.materializeArtifactDefinition(
        name,
        definition,
        attempt.execution_dir,
        workspacePath
      );
      artifacts[name] = materialized;
    }

    return artifacts;
  }

  private async materializeArtifactDefinition(
    name: string,
    definition: ArtifactDefinition,
    executionDir: string,
    workspacePath: string
  ): Promise<string> {
    const artifactsRoot = resolveExecutionArtifactsDirectory(executionDir);

    if (definition.from === "output_dir") {
      const outputPath = resolveSubpathWithinRoot(
        artifactsRoot,
        definition.path,
        `Artifact "${name}" path`
      );

      try {
        await access(outputPath);
        return outputPath;
      } catch {
        throw new Error(`Required output_dir artifact "${name}" is missing at ${definition.path}.`);
      }
    }

    const sourcePath = resolveSubpathWithinRoot(
      workspacePath,
      definition.path,
      `Artifact "${name}" path`
    );
    const destinationPath = resolveSubpathWithinRoot(
      artifactsRoot,
      definition.path,
      `Materialized artifact "${name}" path`
    );

    try {
      await access(sourcePath);
      await mkdir(dirname(destinationPath), { recursive: true });
      await copyFile(sourcePath, destinationPath);
      return destinationPath;
    } catch {
      throw new Error(`Required workspace artifact "${name}" is missing at ${definition.path}.`);
    }
  }
}
