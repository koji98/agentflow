# Prompt Iteration Template

Use this template for every prompt change that affects agent behavior.

## Summary

- Date:
- Prompt surface:
- Renderer:
- Failure mode:
- Candidate change:
- Promotion decision:

## Baseline

- Eval suite:
- Variant:
- Trials:
- Pass rate:
- Pass at 1:
- Pass at k:
- Blocker rate:
- Average score:
- Timeout rate:
- Tool-call count:
- Token or prompt byte estimate:

## Candidate

- Eval suite:
- Variant:
- Trials:
- Pass rate:
- Pass at 1:
- Pass at k:
- Blocker rate:
- Average score:
- Timeout rate:
- Tool-call count:
- Token or prompt byte estimate:

## Deltas

- Pass-rate delta:
- Blocker-rate delta:
- Score delta:
- Prompt sections changed:
- Prompt byte delta:
- Tool usage delta:
- Runtime duration delta:

## Failure Labels

Classify every failure as one of:

- prompt defect
- graph/task ambiguity
- grader defect
- fixture/environment issue
- runtime defect
- model variance

## Evidence

- Eval roots:
- Failing scorecards:
- Prompt diff report:
- Representative transcripts:
- Tests added:

## Residual Risk

- Remaining prompt risks:
- Evals not run:
- Follow-up scenarios:
