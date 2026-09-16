#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PWD/scripts/bin:$PATH"
set -a;source .env;set +a
if ! docker exec home-chef-mvp-postgres-1 psql -U home_chef -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='home_chef_test'" | grep -q 1; then
 docker exec home-chef-mvp-postgres-1 createdb -U home_chef home_chef_test
fi
export APP_MODE=sandbox
export DATABASE_URL=postgresql://home_chef:home_chef@localhost:55432/home_chef_test
pnpm db:migrate
pnpm exec tsx --test tests/integration.test.ts
