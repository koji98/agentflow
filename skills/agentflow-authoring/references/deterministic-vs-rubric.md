# Deterministic Checks vs Rubrics

Main rule: deterministic checks validate stable outcomes, not guessed implementation tactics.

## Use Deterministic Checks For

- Existing test commands.
- Typecheck, build, lint, format-check, smoke scripts.
- Schema or JSON validation for explicitly required artifacts.
- Commands that are valid regardless of the agent's chosen implementation path.

## Use Rubrics, Artifacts, Or Review Nodes For

- Architecture fit.
- Maintainability.
- Correctness where no stable command exists.
- Handoff quality.
- Whether the agent chose a reasonable implementation path.
- Review of changes that may be valid in multiple shapes.

## Brittle Check Smells

- The command expects a script the agent may not create.
- The command checks exact internal structure when several implementations are acceptable.
- The command encodes the graph author's imagined solution.
- The command is really a reviewer opinion expressed as a shell script.

If a script is itself the deliverable, declare it as an artifact and acceptance criterion. If it is only one possible tactic, do not make it a check.
