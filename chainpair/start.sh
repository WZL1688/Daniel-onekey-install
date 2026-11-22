#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo '请先安装 Node.js 24 LTS：https://nodejs.org/'
  exit 1
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("需要 Node.js 24 或以上版本"); process.exit(1) }'
if [ ! -d node_modules ] || ! node -e 'try { if (require("undici/package.json").version !== require("./package.json").dependencies.undici) process.exit(1) } catch { process.exit(1) }'; then
  npm ci --omit=dev --no-audit --no-fund
fi
exec npm start
