import { readFileSync } from "node:fs";

const packet = JSON.parse(readFileSync(process.env.AGENTFLOW_EVAL_TRACE_PACKET_FILE, "utf8"));
const passed = packet.outcome.status === "passed" && packet.metrics.attempts >= 1;

console.log(JSON.stringify({
  passed,
  score: passed ? 5 : 1,
  summary: passed ? "Trace packet includes passing run and attempt records." : "Trace packet is missing expected run records.",
  assertions: [
    {
      id: "trace_packet_passed",
      passed: packet.outcome.status === "passed",
      evidence: "Checked trace-packet.json outcome."
    },
    {
      id: "trace_packet_has_attempt",
      passed: packet.metrics.attempts >= 1,
      evidence: "Checked trace-packet.json metrics."
    }
  ],
  metrics: {}
}));
