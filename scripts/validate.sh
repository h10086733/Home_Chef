#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .data docs/evidence
: > docs/evidence/validation.log
run() {
 echo "CHECK: $*" | tee -a docs/evidence/validation.log
 if "$@" >>docs/evidence/validation.log 2>&1; then
  echo "PASS: $*" | tee -a docs/evidence/validation.log
 else
  tail -60 docs/evidence/validation.log
  exit 1
 fi
}
run bash scripts/pnpm.sh typecheck
run bash scripts/pnpm.sh test
run bash scripts/test-integration.sh
run bash scripts/pnpm.sh build
run bash scripts/pnpm.sh --filter @home-chef/miniapp build:h5
run bash scripts/pnpm.sh test:ui
echo 'All requested checks passed. See docs/evidence/validation.log.'
