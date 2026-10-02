#!/usr/bin/env bash
# Source this file (don't execute it) to set GOOGLE_APPLICATION_CREDENTIALS
# in your current shell:
#
#   source scripts/set-gcp-creds.sh
#
# After sourcing, any Python/Node script that uses a Google SDK will
# authenticate automatically as the service account.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export GOOGLE_APPLICATION_CREDENTIALS="${REPO_ROOT}/gcp-creds.json"
echo "GOOGLE_APPLICATION_CREDENTIALS set to: ${GOOGLE_APPLICATION_CREDENTIALS}"
