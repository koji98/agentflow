import assert from "node:assert/strict";
import { test } from "node:test";

import { tabsReducer } from "../src/tabs.js";

const state = {
  tabs: [
    { id: "a", title: "Alpha" },
    { id: "b", title: "Beta" },
    { id: "c", title: "Gamma" }
  ],
  selectedId: "b"
};

test("closing selected tab selects next tab", () => {
  assert.deepEqual(tabsReducer(state, { type: "close", id: "b" }), {
    tabs: [
      { id: "a", title: "Alpha" },
      { id: "c", title: "Gamma" }
    ],
    selectedId: "c"
  });
});

test("closing non-selected tab preserves selection and does not mutate input", () => {
  const next = tabsReducer(state, { type: "close", id: "a" });
  assert.equal(next.selectedId, "b");
  assert.deepEqual(state.tabs.map((tab) => tab.id), ["a", "b", "c"]);
});

test("closing final tab clears selection", () => {
  assert.deepEqual(tabsReducer({ tabs: [{ id: "a", title: "Alpha" }], selectedId: "a" }, { type: "close", id: "a" }), {
    tabs: [],
    selectedId: null
  });
});
