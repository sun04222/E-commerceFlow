#!/usr/bin/env node
/**
 * 电商数据连接器 · MCP 服务端（零依赖）
 *
 * 这是一个标准的 stdio MCP 服务端：换行分隔的 JSON-RPC 2.0。
 * 它能被任何 MCP 宿主直接连接（Claude Code / Cursor / 自研 Agent），
 * 因此「把平台数据接进来」这件事不绑死在本项目的界面上。
 *
 *   连接方式（任意 MCP 宿主通用）：
 *     { "mcpServers": { "commerce": { "command": "node", "args": ["<绝对路径>/mcp/server.mjs"] } } }
 *
 * 工具面不硬编码：全部来自 ../data/connectors.json 的声明。
 * 想接入一个新平台，改声明、放数据文件即可，本文件不用动。
 *
 * 手测：
 *   node mcp/server.mjs --list     打印工具清单
 *   node mcp/server.mjs --call commerce.orders_list   调一次工具，看返回
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "commerce-connectors", version: "1.0.0" };

const manifest = JSON.parse(readFileSync(join(ROOT, "data", "connectors.json"), "utf8"));
const NS = manifest.namespace;

/* ═══ 极简 CSV 解析：与 src/ingest.ts 同一套语义（引号包裹、"" 转义、CRLF 归一）═══ */
function parseDelimited(text) {
  const clean = String(text).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!clean) return [];
  const first = clean.split("\n")[0];
  const delim = first.includes("\t") && first.split("\t").length > first.split(",").length ? "\t" : ",";
  const cells = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delim) { row.push(field); field = ""; continue; }
    if (ch === "\n") { row.push(field); cells.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  row.push(field);
  cells.push(row);

  const headers = (cells.shift() ?? []).map((h) => h.trim());
  return cells
    .filter((r) => r.some((c) => c.trim() !== ""))
    .map((r) => {
      const o = {};
      headers.forEach((h, i) => { o[h] = (r[i] ?? "").trim(); });
      return o;
    });
}

/** 数值 / 布尔 / JSON 字面量还原：CSV 里全是字符串，出去之前要变成真类型 */
function toTyped(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === "") { out[k] = ""; continue; }
    if (/^-?\d+(\.\d+)?$/.test(v) && !/^0\d/.test(v)) { out[k] = Number(v); continue; }
    if (v === "true" || v === "false") { out[k] = v === "true"; continue; }
    if ((v.startsWith("{") && v.endsWith("}")) || (v.startsWith("[") && v.endsWith("]"))) {
      try { out[k] = JSON.parse(v); continue; } catch { /* 保持字符串 */ }
    }
    out[k] = v;
  }
  return out;
}

function readRows(tool) {
  const text = readFileSync(join(ROOT, tool.file), "utf8");
  return parseDelimited(text).map(toTyped);
}

/* ═══ 工具面：由声明派生 ═══ */
const toolIndex = new Map();
for (const c of manifest.connectors) {
  for (const t of c.tools) {
    if (t.op !== "list" && t.op !== "get") continue;
    const fq = `${NS}.${t.name}`;
    toolIndex.set(fq, { ...t, connector: c, fq });
  }
}

function resolveTool(name) {
  if (toolIndex.has(name)) return toolIndex.get(name);
  return toolIndex.get(`${NS}.${name}`) ?? null;
}

function listTools() {
  return [...toolIndex.values()].map((t) => ({
    name: t.fq,
    title: t.title,
    description: `${t.connector.name}｜${t.title}。数据来源：${t.connector.platforms.join(" / ")}。${t.connector.desc}`,
    inputSchema: {
      type: "object",
      properties:
        t.op === "get"
          ? { [t.key]: { type: "string", description: "按该字段精确定位一行" } }
          : { limit: { type: "number", description: "最多返回多少行，默认 200" } },
      required: t.op === "get" ? [t.key] : [],
    },
  }));
}

function callTool(name, args = {}) {
  const t = resolveTool(name);
  if (!t) throw new Error(`未知工具：${name}`);
  let rows = readRows(t);
  if (t.op === "get") {
    const v = args[t.key];
    if (v === undefined || v === null || v === "") throw new Error(`缺少参数 ${t.key}`);
    rows = rows.filter((r) => String(r[t.key]) === String(v));
  } else {
    const limit = Number(args.limit ?? 200);
    if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, limit);
  }
  // 一次性把整张表给到调用方 —— 数据入口交给 src/ingest.ts 做校验与合并，不由本文件决定口径
  return { dataset: t.dataset, connector: t.connector.id, rows, count: rows.length };
}

/* ═══ JSON-RPC 主循环 ═══ */
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function fail(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        "电商数据连接器。工具名以 " + NS + ". 前缀命名空间化，按需拉取订单 / 退款申请 / 商品规格 / 物流 / 工单。",
    });
  }
  if (method === "notifications/initialized" || (typeof method === "string" && method.startsWith("notifications/"))) return;
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: listTools() });
  if (method === "tools/call") {
    const name = params?.name ?? "";
    try {
      const payload = callTool(name, params?.arguments ?? {});
      return reply(id, {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
        isError: false,
      });
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: String(e.message ?? e) }], isError: true });
    }
  }
  if (id === undefined) return; // 通知类消息不需要回
  return fail(id, -32601, `未实现的方法：${method}`);
}

/* ═══ CLI 自测通道（不参与 MCP 会话）═══ */
const argv = process.argv.slice(2);
if (argv.includes("--list")) {
  for (const t of listTools()) console.log(`${t.name}\t${t.title}`);
  process.exit(0);
}
if (argv.includes("--call")) {
  const name = argv[argv.indexOf("--call") + 1];
  console.log(JSON.stringify(callTool(name, {}), null, 2));
  process.exit(0);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let at;
  while ((at = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, at).trim();
    buf = buf.slice(at + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    try { handle(msg); } catch (e) {
      if (msg && msg.id !== undefined) fail(msg.id, -32603, String(e?.message ?? e));
    }
  }
});
process.stdin.on("end", () => process.exit(0));
