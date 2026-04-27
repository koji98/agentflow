# Runtime Tooling

This page explains how Agentflow injects runtime tools into an agent node, what appears in the harness context window, and how plugin tools resolve config and credentials without exposing secrets to the model.

## What The Harness Receives

Before launching a Codex CLI or Cursor CLI agent node, Agentflow builds one `AgentInvocation` contract. The harness adapter renders that into a prompt and process environment.

```mermaid
flowchart TD
  compiled["Compiled agent node"] --> setup["prepareAgentTools"]
  compiled --> context["resolveExecutionContext"]
  setup --> bin["agentflow-tools/bin"]
  setup --> metadata["runtime.json and credential-config.json"]
  context --> packet["context packet and manifest"]
  bin --> env["Harness env and PATH"]
  metadata --> env
  packet --> prompt["Rendered harness prompt"]
  compiled --> prompt
  env --> harness["Codex CLI or Cursor CLI"]
  prompt --> harness
```

The harness prompt includes:

- role and node task
- graph goal, acceptance criteria, and constraints when present
- workspace path, output directory, sandbox, and timeout expectations
- context manifest plus paths to `packet.json` and `provenance.json`
- `af` runtime CLI instructions
- declared artifact contract
- short plugin tool selection hints
- validation and final handoff expectations

The harness environment includes:

- `AGENTFLOW_WORKSPACE`
- `AGENTFLOW_OUTPUT_DIR`
- `AGENTFLOW_CONTEXT_PACKET`
- `AGENTFLOW_CONTEXT_MANIFEST`
- `AGENTFLOW_RUNTIME_METADATA`
- `AGENTFLOW_TOOL_STATE`
- run/node identity values such as `AGENTFLOW_RUN_ID`, `AGENTFLOW_AGENT_ID`, and `AGENTFLOW_NODE_ID`
- a `PATH` with the generated tool directory prepended

It explicitly does not include `AGENTFLOW_CREDENTIAL_*` values or raw `AGENTFLOW_TOOL_<NAME>_<KEY>` config values.

## Generated Tool Directory

For each agent execution, Agentflow creates:

```text
<execution-dir>/agentflow-tools/
  bin/
    af
    <plugin-callable-name>
  launcher.mjs
  runtime.json
  state.json
  credential-config.json
```

`bin/af` is a generated wrapper around Agentflow's runtime CLI implementation. Plugin callable files in `bin/` are generated shell wrappers that execute `launcher.mjs <tool-name> "$@"`.

The generated `bin/` directory is prepended to `PATH` only for that node attempt. A downstream or helper node gets its own generated directory and metadata.

## Prompt Tool Contract

Plugin tools are described to the agent as short selectable CLIs, not as fully inlined API docs. The prompt includes each callable name, plugin origin, description, credential scope names, and configured default keys. It tells the agent to run:

```bash
<tool> --help
```

before first use when exact arguments, defaults, output shape, exit codes, examples, or safety notes matter.

This keeps the context window small and makes the executable's own `--help` the source of truth. It also lets the same graph work across Codex CLI and Cursor CLI because both harnesses receive the same tool contract and generated `PATH`.

## Plugin Tool Invocation

```mermaid
sequenceDiagram
  participant Agent
  participant Wrapper as generated tool wrapper
  participant Launcher as launcher.mjs
  participant Index as credential index
  participant Keychain
  participant Tool as plugin executable
  participant Ledger as tool-invocations.jsonl

  Agent->>Wrapper: babysit-poll --pr 42
  Wrapper->>Launcher: node launcher.mjs babysit-poll --pr 42
  Launcher->>Launcher: scrub credential/tool env from inherited env
  Launcher->>Index: read non-secret credential metadata
  Launcher->>Keychain: read secret fields only if needed
  Launcher->>Tool: spawn executable with config and credential env
  Tool-->>Launcher: stdout/stderr/exit code
  Launcher->>Ledger: append redacted invocation record
  Launcher-->>Agent: forward stdout/stderr/exit code
```

The generated launcher has two paths:

- Help path: if args include `--help` or `-h`, it runs the tool without resolving credentials, injects only non-secret config defaults, appends an `Agentflow configured defaults` section, and records a redacted invocation.
- Invocation path: it reads non-secret config, resolves declared credential scopes, injects `AGENTFLOW_TOOL_<CALLABLE>_<KEY>` and `AGENTFLOW_CREDENTIAL_<SCOPE>_<FIELD>` only into the plugin subprocess, writes stdout/stderr sidecar logs, and appends a redacted ledger entry.

The agent sees tool stdout/stderr and exit code. It does not see secret values unless the plugin executable itself prints them, which plugin authors must avoid.

## Credential Isolation

Secret values are configured with `agentflow auth` and stored in macOS Keychain. The local credential index stores metadata and non-secret fields. At runtime:

1. The compiled graph records which credential scopes a granted tool requires.
2. `prepareAgentTools` writes `credential-config.json` with credential specs and tool metadata, but not secret values.
3. `buildHarnessSpawnEnv` removes any inherited `AGENTFLOW_CREDENTIAL_*` and `AGENTFLOW_TOOL_*` values before launching the harness.
4. The generated launcher resolves credentials only when a plugin tool subprocess runs.
5. Invocation ledgers redact secret-looking argv values and omit credential env values.

```mermaid
flowchart LR
  auth["agentflow auth"] --> keychain["macOS Keychain\nsecret values"]
  auth --> index["credential index\nmetadata and non-secrets"]
  graph["Graph tool declaration"] --> compiled["compiled credential specs"]
  compiled --> launcher["generated launcher"]
  index --> launcher
  keychain --> launcher
  launcher --> child["plugin subprocess env"]
  harness["agent harness env"] -. no secrets .-> child
```

## Runtime CLI `af`

`af` is injected beside plugin tools because it is part of the same per-attempt runtime contract. It reads `$AGENTFLOW_RUNTIME_METADATA`, which points at `runtime.json`.

Common commands:

- `af status`: inspect run, node, workspace, output directory, sandbox, declared artifacts, and granted tools.
- `af context show`: print the materialized context manifest and packet path.
- `af tools list`: show the granted plugin tools.
- `af artifact list|write`: publish declared artifacts.
- `af log --type ...`: append structured worker evidence to `runtime/log.jsonl`.
- `af spawn` and `af wait`: manage supervised helper sub-nodes with their own metadata and artifacts.

The runtime CLI is file-backed. It coordinates through the run root and runtime directory, not through a live in-memory service exposed to the model.

## Tool Invocation Evidence

Generated wrappers write `tool-invocations.jsonl` under the node execution directory. Invocation records include:

- run, graph, agent, execution, node, and compiled ids
- tool callable name and source
- redacted argv
- cwd
- exit code and duration
- stdout/stderr sidecar paths for normal invocations
- redaction note

Those records feed debugging and delivery evidence. They are not the main handoff; durable handoffs still belong in declared artifacts.

## Practical Consequences

- Adding a plugin tool to a graph is operator approval to expose that CLI to eligible nodes.
- The plugin manifest describes selection and auth/config needs; `--help` describes exact CLI usage.
- Config values are graph-provided defaults for the tool subprocess, not agent prompt variables.
- Credentials stay out of the harness context window and environment.
- Tool behavior is auditable through wrapper ledgers and sidecar logs.
