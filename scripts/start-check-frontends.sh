#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .data
if ! curl --max-time 2 -fsS http://127.0.0.1:5173/ >/dev/null 2>&1; then
 CI=true nohup bash scripts/pnpm.sh --filter @home-chef/admin-web dev >.data/check-web.log 2>&1 </dev/null &
fi
if ! curl --max-time 2 -fsS http://127.0.0.1:10086/ >/dev/null 2>&1; then
 CI=true nohup bash scripts/pnpm.sh --filter @home-chef/miniapp dev:h5 >.data/check-h5.log 2>&1 </dev/null &
fi
for attempt in {1..50};do
 if curl --max-time 2 -fsS http://127.0.0.1:5173/ >/dev/null 2>&1 && curl --max-time 2 -fsS http://127.0.0.1:10086/ >/dev/null 2>&1;then exit 0;fi
 sleep 1
done
exit 1