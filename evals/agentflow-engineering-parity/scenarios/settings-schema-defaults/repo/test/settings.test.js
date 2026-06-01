import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeSettings } from "../src/settings.js";

test("applies defaults without mutating input", () => {
  const input = {};
  assert.deepEqual(normalizeSettings(input), {
    theme: "system",
    emailNotifications: true
  });
  assert.deepEqual(input, {});
});

test("accepts valid explicit settings", () => {
  assert.deepEqual(normalizeSettings({ theme: "dark", emailNotifications: false }), {
    theme: "dark",
    emailNotifications: false
  });
});

test("rejects invalid values", () => {
  assert.throws(() => normalizeSettings({ theme: "sepia" }), /theme/u);
  assert.throws(() => normalizeSettings({ emailNotifications: "yes" }), /emailNotifications/u);
});
