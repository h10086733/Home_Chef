#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -d "$HOME/.nvm/versions/node/v22.12.0/bin" ]; then export PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH"; fi
chmod +x scripts/bin/pnpm
export PATH="$PWD/scripts/bin:$PATH"
if [ ! -f .env ]; then
  cp .env.example .env
  node --input-type=module -e 'import fs from "node:fs"; import crypto from "node:crypto"; let s=fs.readFileSync(".env","utf8").replaceAll("GENERATE_64_HEX_CHARACTERS",()=>crypto.randomBytes(32).toString("hex")); fs.writeFileSync(".env",s,{mode:0o600});'
  chmod 600 .env
fi
set -a; source .env; set +a
corepack pnpm@9.15.0 install --frozen-lockfile
docker compose -p home-chef-mvp up -d --wait postgres redis
corepack pnpm@9.15.0 db:generate
if [ "$APP_MODE" = business ]; then
 bash scripts/bootstrap-business.sh
else
 corepack pnpm@9.15.0 db:migrate
 corepack pnpm@9.15.0 db:seed:demo
fi
echo 'Ready: bash scripts/pnpm.sh dev'
