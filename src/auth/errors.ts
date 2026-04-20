export interface MissingCredentialField {
  scope: string;
  key: string;
  secret: boolean;
}

export interface MissingCredentialsScope {
  scope: string;
  missing_keys: string[];
  used_by: string[];
}

export interface MissingCredentialsPayload {
  missing: MissingCredentialsScope[];
}

function suggestionLineForScope(scope: MissingCredentialsScope): string {
  const usedBy = scope.used_by.length > 0 ? ` (required by: ${scope.used_by.join(", ")})` : "";
  return `  - agentflow auth login ${scope.scope}${usedBy}`;
}

export class MissingCredentialsError extends Error {
  readonly missing: MissingCredentialsScope[];

  constructor(missing: MissingCredentialsScope[]) {
    const lines: string[] = [];
    if (missing.length === 1 && missing[0]!.missing_keys.length === 1) {
      const only = missing[0]!;
      lines.push(
        `Missing credential ${only.scope}.${only.missing_keys[0]}. Run: agentflow auth login ${only.scope}`
      );
    } else {
      lines.push("Missing credentials required by this graph:");
      for (const scope of missing) {
        lines.push(`  ${scope.scope}: missing ${scope.missing_keys.join(", ")}`);
      }
      lines.push("Run:");
      for (const scope of missing) {
        lines.push(suggestionLineForScope(scope));
      }
    }

    super(lines.join("\n"));
    this.name = "MissingCredentialsError";
    this.missing = missing;
  }

  toPayload(): MissingCredentialsPayload {
    return { missing: this.missing };
  }
}

export function isMissingCredentialsError(value: unknown): value is MissingCredentialsError {
  return value instanceof MissingCredentialsError;
}
