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
poll-pr.sh - example babysit poll tool

Usage:
  poll-pr.sh [--pr <id>] [--once]

Reads:
  AGENTFLOW_CREDENTIAL_GITHUB_TOKEN  GitHub token resolved by Agentflow auth for this subprocess.

Prints a JSON object describing the simulated PR status.
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
