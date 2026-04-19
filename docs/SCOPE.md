# Scope

## Build Now

The current release is a runnable local-first graph executor with a graph-native CLI and durable run artifacts.

Required product surface:

- graph file authoring in `1` format
- graph validation without execution, with optional compiled-contract inspection through `validate --show-compiled`
- run execution against one or more local git repositories
- run resume from failed or canceled run roots, including `resume --graph --latest`
- workspace backends: `inplace` (default) and `worktree`
- executable node kinds: `agent`, `exec`, `check`, `checkpoint`
- authored container kinds: `sequence`, `parallel`, `repeat`
- profile resolution
- Git-resolved plugin workflows that lower into normal primitive subgraphs
- plugin-bundled CLI tools and per-tool environment configuration; no built-in or inline graph- or agent-defined tools
- Cursor CLI and Codex CLI harness adapters
- deterministic checks and AI checks
- durable run artifacts, append-only events, and projected inspection state
- CLI commands for `graph-help`, `validate`, `plugin resolve`, `run`, `resume`, `apply`, `runs list`, and `inspect`

## Required Behavior

### Graph and compiler

- validate authored graphs deterministically
- resolve launch profile and workspace backend before compile
- compile authored containers into a flat executable graph with scope metadata
- resolve plugin workflows from the local lockfile and lower them before normal graph validation
- preserve authored ids and emit stable compiled ids
- emit explicit repeat edges and repeat scope metadata
- reject ambiguous upstream references and unsupported deferred features

### Runtime

- execute compiled graphs only
- schedule `agent`, `exec`, `check`, and `checkpoint`
- enforce `parallel.max_concurrency`
- track repeat iterations explicitly
- stop on terminal failure and cancel other active executions
- support operator cancellation from the CLI launch surface
- write artifacts and events incrementally during execution

### Context and artifacts

- materialize declared `context`
- resolve artifact context items by `ref` (`"node.artifact"` or bare `"node"` for the canonical artifact of that node kind) from prior executions
- enforce `input_rules`
- materialize declared `artifacts` for downstream use
- publish reserved `agent_response`, `stdout`, and `result_json` canonical artifacts automatically per node kind
- expose `AGENTFLOW_CONTEXT_<UPPER_NAME>` env vars for `exec` and deterministic `check` nodes
- run bounded agent artifact repair when a successful agent misses declared artifacts
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
2. A graph's compiled contract can be inspected from the CLI through `validate --show-compiled`.
3. A multi-step graph with `repeat` can run locally end to end.
4. Both supported harness adapters can execute at least one `agent` node.
5. Deterministic and AI checks both produce inspectable results.
6. A historical run can be inspected from durable artifacts alone, including through `runs list` and `inspect`.
7. Automated tests cover compiler semantics, repeat execution, context resolution, harness adapters, artifact projection, and CLI contracts.
8. A graph can resolve a Git-distributed plugin workflow, compile the lowered workflow, and consume its public artifacts from a regular downstream node.
9. A graph can declare and consume a plugin-bundled CLI tool from an `agent` node.

## Out of Scope

Do not build these now:

- new runtime node kinds beyond `agent`, `exec`, `check`, `checkpoint`
- automatic controller loops
- remote workspace backends
- MCP sidecars or harness-specific extension semantics. Plugin-bundled CLI tools are supported (see `docs/PLUGINS.md`); built-in CLI tools, inline graph- or agent-defined tools, long-running tool sidecars, and harness-specific tool bindings remain deferred.
- interactive graph editing surfaces
- resumability beyond `resume` plus reopening completed or failed runs from artifacts

`DEFERRED.md` is authoritative for the full deferred list.
