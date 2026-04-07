# Resume Reference

`resume` recompiles the original graph and preserves passed work only when:

1. the compiled executable contract still matches
2. the resolved context provenance still matches

## What invalidates preservation

- explicit file-input content changes
- glob content changes
- glob match-set changes
- harness instruction changes for harnessed nodes:
  - `AGENTS.md`
  - `CLAUDE.md`
  - `.cursorrules`
  - `.cursor/rules/**`

## What does not invalidate preservation

- unrelated repo changes that do not affect the node's explicit inputs or harness instruction provenance

## Older runs

If the prior passed execution does not have `context_provenance.json`, Agentflow restarts that node instead of preserving it.
