import fs from 'node:fs';

export function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function readJsonFileWithRetries<T>(
  filePath: string,
  options?: { attempts?: number; delayMs?: number },
): Promise<T | null> {
  const attempts = Math.max(1, options?.attempts ?? 5);
  const delayMs = Math.max(0, options?.delayMs ?? 30);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const json = readJsonFile<T>(filePath);
    if (json !== null) return json;
    if (attempt < attempts - 1 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return null;
}
