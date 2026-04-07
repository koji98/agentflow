import type { ManagedWorkflowKind } from "../graph/schema.js";

export type ManagedWorkflowPhaseMode =
  | "single-agent"
  | "parallel-agents"
  | "council"
  | "deterministic-check"
  | "repair-loop";

export interface ManagedWorkflowPhaseDescriptor {
  id: string;
  label: string;
  summary: string;
  mode: ManagedWorkflowPhaseMode;
}

export interface ManagedWorkflowOrchestrationDescriptor {
  summary: string;
  planner: boolean;
  fan_out: boolean;
  council: boolean;
  validation: boolean;
}

export interface ManagedWorkflowDescriptor {
  kind: ManagedWorkflowKind;
  label: string;
  summary: string;
  authored_contract_status: "deferred" | "implemented";
  runtime_shape: "compiled-subgraph";
  orchestration: ManagedWorkflowOrchestrationDescriptor;
  phases: ManagedWorkflowPhaseDescriptor[];
}

export interface ManagedWorkflowRegistry {
  descriptors: ManagedWorkflowDescriptor[];
  by_kind: Record<ManagedWorkflowKind, ManagedWorkflowDescriptor>;
}
