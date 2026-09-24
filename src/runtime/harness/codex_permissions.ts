import type { SandboxMode } from "../../graph/schema.js";

export const codexNetworkAccessKey = "permissions.agentflow_judge_permissions.network.enabled";
export const codexNetworkAccessEnv = "AGENTFLOW_CODEX_NETWORK_ACCESS";

const baseProfiles: Record<Exclude<SandboxMode, "danger-full-access">, string> = {
  "read-only": ":read-only",
  "workspace-write": ":workspace"
};

export function resolveCodexNetworkAccess(config: Record<string, unknown> | undefined): boolean {
  const value = config?.[codexNetworkAccessKey];
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`${codexNetworkAccessKey} must be a boolean.`);
  }
  return value ?? true;
}

export function buildCodexPermissionArgs(sandbox: SandboxMode, networkAccess: boolean): string[] {
  // Codex allows selecting full access directly, but not extending it.
  if (sandbox === "danger-full-access") {
    if (!networkAccess) {
      throw new Error("Codex danger-full-access cannot disable network access. Use read-only or workspace-write instead.");
    }
    return ["-c", 'default_permissions=":danger-full-access"'];
  }

  return [
    "-c", 'default_permissions="agentflow_judge_permissions"',
    "-c", `permissions.agentflow_judge_permissions={ extends = "${baseProfiles[sandbox]}", network = { enabled = ${networkAccess} } }`
  ];
}
