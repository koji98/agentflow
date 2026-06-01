# API User Filter

`npm test` fails because `listUsers` only filters by role. Update `src/users.js` so callers can combine:

- `role`: exact role filter;
- `active`: accepts boolean values or the strings `"true"` and `"false"`;
- `sort: "name"`: returns users sorted by display name without mutating the original array.

Run `npm test` and include the command result in your handoff.
