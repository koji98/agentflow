const fs = require("node:fs");
const path = require("node:path");

if (process.env.AGENTFLOW_NODE_ID !== "validation" || !process.env.AGENTFLOW_RUN_ROOT) {
  process.exit(0);
}

const markerPath = path.join(process.env.AGENTFLOW_RUN_ROOT, "runtime", "eval-validation-gate-passed");

if (!fs.existsSync(markerPath)) {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, "first validation attempt intentionally failed\n");
  console.error("validation strategy repair required: first deterministic validation attempt is intentionally rejected; retry after supervisor evidence delta.");
  process.exit(1);
}
