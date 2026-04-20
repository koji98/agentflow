import type { PluginCredentialVerify } from "../plugins/workflows.js";

export interface VerifyResult {
  ok: boolean;
  status: number;
  identity?: string;
  body_excerpt?: string;
  reason?: string;
}

const TEMPLATE_TOKEN_PATTERN = /\{([a-z][a-z0-9_]*)\}/g;

export class TemplateRenderError extends Error {
  readonly missing_field: string;

  constructor(missingField: string) {
    super(`Verify template references undeclared field "{${missingField}}".`);
    this.name = "TemplateRenderError";
    this.missing_field = missingField;
  }
}

export function renderTemplate(template: string, fields: Record<string, string>): string {
  return template.replace(TEMPLATE_TOKEN_PATTERN, (_match, fieldName: string) => {
    if (!Object.prototype.hasOwnProperty.call(fields, fieldName)) {
      throw new TemplateRenderError(fieldName);
    }
    return fields[fieldName] ?? "";
  });
}

function basicAuthHeaderValue(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function evaluateJsonPath(payload: unknown, path: string): string | undefined {
  if (!path.startsWith("$.")) {
    return undefined;
  }
  const remainder = path.slice(2);
  if (remainder.length === 0) {
    return undefined;
  }
  const segments = remainder.split(".");
  let cursor: unknown = payload;
  for (const segment of segments) {
    if (!isPlainObject(cursor)) {
      return undefined;
    }
    cursor = cursor[segment];
  }
  if (cursor === undefined || cursor === null) {
    return undefined;
  }
  if (typeof cursor === "string") {
    return cursor;
  }
  if (typeof cursor === "number" || typeof cursor === "boolean") {
    return String(cursor);
  }
  return undefined;
}

export interface VerifyOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function runVerify(
  verify: PluginCredentialVerify,
  fields: Record<string, string>,
  options: VerifyOptions = {}
): Promise<VerifyResult> {
  const fetchImpl = options.fetchImpl ?? fetch;

  const headers: Record<string, string> = {};
  if (verify.extra_headers) {
    for (const [headerName, headerValue] of Object.entries(verify.extra_headers)) {
      headers[headerName] = headerValue;
    }
  }

  if (verify.auth.kind === "header") {
    headers[verify.auth.header_name] = renderTemplate(verify.auth.header_value_template, fields);
  } else {
    const username = renderTemplate(verify.auth.username_template, fields);
    const password = renderTemplate(verify.auth.password_template, fields);
    headers["Authorization"] = basicAuthHeaderValue(username, password);
  }

  const timeoutMs = options.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(verify.url, {
      method: verify.method,
      headers,
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timer);
    return {
      ok: false,
      status: 0,
      reason: `Network error: ${(error as Error).message}`
    };
  } finally {
    clearTimeout(timer);
  }

  const status = response.status;
  const ok = status === verify.ok_when_status;

  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    bodyText = "";
  }

  const trimmed = bodyText.length > 240 ? `${bodyText.slice(0, 240)}…` : bodyText;

  if (!ok) {
    return {
      ok: false,
      status,
      body_excerpt: trimmed,
      reason: `Expected status ${verify.ok_when_status}, got ${status}`
    };
  }

  let identity: string | undefined;
  if (verify.extract_identity) {
    try {
      const parsed = JSON.parse(bodyText);
      identity = evaluateJsonPath(parsed, verify.extract_identity);
    } catch {
      identity = undefined;
    }
  }

  return {
    ok: true,
    status,
    body_excerpt: trimmed,
    ...(identity ? { identity } : {})
  };
}
