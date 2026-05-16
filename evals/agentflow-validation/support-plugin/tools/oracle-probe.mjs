#!/usr/bin/env node

if (process.argv.includes("--help")) {
  process.stdout.write("Usage: oracle-probe [--summary]\n\nReads non-secret local sentinel metadata for validation workflows.\n");
  process.exit(0);
}

process.stdout.write(JSON.stringify({
  mode: process.env.AGENTFLOW_TOOL_CONFIG_MODE ?? "unset",
  summary: "sentinel fixture metadata available",
  hidden_oracle: false
}, null, 2));
