import assert from "node:assert/strict";
import { test } from "node:test";

import { parseDurationMs } from "../src/duration.js";

test("parses supported duration units", () => {
  assert.equal(parseDurationMs("250ms"), 250);
  assert.equal(parseDurationMs("2s"), 2000);
  assert.equal(parseDurationMs("3m"), 180000);
  assert.equal(parseDurationMs("1h"), 3600000);
  assert.equal(parseDurationMs(" 4s "), 4000);
});

test("rejects invalid durations", () => {
  assert.throws(() => parseDurationMs("soon"), /duration/u);
  assert.throws(() => parseDurationMs("3d"), /duration/u);
});
