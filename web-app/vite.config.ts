import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = fileURLToPath(new URL(".", import.meta.url));
const appPort = Number(process.env.AGENTFLOW_WEB_APP_PORT ?? 4178);
const apiOrigin = process.env.AGENTFLOW_WEB_API_ORIGIN ?? "http://127.0.0.1:4179";

export default defineConfig({
  root: resolve(rootDirectory, "client"),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: appPort,
    strictPort: true,
    proxy: {
      "/api": apiOrigin,
      "/health": apiOrigin
    }
  },
  build: {
    outDir: resolve(rootDirectory, "dist/client"),
    emptyOutDir: true
  }
});
