#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, cp, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSuiteDir = resolve(rootDir, "evals", "agentflow-realworld-issues");
const defaultReposDir = resolve(rootDir, "eval-repos", "agentflow-realworld-issues");
const maxBuffer = 1024 * 1024 * 64;

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function ensureInside(parent, child, label) {
  const parentResolved = resolve(parent);
  const childResolved = resolve(child);
  const rel = relative(parentResolved, childResolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} must stay inside ${parentResolved}: ${childResolved}`);
  }
}

export function sanitizeRepoKey(sourceRepo) {
  return sourceRepo.toLowerCase().replace(/[^a-z0-9._-]+/gu, "__");
}

export function parseSetupRealworldArgs(argv) {
  const options = {
    suiteDir: defaultSuiteDir,
    reposDir: defaultReposDir,
    scenario: "all",
    force: true,
    install: true,
    sourceRoot: process.env.AGENTFLOW_REALWORLD_SOURCE_ROOT
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--suite" && next) {
      options.suiteDir = resolve(next);
      index += 1;
    } else if (arg === "--repos-root" && next) {
      options.reposDir = resolve(next);
      index += 1;
    } else if (arg === "--scenario" && next) {
      options.scenario = next;
      index += 1;
    } else if (arg === "--source-root" && next) {
      options.sourceRoot = resolve(next);
      index += 1;
    } else if (arg === "--skip-install") {
      options.install = false;
    } else if (arg === "--no-force") {
      options.force = false;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown setup-realworld-evals option: ${arg}`);
    }
  }

  return options;
}

export function buildCloneSpec({ sourceRepo, sourceRoot, destination }) {
  if (sourceRoot) {
    return {
      args: [resolve(sourceRoot, sanitizeRepoKey(sourceRepo)), destination],
      local: true
    };
  }

  return {
    args: [`https://github.com/${sourceRepo}.git`, destination],
    local: false
  };
}

export function buildNpmSetupSpec(setupCommand) {
  const parts = setupCommand.trim().split(/\s+/u).filter(Boolean);
  if (parts[0] !== "npm" || parts[1] !== "install") {
    throw new Error(`Unsupported real-world eval setup command: ${setupCommand}`);
  }

  const args = parts.slice(1);
  for (const arg of args) {
    if (arg !== "install" && !/^--[a-z0-9-]+(?:=.*)?$/u.test(arg)) {
      throw new Error(`Unsupported real-world eval setup argument "${arg}" in: ${setupCommand}`);
    }
  }

  return { command: "npm", args };
}

async function run(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env,
    maxBuffer
  });
  return result.stdout;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function loadSuiteScenarios(suiteDir) {
  const suite = await readJson(join(suiteDir, "eval.json"));
  const scenarios = [];
  for (const scenarioRef of suite.scenarios ?? []) {
    const scenarioPath = resolve(suiteDir, scenarioRef);
    const scenario = await readJson(scenarioPath);
    scenarios.push({
      ...scenario,
      scenario_path: scenarioPath,
      scenario_dir: dirname(scenarioPath)
    });
  }
  return scenarios;
}

async function ensureGitIdentity(repoDir) {
  await run("git", ["config", "user.email", "agentflow@example.com"], { cwd: repoDir });
  await run("git", ["config", "user.name", "Agentflow Eval"], { cwd: repoDir });
}

async function verifyLicense(repoDir, expectedLicense) {
  const candidates = ["LICENSE", "LICENSE.md", "license", "license.md"];
  for (const candidate of candidates) {
    const path = join(repoDir, candidate);
    if (await pathExists(path)) {
      const text = await readFile(path, "utf8");
      if (
        expectedLicense === "MIT" &&
        (/MIT License/i.test(text) || /Permission is hereby granted, free of charge/i.test(text))
      ) {
        return;
      }
    }
  }

  throw new Error(`Expected ${expectedLicense} license in ${repoDir}.`);
}

async function verifyBaseSha(repoDir, expectedSha) {
  const actual = (await run("git", ["rev-parse", "HEAD"], { cwd: repoDir })).trim();
  if (actual !== expectedSha) {
    throw new Error(`Expected ${expectedSha}, got ${actual} in ${repoDir}.`);
  }
}

async function verifyPackageManager(repoDir, expectedPackageManager) {
  if (expectedPackageManager !== "npm") {
    throw new Error(`Unsupported real-world eval package manager "${expectedPackageManager}".`);
  }

  if (!await pathExists(join(repoDir, "package.json"))) {
    throw new Error(`Real-world eval repo is missing package.json: ${repoDir}`);
  }
}

async function copyIfExists(from, to) {
  if (await pathExists(from)) {
    await cp(from, to, { recursive: true });
  }
}

async function installSharedDependencies({ repoDir, depsDir, setupCommand }) {
  await rm(depsDir, { recursive: true, force: true });
  await mkdir(depsDir, { recursive: true });
  await copyIfExists(join(repoDir, "package.json"), join(depsDir, "package.json"));
  await copyIfExists(join(repoDir, "package-lock.json"), join(depsDir, "package-lock.json"));
  await copyIfExists(join(repoDir, "npm-shrinkwrap.json"), join(depsDir, "npm-shrinkwrap.json"));

  const setup = buildNpmSetupSpec(setupCommand);
  await run(setup.command, setup.args, { cwd: depsDir });

  const repoNodeModules = join(repoDir, "node_modules");
  await rm(repoNodeModules, { recursive: true, force: true });
  await symlink(join(depsDir, "node_modules"), repoNodeModules, "dir");
  await writeFile(join(repoDir, ".git", "info", "exclude"), "\nnode_modules\n", { flag: "a" });
}

async function materializeScenario({ scenario, suiteDir, reposDir, force, install, sourceRoot }) {
  const realworld = scenario.metadata?.realworld;
  if (!realworld) {
    throw new Error(`Scenario ${scenario.id} is missing metadata.realworld.`);
  }

  const destination = resolve(scenario.scenario_dir, scenario.environment.repo);
  ensureInside(reposDir, destination, `Scenario ${scenario.id} fixture repo`);

  if (force) {
    await rm(destination, { recursive: true, force: true });
  } else if (await pathExists(destination)) {
    throw new Error(`Destination already exists: ${destination}`);
  }

  await mkdir(dirname(destination), { recursive: true });
  const clone = buildCloneSpec({
    sourceRepo: realworld.source_repo,
    sourceRoot,
    destination
  });

  if (clone.local) {
    if (!await pathExists(clone.args[0])) {
      throw new Error(`Local source repo does not exist: ${clone.args[0]}`);
    }
  }

  await run("git", ["clone", "--no-tags", ...clone.args]);
  await run("git", ["checkout", "--detach", realworld.base_sha], { cwd: destination });
  await verifyBaseSha(destination, realworld.base_sha);
  await verifyLicense(destination, realworld.license);
  await verifyPackageManager(destination, realworld.package_manager);

  const patchPath = resolve(scenario.scenario_dir, realworld.regression_patch);
  await run("git", ["apply", "--whitespace=nowarn", patchPath], { cwd: destination });
  await ensureGitIdentity(destination);
  await run("git", ["add", "."], { cwd: destination });
  await run("git", ["commit", "-m", "agentflow realworld regression fixture"], { cwd: destination });

  if (install) {
    const depsDir = join(reposDir, ".deps", scenario.id);
    await installSharedDependencies({ repoDir: destination, depsDir, setupCommand: realworld.setup_command });
  }

  const status = (await run("git", ["status", "--short"], { cwd: destination })).trim();
  const allowedStatus = status
    .split("\n")
    .filter(Boolean)
    .filter((line) => !line.endsWith("node_modules"));
  if (allowedStatus.length > 0) {
    throw new Error(`Scenario ${scenario.id} fixture is not clean after setup:\n${allowedStatus.join("\n")}`);
  }

  return { id: scenario.id, repo: destination };
}

function printHelp() {
  console.log([
    "Usage: node scripts/setup-realworld-evals.mjs [options]",
    "",
    "Options:",
    "  --suite <path>        Eval suite directory. Defaults to evals/agentflow-realworld-issues",
    "  --repos-root <path>   Generated repo root. Defaults to eval-repos/agentflow-realworld-issues",
    "  --scenario <id|all>   Scenario to materialize. Defaults to all",
    "  --source-root <path>  Optional local source mirror root for tests/offline setup",
    "  --skip-install        Clone, patch, and commit fixtures without npm install",
    "  --no-force            Refuse to replace existing materialized repos"
  ].join("\n"));
}

export async function setupRealworldEvals(rawOptions = {}) {
  const suiteDir = resolve(rawOptions.suiteDir ?? defaultSuiteDir);
  const reposDir = resolve(rawOptions.reposDir ?? defaultReposDir);
  const scenarioFilter = rawOptions.scenario ?? "all";
  const scenarios = await loadSuiteScenarios(suiteDir);
  const realworldScenarios = scenarios.filter((scenario) => scenario.metadata?.realworld);
  const selected = scenarioFilter === "all"
    ? realworldScenarios
    : scenarios.filter((scenario) => scenario.id === scenarioFilter);

  if (selected.length === 0) {
    throw new Error(`No real-world eval scenarios matched "${scenarioFilter}".`);
  }

  const nonRealworld = selected.filter((scenario) => !scenario.metadata?.realworld);
  if (nonRealworld.length > 0) {
    throw new Error(`Scenario ${nonRealworld.map((scenario) => scenario.id).join(", ")} is not a real-world eval scenario.`);
  }

  await mkdir(reposDir, { recursive: true });
  const materialized = [];
  for (const scenario of selected) {
    materialized.push(await materializeScenario({
      scenario,
      suiteDir,
      reposDir,
      force: rawOptions.force ?? true,
      install: rawOptions.install ?? true,
      sourceRoot: rawOptions.sourceRoot
    }));
  }

  return { suiteDir, reposDir, materialized };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseSetupRealworldArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      process.exitCode = 0;
    } else {
      const result = await setupRealworldEvals(options);
      console.log(`Materialized ${result.materialized.length} real-world eval scenario(s).`);
      for (const entry of result.materialized) {
        const info = await lstat(entry.repo);
        console.log(`- ${entry.id}: ${entry.repo}${info.isDirectory() ? "" : " (non-directory)"}`);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
