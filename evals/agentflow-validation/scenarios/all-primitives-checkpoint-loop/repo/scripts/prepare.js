const fs = require("node:fs");
const path = require("node:path");

fs.writeFileSync(path.join(process.env.AGENTFLOW_OUTPUT_DIR, "prep.md"), "Scenario: all-primitives-checkpoint-loop\nValidation: prepared\n");
