# Agentflow Capability Workflows

This suite is for hard, prompt-sensitive Agentflow workflow evals across several local repository shapes. It is the primary suite for iterating on Agentflow internal prompts, context packaging, tool guidance, delivery evidence, and supervisor recovery behavior against real local repo fixtures.

The fixture repos are generated under ignored `eval-repos/agentflow-capability-workflows/`. Recreate them on any device with:

```bash
npm run setup:eval-repos
```

Then validate or run:

```bash
agentflow eval validate evals/agentflow-capability-workflows
agentflow eval run evals/agentflow-capability-workflows --variant current --scenario all --trials 1 --concurrency 2
```

## Scenario Coverage

| Scenario | Bucket | What It Tests |
| --- | --- | --- |
| `01-config-deep-merge` | `valid-hard-execution` | Fix nested configuration merging in a Node service. |
| `02-cache-ttl-regression` | `valid-hard-execution` | Repair TTL cache expiration without changing the public API. |
| `03-api-client-docs-migration` | `missing-dependency-docs` | Use local HTTP docs to migrate an API client to the v2 request contract. |
| `04-ui-accessibility` | `valid-hard-execution` | Add accessible names to icon-only UI rendering without changing text buttons. |
| `05-design-token-scope` | `scope-control` | Update design tokens while preserving a frozen compatibility file. |
| `06-data-normalization` | `valid-hard-execution` | Normalize CSV-like rows with trimming, dedupe, and numeric parsing. |
| `07-noisy-monorepo-targeting` | `noisy-evidence` | Make a targeted billing fix inside a noisy monorepo fixture. |
| `08-tool-guided-discovery` | `tool-discipline` | Use a local CLI tool to discover required implementation data. |
| `09-cli-error-discipline` | `valid-hard-execution` | Improve CLI invalid-input behavior with actionable errors. |
| `10-no-edit-audit` | `no-edit-audit` | Audit a package without modifying repo files and produce only a handoff artifact. |
| `11-forbidden-scope-guard` | `scope-control` | Fix escaping logic while preserving an out-of-scope secrets fixture. |
| `12-sequence-research-implement` | `context-handoff` | Use a research artifact to drive a downstream implementation node. |
| `13-worktree-change-capture` | `workspace-backend` | Run an implementation scenario through the worktree backend. |
| `14-stale-docs-conflict` | `context-conflict` | Resolve stale repo docs by preferring the current local HTTP docs fixture. |
| `15-supervisor-retry-envelope` | `supervisor-recovery` | Confirm a failed executable node receives a supervisor recovery envelope on retry. |
| `16-terminal-repeated-failure` | `supervisor-boundary` | Confirm repeated unrecoverable failure records terminal supervisor evidence. |
| `17-context-pointer-provenance` | `context-pointer-provenance` | Confirm pointer-only context gives enough provenance for a targeted fix without broad rewrites. |
| `18-noisy-generated-tree` | `context-noise-control` | Confirm broad context ignores generated dependency-style trees while preserving useful task context. |
| `19-validation-timeout-strategy` | `validation-repair` | Confirm timeout-like failures receive changed validation strategy before retry. |
| `20-workspace-pollution-cleanup` | `workspace-repair` | Confirm failed-attempt workspace pollution is cleaned before retry. |
| `21-no-delta-recovery-stop` | `supervisor-boundary` | Confirm recovery stops when no material delta can be produced. |
| `22-managed-deep-research-repo` | `managed-patterns` | Use managed deep research on a real local repo fixture with seven balanced research angles. |
| `23-managed-deep-work-repo` | `managed-patterns` | Use managed deep work to plan, generate, validate, grade, and publish a real local repo fix. |

The suite intentionally includes expected-pass workflows, a no-repo-edit audit, tool-required discovery, local HTTP docs, stale/noisy context, sequence handoff, worktree backend behavior, supervisor retry envelope behavior, and expected terminal failure.

Do not commit generated eval repos or eval output roots.
