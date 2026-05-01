# Current API Fixture

For API client migration, use the v2 stable request envelope:

```json
{
  "transport": "stableRequest",
  "version": "2026-04",
  "request": { "method": "POST", "path": "/resource", "json": {} }
}
```

For stale docs conflict scenarios, use `mode: stable-v2`.
