#!/usr/bin/env bash
# VideoMerge — 一鍵本機啟動開發伺服器
set -euo pipefail

cd "$(dirname "$0")"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}→${NC} $*"; }
ok()    { echo -e "${GREEN}✓${NC} $*"; }
fail()  { echo -e "${RED}✗${NC} $*" >&2; exit 1; }

echo ""
echo "  VideoMerge 本機啟動"
echo "  --------------------"

# Node / npm 檢查
if ! command -v node >/dev/null 2>&1; then
  fail "找不到 Node.js。請先安裝：https://nodejs.org/"
fi
if ! command -v npm >/dev/null 2>&1; then
  fail "找不到 npm。請確認 Node.js 安裝完整。"
fi

NODE_VER="$(node -v)"
ok "Node ${NODE_VER}"

# 首次執行自動安裝依賴
if [[ ! -d node_modules ]]; then
  info "尚未安裝依賴，正在執行 npm install…"
  npm install
  ok "依賴安裝完成"
else
  ok "依賴已就緒"
fi

PORT="${PORT:-5173}"
info "啟動開發伺服器（http://localhost:${PORT}/）"
info "按 Ctrl+C 可停止"
echo ""

# 若埠被佔用，Vite 會自動換埠；--open 嘗試開啟瀏覽器
exec npm run dev -- --host 127.0.0.1 --port "${PORT}" --open
