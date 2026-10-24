#!/usr/bin/env node
/**
 * 桌面端本地服务（零第三方依赖）
 *
 * 把 src/ 下的 agent 编排包成一个 HTTP API，供 desktop/public/index.html 调用：
 *   GET  /                 前端单页（深色、三栏：案件列表 / 链路详情 / 决策轨迹）
 *   GET  /api/bootstrap    启动信息：样本清单 + 模型通道状态 + Node 版本
 *   POST /api/run          跑一个案件（msgId 或临时 text），返回全链路结果 + 轨迹原文
 *   POST /api/gate         跑回归门禁（8 样本逐一比对期望），返回逐行结果
 *   GET  /api/approvals    列出待人工审批的处置（审批中心的队列）
 *   POST /api/approve      审批裁决：{ id, approved, approver, note } → 批准则续办执行并结单
 *   GET  /api/connectors   数据源清单：连接器声明 + 实时规模 + MCP 服务端联通状态
 *   POST /api/connectors/pull  从一个（或全部）数据源拉数据并合并进引擎：{ id }
 *   POST /api/ingest       粘/传一段 CSV、TSV、JSON 直接入引擎：{ dataset, text }
 *   POST /api/inbound      一条客户消息入站 → 自动处置 → 结论可回写：{ text, from, channel, msg_id }
 *   GET  /api/inbound      入站消息流水（含去重命中记录）
 *   GET  /api/followups    人工跟进台账（哪些案子需要人接手、跟进到哪一步、谁在跟）
 *   POST /api/followup     记一笔人工跟进：{ case_key, action, by, note, target, case, run_case }
 *                          action ∈ claim | note | wait | reassign | rerun | close
 *                          case     = 该条会话的瘦身快照，用于重新打开页面时把案子一并还原
 *                          run_case = 「按补充事实重新处置」产生的那条结果快照（只有 rerun 会带）
 *
 * 设计要点：
 *   - 判定逻辑不重写：期望比对直接用 src/gate.ts 的 checkExpectation，
 *     UI 上显示的「符合期望」与命令行门禁退出码是同一个裁判。
 *   - 模型通道不可用时不假装成功：/api/run 的 offline 由前端显式决定，
 *     服务端只负责把 llmConfig 的真实状态告诉前端（bootstrap.mode）。
 *   - 数据源走真 MCP：启动时拉起 mcp/server.mjs 并完成 initialize / tools/list，
 *     拉数时调 tools/call；MCP 不可用时退回同一份数据文件（口径完全一致，不静默降级成假数据）。
 *   - 人工跟进是真台账：「转交专人跟进」不能只是一句话 —— 认领 / 记录 / 按补充事实重新处置 /
 *     结单全部落库，并且**重新处置会真的重跑一遍链路**（人工补到的事实要能被引擎用上）。
 *   - 端口默认 8787，可用 PORT 环境变量覆盖。
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const PORT = Number(process.env.PORT ?? 8787);

// Windows 上动态 import() 不接受裸绝对路径（ERR_UNSUPPORTED_ESM_URL_SCHEME），
// 必须先经 pathToFileURL 转成 file:// URL。Node ≥22.18 原生类型擦除，可直接 import .ts。
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const { runCase, runCaseDetailed, seedApprovalSeq } = await imp("src/agent.ts");
const { loadRegistry, loadStore, buildTools } = await imp("src/tools.ts");
const { loadPolicy, loadSop } = await imp("src/policy.ts");
const { llmConfig, resetEnvCache, SAMPLES_FILE } = await imp("src/env.ts");
const { callModel } = await imp("src/llm.ts");
const { checkExpectation, actualSummary } = await imp("src/gate.ts");
const { ingestText, mergeRows, storeStats, DATASETS, DATASET_SPEC, datasetHeader, DATASET_SAMPLE } = await imp("src/ingest.ts");
const { loadConnectors, pullFromFiles, listSources, buildConnectorViews } = await imp("src/connectors.ts");

const reg = loadRegistry();
const store = loadStore();
const deps = { store, sop: loadSop(), policy: loadPolicy(), reg, tools: buildTools(reg, store) };
const samples = JSON.parse(readFileSync(SAMPLES_FILE, "utf8")).rows;
const conns = loadConnectors();

/* ═══════════ MCP 客户端：本服务端就是一个 MCP 宿主 ═══════════
   零依赖实现：换行分隔的 JSON-RPC 2.0 over stdio。
   接不上不影响其它功能 —— 拉数会退回读同一份数据文件，并如实标注通道为「本地文件」。

   这一层最容易骗人的地方不是「连不上」，而是「看起来还连着」：
   子进程挂了却没人收尸，mcpState.ready 会一直是 true，于是界面显示「已联通」，
   每次拉数都要等满超时才失败。所以这里的纪律是 —— 进程一死就当场作废，
   所有在飞的请求立刻失败，绝不让它们挂到超时。

   另外两处不能省：
     · 定时器必须 unref()。一个没回音的请求不该拖住整个进程退出。
     · 超时要顺手发 notifications/cancelled。光抛异常不告诉对方，
       对方还在算，算完的响应会被当成无人认领的消息丢掉。
*/
const MCP_SERVER = join(ROOT, "mcp", "server.mjs");
const MCP_TIMEOUT = Number(process.env.MCP_TIMEOUT ?? 10000); // 单次工具调用上限
const MCP_HANDSHAKE_TIMEOUT = Number(process.env.MCP_HANDSHAKE_TIMEOUT ?? 8000); // 握手单独一档，别让工具调用的短超时把启动也卡死
const MCP_RETRY_COOLDOWN = 3000; // 失败后别疯狂重启子进程

const mcpState = {
  ready: false,
  problem: "",
  tools: [],
  serverInfo: null,
  attempts: 0,      // 一共尝试连接过几次（含自动重连）
  lastTriedAt: 0,
  handshakeMs: 0,   // 上次握手耗时：联通时这也是一个可看的数
};

let mcpConn = null;

/**
 * 毫秒数说成人话。超时配成 1 毫秒时写「0 秒」是最典型的那种「日志看着有、其实没有信息」。
 */
function fmtMs(ms) {
  return ms >= 1000 ? (ms / 1000) + " 秒" : ms + " 毫秒";
}

/** 主动放弃一条连接：先把它标成已死，再 kill —— 否则我们自己造成的 EPIPE 会覆盖掉真原因 */
function dropMcp(conn) {
  if (!conn) return;
  conn.live = false;
  if (mcpConn === conn) mcpConn = null;
  try { conn.child.kill(); } catch { /* 已经没了 */ }
}

/**
 * 从子进程的 stderr 里挑出「真正的那一句」。
 * 直接取最后两行没用 —— node 崩溃时末尾是 `} / Node.js v22.22.2` 这种收尾噪声，
 * 真正的原因（Cannot find module / SyntaxError）在中间。宁可给人一句能搜的话。
 */
function mcpReasonFromStderr(raw) {
  const lines = String(raw || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const hit =
    lines.find((l) => /^(Error|TypeError|SyntaxError|RangeError|Cannot find module|Cannot find package|EACCES|EADDRINUSE|EADDRNOTAVAIL)\b/.test(l)) ||
    lines.find((l) => /\b(Error|Exception)\b/.test(l)) ||
    lines[lines.length - 1] ||
    "";
  return hit.replace(/^Error:\s*/, "").slice(0, 160);
}

/** 建立一条到 MCP 服务端的连接（不含握手）。返回的对象自带生命周期状态 */
function openMcp() {
  const child = spawn(process.execPath, [MCP_SERVER], { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  let seq = 0;
  let stderr = "";
  const waiters = new Map();
  const conn = { child, live: true };

  /** 通道作废：状态立刻改、在飞的请求立刻失败 —— 这是「不假装在线」的唯一实现处 */
  const dead = (reason) => {
    if (!conn.live) return;
    conn.live = false;
    if (mcpConn === conn) mcpConn = null;
    mcpState.ready = false;
    mcpState.problem = reason;
    mcpState.tools = [];
    mcpState.serverInfo = null;
    for (const [, w] of waiters) {
      clearTimeout(w.timer);
      w.reject(new Error(reason)); // 不等超时，立刻告诉调用方
    }
    waiters.clear();
  };

  const write = (obj) => {
    if (!conn.live) return false;
    try {
      if (!child.stdin.writable) throw new Error("输入管道已关闭");
      child.stdin.write(JSON.stringify(obj) + "\n");
      return true;
    } catch (e) {
      // EPIPE 之类：进程已经没了，写失败不是调用方的问题，按通道作废处理
      dead("写入 MCP 子进程失败：" + (e?.message ?? e));
      return false;
    }
  };

  conn.send = (method, params, opts) => {
    const timeout = (opts && opts.timeout) || MCP_TIMEOUT;
    return new Promise((resolve, reject) => {
      if (!conn.live) { reject(new Error(mcpState.problem || "MCP 通道不可用")); return; }
      const id = ++seq;
      const timer = setTimeout(() => {
        waiters.delete(id);
        // 通知对方别算了。它可能已经算完，那我们这边丢掉即可 —— 不假装撤回
        write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "timeout" } });
        reject(new Error("MCP 调用超时（" + fmtMs(timeout) + "）：" + method));
      }, timeout);
      // 定时器不该决定进程能不能退出
      if (typeof timer.unref === "function") timer.unref();
      waiters.set(id, { resolve, reject, timer });
      if (!write({ jsonrpc: "2.0", id, method, params })) {
        waiters.delete(id);
        clearTimeout(timer);
        reject(new Error(mcpState.problem || "MCP 通道不可用"));
      }
    });
  };

  conn.notify = (method, params) => write({ jsonrpc: "2.0", method, params });

  conn.stderrText = () => stderr;

  child.stderr.on("data", (d) => { stderr = (stderr + d.toString("utf8")).slice(-2000); });

  child.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let at;
    while ((at = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, at).trim();
      buf = buf.slice(at + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const w = waiters.get(msg.id);
      if (!w) continue; // 超时后迟到的响应 / 无人认领的通知
      waiters.delete(msg.id);
      clearTimeout(w.timer);
      if (msg.error) w.reject(new Error("MCP 返回错误：" + (msg.error.message || "未知")));
      else w.resolve(msg.result);
    }
  });

  child.stdin.on("error", (e) => dead("MCP 输入管道异常：" + (e?.message ?? e)));
  child.on("error", (e) => dead("MCP 子进程起不来：" + (e?.message ?? e)));
  child.on("exit", (code, sig) => {
    const tail = mcpReasonFromStderr(stderr);
    // Windows 上被强制结束时 code 是 4294967295 这种数：直接写进界面等于没写
    const how = sig
      ? "被信号 " + sig + " 结束"
      : (code === null || code < 0 || code > 1000 ? "被强制结束" : "退出（退出码 " + code + "）");
    dead("MCP 子进程" + how + (tail ? "：" + tail : ""));
  });

  return conn;
}

/**
 * 连上（必要时重连）并完成握手。
 * 返回 true 表示通道可用。失败不抛异常 —— 调用方要的是「能不能用」，不是一次未处理拒绝。
 */
async function ensureMcp(opts) {
  const force = !!(opts && opts.force);
  if (mcpState.ready && mcpConn && mcpConn.live) return true;
  if (!force && Date.now() - mcpState.lastTriedAt < MCP_RETRY_COOLDOWN) return false;
  mcpState.lastTriedAt = Date.now();
  mcpState.attempts += 1;
  const t0 = Date.now();
  try {
    if (!mcpConn || !mcpConn.live) mcpConn = openMcp();
    const conn = mcpConn;
    const init = await conn.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "aftersales-desktop", version: "1.0.0" },
    }, { timeout: MCP_HANDSHAKE_TIMEOUT });
    conn.notify("notifications/initialized", {});
    const tl = await conn.send("tools/list", {}, { timeout: MCP_HANDSHAKE_TIMEOUT });
    mcpState.ready = true;
    mcpState.problem = "";
    mcpState.serverInfo = init?.serverInfo ?? null;
    mcpState.tools = (tl?.tools || []).map((t) => t.name);
    mcpState.handshakeMs = Date.now() - t0;
    return true;
  } catch (e) {
    mcpState.ready = false;
    mcpState.tools = [];
    mcpState.serverInfo = null;
    const stderrTail = mcpConn && mcpConn.stderrText ? mcpReasonFromStderr(mcpConn.stderrText()) : "";
    // 握手都过不去就别把这条半死连接留着：下次调用要么重开，要么老实走文件通路。
    // 顺序很重要 —— 先收尸再写问题。反过来的话，我们自己 kill 出来的 EPIPE
    // 会把「握手超时」这种真原因盖掉，界面上就只剩一句没用的管道错误。
    dropMcp(mcpConn);
    mcpState.problem = String(e?.message ?? e) || stderrTail || "MCP 服务端未就绪";
    return false;
  }
}

/**
 * 调一次工具。
 * MCP 协议里工具级失败是「正常返回 + isError:true」，不是 JSON-RPC error ——
 * 不认这一层，报错信息就会变成 JSON.parse 的语法错误，把真正原因埋掉。
 */
async function callMcpTool(name, args) {
  if (!mcpState.ready && !(await ensureMcp())) throw new Error(mcpState.problem || "MCP 通道不可用");
  const r = await mcpConn.send("tools/call", { name, arguments: args || {} });
  if (r && r.isError) {
    const txt = (r.content || []).map((c) => c && c.text).filter(Boolean).join("；");
    throw new Error(txt || "工具调用被服务端拒绝");
  }
  if (r && r.structuredContent) return r.structuredContent;
  const txt = r && r.content && r.content[0] && r.content[0].text;
  if (!txt) throw new Error("工具没有返回内容");
  try { return JSON.parse(txt); } catch { throw new Error("工具返回的不是可解析的数据"); }
}

await ensureMcp();

/**
 * 通道状态视图。
 * 界面要能回答四个问题，缺一个就会有人去猜：通了吗、通的是谁、什么工具在线、不通是什么原因。
 * 这里的每个字段都来自真实探测，没有一处是「大概能连」的推断。
 */
function mcpView() {
  return {
    ready: mcpState.ready,
    problem: mcpState.problem,
    serverInfo: mcpState.serverInfo,
    tools: mcpState.tools,
    attempts: mcpState.attempts,
    handshakeMs: mcpState.handshakeMs,
    timeoutMs: MCP_TIMEOUT,
    server: conns.server,
    namespace: conns.namespace,
    // 有进程可拉才有「重连」这回事；单文件版据此不摆一个点了必然失败的按钮
    can_reconnect: true,
  };
}

/** 入站消息流水（演示工程放内存；真实系统这里应是可重放的持久化队列） */
const inboundLog = [];

/** 数据源视图：声明 + 实时规模 + 工具是否在线（与单文件演示版共用同一段） */
function connectorViews() {
  return buildConnectorViews(conns, storeStats(store), {
    ready: mcpState.ready,
    problem: mcpState.problem,
    serverInfo: mcpState.serverInfo,
    tools: mcpState.tools,
  });
}

/**
 * 待审批队列。
 *
 * 存的是「这一次会话的续办句柄」而不是一份可以重新跑的请求——审批人批的是
 * 具体那一笔金额，重新跑一遍可能算出别的数，那就不是审批了。
 *
 * 落了盘的是**单据**（append-only 事件流），不是续办句柄：句柄是闭包，跨不了进程。
 * 所以重启后这些单子的状态必须说清楚，不能装作还能续办 ——
 * 恢复出来的单子标 stale（流程已中断），界面上给的是「重新处置」而不是「批准执行」。
 */
const pendingApprovals = new Map();

/**
 * 台账落盘：append-only JSONL + 启动回放。
 *
 * 为什么是事件流而不是快照：快照要每次重写整条记录（含案子快照与重跑结果），
 * 越写越大，而且写一半崩了就整条坏掉；事件流每次只追加一行，坏一行只丢一行。
 * 更关键的是 —— **写入与回放必须共用同一个状态推演函数**，
 * 否则「运行时的状态」与「重启后的状态」会慢慢长成两套口径。
 */
const LEDGER_DIR = join(ROOT, "data", "ledger");
const FU_LEDGER = join(LEDGER_DIR, "followups.jsonl");
const APPR_LEDGER = join(LEDGER_DIR, "approvals.jsonl");

function appendLedger(file, obj) {
  try {
    mkdirSync(LEDGER_DIR, { recursive: true });
    appendFileSync(file, JSON.stringify(obj) + "\n", "utf8");
  } catch (e) {
    // 台账写不进去不能挡住眼前这次操作，但必须留下痕迹（否则就是静默丢数据）
    console.error(`[ledger] 写入失败 ${file}：`, e.message);
  }
}

function replayLedger(file) {
  const out = [];
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return out; // 还没有台账，第一次跑
  }
  let bad = 0;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      bad += 1;
    }
  }
  if (bad) console.warn(`[ledger] ${file} 有 ${bad} 行解析不了，已跳过`);
  return out;
}

const FU_STATUS = { todo: "待跟进", doing: "跟进中", waiting: "等客户回复", closed: "已结单" };
const FU_LABEL = {
  claim: "接手跟进",
  note: "记了一条跟进",
  wait: "已联系客户，等待客户补充",
  reassign: "转交跟进",
  rerun: "按补充事实重新处置",
  close: "核实完毕，结单",
};

/**
 * 一笔跟进事件 → 台账新状态。**运行时与回放共用这一份**。
 * 纯函数：不改入参、返回新对象，避免回放时把历史对象改脏。
 */
function applyFollowupEvent(prev, e) {
  const cur = {
    owner: prev.owner ?? "",
    status: prev.status ?? "todo",
    log: [...(prev.log ?? [])],
    case: prev.case ?? null,
    run_case: prev.run_case ?? null,
  };
  // 台账要连着案子一起存：否则重开页面时台账还在、它记的那条案子却没了。
  if (e.case && typeof e.case === "object") cur.case = e.case;
  // 「按补充事实重新处置」的结果也一并存：那是人工跟进真正跟出来的东西，只留原案会让人白跟一场。
  if (e.run_case && typeof e.run_case === "object") cur.run_case = e.run_case;
  cur.log.push({
    at: e.at,
    by: e.by,
    action: e.action,
    label: e.label ?? FU_LABEL[e.action] ?? "跟进",
    note: e.note ?? "",
    target: e.target ?? "",
  });

  const { action, by, target } = e;
  if (action === "claim" || action === "note" || action === "rerun" || action === "reassign") {
    if (action === "reassign" && target) cur.owner = target;
    else if (!cur.owner) cur.owner = by;
    if (cur.status === "todo" || cur.status === "waiting") cur.status = "doing";
    if (action === "reassign") cur.status = "doing";
  }
  if (action === "wait") {
    if (!cur.owner) cur.owner = by;
    cur.status = "waiting";
  }
  if (action === "close") {
    if (!cur.owner) cur.owner = by;
    cur.status = "closed";
  }
  return cur;
}

const followups = new Map();
for (const e of replayLedger(FU_LEDGER)) {
  if (!e || !e.case_key) continue;
  followups.set(e.case_key, applyFollowupEvent(followups.get(e.case_key) ?? {}, e));
}
if (followups.size) {
  const logCount = [...followups.values()].reduce((n, v) => n + v.log.length, 0);
  console.log(`[ledger] 回放出 ${followups.size} 条人工跟进，共 ${logCount} 条跟进记录`);
}

/**
 * 审批单回放：只认「有请求、没有裁决」的单子。
 * 它们的续办句柄随进程一起没了，所以标 stale —— 界面上不能给一个点了会 404 的「批准执行」。
 */
const APPR_EVENTS = replayLedger(APPR_LEDGER);
for (const e of APPR_EVENTS) {
  if (!e || !e.id) continue;
  if (e.kind === "requested") {
    pendingApprovals.set(e.id, {
      ticket: { ...e.ticket, stale: true, stale_reason: "服务重启时这条处置流程已中断，续办句柄不在了" },
      resume: null,
      msg_id: e.msg_id,
      sample_id: e.sample_id ?? null,
      stale: true,
    });
  } else if (e.kind === "resolved") {
    pendingApprovals.delete(e.id);
  }
}
// 单号续号：不续就会出现「重启后新单与旧单同号 → 新单一裁决把旧单一起抹掉」
seedApprovalSeq(APPR_EVENTS.map((e) => e && e.id).filter(Boolean));
if (pendingApprovals.size) {
  const staleCount = [...pendingApprovals.values()].filter((x) => x.stale).length;
  console.log(`[ledger] 回放出 ${pendingApprovals.size} 张待审批单（其中 ${staleCount} 张已失效，需重新处置）`);
}

/** 跑完一个案件后，把轨迹原文（JSONL 每一行）一并返回，供 UI 回放 */
function withTrace(result) {
  let traceLines = [];
  try {
    traceLines = readFileSync(result.trace_path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  } catch {
    /* 轨迹读取失败不影响主结果 */
  }
  return { ...result, trace_lines: traceLines };
}

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(s);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

/* ═══════════ 模型接口配置：读 / 写 / 试连 ═══════════
   三条纪律：
   1) 密钥只落本机 .env，接口对外只回尾 4 位，任何响应都不带明文。
   2) 写回时保留原有注释与键序，只改这四行 —— 不整份覆盖。
   3) 保存后必须重载缓存，否则表现为「保存成功但不生效」。 */
const CFG_KEYS = ["LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "LLM_TIMEOUT"];
const ENV_PATH = join(ROOT, ".env");

function envRaw() {
  try {
    return readFileSync(ENV_PATH, "utf8");
  } catch {
    return "";
  }
}

function maskKey(k) {
  if (!k) return "";
  return k.length <= 4 ? "****" : "****" + k.slice(-4);
}

/** 哪些键被真实环境变量遮住了：写了 .env 也不生效时，得能说清为什么 */
function shadowedKeys() {
  return CFG_KEYS.filter((k) => process.env[k] !== undefined && process.env[k] !== "");
}

function configView() {
  const c = llmConfig();
  return {
    ok: true,
    editable: true,
    baseUrl: c.baseUrl,
    model: c.model,
    timeout: c.timeout,
    key_set: !!c.apiKey,
    key_mask: maskKey(c.apiKey),
    usable: c.usable,
    problem: c.problem,
    shadowed: shadowedKeys(),
    env_file: ".env（项目根目录）",
  };
}

function writeEnvPatch(patch) {
  const lines = envRaw().split(/\r?\n/);
  const seen = new Set();
  const out = lines.map((line) => {
    const m = line.match(/^([A-Z0-9_]+)\s*=/);
    if (!m || !(m[1] in patch)) return line;
    seen.add(m[1]);
    return `${m[1]}=${patch[m[1]]}`;
  });
  for (const k of Object.keys(patch)) if (!seen.has(k)) out.push(`${k}=${patch[k]}`);
  writeFileSync(ENV_PATH, out.join("\n"), "utf8");
}

/* ═══════════ 跑一个案件：一次跑批，两种交付方式 ═══════════
   /api/run        —— 一次返回结果（脚本、门禁、老前端用）
   /api/run/stream —— NDJSON 边跑边推过程事件（处置台用）
   两条路必须共用同一份编排调用与同一份收尾逻辑，否则「流式那条」迟早与
   「普通那条」出现口径差：一边记账一边不记、一边按 stale 处理一边不处理。 */
function prepareRun(body) {
  const offline = body.offline !== false; // 默认离线；显式传 false 才走模型
  if (!offline && !llmConfig().usable) {
    const e = new Error(`模型通道不可用：${llmConfig().problem}。请填入可用密钥，或改用离线规则模式。`);
    e.status = 400;
    throw e;
  }
  let msgId = String(body.msgId ?? "");
  if (!msgId && body.text) {
    // 临时咨询：合成一条消息塞进 store，订单线索完全从自然语言解析
    msgId = `ADHOC-${Date.now().toString().slice(-6)}`;
    store.messages.push({ msg_id: msgId, text: String(body.text), known_order: null });
  }
  if (!msgId || !store.messages.some((m) => m.msg_id === msgId)) {
    const e = new Error("缺少 msgId 或 text，或消息不存在");
    e.status = 400;
    throw e;
  }
  return { msgId, offline };
}

/** 把一次跑批的结果收尾：待审批单入队 + 落盘 + 挂样本期望比对 */
function finishRun(msgId, outcome) {
  let pendingPayload = null;
  if (outcome.status === "pending" && outcome.ticket && outcome.resume) {
    pendingApprovals.set(outcome.ticket.id, {
      ticket: outcome.ticket,
      resume: outcome.resume,
      msg_id: msgId,
      sample_id: samples.find((s) => s.msg_id === msgId)?.sample_id ?? null,
    });
    // 单据落盘（续办句柄不落盘：闭包跨不了进程，重启后按 stale 处理）
    appendLedger(APPR_LEDGER, {
      at: new Date().toISOString(),
      kind: "requested",
      id: outcome.ticket.id,
      msg_id: msgId,
      sample_id: samples.find((s) => s.msg_id === msgId)?.sample_id ?? null,
      ticket: outcome.ticket,
    });
    pendingPayload = outcome.ticket;
  }
  const sample = samples.find((s) => s.msg_id === msgId) ?? null;
  const payload = withTrace(outcome.result);
  if (sample) {
    payload.sample_id = sample.sample_id;
    payload.grade = sample.grade;
    payload.title = sample.title;
    payload.expected = sample.expect;
    payload.expect_errors = checkExpectation(sample, outcome.result);
  }
  return { payload, pending: pendingPayload };
}

function runOptionsFor(body, offline, extra) {
  return {
    offline,
    autoApproveAsk: body.autoApproveAsk !== false, // 演示默认自动确认 ASK 档（小额不必等人点）
    disableReviewer: body.disableReviewer === true,
    simulateStageViolation: body.simulateStageViolation === true,
    // 自主模式：大额动作停办转审批中心，而不是就地无限等待
    deferApproval: body.deferApproval !== false,
    ...extra,
  };
}

function streamHead(res) {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    // 反向代理不许缓冲：否则「流式」会在中途被攒成一坨，退化成一次性返回
    "X-Accel-Buffering": "no",
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      // 按请求读盘：改完前端刷新浏览器即可见，不用重启服务（本地演示改 UI 是高频动作）
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync(join(here, "public", "index.html"), "utf8"));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/bootstrap") {
      const c = llmConfig();
      json(res, 200, {
        ok: true,
        node: process.version,
        port: PORT,
        namespace: reg.namespace,
        mode: c.usable ? "model" : "offline",
        llm_problem: c.usable ? "" : c.problem,
        // 工具注册表：前端「技能」视图渲染工具面与阶段装配矩阵用，
        // 和 src/tools.ts 读的是同一份 data/tool-registry.json
        registry: { namespace: reg.namespace, tools: reg.tools },
        samples: samples.map((s) => ({
          sample_id: s.sample_id,
          grade: s.grade,
          msg_id: s.msg_id,
          title: s.title,
          display: s.display ?? s.title,
          text: store.messages.find((m) => m.msg_id === s.msg_id)?.text ?? "",
          expect: s.expect,
        })),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/run") {
      const body = await readBody(req);
      let pre;
      try {
        pre = prepareRun(body);
      } catch (e) {
        json(res, e.status ?? 500, { ok: false, error: e.message });
        return;
      }
      const outcome = await runCaseDetailed(pre.msgId, deps, runOptionsFor(body, pre.offline));
      const { payload, pending } = finishRun(pre.msgId, outcome);
      json(res, 200, { ok: true, result: payload, pending });
      return;
    }

    /* —— 边跑边推：每个过程事件一行 JSON，最后一行是结果 ——
       为什么要有它：模型判定一条 20–30 秒，宿主原先只知道「还没回来」，
       界面上只能显示转圈或编一个假进度。轨迹本来就是真实审计记录，
       把它实时推出去，界面显示的就是引擎自己记下的过程。 */
    if (req.method === "POST" && url.pathname === "/api/run/stream") {
      const body = await readBody(req);
      let pre;
      try {
        pre = prepareRun(body);
      } catch (e) {
        json(res, e.status ?? 500, { ok: false, error: e.message });
        return;
      }

      streamHead(res);
      let finished = false;
      const send = (obj) => {
        if (finished || res.writableEnded) return;
        try {
          res.write(JSON.stringify(obj) + "\n");
        } catch {
          /* 浏览器已经走了，写不进去是正常情况，不是故障 */
        }
      };

      // 取消传播：浏览器关页面 / 断开 / 前端 abort，都会在这里变成一次信号
      const ctrl = new AbortController();
      req.on("close", () => {
        if (!finished) ctrl.abort();
      });

      send({ type: "start", msg_id: pre.msgId, mode: pre.offline ? "offline" : "model", at: new Date().toISOString() });
      try {
        const outcome = await runCaseDetailed(pre.msgId, deps, runOptionsFor(body, pre.offline, {
          signal: ctrl.signal,
          onEvent: (line) => send({ type: "event", line }),
        }));
        const { payload, pending } = finishRun(pre.msgId, outcome);
        send({ type: "result", result: payload, pending });
      } catch (e) {
        if (e && e.name === "AbortError") send({ type: "cancelled", error: "已取消：在环节边界停下，未执行资金处置" });
        else send({ type: "error", error: (e && e.message) || "内部错误" });
      }
      finished = true;
      try {
        res.end();
      } catch {
        /* 同上 */
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/config") {
      json(res, 200, configView());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/config") {
      const b = await readBody(req);
      const baseUrl = String(b.baseUrl ?? "").trim();
      const model = String(b.model ?? "").trim();
      const timeout = Number(b.timeout);
      const apiKey = typeof b.apiKey === "string" ? b.apiKey.trim() : "";

      const bad = [];
      if (!/^https?:\/\/.+/i.test(baseUrl)) bad.push("服务地址要以 http:// 或 https:// 开头");
      if (!model) bad.push("模型名不能为空");
      if (!Number.isFinite(timeout) || timeout < 1 || timeout > 600) bad.push("超时时间要在 1–600 秒之间");
      if (bad.length) {
        json(res, 400, { ok: false, error: bad.join("；") });
        return;
      }

      const patch = {
        LLM_BASE_URL: baseUrl,
        LLM_MODEL: model,
        LLM_TIMEOUT: String(Math.round(timeout)),
      };
      // 密钥留空 = 保持原值。要清空必须显式说 clear_key，避免误清。
      if (apiKey) patch.LLM_API_KEY = apiKey;
      else if (b.clear_key === true) patch.LLM_API_KEY = "";

      writeEnvPatch(patch);
      resetEnvCache(); // 不重载缓存的话，改了也要重启才生效
      json(res, 200, configView());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/config/test") {
      const c = llmConfig();
      if (!c.usable) {
        json(res, 200, { ok: false, error: c.problem });
        return;
      }
      try {
        const r = await callModel("你是连通性检查助手，只回复 OK 两个字。", "ping", 0);
        json(res, 200, {
          ok: true,
          latency_ms: r.latency_ms,
          model: r.model,
          reply: String(r.text ?? "").trim().slice(0, 40),
        });
      } catch (e) {
        let msg = String(e?.message ?? e);
        // 错误信息里绝不能出现密钥本身
        if (c.apiKey && msg.includes(c.apiKey)) msg = msg.split(c.apiKey).join("***");
        json(res, 200, { ok: false, error: msg, status: e?.status ?? null });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/approvals") {
      json(res, 200, {
        ok: true,
        items: [...pendingApprovals.values()].map((x) => x.ticket),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/approve") {
      const body = await readBody(req);
      const id = String(body.id ?? "");
      const entry = pendingApprovals.get(id);
      if (!entry) {
        json(res, 404, { ok: false, error: "该审批单不存在或已处理" });
        return;
      }
      // 重启恢复出来的单子没有续办句柄。不假装能续办，也不悄悄把它批掉：
      // 明确告诉人「这条流程断了，去重新处置」，并把它从队列里摘掉。
      if (!entry.resume) {
        json(res, 409, {
          ok: false,
          stale: true,
          error: "这条处置流程在服务重启时中断了，当时的续办句柄已不存在，无法在这里批准执行。请重新处置这条案子。",
          msg_id: entry.msg_id,
        });
        return;
      }
      const approved = body.approved === true;
      const approver = String(body.approver ?? "").trim() || "未署名审批人";
      const note = String(body.note ?? "");
      // 先取出再删：续办过程若抛错，单子已被消费，避免重复执行同一笔处置
      pendingApprovals.delete(id);
      appendLedger(APPR_LEDGER, { at: new Date().toISOString(), kind: "resolved", id, approved, approver, note });
      const result = await entry.resume(approved, approver, note);
      const sample = samples.find((s) => s.msg_id === entry.msg_id) ?? null;
      const payload = withTrace(result);
      if (sample) {
        payload.sample_id = sample.sample_id;
        payload.grade = sample.grade;
        payload.title = sample.title;
        payload.expected = sample.expect;
        payload.expect_errors = checkExpectation(sample, result);
      }
      json(res, 200, {
        ok: true,
        approved,
        approver,
        note,
        result: payload,
        remaining: pendingApprovals.size,
      });
      return;
    }

    /* ── 人工跟进：把「已转交专人跟进」变成一件能做的事 ── */
    if (req.method === "GET" && url.pathname === "/api/followups") {
      json(res, 200, {
        ok: true,
        statuses: FU_STATUS,
        items: [...followups.entries()].map(([key, v]) => ({ case_key: key, ...v })),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/followup") {
      const body = await readBody(req);
      const key = String(body.case_key ?? "").trim();
      const action = String(body.action ?? "").trim();
      const by = String(body.by ?? "").trim() || "未署名跟进人";
      const note = String(body.note ?? "").trim();
      const target = String(body.target ?? "").trim();
      if (!key) {
        json(res, 400, { ok: false, error: "缺少 case_key" });
        return;
      }
      const LABEL = FU_LABEL;
      if (!LABEL[action]) {
        json(res, 400, { ok: false, error: `不认识的跟进动作：${action}` });
        return;
      }
      if (action === "note" && !note) {
        json(res, 400, { ok: false, error: "跟进记录不能为空" });
        return;
      }
      const event = {
        at: new Date().toISOString(),
        case_key: key,
        action,
        by,
        note,
        target,
        label: LABEL[action],
        ...(body.case && typeof body.case === "object" ? { case: body.case } : {}),
        ...(body.run_case && typeof body.run_case === "object" ? { run_case: body.run_case } : {}),
      };
      // 先落盘再改内存：崩在中间时最多「文件里有、内存没有」，
      // 下次启动回放能补上；反过来就是「界面显示记下了、其实没存」。
      appendLedger(FU_LEDGER, event);
      const cur = applyFollowupEvent(followups.get(key) ?? {}, event);
      followups.set(key, cur);
      json(res, 200, { ok: true, case_key: key, ...cur, status_text: FU_STATUS[cur.status] });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/gate") {
      const body = await readBody(req);
      const offline = body.offline !== false;
      const rows = [];
      for (const s of samples) {
        const r = await runCase(s.msg_id, deps, {
          offline,
          autoApproveAsk: body.autoApproveAsk !== false,
          disableReviewer: body.disableReviewer === true,
        });
        rows.push({
          sample_id: s.sample_id,
          grade: s.grade,
          msg_id: s.msg_id,
          title: s.title,
          expect: s.expect,
          actual: actualSummary(r),
          errors: checkExpectation(s, r),
        });
      }
      const failed = rows.filter((x) => x.errors.length > 0).length;
      json(res, 200, { ok: true, passed: rows.length - failed, failed, total: rows.length, rows });
      return;
    }

    /* ── 数据源：连接器清单 ── */
    if (req.method === "GET" && url.pathname === "/api/connectors") {
      json(res, 200, {
        ok: true,
        protocol: conns.protocol,
        namespace: conns.namespace,
        notice: conns.notice,
        server: conns.server,
        mcp: mcpView(),
        datasets: DATASETS.map((d) => ({
          dataset: d,
          label: DATASET_SPEC[d].label,
          rows: storeStats(store)[d],
          columns: datasetHeader(d),
          sample: DATASET_SAMPLE[d],
        })),
        stats: storeStats(store),
        connectors: connectorViews(),
      });
      return;
    }

    /* ── 数据源：从一个（或全部）连接器拉数据 ── */
    if (req.method === "POST" && url.pathname === "/api/connectors/pull") {
      const body = await readBody(req);
      const want = String(body.id ?? "").trim();
      const targets = !want || want === "*" ? conns.connectors : conns.connectors.filter((c) => c.id === want);
      if (!targets.length) {
        json(res, 404, { ok: false, error: "没有这个数据源" });
        return;
      }

      // 通道没通就先试一次（有冷却，不会每次点都重启子进程）
      if (!mcpState.ready) await ensureMcp();

      const pulled = [];
      for (const c of targets) {
        if (c.kind !== "mcp") continue;
        let reports = [];
        let ok = 0;
        const mcpErrors = [];
        for (const t of listSources(c)) {
          if (!mcpState.ready) break;
          try {
            const payload = await callMcpTool(`${conns.namespace}.${t.name}`, {});
            reports.push(mergeRows(store, payload.dataset ?? t.dataset, payload.rows ?? []));
            ok += 1;
          } catch (e) {
            mcpErrors.push(t.name + "：" + String(e?.message ?? e));
          }
        }
        // 一个工具都没成 = 这条路其实是不通的。退回同一份数据文件（同一套校验、同一处 upsert），
        // 但 via 必须写成 file、并把不通的原因一起带回去 ——
        // 不能一边报错一边标「已联通」，那正是这类集成最容易撒的谎。
        let via = "mcp";
        if (!ok) {
          via = "file";
          reports = pullFromFiles(store, c);
        }
        const why = mcpErrors.length ? mcpErrors[0] : (mcpState.problem || "");
        pulled.push({
          id: c.id,
          name: c.name,
          via,
          via_note: via === "file" && why ? "MCP 通道未就绪：" + why + "。数据已改从本地文件通路读取。" : "",
          reports,
          added: reports.reduce((n, r) => n + r.added, 0),
          updated: reports.reduce((n, r) => n + r.updated, 0),
          rejected: reports.reduce((n, r) => n + r.rejected, 0),
          errors: reports.flatMap((r) => r.errors).concat(mcpErrors),
        });
      }
      json(res, 200, { ok: true, pulled, stats: storeStats(store), connectors: connectorViews(), mcp: mcpView() });
      return;
    }

    /* ── MCP 通道：手动重连 ──
       界面上的「重连」按钮走这里。不带 force 的自动重连有 3 秒冷却，
       人点了按钮就该立刻试，所以这里 force: true。 */
    if (req.method === "POST" && url.pathname === "/api/mcp/reconnect") {
      dropMcp(mcpConn);
      mcpState.ready = false;
      const okReady = await ensureMcp({ force: true });
      json(res, 200, { ok: true, connected: okReady, mcp: mcpView(), connectors: connectorViews() });
      return;
    }

    /* ── 数据源：直接粘一段文本入引擎 ── */
    if (req.method === "POST" && url.pathname === "/api/ingest") {
      const body = await readBody(req);
      const dataset = String(body.dataset ?? "");
      if (!DATASETS.includes(dataset)) {
        json(res, 400, { ok: false, error: "请选择要导入的数据表（订单 / 退款申请 / 商品规格 / 物流 / 工单）" });
        return;
      }
      const report = ingestText(store, dataset, String(body.text ?? ""));
      json(res, 200, { ok: true, report, stats: storeStats(store), connectors: connectorViews() });
      return;
    }

    /* ── 微信入站：一条客户消息进来即触发一次处置 ── */
    if (req.method === "GET" && url.pathname === "/api/inbound") {
      json(res, 200, {
        ok: true,
        connected: true,
        protocol: conns.protocol,
        notice: conns.notice,
        // 只给最近 8 条带上处置结果：界面重开时按它回灌队列，再往前的只留流水
        entries: inboundLog.slice(-40).reverse().map((e, i) => (i < 8 ? e : { ...e, result: undefined })),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/inbound") {
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) {
        json(res, 400, { ok: false, error: "消息内容为空" });
        return;
      }
      const from = String(body.from ?? "").trim() || "微信客户";
      const channel = String(body.channel ?? "").trim() || "微信小店";
      const at = new Date().toISOString();
      // message_id 优先用微信侧给的：同一条消息被重复投递时不应该跑第二遍
      const msgId = String(body.msg_id ?? "").trim() ||
        "WX-" + createHash("sha256").update(`${from}|${channel}|${text}`).digest("hex").slice(0, 10);

      const seen = store.messages.find((m) => m.msg_id === msgId);
      if (seen) {
        inboundLog.push({ msg_id: msgId, from, channel, text, at, status: "duplicate", note: "同一条消息已处理过，未重复执行" });
        json(res, 200, { ok: true, deduped: true, msg_id: msgId, from, channel, at, note: "该消息已处理过，未重复执行" });
        return;
      }

      store.messages.push({ msg_id: msgId, text, known_order: null });
      const offline = body.offline !== false;
      if (!offline && !llmConfig().usable) {
        json(res, 400, { ok: false, error: `模型通道不可用：${llmConfig().problem}。请填入可用密钥，或改用离线规则模式。` });
        return;
      }

      const outcome = await runCaseDetailed(msgId, deps, {
        offline,
        autoApproveAsk: body.autoApproveAsk !== false,
        disableReviewer: false,
        deferApproval: true,
      });
      let pendingPayload = null;
      if (outcome.status === "pending" && outcome.ticket && outcome.resume) {
        pendingApprovals.set(outcome.ticket.id, { ticket: outcome.ticket, resume: outcome.resume, msg_id: msgId, sample_id: null });
        appendLedger(APPR_LEDGER, {
          at: new Date().toISOString(),
          kind: "requested",
          id: outcome.ticket.id,
          msg_id: msgId,
          sample_id: null,
          ticket: outcome.ticket,
        });
        pendingPayload = outcome.ticket;
      }
      const payload = withTrace(outcome.result);
      payload.inbound = { msg_id: msgId, from, channel, at };
      inboundLog.push({
        msg_id: msgId, from, channel, text, at,
        status: outcome.result.pending_approval ? "pending" : "handled",
        outcome: outcome.result.execution_outcome ?? "",
        result: payload,
      });
      json(res, 200, { ok: true, deduped: false, msg_id: msgId, from, channel, at, result: payload, pending: pendingPayload });
      return;
    }

    json(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    // 服务端异常必须留痕：只回一句 JSON 会让人分不清是「没收到」还是「处理时炸了」
    console.error(`[server] ${req.method} ${url.pathname} 处理失败：`, e);
    json(res, 500, { ok: false, error: String(e?.message ?? e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const c = llmConfig();
  console.log(`售后 Agent 桌面端已启动：http://127.0.0.1:${PORT}`);
  console.log(`模型通道：${c.usable ? "可用（" + c.model + "）" : "不可用 —— " + c.problem + "，前端将以离线规则模式运行"}`);
  console.log(
    `数据连接器：${conns.connectors.length} 个（${conns.connectors.map((x) => x.name).join(" / ")}）｜` +
      (mcpState.ready
        ? `MCP 服务端已联通，工具 ${mcpState.tools.length} 个`
        : `MCP 未联通（${mcpState.problem}），拉数走本地文件通路`)
  );
  console.log("停止服务：关闭本窗口或 Ctrl+C");
});

/* 退出时把 MCP 子进程一起带走。
   不这么做的话，每次 Ctrl+C 都会留一个孤儿 node 进程占着管道，
   下次启动时「明明上次能用」却连不上 —— 这类残留最难查也最没必要。 */
const shutdown = (sig) => {
  if (mcpConn) { try { mcpConn.child.kill(); } catch { /* 已经没了 */ } mcpConn = null; }
  if (sig) process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => shutdown(null));
