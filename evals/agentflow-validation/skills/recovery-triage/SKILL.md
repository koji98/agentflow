---
name: recovery-triage
description: Triage Agentflow recovery cases by distinguishing missing context, stale docs, validation strategy failure, workspace pollution, and authority pauses.
---

# Recovery Triage

Use this skill only when a node needs to classify recovery evidence. Prefer local trace packets, agent context briefs, and validation logs over broad guessing.

Checklist:

- identify the concrete failing contract
- name the smallest recoverable action
- preserve evidence paths for the handoff
- pause only when authority or credentials are genuinely required
