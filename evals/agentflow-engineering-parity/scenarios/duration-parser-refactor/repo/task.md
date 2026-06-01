# Duration Parser Refactor

`npm test` fails because `parseDurationMs` only handles minutes and duplicates fragile parsing logic.

Refactor `src/duration.js` so:

- `250ms`, `2s`, `3m`, and `1h` are converted to milliseconds;
- whitespace around the input is ignored;
- invalid inputs throw a useful error;
- the implementation stays small and avoids one-off parsing branches for every unit.

Run `npm test` and include the command result in your handoff.
