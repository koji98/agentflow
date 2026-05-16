const assert = require("node:assert/strict");
const { status } = require("../src/service");

assert.equal(status(), "ready");
