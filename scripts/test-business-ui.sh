#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .data
bash scripts/start-check-frontends.sh
if curl --max-time 2 -fsS http://127.0.0.1:3001/health >/dev/null 2>&1;then echo 'Port 3001 is in use; stop the previous isolated test API before running this test.';exit 1;fi
set -a;source .env;set +a
export APP_MODE=business
export DATABASE_URL=postgresql://home_chef:home_chef@localhost:55432/home_chef_test
if [ -d "$HOME/.nvm/versions/node/v22.12.0/bin" ]; then export PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH";fi
if ! docker exec home-chef-mvp-postgres-1 psql -U home_chef -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='home_chef_test'" | grep -q 1;then docker exec home-chef-mvp-postgres-1 createdb -U home_chef home_chef_test;fi
bash scripts/pnpm.sh db:migrate
bash scripts/pnpm.sh exec tsx --test tests/business.test.ts
bash scripts/run-business-test-api.sh >.data/business-test-api.log 2>&1 &
taskApiPid=$!
trap 'kill -TERM "$taskApiPid" 2>/dev/null || true' EXIT
taskApiReady=false
for taskAttempt in {1..30};do
 if curl --max-time 2 -fsS http://127.0.0.1:3001/health >/dev/null 2>&1;then taskApiReady=true;break;fi
 sleep .5
done
if [[ "$taskApiReady" != true ]];then echo "Isolated test API failed to start; inspect .data/business-test-api.log";exit 1;fi
if [[ "${1:-}" != "--maps-only" ]];then node tests/business-browser.mjs;fi

MAP_TEST_ISOLATED=true node tests/maps-browser.mjs
