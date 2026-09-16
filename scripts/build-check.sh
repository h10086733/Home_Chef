#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .data
if bash scripts/pnpm.sh build >.data/build.log 2>&1; then tail -25 .data/build.log; else tail -70 .data/build.log; exit 1; fi
