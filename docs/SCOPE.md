# Scope

## Build Now

The current release is a runnable local-first graph executor with a graph-native CLI and durable run artifacts.

Required product surface:

- graph file authoring in `1` format
- graph validation without execution
- graph compilation with authored and compiled inspection payloads
- run execution against one or more local git repositories
- run resume from failed or canceled run roots
- workspace backends: `inplace` and `worktree`
- executable node kinds: `agent`, `exec`, `check`
- authored container kinds: `sequence`, `parallel`, `repeat`
- profile resolution
- Codex CLI and Cursor CLI harness adapters
- deterministic checks and AI checks
- durable run artifacts, append-only events, and projected inspection state
- CLI commands for `graph-help`, `validate`, `compile`, `run`, and `resume`

## Required Behavior

### Graph and compiler

- validate authored graphs deterministically
- resolve launch profile and workspace backend before compile
- compile authored containers into a flat executable graph with scope metadata
- preserve authored ids and emit stable compiled ids
- emit explicit repeat edges and repeat scope metadata
- reject ambiguous upstream references and unsupported deferred features

### Runtime

- execute compiled graphs only
- schedule `agent`, `exec`, and `check`
- enforce `parallel.max_concurrency`
- track repeat iterations explicitly
- stop on terminal failure and cancel other active executions
- support operator cancellation from the CLI launch surface
- write artifacts and events incrementally during execution

### Context and outputs

- materialize declared `inputs`
- resolve `context_from` from prior executions
- enforce `input_rules`
- materialize declared outputs for downstream use
- fail clearly on missing required context

### Harnesses and checks

- normalize one invocation contract for Codex and Cursor
- run deterministic checks locally
- run AI checks through codex-cli in strict read-only mode
- run cursor-backed read-only agent flows in proposal mode rather than forced-write mode
- require structured evaluator output for AI checks

### Inspection

- show authored and compiled graph details before launch through CLI output
- emit enough durable artifacts to inspect a historical run from the filesystem alone
- keep node-level logs, artifacts, diagnostics, and events addressable from the run root
- support projected inspection state derived from durable artifacts without requiring a live controller

## Release Acceptance Criteria

The release is complete only when all of the following are true:

1. A graph can be validated from the CLI without launching a run.
2. A graph can be compiled from the CLI and inspected from the emitted contract.
3. A multi-step graph with `repeat` can run locally end to end.
4. Both supported harness adapters can execute at least one `agent` node.
5. Deterministic and AI checks both produce inspectable results.
6. A historical run can be inspected from durable artifacts alone.
7. Automated tests cover compiler semantics, repeat execution, context resolution, harness adapters, artifact projection, and CLI contracts.

## Out of Scope

Do not build these now:

- new node kinds beyond `agent`, `exec`, `check`, `sequence`, `parallel`, `repeat`
- automatic controller loops
- remote workspace backends
- generalized plugin APIs
- interactive graph editing surfaces
- resumability beyond `resume` plus reopening completed or failed runs from artifacts

`DEFERRED.md` is authoritative for the full deferred list.
