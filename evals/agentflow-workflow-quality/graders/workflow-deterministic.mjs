import { readFileSync } from "node:fs";
import { join } from "node:path";

const packet = JSON.parse(readFileSync(process.env.AGENTFLOW_EVAL_TRACE_PACKET_FILE, "utf8"));
const suiteDir = process.cwd();
const suite = JSON.parse(readFileSync(join(suiteDir, "eval.json"), "utf8"));
const scenario = suite.scenarios
  .map((ref) => JSON.parse(readFileSync(join(suiteDir, ref), "utf8")))
  .find((entry) => entry.id === process.env.AGENTFLOW_EVAL_SCENARIO_ID);
const expectedStatus = scenario?.criteria?.outcome?.status ?? "passed";
const artifacts = packet.artifacts ?? [];
const hasHandoff = artifacts.some((artifact) => artifact.name === "handoff" && String(artifact.content ?? "").trim().length > 0);
const hasDelivery = Boolean(packet.delivery?.manifest_path);
const needsHandoff = expectedStatus === "passed";
const passed = packet.outcome.status === expectedStatus && (!needsHandoff || hasHandoff) && (!needsHandoff || hasDelivery);

console.log(JSON.stringify({
  passed,
  score: passed ? 5 : 1,
  summary: passed ? "Workflow produced a handoff artifact and delivery manifest." : "Workflow missed expected deterministic evidence.",
  assertions: [
    { id: "expected_status", passed: packet.outcome.status === expectedStatus, evidence: `expected=${expectedStatus}; actual=${packet.outcome.status}` },
    { id: "handoff_artifact", passed: !needsHandoff || hasHandoff, evidence: "trace packet artifacts" },
    { id: "delivery_manifest", passed: !needsHandoff || hasDelivery, evidence: packet.delivery?.manifest_path ?? "missing" }
  ],
  metrics: {
    attempts: packet.metrics.attempts,
    recovery_cycles: packet.metrics.recovery_cycles
  }
}));
