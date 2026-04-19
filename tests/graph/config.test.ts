import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import {
  collectConfigReferences,
  interpolateGraphConfig,
  mergeConfig,
  parseConfigOverridesFromCli,
  readConfigValue,
  rewriteConfigPlaceholders,
  validateConfigAgainstSchema
} from "../../src/graph/config.js";
import { loadAuthoredGraphDocument } from "../../src/graph/validate.js";

describe("graph config helpers", () => {
  it("reads scalar values via dotted paths", () => {
    expect(readConfigValue({ owner: "octocat" }, "owner")).toBe("octocat");
    expect(readConfigValue({ pr: { number: 42 } }, "pr.number")).toBe("42");
    expect(readConfigValue({ flag: true }, "flag")).toBe("true");
  });

  it("serializes structured values as JSON when interpolated", () => {
    expect(readConfigValue({ branches: ["a", "b"] }, "branches")).toBe('["a","b"]');
  });

  it("rewrites placeholders in strings", () => {
    expect(
      rewriteConfigPlaceholders("hello {{config.who}}!", { who: "world" })
    ).toBe("hello world!");
  });

  it("collects config references from a string", () => {
    expect(
      collectConfigReferences("{{config.a}} and {{config.b.c}}")
    ).toEqual(["a", "b.c"]);
  });

  it("interpolates strings throughout an object but skips $.config and $.config_schema", () => {
    const document = {
      version: "1",
      config: { foo: "bar", literal: "{{config.foo}}" },
      config_schema: { type: "object" },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "exec",
            id: "use_config",
            command: "echo",
            args: ["{{config.foo}}"]
          }
        ]
      }
    };

    const { document: rewritten, diagnostics } = interpolateGraphConfig(document, {
      foo: "bar"
    });

    expect(diagnostics).toEqual([]);
    const recordRewritten = rewritten as Record<string, unknown>;
    const configRecord = recordRewritten.config as Record<string, unknown>;
    const graphRecord = recordRewritten.graph as Record<string, unknown>;
    const stepsRecord = graphRecord.steps as Array<Record<string, unknown>>;
    expect(configRecord.literal).toBe("{{config.foo}}");
    expect((stepsRecord[0]?.args as string[])[0]).toBe("bar");
  });

  it("emits diagnostics when a referenced config key is missing", () => {
    const result = interpolateGraphConfig({ x: "{{config.missing}}" }, {});
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toContain("missing");
  });

  it("validates required and unknown properties against a schema", () => {
    const diagnostics: Array<{ path: string; message: string }> = [];
    validateConfigAgainstSchema(
      { extra: "1" },
      {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false
      },
      "$.config_schema",
      diagnostics
    );

    const messages = diagnostics.map((diagnostic) => diagnostic.message);
    expect(messages.some((message) => message.includes('required property "name"'))).toBe(
      true
    );
    expect(messages.some((message) => message.includes('does not allow property "extra"'))).toBe(
      true
    );
  });

  it("flags property-type mismatches", () => {
    const diagnostics: Array<{ path: string; message: string }> = [];
    validateConfigAgainstSchema(
      { count: "five" },
      { type: "object", properties: { count: { type: "number" } } },
      "$.config_schema",
      diagnostics
    );

    expect(diagnostics).toEqual([
      {
        path: "config.count",
        message: 'config property "count" must be number.'
      }
    ]);
  });

  it("parses CLI overrides with JSON-typed values and dotted keys", () => {
    const result = parseConfigOverridesFromCli([
      "owner=octocat",
      "pr.number=42",
      "labels=[\"bug\"]",
      "flag=true"
    ]);

    expect(result.diagnostics).toEqual([]);
    expect(result.config).toEqual({
      owner: "octocat",
      pr: { number: 42 },
      labels: ["bug"],
      flag: true
    });
  });

  it("flags malformed CLI override entries", () => {
    const result = parseConfigOverridesFromCli(["no-equals", "=missing-key"]);
    expect(result.diagnostics).toHaveLength(2);
  });

  it("merges nested config objects deeply", () => {
    expect(
      mergeConfig({ a: { b: 1, c: 2 } }, { a: { c: 3, d: 4 } })
    ).toEqual({ a: { b: 1, c: 3, d: 4 } });
  });
});

describe("loadAuthoredGraphDocument with config", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agentflow-config-test-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function writeGraph(document: unknown): Promise<string> {
    const path = join(workspace, "agentflow.graph.json");
    await writeFile(path, JSON.stringify(document, null, 2));
    return path;
  }

  function baseGraph(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      version: "1",
      graph_id: "config-test",
      repos: { main: { path: "." } },
      defaults: { launch_profile: "default" },
      profiles: { default: { harness: "codex-cli" } },
      ...extra
    };
  }

  it("interpolates document config into nested fields before validation", async () => {
    await mkdir(join(workspace, "."), { recursive: true });
    const path = await writeGraph(
      baseGraph({
        config: { branch: "main", message: "ship it" },
        graph: {
          type: "sequence",
          id: "root",
          steps: [
            {
              type: "exec",
              id: "echo",
              command: "echo",
              args: ["{{config.message}} on {{config.branch}}"]
            }
          ]
        }
      })
    );

    const loaded = await loadAuthoredGraphDocument(workspace, path);
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.document).toBeDefined();

    const stepRecord = loaded.document!.graph.type === "sequence"
      ? loaded.document!.graph.steps[0]
      : undefined;
    expect(stepRecord?.type).toBe("exec");
    if (stepRecord?.type === "exec") {
      expect(stepRecord.args).toEqual(["ship it on main"]);
    }
  });

  it("merges CLI config overrides on top of document config", async () => {
    const path = await writeGraph(
      baseGraph({
        config: { branch: "main" },
        graph: {
          type: "sequence",
          id: "root",
          steps: [
            { type: "exec", id: "step", command: "echo", args: ["{{config.branch}}"] }
          ]
        }
      })
    );

    const loaded = await loadAuthoredGraphDocument(workspace, path, {
      config_overrides: { branch: "feature/x" }
    });

    expect(loaded.diagnostics).toEqual([]);
    if (loaded.document?.graph.type === "sequence") {
      const step = loaded.document.graph.steps[0];
      if (step?.type === "exec") {
        expect(step.args).toEqual(["feature/x"]);
      }
    }
  });

  it("validates merged config against config_schema and reports missing required keys", async () => {
    const path = await writeGraph(
      baseGraph({
        config_schema: {
          type: "object",
          properties: { branch: { type: "string" } },
          required: ["branch"]
        },
        graph: {
          type: "sequence",
          id: "root",
          steps: [
            { type: "exec", id: "step", command: "echo" }
          ]
        }
      })
    );

    const loaded = await loadAuthoredGraphDocument(workspace, path);
    expect(loaded.document).toBeUndefined();
    expect(
      loaded.diagnostics.some((diagnostic) =>
        diagnostic.message.includes('required property "branch"')
      )
    ).toBe(true);
  });

  it("emits diagnostics when a {{config.x}} reference is missing from merged config", async () => {
    const path = await writeGraph(
      baseGraph({
        graph: {
          type: "sequence",
          id: "root",
          steps: [
            { type: "exec", id: "step", command: "echo", args: ["{{config.unknown}}"] }
          ]
        }
      })
    );

    const loaded = await loadAuthoredGraphDocument(workspace, path);
    expect(
      loaded.diagnostics.some((diagnostic) =>
        diagnostic.message.includes('"{{config.unknown}}"')
      )
    ).toBe(true);
  });
});
