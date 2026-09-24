# Codex file and network permissions

Codex runs in Agentflow have network access by default. Workers, AI judges, and helper agents can reach the internet and start local test servers. You do not need to change your graph to enable this.

File access is a separate choice. A `read-only` judge can run a test server but cannot edit app files. Tests that need to write app files may still fail in a read-only run.

## Turn network access off

Add this setting to the graph profile used by the run or node:

```json
{
  "harness_config": {
    "codex": {
      "config": {
        "permissions.agentflow_judge_permissions.network.enabled": false
      }
    }
  }
}
```

The value must be `true` or `false`. Leaving it out means `true`. AI judges keep this setting even though their other Codex settings are isolated. Helpers inherit the network choice from the parent that starts them.

Network-off requires `read-only` or `workspace-write`. Codex's `danger-full-access` mode has no network sandbox, so Agentflow rejects network-off with that mode before launch.

## How it works

Agentflow uses Codex permission profiles. The graph's `sandbox` chooses its file rules:

| Graph sandbox | Codex base profile | File access |
| --- | --- | --- |
| `read-only` | `:read-only` | Read app files. |
| `workspace-write` | `:workspace` | Read and write within the allowed workspace. |
| `danger-full-access` | `:danger-full-access` (selected directly) | No file or network sandbox. |

For read-only and workspace runs, Agentflow extends the base with a named profile, `agentflow_judge_permissions`, and sets the network choice there. Full-access runs select the built-in profile directly because Codex does not allow extending it. Agentflow does not also pass the older Codex `--sandbox` flag or write older sandbox settings into its temporary config.

Normal workers still inherit the user's other Codex settings. AI judges, outcome verifiers, evidence checks, and delivery reviews still use an isolated Codex config. They keep only the graph profile's network choice from the supplied native config.

The launch code is in `src/runtime/harness/codex_permissions.ts` and `codex_cli.ts`. Direct helper launches use the same permission builder in `src/af/index.ts`. Cursor settings are unchanged.

## CLI support

Use a Codex CLI that supports named permission profiles. This change was checked with Codex CLI 0.144.5 on macOS, including a real local-server test and a blocked source-file write. See [OpenAI's permissions guide](https://learn.chatgpt.com/docs/permissions) for the native settings.

Host or organization rules may still limit network access. Agentflow does not retry with full access if the CLI rejects the permission profile.
