import type {
  ProjectedArtifactItem,
  ProjectedArtifactRead,
  ProjectedCheckEvaluation,
  ProjectedNodeAttemptSummary,
  ProjectedNodeDetail,
  ProjectedNodeLogPayload,
  ProjectedRunEvent,
  ProjectedRunEventPage,
  ProjectedRunNode,
  ProjectedRunSnapshot,
  ProjectedRunSummary,
  ProjectionStatus
} from "../../../src/artifacts/projection.js";

export type RunStatus = ProjectionStatus;
export type RunSummary = ProjectedRunSummary;
export type RunNodeOverlay = ProjectedRunNode;
export type RunSnapshot = ProjectedRunSnapshot;
export type RunEvent = ProjectedRunEvent;
export type RunEventPage = ProjectedRunEventPage;
export type NodeExecutionSummary = ProjectedNodeAttemptSummary;
export type NodeDetail = ProjectedNodeDetail;
export type CheckEvaluation = ProjectedCheckEvaluation;
export type ArtifactItem = ProjectedArtifactItem;
export type NodeLogPayload = ProjectedNodeLogPayload;
export type ArtifactRead = ProjectedArtifactRead;
