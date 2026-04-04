# UI Model

## Product Stance

The UI is an operator console, not a marketing shell. It should feel like a precise control surface for graph execution.

Visual direction:

- light theme by default
- warm off-white canvas, graphite text, slate borders
- status color only where it carries meaning
- `Space Grotesk` or similar condensed display face for headers
- `IBM Plex Sans` for body text
- `IBM Plex Mono` for ids, commands, and logs
- radius `2px` to `4px`
- visible borders, minimal shadows

The graph is the product. The graph tile gets the largest footprint on every desktop screen.

## Information Hierarchy

The interface has four persistent information classes:

- launch controls
- graph topology
- node inspection
- run activity

Logs and raw artifacts matter, but they remain subordinate to graph state.

## Layout Model

Use a bento-grid shell on desktop:

- 12-column main grid
- 16px gaps
- dominant graph tile in the center-left
- persistent inspector tile on the right
- lower strip for activity and logs

Responsive collapse:

- tablet: 8 columns, inspector becomes a docked lower panel
- mobile: 4 columns, inspector and logs move into tabs or drawers

Do not turn the monitor into a vertically stacked card list on smaller screens. Preserve hierarchy.

## Surface 1: Launchpad

The launchpad is the home surface for choosing a graph, validating it, compiling it, and preparing a CLI launch handoff.

### Desktop tile map

- top row: four narrow KPI tiles for graph id, node count, profile count, and compile status
- center-left hero tile: authored graph preview
- center-right control tile: graph picker, launch profile selector, workspace backend selector, action buttons
- bottom-left wide tile: validation and compile diagnostics plus inferred repos
- bottom-right medium tile: recent runs for this graph

### Launch controls

Required controls:

- choose graph file
- choose launch profile
- choose workspace backend
- `Validate`
- `Compile`
- CLI launch handoff

Rules:

- launch profile defaults from `defaults.launch_profile`
- workspace backend defaults from `defaults.workspace_backend`
- workspace backend is shown as run-scoped, not node-scoped
- changing the graph resets prior compile output
- the release may render a disabled `Run` affordance, but durable execution still starts from the CLI

The graph file picker should be a proper modal with breadcrumb path, recent locations, and explicit confirm/cancel actions.

### Launchpad behavior

- selecting a graph immediately shows authored graph structure and top-level metadata
- `Validate` reports schema and semantic issues without generating a run
- `Compile` materializes the compiled graph preview and effective launch configuration
- compile diagnostics stay visible beside the graph preview; they are not buried in a toast
- inferred repos show both source paths and eventual workspace paths when they are known
- when compilation succeeds, the surface should expose the exact CLI launch shape instead of silently starting a run

## Surface 2: Graph Inspection

Graph inspection exists both before launch and from a run. It is a static analysis surface, not the live monitor.

### View modes

The graph tile exposes exactly three modes:

- `Authored`
- `Compiled`
- `Overlay`

`Overlay` is only available when a run exists. The other two modes always exist.

### Authored graph appearance

Authored mode should make author intent obvious.

- `sequence` regions render as linear lanes
- `parallel` regions render as split columns inside a bordered container
- `repeat` regions render as framed loops with an attempt-cap badge in the header
- leaf nodes render as crisp rectangular cards with type labels
- compile-generated detail stays hidden in this mode

The authored graph should look stable and human-authored, not mechanically exploded.

### Compiled graph appearance

Compiled mode shows runtime truth.

- only executable nodes render as graph nodes
- compiler-generated edges are explicit
- repeat regions render with visible back-edges
- check nodes use a distinct shape from `agent` and `exec`
- authored container ancestry comes from `scope_stack` and renders as subtle scope outlines, not executable nodes

Compiled mode should answer one question fast: "what will the scheduler actually run?"

### Runtime overlay appearance

Overlay mode starts from compiled mode and adds run state.

- node border color shows status
- active node gets a solid highlight and elapsed timer
- repeated nodes show an iteration and attempt badge, for example `i2/a1`
- failed checks show pass/fail status directly on the node
- blocked downstream nodes mute but remain visible
- edges that are currently activating pulse subtly

The overlay never mutates the authored graph. Attempts belong to the overlay, not to graph structure.

## Surface 3: Live Monitor

The live monitor is the primary run surface.

### Desktop tile map

- top KPI strip: run status, active nodes, passed or failed counts, current repeat depth
- center-left hero tile: compiled graph with runtime overlay
- center-right inspector tile: selected node details
- bottom-left wide tile: event timeline
- bottom-right wide tile: selected node logs and artifacts

### Monitor behavior

- opening a run lands on overlay mode by default
- selecting a node updates the inspector and log tile without route churn
- event timeline auto-scrolls only when the user is pinned to live mode
- the header exposes cancel guidance, but actual run cancellation stays CLI-owned in this release and resolves through durable artifact updates
- run-wide diagnostics derived from durable events stay pinned near the header so preflight failures and harness timeouts are visible without opening node logs
- filters exist for `active`, `failed`, `checks`, and `repeats`
- the UI boots from `state.json` and then tails events after `snapshot_seq`

The monitor is for diagnosis, not for graph editing.

## Surface 4: Node Inspection

Node inspection is a persistent right-side pane on desktop and a drawer on smaller screens.

### Inspector header

Always visible:

- node label and kind
- authored id
- compiled id
- current runtime state
- repo alias
- effective profile name

If the node is inside a repeat, the header also shows repeat scope id and current iteration.

### Inspector sections

The inspector uses flat sections, not deep tabs.

Required sections:

- `Definition`: source prompt or command, authored metadata, compiled dependencies, scope stack
- `Profile`: resolved harness, model, reasoning effort, sandbox, timeout, workspace backend
- `Inputs`: static inputs, upstream references, selectors, optionality, materialized sizes, context summary
- `Executions`: one row per execution with outcome, duration, iteration, and attempt index
- `Checks`: pass/fail evidence and evaluator output when the node is a check
- `Artifacts`: openable files produced by the selected execution
- `Events`: node-scoped event stream

The `Inputs` section distinguishes:

- authored `inputs`
- authored `context_from`
- resolved execution used by each upstream reference
- omitted optional items

If a section has no data, show it collapsed with an empty-state label rather than removing it and shifting the operator's mental map.

## Operator Mental Model

The UI must teach three distinct layers without making them feel like three products.

### Layer 1: authored graph

This is what the operator wrote. It should remain stable across runs.

### Layer 2: compiled graph

This is what Agentflow will execute. It is the static runtime contract, including scope ancestry and explicit failure edges.

### Layer 3: runtime overlay

This is what happened in one specific run. It includes executions, statuses, events, durations, repeat iterations, and produced artifacts.

The UI lets the operator move between these layers with one control group in one location.

## Status Language

Use these status words consistently:

- `Pending`
- `Ready`
- `Running`
- `Passed`
- `Failed`
- `Blocked`
- `Canceled`
- `Skipped`

Meaning rules:

- `Passed` and `Failed` are terminal node outcomes and match compiled edge conditions
- `Blocked` means upstream terminal failure prevented execution
- `Canceled` means an in-flight execution was interrupted by operator cancellation
- `Skipped` means the node never started because the run was canceled before it became runnable

Do not invent synonyms like `done`, `success`, or `waiting`.

## Node Visual Language

Node cards should be compact and utilitarian.

- `agent`: header label plus harness badge
- `exec`: command-focused label plus repo badge
- `check`: stronger visual boundary and explicit pass/fail slot

Node cards always show:

- human label
- canonical kind
- current status
- latest duration or execution badge when relevant

Node cards never show:

- long prompt bodies
- raw logs
- giant badges

Those belong in the inspector.

## Timeline and Logs

The lower-row tiles handle detail without hijacking the page.

### Event timeline

- reverse chronological list
- timestamp, event type, node label, short summary
- filterable by node and event type
- clicking an event selects the related node

### Log tile

- defaults to the selected node's latest execution
- separate stdout and stderr tabs
- fixed-width typography
- minimal decoration
- tail mode reads the current `stdout.log` and `stderr.log`, not event payloads

Artifacts sit beside logs as an indexed file list, not a full file browser by default.

## Empty and Failure States

The UI should be blunt when state is incomplete.

- no graph selected: show the picker and a short explanation of required inputs
- validation failed: keep authored preview visible and pin diagnostics beside it
- compilation failed: show authored view plus partial compiled payload if the compiler returned one
- run failed before node start: show preflight failure details in the monitor header
- live stream unavailable: continue with polling and label the monitor as non-live

## Route Model

Lean release routes:

- `/`: launchpad
- `/graphs/inspect?path=...`: static graph inspection
- `/runs/:runId`: live or historical monitor

No separate route is needed for node details. Selection state stays inside the current surface.

## UI Contract to Backend

The UI expects the server to provide:

- graph inspection payload with authored graph, compiled graph, launch resolution, and diagnostics
- run summary payload with status counts and timestamps
- compiled graph plus runtime overlay and `snapshot_seq`
- node detail payload keyed by `compiled_id`
- append-only event reads with `after_seq`
- log file metadata and tail reads for selected executions
- artifact metadata and file paths for selected executions

The browser should not reconstruct graph semantics from raw filesystem reads.
