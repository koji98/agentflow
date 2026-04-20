import { describe, expect, it } from "vitest";

import {
  TemplateRenderError,
  evaluateJsonPath,
  renderTemplate,
  runVerify
} from "../../src/auth/verify.js";
import type { PluginCredentialVerify } from "../../src/plugins/workflows.js";

interface FakeFetchCall {
  url: string;
  init?: RequestInit;
}

function buildFakeFetch(
  responder: () => { status: number; body: string }
): { fetchImpl: typeof fetch; calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, ...(init !== undefined ? { init } : {}) });
    const response = responder();
    return new Response(response.body, { status: response.status });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

describe("renderTemplate", () => {
  it("substitutes declared field tokens", () => {
    expect(renderTemplate("Bearer {token}", { token: "abc" })).toBe("Bearer abc");
  });

  it("supports multiple tokens", () => {
    expect(renderTemplate("{user}:{pw}", { user: "u", pw: "p" })).toBe("u:p");
  });

  it("throws TemplateRenderError when a referenced field is missing", () => {
    expect(() => renderTemplate("{missing}", {})).toThrow(TemplateRenderError);
  });
});

describe("evaluateJsonPath", () => {
  it("returns string at the requested path", () => {
    expect(evaluateJsonPath({ login: "chidi" }, "$.login")).toBe("chidi");
  });

  it("supports nested paths", () => {
    expect(evaluateJsonPath({ user: { name: "chidi" } }, "$.user.name")).toBe("chidi");
  });

  it("returns undefined when traversal fails", () => {
    expect(evaluateJsonPath({}, "$.user.name")).toBeUndefined();
  });

  it("converts number/boolean to strings", () => {
    expect(evaluateJsonPath({ id: 42 }, "$.id")).toBe("42");
    expect(evaluateJsonPath({ active: true }, "$.active")).toBe("true");
  });

  it("returns undefined for array values", () => {
    expect(evaluateJsonPath({ tags: ["a"] }, "$.tags")).toBeUndefined();
  });
});

describe("runVerify", () => {
  const headerVerify: PluginCredentialVerify = {
    method: "GET",
    url: "https://drone.example.com/api/user",
    auth: { kind: "header", header_name: "Authorization", header_value_template: "Bearer {token}" },
    extra_headers: { Accept: "application/json" },
    ok_when_status: 200,
    extract_identity: "$.login"
  };

  const basicVerify: PluginCredentialVerify = {
    method: "GET",
    url: "https://example.atlassian.net/rest/api/3/myself",
    auth: { kind: "basic", username_template: "{email}", password_template: "{token}" },
    ok_when_status: 200,
    extract_identity: "$.displayName"
  };

  it("sends header auth and extracts the identity from the response", async () => {
    const { fetchImpl, calls } = buildFakeFetch(() => ({
      status: 200,
      body: JSON.stringify({ login: "chidi.udeze" })
    }));

    const result = await runVerify(headerVerify, { token: "drone_token_value" }, { fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.identity).toBe("chidi.udeze");

    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer drone_token_value");
    expect(headers.Accept).toBe("application/json");
  });

  it("sends basic auth via Authorization header", async () => {
    const { fetchImpl, calls } = buildFakeFetch(() => ({
      status: 200,
      body: JSON.stringify({ displayName: "Chidi Udeze" })
    }));

    const result = await runVerify(
      basicVerify,
      { email: "chidi@example.com", token: "atlassian_token" },
      { fetchImpl }
    );
    expect(result.ok).toBe(true);
    expect(result.identity).toBe("Chidi Udeze");

    const headers = calls[0]!.init?.headers as Record<string, string>;
    const expected = `Basic ${Buffer.from("chidi@example.com:atlassian_token").toString("base64")}`;
    expect(headers.Authorization).toBe(expected);
  });

  it("returns ok=false with an explanation when the status does not match", async () => {
    const { fetchImpl } = buildFakeFetch(() => ({
      status: 401,
      body: "Unauthorized"
    }));

    const result = await runVerify(headerVerify, { token: "expired" }, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.reason).toContain("Expected status 200");
    expect(result.body_excerpt).toContain("Unauthorized");
  });

  it("returns ok=false when the network call throws", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await runVerify(headerVerify, { token: "x" }, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.reason).toContain("ECONNREFUSED");
  });

  it("returns ok=true with no identity when extract_identity does not match", async () => {
    const { fetchImpl } = buildFakeFetch(() => ({
      status: 200,
      body: JSON.stringify({ other: "value" })
    }));

    const result = await runVerify(headerVerify, { token: "x" }, { fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.identity).toBeUndefined();
  });
});
