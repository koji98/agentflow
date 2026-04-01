High-value UX choices
- In-app filesystem browser with hidden-folder visibility makes plan/run selection fast without native pickers.
- Graph-first layout keeps the run legible; node selection drives artifacts/logs instead of a log wall.
- SSE-based updates for run state, decisions, and log tail keep UI responsive with low complexity.
- Run settings surface risk clearly for `danger-full-access` sandbox.

Known limitations
- Graph layout is linear for v1; complex branching/parallel layout can be improved.
- Artifacts preview is text-first; binary previews can be added.
- No run list yet; open via file browser for now.
Gaps to validate next
- Ensure SSE bus removal on cancel/exit (avoid emitter leaks).
- Add server ping heartbeats for long-lived SSE.
- Surface loop_judge in the graph node type explicitly (badge + threshold).
- Add a compact loop_judge details panel (pass threshold, latest score, iteration) fed from decision_trace).
