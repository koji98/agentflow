export const taskRuntimeDirectoryName = ".task-runtime";

// Stale Agentflow-generated directories stay excluded so old local run state
// cannot leak into future prompt/context material.
export const staleAgentflowDirectoryName = ".agentflow";
export const staleAgentflowRuntimeDirectoryName = ".agentflow-runtime";
