# Pairwise Implementation Quality

Judge two anonymized attempts on the same local engineering task.

Prefer the candidate that:

- satisfies the task and hidden oracle evidence;
- passes the requested validation command;
- changes only necessary files;
- keeps the implementation simple and maintainable;
- gives a useful handoff with validation evidence and risks.

If both candidates are equivalent on implementation quality, prefer the one with better evidence and reviewability. Deterministic validation failures are blockers and cannot be overcome by a nicer handoff.
