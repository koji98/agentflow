# Resume Reference

`resume` recompiles the original graph and preserves passed work only when:

1. the compiled executable contract still matches

## What invalidates preservation

- compiled node contract changes
- repeat scope shape changes
- unfinished repeat scopes

## What does not invalidate preservation

- explicit file-input content changes
- glob content changes
- glob match-set changes
- harness instruction changes
- unrelated repo changes

## Operator implication

If a passed node was preserved unexpectedly, check the recompiled node contract first. In this release, Agentflow does not invalidate preservation from mutable workspace content.
