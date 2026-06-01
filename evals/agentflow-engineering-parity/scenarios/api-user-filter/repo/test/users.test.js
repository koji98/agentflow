import assert from "node:assert/strict";
import { test } from "node:test";

import { listUsers } from "../src/users.js";

test("filters active students and sorts by name", () => {
  assert.deepEqual(
    listUsers({ role: "student", active: "true", sort: "name" }).map((user) => user.name),
    ["Zoe"]
  );
});

test("handles inactive boolean filter", () => {
  assert.deepEqual(
    listUsers({ active: false }).map((user) => user.id),
    ["u2"]
  );
});

test("sorting does not mutate subsequent unsorted results", () => {
  assert.deepEqual(listUsers({ sort: "name" }).map((user) => user.name), ["Ari", "Mina", "Zoe"]);
  assert.deepEqual(listUsers().map((user) => user.name), ["Mina", "Ari", "Zoe"]);
});
