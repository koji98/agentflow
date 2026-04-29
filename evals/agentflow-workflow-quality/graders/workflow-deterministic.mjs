import { readFileSync } from "node:fs";

const packet = JSON.parse(readFileSync(process.env.AGENTFLOW_EVAL_TRACE_PACKET_FILE, "utf8"));
const artifacts = packet.artifacts ?? [];
const hasHandoff = artifacts.some((artifact) => artifact.name === "handoff" && String(artifact.content ?? "").trim().length > 0);
const hasDelivery = Boolean(packet.delivery?.manifest_path);
const passed = packet.outcome.status === "passed" && hasHandoff && hasDelivery;

console.log(JSON.stringify({
  passed,
  score: passed ? 5 : 1,
  summary: passed ? "Workflow produced a handoff artifact and delivery manifest." : "Workflow missed expected deterministic evidence.",
  assertions: [
    { id: "run_passed", passed: packet.outcome.status === "passed", evidence: `status=${packet.outcome.status}` },
    { id: "handoff_artifact", passed: hasHandoff, evidence: "trace packet artifacts" },
    { id: "delivery_manifest", passed: hasDelivery, evidence: packet.delivery?.manifest_path ?? "missing" }
  ],
  metrics: {
    attempts: packet.metrics.attempts,
    recovery_cycles: packet.metrics.recovery_cycles
  }
}));
