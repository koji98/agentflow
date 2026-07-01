# Context And Artifacts

Context is what a node may inspect. Artifacts are what a node publishes. Agentflow keeps those concepts separate so prompts stay pointer-based, downstream handoffs are explicit, and resume can reason about source provenance without stuffing copied evidence into the harness prompt.

## High-Level Flow

```mermaid
flowchart LR
  authored["Authored support.context"] --> normalize["Normalize refs and selectors"]
  normalize --> compile["Compile dependency edges"]
  compile --> attempt["Node attempt starts"]
  attempt --> resolve["Resolve agent, runtime, and debug context files"]
  resolve --> prompt["Harness prompt uses agent/context.md"]
  prompt --> worker["Agent/check/exec opens source pointers when needed"]
  worker --> artifacts["Declared artifacts and reserved artifacts"]
  artifacts --> downstream["Downstream refs"]
```

## Authored Context

Executable nodes receive authored context through `support.context`. Each entry must include `what` and `why` so the prompt can explain what the pointer is and why this node needs it.

Context kinds are:

- `workspace_file`: one required static file from the selected repo workspace.
- `workspace_glob`: one required static glob from the selected repo workspace; it must match at least one non-ignored file. At runtime it appears to the agent as one generated glob index pointer, not one row per matched file.
- `plugin_file`: one required static plugin-owned file forwarded by a plugin workflow.
- `ref`: a prior node artifact reference such as `design_spec.spec` or bare `design_spec`.

Inline text context is not part of the graph contract. Durable launch-time context belongs in `intent`, a workspace file, or a plugin file. Context produced during the run belongs in a declared artifact on the producer and a `ref` on the consumer.

Workspace and plugin context are static launch prerequisites. `agentflow validate`, `agentflow run`, and `agentflow resume` fail before launching any node when a required `workspace_file`, `workspace_glob`, or `plugin_file` is missing. Do not model a file that an upstream node will create as `workspace_file` context for a downstream node; declare it as an artifact and consume it with `ref`.

Authored artifact refs use `ref` as the source of truth. A dotted ref names `node.artifact`; a bare ref names a node and uses that node type's canonical artifact, such as `agent_response` for agent nodes. The normalizer derives `node` and `artifact` internally for compiled/runtime use.

## Artifact Ref Resolution

```mermaid
flowchart TD
  ref["Authored ref"] --> dotted{"Contains dot?"}
  dotted -- yes --> split["node = before dot\nartifact = after dot"]
  dotted -- no --> node["node = ref"]
  node --> kind["Look up target node kind"]
  kind --> canonical["artifact = canonical artifact for kind"]
  split --> validate["Validate target, dependency, and selector rules"]
  canonical --> validate
  validate --> compiled["Compiled context item with derived node/artifact"]
```

Compile-time validation checks that artifact refs point to known executable nodes, do not cross unordered parallel siblings, and use repeat selectors when a reference leaves a repeat scope. The compiled graph carries derived `node` and `artifact` fields so Mermaid diagrams, runtime context resolution, review, and delivery can explain the dependency without requiring redundant authored fields.

## Pointer Resolution

At execution time, `resolveExecutionContext` writes audience-specific files under the attempt directory:

- `agent/context.md`: prompt-facing pointer index. This is what normal agents see.
- `runtime/context.json`: compact machine state for resume, completion, verification, and recovery.
- `human-debug/context-provenance.json`: source provenance and digest metadata for audit/debug review.

Agentflow does not copy authored context text into attempt-local source clones and does not truncate source context. The prompt includes only available actionable pointers and omits optional omissions, digests, byte sizes, packet paths, and provenance paths. Each runtime context item points back to the source workspace file, artifact file, plugin file, or runtime-generated file.

`agent/context.md` is priority-sectioned when context has more than ordinary task pointers:

- `Read First`: retry/recovery evidence and immediate repair feedback.
- `Current Work`: the pointer that defines the active unit of work.
- `Task Context`: authored files, plugin files, and ordinary artifact refs.
- `Progress State`: runtime state useful for continuation.
- `Reference Sets`: broad file sets such as workspace globs.

If a node only has simple task context, `agent/context.md` may stay as a compact `Pointers` table. Priority is advisory; it tells the worker where to start without expanding authority or preventing targeted search.

```mermaid
flowchart TD
  start["Node attempt"] --> item{"Context item type"}
  item --> file["Workspace file"]
  item --> glob["Workspace glob"]
  item --> plugin["Plugin file"]
  item --> ref["Prior artifact ref"]
  glob --> sort["List repo files, sort, cap by max_files"]
  sort --> glob_index["Write runtime/globs/<name>.md index"]
  ref --> attempts["Select producer attempt by iteration/attempt selector"]
  attempts --> artifact{"Artifact path exists?"}
  artifact -- yes --> pointer["Record pointer and runtime/debug metadata"]
  artifact -- no --> omit["Omit if if_available, otherwise fail context resolution"]
  file --> pointer
  plugin --> pointer
  glob_index --> pointer
  pointer --> write["Write agent context, runtime context, debug provenance"]
```

## Validate Context Analysis

`agentflow validate --graph <path>` uses the same repo file discovery and path-safety rules as runtime context resolution. It reports pointer-level context analysis under `checks.context` in the validation payload:

- projected pointer counts per node
- projected byte sizes per context item when statically knowable
- sample glob matches and largest matched files
- non-text or unsafe source warnings
- default ignored roots and explicit ignored-root opt-ins
- missing static workspace/plugin context as blockers

Workspace globs skip common dependency and generated roots by default, including `.git`, `.task-runtime`, stale `.agentflow` runtime state, `.agentflow-runtime`, `node_modules`, `.venv`, `venv`, `.tox`, cache directories, build output, coverage, `vendor`, `third_party`, `generated`, `gen`, `__generated__`, and Bazel output. Authors can intentionally opt into one of those roots by starting the authored context path inside that root, such as `.venv/*eval*.md`; broad globs like `**/*eval*` still skip those roots.

At runtime, each authored `workspace_glob` writes one attempt-local index file under `context/runtime/globs/<context-name>.md`. The index records the source pattern, matches found, matches included after `max_files`, limit status, ignored-root behavior, and a file table with paths, sizes, and digests. `runtime/context.json` and `human-debug/context-provenance.json` preserve file-level path/digest/size metadata for every included match.

## Repeat Selectors

Artifact refs can select attempts with:

- `iteration`: `latest`, `latest_passed`, `latest_failed`, `previous`, or a positive integer.
- `attempt`: `latest`, `latest_passed`, `latest_failed`, or a positive integer.
- `if_available: true`: record an optional missing artifact reference in runtime/debug state rather than fail when the selected material does not exist. Optional omissions are not rendered into normal agent prompts.

Missing required artifact references fail context resolution before the consumer node runs because the producer's runtime result determines availability. Missing static workspace files, glob matches, and plugin files are launch preflight failures.

Inside repeat bodies, Agentflow can also add repeat history pointers for the current iteration. That gives a repair/retry node a concise view of previous failed attempts without making graph authors wire every internal attempt artifact manually. Supervisor retry guidance can also appear as runtime-provided context after recovery; it contains the retry brief and prior attempt evidence paths for the retrying node. Runtime-authored attempt memory is separate: `agent/attempt-memory.md` and `runtime/attempt-memory.json` summarize the best-resume decision, prior timeline from `events.jsonl`, progress to reuse, progress to discard, artifact state, validation evidence, workspace decision, resume point, restart boundary, and do-not-redo guidance.

When a retry uses a supervisor runtime overlay, the overlay context is resolved before authored context:

- `supervisor_recovery_envelope` points to `agent/supervisor-recovery.md`, which summarizes the failure symptom, selected recovery action, best resume point, restart boundary, workspace decision, required material delta, reuse/discard guidance, evidence pointers, validation focus, and unchanged contract.
- `supervisor_context_repair` appears when context pointer resolution failed. It provides a compact context index, omitted-entry provenance, largest-file warnings, default ignored roots, and live paths the worker can inspect manually.
- Workspace and environment repairs are recorded in `runtime-overlay.json` and `material-delta.json`. Workspace repair also writes `workspace-repair-patch.json` and `workspace-repair-result.json` so reviewers can see which failed-attempt edits were restored before retry.

The overlay is not a graph contract change. It is an auditable runtime repair attached to machine state under `runtime/supervisor/` and raw debug evidence under `human-debug/interventions/`.

## Artifact Production

Nodes declare durable handoffs under `artifacts`. An artifact definition says where the runtime should look after a node reports success:

- `from: "output_dir"`: the file must exist under `$AGENTFLOW_OUTPUT_DIR`.
- `from: "workspace"`: the file must exist under the node workspace path.
- `content_type`: optional expected MIME type such as `text/markdown`, `application/json`, `image/png`, or `application/pdf`. When present, runtime verifies it against detected bytes or known file evidence.

Artifacts are bytes-first. Markdown and JSON artifacts still receive text checks such as empty, placeholder, exact required content, forbidden content, and JSON parsing. Screenshots, PDFs, traces, videos, archives, and other binary artifacts are validated as non-empty byte artifacts with detected content type, media kind, size, SHA-256, and cheap preview metadata when available. Agents can stream artifact bytes through `af artifact write <name>` or copy an existing workspace/output file with `af artifact write <name> --file <path>`.

When binary artifact content matters to acceptance criteria, the worker should also record textual validation evidence in milestones or a text handoff that explains what the binary proves. Agentflow never inlines base64 or raw binary into prompts.

Agent nodes also produce reserved automatic artifacts regardless of whether declared artifact projection succeeds:

- `agent_response`: final harness response.
- `stdout`: captured stdout log for human audit/debug.
- `stderr`: captured stderr log for human audit/debug.

Check nodes can produce `verification_json`; local exec/check nodes capture `stdout` and `stderr`. Passing agent attempts that project declared artifacts also receive `runtime/verifier.json` and `human-debug/verifier/verdict.md` from outcome verification. Raw logs and verifier internals are audit artifacts, not declared handoffs or default agent-facing context.

## Missing Artifacts

A missing declared artifact is a runtime failure, not a graph validation failure. Validation proves the contract is well formed; execution proves the worker honored it.

When an agent attempt reports success but required declared artifacts are missing, the supervisor may run `repair_artifact` if policy and budget allow. The runtime writes an agent-facing repair brief under `agent/` with missing artifacts, concise evidence pointers, and retry instructions. Raw harness logs stay under `human-debug/` for audit and diagnostic helpers. The repair is accepted only if the missing files now exist at the declared paths.

When an agent harness fails, the runtime preserves the harness failure as the primary diagnostic and does not convert the attempt into a missing-artifact failure. Files written before the failure are not registered as declared artifacts for downstream refs. Later repair or retry prompts may still list those existing paths as prior-attempt evidence so the next worker can inspect useful partial work without treating it as a completed handoff.

## Why This Shape

This design makes handoffs explicit and inspectable:

- Graph authors decide which inputs are important by naming context pointers.
- Graph authors decide which outputs matter by naming artifacts.
- Agents cannot smuggle durable state through hidden chat history.
- Downstream nodes depend on named artifacts instead of scratch paths.
- Resume can compare context provenance and compiled node contracts.
- Delivery can separate human-facing artifacts from debug-only runtime files.
