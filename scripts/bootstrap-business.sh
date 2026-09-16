#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a;source .env;set +a
if [[ "${DATABASE_URL}" != */home_chef_business ]]; then
 echo "Business bootstrap expects database home_chef_business";exit 1
fi
if ! docker exec home-chef-mvp-postgres-1 psql -U home_chef -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='home_chef_business'" | grep -q 1; then
 docker exec home-chef-mvp-postgres-1 createdb -U home_chef home_chef_business
fi
bash scripts/pnpm.sh db:migrate
bash scripts/pnpm.sh exec tsx prisma/bootstrap.ts
