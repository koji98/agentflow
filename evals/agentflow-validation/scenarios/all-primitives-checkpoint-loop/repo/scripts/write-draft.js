const fs = require("node:fs");
const path = require("node:path");

fs.writeFileSync(path.join(process.env.AGENTFLOW_OUTPUT_DIR, "draft.md"), "Scenario: all-primitives-checkpoint-loop\nValidation: checkpoint draft\nRisks: scripted first denial must be incorporated\n");
