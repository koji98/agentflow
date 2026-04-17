import { readFileSync } from "node:fs";

const trace = readFileSync(process.env.AGENTFLOW_EVAL_TRACE_FILE, "utf8");
const passed = trace.includes('"type":"run.completed"') && trace.includes('"kind":"attempt"');

console.log(JSON.stringify({
  passed,
  score: passed ? 1 : 0,
  summary: passed ? "Trace includes run completion and attempt records." : "Trace is missing expected run records.",
  assertions: [
    {
      id: "trace_has_run_completed",
      passed: trace.includes('"type":"run.completed"'),
      evidence: "Checked trace.jsonl for the run.completed event."
    },
    {
      id: "trace_has_attempt",
      passed: trace.includes('"kind":"attempt"'),
      evidence: "Checked trace.jsonl for at least one attempt record."
    }
  ],
  metrics: {}
}));
