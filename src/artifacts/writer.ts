import { access, appendFile, copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AuthoredGraphDocument, OutputDefinition } from "../graph/authored.js";
import type { CompiledExecutableNode, CompiledGraph } from "../graph/compiled.js";
import type { GraphDiagnostic } from "../graph/schema.js";
import {
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

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function writeText(filePath: string, contents: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
}

export class ArtifactWriter {
  readonly run_root: string;
  readonly paths: ReturnType<typeof resolveRunArtifactPaths>;

  constructor(runRoot: string) {
    this.run_root = runRoot;
    this.paths = resolveRunArtifactPaths(runRoot);
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
  }

  async appendEvent(event: RuntimeEventEnvelope): Promise<void> {
    await appendFile(this.paths.events_file, `${JSON.stringify(event)}\n`);
  }

  async writeState(state: RuntimeStateSnapshot): Promise<void> {
    await writeJson(this.paths.state_file, state);
  }

  async writeRunSummary(summary: string): Promise<void> {
    await writeText(this.paths.summary_file, summary);
  }

  getExecutionDirectory(compiledId: string, executionId: string): string {
    return resolveNodeExecutionDirectory(this.run_root, compiledId, executionId);
  }

  async writeExecutionStart(
    attempt: RuntimeNodeAttempt,
    context: {
      packet_path: string;
      summary_path: string;
      provenance_path?: string;
    }
  ): Promise<{
    execution_json_path: string;
    stdout_log_path: string;
    stderr_log_path: string;
    result_path: string;
  }> {
    const executionDir = attempt.execution_dir;
    const executionJsonPath = join(executionDir, "execution.json");
    const stdoutLogPath = join(executionDir, "stdout.log");
    const stderrLogPath = join(executionDir, "stderr.log");
    const resultPath = join(executionDir, "result.json");
    await writeJson(executionJsonPath, {
      execution_id: attempt.execution_id,
      compiled_id: attempt.compiled_id,
      authored_id: attempt.authored_id,
      kind: attempt.kind,
      repo_alias: attempt.repo_alias,
      attempt_index: attempt.attempt_index,
      ...(attempt.repeat_scope_id ? { repeat_scope_id: attempt.repeat_scope_id } : {}),
      ...(attempt.iteration_index !== undefined ? { iteration_index: attempt.iteration_index } : {}),
      status: attempt.status,
      started_at: attempt.started_at,
      context_packet_path: context.packet_path,
      context_summary_path: context.summary_path,
      ...(context.provenance_path ? { context_provenance_path: context.provenance_path } : {})
    });
    await writeText(stdoutLogPath, "");
    await writeText(stderrLogPath, "");

    return {
      execution_json_path: executionJsonPath,
      stdout_log_path: stdoutLogPath,
      stderr_log_path: stderrLogPath,
      result_path: resultPath
    };
  }

  async writeExecutionCompletion(
    attempt: RuntimeNodeAttempt,
    payload: {
      result: unknown;
      stdout?: string;
      stderr?: string;
    }
  ): Promise<void> {
    const executionJsonPath = join(attempt.execution_dir, "execution.json");
    const stdoutLogPath = join(attempt.execution_dir, "stdout.log");
    const stderrLogPath = join(attempt.execution_dir, "stderr.log");
    const resultPath = join(attempt.execution_dir, "result.json");

    await writeJson(executionJsonPath, attempt);
    await writeJson(resultPath, payload.result);

    if (payload.stdout !== undefined) {
      await writeText(stdoutLogPath, payload.stdout);
    }

    if (payload.stderr !== undefined) {
      await writeText(stderrLogPath, payload.stderr);
    }
  }

  async appendExecutionLogChunk(logPath: string, chunk: string): Promise<void> {
    if (chunk.length === 0) {
      return;
    }

    await appendFile(logPath, chunk);
  }

  async materializeDeclaredOutputs(
    node: CompiledExecutableNode,
    attempt: RuntimeNodeAttempt,
    workspacePath: string
  ): Promise<Record<string, string>> {
    const outputs: Record<string, string> = {};

    for (const definition of node.declared_outputs) {
      const materialized = await this.materializeOutputDefinition(
        definition,
        attempt.execution_dir,
        workspacePath
      );

      if (materialized) {
        outputs[definition.name] = materialized;
      }
    }

    return outputs;
  }

  private async materializeOutputDefinition(
    definition: OutputDefinition,
    executionDir: string,
    workspacePath: string
  ): Promise<string | undefined> {
    if (definition.from === "attempt") {
      const attemptPath = join(executionDir, definition.path);

      try {
        await access(attemptPath);
        return attemptPath;
      } catch {
        if (definition.required) {
          throw new Error(`Required attempt output "${definition.name}" is missing at ${definition.path}.`);
        }

        return undefined;
      }
    }

    const sourcePath = join(workspacePath, definition.path);
    const destinationPath = join(executionDir, "artifacts", definition.path);

    try {
      await access(sourcePath);
      await mkdir(dirname(destinationPath), { recursive: true });
      await copyFile(sourcePath, destinationPath);
      return destinationPath;
    } catch {
      if (definition.required) {
        throw new Error(`Required workspace output "${definition.name}" is missing at ${definition.path}.`);
      }

      return undefined;
    }
  }
}
