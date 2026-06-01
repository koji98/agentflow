# Frontend Tabs Reducer

`npm test` fails because closing tabs leaves stale selection state.

Update `src/tabs.js` so:

- closing a non-selected tab removes it and preserves the selected tab;
- closing the selected tab selects the next tab when possible, otherwise the previous tab;
- closing the final tab leaves `selectedId` as `null`;
- reducer operations do not mutate the previous state.

Run `npm test` and include the command result in your handoff.
