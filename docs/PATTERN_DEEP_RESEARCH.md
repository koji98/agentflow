# Pattern Deep Research

`pattern_deep_research` turns a research question into a sourced, reviewable research package.

Use it when a team needs grounded discovery before design or implementation: technical comparison, roadmap shaping, architecture research, operational risk analysis, or product behavior investigation.

## Contract

Required fields:

- `type`: `"pattern_deep_research"`
- `id`
- `brief.question`
- `brief.objective`

Common fields:

- `repo`
- `profile`
- `context`
- `context_policy`
- `approval_policy.require_plan_approval`
- `strategy.depth`
- `strategy.coverage_mode`
- `strategy.followup_passes`
- `strategy.final_critique`
- `delivery.sections`
- `runtime.max_concurrency`

## Published Artifacts

- `research_report`: human-readable recommendation.
- `research_packet`: machine-readable summary of question, findings, evidence, and recommendation.
- `source_ledger`: cited or inspected source list.
- `uncertainties`: remaining unknowns and confidence limits.
- `interim_findings`: JSONL trail of investigator findings.

## Runtime Shape

The pattern lowers into a sequence that:

1. Clarifies the brief.
2. Plans research.
3. Optionally pauses for plan approval.
4. Fans out investigator tracks.
5. Runs follow-up passes for gaps or contradictions.
6. Consolidates evidence.
7. Optionally runs a final critique.
8. Publishes the research package.

## Example

```json
{
  "type": "pattern_deep_research",
  "id": "storage_research",
  "repo": "main",
  "profile": "research",
  "brief": {
    "question": "Which storage design best supports resumable supervised runs?",
    "objective": "Recommend an implementation path with tradeoffs and uncertainty.",
    "audience": "engineering",
    "scope_cues": ["runtime artifacts", "resume", "event projection"],
    "success_bar": ["compare alternatives", "preserve uncertainty"]
  },
  "context_policy": {
    "web": true,
    "files": true,
    "apps": false,
    "allow_domains": ["openai.com", "developers.openai.com"]
  },
  "strategy": {
    "depth": "standard",
    "coverage_mode": "balanced",
    "followup_passes": 1,
    "final_critique": true
  },
  "delivery": {
    "sections": ["findings", "recommendation", "uncertainties"]
  }
}
```

Validate with `agentflow validate --graph <path> --show-compiled` and inspect the lowered research phases before launch.
