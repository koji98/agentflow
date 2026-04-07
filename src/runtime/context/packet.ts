import type { ContextReference, InputItem } from "../../graph/authored.js";

export interface ContextPacketMaterializedItem {
  key: string;
  kind: "input" | "context";
  source: InputItem | ContextReference;
  materialized_path: string;
  bytes: number;
  truncated: boolean;
}

export interface ContextPacketOmittedItem {
  key: string;
  source: InputItem | ContextReference;
  reason: string;
  optional: boolean;
}

export interface ContextPacket {
  execution_id: string;
  compiled_id: string;
  authored_id: string;
  repo_alias: string;
  workspace_path: string;
  materials: ContextPacketMaterializedItem[];
  omitted: ContextPacketOmittedItem[];
  totals: {
    material_count: number;
    file_count: number;
    total_bytes: number;
  };
}

export interface ContextDigestEntry {
  path: string;
  digest: string;
}

export interface ContextFileInputProvenance {
  kind: "file";
  key: string;
  repo_alias: string;
  path: string;
  digest: string;
}

export interface ContextGlobInputProvenance {
  kind: "glob";
  key: string;
  repo_alias: string;
  pattern: string;
  files: ContextDigestEntry[];
  digest: string;
}

export type ContextInputProvenance =
  | ContextFileInputProvenance
  | ContextGlobInputProvenance;

export interface ContextHarnessInstructionProvenance {
  repo_alias: string;
  files: ContextDigestEntry[];
  digest: string;
}

export interface ContextProvenance {
  compiled_id: string;
  authored_id: string;
  repo_alias: string;
  inputs: ContextInputProvenance[];
  harness_instructions?: ContextHarnessInstructionProvenance;
}
