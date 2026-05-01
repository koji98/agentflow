import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const jsonMode = process.argv.includes("--json");

const requiredReferences = [
  "graph-authoring.md",
  "common-patterns.md",
  "github-rollout.md",
  "managed-workflows.md",
  "run-debugging.md",
  "graph-contract.md",
  "cli-and-validation.md",
  "failure-and-validation.md",
  "examples.md"
];

const requiredAgentflowPluginReferences = [
  "plugin-workflows.md"
];

const requiredAgentflowEvalReferences = [
  "eval-patterns.md",
  "suite-authoring.md",
  "grading-and-reporting.md",
  "operations-and-dogfood.md"
];

const staleSkillContractPatterns = [
  {
    pattern: /"required"\s*:\s*(true|false)/u,
    reason: 'artifact examples must use "description", not "required"'
  },
  {
    pattern: /\brequired:\s*(true|false)\b/u,
    reason: "artifact examples must use description, not required"
  },
  {
    pattern: /required or optional status/u,
    reason: "artifact prompt guidance must describe artifact descriptions, not required or optional status"
  },
  {
    pattern: /Use `required/u,
    reason: "producer artifacts are always required; do not teach required flags"
  },
  {
    pattern: /optional artifacts/u,
    reason: "producer artifacts are always required; use if_available on consumer artifact context only when missing material is acceptable"
  },
  {
    pattern: /context_(summary|packet|provenance)\.json|context_summary\.md/u,
    reason: "context files now live under context/packet.json, context/manifest.md, and context/provenance.json"
  },
  {
    pattern: /hashed names/u,
    reason: "node and execution directories now use readable ordered names"
  },
  {
    pattern: /\bmissing_artifact\b/u,
    reason: 'current supervisor failure class is "artifact_contract_failure"'
  },
  {
    pattern: /\bcontext_resolution\b/u,
    reason: 'current supervisor failure class is "missing_context"'
  },
  {
    pattern: /\bcheck_failed\b/u,
    reason: 'current supervisor failure classes are "diagnostic_needed" and "semantic_misalignment"'
  },
  {
    pattern: /every missing artifact/u,
    reason: "artifact synthesis only handles exactly one human-readable text artifact"
  }
];

const artifactContextReferenceFiles = new Set([
  "skills/agentflow/references/graph-authoring.md",
  "skills/agentflow/references/graph-contract.md",
  "skills/agentflow/references/cli-and-validation.md",
  "skills/agentflow/references/failure-and-validation.md",
  "skills/agentflow/references/examples.md"
]);

const graphContractReferenceFiles = new Set([
  "skills/agentflow/SKILL.md",
  "skills/agentflow/agents/openai.yaml",
  "skills/agentflow-plugins/SKILL.md",
  "skills/agentflow-plugins/agents/openai.yaml",
  "skills/README.md",
  ...requiredReferences.map((reference) => `skills/agentflow/references/${reference}`),
  ...requiredAgentflowPluginReferences.map((reference) => `skills/agentflow-plugins/references/${reference}`)
]);

const staleArtifactContextPatterns = [
  {
    pattern: /"optional"\s*:\s*(true|false)/u,
    reason: 'artifact context examples must use "if_available", not "optional"'
  },
  {
    pattern: /\boptional:\s*(true|false)\b/u,
    reason: "artifact context examples must use if_available, not optional"
  },
  {
    pattern: /optional artifact context/u,
    reason: "artifact context availability is expressed with if_available"
  },
  {
    pattern: /artifact context as optional/u,
    reason: "artifact context availability is expressed with if_available"
  },
  {
    pattern: /change optional context/u,
    reason: "artifact context availability is expressed with if_available"
  }
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
    "packaged skills",
    JSON.stringify(skillDirs) === JSON.stringify(["agentflow", "agentflow-evals", "agentflow-plugins"]),
    JSON.stringify(skillDirs) === JSON.stringify(["agentflow", "agentflow-evals", "agentflow-plugins"])
      ? "skills/agentflow, skills/agentflow-evals, and skills/agentflow-plugins are packaged."
      : `Expected skills/agentflow, skills/agentflow-evals, and skills/agentflow-plugins, found: ${skillDirs.join(", ") || "none"}`
  );

  const requiredFiles = [
    "skills/agentflow/SKILL.md",
    "skills/agentflow/agents/openai.yaml",
    "skills/agentflow-evals/SKILL.md",
    "skills/agentflow-evals/agents/openai.yaml",
    "skills/agentflow-plugins/SKILL.md",
    "skills/agentflow-plugins/agents/openai.yaml",
    "skills/README.md",
    ...requiredReferences.map((reference) => `skills/agentflow/references/${reference}`),
    ...requiredAgentflowEvalReferences.map((reference) => `skills/agentflow-evals/references/${reference}`),
    ...requiredAgentflowPluginReferences.map((reference) => `skills/agentflow-plugins/references/${reference}`)
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
    const missingReferences = [
      ...requiredReferences.filter(
      (reference) => !skill.includes(`references/${reference}`)
      ),
      ...(!skill.includes("agentflow-evals") ? ["agentflow-evals"] : []),
      ...(!skill.includes("agentflow-plugins") ? ["agentflow-plugins"] : [])
    ];

    record(
      "router references",
      missingReferences.length === 0,
      missingReferences.length === 0
        ? "SKILL.md routes to every required reference."
        : `SKILL.md does not route to: ${missingReferences.join(", ")}`
    );
  }

  if (await fileExists("skills/agentflow-evals/SKILL.md")) {
    const skill = await readText("skills/agentflow-evals/SKILL.md");
    const missingReferences = [
      ...requiredAgentflowEvalReferences.filter(
        (reference) => !skill.includes(`references/${reference}`)
      ),
      ...(!skill.includes("agentflow-plugins") ? ["agentflow-plugins"] : []),
      ...(!skill.includes("agentflow") ? ["agentflow"] : [])
    ];

    record(
      "eval router references",
      missingReferences.length === 0,
      missingReferences.length === 0
        ? "agentflow-evals/SKILL.md routes to every required reference and adjacent skill."
        : `agentflow-evals/SKILL.md does not route to: ${missingReferences.join(", ")}`
    );
  }

  const textFiles = [
    "skills/agentflow/SKILL.md",
    "skills/agentflow/agents/openai.yaml",
    "skills/agentflow-evals/SKILL.md",
    "skills/agentflow-evals/agents/openai.yaml",
    "skills/agentflow-plugins/SKILL.md",
    "skills/agentflow-plugins/agents/openai.yaml",
    "skills/README.md",
    ...requiredReferences.map((reference) => `skills/agentflow/references/${reference}`),
    ...requiredAgentflowEvalReferences.map((reference) => `skills/agentflow-evals/references/${reference}`),
    ...requiredAgentflowPluginReferences.map((reference) => `skills/agentflow-plugins/references/${reference}`)
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

  const staleSkillContractMatches = [];

  for (const file of textFiles) {
    if (!await fileExists(file)) {
      continue;
    }

    const text = await readText(file);
    const lines = text.split("\n");

    for (const [lineIndex, line] of lines.entries()) {
      if (graphContractReferenceFiles.has(file)) {
        for (const { pattern, reason } of staleSkillContractPatterns) {
          if (pattern.test(line)) {
            staleSkillContractMatches.push(`${file}:${lineIndex + 1}: ${reason}`);
          }
        }
      }
      if (artifactContextReferenceFiles.has(file)) {
        for (const { pattern, reason } of staleArtifactContextPatterns) {
          if (pattern.test(line)) {
            staleSkillContractMatches.push(`${file}:${lineIndex + 1}: ${reason}`);
          }
        }
      }
    }
  }

  record(
    "current graph contract terms",
    staleSkillContractMatches.length === 0,
    staleSkillContractMatches.length === 0
      ? "Packaged skill references use the current graph contract terms."
      : `Stale skill contract guidance found: ${staleSkillContractMatches.join("; ")}`
  );

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
