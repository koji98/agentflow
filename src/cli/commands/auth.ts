import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

import { collectRequiredScopes, type RequiredScope } from "../../auth/required_scopes.js";
import {
  credentialEnvVarName,
  defaultIndexPath,
  deleteScope as storeDeleteScope,
  getScopeFields,
  listScopes as storeListScopes,
  putScope,
  recordVerification
} from "../../auth/store.js";
import { runVerify, type VerifyResult } from "../../auth/verify.js";
import { compileAuthoredGraph } from "../../graph/compile.js";
import { resolveLaunchConfig } from "../../graph/profiles.js";
import { loadAuthoredGraphDocument } from "../../graph/validate.js";
import type { GraphDiagnostic } from "../../graph/schema.js";
import type {
  PluginCredentialDecl,
  PluginCredentialField,
  ResolvedPlugin
} from "../../plugins/workflows.js";
import { renderCommandUsageError } from "../command_support.js";
import { dirname } from "node:path";

interface AuthStreams {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  stderr: NodeJS.WritableStream & { isTTY?: boolean };
}

export interface AuthCommandHooks {
  streams?: AuthStreams;
  promptValue?: (params: {
    scope: string;
    field: PluginCredentialField;
  }) => Promise<string | undefined>;
  openUrl?: (url: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  index_path?: string;
  account?: string;
  env?: NodeJS.ProcessEnv;
}

let activeHooks: AuthCommandHooks | undefined;

export function setAuthCommandHooksForTesting(hooks: AuthCommandHooks | undefined): void {
  activeHooks = hooks;
}

function effectiveHooks(): AuthCommandHooks {
  return activeHooks ?? {};
}

function effectiveEnv(hooks: AuthCommandHooks): NodeJS.ProcessEnv {
  return hooks.env ?? process.env;
}

function authIndexPath(hooks: AuthCommandHooks): string {
  return hooks.index_path ?? defaultIndexPath();
}

async function defaultPromptValue(
  streams: AuthStreams,
  params: { scope: string; field: PluginCredentialField }
): Promise<string | undefined> {
  const rl = createInterface({
    input: streams.stdin,
    output: streams.stderr,
    terminal: true
  });
  try {
    const promptText = params.field.prompt
      ? `${params.field.prompt}: `
      : `${params.scope}.${params.field.key}: `;
    const value = await rl.question(promptText);
    return value.trim().length > 0 ? value.trim() : undefined;
  } finally {
    rl.close();
  }
}

async function defaultOpenUrl(url: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("open", [url], { stdio: "ignore", detached: true });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
    child.unref();
  });
}

interface ResolvedScopeForLogin {
  scope: string;
  decl: PluginCredentialDecl;
  used_by: string[];
}

interface ResolvedScopesPayload {
  diagnostics: GraphDiagnostic[];
  required_scopes: RequiredScope[];
}

async function resolveRequiredScopesFromGraph(
  currentWorkingDirectory: string,
  graphPath: string
): Promise<ResolvedScopesPayload> {
  const loaded = await loadAuthoredGraphDocument(currentWorkingDirectory, graphPath, {});
  if (!loaded.document) {
    return {
      diagnostics: loaded.diagnostics ?? [],
      required_scopes: []
    };
  }
  const launch = resolveLaunchConfig(loaded.document);
  if (launch.diagnostics.length > 0) {
    return { diagnostics: launch.diagnostics, required_scopes: [] };
  }
  const compilation = compileAuthoredGraph(
    loaded.document,
    launch,
    loaded.lowered_managed_nodes,
    {
      ...(loaded.resolved_plugins ? { resolved_plugins: loaded.resolved_plugins } : {}),
      graph_dir: dirname(loaded.absolute_path)
    }
  );
  if (!compilation.compiled_graph) {
    return { diagnostics: compilation.diagnostics, required_scopes: [] };
  }
  return {
    diagnostics: [],
    required_scopes: collectRequiredScopes({
      resolved_plugins: loaded.resolved_plugins ?? [],
      compiled_graph: compilation.compiled_graph
    })
  };
}

function pickScopeFromAvailable(
  scope: string,
  scopes: RequiredScope[]
): ResolvedScopeForLogin | undefined {
  const match = scopes.find((entry) => entry.scope === scope);
  if (!match) {
    return undefined;
  }
  return { scope: match.scope, decl: match.decl, used_by: match.used_by };
}

function findDeclInResolvedPlugins(
  scope: string,
  plugins: ResolvedPlugin[]
): { decl: PluginCredentialDecl; alias: string } | undefined {
  for (const plugin of plugins) {
    const credentials = plugin.manifest.credentials ?? {};
    for (const decl of Object.values(credentials)) {
      if (decl.scope === scope) {
        return { decl, alias: plugin.alias };
      }
    }
  }
  return undefined;
}

async function resolveDeclForScope(
  scope: string,
  currentWorkingDirectory: string,
  graphPath: string | undefined
): Promise<{
  decl?: PluginCredentialDecl;
  used_by: string[];
  diagnostics: GraphDiagnostic[];
}> {
  if (!graphPath) {
    return {
      diagnostics: [
        {
          path: "--graph",
          message: "Auth commands require --graph to discover credential declarations from resolved plugins."
        }
      ],
      used_by: []
    };
  }

  const loaded = await loadAuthoredGraphDocument(currentWorkingDirectory, graphPath, {});
  const plugins = loaded.resolved_plugins ?? [];
  const fromResolved = findDeclInResolvedPlugins(scope, plugins);
  if (!fromResolved) {
    return {
      diagnostics: [
        {
          path: "--scope",
          message: `Credential scope "${scope}" is not declared by any resolved plugin for this graph. Run agentflow plugin resolve --graph ${graphPath} first.`
        }
      ],
      used_by: []
    };
  }

  const required = await resolveRequiredScopesFromGraph(currentWorkingDirectory, graphPath);
  const usedBy = required.required_scopes.find((entry) => entry.scope === scope)?.used_by ?? [];
  return { decl: fromResolved.decl, used_by: usedBy, diagnostics: [] };
}

interface LoginCollectedField {
  key: string;
  secret: boolean;
  value: string;
}

async function collectFieldValues(
  scope: ResolvedScopeForLogin,
  hooks: AuthCommandHooks,
  streams: AuthStreams
): Promise<{ collected: LoginCollectedField[]; missing: string[] }> {
  const env = effectiveEnv(hooks);
  const collected: LoginCollectedField[] = [];
  const missing: string[] = [];
  const promptFn = hooks.promptValue ?? ((params) => defaultPromptValue(streams, params));

  for (const field of scope.decl.fields) {
    const envName = credentialEnvVarName(scope.scope, field.key);
    const envValue = env[envName];
    if (envValue !== undefined && envValue.length > 0) {
      collected.push({ key: field.key, secret: field.secret, value: envValue });
      continue;
    }

    const value = await promptFn({ scope: scope.scope, field });
    if (value === undefined || value.length === 0) {
      if (field.required) {
        missing.push(field.key);
      }
      continue;
    }
    collected.push({ key: field.key, secret: field.secret, value });
  }

  return { collected, missing };
}

function fieldsAsRecord(collected: LoginCollectedField[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of collected) {
    result[field.key] = field.value;
  }
  return result;
}

export interface AuthCommandResult {
  exitCode: number;
  output?: unknown;
  stdout?: string;
}

async function runLogin(
  options: Record<string, string | boolean | string[] | undefined>,
  currentWorkingDirectory: string,
  positionals: readonly string[]
): Promise<AuthCommandResult> {
  const hooks = effectiveHooks();
  const streams: AuthStreams = hooks.streams ?? {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr
  };

  const scopeArg = positionals[0] ?? (typeof options.scope === "string" ? options.scope : undefined);
  if (!scopeArg) {
    return {
      exitCode: 2,
      stdout: renderCommandUsageError({
        message: "Missing required scope argument.",
        commandName: "auth login",
        usage: "agentflow auth login <scope> --graph <path/to/agentflow.graph.json>"
      })
    };
  }

  const graphPath = typeof options.graph === "string" ? options.graph : undefined;

  const declResult = await resolveDeclForScope(scopeArg, currentWorkingDirectory, graphPath);
  if (!declResult.decl) {
    return {
      exitCode: 2,
      output: {
        command: "auth login",
        status: "failed",
        scope: scopeArg,
        diagnostics: declResult.diagnostics
      }
    };
  }

  const scope: ResolvedScopeForLogin = {
    scope: scopeArg,
    decl: declResult.decl,
    used_by: declResult.used_by
  };

  if (scope.decl.login.open_url && hooks.openUrl !== undefined) {
    await hooks.openUrl(scope.decl.login.open_url);
  } else if (scope.decl.login.open_url) {
    streams.stderr.write(`Open ${scope.decl.login.open_url} to mint a new token.\n`);
    await defaultOpenUrl(scope.decl.login.open_url);
  }

  if (scope.decl.login.instructions) {
    streams.stderr.write(`${scope.decl.login.instructions}\n`);
  }

  const { collected, missing } = await collectFieldValues(scope, hooks, streams);
  if (missing.length > 0) {
    return {
      exitCode: 1,
      output: {
        command: "auth login",
        status: "failed",
        scope: scope.scope,
        message: `Missing required field(s): ${missing.join(", ")}.`,
        missing_fields: missing
      }
    };
  }

  const verify = await runVerify(scope.decl.login.verify, fieldsAsRecord(collected), {
    ...(hooks.fetchImpl ? { fetchImpl: hooks.fetchImpl } : {})
  });

  if (!verify.ok) {
    return {
      exitCode: 1,
      output: {
        command: "auth login",
        status: "failed",
        scope: scope.scope,
        verify_status: verify.status,
        message: verify.reason ?? "Verification failed.",
        body_excerpt: verify.body_excerpt
      }
    };
  }

  const verifiedAt = new Date().toISOString();
  await putScope(
    {
      scope: scope.scope,
      ...(verify.identity ? { identity: verify.identity } : {}),
      fields: collected,
      verified_at: verifiedAt
    },
    {
      index_path: authIndexPath(hooks),
      ...(hooks.account ? { account: hooks.account } : {})
    }
  );

  return {
    exitCode: 0,
    output: {
      command: "auth login",
      status: "passed",
      scope: scope.scope,
      identity: verify.identity ?? null,
      verified_at: verifiedAt,
      fields_stored: collected.map((field) => ({ key: field.key, secret: field.secret })),
      used_by: scope.used_by
    }
  };
}

async function runList(): Promise<AuthCommandResult> {
  const hooks = effectiveHooks();
  const scopes = await storeListScopes({
    index_path: authIndexPath(hooks),
    ...(hooks.account ? { account: hooks.account } : {})
  });
  return {
    exitCode: 0,
    output: {
      command: "auth list",
      status: "passed",
      scopes: scopes.map((scope) => ({
        scope: scope.scope,
        identity: scope.identity ?? null,
        stored_at: scope.stored_at ?? null,
        last_verified_at: scope.last_verified_at ?? null,
        non_secret_fields: Object.keys(scope.fields).sort(),
        secret_keys: scope.secret_keys
      }))
    }
  };
}

async function runStatus(
  options: Record<string, string | boolean | string[] | undefined>,
  currentWorkingDirectory: string,
  positionals: readonly string[]
): Promise<AuthCommandResult> {
  const hooks = effectiveHooks();
  const scopeArg =
    positionals[0] ?? (typeof options.scope === "string" ? options.scope : undefined);
  if (!scopeArg) {
    return {
      exitCode: 2,
      stdout: renderCommandUsageError({
        message: "Missing required scope argument.",
        commandName: "auth status",
        usage: "agentflow auth status <scope> --graph <path/to/agentflow.graph.json>"
      })
    };
  }

  const graphPath = typeof options.graph === "string" ? options.graph : undefined;
  const declResult = await resolveDeclForScope(scopeArg, currentWorkingDirectory, graphPath);
  if (!declResult.decl) {
    return {
      exitCode: 2,
      output: {
        command: "auth status",
        status: "failed",
        scope: scopeArg,
        diagnostics: declResult.diagnostics
      }
    };
  }

  const stored = await getScopeFields(scopeArg, {
    index_path: authIndexPath(hooks),
    ...(hooks.account ? { account: hooks.account } : {})
  });
  if (!stored) {
    return {
      exitCode: 1,
      output: {
        command: "auth status",
        status: "failed",
        scope: scopeArg,
        message: `No credentials stored for scope "${scopeArg}". Run: agentflow auth login ${scopeArg}`
      }
    };
  }

  const verify: VerifyResult = await runVerify(declResult.decl.login.verify, stored.fields, {
    ...(hooks.fetchImpl ? { fetchImpl: hooks.fetchImpl } : {})
  });

  if (verify.ok) {
    const verifiedAt = new Date().toISOString();
    await recordVerification(scopeArg, verifiedAt, {
      index_path: authIndexPath(hooks),
      ...(hooks.account ? { account: hooks.account } : {})
    });
    return {
      exitCode: 0,
      output: {
        command: "auth status",
        status: "passed",
        scope: scopeArg,
        identity: verify.identity ?? stored.identity ?? null,
        verified_at: verifiedAt,
        verify_status: verify.status
      }
    };
  }

  return {
    exitCode: 1,
    output: {
      command: "auth status",
      status: "failed",
      scope: scopeArg,
      verify_status: verify.status,
      message: verify.reason ?? "Verification failed.",
      body_excerpt: verify.body_excerpt
    }
  };
}

async function runLogout(
  options: Record<string, string | boolean | string[] | undefined>,
  positionals: readonly string[]
): Promise<AuthCommandResult> {
  const hooks = effectiveHooks();
  const scopeArg =
    positionals[0] ?? (typeof options.scope === "string" ? options.scope : undefined);
  if (!scopeArg) {
    return {
      exitCode: 2,
      stdout: renderCommandUsageError({
        message: "Missing required scope argument.",
        commandName: "auth logout",
        usage: "agentflow auth logout <scope>"
      })
    };
  }

  const removed = await storeDeleteScope(scopeArg, {
    index_path: authIndexPath(hooks),
    ...(hooks.account ? { account: hooks.account } : {})
  });

  return {
    exitCode: 0,
    output: {
      command: "auth logout",
      status: removed ? "passed" : "noop",
      scope: scopeArg,
      removed
    }
  };
}

async function runSet(
  options: Record<string, string | boolean | string[] | undefined>,
  currentWorkingDirectory: string
): Promise<AuthCommandResult> {
  const hooks = effectiveHooks();
  const scopeArg = typeof options.scope === "string" ? options.scope : undefined;
  const keyArg = typeof options.key === "string" ? options.key : undefined;
  const graphPath = typeof options.graph === "string" ? options.graph : undefined;

  if (!scopeArg || !keyArg) {
    return {
      exitCode: 2,
      stdout: renderCommandUsageError({
        message: "Missing required option(s): --scope and --key are both required.",
        commandName: "auth set",
        usage: "agentflow auth set --scope <s> --key <k> --graph <path/to/agentflow.graph.json>"
      })
    };
  }

  const declResult = await resolveDeclForScope(scopeArg, currentWorkingDirectory, graphPath);
  if (!declResult.decl) {
    return {
      exitCode: 2,
      output: {
        command: "auth set",
        status: "failed",
        scope: scopeArg,
        diagnostics: declResult.diagnostics
      }
    };
  }

  const fieldDecl = declResult.decl.fields.find((field) => field.key === keyArg);
  if (!fieldDecl) {
    return {
      exitCode: 2,
      output: {
        command: "auth set",
        status: "failed",
        scope: scopeArg,
        message: `Field "${keyArg}" is not declared on credential scope "${scopeArg}".`
      }
    };
  }

  const streams: AuthStreams = hooks.streams ?? {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr
  };
  const promptFn = hooks.promptValue ?? ((params) => defaultPromptValue(streams, params));
  const value = await promptFn({ scope: scopeArg, field: fieldDecl });
  if (value === undefined || value.length === 0) {
    return {
      exitCode: 1,
      output: {
        command: "auth set",
        status: "failed",
        scope: scopeArg,
        message: `Field "${keyArg}" requires a non-empty value.`
      }
    };
  }

  const existing = await getScopeFields(scopeArg, {
    index_path: authIndexPath(hooks),
    ...(hooks.account ? { account: hooks.account } : {})
  });

  const fields: LoginCollectedField[] = declResult.decl.fields.map((field) => {
    if (field.key === keyArg) {
      return { key: field.key, secret: field.secret, value };
    }
    const existingValue = existing?.fields[field.key];
    if (existingValue !== undefined) {
      return { key: field.key, secret: field.secret, value: existingValue };
    }
    return { key: field.key, secret: field.secret, value: "" };
  }).filter((field) => field.value.length > 0 || field.key === keyArg);

  await putScope(
    {
      scope: scopeArg,
      ...(existing?.identity ? { identity: existing.identity } : {}),
      fields
    },
    {
      index_path: authIndexPath(hooks),
      ...(hooks.account ? { account: hooks.account } : {})
    }
  );

  return {
    exitCode: 0,
    output: {
      command: "auth set",
      status: "passed",
      scope: scopeArg,
      key: keyArg,
      secret: fieldDecl.secret
    }
  };
}

const subcommands = ["login", "list", "status", "logout", "set"] as const;
type AuthSubcommand = (typeof subcommands)[number];

function isAuthSubcommand(value: string | undefined): value is AuthSubcommand {
  return typeof value === "string" && (subcommands as readonly string[]).includes(value);
}

export const authCommand = {
  name: "auth",
  summary: "Manage credentials for plugin tools that need API access (macOS keychain).",
  usage:
    "agentflow auth <login|list|status|logout|set> [<scope>] [--graph <path>] [--scope <s>] [--key <k>]",
  examples: [
    "agentflow auth login reddit-drone --graph ./agentflow.graph.json",
    "agentflow auth list",
    "agentflow auth status reddit-drone --graph ./agentflow.graph.json",
    "agentflow auth logout reddit-drone",
    "agentflow auth set --scope reddit-jira --key email --graph ./agentflow.graph.json"
  ] as const,
  optionNames: ["graph", "scope", "key", "help"] as const,
  helpNotes: [
    "Secrets are stored in the macOS Keychain (service: agentflow.<scope>.<field>); non-secret fields live in ~/.agentflow/credentials.index.json (mode 0600).",
    "login/status/set need --graph so Agentflow can read the credential schema from your resolved plugins.",
    "AGENTFLOW_CREDENTIAL_<SCOPE>_<KEY> environment variables override stored values for ad-hoc and CI use; they always win over the keychain."
  ] as const,
  async run(
    options: Record<string, string | boolean | string[] | undefined>,
    currentWorkingDirectory: string,
    _signal?: AbortSignal,
    positionals: readonly string[] = []
  ): Promise<AuthCommandResult> {
    const subcommand = positionals[0];
    if (!isAuthSubcommand(subcommand)) {
      return {
        exitCode: 2,
        stdout: renderCommandUsageError({
          message: subcommand
            ? `Unknown auth subcommand: ${subcommand}`
            : "Missing auth subcommand.",
          commandName: this.name,
          usage: this.usage
        })
      };
    }
    const remainingPositionals = positionals.slice(1);

    switch (subcommand) {
      case "login":
        return runLogin(options, currentWorkingDirectory, remainingPositionals);
      case "list":
        return runList();
      case "status":
        return runStatus(options, currentWorkingDirectory, remainingPositionals);
      case "logout":
        return runLogout(options, remainingPositionals);
      case "set":
        return runSet(options, currentWorkingDirectory);
      default:
        return {
          exitCode: 2,
          stdout: renderCommandUsageError({
            message: `Unknown auth subcommand: ${String(subcommand)}`,
            commandName: this.name,
            usage: this.usage
          })
        };
    }
  }
};
