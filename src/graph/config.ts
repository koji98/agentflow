import type { GraphDiagnostic } from "./schema.js";

export type GraphConfig = Record<string, unknown>;

export const configInterpolationPattern = /\{\{config\.([a-zA-Z0-9_.-]+)\}\}/g;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readByPath(config: GraphConfig, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    const record = asRecord(current);
    return record ? record[key] : undefined;
  }, config);
}

export function readConfigValue(config: GraphConfig, path: string): string {
  const value = readByPath(config, path);

  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : JSON.stringify(value);
}

export function rewriteConfigPlaceholders(value: string, config: GraphConfig): string {
  return value.replace(configInterpolationPattern, (_match, key: string) =>
    readConfigValue(config, key)
  );
}

export function collectConfigReferences(value: string): string[] {
  const matches: string[] = [];

  for (const match of value.matchAll(configInterpolationPattern)) {
    matches.push(match[1] ?? "");
  }

  return matches;
}

export function isConfigReferenceMissing(config: GraphConfig, key: string): boolean {
  return readByPath(config, key) === undefined;
}

export interface InterpolateGraphConfigResult {
  document: unknown;
  diagnostics: GraphDiagnostic[];
}

export function interpolateGraphConfig(
  document: unknown,
  config: GraphConfig
): InterpolateGraphConfigResult {
  const diagnostics: GraphDiagnostic[] = [];

  function walk(value: unknown, path: string): unknown {
    if (typeof value === "string") {
      collectConfigReferences(value).forEach((reference) => {
        if (isConfigReferenceMissing(config, reference)) {
          diagnostics.push({
            path,
            message: `Graph config does not provide a value for "{{config.${reference}}}".`
          });
        }
      });
      return rewriteConfigPlaceholders(value, config);
    }

    if (Array.isArray(value)) {
      return value.map((item, index) => walk(item, `${path}[${index}]`));
    }

    const record = asRecord(value);

    if (!record) {
      return value;
    }

    const next: Record<string, unknown> = {};

    for (const [key, itemValue] of Object.entries(record)) {
      if (path === "$" && (key === "config" || key === "config_schema")) {
        next[key] = itemValue;
        continue;
      }

      const childPath = path === "$" ? `$.${key}` : `${path}.${key}`;
      next[key] = walk(itemValue, childPath);
    }

    return next;
  }

  return {
    document: walk(document, "$"),
    diagnostics
  };
}

export function validateConfigAgainstSchema(
  config: GraphConfig,
  schema: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): void {
  const schemaRecord = asRecord(schema);

  if (!schemaRecord) {
    diagnostics.push({ path, message: "Config schema must be an object." });
    return;
  }

  if (schemaRecord.type !== undefined && schemaRecord.type !== "object") {
    diagnostics.push({
      path: `${path}.type`,
      message: "Only object config schemas are supported."
    });
    return;
  }

  const properties = asRecord(schemaRecord.properties) ?? {};
  const required = Array.isArray(schemaRecord.required)
    ? schemaRecord.required.filter((item): item is string => typeof item === "string")
    : [];

  required.forEach((key) => {
    if (config[key] === undefined) {
      diagnostics.push({
        path: `config.${key}`,
        message: `config is missing required property "${key}".`
      });
    }
  });

  if (schemaRecord.additionalProperties === false) {
    Object.keys(config)
      .filter((key) => properties[key] === undefined)
      .forEach((key) => {
        diagnostics.push({
          path: `config.${key}`,
          message: `config does not allow property "${key}".`
        });
      });
  }

  Object.entries(properties).forEach(([key, propertySchema]) => {
    if (config[key] === undefined) {
      return;
    }

    const expectedType = asRecord(propertySchema)?.type;
    const actual = config[key];
    const typeMatches =
      expectedType === undefined ||
      (expectedType === "array"
        ? Array.isArray(actual)
        : typeof actual === expectedType);

    if (!typeMatches) {
      diagnostics.push({
        path: `config.${key}`,
        message: `config property "${key}" must be ${String(expectedType)}.`
      });
    }
  });
}

const numericPattern = /^-?[0-9]+(\.[0-9]+)?$/;

function shouldAttemptJsonParse(rawValue: string): boolean {
  if (rawValue.length === 0) {
    return false;
  }

  if (rawValue === "true" || rawValue === "false" || rawValue === "null") {
    return true;
  }

  if (numericPattern.test(rawValue)) {
    return true;
  }

  const first = rawValue[0];

  return first === "{" || first === "[" || first === '"';
}

function setByPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");

  if (segments.length === 0) {
    return;
  }

  let current = target;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] ?? "";
    const existing = current[segment];

    if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
      current = existing as Record<string, unknown>;
    } else {
      const next: Record<string, unknown> = {};
      current[segment] = next;
      current = next;
    }
  }

  current[segments[segments.length - 1] ?? ""] = value;
}

export interface ParseConfigOverridesResult {
  config: GraphConfig;
  diagnostics: GraphDiagnostic[];
}

export function parseConfigOverridesFromCli(entries: string[]): ParseConfigOverridesResult {
  const config: GraphConfig = {};
  const diagnostics: GraphDiagnostic[] = [];

  for (const entry of entries) {
    const equals = entry.indexOf("=");

    if (equals <= 0) {
      diagnostics.push({
        path: "--config",
        message: `--config entry "${entry}" must use key=value form.`
      });
      continue;
    }

    const key = entry.slice(0, equals).trim();
    const rawValue = entry.slice(equals + 1);

    if (!key) {
      diagnostics.push({
        path: "--config",
        message: `--config entry "${entry}" has an empty key.`
      });
      continue;
    }

    let parsed: unknown = rawValue;

    if (shouldAttemptJsonParse(rawValue)) {
      try {
        parsed = JSON.parse(rawValue);
      } catch {
        parsed = rawValue;
      }
    }

    setByPath(config, key, parsed);
  }

  return {
    config,
    diagnostics
  };
}

export function mergeConfig(base: GraphConfig, overrides: GraphConfig): GraphConfig {
  const result: GraphConfig = { ...base };

  for (const [key, value] of Object.entries(overrides)) {
    const existingBase = result[key];

    if (
      typeof existingBase === "object" &&
      existingBase !== null &&
      !Array.isArray(existingBase) &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      result[key] = mergeConfig(existingBase as GraphConfig, value as GraphConfig);
    } else {
      result[key] = value;
    }
  }

  return result;
}
