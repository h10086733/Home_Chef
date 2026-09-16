#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a;source .env;set +a
export APP_MODE=business WECHAT_PAY_ENABLED=false
export DATABASE_URL=postgresql://home_chef:home_chef@localhost:55432/home_chef_test_wechat
if ! docker exec home-chef-mvp-postgres-1 psql -U home_chef -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='home_chef_test_wechat'" | grep -q 1;then docker exec home-chef-mvp-postgres-1 createdb -U home_chef home_chef_test_wechat;fi
bash scripts/pnpm.sh db:migrate
bash scripts/pnpm.sh exec tsx --test tests/business.test.ts
bash scripts/pnpm.sh exec tsx --test tests/wechat-pay.test.ts