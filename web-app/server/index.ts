import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  resolveLaunchWorkingDirectory,
  resolveRunsRoot
} from "../../src/artifacts/paths.js";
import { createWebAppServer } from "./app.js";

function looksLikeRepositoryRoot(candidate: string): boolean {
  return existsSync(resolve(candidate, "package.json"))
    && existsSync(resolve(candidate, "web-app", "package.json"))
    && existsSync(resolve(candidate, "src", "artifacts", "paths.ts"));
}

function resolveRepositoryRoot(serverEntryDirectory: string): string {
  const candidates = [
    resolve(serverEntryDirectory, "../.."),
    resolve(serverEntryDirectory, "../../.."),
    resolve(serverEntryDirectory, "../../../.."),
    resolve(serverEntryDirectory, "../../../../..")
  ];

  for (const candidate of candidates) {
    if (looksLikeRepositoryRoot(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to resolve the Agentflow repository root from ${serverEntryDirectory}.`);
}

const repositoryRoot = resolveRepositoryRoot(dirname(fileURLToPath(import.meta.url)));
const defaultClientDistRoot = resolve(repositoryRoot, "web-app", "dist", "client");

export interface NodeWebServerOptions {
  port?: number;
  current_working_directory?: string;
  runs_root?: string;
  client_dist_root?: string;
}

function contentTypeForPath(pathname: string): string {
  switch (extname(pathname).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".map":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function resolveClientFilePath(clientDistRoot: string, pathname: string): string | undefined {
  const candidate = resolve(clientDistRoot, `.${pathname}`);

  return candidate === clientDistRoot || candidate.startsWith(`${clientDistRoot}${sep}`)
    ? candidate
    : undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function tryServeStaticFile(
  response: ServerResponse,
  filePath: string,
  contentPath: string
): Promise<boolean> {
  if (!(await isReadableFile(filePath))) {
    return false;
  }

  response.statusCode = 200;
  response.setHeader("Content-Type", contentTypeForPath(contentPath));
  response.end(await readFile(filePath));
  return true;
}

async function serveClientApplication(
  response: ServerResponse,
  clientDistRoot: string,
  pathname: string
): Promise<void> {
  const directFilePath = resolveClientFilePath(
    clientDistRoot,
    pathname === "/" ? "/index.html" : pathname
  );

  if (
    directFilePath &&
    await tryServeStaticFile(
      response,
      directFilePath,
      pathname === "/" ? "/index.html" : pathname
    )
  ) {
    return;
  }

  const spaFallbackPath = resolve(clientDistRoot, "index.html");

  if (extname(pathname).length === 0 && await tryServeStaticFile(response, spaFallbackPath, "/index.html")) {
    return;
  }

  if (await pathExists(spaFallbackPath)) {
    response.statusCode = 404;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end(`Static asset not found for ${pathname}.`);
    return;
  }

  response.statusCode = 503;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end("Web client build artifacts are missing. Run npm run build before npm run start --workspace web-app.");
}

async function handleApiResponse(
  request: IncomingMessage,
  response: ServerResponse,
  apiServer: ReturnType<typeof createWebAppServer>
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const routed = await apiServer.request(request.method ?? "GET", url);

  response.statusCode = routed.status;

  if (routed.kind === "json") {
    Object.entries(routed.headers ?? {}).forEach(([name, value]) => {
      response.setHeader(name, value);
    });
    response.end(JSON.stringify(routed.body, null, 2));
    return;
  }

  Object.entries(routed.headers ?? {}).forEach(([name, value]) => {
    response.setHeader(name, value);
  });
  response.flushHeaders();

  const abortController = new AbortController();
  request.on("close", () => abortController.abort());

  try {
    await routed.stream(
      {
        write(event, payload) {
          response.write(`event: ${event}\n`);
          response.write(`data: ${JSON.stringify(payload)}\n\n`);
        },
        close() {
          if (!response.writableEnded) {
            response.end();
          }
        }
      },
      abortController.signal
    );
  } catch {
    if (!response.writableEnded) {
      response.end();
    }
  }
}

export function createNodeWebServer(options: NodeWebServerOptions = {}): NodeHttpServer {
  const clientDistRoot = options.client_dist_root ?? defaultClientDistRoot;
  const currentWorkingDirectory = resolveLaunchWorkingDirectory({
    ...(options.current_working_directory
      ? { currentWorkingDirectory: options.current_working_directory }
      : {}),
    environment: process.env
  });
  const apiServer = createWebAppServer({
    current_working_directory: currentWorkingDirectory,
    runs_root: options.runs_root ?? resolveRunsRoot({
      currentWorkingDirectory,
      environment: process.env
    })
  });

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (url.pathname === "/health" || url.pathname.startsWith("/api/")) {
      await handleApiResponse(request, response, apiServer);
      return;
    }

    await serveClientApplication(response, clientDistRoot, url.pathname);
  });
}

export function startWebAppServer(options: NodeWebServerOptions = {}): NodeHttpServer {
  const port = Number(options.port ?? process.env.PORT ?? 4178);
  const server = createNodeWebServer(options);

  server.listen(port, () => {
    process.stdout.write(`Agentflow web monitor listening on http://localhost:${port}\n`);
  });

  return server;
}

function isMainModule(importMetaUrl: string): boolean {
  const entryPath = process.argv[1];

  if (!entryPath) {
    return false;
  }

  return pathToFileURL(resolve(entryPath)).href === importMetaUrl;
}

if (isMainModule(import.meta.url)) {
  startWebAppServer();
}
