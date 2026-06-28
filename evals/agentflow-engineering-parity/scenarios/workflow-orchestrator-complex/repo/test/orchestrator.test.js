import assert from "node:assert/strict";
import { test } from "node:test";

import { createWorkflowRunner } from "../src/orchestrator.js";
import { formatWorkflowReport } from "../src/report.js";

test("runs tasks in dependency order and passes accumulated context", async () => {
  const calls = [];
  const runner = createWorkflowRunner({
    tasks: [
      { id: "load", run: "load" },
      { id: "normalize", run: "normalize", deps: ["load"] },
      { id: "publish", run: "publish", deps: ["normalize"] }
    ]
  }, {
    load: async (context, task) => {
      calls.push([task.id, { tenant: context.tenant, results: { ...context.results } }]);
      return { rows: [1, 2] };
    },
    normalize: (context, task) => {
      calls.push([task.id, { ...context.results }]);
      return context.results.load.rows.map((value) => value * 2);
    },
    publish: async (context, task) => {
      calls.push([task.id, context.results.normalize]);
      return "done";
    }
  });

  const result = await runner.run({ tenant: "acme" });

  assert.equal(result.status, "passed");
  assert.deepEqual(result.order, ["load", "normalize", "publish"]);
  assert.deepEqual(result.results, {
    load: { rows: [1, 2] },
    normalize: [2, 4],
    publish: "done"
  });
  assert.equal(result.tasks.load.status, "passed");
  assert.equal(result.tasks.normalize.attempts, 1);
  assert.deepEqual(calls[0], ["load", { tenant: "acme", results: {} }]);
  assert.deepEqual(calls[1], ["normalize", { load: { rows: [1, 2] } }]);
  assert.deepEqual(calls[2], ["publish", [2, 4]]);
});

test("retries flaky tasks and formats a Markdown report", async () => {
  let attempts = 0;
  const runner = createWorkflowRunner({
    tasks: [
      { id: "fetch", run: "fetch", retries: 2 }
    ]
  }, {
    fetch: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error(`try ${attempts}`);
      }
      return "ok";
    }
  });

  const result = await runner.run();

  assert.equal(result.status, "passed");
  assert.deepEqual(result.order, ["fetch"]);
  assert.equal(result.tasks.fetch.attempts, 3);
  assert.equal(result.tasks.fetch.result, "ok");

  const report = formatWorkflowReport(result);
  assert.match(report, /Workflow status: passed/);
  assert.match(report, /Run order: fetch/);
  assert.match(report, /\| fetch \| passed \| 3 \| ok \|/);
});

test("marks permanent failures and skips dependent tasks", async () => {
  const attempted = [];
  const runner = createWorkflowRunner({
    tasks: [
      { id: "parse", run: "parse", retries: 1 },
      { id: "write", run: "write", deps: ["parse"] },
      { id: "notify", run: "notify", deps: ["write"] }
    ]
  }, {
    parse: async () => {
      attempted.push("parse");
      throw new Error("bad input");
    },
    write: async () => {
      attempted.push("write");
      return "written";
    },
    notify: async () => {
      attempted.push("notify");
      return "notified";
    }
  });

  const result = await runner.run();

  assert.equal(result.status, "failed");
  assert.deepEqual(result.order, ["parse"]);
  assert.deepEqual(attempted, ["parse", "parse"]);
  assert.equal(result.tasks.parse.status, "failed");
  assert.equal(result.tasks.parse.attempts, 2);
  assert.match(result.tasks.parse.error, /bad input/);
  assert.deepEqual(result.tasks.write, {
    status: "skipped",
    attempts: 0,
    skipped_due_to: ["parse"]
  });
  assert.deepEqual(result.tasks.notify, {
    status: "skipped",
    attempts: 0,
    skipped_due_to: ["write"]
  });
});

test("validates workflow definitions during runner creation", () => {
  assert.throws(() => createWorkflowRunner({
    tasks: [
      { id: "a", run: "one" },
      { id: "a", run: "two" }
    ]
  }, {
    one: () => "one",
    two: () => "two"
  }), /duplicate/i);

  assert.throws(() => createWorkflowRunner({
    tasks: [
      { id: "a", run: "one", deps: ["missing"] }
    ]
  }, {
    one: () => "one"
  }), /unknown/i);

  assert.throws(() => createWorkflowRunner({
    tasks: [
      { id: "a", run: "one", deps: ["b"] },
      { id: "b", run: "two", deps: ["a"] }
    ]
  }, {
    one: () => "one",
    two: () => "two"
  }), /cycle/i);

  assert.throws(() => createWorkflowRunner({
    tasks: [
      { id: "a", run: "missing" }
    ]
  }, {}), /runner/i);
});
