# Auth

Agentflow has its own credential system for plugin tools. Plugins declare the credentials they need; the CLI stores secrets in the local OS keychain; and the runtime injects resolved values into the agent's environment so plugin tools can authenticate without baking secrets into graphs.

This release supports macOS only and assumes a single human operator. CI environments and shared multi-user machines are out of scope.

## When To Use Credentials

Credentials are for upstream API access that a plugin tool needs at runtime. A typical case: a plugin ships a `babysit-poll` CLI that calls a REST API requiring a personal access token. Without credentials, every consumer graph would have to hand-wire the secret through `tool_config`, which makes secrets visible in graph files and lockfiles.

Use credentials when:

- the value is sensitive and must not appear in a graph file
- the same value is reused across many runs and graphs
- the upstream system supports a verifiable token (PAT, API key) that a single human can rotate

Do not use credentials for non-secret configuration. Plain `tool_config` is the right answer for things like API base URLs that are not sensitive and that may legitimately differ per graph.

## Plugin Manifest: `credentials` Block

A plugin declares credentials in `agentflow.plugin.json` alongside `tools` and `workflows`:

```json
{
  "schema": "agentflow.plugin/1",
  "id": "babysit",
  "version": "1.0.0",
  "tools": {
    "poll": {
      "executable": "scripts/poll-pr.sh",
      "description": "Poll a GitHub PR.",
      "credentials": ["babysit_pat"]
    }
  },
  "credentials": {
    "babysit_pat": {
      "scope": "babysit",
      "description": "Personal access token for the babysit API.",
      "fields": [
        { "key": "token", "secret": true, "required": true },
        { "key": "host", "secret": false, "required": false, "default": "https://api.example.com" }
      ],
      "login": {
        "type": "pat-paste",
        "open_url": "https://example.com/settings/tokens",
        "instructions": "Create a token with `repo` scope and paste it below.",
        "verify": {
          "method": "GET",
          "url": "{host}/whoami",
          "auth": {
            "kind": "header",
            "header_name": "Authorization",
            "header_value_template": "Bearer {token}"
          },
          "ok_when_status": 200,
          "extract_identity": "$.login"
        }
      }
    }
  }
}
```

Field rules:

- `scope` (lowercase, `[a-z0-9-]`): the global scope name. Two plugins MAY share a scope to reuse the same stored credential (for example a shared `github` scope).
- `fields[]`: each field has a `key` (lowercase, `[a-z][a-z0-9_]*`), a `secret` flag, a `required` flag, and an optional `default`. Secret fields are stored in the macOS Keychain; non-secret fields are stored in plain text in the index file.
- `login.type` is `pat-paste` in this release. The CLI opens `open_url` in the browser if present, prints `instructions`, and prompts for each field.
- `login.verify` describes how to validate the credential against the upstream API. The supported `auth.kind` values are `header` (single header with `header_value_template`) and `basic` (HTTP Basic with `username_template` and `password_template`). Templates use `{field_key}` tokens that are substituted from the resolved field values. `extract_identity` is an optional JSONPath used to extract a human-readable identity (account login, email) from the verify response.

A tool opts into a credential by listing the credential id in its `credentials` array. Multiple tools may share a credential, and a tool may declare multiple credentials.

## CLI: `agentflow auth`

The CLI manages credentials interactively. All subcommands require `--graph <path>` so they can resolve plugin manifests and credential declarations from a real graph context. There is no global credential store decoupled from a graph.

```text
agentflow auth login --graph <path> --scope <scope>
agentflow auth list --graph <path>
agentflow auth status --graph <path> --scope <scope>
agentflow auth logout --graph <path> --scope <scope>
agentflow auth set --graph <path> --scope <scope> --key <field>
```

Behavior summary:

- `login` resolves the credential declaration for `--scope`, prompts for each field (hidden input for secret fields), runs the declared `verify` request, and on success stores the values (secrets in Keychain, non-secrets in the index) plus the extracted identity and verification timestamp.
- `list` enumerates every scope stored locally, with the identity, the last verification time, and the field keys. Secret values are never printed.
- `status` re-runs `verify` against currently stored values and reports whether the credential still works upstream.
- `logout` deletes the stored values for a scope from both the index and the Keychain.
- `set` updates a single field in place and re-runs `verify`. Use this to rotate a token without re-entering every field.

Exit codes:

- `0` for success and for `status` when the credential verifies.
- `1` for verify failures, missing required fields after prompting, or scope-not-declared errors.
- `2` for input or schema errors that prevented the command from running.

## Storage Layout

Per-host state lives under `~/.agentflow/`:

- `~/.agentflow/credentials.index.json` — non-secret metadata: declared scopes, field keys, identity, `stored_at`, `last_verified_at`. Mode `0600`.
- macOS Keychain entries — secret field values stored under service `agentflow:<scope>` and account `<field_key>`. The CLI uses the `security` binary directly; no third-party keychain library is required.

The index file is the source of truth for "what scopes exist and which fields are stored". The Keychain is the source of truth for secret values. Losing the index but keeping the Keychain leaves the secrets recoverable but orphaned from the user's view of which scopes exist.

## Resolution Order

When the runtime needs a credential field for a scope, it resolves in this order:

1. Process environment variable `AGENTFLOW_CREDENTIAL_<SCOPE>_<KEY>` (uppercased, hyphens become underscores). This is the override path for ad-hoc and one-off runs.
2. Stored value in the index (non-secret fields) or the Keychain (secret fields).
3. The field's `default` from the plugin manifest, if any.
4. Otherwise the field is "missing".

If a `required` field is missing for a scope used by the graph, validation and runtime both fail with a `MissingCredentialsError`. Optional fields that are missing are simply not exported.

## Runtime Injection

For each agent node, before the harness subprocess is spawned, the runtime:

1. Walks `node.tools[].credentials_required` to compute which scopes the node needs.
2. For each scope, looks up the field metadata in the compiled graph's `credential_specs` map (built at compile time from resolved plugin manifests).
3. Resolves each field via the order above.
4. Exports `AGENTFLOW_CREDENTIAL_<SCOPE>_<KEY>=<value>` for every resolved field into the harness env, alongside `AGENTFLOW_TOOL_*` and `AGENTFLOW_PLUGIN_ROOT_*`.
5. Throws `MissingCredentialsError` if any required field is missing for any required scope. The error message names every missing scope and the `agentflow auth login` command to fix it.

Plugin tool scripts read these environment variables directly. Tools should not assume any specific storage format and should never try to read the Keychain or the index themselves.

## Validation Hook

`agentflow validate --run-ready --graph <path>` evaluates credential readiness as part of the machine-readiness checks. Each scope used by the graph appears as a `kind: "credential"` check in the readiness report:

- `passed` when every required field for the scope resolves to a non-empty value.
- `blocked` when at least one required field is missing. The check message names the missing keys and the `agentflow auth login <scope>` command to run.

`validate` without `--run-ready` does not call the OS Keychain. It still surfaces schema errors in the manifest's `credentials` block so that broken declarations are caught before they reach a real run.

## Operator Safety Notes

- Secrets are stored in the macOS Keychain, not in the graph or in run artifacts. Run artifacts include the index of *which* credential scopes the run consumed but never the secret values.
- The `agentflow auth` CLI never prints secret field values. `agentflow auth list` and `status` show only the identity and the field keys.
- The environment variables exported into the harness subprocess (`AGENTFLOW_CREDENTIAL_*`) are visible to the agent harness child process and to plugin tools spawned from it. Treat the harness sandbox the same way you would treat any process holding a token.
- Rotating a token is `agentflow auth set --scope <scope> --key token` followed by re-verification. Logout-then-login also works and is the preferred path when rotating identity.

## Out Of Scope For This Release

The credential system intentionally does not yet cover:

- non-macOS hosts (Linux/Windows credential stores)
- non-interactive CI environments and machine-to-machine credential issuance
- OAuth device flow or SSO-based logins; the only login type is `pat-paste`
- shared team credential vaults or remote secret managers
- credential rotation policy or expiry enforcement

These are tracked in `docs/DEFERRED.md`. The design keeps the storage and resolution layers small enough that adding new login types or backends later does not require breaking changes to plugin manifests or to the runtime injection contract.
