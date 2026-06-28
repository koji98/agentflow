# Workflow Orchestrator

Build a small async workflow orchestration library. This is intentionally a multi-part implementation task; treat the sections below as the user plan.

Validation command: `npm test`

## Public API

- Implement `createWorkflowRunner(definition, runners)` in `src/orchestrator.js`.
- Implement `formatWorkflowReport(result)` in `src/report.js`.
- Do not change `task.md`, `package.json`, or tests.

## Workflow Definition

`definition.tasks` is an array of task records:

- `id`: unique task id.
- `run`: key used to find a runner function in the `runners` object.
- `deps`: optional array of task ids that must pass first.
- `retries`: optional number of retries after the first failed attempt.

Validate during `createWorkflowRunner`:

- duplicate task ids throw an error mentioning duplicate ids;
- unknown dependency ids throw an error mentioning unknown dependencies;
- missing runner keys throw an error mentioning runner;
- dependency cycles throw an error mentioning cycle.

## Execution Behavior

`createWorkflowRunner` should return an object with an async `run(initialContext = {})` method.

- Run tasks only after all dependencies pass.
- Preserve deterministic dependency order from the original `definition.tasks` order.
- Each runner receives `(context, task)` where `context` includes the original input fields and a `results` object containing successful prior task results by id.
- Record `order` as the ids of tasks that actually ran.
- Retry a failed task until it passes or its retry budget is exhausted.
- A task with `retries: 2` may run up to three attempts total.
- When a task fails permanently, skip tasks that depend on it.
- A skipped task should record `status: "skipped"`, `attempts: 0`, and `skipped_due_to` with the blocking dependency ids.

The final result should include:

- `status`: `"passed"` only if every task passed, otherwise `"failed"`;
- `order`: task ids that actually ran;
- `results`: successful task return values keyed by id;
- `tasks`: per-task records with `status`, `attempts`, and either `result`, `error`, or `skipped_due_to`.

## Report Behavior

`formatWorkflowReport(result)` should return Markdown with:

- a line containing `Workflow status: <status>`;
- a line containing `Run order: <ids>` where ids are joined by ` -> `, or `none` when no tasks ran;
- a table with task id, status, attempts, and detail;
- failed task details should include the error message;
- skipped task details should include the dependency ids that caused the skip.

## Suggested Work Order

1. Read the current source and tests.
2. Implement validation and dependency analysis.
3. Implement async execution with deterministic dependency order and accumulated context.
4. Implement retries, permanent failure handling, and skipped dependents.
5. Implement Markdown reporting.
6. Run `npm test`, fix any failures, and write a concise handoff with changed files, validation result, and risks.
