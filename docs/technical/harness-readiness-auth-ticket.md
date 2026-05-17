# Future Ticket: Harness Readiness And Auth Contract

## Goal

Define one adapter-owned readiness contract for Codex and Cursor harness authentication. Missing harness auth should pause only through trusted typed runtime metadata, never through stdout or stderr text parsing.

## Requirements

- Add explicit readiness checks for Codex and Cursor auth state.
- Emit `AuthorityRequest` with `kind: "missing_harness_auth"` only from trusted adapter/readiness metadata.
- Do not parse agent output, stdout, stderr, verifier text, or helper text to infer auth state.
- Do not read, copy, log, or expose secret auth contents.
- Keep graph/sandbox/repo/scope/product ambiguity as recovery or contractual failure, not human pause.

## Tests

- Auth text in stdout/stderr does not pause without trusted metadata.
- Missing Codex auth produces typed readiness metadata in local tests.
- Cursor behavior is covered by local adapter mocks so the contract is testable without Cursor installed.
- Trusted `missing_harness_auth` pauses with a clear unblock request.
