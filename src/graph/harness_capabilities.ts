import type { HarnessName } from "./schema.js";

export interface HarnessCapabilities {
  supports_agent: boolean;
  supports_ai_check: boolean;
}

const harnessCapabilitiesByName: Record<HarnessName, HarnessCapabilities> = {
  "codex-cli": {
    supports_agent: true,
    supports_ai_check: true
  },
  "cursor-cli": {
    supports_agent: true,
    supports_ai_check: false
  }
};

export function getHarnessCapabilities(
  harnessName: HarnessName | undefined
): HarnessCapabilities | undefined {
  return harnessName ? harnessCapabilitiesByName[harnessName] : undefined;
}
