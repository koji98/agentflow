import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const jsonMode = process.argv.includes("--json");

const requiredSkillReferences = {
  "agentflow-authoring": [
    "composition-model.md",
    "managed-patterns.md",
    "deterministic-vs-rubric.md",
    "graph-quality-bar.md",
    "intent-writing.md",
    "prompt-translation.md",
    "support-surfaces.md"
  ],
  "agentflow-evals": [
    "eval-patterns.md",
    "suite-authoring.md",
    "grading-and-reporting.md",
    "operations-and-dogfood.md"
  ],
  "agentflow-intake": [
    "workflow-brief.md",
    "assurance-profiles.md",
    "grill-questions.md"
  ],
  "agentflow-operations": [
    "validation-launch-resume.md",
    "delivery-review.md",
    "failure-triage.md"
  ],
  "agentflow-plan-review": [
    "review-rubric.md",
    "anti-patterns.md",
    "prompt-translation-review.md"
  ],
  "agentflow-plugins": [
    "plugin-workflows.md"
  ],
  "agentflow-run-review": [
    "run-postmortem.md",
    "plugin-extraction.md",
    "eval-extraction.md"
  ]
};

const expectedSkillDirs = Object.keys(requiredSkillReferences).sort();
const deletedBroadSkillTokenPattern = new RegExp(`\\$${"agentflow"}(?!-)`, "u");
const deletedGrillSkillName = `agentflow-${"grill-me"}`;
const deletedBroadSkillPath = `skills/${"agentflow"}/`;
const textFiles = [
  "skills/README.md",
  ...expectedSkillDirs.flatMap((skill) => [
    `skills/${skill}/SKILL.md`,
    `skills/${skill}/agents/openai.yaml`,
    ...requiredSkillReferences[skill].map((reference) => `skills/${skill}/references/${reference}`)
  ])
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
    pattern: /context_(summary|packet|provenance)\.json|context_summary\.md|context\/(packet|manifest|provenance)\.(json|md)/u,
    reason: "context files now live under agent/context.md, runtime/context.json, and human-debug/context-provenance.json"
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
  },
  {
    pattern: /delivery\/(reviewer-guide|task-brief|implementation-summary|risk-notes|follow-up-items|run-map)\.md/u,
    reason: "delivery review now starts from 01-review-brief.md, 02-run-learnings.md, and 03-audit-index.md"
  },
  {
    pattern: /Graph-addressable outputs are `summary`, `packet`/u,
    reason: "deep research no longer exposes a public packet artifact"
  },
  {
    pattern: /managed research summary and packet/u,
    reason: "deep research handoffs should cite summary and selected raw angle artifacts, not a packet"
  }
];

const artifactContextReferenceFiles = new Set(
  textFiles.filter((file) => !file.startsWith("skills/agentflow-evals/"))
);

const graphContractReferenceFiles = new Set(
  textFiles.filter((file) => !file.startsWith("skills/agentflow-evals/"))
);

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
    JSON.stringify(skillDirs) === JSON.stringify(expectedSkillDirs),
    JSON.stringify(skillDirs) === JSON.stringify(expectedSkillDirs)
      ? `Packaged skills match the focused Agentflow workflow set: ${expectedSkillDirs.join(", ")}.`
      : `Expected focused Agentflow skills ${expectedSkillDirs.join(", ")}, found: ${skillDirs.join(", ") || "none"}`
  );

  const missingFiles = [];

  for (const file of textFiles) {
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

  const missingReferenceRoutes = [];

  for (const [skill, references] of Object.entries(requiredSkillReferences)) {
    const skillPath = `skills/${skill}/SKILL.md`;
    if (!await fileExists(skillPath)) {
      continue;
    }

    const skillText = await readText(skillPath);
    for (const reference of references) {
      if (!skillText.includes(`references/${reference}`)) {
        missingReferenceRoutes.push(`${skillPath} -> references/${reference}`);
      }
    }
  }

  record(
    "reference routes",
    missingReferenceRoutes.length === 0,
    missingReferenceRoutes.length === 0
      ? "Each focused SKILL.md routes to its required references."
      : `Missing reference routes: ${missingReferenceRoutes.join(", ")}`
  );

  const staleRoutingMatches = [];
  for (const file of textFiles) {
    if (!await fileExists(file)) {
      continue;
    }

    const text = await readText(file);
    if (deletedBroadSkillTokenPattern.test(text)) {
      staleRoutingMatches.push(`${file}: stale deleted broad skill reference`);
    }
    if (text.includes(deletedGrillSkillName) || text.includes(deletedBroadSkillPath)) {
      staleRoutingMatches.push(`${file}: stale deleted skill path or name`);
    }
  }

  record(
    "no stale deleted-skill routes",
    staleRoutingMatches.length === 0,
    staleRoutingMatches.length === 0
      ? "Skill package contains no deleted broad-skill or grill-skill routing references."
      : `Stale routing references found: ${staleRoutingMatches.join("; ")}`
  );

  const defaultPromptMismatches = [];

  for (const skill of expectedSkillDirs) {
    const openAiYamlPath = `skills/${skill}/agents/openai.yaml`;
    if (!await fileExists(openAiYamlPath)) {
      continue;
    }

    const openAiYaml = await readText(openAiYamlPath);
    if (!openAiYaml.includes(`$${skill}`)) {
      defaultPromptMismatches.push(openAiYamlPath);
    }
  }

  record(
    "default prompts name matching skills",
    defaultPromptMismatches.length === 0,
    defaultPromptMismatches.length === 0
      ? "Every generated agents/openai.yaml default_prompt names its matching skill."
      : `default_prompt does not name the matching skill in: ${defaultPromptMismatches.join(", ")}`
  );

  const requiredConstraintGuidance = [
    "skills/agentflow-authoring/SKILL.md",
    "skills/agentflow-authoring/references/graph-quality-bar.md",
    "skills/agentflow-plan-review/SKILL.md",
    "skills/agentflow-plan-review/references/review-rubric.md",
    "skills/agentflow-plan-review/references/anti-patterns.md",
    "skills/agentflow-intake/references/workflow-brief.md"
  ];
  const missingConstraintGuidance = [];

  for (const file of requiredConstraintGuidance) {
    if (!await fileExists(file)) {
      missingConstraintGuidance.push(file);
      continue;
    }

    const text = await readText(file);
    if (!text.includes("Do not")) {
      missingConstraintGuidance.push(file);
    }
  }

  record(
    "constraint guidance uses Do not",
    missingConstraintGuidance.length === 0,
    missingConstraintGuidance.length === 0
      ? 'Authoring and review guidance requires graph and node constraints to start with "Do not".'
      : `Missing Do not constraint guidance in: ${missingConstraintGuidance.join(", ")}`
  );

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
