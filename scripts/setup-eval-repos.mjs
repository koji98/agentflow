#!/usr/bin/env node
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const suiteId = "agentflow-capability-workflows";
const suiteDir = resolve(rootDir, "evals", suiteId);
const reposDir = resolve(rootDir, "eval-repos", suiteId);

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function write(path, content, mode) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  if (mode !== undefined) {
    await chmod(path, mode);
  }
}

function packageJson(name) {
  return json({
    name,
    version: "0.0.0",
    private: true,
    scripts: {
      test: "node tests/verify.js"
    }
  });
}

function task(title, body) {
  return [
    `# ${title}`,
    "",
    body.trim(),
    "",
    "## Agentflow Output Contract",
    "",
    "Write `handoff.md` in `$AGENTFLOW_OUTPUT_DIR`.",
    "The handoff must include:",
    "",
    "- `Scenario:` with the scenario id",
    "- `Changed files:` with the files changed or `none`",
    "- `Validation:` with the exact validation command and result",
    "- `Risks:` with any remaining uncertainty",
    "",
    "Run `npm test` before finishing unless the graph profile is read-only."
  ].join("\n");
}

function verifier(assertions) {
  return [
    "const assert = require('node:assert/strict');",
    ...assertions,
    "console.log('eval fixture verification passed');",
    ""
  ].join("\n");
}

const repos = {
  "01-config-deep-merge": {
    "package.json": packageJson("config-deep-merge"),
    "AGENTFLOW_EVAL_TASK.md": task(
      "Scenario: config-deep-merge",
      "Fix `src/config.js` so `mergeConfig(base, override)` performs a deterministic deep merge for plain objects. Nested object keys from the base must be preserved unless overridden, arrays should be replaced, and inputs must not be mutated."
    ),
    "src/config.js": [
      "function mergeConfig(base, override) {",
      "  return { ...base, ...override };",
      "}",
      "",
      "module.exports = { mergeConfig };",
      ""
    ].join("\n"),
    "tests/verify.js": verifier([
      "const { mergeConfig } = require('../src/config');",
      "const base = { feature: { enabled: true, flags: { beta: false, audit: true } }, list: ['a'], port: 3000 };",
      "const override = { feature: { flags: { beta: true } }, list: ['b'] };",
      "const merged = mergeConfig(base, override);",
      "assert.deepEqual(merged, { feature: { enabled: true, flags: { beta: true, audit: true } }, list: ['b'], port: 3000 });",
      "assert.deepEqual(base.list, ['a']);"
    ])
  },
  "02-cache-ttl-regression": {
    "package.json": packageJson("cache-ttl-regression"),
    "AGENTFLOW_EVAL_TASK.md": task(
      "Scenario: cache-ttl-regression",
      "Fix `src/cache.js`. `createCache({ ttlMs, now })` should expire entries after ttlMs, refresh timestamps on `set`, and return `undefined` for missing or expired keys. Keep the API shape unchanged."
    ),
    "src/cache.js": [
      "function createCache({ ttlMs, now = () => Date.now() }) {",
      "  const values = new Map();",
      "  return {",
      "    set(key, value) { values.set(key, { value, createdAt: now() }); },",
      "    get(key) { return values.get(key)?.value; }",
      "  };",
      "}",
      "",
      "module.exports = { createCache };",
      ""
    ].join("\n"),
    "tests/verify.js": verifier([
      "const { createCache } = require('../src/cache');",
      "let current = 1000;",
      "const cache = createCache({ ttlMs: 50, now: () => current });",
      "cache.set('user', { id: 1 });",
      "assert.deepEqual(cache.get('user'), { id: 1 });",
      "current = 1049;",
      "assert.deepEqual(cache.get('user'), { id: 1 });",
      "current = 1051;",
      "assert.equal(cache.get('user'), undefined);",
      "cache.set('user', { id: 2 });",
      "assert.deepEqual(cache.get('user'), { id: 2 });"
    ])
  },
  "03-api-client-docs-migration": {
    "package.json": packageJson("api-client-docs-migration"),
    "AGENTFLOW_EVAL_TASK.md": task(
      "Scenario: api-client-docs-migration",
      "Update `src/client.js` to the documented v2 request contract. The graph provides a local docs URL. Use that docs fixture, not guessed API names. The exported `buildRequest` must produce the v2 stable request envelope expected by tests."
    ),
    "src/client.js": [
      "function buildRequest(path, body) {",
      "  return { endpoint: path, payload: body, version: 'legacy' };",
      "}",
      "",
      "module.exports = { buildRequest };",
      ""
    ].join("\n"),
    "tests/verify.js": verifier([
      "const { buildRequest } = require('../src/client');",
      "assert.deepEqual(buildRequest('/users', { active: true }), {",
      "  transport: 'stableRequest',",
      "  version: '2026-04',",
      "  request: { method: 'POST', path: '/users', json: { active: true } }",
      "});"
    ])
  },
  "04-ui-accessibility": {
    "package.json": packageJson("ui-accessibility"),
    "AGENTFLOW_EVAL_TASK.md": task(
      "Scenario: ui-accessibility",
      "Fix the button renderer in `src/renderButton.js` so icon-only buttons expose an accessible name while regular text buttons remain unchanged. Keep the function dependency-free."
    ),
    "src/renderButton.js": [
      "function renderButton({ label, iconOnly = false }) {",
      "  return iconOnly ? '<button class=\"icon-btn\"></button>' : `<button>${label}</button>`;",
      "}",
      "",
      "module.exports = { renderButton };",
      ""
    ].join("\n"),
    "tests/verify.js": verifier([
      "const { renderButton } = require('../src/renderButton');",
      "assert.equal(renderButton({ label: 'Save' }), '<button>Save</button>');",
      "assert.match(renderButton({ label: 'Save', iconOnly: true }), /aria-label=\"Save\"/);",
      "assert.match(renderButton({ label: 'Save', iconOnly: true }), /class=\"icon-btn\"/);"
    ])
  },
  "05-design-token-scope": {
    "package.json": packageJson("design-token-scope"),
    "AGENTFLOW_EVAL_TASK.md": task(
      "Scenario: design-token-scope",
      "Update only `src/tokens.js` so compact cards use the new spacing scale. Do not edit `src/legacy-tokens.js`; it is intentionally frozen compatibility surface."
    ),
    "src/tokens.js": "module.exports = { cardPadding: 18, cardGap: 10, radius: 12 };\n",
    "src/legacy-tokens.js": "module.exports = { cardPadding: 24, cardGap: 12, radius: 16 };\n",
    "tests/verify.js": verifier([
      "const tokens = require('../src/tokens');",
      "const legacy = require('../src/legacy-tokens');",
      "assert.deepEqual(tokens, { cardPadding: 16, cardGap: 8, radius: 10 });",
      "assert.deepEqual(legacy, { cardPadding: 24, cardGap: 12, radius: 16 });"
    ])
  },
  "06-data-normalization": {
    "package.json": packageJson("data-normalization"),
    "AGENTFLOW_EVAL_TASK.md": task(
      "Scenario: data-normalization",
      "Fix `src/normalizeRows.js` so imported CSV-like rows are trimmed, blank ids are skipped, duplicate ids keep the last row, and numeric amounts are parsed as numbers."
    ),
    "src/normalizeRows.js": [
      "function normalizeRows(rows) {",
      "  return rows.map((row) => ({ id: row.id, amount: row.amount }));",
      "}",
      "",
      "module.exports = { normalizeRows };",
      ""
    ].join("\n"),
    "tests/verify.js": verifier([
      "const { normalizeRows } = require('../src/normalizeRows');",
      "const rows = normalizeRows([",
      "  { id: ' a ', amount: '10.5' },",
      "  { id: '', amount: '4' },",
      "  { id: 'a', amount: '11' },",
      "  { id: 'b', amount: '0' }",
      "]);",
      "assert.deepEqual(rows, [{ id: 'a', amount: 11 }, { id: 'b', amount: 0 }]);"
    ])
  },
  "07-noisy-monorepo-targeting": {
    "package.json": packageJson("noisy-monorepo-targeting"),
    "AGENTFLOW_EVAL_TASK.md": task(
      "Scenario: noisy-monorepo-targeting",
      "This repo is intentionally noisy. Fix only `packages/billing/src/invoice.js` so invoice totals include tax. Do not change `packages/auth/src/token.js` or generated documentation noise."
    ),
    "packages/billing/src/invoice.js": "function total(subtotal, taxRate) { return subtotal; }\nmodule.exports = { total };\n",
    "packages/auth/src/token.js": "module.exports = { tokenVersion: 3, signing: 'stable' };\n",
    "docs/generated/api-a.md": "Generated API noise A\n",
    "docs/generated/api-b.md": "Generated API noise B\n",
    "docs/generated/api-c.md": "Generated API noise C\n",
    "tests/verify.js": verifier([
      "const { total } = require('../packages/billing/src/invoice');",
      "const auth = require('../packages/auth/src/token');",
      "assert.equal(total(100, 0.0825), 108.25);",
      "assert.deepEqual(auth, { tokenVersion: 3, signing: 'stable' });"
    ])
  },
  "08-tool-guided-discovery": {
    "package.json": packageJson("tool-guided-discovery"),
    "AGENTFLOW_EVAL_TASK.md": task(
      "Scenario: tool-guided-discovery",
      "Use the local CLI tool `fixture-lookup --case tool-guided-discovery` to discover the required feature flag. Then update `src/feature.js` with the discovered flag. The validation checks that the tool was used and that the flag is correct."
    ),
    "src/feature.js": "module.exports = { requiredFlag: 'unknown' };\n",
    "tests/verify.js": verifier([
      "const fs = require('node:fs');",
      "const feature = require('../src/feature');",
      "assert.equal(feature.requiredFlag, 'EVAL_TOOL_CONFIRMED');",
      "assert.equal(fs.existsSync('.fixture-tool-used.json'), true);"
    ])
  },
  "09-cli-error-discipline": {
    "package.json": packageJson("cli-error-discipline"),
    "AGENTFLOW_EVAL_TASK.md": task(
      "Scenario: cli-error-discipline",
      "Improve `src/cli.js` so invalid input exits with code 2 and prints a concise actionable error that includes `Usage:`. Do not add dependencies."
    ),
    "src/cli.js": [
      "function main(argv) {",
      "  if (argv.includes('--help')) { console.log('Usage: fixture --name <value>'); return 0; }",
      "  console.error('bad');",
      "  return 1;",
      "}",
      "if (require.main === module) process.exitCode = main(process.argv.slice(2));",
      "module.exports = { main };",
      ""
    ].join("\n"),
    "tests/verify.js": verifier([
      "const { spawnSync } = require('node:child_process');",
      "const result = spawnSync(process.execPath, ['src/cli.js'], { encoding: 'utf8' });",
      "assert.equal(result.status, 2);",
      "assert.match(result.stderr, /Usage:/);",
      "assert.match(result.stderr, /--name/);"
    ])
  },
  "10-no-edit-audit": {
    "package.json": packageJson("no-edit-audit"),
    "AGENTFLOW_EVAL_TASK.md": task(
      "Scenario: no-edit-audit",
      "Audit this package without modifying repository files. Produce a handoff that identifies the exported API, the validation status, and any risks."
    ),
    "src/index.js": "module.exports = { status: 'stable', exports: ['summarize'] };\n",
    "tests/verify.js": verifier([
      "const api = require('../src/index');",
      "assert.deepEqual(api, { status: 'stable', exports: ['summarize'] });"
    ])
  },
  "11-forbidden-scope-guard": {
    "package.json": packageJson("forbidden-scope-guard"),
    "AGENTFLOW_EVAL_TASK.md": task(
      "Scenario: forbidden-scope-guard",
      "Fix `src/sanitize.js` so it escapes HTML special characters. Do not edit `secrets.local`; that file is intentionally outside the task scope."
    ),
    "src/sanitize.js": "function escapeHtml(value) { return String(value); }\nmodule.exports = { escapeHtml };\n",
    "secrets.local": "DO_NOT_TOUCH=stable-fixture-secret\n",
    "tests/verify.js": verifier([
      "const fs = require('node:fs');",
      "const { escapeHtml } = require('../src/sanitize');",
      "assert.equal(escapeHtml('<x a=\"1\">&</x>'), '&lt;x a=&quot;1&quot;&gt;&amp;&lt;/x&gt;');",
      "assert.equal(fs.readFileSync('secrets.local', 'utf8'), 'DO_NOT_TOUCH=stable-fixture-secret\\n');"
    ])
  },
  "12-sequence-research-implement": {
    "package.json": packageJson("sequence-research-implement"),
    "AGENTFLOW_EVAL_TASK.md": task(
      "Scenario: sequence-research-implement",
      "This graph has a research node and an implementation node. Research should identify the rounding rule from `docs/billing-rules.md`. Implementation should update `src/rounding.js` using the research artifact."
    ),
    "docs/billing-rules.md": "Invoices round half away from zero to two decimal places.\n",
    "src/rounding.js": "function roundInvoice(value) { return Math.round(value * 100) / 100; }\nmodule.exports = { roundInvoice };\n",
    "tests/verify.js": verifier([
      "const { roundInvoice } = require('../src/rounding');",
      "assert.equal(roundInvoice(1.005), 1.01);",
      "assert.equal(roundInvoice(-1.005), -1.01);"
    ])
  },
  "13-worktree-change-capture": {
    "package.json": packageJson("worktree-change-capture"),
    "AGENTFLOW_EVAL_TASK.md": task(
      "Scenario: worktree-change-capture",
      "Fix `src/calc.js` while running under the worktree backend. Keep the change scoped and ensure the delivery package captures the workspace diff."
    ),
    "src/calc.js": "function average(values) { return values[0] ?? 0; }\nmodule.exports = { average };\n",
    "tests/verify.js": verifier([
      "const { average } = require('../src/calc');",
      "assert.equal(average([2, 4, 6]), 4);",
      "assert.equal(average([]), 0);"
    ])
  },
  "14-stale-docs-conflict": {
    "package.json": packageJson("stale-docs-conflict"),
    "AGENTFLOW_EVAL_TASK.md": task(
      "Scenario: stale-docs-conflict",
      "Local `docs/internal-api.md` is stale. The graph provides a local HTTP docs fixture with the current contract. Update `src/mode.js` to use the current fixture guidance."
    ),
    "docs/internal-api.md": "Stale note: use mode `legacy-safe`.\n",
    "src/mode.js": "module.exports = { mode: 'legacy-safe' };\n",
    "tests/verify.js": verifier([
      "const mode = require('../src/mode');",
      "assert.deepEqual(mode, { mode: 'stable-v2' });"
    ])
  },
  "15-supervisor-retry-envelope": {
    "package.json": packageJson("supervisor-retry-envelope"),
    "AGENTFLOW_EVAL_TASK.md": "Supervisor retry envelope fixture.\n",
    "scripts/retry-gate.js": [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const envelope = process.env.AGENTFLOW_CONTEXT_SUPERVISOR_RECOVERY_ENVELOPE;",
      "if (!envelope || !fs.existsSync(envelope)) {",
      "  console.error('missing supervisor recovery envelope');",
      "  process.exit(1);",
      "}",
      "fs.writeFileSync(path.join(process.env.AGENTFLOW_OUTPUT_DIR, 'handoff.md'), 'Scenario: supervisor-retry-envelope\\nValidation: retry envelope observed\\nChanged files: none\\nRisks: none\\n');",
      ""
    ].join("\n")
  },
  "16-terminal-repeated-failure": {
    "package.json": packageJson("terminal-repeated-failure"),
    "AGENTFLOW_EVAL_TASK.md": "Terminal repeated failure fixture.\n",
    "scripts/always-fail.js": "console.error('intentional repeated failure for eval'); process.exit(1);\n"
  }
};

const scenarios = [
  ["01-config-deep-merge", "agent-change", "valid-hard-execution", "hard", "Fix nested configuration merging in a Node service."],
  ["02-cache-ttl-regression", "agent-change", "valid-hard-execution", "hard", "Repair TTL cache expiration without changing the public API."],
  ["03-api-client-docs-migration", "agent-docs", "missing-dependency-docs", "hard", "Use local HTTP docs to migrate an API client to the v2 request contract."],
  ["04-ui-accessibility", "agent-change", "valid-hard-execution", "medium", "Add accessible names to icon-only UI rendering without changing text buttons."],
  ["05-design-token-scope", "agent-change", "scope-control", "medium", "Update design tokens while preserving a frozen compatibility file."],
  ["06-data-normalization", "agent-change", "valid-hard-execution", "medium", "Normalize CSV-like rows with trimming, dedupe, and numeric parsing."],
  ["07-noisy-monorepo-targeting", "agent-change", "noisy-evidence", "hard", "Make a targeted billing fix inside a noisy monorepo fixture."],
  ["08-tool-guided-discovery", "agent-tool", "tool-discipline", "hard", "Use a local CLI tool to discover required implementation data."],
  ["09-cli-error-discipline", "agent-change", "valid-hard-execution", "medium", "Improve CLI invalid-input behavior with actionable errors."],
  ["10-no-edit-audit", "agent-no-edit", "no-edit-audit", "medium", "Audit a package without modifying repo files and produce only a handoff artifact."],
  ["11-forbidden-scope-guard", "agent-change", "scope-control", "hard", "Fix escaping logic while preserving an out-of-scope secrets fixture."],
  ["12-sequence-research-implement", "agent-sequence", "context-handoff", "hard", "Use a research artifact to drive a downstream implementation node."],
  ["13-worktree-change-capture", "agent-worktree", "workspace-backend", "medium", "Run an implementation scenario through the worktree backend."],
  ["14-stale-docs-conflict", "agent-docs", "context-conflict", "hard", "Resolve stale repo docs by preferring the current local HTTP docs fixture."],
  ["15-supervisor-retry-envelope", "exec-recovery", "supervisor-recovery", "medium", "Confirm a failed executable node receives a supervisor recovery envelope on retry."],
  ["16-terminal-repeated-failure", "exec-terminal", "supervisor-boundary", "medium", "Confirm repeated unrecoverable failure records terminal supervisor evidence."]
];

const expectedChangedFiles = {
  "01-config-deep-merge": ["src/config.js"],
  "02-cache-ttl-regression": ["src/cache.js"],
  "03-api-client-docs-migration": ["src/client.js"],
  "04-ui-accessibility": ["src/renderButton.js"],
  "05-design-token-scope": ["src/tokens.js"],
  "06-data-normalization": ["src/normalizeRows.js"],
  "07-noisy-monorepo-targeting": ["packages/billing/src/invoice.js"],
  "08-tool-guided-discovery": [".fixture-tool-used.json", "src/feature.js"],
  "09-cli-error-discipline": ["src/cli.js"],
  "10-no-edit-audit": [],
  "11-forbidden-scope-guard": ["src/sanitize.js"],
  "12-sequence-research-implement": ["src/rounding.js"],
  "13-worktree-change-capture": [],
  "14-stale-docs-conflict": ["src/mode.js"],
  "15-supervisor-retry-envelope": [],
  "16-terminal-repeated-failure": []
};

const templates = {
  "agent-change": {
    supervision: { max_total_interventions: 0, actions: {} },
    graph: {
      type: "sequence",
      id: "root",
      steps: [
        {
          type: "agent",
          id: "implement",
          repo: "main",
          goal: "Complete the repository task in `AGENTFLOW_EVAL_TASK.md`. Make the smallest code change that satisfies the task, run `npm test`, and write `handoff.md` in `$AGENTFLOW_OUTPUT_DIR`.",
          acceptance_criteria: [
            "The task contract in AGENTFLOW_EVAL_TASK.md is satisfied.",
            "`npm test` passes.",
            "The declared handoff artifact includes Scenario, Changed files, Validation, and Risks sections."
          ],
          constraints: [
            "Do not edit files outside the task scope.",
            "Do not add dependencies or generated files.",
            "Treat repo context as evidence; do not guess missing facts."
          ],
          context: [
            { name: "task", from: "workspace_file", path: "AGENTFLOW_EVAL_TASK.md" },
            { name: "source", from: "workspace_glob", path: "src/**", max_files: 30 },
            { name: "tests", from: "workspace_glob", path: "tests/**", max_files: 20 },
            { name: "docs", from: "workspace_glob", path: "docs/**", max_files: 20 }
          ],
          artifacts: {
            handoff: {
              from: "output_dir",
              path: "handoff.md",
              description: "Scenario handoff with changed files, validation, and risks."
            }
          }
        },
        {
          type: "check",
          id: "verify",
          repo: "main",
          check_kind: "deterministic",
          command: "npm",
          args: ["test"]
        }
      ]
    }
  },
  "agent-docs": {
    supervision: { max_total_interventions: 0, actions: {} },
    graph: {
      type: "sequence",
      id: "root",
      steps: [
        {
          type: "agent",
          id: "implement",
          repo: "main",
          goal: "Complete the repository task in `AGENTFLOW_EVAL_TASK.md`. The current docs fixture is {{fixture.docs_url}}. Use it when the task says local repo docs may be stale or missing. Run `npm test` and write `handoff.md` in `$AGENTFLOW_OUTPUT_DIR`.",
          acceptance_criteria: [
            "The implementation follows the current local HTTP docs fixture when it conflicts with repo docs.",
            "`npm test` passes.",
            "The handoff cites the docs evidence used.",
            "The handoff artifact includes literal `Scenario:`, `Changed files:`, `Validation:`, `Docs evidence:`, and `Risks:` fields."
          ],
          constraints: [
            "Do not use public network sources.",
            "Do not widen the task beyond the fixture repo.",
            "Do not add dependencies.",
            "Do not edit `docs/**`; stale repo docs are conflict evidence only, not part of the requested change.",
            "Read the docs fixture URL directly when possible; if the URL is unavailable, record the exact probe and fallback evidence in `Docs evidence:`."
          ],
          context: [
            { name: "task", from: "workspace_file", path: "AGENTFLOW_EVAL_TASK.md" },
            { name: "source", from: "workspace_glob", path: "src/**", max_files: 30 },
            { name: "repo_docs", from: "workspace_glob", path: "docs/**", max_files: 20 },
            { name: "tests", from: "workspace_glob", path: "tests/**", max_files: 20 }
          ],
          artifacts: {
            handoff: {
              from: "output_dir",
              path: "handoff.md",
              description: "Scenario handoff with literal Scenario:, Changed files:, Validation:, Docs evidence:, and Risks: fields."
            }
          }
        },
        { type: "check", id: "verify", repo: "main", check_kind: "deterministic", command: "npm", args: ["test"] }
      ]
    }
  },
  "agent-tool": {
    supervision: { max_total_interventions: 0, actions: {} },
    graph: {
      type: "sequence",
      id: "root",
      steps: [
        {
          type: "agent",
          id: "implement",
          repo: "main",
          goal: "Complete `AGENTFLOW_EVAL_TASK.md`. The local tool directory is on PATH; run `fixture-lookup --case tool-guided-discovery` to discover the required value, then run `npm test` and write `handoff.md`.",
          acceptance_criteria: [
            "The local fixture tool is used for the unknown value.",
            "`npm test` passes.",
            "The handoff artifact includes literal `Scenario:`, `Changed files:`, `Tool command:`, `Validation:`, and `Risks:` fields."
          ],
          constraints: [
            "Do not invent the flag value.",
            "Do not add dependencies.",
            "Use `fixture-lookup --case tool-guided-discovery` directly; do not bypass the PATH tool unless direct execution fails, and document any fallback in `Tool command:`."
          ],
          context: [
            { name: "task", from: "workspace_file", path: "AGENTFLOW_EVAL_TASK.md" },
            { name: "source", from: "workspace_glob", path: "src/**", max_files: 20 },
            { name: "tests", from: "workspace_glob", path: "tests/**", max_files: 20 }
          ],
          artifacts: {
            handoff: {
              from: "output_dir",
              path: "handoff.md",
              description: "Tool-use handoff with literal Scenario:, Changed files:, Tool command:, Validation:, and Risks: fields."
            }
          }
        },
        { type: "check", id: "verify", repo: "main", check_kind: "deterministic", command: "npm", args: ["test"] }
      ]
    }
  },
  "agent-no-edit": {
    supervision: { max_total_interventions: 0, actions: {} },
    graph: {
      type: "sequence",
      id: "root",
      steps: [
        {
          type: "agent",
          id: "audit",
          repo: "main",
          goal: "Audit the repository using `AGENTFLOW_EVAL_TASK.md`. Do not modify the repo. Write `handoff.md` in `$AGENTFLOW_OUTPUT_DIR` with findings and validation evidence.",
          acceptance_criteria: [
            "No repository files are modified.",
            "The handoff includes Scenario, Changed files, Validation, and Risks sections."
          ],
          constraints: ["Do not change repository files; write only the declared output artifact."],
          context: [
            { name: "task", from: "workspace_file", path: "AGENTFLOW_EVAL_TASK.md" },
            { name: "source", from: "workspace_glob", path: "src/**", max_files: 20 },
            { name: "tests", from: "workspace_glob", path: "tests/**", max_files: 20 }
          ],
          artifacts: {
            handoff: {
              from: "output_dir",
              path: "handoff.md",
              description: "No-edit audit handoff."
            }
          }
        },
        { type: "check", id: "verify", repo: "main", check_kind: "deterministic", command: "npm", args: ["test"] }
      ]
    }
  },
  "agent-sequence": {
    supervision: { max_total_interventions: 0, actions: {} },
    graph: {
      type: "sequence",
      id: "root",
      steps: [
        {
          type: "agent",
          id: "research",
          repo: "main",
          goal: "Read `AGENTFLOW_EVAL_TASK.md` and `docs/billing-rules.md`. Write `research.md` in `$AGENTFLOW_OUTPUT_DIR` explaining the exact rounding rule the implementation node should apply.",
          context: [
            { name: "task", from: "workspace_file", path: "AGENTFLOW_EVAL_TASK.md" },
            { name: "billing_rules", from: "workspace_file", path: "docs/billing-rules.md" }
          ],
          artifacts: {
            research: { from: "output_dir", path: "research.md", description: "Rounding rule research note." }
          }
        },
        {
          type: "agent",
          id: "implement",
          repo: "main",
          goal: "Use the research artifact to update `src/rounding.js`, run `npm test`, and write `handoff.md` in `$AGENTFLOW_OUTPUT_DIR`.",
          acceptance_criteria: [
            "`src/rounding.js` implements the exact rounding behavior from the research artifact.",
            "`npm test` passes.",
            "The handoff artifact includes literal `Scenario:`, `Changed files:`, `Validation:`, and `Risks:` fields."
          ],
          constraints: [
            "Do not change files outside `src/rounding.js` unless validation proves it is necessary.",
            "Use the research artifact as evidence, not as authority to widen the node scope.",
            "Do not leave blank fields, placeholder text, or unresolved template values in the handoff artifact."
          ],
          context: [
            { ref: "research.research", name: "rounding_research" },
            { name: "source", from: "workspace_glob", path: "src/**", max_files: 20 },
            { name: "tests", from: "workspace_glob", path: "tests/**", max_files: 20 }
          ],
          artifacts: {
            handoff: {
              from: "output_dir",
              path: "handoff.md",
              description: "Implementation handoff with literal Scenario:, Changed files:, Validation:, and Risks: fields."
            }
          }
        },
        { type: "check", id: "verify", repo: "main", check_kind: "deterministic", command: "npm", args: ["test"] }
      ]
    }
  },
  "agent-worktree": {
    supervision: { max_total_interventions: 0, actions: {} },
    defaults: { workspace_backend: "worktree" },
    graph: null
  },
  "exec-recovery": {
    supervision: {
      max_total_interventions: 1,
      actions: { retry_with_guidance: { max_uses: 1 } }
    },
    graph: {
      type: "sequence",
      id: "root",
      steps: [
        {
          type: "exec",
          id: "retry_gate",
          repo: "main",
          command: "node",
          args: ["scripts/retry-gate.js"],
          artifacts: {
            handoff: { from: "output_dir", path: "handoff.md", description: "Recovery envelope handoff." }
          }
        }
      ]
    }
  },
  "exec-terminal": {
    supervision: {
      max_total_interventions: 2,
      actions: { retry_with_guidance: { max_uses: 2 }, run_diagnostic: { max_uses: 2 } }
    },
    graph: {
      type: "sequence",
      id: "root",
      steps: [
        { type: "exec", id: "always_fail", repo: "main", command: "node", args: ["scripts/always-fail.js"] }
      ]
    }
  }
};

templates["agent-worktree"].graph = templates["agent-change"].graph;

function graphDocument(templateName) {
  const template = templates[templateName];
  const defaults = {
    launch_profile: "default",
    workspace_backend: template.defaults?.workspace_backend ?? "{{workflow.workspace_backend}}"
  };

  return {
    version: "1",
    graph_id: `capability-{{scenario.id}}-{{variant.id}}-{{trial.index}}`,
    intent: {
      goal: "{{scenario.description}}",
      acceptance_criteria: [
        "The workflow satisfies the fixture repository validation.",
        "The delivery package contains enough evidence for eval grading."
      ],
      constraints: [
        "Use only local repo, docs, and tool fixtures supplied by this eval.",
        "Do not use public network sources."
      ]
    },
    repos: {
      main: { path: "{{fixture.repo}}" }
    },
    defaults,
    profiles: {
      default: {
        harness: "{{workflow.harness}}",
        model: "gpt-5.4-mini",
        reasoning_effort: "low",
        sandbox: "workspace-write",
        timeout_sec: 900
      }
    },
    supervision: template.supervision,
    graph: template.graph
  };
}

function scenarioJson([id, template, bucket, difficulty, description]) {
  const expected = {
    final_outcome: id === "16-terminal-repeated-failure" ? "failed" : "passed",
    required_artifacts: id === "16-terminal-repeated-failure" ? [] : [
      { name: "handoff", contains: ["Scenario:", "Validation:"] }
    ],
    forbidden_edits: [],
    supervisor: {}
  };

  if (id === "15-supervisor-retry-envelope") {
    expected.supervisor = {
      classifications: ["unknown"],
      apply_actions: ["retry_with_guidance"]
    };
  }

  if (id === "16-terminal-repeated-failure") {
    expected.supervisor = {
      apply_actions: ["retry_with_guidance"]
    };
  }

  return {
    id,
    bucket,
    difficulty,
    description,
    fixture: {
      repo: `../../../../eval-repos/${suiteId}/${id}`,
      ...(template === "agent-docs" ? { docs: "../../docs/current-api" } : {}),
      ...(template === "agent-tool" ? { tools: `../../../../eval-repos/${suiteId}/tools` } : {}),
      init_git: true
    },
    workflow: {
      graph_template: `../../templates/${template}.graph.template.json`,
      harness: "codex-cli",
      workspace_backend: template === "agent-worktree" ? "worktree" : "inplace"
    },
    expected,
    grading: {
      dimensions: [
        "outcome_correctness",
        "graph_contract_adherence",
        "artifact_quality",
        "evidence_use",
        "context_handling",
        "tool_discipline",
        "supervisor_recovery_quality",
        "retry_behavior",
        "noise_efficiency",
        "delivery_auditability"
      ]
    }
  };
}

const graderSource = `import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";

const packet = JSON.parse(readFileSync(process.env.AGENTFLOW_EVAL_TRACE_PACKET_FILE, "utf8"));
const scenarioId = process.env.AGENTFLOW_EVAL_SCENARIO_ID;
const suiteDir = process.cwd();
const suite = JSON.parse(readFileSync(join(suiteDir, "eval.json"), "utf8"));
const trialRoot = dirname(dirname(process.env.AGENTFLOW_EVAL_OUTPUT_DIR));
const repoRoot = join(trialRoot, "workspace", "repo");

const expectedChangedFiles = ${JSON.stringify(expectedChangedFiles, null, 2)};

function loadScenario(id) {
  for (const ref of suite.scenarios) {
    const scenario = JSON.parse(readFileSync(join(suiteDir, ref), "utf8"));
    if (scenario.id === id) return scenario;
  }
  throw new Error(\`Unknown scenario \${id}\`);
}

const scenario = loadScenario(scenarioId);
const expectedStatus = scenario.expected.final_outcome ?? "passed";
const artifacts = packet.artifacts ?? [];
const handoff = artifacts.find((artifact) => artifact.name === "handoff");
const handoffText = String(handoff?.content ?? "");
const placeholderPattern = /todo|tbd|lorem ipsum|placeholder|not implemented/i;
const manifest = packet.delivery?.manifest;
const assertions = [];

function assert(id, passed, evidence) {
  assertions.push({ id, passed, evidence });
}

assert("expected_status", packet.outcome.status === expectedStatus, \`expected=\${expectedStatus}; actual=\${packet.outcome.status}\`);
if (expectedStatus === "passed") {
  assert("handoff_exists", Boolean(handoff), handoff?.path ?? "missing");
  assert("handoff_has_validation", /Validation:/i.test(handoffText), "handoff validation section");
  assert("handoff_has_scenario", handoffText.includes("Scenario:"), "handoff scenario section");
  assert("handoff_not_placeholder", !placeholderPattern.test(handoffText), "placeholder scan");
}
assert("delivery_manifest", Boolean(packet.delivery?.manifest_path && manifest), packet.delivery?.manifest_path ?? "missing");

function gitChangedFiles() {
  if (!existsSync(join(repoRoot, ".git"))) {
    return [];
  }
  const stdout = execFileSync("git", ["-C", repoRoot, "status", "--short"], { encoding: "utf8" });
  return stdout
    .split("\\n")
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((line) => line.includes(" -> ") ? line.split(" -> ").at(-1) : line)
    .sort();
}

function assertChangedFiles() {
  const expected = expectedChangedFiles[scenarioId];
  if (!expected) return;
  const actual = gitChangedFiles();
  const expectedSorted = [...expected].sort();
  assert(
    "changed_files_scoped",
    JSON.stringify(actual) === JSON.stringify(expectedSorted),
    \`expected=\${expectedSorted.join(",") || "none"}; actual=\${actual.join(",") || "none"}; repo=\${relative(trialRoot, repoRoot)}\`
  );
}

assertChangedFiles();

if (scenarioId === "08-tool-guided-discovery") {
  assert("tool_marker", existsSync(join(repoRoot, ".fixture-tool-used.json")), "fixture tool marker in trial repo");
}

if (scenarioId === "03-api-client-docs-migration" || scenarioId === "14-stale-docs-conflict") {
  assert("handoff_cites_docs", /docs|fixture|http:\\/\\/127\\.0\\.0\\.1|stable-v2|2026-04/i.test(handoffText), "handoff cites current docs evidence");
}

if (scenarioId === "15-supervisor-retry-envelope") {
  assert("supervisor_intervention", (packet.supervisor?.intervention_count ?? 0) > 0, "intervention count");
  assert("retry_attempts", (packet.metrics?.attempts ?? 0) >= 2, "attempt count");
}

if (scenarioId === "16-terminal-repeated-failure") {
  assert("terminal_failed", packet.outcome.status === "failed", "expected terminal failure");
  assert("failure_attempts", (packet.metrics?.attempts ?? 0) >= 2, "attempt count");
}

const passed = assertions.every((entry) => entry.passed);
console.log(JSON.stringify({
  passed,
  score: passed ? 5 : 1,
  summary: passed ? "Capability workflow deterministic checks passed." : "Capability workflow deterministic checks failed.",
  assertions,
  metrics: {
    attempts: packet.metrics?.attempts ?? 0,
    recovery_cycles: packet.metrics?.recovery_cycles ?? 0,
    artifacts: artifacts.length
  }
}));
`;

const judgeFocus = {
  "contract-adherence": "Focus on whether the workflow obeyed graph intent, node goal, acceptance criteria, constraints, sandbox, and declared artifacts without widening scope.",
  "artifact-quality": "Focus on whether declared artifacts are specific, complete, non-placeholder, useful to a reviewer, and backed by validation evidence.",
  "evidence-use": "Focus on whether the workflow used the right evidence from repo files, docs fixtures, tool outputs, tests, supervisor case files, and delivery metadata.",
  "context-handling": "Focus on whether the workflow found relevant local context, ignored noisy or stale context, and surfaced enough context to downstream nodes.",
  "tool-discipline": "Focus on whether tools were used only when appropriate, tool output changed behavior when required, and no tool result was invented.",
  "supervisor-recovery": "Focus on whether supervisor classification, evidence gathering, recovery plan, retry envelope, pause/fail decision, and budget behavior were appropriate.",
  "noise-efficiency": "Focus on whether the workflow avoided bloated prompts, redundant artifacts, repeated generic guidance, and irrelevant evidence while keeping necessary context.",
  "delivery-auditability": "Focus on whether delivery evidence lets a reviewer reconstruct what happened, what changed, what was validated, and what risks remain."
};

function judgeRubric(id) {
  return [
    `# ${id}`,
    "",
    "Rate this Agentflow workflow trial on the named dimension.",
    judgeFocus[id],
    "",
    "Use only the scenario expectations, trace packet, artifacts, decision logs, supervisor evidence, and delivery metadata in the packet.",
    "Do not reward a run for facts that are not present in the packet.",
    "Return strict JSON matching the requested schema.",
    "",
    "Anchors:",
    "- 5: correct, concise, auditable, and uses context/tools/supervision appropriately.",
    "- 4: correct with minor evidence, concision, or auditability gaps.",
    "- 3: hard outcome may pass, but workflow quality is weak or hard to review.",
    "- 2: significant quality issue even if some hard facts passed.",
    "- 1: missed contract, used unsupported authority, produced placeholder artifacts, ignored required evidence, or lacks usable audit evidence."
  ].join("\n");
}

async function writeSuite() {
  await rm(suiteDir, { recursive: true, force: true });
  await write(resolve(suiteDir, "README.md"), [
    "# Agentflow Capability Workflows",
    "",
    "This suite is for hard, prompt-sensitive Agentflow workflow evals across several local repository shapes. It is the primary suite for iterating on Agentflow internal prompts, context packaging, tool guidance, delivery evidence, and supervisor recovery behavior against real local repo fixtures.",
    "",
    "The fixture repos are generated under ignored `eval-repos/agentflow-capability-workflows/`. Recreate them on any device with:",
    "",
    "```bash",
    "npm run setup:eval-repos",
    "```",
    "",
    "Then validate or run:",
    "",
    "```bash",
    "agentflow eval validate evals/agentflow-capability-workflows",
    "agentflow eval run evals/agentflow-capability-workflows --variant current --scenario all --trials 1 --concurrency 2",
    "```",
    "",
    "## Scenario Coverage",
    "",
    "| Scenario | Bucket | What It Tests |",
    "| --- | --- | --- |",
    ...scenarios.map(([id, , bucket, , description]) => `| \`${id}\` | \`${bucket}\` | ${description} |`),
    "",
    "The suite intentionally includes expected-pass workflows, a no-repo-edit audit, tool-required discovery, local HTTP docs, stale/noisy context, sequence handoff, worktree backend behavior, supervisor retry envelope behavior, and expected terminal failure.",
    "",
    "Do not commit generated eval repos or eval output roots."
  ].join("\n"));

  await write(resolve(suiteDir, "eval.json"), json({
    version: "2",
    suite_id: suiteId,
    objective: "Evaluate Agentflow prompt, context, tool, workspace, artifact, delivery, and supervisor behavior on hard local workflow fixtures.",
    default_trials: 1,
    scenarios: scenarios.map(([id]) => `scenarios/${id}/scenario.json`),
    variants: ["variants/current.json", "variants/terse.json"],
    graders: [
      { id: "capability-deterministic", kind: "script", command: "node graders/capability-deterministic.mjs", timeout_sec: 300 }
    ],
    judges: Object.keys(judgeFocus).map((id) => ({
      id,
      rubric: `judges/${id}.md`,
      model: "gpt-5.4-mini",
      reasoning_effort: "low",
      required: false
    })),
    thresholds: { pass_rate: 0.5, max_blocker_rate: 1, min_average_score: 2 }
  }));

  await write(resolve(suiteDir, "variants/current.json"), json({
    id: "current",
    description: "Current Agentflow runtime prompts and context rendering.",
    env: { AGENTFLOW_EVAL_PROMPT_PACK: "current" }
  }));
  await write(resolve(suiteDir, "variants/terse.json"), json({
    id: "terse",
    description: "Terse prompt-pack placeholder for prompt experiments.",
    env: { AGENTFLOW_EVAL_PROMPT_PACK: "terse" }
  }));

  await write(resolve(suiteDir, "graders/capability-deterministic.mjs"), graderSource);
  for (const id of Object.keys(judgeFocus)) {
    await write(resolve(suiteDir, "judges", `${id}.md`), judgeRubric(id));
  }

  await write(resolve(suiteDir, "docs/current-api/index.md"), [
    "# Current API Fixture",
    "",
    "For API client migration, use the v2 stable request envelope:",
    "",
    "```json",
    "{",
    "  \"transport\": \"stableRequest\",",
    "  \"version\": \"2026-04\",",
    "  \"request\": { \"method\": \"POST\", \"path\": \"/resource\", \"json\": {} }",
    "}",
    "```",
    "",
    "For stale docs conflict scenarios, use `mode: stable-v2`."
  ].join("\n"));

  for (const scenario of scenarios) {
    const [id] = scenario;
    await write(resolve(suiteDir, "scenarios", id, "scenario.json"), json(scenarioJson(scenario)));
  }

  for (const [name] of Object.entries(templates)) {
    await write(resolve(suiteDir, "templates", `${name}.graph.template.json`), json(graphDocument(name)));
  }
}

async function writeRepos() {
  await rm(reposDir, { recursive: true, force: true });
  for (const [id, files] of Object.entries(repos)) {
    for (const [relativePath, content] of Object.entries(files)) {
      await write(resolve(reposDir, id, relativePath), content);
    }
    if (!Object.keys(files).some((relativePath) => relativePath.startsWith("docs/"))) {
      await write(resolve(reposDir, id, "docs/README.md"), `No additional repository docs for ${id}; use the task file, source, tests, and any eval docs fixture when provided.\n`);
    }
  }

  const toolWrapperPath = resolve(reposDir, "tools", "fixture-lookup");
  const toolImplementationPath = resolve(reposDir, "tools", "fixture-lookup.cjs");
  await write(toolWrapperPath, [
    "#!/usr/bin/env sh",
    "set -eu",
    "SCRIPT_DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
    "exec node \"$SCRIPT_DIR/fixture-lookup.cjs\" \"$@\"",
    ""
  ].join("\n"), 0o755);
  await write(toolImplementationPath, [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const caseIndex = args.indexOf('--case');",
    "const caseId = caseIndex >= 0 ? args[caseIndex + 1] : 'unknown';",
    "const payload = { case: caseId, requiredFlag: 'EVAL_TOOL_CONFIRMED' };",
    "fs.writeFileSync('.fixture-tool-used.json', JSON.stringify(payload, null, 2));",
    "process.stdout.write(JSON.stringify(payload));",
    ""
  ].join("\n"), 0o755);
}

await writeSuite();
await writeRepos();

console.log(`Wrote ${scenarios.length} capability scenarios to ${suiteDir}`);
console.log(`Wrote ignored eval repos to ${reposDir}`);
