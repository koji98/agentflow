# Settings Schema Defaults

`npm test` fails because `normalizeSettings` passes input through without applying defaults or validating values.

Update `src/settings.js` so:

- missing `theme` defaults to `"system"`;
- valid themes are `"light"`, `"dark"`, and `"system"`;
- missing `emailNotifications` defaults to `true`;
- non-boolean `emailNotifications` values are rejected;
- the original input object is not mutated.

Run `npm test` and include the command result in your handoff.
