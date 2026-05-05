# Prompt Iteration Reports

Prompt iteration is a release-gated loop:

1. Freeze one prompt surface.
2. Run a baseline eval cluster.
3. Change one prompt class.
4. Rerun the cluster.
5. Run prompt regression gates.
6. Publish the decision and evidence.

Use `prompt-iteration-template.md` for new reports.

## Reports

- `prompt-iteration-2026-04-29.md`: first real `codex-cli` capability prompt/context tuning pass.
- `prompt-iteration-2026-05-04.md`: prompt-regression release gate introduction and completion-contract hardening pass.
