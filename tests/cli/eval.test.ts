import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { executeCli } from "../../src/cli/index.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(repoDir: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "agentflow@example.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "Agentflow Tests"], { cwd: repoDir });
  await writeFile(join(repoDir, "README.md"), "seed\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
}

async function writeEvalFixture(tempRoot: string): Promise<{
  suitePath: string;
  evalRoot: string;
}> {
  const repoDir = join(tempRoot, "repo");
  const suiteDir = join(tempRoot, "suite");
  const gradersDir = join(suiteDir, "graders");
  const evalRoot = join(tempRoot, "eval-output");

  await mkdir(repoDir, { recursive: true });
  await mkdir(gradersDir, { recursive: true });
  await initGitRepo(repoDir);
  await writeFile(
    join(suiteDir, "agentflow.graph.template.json"),
    `${JSON.stringify(
      {
        version: "1",
        graph_id: "eval-cli-{{case.id}}",
        repos: {
          main: {
            path: "{{case.repos.main.path}}"
          }
        },
        defaults: {
          launch_profile: "default",
          workspace_backend: "inplace"
        },
        profiles: {
          default: {
            harness: "codex-cli"
          }
        },
        graph: {
          type: "sequence",
          id: "root",
          steps: [
            {
              type: "exec",
              id: "echo_task",
              repo: "main",
              command: "node",
              args: ["-e", "console.log(process.argv[1])", "{{case.task}}"]
            }
          ]
        }
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    join(suiteDir, "cases.jsonl"),
    `${JSON.stringify({
      id: "case-1",
      task: "hello eval",
      repos: {
        main: {
          path: "../repo"
        }
      }
    })}\n`
  );
  await writeFile(
    join(gradersDir, "trace.mjs"),
    [
      'import { readFileSync } from "node:fs";',
      "const trace = readFileSync(process.env.AGENTFLOW_EVAL_TRACE_FILE, 'utf8');",
      "const passed = trace.includes('\"type\":\"run.completed\"') && trace.includes('\"kind\":\"attempt\"');",
      "console.log(JSON.stringify({ passed, score: passed ? 1 : 0, summary: passed ? 'ok' : 'missing trace', assertions: [{ id: 'trace', passed, evidence: 'trace inspected' }], metrics: {} }));"
    ].join("\n")
  );
  await writeFile(
    join(suiteDir, "suite.json"),
    `${JSON.stringify(
      {
        version: "1",
        suite_id: "cli-eval-suite",
        target: {
          graph_template: "agentflow.graph.template.json"
        },
        cases: "cases.jsonl",
        graders: [
          {
            id: "trace",
            kind: "script",
            command: "node graders/trace.mjs"
          }
        ],
        thresholds: {
          pass_rate: 1,
          critical_failures: 0
        }
      },
      null,
      2
    )}\n`
  );

  return {
    suitePath: join(suiteDir, "suite.json"),
    evalRoot
  };
}

describe("eval CLI", () => {
  it("validates, runs, and reports a local eval suite", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-eval-"));
    const { suitePath, evalRoot } = await writeEvalFixture(tempRoot);

    const validateResult = await executeCli(["eval", "validate", "--suite", suitePath], tempRoot);
    const validatePayload = JSON.parse(validateResult.stdout);

    expect(validateResult.exitCode).toBe(0);
    expect(validatePayload.command).toBe("eval validate");
    expect(validatePayload.status).toBe("passed");
    expect(validatePayload.case_count).toBe(1);

    const runResult = await executeCli(
      ["eval", "run", "--suite", suitePath, "--evals-root", evalRoot],
      tempRoot
    );
    const runPayload = JSON.parse(runResult.stdout);
    const ledger = JSON.parse(await readFile(join(evalRoot, "evaluation-ledger.json"), "utf8"));

    expect(runResult.exitCode).toBe(0);
    expect(runPayload.command).toBe("eval run");
    expect(runPayload.status).toBe("passed");
    expect(runPayload.benchmark.pass_rate).toBe(1);
    expect(ledger.results[0].status).toBe("passed");
    expect(ledger.results[0].graders[0].id).toBe("trace");

    const reportResult = await executeCli(["eval", "report", "--eval-root", evalRoot], tempRoot);
    const reportPayload = JSON.parse(reportResult.stdout);

    expect(reportResult.exitCode).toBe(0);
    expect(reportPayload.command).toBe("eval report");
    expect(reportPayload.suite_id).toBe("cli-eval-suite");
    expect(reportPayload.benchmark.passed).toBe(1);
  });

  it("continues to reject positionals for non-eval commands", async () => {
    const result = await executeCli(["run", "unexpected"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("Unexpected positional arguments: unexpected");
  });
});
