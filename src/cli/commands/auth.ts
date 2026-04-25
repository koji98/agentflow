import {
  renderCommandUsageError
} from "../command_support.js";
import { createCredentialStore } from "../../auth/store.js";

function renderAuthUsageError(message: string): string {
  return renderCommandUsageError({
    message,
    commandName: "auth",
    usage: authCommand.usage
  });
}

function readStringOption(
  options: Record<string, string | boolean | string[] | undefined>,
  name: string
): string | undefined {
  const value = options[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function readValueFromStdin(): Promise<string> {
  let value = "";
  for await (const chunk of process.stdin) {
    value += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  }
  return value.replace(/\r?\n$/, "");
}

export const authCommand = {
  name: "auth",
  summary: "Configure credential fields for plugin tools without exposing secret values to agent harnesses.",
  usage:
    "agentflow auth <set|delete|list> [--scope <scope> --key <field> --value <value> --value-stdin --secret] [--index <path>]",
  examples: [
    "printf %s \"$GITHUB_TOKEN\" | agentflow auth set --scope github --key token --secret --value-stdin",
    "agentflow auth set --scope github --key host --value api.github.com",
    "agentflow auth list"
  ] as const,
  optionNames: ["scope", "key", "value", "value-stdin", "secret", "index", "help"] as const,
  helpNotes: [
    "Secret fields are written to macOS Keychain; the local index stores only metadata.",
    "Credential values are resolved by generated plugin-tool launchers, not exported into Codex or Cursor harness environments.",
    "Use non-secret fields only for public routing values such as hosts, org slugs, or deployment names."
  ] as const,
  async run(
    options: Record<string, string | boolean | string[] | undefined>,
    _currentWorkingDirectory: string,
    _signal?: AbortSignal,
    positionals: readonly string[] = []
  ) {
    const subcommand = positionals[0];
    if (!subcommand || positionals.length > 1 || !["set", "delete", "list"].includes(subcommand)) {
      return {
        exitCode: 2,
        stdout: renderAuthUsageError(
          subcommand
            ? `Unexpected auth subcommand or positional arguments: ${positionals.join(", ")}`
            : "Missing auth subcommand."
        )
      };
    }

    const indexPath = readStringOption(options, "index");
    const store = createCredentialStore({
      ...(indexPath ? { index_path: indexPath } : {})
    });

    if (subcommand === "list") {
      return {
        exitCode: 0,
        output: {
          command: "auth list",
          status: "passed",
          index_path: store.index_path,
          credentials: await store.listMetadata()
        }
      };
    }

    const scope = readStringOption(options, "scope");
    const key = readStringOption(options, "key");
    if (!scope || !key) {
      return {
        exitCode: 2,
        stdout: renderAuthUsageError("Missing required options: --scope and --key")
      };
    }

    if (subcommand === "delete") {
      await store.deleteField(scope, key);
      return {
        exitCode: 0,
        output: {
          command: "auth delete",
          status: "passed",
          index_path: store.index_path,
          scope,
          key
        }
      };
    }

    if (options.value !== undefined && options["value-stdin"] === true) {
      return {
        exitCode: 2,
        stdout: renderAuthUsageError("Use either --value or --value-stdin, not both.")
      };
    }

    const secret = options.secret === true;
    if (secret && options.value !== undefined) {
      return {
        exitCode: 2,
        stdout: renderAuthUsageError("Secret values must be provided with --value-stdin, not --value.")
      };
    }

    const value = options["value-stdin"] === true
      ? await readValueFromStdin()
      : readStringOption(options, "value");
    if (value === undefined) {
      return {
        exitCode: 2,
        stdout: renderAuthUsageError("Missing required option: --value")
      };
    }

    await store.setField({
      scope,
      key,
      value,
      secret
    });

    return {
      exitCode: 0,
      output: {
        command: "auth set",
        status: "passed",
        index_path: store.index_path,
        scope,
        key,
        secret
      }
    };
  }
};
