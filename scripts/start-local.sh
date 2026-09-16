#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .data
if ! curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1; then
 nohup bash scripts/pnpm.sh --filter @home-chef/api dev >.data/api.log 2>&1 &
 echo $! >.data/api.pid
fi
if ! curl -fsS http://127.0.0.1:5173/ >/dev/null 2>&1; then
 CI=true nohup bash scripts/pnpm.sh --filter @home-chef/admin-web dev >.data/web.log 2>&1 &
 echo $! >.data/web.pid
fi
if [ ! -f .data/worker.pid ] || ! kill -0 "$(cat .data/worker.pid)" 2>/dev/null; then
 nohup bash scripts/pnpm.sh --filter @home-chef/worker dev >.data/worker.log 2>&1 &
 echo $! >.data/worker.pid
fi
for attempt in {1..30}; do
 if curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1 && curl -fsS http://127.0.0.1:5173/ >/dev/null 2>&1; then
  echo 'Home Chef is ready: http://localhost:5173 (logs: .data/)'
  exit 0
 fi
 sleep 1
done
echo 'Startup not ready. Inspect .data/api.log and .data/web.log.'
exit 1
