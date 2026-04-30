# tool-discipline

Rate this Agentflow workflow trial on the named dimension.
Focus on whether tools were used only when appropriate, tool output changed behavior when required, and no tool result was invented.

Use only the scenario expectations, trace packet, artifacts, decision logs, supervisor evidence, and delivery metadata in the packet.
Do not reward a run for facts that are not present in the packet.
Return strict JSON matching the requested schema.

Anchors:
- 5: correct, concise, auditable, and uses context/tools/supervision appropriately.
- 4: correct with minor evidence, concision, or auditability gaps.
- 3: hard outcome may pass, but workflow quality is weak or hard to review.
- 2: significant quality issue even if some hard facts passed.
- 1: missed contract, used unsupported authority, produced placeholder artifacts, ignored required evidence, or lacks usable audit evidence.
