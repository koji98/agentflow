import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webAppRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const appPort = process.env.AGENTFLOW_WEB_APP_PORT ?? "4178";
const apiPort = process.env.AGENTFLOW_WEB_API_PORT ?? "4179";
const apiOrigin = process.env.AGENTFLOW_WEB_API_ORIGIN ?? `http://127.0.0.1:${apiPort}`;
const tsxCli = join(dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs");
const viteCli = join(dirname(require.resolve("vite/package.json")), "bin", "vite.js");
const children = [];
let shuttingDown = false;

function startChild(name, command, args, env) {
  const child = spawn(command, args, {
    cwd: webAppRoot,
    env,
    stdio: "inherit"
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }

    const reason =
      typeof code === "number"
        ? `${name} exited with code ${code}.`
        : `${name} exited because of signal ${signal ?? "unknown"}.`;
    process.stderr.write(`${reason}\n`);
    requestShutdown(typeof code === "number" ? code : 1);
  });

  children.push(child);
}

function killChildren(signal) {
  for (const child of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

function requestShutdown(exitCode) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  killChildren("SIGTERM");

  const forceKillTimer = setTimeout(() => {
    killChildren("SIGKILL");
  }, 1000);

  const pending = children.map(
    (child) =>
      new Promise((resolvePromise) => {
        child.once("exit", () => resolvePromise(undefined));
      })
  );

  Promise.allSettled(pending).finally(() => {
    clearTimeout(forceKillTimer);
    process.exit(exitCode);
  });
}

process.on("SIGINT", () => requestShutdown(0));
process.on("SIGTERM", () => requestShutdown(0));

startChild("web-app api", process.execPath, [tsxCli, "server/index.ts"], {
  ...process.env,
  PORT: apiPort
});

startChild("web-app client", process.execPath, [viteCli, "--host", "127.0.0.1", "--port", appPort], {
  ...process.env,
  AGENTFLOW_WEB_APP_PORT: appPort,
  AGENTFLOW_WEB_API_ORIGIN: apiOrigin
});
