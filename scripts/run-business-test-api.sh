#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a;source .env;set +a
export WECHAT_PAY_ENABLED=false WECHAT_TRANSFER_ENABLED=false WECHAT_PROFITSHARING_ENABLED=false
export APP_MODE=business DATABASE_URL=postgresql://home_chef:home_chef@localhost:55432/home_chef_test PORT=3001 HOST=127.0.0.1
if [ -d "$HOME/.nvm/versions/node/v22.12.0/bin" ]; then export PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH";fi
cd apps/api
exec node --import tsx src/main.ts
