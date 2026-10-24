#!/usr/bin/env bash
# 售后 Agent 桌面端启动器（macOS / Linux）
# 用法：./启动桌面端.sh   （换端口：PORT=9000 ./启动桌面端.sh）
# Windows 用户请双击「启动桌面端.cmd」。
set -u
cd "$(dirname "$0")"

PORT="${PORT:-8787}"
BASE="http://127.0.0.1:${PORT}"

# ═══ 1. 找 node ═══
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 找不到 Node.js。请先安装 Node 22.18+。"
  echo "       注意：如果只是想看演示，不需要 Node —— 直接用浏览器打开本目录的 demo.html"
  exit 1
fi

# ═══ 2. 端口已被占用就跳过起服务 ═══
# 用 node 做端口探测：macOS 默认没有 lsof 以外的保证，Linux 缺 ss 的容器也常见，
# node 一行最稳（net 模块跨平台一致）。
if node -e '
const net=require("net");
const s=net.connect(Number(process.argv[1]),"127.0.0.1");
s.on("connect",()=>{s.destroy();process.exit(0)});
s.on("error",()=>process.exit(1));
' "$PORT"; then
  echo "检测到服务已在运行（${BASE}），直接打开窗口。"
else
  echo "正在启动本地服务（${BASE}）..."
  node desktop/server.mjs &
  SERVER_PID=$!
  # 等服务就绪（最多等 5 秒）
  for _ in $(seq 1 10); do
    if node -e '
const net=require("net");
const s=net.connect(Number(process.argv[1]),"127.0.0.1");
s.on("connect",()=>{s.destroy();process.exit(0)});
s.on("error",()=>process.exit(1));
' "$PORT"; then
      break
    fi
    sleep 1
  done
fi

# ═══ 3. 用默认浏览器打开 ═══
# macOS: open；Linux: xdg-open。都没有就只打印地址，让用户自己贴。
if command -v open >/dev/null 2>&1; then
  open "$BASE"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$BASE"
else
  echo "未找到浏览器打开命令，请手动访问：${BASE}"
fi

echo ""
echo "  · 服务在后台运行（PID ${SERVER_PID:-已存在}）"
echo "  · 停止服务：kill ${SERVER_PID:-<PID>}，或在原终端按 Ctrl+C"
echo "  · 换端口：PORT=9000 ./启动桌面端.sh"
echo "  · 不想装 Node？直接用浏览器打开本目录的 demo.html，零安装看演示"
