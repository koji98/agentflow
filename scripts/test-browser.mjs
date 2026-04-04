import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const jsonMode = process.argv.includes("--json");
const headedMode = process.argv.includes("--headed");
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const commandTimeoutMs = 2 * 60 * 1000;
const serverReadyTimeoutMs = 20 * 1000;
const browserActionTimeoutMs = 20 * 1000;

const builtCliRelativePath = "dist/cli/index.js";
const builtClientIndexRelativePath = "web-app/dist/client/index.html";
const builtServerRelativePath = "web-app/dist/server-build/web-app/server/index.js";

export const browserSmokeContract = {
  builtCliRelativePath,
  builtClientIndexRelativePath,
  builtServerRelativePath,
  packageStartCommand: "npm run start --workspace web-app",
  browserBinary: "playwright-chromium",
  browserBootstrap: "install-if-missing",
  requiredRoutes: ["launchpad", "run-monitor"],
  requiredSurfaces: ["recent-runs", "event-timeline", "node-inspector", "logs-and-artifacts"],
  operatorFlow: [
    "choose graph",
    "inspect known run set",
    "compile graph",
    "open recent run",
    "render core monitor surfaces",
    "read node stdout and artifact"
  ]
};

function stripAnsi(text) {
  return text.replace(/\u001B\[[0-9;]*m/g, "");
}

function summarizeOutput(output) {
  const lines = stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return "no output";
  }

  const excerpt = lines.slice(-8).join(" | ");
  return excerpt.length <= 600 ? excerpt : `...${excerpt.slice(-597)}`;
}

async function fileExists(relativePath) {
  try {
    await access(resolve(rootDir, relativePath), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command, args, displayName, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    encoding: "utf8",
    env: { ...process.env, CI: process.env.CI ?? "1", ...(options.env ?? {}) },
    maxBuffer: 10 * 1024 * 1024,
    timeout: options.timeoutMs ?? commandTimeoutMs
  });

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");

  if (result.error) {
    return {
      passed: false,
      reason: `${displayName} failed to start: ${result.error.message}`,
      stdout: result.stdout ?? ""
    };
  }

  if (result.signal) {
    return {
      passed: false,
      reason: `${displayName} terminated with signal ${result.signal}: ${summarizeOutput(output)}`,
      stdout: result.stdout ?? ""
    };
  }

  if (result.status !== 0) {
    return {
      passed: false,
      reason: `${displayName} failed with exit code ${result.status}: ${summarizeOutput(output)}`,
      stdout: result.stdout ?? ""
    };
  }

  return {
    passed: true,
    reason: `${displayName} passed.`,
    stdout: result.stdout ?? ""
  };
}

function parseJsonOutput(commandName, stdout) {
  const trimmed = stripAnsi(stdout).trim();

  if (trimmed.length === 0) {
    throw new Error(`${commandName} returned no JSON output.`);
  }

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `${commandName} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function initGitRepo(repoDir) {
  const steps = [
    ["init"],
    ["config", "user.email", "agentflow@example.com"],
    ["config", "user.name", "Agentflow Browser Smoke"]
  ];

  for (const args of steps) {
    const result = runCommand("git", args, `git ${args.join(" ")}`, { cwd: repoDir });

    if (!result.passed) {
      throw new Error(result.reason);
    }
  }

  await writeFile(join(repoDir, "README.md"), "seed\n");

  for (const args of [["add", "README.md"], ["commit", "-m", "init"]]) {
    const result = runCommand("git", args, `git ${args.join(" ")}`, { cwd: repoDir });

    if (!result.passed) {
      throw new Error(result.reason);
    }
  }
}

async function createFixtureGraph(tempRoot) {
  const launchRoot = join(tempRoot, "launch");
  const repoDir = join(tempRoot, "repo");
  const graphPath = join(tempRoot, "agentflow.graph.json");
  const runsRoot = join(launchRoot, ".agentflow", "runs");

  await mkdir(launchRoot, { recursive: true });
  await mkdir(repoDir, { recursive: true });
  await initGitRepo(repoDir);

  const graphDocument = {
    version: "1",
    graph_id: "browser-smoke-graph",
    repos: {
      main: {
        path: "./repo"
      }
    },
    defaults: {
      launch_profile: "default",
      workspace_backend: "inplace"
    },
    profiles: {
      default: {}
    },
    graph: {
      type: "sequence",
      id: "root",
      steps: [
        {
          type: "exec",
          id: "write-marker",
          label: "Write Marker",
          repo: "main",
          outputs: [
            {
              name: "marker_file",
              from: "workspace",
              path: "marker.txt",
              required: true
            }
          ],
          command: process.execPath,
          args: [
            "-e",
            "const fs=require('node:fs'); fs.writeFileSync('marker.txt', 'ok\\n'); process.stdout.write('marker ready\\n');"
          ]
        }
      ]
    }
  };

  await writeFile(graphPath, `${JSON.stringify(graphDocument, null, 2)}\n`);

  return {
    graphPath,
    launchRoot,
    repoDir,
    runsRoot
  };
}

async function reservePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to resolve a local port for the browser smoke server.")));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolvePort(port);
      });
    });
  });
}

async function waitForServer(baseUrl, serverProcess) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < serverReadyTimeoutMs) {
    if (serverProcess.exitCode !== null) {
      throw new Error("Packaged web server exited before it became ready.");
    }

    try {
      const response = await fetch(`${baseUrl}/health`);

      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the timeout expires.
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }

  throw new Error(`Timed out waiting for packaged web server health at ${baseUrl}/health.`);
}

async function stopServer(serverProcess) {
  if (!serverProcess || serverProcess.exitCode !== null) {
    return;
  }

  serverProcess.kill("SIGTERM");

  await new Promise((resolveStop) => {
    const timer = setTimeout(() => {
      if (serverProcess.exitCode === null) {
        serverProcess.kill("SIGKILL");
      }

      resolveStop(undefined);
    }, 5000);

    serverProcess.once("exit", () => {
      clearTimeout(timer);
      resolveStop(undefined);
    });
  });
}

function extractServerOutput(stdoutChunks, stderrChunks) {
  return summarizeOutput([...stdoutChunks, ...stderrChunks].join("\n"));
}

async function captureFailureScreenshot(page) {
  if (!page) {
    return undefined;
  }

  const screenshotPath = resolve(rootDir, "output", "playwright", "test-browser-failure.png");
  await mkdir(dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return screenshotPath;
}

async function launchChromiumBrowser() {
  try {
    return {
      browser: await chromium.launch({ headless: !headedMode }),
      provisioning: "present"
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (!message.includes("Executable doesn't exist")) {
      throw new Error(`Chromium could not start for browser smoke validation: ${message}`);
    }

    const installResult = runCommand(
      npxCommand,
      ["playwright", "install", "chromium"],
      "playwright install chromium",
      {
        timeoutMs: 20 * 60 * 1000
      }
    );

    if (!installResult.passed) {
      throw new Error(
        `Chromium is missing and playwright install chromium failed: ${installResult.reason}`
      );
    }

    try {
      return {
        browser: await chromium.launch({ headless: !headedMode }),
        provisioning: "installed-on-demand"
      };
    } catch (retryError) {
      throw new Error(
        `Chromium could not start for browser smoke validation after playwright install chromium: ${retryError instanceof Error ? retryError.message : String(retryError)}`
      );
    }
  }
}

async function runBuiltCliGraph(builtCliPath, fixture, runLabel) {
  const runResult = runCommand(
    process.execPath,
    [builtCliPath, "run", "--graph", fixture.graphPath, "--label", runLabel],
    `built CLI run for browser smoke (${runLabel})`,
    {
      cwd: fixture.launchRoot
    }
  );

  if (!runResult.passed) {
    throw new Error(runResult.reason);
  }

  const runPayload = parseJsonOutput(`built CLI run for browser smoke (${runLabel})`, runResult.stdout);

  if (runPayload.command !== "run") {
    throw new Error(`Browser smoke expected ${runLabel} payload.command to equal "run".`);
  }

  if (runPayload.status !== "passed") {
    throw new Error(`Browser smoke expected ${runLabel} payload.status to equal "passed".`);
  }

  if (typeof runPayload.run_id !== "string" || runPayload.run_id.length === 0) {
    throw new Error(`Browser smoke expected ${runLabel} payload.run_id to be a non-empty string.`);
  }

  return runPayload;
}

async function assertLaunchpadFlow(page, fixture, recentRunIds) {
  await page.goto(fixture.baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Graph launchpad" }).waitFor();
  await page.getByRole("button", { name: "Choose graph" }).click();
  await page.getByRole("heading", { name: "Choose an authored graph path" }).waitFor();
  await page.getByPlaceholder("/path/to/agentflow.graph.json").fill(fixture.graphPath);
  await page.getByRole("button", { name: "Confirm graph" }).click();
  await page.getByText("Run launch stays local-first in this release.").waitFor();
  await page.getByText(`Latest runs for ${fixture.graphId}`).waitFor();

  for (const runId of recentRunIds) {
    await page.getByRole("button", { name: runId }).waitFor();
  }

  const recentRunButtons = page.locator(".tile-timeline .timeline-link");
  const visibleRunIds = (await recentRunButtons.evaluateAll((elements) =>
    elements.map((element) => element.textContent?.trim() ?? "").filter(Boolean)
  ));

  if (visibleRunIds[0] !== recentRunIds[0]) {
    throw new Error(
      `Browser smoke expected the most recent launchpad run to be "${recentRunIds[0]}", received "${visibleRunIds[0] ?? "none"}".`
    );
  }

  if (visibleRunIds[1] !== recentRunIds[1]) {
    throw new Error(
      `Browser smoke expected the second launchpad run to be "${recentRunIds[1]}", received "${visibleRunIds[1] ?? "none"}".`
    );
  }

  await page.getByRole("button", { name: "Compile" }).click();
  await page.getByText("Compiled graph is ready.").waitFor();
}

async function assertRunMonitorFlow(page, newestRunId) {
  await page.getByRole("button", { name: newestRunId }).click();
  await page.getByText("Event timeline").waitFor();
  await page.locator("#timeline-panel .event-card").first().waitFor();
  await page.locator("#inspector-panel").waitFor();
  await page.locator("#logs-panel").waitFor();
  await page.getByText("Write Marker execution output").waitFor();

  const inspectorText = (await page.locator("#inspector-panel").textContent()) ?? "";

  if (!inspectorText.includes("Write Marker") || !inspectorText.includes("write-marker")) {
    throw new Error("Browser smoke expected the run inspector to render the selected Write Marker node.");
  }

  const logOutput = await page.locator("#logs-panel .log-console").textContent();

  if (!logOutput?.includes("marker ready")) {
    throw new Error(`Browser smoke expected the selected node stdout to include "marker ready", received "${logOutput?.trim() ?? "empty output"}".`);
  }

  await page.locator("#logs-panel").getByRole("button", { name: /^artifacts\b/i }).click();
  await page.locator("#logs-panel").getByRole("button", { name: "artifacts/marker.txt" }).waitFor();
  await page.locator("#logs-panel .artifact-preview .log-console").waitFor();
  const artifactPreview = await page.locator("#logs-panel .artifact-preview .log-console").textContent();

  if (!artifactPreview?.includes("ok")) {
    throw new Error(`Browser smoke expected the artifact preview to include "ok", received "${artifactPreview?.trim() ?? "empty preview"}".`);
  }

  const runStatus = await page.locator(".header-status strong").textContent();

  if (runStatus?.trim() !== "Passed") {
    throw new Error(`Browser smoke expected the run header status to be "Passed", received "${runStatus?.trim() ?? "unknown"}".`);
  }
}

async function main() {
  const missingPaths = [];

  if (!(await fileExists(builtCliRelativePath))) {
    missingPaths.push(`${builtCliRelativePath} (run npm run build or npm run validate:smoke first)`);
  }

  if (!(await fileExists(builtClientIndexRelativePath))) {
    missingPaths.push(`${builtClientIndexRelativePath} (run npm run build or npm run validate:smoke first)`);
  }

  if (!(await fileExists(builtServerRelativePath))) {
    missingPaths.push(`${builtServerRelativePath} (run npm run build or npm run validate:smoke first)`);
  }

  if (missingPaths.length > 0) {
    const payload = {
      passed: false,
      proof: {
        missing_artifacts: missingPaths
      },
      reasons: [`Browser smoke prerequisites are missing: ${missingPaths.join("; ")}`]
    };

    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      console.log("Browser smoke FAIL");
      console.log(`[fail] ${payload.reasons[0]}`);
    }

    process.exitCode = 1;
    return;
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-browser-smoke-"));
  let browser;
  let page;
  let screenshotPath;
  let serverProcess;
  let chromiumProvisioning = "unknown";
  const serverStdout = [];
  const serverStderr = [];

  try {
    const fixture = await createFixtureGraph(tempRoot);
    const builtCliPath = resolve(rootDir, builtCliRelativePath);
    const olderRun = await runBuiltCliGraph(builtCliPath, fixture, "recent-older");
    const newerRun = await runBuiltCliGraph(builtCliPath, fixture, "recent-newer");

    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const builtServerPath = resolve(rootDir, builtServerRelativePath);

    serverProcess = spawn(process.execPath, [builtServerPath], {
      cwd: rootDir,
      env: {
        ...process.env,
        CI: process.env.CI ?? "1",
        PORT: String(port),
        AGENTFLOW_RUNS_ROOT: fixture.runsRoot
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    serverProcess.stdout?.setEncoding("utf8");
    serverProcess.stderr?.setEncoding("utf8");
    serverProcess.stdout?.on("data", (chunk) => serverStdout.push(chunk));
    serverProcess.stderr?.on("data", (chunk) => serverStderr.push(chunk));

    await waitForServer(baseUrl, serverProcess);

    const launchedChromium = await launchChromiumBrowser();
    browser = launchedChromium.browser;
    chromiumProvisioning = launchedChromium.provisioning;

    page = await browser.newPage();
    page.setDefaultTimeout(browserActionTimeoutMs);
    const browserFixture = {
      ...fixture,
      baseUrl,
      graphId: "browser-smoke-graph"
    };

    await assertLaunchpadFlow(page, browserFixture, [newerRun.run_id, olderRun.run_id]);
    await assertRunMonitorFlow(page, newerRun.run_id);

    const payload = {
      passed: true,
      proof: {
        built_cli: builtCliRelativePath,
        built_client: builtClientIndexRelativePath,
        built_server: builtServerRelativePath,
        package_start_command: browserSmokeContract.packageStartCommand,
        browser_binary: browserSmokeContract.browserBinary,
        browser_provisioning: chromiumProvisioning,
        runs_root: fixture.runsRoot,
        graph_path: fixture.graphPath,
        recent_run_ids: [newerRun.run_id, olderRun.run_id],
        asserted_surfaces: browserSmokeContract.requiredSurfaces
      },
      reasons: [
        `Packaged launchpad resolved ${fixture.graphPath}, listed the known runs ${newerRun.run_id} and ${olderRun.run_id}, compiled the graph, opened ${newerRun.run_id}, and rendered the expected timeline, inspector, stdout, and artifact preview for Write Marker using the built web server and client artifacts.`
      ]
    };

    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      console.log("Browser smoke PASS");
      console.log(`[pass] ${payload.reasons[0]}`);
    }
  } catch (error) {
    screenshotPath = await captureFailureScreenshot(page).catch(() => undefined);
    const serverOutput = serverProcess
      ? extractServerOutput(serverStdout, serverStderr)
      : "server did not start";
    const reason = [
      error instanceof Error ? error.message : String(error),
      screenshotPath ? `Failure screenshot: ${screenshotPath}` : null,
      serverProcess ? `Server output: ${serverOutput}` : null
    ]
      .filter(Boolean)
      .join(" | ");
    const payload = {
      passed: false,
      proof: {
        built_cli: builtCliRelativePath,
        built_client: builtClientIndexRelativePath,
        built_server: builtServerRelativePath,
        package_start_command: browserSmokeContract.packageStartCommand,
        browser_binary: browserSmokeContract.browserBinary,
        browser_provisioning: chromiumProvisioning
      },
      reasons: [reason]
    };

    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      console.log("Browser smoke FAIL");
      console.log(`[fail] ${reason}`);
    }

    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close();
    }

    await stopServer(serverProcess);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

const invokedScript = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;

if (invokedScript === import.meta.url) {
  await main();
}
