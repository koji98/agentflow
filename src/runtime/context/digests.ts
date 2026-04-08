import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { ContextDigestEntry } from "./packet.js";

export function createDigest(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export function aggregateDigest(entries: ContextDigestEntry[]): string {
  return createDigest(entries.map((entry) => `${entry.path}:${entry.digest}`).join("\n"));
}

export async function digestFile(
  sourcePath: string,
  cache?: Map<string, string>
): Promise<string> {
  const cached = cache?.get(sourcePath);

  if (cached) {
    return cached;
  }

  const digest = createDigest(await readFile(sourcePath));
  cache?.set(sourcePath, digest);
  return digest;
}
