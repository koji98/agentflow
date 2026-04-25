import type { ManagedPatternKind } from "../graph/schema.js";

export type ManagedPatternPhaseMode =
  | "single-agent"
  | "parallel-agents"
  | "council"
  | "deterministic-check"
  | "repair-loop";

export interface ManagedPatternPhaseDescriptor {
  id: string;
  label: string;
  summary: string;
  mode: ManagedPatternPhaseMode;
}

export interface ManagedPatternOrchestrationDescriptor {
  summary: string;
  planner: boolean;
  fan_out: boolean;
  council: boolean;
  validation: boolean;
}

export interface ManagedPatternDescriptor {
  kind: ManagedPatternKind;
  label: string;
  summary: string;
  contract_status: "implemented";
  runtime_shape: "compiled-subgraph";
  orchestration: ManagedPatternOrchestrationDescriptor;
  phases: ManagedPatternPhaseDescriptor[];
}

export interface ManagedPatternRegistry {
  descriptors: ManagedPatternDescriptor[];
  by_kind: Record<ManagedPatternKind, ManagedPatternDescriptor>;
}
