const assert = require("node:assert/strict");
const { recoveryStatus } = require("../src/recovery");

assert.deepEqual(Object.keys(recoveryStatus()).sort(), [
  "authorityPause",
  "missingContext",
  "resume",
  "staleDocs",
  "validationStrategy",
  "workspacePollution"
].sort());
