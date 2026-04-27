#!/usr/bin/env bash
# Sample polling script for the babysit plugin example.
#
# This is a demonstration helper, not a production tool. It reads its
# credential from the AGENTFLOW_CREDENTIAL_GITHUB_TOKEN environment
# variable that the Agentflow tool launcher exports only for this subprocess,
# accepts an optional --pr <id> argument, and prints a JSON status line
# to stdout.

set -euo pipefail

PR_ID="unknown"
ONCE="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pr)
      PR_ID="${2:-unknown}"
      shift 2
      ;;
    --once)
      ONCE="true"
      shift 1
      ;;
    --help|-h)
      cat <<USAGE
poll-pr.sh - example babysit poll tool that prints simulated PR status JSON

Usage:
  poll-pr.sh [--pr <id>] [--once] [--help]

Arguments:
  (none)

Options:
  --pr <id>  Pull request id to inspect. Default: unknown
  --once     Poll once and exit. Default: false
  --help     Show this help and exit. Default: false

Agentflow configured defaults:
  (none)

Output:
  JSON object: {"pr_id": "...", "state": "open", "checks_passing": true, "once": true, "token_present": true}

Exit codes:
  0 success
  2 invalid arguments
  1 runtime failure

Examples:
  poll-pr.sh --pr 123 --once

Safety:
  --help is read-only and credential-free. Normal polling reads AGENTFLOW_CREDENTIAL_GITHUB_TOKEN only inside the plugin subprocess.
USAGE
      exit 0
      ;;
    *)
      echo "poll-pr.sh: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

TOKEN_PRESENT="false"
if [[ -n "${AGENTFLOW_CREDENTIAL_GITHUB_TOKEN:-}" ]]; then
  TOKEN_PRESENT="true"
fi

cat <<JSON
{"pr_id": "${PR_ID}", "state": "open", "checks_passing": true, "once": ${ONCE}, "token_present": ${TOKEN_PRESENT}}
JSON
