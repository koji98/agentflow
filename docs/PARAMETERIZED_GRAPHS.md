# Parameterized Graphs

Top-level graph config lets a single graph be reused across runs without editing JSON. It generalizes the same `config` and `config_schema` mechanism that plugin workflows already use, but at the document root.

## Why

A reusable feature-shipping workflow rarely runs with identical inputs. Real shipping flows differ by:

- branch name, target repository, or PR number
- commit message or release notes template
- which test command, lint command, or service to spin up
- environment-specific paths or feature flags

You could fork the graph for each variant, but that fragments operational knowledge. Top-level config keeps the graph stable and shifts variation to a small declared surface.

## Graph Surface

Two new optional fields on `AuthoredGraphDocument`:

- `config`: an object of named values. Strings, numbers, booleans, arrays, and nested objects are allowed. Defaults declared in the graph file.
- `config_schema`: an object schema validated against the merged config. Same subset Agentflow already supports for plugin workflows: `type: "object"`, `required`, `properties.<name>.type`, and optional `additionalProperties: false`.

Strings anywhere in the document (outside of `$.config` and `$.config_schema` themselves) can interpolate values with `{{config.key}}` or `{{config.nested.key}}`.

```json
{
  "version": "1",
  "graph_id": "ship-feature",
  "config_schema": {
    "type": "object",
    "properties": {
      "branch": { "type": "string" },
      "tests_command": { "type": "string" }
    },
    "required": ["branch"]
  },
  "config": {
    "branch": "main",
    "tests_command": "npm test -- --runInBand"
  },
  "repos": { "main": { "path": "." } },
  "defaults": { "launch_profile": "default" },
  "profiles": { "default": { "harness": "codex-cli" } },
  "graph": {
    "type": "sequence",
    "id": "root",
    "steps": [
      {
        "type": "exec",
        "id": "checkout",
        "command": "git",
        "args": ["checkout", "-b", "{{config.branch}}"]
      },
      {
        "type": "check",
        "id": "tests",
        "check_kind": "deterministic",
        "command": "bash",
        "args": ["-lc", "{{config.tests_command}}"]
      }
    ]
  }
}
```

## CLI Overrides

`agentflow run` and `agentflow validate` (with or without `--show-compiled`) accept config overrides:

- `--config key=value` (repeatable). Dotted keys (`pr.number=42`) build nested objects.
- `--config-file <path>` loads a JSON object and uses it as a base layer; later `--config` flags merge on top of it.

JSON-vs-string parsing: a value parses as JSON when it looks unambiguously like JSON: `true`, `false`, `null`, a number, or starts with `{`, `[`, or `"`. Everything else stays a literal string. That keeps simple values like `--config branch=feature/login` ergonomic without quoting, and complex values like `--config labels='["bug","p0"]'` work too.

The merge order is:

1. `document.config` (defaults from the graph file)
2. `--config-file <path>` (entire object)
3. each `--config key=value` flag in argv order

After the merge, the loader:

1. Validates the merged object against `document.config_schema` if present
2. Rewrites every `{{config.x}}` placeholder in the document
3. Expands plugin workflows (which see fully-resolved `config` blocks on their plugin nodes)
4. Normalizes and validates the final graph

## Diagnostics

The loader emits structured `GraphDiagnostic` entries for the common authoring mistakes:

- Missing required key under `config_schema.required`
- Unknown key when `config_schema.additionalProperties` is `false`
- Property type mismatch
- A `{{config.x}}` placeholder whose `x` is not present in the merged config

Diagnostics surface through the same `validate` (with or without `--show-compiled`) and `run` outputs that already report graph diagnostics, so existing tooling and CI scripts pick them up without changes.

## Cascading Into Plugins

Plugin workflows already validate their own `config` against a per-workflow schema. Because top-level interpolation runs before plugin expansion, a plugin node's `config` field can forward values from the top-level config:

```json
{
  "type": "plugin",
  "id": "prepare_change",
  "uses": "team/dev-change-prep",
  "config": {
    "branch": "{{config.branch}}",
    "test_command": "{{config.tests_command}}"
  }
}
```

The plugin sees its `branch` and `test_command` already resolved. Each plugin still defines its own surface; nothing leaks unintentionally.

## Recommended Conventions

- Prefer flat keys for branch, command, and label-style values; nest only when a logical group exists (`pr.number`, `pr.target_branch`).
- Always declare a `config_schema` for graphs you share with other people, even a permissive one. It documents the contract.
- Keep defaults in the graph file so `agentflow run --graph ...` stays runnable with no flags.
- Use `--config-file` for environment- or persona-specific bundles that you check in next to the graph (for example, `agentflow.config.shipping.json`).
