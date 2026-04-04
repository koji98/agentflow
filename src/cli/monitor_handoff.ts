import { runsRootEnvironmentVariable } from "../artifacts/paths.js";

export const defaultUiBaseUrl = "http://127.0.0.1:4178";
export const defaultUiApiOrigin = "http://127.0.0.1:4179";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function withRunsRoot(command: string, runsRoot: string): string {
  return `${runsRootEnvironmentVariable}=${shellQuote(runsRoot)} ${command}`;
}

export function createMonitorHandoff(options: {
  runsRoot: string;
  runId?: string;
}) {
  return {
    runs_root: options.runsRoot,
    runs_root_env: runsRootEnvironmentVariable,
    start_command: withRunsRoot("npm run start --workspace web-app", options.runsRoot),
    dev_command: withRunsRoot("npm run dev --workspace web-app", options.runsRoot),
    launchpad_url: `${defaultUiBaseUrl}/`,
    inspect_route: `${defaultUiBaseUrl}/graphs/inspect?path=<absolute-graph-path>&compiled=1`,
    monitor_route: options.runId
      ? `${defaultUiBaseUrl}/runs/${encodeURIComponent(options.runId)}`
      : `${defaultUiBaseUrl}/runs/<run-id>`,
    api_origin: defaultUiApiOrigin,
    contract:
      `CLI and web monitor runs roots resolve from an absolute ${runsRootEnvironmentVariable} when set; otherwise they default to <launch-cwd>/.agentflow/runs.`
  };
}
