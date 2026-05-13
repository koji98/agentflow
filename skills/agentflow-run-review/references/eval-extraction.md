# Eval Extraction

Extract an eval scenario when a run exposes a behavior that should not regress.

Good eval candidates:

- A brittle deterministic check pattern that future authors may repeat.
- A recurring missing-context failure.
- A supervisor recovery class that should improve or remain stable.
- A plugin tool contract that must produce stable outputs.
- A delivery reviewability failure.
- A prompt or managed-pattern behavior that should be compared across variants.

Avoid evals for one-off environment failures unless the environment behavior is intentionally simulated.

For eval suite authoring, use `agentflow-evals`.
