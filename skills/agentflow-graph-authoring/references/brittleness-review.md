# Brittleness Review

Use this as the final review checklist before shipping or approving a graph.

## Topology

- Is each executable node narrow enough that its purpose and failure mode are obvious?
- Is every `parallel` branch truly independent?
- Does every fan-out have a clear fan-in?
- Is every `repeat` bounded and justified?

## Context

- Are `inputs` specific, intentional, and as small as they can be?
- Are broad globs really necessary, or should the graph pass named files or upstream outputs instead?
- Does each `context_from` reference include only the next node's real needs: `summary`, `result`, or named `output`?
- Are downstream artifacts published explicitly through `outputs` instead of relying on ambient workspace state?

## Failure boundaries

- Which failures should stop the graph immediately?
- Which failures should be captured and reviewed later?
- Are `exec` and `check` being used to express that distinction cleanly?
- If a command can fail, will later nodes have enough logs or artifacts to explain why?

## Runtime and operability

- Are launch settings authored in the graph rather than assumed from the CLI?
- Are node-level profiles used only where a real runtime policy difference exists?
- Are env-sensitive commands and repo assumptions clearly localized to the nodes that need them?
- Do env-sensitive local commands declare `env_files` on the profile or node instead of relying on hidden shell setup?
- Would `resume` behave sensibly if an explicit input file or harness instruction file changes?

## Maintainability

- Are ids stable and readable?
- Does the graph read like intentional control flow rather than a prose task list in JSON form?
- Could another engineer tell where to modify the graph when a single stage changes?
- Are there any temporary compatibility nodes, duplicated checks, or convenience wrappers that should be removed now instead of carried forward?
