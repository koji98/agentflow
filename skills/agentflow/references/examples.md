# Examples

Repository examples live in `docs/examples/graphs/`.

Use:

```bash
agentflow validate --graph docs/examples/graphs/feature-showcase.json
agentflow validate --graph docs/examples/graphs/feature-showcase.json --show-compiled
```

Plugin tool example:

```bash
agentflow plugin resolve --graph docs/examples/graphs/ship-feature.graph.json
agentflow validate --graph docs/examples/graphs/ship-feature.graph.json --run-ready
```

## Minimal Primitive Skeleton

```json
{
  "version": "1",
  "graph_id": "example",
  "intent": {
    "goal": "Implement a focused change.",
    "acceptance_criteria": ["The change is tested and reviewable."]
  },
  "profiles": {
    "default": {
      "harness": "codex-cli",
      "sandbox": "workspace-write"
    }
  },
  "graph": {
    "type": "sequence",
    "id": "root",
    "steps": [
      {
        "type": "agent",
        "id": "implement",
        "goal": "Implement the focused change and write $AGENTFLOW_OUTPUT_DIR/change-summary.md.",
        "artifacts": {
          "change_summary": {
            "from": "output_dir",
            "path": "change-summary.md",
            "description": "Implementation summary."
          }
        }
      },
      {
        "type": "check",
        "id": "test",
        "check_kind": "deterministic",
        "command": "npm",
        "args": ["test"]
      }
    ]
  }
}
```

## Codex And Cursor

Use the same graph and switch launch profiles:

```json
{
  "profiles": {
    "codex": { "harness": "codex-cli", "sandbox": "workspace-write" },
    "cursor": { "harness": "cursor-cli", "sandbox": "workspace-write" }
  },
  "defaults": { "launch_profile": "codex" }
}
```

Both harnesses receive the same Agentflow context, artifacts, tools, timeout, and delivery contract.
