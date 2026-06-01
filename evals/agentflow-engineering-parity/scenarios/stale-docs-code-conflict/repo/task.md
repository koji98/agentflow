# Retry Delay Contract

`npm test` fails and the local docs disagree with the expected behavior. Treat the test as the source of truth for the current product contract.

Update `src/retry.js` and `docs/retry-policy.md` so:

- numeric `Retry-After` header values are interpreted as seconds;
- the exported function name stays the same;
- the docs explain the seconds-based contract and the millisecond return value.

Run `npm test` and include the command result in your handoff.
