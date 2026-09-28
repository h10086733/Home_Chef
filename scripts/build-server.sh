#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Regenerate schema types, then build workspace dependencies before API/worker.
# This does not migrate a database, seed data, or restart production services.
bash scripts/pnpm.sh db:generate
bash scripts/pnpm.sh --filter '@home-chef/api...' --filter '@home-chef/worker...' -r run build
