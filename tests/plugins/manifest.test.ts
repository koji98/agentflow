import { describe, expect, it } from "vitest";

import { normalizeManifest } from "../../src/plugins/workflows.js";
import type { GraphDiagnostic } from "../../src/graph/schema.js";

function diagPaths(diagnostics: GraphDiagnostic[]): string[] {
  return diagnostics.map((d) => d.path);
}

function baseManifest(): Record<string, unknown> {
  return {
    schema: "agentflow.plugin/1",
    id: "fixture",
    version: "0.1.0",
    workflows: {}
  };
}

function droneCredential(): Record<string, unknown> {
  return {
    scope: "reddit-drone",
    description: "Drone CI token",
    fields: [{ key: "token", secret: true, required: true, prompt: "Drone API token" }],
    login: {
      type: "pat-paste",
      open_url: "https://drone.example.com/account",
      verify: {
        method: "GET",
        url: "https://drone.example.com/api/user",
        auth: { kind: "header", header_name: "Authorization", header_value_template: "Bearer {token}" },
        ok_when_status: 200,
        extract_identity: "$.login"
      }
    }
  };
}

function jiraCredential(): Record<string, unknown> {
  return {
    scope: "reddit-jira",
    fields: [
      { key: "email", secret: false, required: true, prompt: "Atlassian email" },
      { key: "token", secret: true, required: true, prompt: "Jira API token" }
    ],
    login: {
      type: "pat-paste",
      open_url: "https://id.atlassian.com/manage-profile/security/api-tokens",
      verify: {
        method: "GET",
        url: "https://example.atlassian.net/rest/api/3/myself",
        auth: { kind: "basic", username_template: "{email}", password_template: "{token}" },
        ok_when_status: 200,
        extract_identity: "$.displayName"
      }
    }
  };
}

describe("normalizeManifest credentials block", () => {
  it("accepts a manifest without credentials", () => {
    const diagnostics: GraphDiagnostic[] = [];
    const manifest = normalizeManifest(baseManifest(), "$", diagnostics);
    expect(diagnostics).toEqual([]);
    expect(manifest).toBeDefined();
    expect(manifest?.credentials).toBeUndefined();
  });

  it("normalizes a single-field header-auth credential", () => {
    const diagnostics: GraphDiagnostic[] = [];
    const manifest = normalizeManifest(
      { ...baseManifest(), credentials: { drone: droneCredential() } },
      "$",
      diagnostics
    );
    expect(diagnostics).toEqual([]);
    expect(manifest?.credentials?.drone).toEqual({
      scope: "reddit-drone",
      description: "Drone CI token",
      fields: [
        { key: "token", secret: true, required: true, prompt: "Drone API token" }
      ],
      login: {
        type: "pat-paste",
        open_url: "https://drone.example.com/account",
        verify: {
          method: "GET",
          url: "https://drone.example.com/api/user",
          auth: { kind: "header", header_name: "Authorization", header_value_template: "Bearer {token}" },
          ok_when_status: 200,
          extract_identity: "$.login"
        }
      }
    });
  });

  it("normalizes a multi-field basic-auth credential", () => {
    const diagnostics: GraphDiagnostic[] = [];
    const manifest = normalizeManifest(
      { ...baseManifest(), credentials: { jira: jiraCredential() } },
      "$",
      diagnostics
    );
    expect(diagnostics).toEqual([]);
    expect(manifest?.credentials?.jira?.fields).toHaveLength(2);
    expect(manifest?.credentials?.jira?.login.verify.auth).toEqual({
      kind: "basic",
      username_template: "{email}",
      password_template: "{token}"
    });
  });

  it("rejects scopes that do not match the scope pattern", () => {
    const diagnostics: GraphDiagnostic[] = [];
    const credential = droneCredential();
    credential.scope = "Reddit-Drone";
    const manifest = normalizeManifest(
      { ...baseManifest(), credentials: { drone: credential } },
      "$",
      diagnostics
    );
    expect(manifest).toBeUndefined();
    expect(diagPaths(diagnostics)).toContain("$.credentials.drone.scope");
  });

  it("rejects field keys that do not match the field key pattern", () => {
    const diagnostics: GraphDiagnostic[] = [];
    const credential = droneCredential();
    (credential.fields as Array<Record<string, unknown>>)[0]!.key = "Token";
    const manifest = normalizeManifest(
      { ...baseManifest(), credentials: { drone: credential } },
      "$",
      diagnostics
    );
    expect(manifest).toBeUndefined();
    expect(diagPaths(diagnostics)).toContain("$.credentials.drone.fields[0].key");
  });

  it("rejects login.type values other than pat-paste", () => {
    const diagnostics: GraphDiagnostic[] = [];
    const credential = droneCredential();
    (credential.login as Record<string, unknown>).type = "oauth";
    const manifest = normalizeManifest(
      { ...baseManifest(), credentials: { drone: credential } },
      "$",
      diagnostics
    );
    expect(manifest).toBeUndefined();
    expect(diagPaths(diagnostics)).toContain("$.credentials.drone.login.type");
  });

  it("rejects unknown verify.auth.kind", () => {
    const diagnostics: GraphDiagnostic[] = [];
    const credential = droneCredential();
    (credential.login as Record<string, Record<string, unknown>>).verify.auth = { kind: "oauth" };
    const manifest = normalizeManifest(
      { ...baseManifest(), credentials: { drone: credential } },
      "$",
      diagnostics
    );
    expect(manifest).toBeUndefined();
    expect(diagPaths(diagnostics)).toContain("$.credentials.drone.login.verify.auth.kind");
  });

  it("rejects template tokens that do not name a declared field", () => {
    const diagnostics: GraphDiagnostic[] = [];
    const credential = droneCredential();
    const verify = (credential.login as Record<string, Record<string, unknown>>).verify;
    (verify.auth as Record<string, unknown>).header_value_template = "Bearer {missing}";
    const manifest = normalizeManifest(
      { ...baseManifest(), credentials: { drone: credential } },
      "$",
      diagnostics
    );
    expect(manifest).toBeUndefined();
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.credentials.drone.login.verify.auth",
          message: expect.stringContaining("{missing}")
        })
      ])
    );
  });

  it("rejects basic-auth templates referencing undeclared fields", () => {
    const diagnostics: GraphDiagnostic[] = [];
    const credential = jiraCredential();
    const verify = (credential.login as Record<string, Record<string, unknown>>).verify;
    (verify.auth as Record<string, unknown>).password_template = "{api_secret}";
    const manifest = normalizeManifest(
      { ...baseManifest(), credentials: { jira: credential } },
      "$",
      diagnostics
    );
    expect(manifest).toBeUndefined();
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.credentials.jira.login.verify.auth",
          message: expect.stringContaining("{api_secret}")
        })
      ])
    );
  });

  it("rejects ok_when_status that is not an integer", () => {
    const diagnostics: GraphDiagnostic[] = [];
    const credential = droneCredential();
    (credential.login as Record<string, Record<string, unknown>>).verify.ok_when_status = "200";
    const manifest = normalizeManifest(
      { ...baseManifest(), credentials: { drone: credential } },
      "$",
      diagnostics
    );
    expect(manifest).toBeUndefined();
    expect(diagPaths(diagnostics)).toContain("$.credentials.drone.login.verify.ok_when_status");
  });

  it("rejects extract_identity that is not a JSONPath", () => {
    const diagnostics: GraphDiagnostic[] = [];
    const credential = droneCredential();
    (credential.login as Record<string, Record<string, unknown>>).verify.extract_identity = "login";
    const manifest = normalizeManifest(
      { ...baseManifest(), credentials: { drone: credential } },
      "$",
      diagnostics
    );
    expect(manifest).toBeUndefined();
    expect(diagPaths(diagnostics)).toContain("$.credentials.drone.login.verify.extract_identity");
  });

  it("rejects duplicate field keys within a credential", () => {
    const diagnostics: GraphDiagnostic[] = [];
    const credential = droneCredential();
    (credential.fields as Array<Record<string, unknown>>).push({
      key: "token",
      secret: false,
      required: false
    });
    const manifest = normalizeManifest(
      { ...baseManifest(), credentials: { drone: credential } },
      "$",
      diagnostics
    );
    expect(manifest).toBeUndefined();
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.credentials.drone.fields[1].key",
          message: expect.stringContaining("duplicated")
        })
      ])
    );
  });

  it("rejects credentials with empty fields arrays", () => {
    const diagnostics: GraphDiagnostic[] = [];
    const credential = droneCredential();
    credential.fields = [];
    const manifest = normalizeManifest(
      { ...baseManifest(), credentials: { drone: credential } },
      "$",
      diagnostics
    );
    expect(manifest).toBeUndefined();
    expect(diagPaths(diagnostics)).toContain("$.credentials.drone.fields");
  });

  it("accepts tools that reference declared credentials", () => {
    const diagnostics: GraphDiagnostic[] = [];
    const manifest = normalizeManifest(
      {
        ...baseManifest(),
        credentials: { drone: droneCredential() },
        tools: {
          "build-status": {
            executable: "scripts/build-status.sh",
            credentials: ["drone"]
          }
        }
      },
      "$",
      diagnostics
    );
    expect(diagnostics).toEqual([]);
    expect(manifest?.tools["build-status"]?.credentials).toEqual(["drone"]);
  });

  it("rejects tools that reference undeclared credentials", () => {
    const diagnostics: GraphDiagnostic[] = [];
    const manifest = normalizeManifest(
      {
        ...baseManifest(),
        credentials: { drone: droneCredential() },
        tools: {
          "build-status": {
            executable: "scripts/build-status.sh",
            credentials: ["jira"]
          }
        }
      },
      "$",
      diagnostics
    );
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.tools.build-status.credentials[0]",
          message: expect.stringContaining("not declared on this plugin")
        })
      ])
    );
    expect(manifest?.tools["build-status"]?.credentials).toBeUndefined();
  });

  it("rejects tools that reference the same credential more than once", () => {
    const diagnostics: GraphDiagnostic[] = [];
    normalizeManifest(
      {
        ...baseManifest(),
        credentials: { drone: droneCredential() },
        tools: {
          "build-status": {
            executable: "scripts/build-status.sh",
            credentials: ["drone", "drone"]
          }
        }
      },
      "$",
      diagnostics
    );
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.tools.build-status.credentials[1]",
          message: expect.stringContaining("more than once")
        })
      ])
    );
  });

  it("rejects credentials block that is not an object", () => {
    const diagnostics: GraphDiagnostic[] = [];
    normalizeManifest({ ...baseManifest(), credentials: [] }, "$", diagnostics);
    expect(diagPaths(diagnostics)).toContain("$.credentials");
  });

  it("rejects credential ids that do not match the plugin identifier pattern", () => {
    const diagnostics: GraphDiagnostic[] = [];
    normalizeManifest(
      { ...baseManifest(), credentials: { "../jira": jiraCredential() } },
      "$",
      diagnostics
    );
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.credentials.../jira",
          message: expect.stringContaining("Credential ids must use")
        })
      ])
    );
  });
});
