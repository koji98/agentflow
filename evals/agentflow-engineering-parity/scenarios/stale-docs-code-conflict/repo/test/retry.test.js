import assert from "node:assert/strict";
import { test } from "node:test";

import { retryDelayMs } from "../src/retry.js";

test("interprets Retry-After numeric values as seconds", () => {
  assert.equal(retryDelayMs({ "Retry-After": "5" }), 5000);
  assert.equal(retryDelayMs({ "retry-after": "1.5" }), 1500);
});

test("returns zero when no retry header is present", () => {
  assert.equal(retryDelayMs({}), 0);
});
