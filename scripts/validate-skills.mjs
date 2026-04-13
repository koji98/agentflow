import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const jsonMode = process.argv.includes("--json");

const requiredReferences = [
  "graph-authoring.md",
  "managed-workflows.md",
  "evals.md",
  "run-debugging.md",
  "graph-contract.md",
  "cli-and-validation.md",
  "failure-and-validation.md",
  "examples.md"
];

async function fileExists(relativePath) {
  try {
    await access(resolve(rootDir, relativePath), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readText(relativePath) {
  return readFile(resolve(rootDir, relativePath), "utf8");
}

async function validateSkills() {
  const checks = [];
  const failures = [];

  function record(name, passed, reason) {
    checks.push({ name, status: passed ? "passed" : "failed", reason });
    if (!passed) {
      failures.push(reason);
    }
  }

  const skillsEntries = await readdir(resolve(rootDir, "skills"), { withFileTypes: true });
  const skillDirs = skillsEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  record(
    "single packaged skill",
    skillDirs.length === 1 && skillDirs[0] === "agentflow",
    skillDirs.length === 1 && skillDirs[0] === "agentflow"
      ? "Only skills/agentflow is packaged."
      : `Expected only skills/agentflow, found: ${skillDirs.join(", ") || "none"}`
  );

  const requiredFiles = [
    "skills/agentflow/SKILL.md",
    "skills/agentflow/agents/openai.yaml",
    "skills/README.md",
    "docs/EVALS.md",
    ...requiredReferences.map((reference) => `skills/agentflow/references/${reference}`)
  ];
  const missingFiles = [];

  for (const file of requiredFiles) {
    if (!await fileExists(file)) {
      missingFiles.push(file);
    }
  }

  record(
    "required skill files",
    missingFiles.length === 0,
    missingFiles.length === 0
      ? "All required skill files and references are present."
      : `Missing required skill files: ${missingFiles.join(", ")}`
  );

  if (await fileExists("skills/agentflow/SKILL.md")) {
    const skill = await readText("skills/agentflow/SKILL.md");
    const missingReferences = requiredReferences.filter(
      (reference) => !skill.includes(`references/${reference}`)
    );

    record(
      "router references",
      missingReferences.length === 0,
      missingReferences.length === 0
        ? "SKILL.md routes to every required reference."
        : `SKILL.md does not route to: ${missingReferences.join(", ")}`
    );
  }

  const textFiles = [
    "skills/agentflow/SKILL.md",
    "skills/agentflow/agents/openai.yaml",
    "skills/README.md",
    ...requiredReferences.map((reference) => `skills/agentflow/references/${reference}`)
  ];
  const patchMarkerFiles = [];

  for (const file of textFiles) {
    if (await fileExists(file)) {
      const text = await readText(file);
      if (text.includes("*** Begin Patch") || text.includes("*** End Patch")) {
        patchMarkerFiles.push(file);
      }
    }
  }

  record(
    "no patch markers",
    patchMarkerFiles.length === 0,
    patchMarkerFiles.length === 0
      ? "Packaged skill files contain no patch markers."
      : `Patch markers found in: ${patchMarkerFiles.join(", ")}`
  );

  if (await fileExists("skills/agentflow/references/evals.md")) {
    const evals = await readText("skills/agentflow/references/evals.md");
    const requiredTerms = [
      "agentflow eval validate",
      "agentflow eval run",
      "agentflow eval report",
      "AGENTFLOW_EVAL_TRACE_FILE",
      "evaluation-ledger.json"
    ];
    const missingTerms = requiredTerms.filter((term) => !evals.includes(term));

    record(
      "eval reference contract",
      missingTerms.length === 0,
      missingTerms.length === 0
        ? "Eval reference includes the local eval command and artifact contract."
        : `Eval reference is missing: ${missingTerms.join(", ")}`
    );
  }

  const passed = failures.length === 0;

  return {
    status: passed ? "passed" : "failed",
    score: passed ? 1 : 0,
    checks,
    reasons: failures
  };
}

const result = await validateSkills();

if (jsonMode) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(`Skill validation ${result.status.toUpperCase()} (score ${result.score})\n`);
  for (const check of result.checks) {
    process.stdout.write(`[${check.status === "passed" ? "pass" : "fail"}] ${check.name}: ${check.reason}\n`);
  }
}

process.exitCode = result.status === "passed" ? 0 : 1;
