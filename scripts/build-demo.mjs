/**
 * build-demo.mjs —— 把整个工程打成「一个 HTML 文件」
 *
 * 为什么要有这个：
 *   原交付形态是「装 Node 22.18+ → 双击 .cmd → 起服务 → 开浏览器」。
 *   Node 22.18 这个门槛足以挡掉绝大多数人，演示工程不该要求别人配环境。
 *   参考 LessIsFORe / agent.html / Nemilia 这类项目的做法：单文件、零安装、
 *   双击即用。本项目的核心价值（门禁 8/8、消融对照、轨迹回放）本来就不依赖模型，
 *   所以完全可以在浏览器里跑。
 *
 * 模型通道怎么办：
 *   实测智谱 API 不回 Access-Control-Allow-Origin，浏览器直连会被 CORS 拦掉。
 *   所以单文件版只做离线引擎（不需要密钥）；模型模式留给 Node 服务端
 *   （node desktop/server.mjs），密钥也因此不必进浏览器——比 BYOK 更安全。
 *
 * 零依赖：只用 Node 内置的 module.stripTypeScriptTypes，不引 esbuild/babel。
 * 运行：node scripts/build-demo.mjs   （需要 Node 22.13+，仅构建时需要）
 */
import { stripTypeScriptTypes } from "node:module";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const OUT = join(ROOT, "demo.html");

/* ── 1. 自校验：内置 sha256 必须和 node:crypto 逐位一致 ── */
/* 注意：截断到 16 位是 llm.ts 里 sha256() 包装层做的事，这里比对完整摘要 */
function selfTestSha256(sha256js) {
  const cases = ["", "abc", "aftersales.decide_refund|{\"a\":1}", "中文与混合 mixed 文本 123", "x".repeat(1000), "🚀 emoji"];
  for (const c of cases) {
    const want = createHash("sha256").update(c, "utf8").digest("hex");
    const got = sha256js(c);
    if (want !== got) throw new Error(`sha256 自校验失败：${JSON.stringify(c.slice(0, 20))}\n  期望 ${want}\n  实得 ${got}`);
  }
}

/* ── 2. 模块拓扑序（import 关系已核对，无环）── */
/* 新增 src 模块时这里必须补 —— 清单是手写的，漏一个不会报错，
   只会让那个模块的导出在浏览器里变成「未定义」，而 import 语句已经被剥掉。 */
const MODULES = [
  "types.ts", "env.ts", "llm.ts", "tools.ts", "ingest.ts", "connectors.ts",
  "trace.ts", "memory.ts", "policy.ts",
  "context.ts", "prompt.ts", "classify.ts", "understand.ts", "judge.ts",
  "reviewer.ts", "auth.ts", "reply.ts", "gate.ts", "agent.ts",
];

/** 从原始源码里抓 import（stripTypeScriptTypes 只删 import type，值导入要先抓） */
function parseImports(raw) {
  const out = [];
  // 第 1 组捕获语句级 type 关键字：import type { ... } from "..." 整条都是类型，运行时不存在
  const re = /^[ \t]*import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["'];?[ \t]*$/gm;
  let m;
  while ((m = re.exec(raw))) {
    if (m[1]) continue; // 纯类型导入，跳过（stripTypeScriptTypes 也已把它从代码里删掉）
    // 每个说明符拆成 { imported, local }：
    //   · 行内 type 标记（import { a, type T }）整条丢掉
    //   · as 别名必须保留——agent.ts 里 classify 与 classify as classifyAuth 同名不同源，
    //     抹掉别名会直接变成重复声明
    const specs = m[2].split(",").map((s) => s.trim()).filter(Boolean)
      .filter((s) => !/^type\s+/.test(s))
      .map((s) => {
        const t = s.replace(/^type\s+/, "").trim();
        const asM = t.match(/^(\w+)\s+as\s+(\w+)$/);
        return asM ? { imported: asM[1], local: asM[2] } : { imported: t, local: t };
      })
      .filter((s) => /^\w+$/.test(s.imported) && /^\w+$/.test(s.local));
    if (specs.length) out.push({ specs, from: m[3] });
  }
  return out;
}

/** 抓 export 名，并把 export 关键字从声明上摘掉 */
function stripExports(code) {
  const names = [];
  // export function/class/const/let/var NAME
  code = code.replace(/^([ \t]*)export\s+(async\s+)?(function|class|const|let|var)\s+(\w+)/gm,
    (_all, indent, asyncKw, kw, name) => {
      names.push(name);
      return `${indent}${asyncKw || ""}${kw} ${name}`;
    });
  // export { a, b as c }
  code = code.replace(/^[ \t]*export\s*\{([^}]*)\};?[ \t]*$/gm, (_all, inner) => {
    for (const part of inner.split(",")) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.push((as[1] || as[0]).trim());
    }
    return "";
  });
  return { code, names };
}

/* ── 3. 组装 shim + 数据虚拟文件系统 ── */
/* 构建期校验用：shim 覆盖到的 node: 命名空间（必须和下面 SHIM 里的 __node 键一致） */
const SHIMMED_NS = ["fs", "path", "url", "crypto"];

const dataFiles = {};
for (const f of readdirSync(join(ROOT, "data"))) {
  if (f.endsWith(".json")) dataFiles[`/demo/data/${f}`] = JSON.parse(readFileSync(join(ROOT, "data", f), "utf8"));
}
dataFiles["/demo/samples/cases.json"] = JSON.parse(readFileSync(join(ROOT, "samples", "cases.json"), "utf8"));

/* 连接器声明的数据文件是 CSV —— 按原文放进虚拟文件系统（readFileSync 得回字符串，
   不能像 JSON 那样 stringify 一遍，否则连接器拿到的是一段带引号的 JSON 字面量）。 */
const dataText = {};
const MCP_DATA = join(ROOT, "mcp", "data");
if (existsSync(MCP_DATA)) {
  for (const f of readdirSync(MCP_DATA)) {
    dataText[`/demo/mcp/data/${f}`] = readFileSync(join(MCP_DATA, f), "utf8");
  }
}

const SHIM = `
/* ═══ 浏览器 shim：让 src/ 的 Node 代码原样跑在浏览器里 ═══ */
const VFS = ${JSON.stringify(dataFiles)};
const VFS_TEXT = ${JSON.stringify(dataText)};
globalThis.process = globalThis.process || { env: {}, platform: "browser" };

/* 写操作不落盘，但要把内容留下来——轨迹靠它回放，和 Node 版逐行同构 */
const __written = {};
function __norm(p) {
  const out = [];
  for (const seg of String(p).split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { out.pop(); continue; }
    out.push(seg);
  }
  return "/" + out.join("/");
}
const __node = {
  fs: {
    readFileSync(p) {
      const k = __norm(p);
      if (Object.prototype.hasOwnProperty.call(VFS_TEXT, k)) return VFS_TEXT[k];
      if (Object.prototype.hasOwnProperty.call(VFS, k)) return JSON.stringify(VFS[k]);
      if (Object.prototype.hasOwnProperty.call(__written, k)) return __written[k];
      throw new Error("单文件演示模式：虚拟文件系统里没有 " + k);
    },
    existsSync(p) {
      const k = __norm(p);
      return Object.prototype.hasOwnProperty.call(VFS, k)
        || Object.prototype.hasOwnProperty.call(VFS_TEXT, k)
        || Object.prototype.hasOwnProperty.call(__written, k);
    },
    mkdirSync() {},
    /* 必须认 flag:"a"——Trace 构造时写文件头，之后每次 append 都是追加。
       忽略这个标志会把前面全部覆盖掉，只剩最后一行。 */
    writeFileSync(p, data, opts) {
      const k = __norm(p);
      const s = String(data);
      const append = !!opts && (opts.flag === "a" || opts.flag === "a+");
      __written[k] = append ? (__written[k] || "") + s : s;
    },
    /* 轨迹改成缓冲批量写之后，append 走的是 appendFileSync ——
       垫片少这一个函数，单文件版会在第一次 flush 就崩（服务端版看不出来）。 */
    appendFileSync(p, data) {
      const k = __norm(p);
      __written[k] = (__written[k] || "") + String(data);
    },
    __written,
  },
  path: {
    join: (...a) => __norm(a.filter(Boolean).join("/")),
    resolve: (...a) => __norm(a.filter(Boolean).join("/")),
    dirname: (p) => { const s = __norm(p); return s.slice(0, s.lastIndexOf("/")) || "/"; },
  },
  url: { fileURLToPath: () => "/demo/src/env.ts" },
  crypto: {
    createHash() {
      let buf = "";
      return {
        update(s) { buf += typeof s === "string" ? s : String(s); return this; },
        digest() { return SHA256(buf).slice(0, 16); },
      };
    },
  },
};
`;

/* ── 4. 纯 JS SHA-256（node:crypto 在浏览器里没有，同步接口也不能换 async subtle）── */
const SHA256_SRC = `
function SHA256(msg) {
  const K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  const bytes = typeof msg === "string" ? new TextEncoder().encode(msg) : new Uint8Array(msg);
  const l = bytes.length;
  const padded = new Uint8Array(((((l + 8) >> 6) + 1) << 6));
  padded.set(bytes);
  padded[l] = 0x80;
  const bits = l * 8;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  dv.setUint32(padded.length - 4, bits >>> 0);
  let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
  const w = new Uint32Array(64);
  for (let i = 0; i < padded.length; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4);
    for (let j = 16; j < 64; j++) {
      const x = w[j-15], y = w[j-2];
      const s0 = ((x>>>7)|(x<<25)) ^ ((x>>>18)|(x<<14)) ^ (x>>>3);
      const s1 = ((y>>>17)|(y<<15)) ^ ((y>>>19)|(y<<13)) ^ (y>>>10);
      w[j] = (w[j-16] + s0 + w[j-7] + s1) >>> 0;
    }
    let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
    for (let j = 0; j < 64; j++) {
      const S1 = ((e>>>6)|(e<<26)) ^ ((e>>>11)|(e<<21)) ^ ((e>>>25)|(e<<7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[j] + w[j]) >>> 0;
      const S0 = ((a>>>2)|(a<<30)) ^ ((a>>>13)|(a<<19)) ^ ((a>>>22)|(a<<10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    h0=(h0+a)>>>0; h1=(h1+b)>>>0; h2=(h2+c)>>>0; h3=(h3+d)>>>0;
    h4=(h4+e)>>>0; h5=(h5+f)>>>0; h6=(h6+g)>>>0; h7=(h7+h)>>>0;
  }
  const hex = (x) => ("00000000" + (x >>> 0).toString(16)).slice(-8);
  return hex(h0)+hex(h1)+hex(h2)+hex(h3)+hex(h4)+hex(h5)+hex(h6)+hex(h7);
}
`;
/* 在构建进程里求值，拿它和 node:crypto 逐位比对——不一致就不许产出 */
const SHA256 = new Function(`${SHA256_SRC}\nreturn SHA256;`)();
selfTestSha256(SHA256);

/* ── 5. 逐模块打包 ── */
const __mods = {};
const parts = [];
for (const file of MODULES) {
  const raw = readFileSync(join(SRC, file), "utf8");
  const imports = parseImports(raw);
  const stripped = stripTypeScriptTypes(raw, { mode: "strip" });
  // import.meta.url 只在 ES module 里合法；file:// 下 module 脚本还可能被 CORS 拦。
  // 打包后没有 import/export 了，用经典脚本最稳，所以先把 import.meta.url 换成字面量。
  const noImportMeta = stripped.replace(/import\.meta\.url/g, '"file:///demo/src/env.ts"');
  // stripTypeScriptTypes 只删 import type，值导入会原样留着——这里自己删干净，
  // 依赖改由 prologue 里的 __req("x.ts") / __node.fs 提供。
  // 注意要支持多行 import（agent.ts 里有跨行的 import { ... } from "./x.ts"）。
  const noImports = noImportMeta
    .replace(/^[ \t]*import\s[\s\S]*?from\s*["'][^"']*["'];?[ \t]*$/gm, "")
    .replace(/^[ \t]*import\s*["'][^"']*["'];?[ \t]*$/gm, "");
  const { code, names } = stripExports(noImports);
  if (!names.length) continue; // types.ts 剥完只剩空壳

  const prologue = [];
  for (const imp of imports) {
    // 解构重命名：imported !== local 时写成 { imported: local }
    const pattern = imp.specs.map((s) => (s.imported === s.local ? s.imported : `${s.imported}: ${s.local}`)).join(", ");
    if (imp.from.startsWith("node:")) {
      const ns = imp.from.slice(5);
      if (!SHIMMED_NS.includes(ns)) throw new Error(`${file} 用了未 shim 的 Node 内置：${imp.from}`);
      prologue.push(`const { ${pattern} } = __node.${ns};`);
    } else if (imp.from.startsWith("./")) {
      const dep = imp.from.slice(2);
      prologue.push(`const { ${pattern} } = __req(${JSON.stringify(dep)});`);
    } else {
      throw new Error(`${file} 有意料之外的 import 来源：${imp.from}`);
    }
  }

  const key = file;
  parts.push(`/* ── ${file} ── */
__def(${JSON.stringify(key)}, () => {
${prologue.join("\n")}
${code}
;
return { ${names.join(", ")} };
});`);
}

/* ── 6. 引擎适配层：把 desktop/server.mjs 的 HTTP 语义原样搬到页内 ── */
const ENGINE = `
const __mods = {};
function __def(k, fn) { __mods[k] = fn(); }
function __req(k) {
  if (!__mods[k]) throw new Error("模块未定义或顺序错误：" + k);
  return __mods[k];
}
${SHA256_SRC}
${SHIM}
${parts.join("\n\n")}

/* ── 适配层：和 desktop/server.mjs 同一套 deps / 同一套 withTrace 语义 ── */
const { loadRegistry, loadStore, buildTools } = __req("tools.ts");
const { loadPolicy, loadSop } = __req("policy.ts");
const { runCase, runCaseDetailed } = __req("agent.ts");
const { checkExpectation, actualSummary } = __req("gate.ts");
const { ingestText, storeStats, DATASETS, DATASET_SPEC, datasetHeader, DATASET_SAMPLE } = __req("ingest.ts");
const { loadConnectors, pullFromFiles, listSources, buildConnectorViews } = __req("connectors.ts");

const reg = loadRegistry();
const store = loadStore();
const deps = { store, sop: loadSop(), policy: loadPolicy(), reg, tools: buildTools(reg, store) };
const samples = VFS["/demo/samples/cases.json"].rows;
const conns = loadConnectors();

/* 单文件版没有独立进程可连 MCP 服务端。不假装联通：如实标注通道，取数走同一份数据文件的本地通路
   —— 校验、合并、判定与本地服务模式完全一致，只有「谁去取数」不同。 */
const MCP_OFF = {
  ready: false,
  problem: "单文件演示模式不能拉起独立进程；取数走本地数据文件通路（同一份数据、同一处校验）",
  serverInfo: null,
  tools: [],
  // 没有进程可拉，就没有「重连」这回事 —— 界面据此不摆这个按钮，而不是摆了再失败
  can_reconnect: false,
  namespace: conns.namespace,
  timeoutMs: 0,
};
const connectorViews = () => buildConnectorViews(conns, storeStats(store), MCP_OFF);
const __inboundLog = [];

/* 待审批队列：单文件版全在页内，用内存 Map 承载续办句柄（与 server.mjs 语义一致） */
const __pending = new Map();

/* 人工跟进台账（与服务端同口径）：认领 / 记录 / 按补充事实重新处置 / 结单 */
const __followups = new Map();
const __FU_STATUS = { todo: "待跟进", doing: "跟进中", waiting: "等客户回复", closed: "已结单" };

/* withTrace：Node 版是读盘，这里读 shim 捕获的写入内容，行结构完全一致 */
function withTrace(result) {
  let lines = [];
  try {
    lines = __node.fs.readFileSync(result.trace_path).trim().split("\\n").map((l) => JSON.parse(l));
  } catch { /* 轨迹读取失败不影响主结果 */ }
  return { ...result, trace_lines: lines };
}

function decorate(payload, msgId) {
  const sample = samples.find((s) => s.msg_id === msgId) ?? null;
  if (sample) {
    payload.sample_id = sample.sample_id;
    payload.grade = sample.grade;
    payload.title = sample.title;
    payload.expected = sample.expect;
    payload.expect_errors = checkExpectation(sample, payload);
  }
  return payload;
}

const DEMO_NOTE = "单文件演示模式：只含离线规则引擎。模型模式需要 Node 服务端（node desktop/server.mjs）。";

window.__AFTERSALES_ENGINE__ = {
  note: DEMO_NOTE,
  call(path, body) {
    if (path === "/api/bootstrap") {
      return Promise.resolve({
        ok: true, node: "browser", port: 0, namespace: reg.namespace,
        mode: "offline", llm_problem: DEMO_NOTE,
        registry: { namespace: reg.namespace, tools: reg.tools },
        samples: samples.map((s) => ({
          sample_id: s.sample_id, grade: s.grade, msg_id: s.msg_id, title: s.title,
          display: s.display ?? s.title,
          text: store.messages.find((m) => m.msg_id === s.msg_id)?.text ?? "",
          expect: s.expect,
        })),
      });
    }
    if (path === "/api/run") {
      if (body && body.offline === false) {
        return Promise.reject(new Error("模型通道不可用：" + DEMO_NOTE));
      }
      let msgId = String((body && body.msgId) ?? "");
      if (!msgId && body && body.text) {
        msgId = "ADHOC-" + String(Date.now()).slice(-6);
        store.messages.push({ msg_id: msgId, text: String(body.text), known_order: null });
      }
      if (!msgId || !store.messages.some((m) => m.msg_id === msgId)) {
        return Promise.reject(new Error("缺少 msgId 或 text，或消息不存在"));
      }
      return runCaseDetailed(msgId, deps, {
        offline: true,
        autoApproveAsk: !body || body.autoApproveAsk !== false,
        disableReviewer: !!(body && body.disableReviewer),
        simulateStageViolation: !!(body && body.simulateStageViolation),
        deferApproval: !body || body.deferApproval !== false,
      }).then((outcome) => {
        let pending = null;
        if (outcome.status === "pending" && outcome.ticket && outcome.resume) {
          __pending.set(outcome.ticket.id, { ticket: outcome.ticket, resume: outcome.resume, msg_id: msgId });
          pending = outcome.ticket;
        }
        return { ok: true, result: decorate(withTrace(outcome.result), msgId), pending };
      });
    }
    if (path === "/api/approvals") {
      return Promise.resolve({ ok: true, items: Array.from(__pending.values()).map((x) => x.ticket) });
    }
    if (path === "/api/followups") {
      return Promise.resolve({
        ok: true,
        statuses: __FU_STATUS,
        items: Array.from(__followups.entries()).map(([key, v]) => Object.assign({ case_key: key }, v)),
      });
    }
    if (path === "/api/followup") {
      const key = String((body && body.case_key) || "").trim();
      const action = String((body && body.action) || "").trim();
      const by = String((body && body.by) || "").trim() || "未署名跟进人";
      const note = String((body && body.note) || "").trim();
      const target = String((body && body.target) || "").trim();
      const LABEL = {
        claim: "接手跟进",
        note: "记了一条跟进",
        wait: "已联系客户，等待客户补充",
        reassign: "转交跟进",
        rerun: "按补充事实重新处置",
        close: "核实完毕，结单",
      };
      if (!key) return Promise.reject(new Error("缺少 case_key"));
      if (!LABEL[action]) return Promise.reject(new Error("不认识的跟进动作：" + action));
      if (action === "note" && !note) return Promise.reject(new Error("跟进记录不能为空"));
      const cur = __followups.get(key) || { owner: "", status: "todo", log: [], case: null };
      if (body && body.case && typeof body.case === "object") cur.case = body.case;
      if (body && body.run_case && typeof body.run_case === "object") cur.run_case = body.run_case;
      cur.log.push({ at: new Date().toISOString(), by, action, label: LABEL[action], note, target });
      if (action === "claim" || action === "note" || action === "rerun" || action === "reassign") {
        if (action === "reassign" && target) cur.owner = target;
        else if (!cur.owner) cur.owner = by;
        if (cur.status === "todo" || cur.status === "waiting") cur.status = "doing";
        if (action === "reassign") cur.status = "doing";
      }
      if (action === "wait") { if (!cur.owner) cur.owner = by; cur.status = "waiting"; }
      if (action === "close") { if (!cur.owner) cur.owner = by; cur.status = "closed"; }
      __followups.set(key, cur);
      return Promise.resolve(Object.assign({ ok: true, case_key: key, status_text: __FU_STATUS[cur.status] }, cur));
    }
    if (path === "/api/config") {
      // 单文件版没有进程可以写回配置。如实标「不可编辑」，让界面收起表单 ——
      // 比在界面上摆一组填了也存不下去的输入框诚实。
      return Promise.resolve({
        ok: true, editable: false,
        usable: false, problem: DEMO_NOTE,
        reason: "单文件版只有一个离线规则引擎，没有可以写回配置的服务端进程。",
        env_file: "",
      });
    }
    if (path === "/api/config/test") {
      return Promise.reject(new Error("单文件版没有模型通道，无法测试连通：" + DEMO_NOTE));
    }
    if (path === "/api/connectors") {
      return Promise.resolve({
        ok: true,
        protocol: conns.protocol,
        namespace: conns.namespace,
        notice: conns.notice,
        server: conns.server,
        mcp: MCP_OFF,
        datasets: DATASETS.map((d) => ({
          dataset: d, label: DATASET_SPEC[d].label, rows: storeStats(store)[d],
          columns: datasetHeader(d), sample: DATASET_SAMPLE[d],
        })),
        stats: storeStats(store),
        connectors: connectorViews(),
      });
    }
    if (path === "/api/connectors/pull") {
      const want = String((body && body.id) || "").trim();
      const targets = !want || want === "*" ? conns.connectors : conns.connectors.filter((c) => c.id === want);
      if (!targets.length) return Promise.reject(new Error("没有这个数据源"));
      const pulled = [];
      for (const c of targets) {
        if (c.kind !== "mcp") continue;
        const reports = pullFromFiles(store, c);
        pulled.push({
          id: c.id, name: c.name, via: "file", reports,
          added: reports.reduce((n, r) => n + r.added, 0),
          updated: reports.reduce((n, r) => n + r.updated, 0),
          rejected: reports.reduce((n, r) => n + r.rejected, 0),
          errors: reports.reduce((a, r) => a.concat(r.errors), []),
        });
      }
      return Promise.resolve({ ok: true, pulled, stats: storeStats(store), connectors: connectorViews() });
    }
    if (path === "/api/mcp/reconnect") {
      // 界面上不摆这个按钮，但接口也不能沉默：万一有人直接调，得说清为什么做不到
      return Promise.reject(new Error("单文件演示模式没有独立进程可连，无法重连数据通道；取数请直接用本地文件通路"));
    }
    if (path === "/api/ingest") {
      const dataset = String((body && body.dataset) || "");
      if (DATASETS.indexOf(dataset) < 0) return Promise.reject(new Error("请选择要导入的数据表"));
      const report = ingestText(store, dataset, String((body && body.text) || ""));
      return Promise.resolve({ ok: true, report, stats: storeStats(store), connectors: connectorViews() });
    }
    if (path === "/api/inbound" && body === undefined) {
      return Promise.resolve({
        ok: true, connected: true, protocol: conns.protocol, notice: conns.notice,
        entries: __inboundLog.slice(-40).reverse().map((e, i) => (i < 8 ? e : { ...e, result: undefined })),
      });
    }
    if (path === "/api/inbound") {
      const text = String((body && body.text) || "").trim();
      if (!text) return Promise.reject(new Error("消息内容为空"));
      const from = String((body && body.from) || "").trim() || "微信客户";
      const channel = String((body && body.channel) || "").trim() || "微信小店";
      const at = new Date().toISOString();
      let msgId = String((body && body.msg_id) || "").trim();
      if (!msgId) {
        // 与 desktop/server.mjs 同口径：同一个人、同一个渠道、同一句话 = 同一条消息 → 判重
        const h = __node.crypto.createHash();
        h.update(from + "|" + channel + "|" + text);
        msgId = "WX-" + h.digest();
      }
      if (store.messages.some((m) => m.msg_id === msgId)) {
        __inboundLog.push({ msg_id: msgId, from, channel, text, at, status: "duplicate", note: "同一条消息已处理过，未重复执行" });
        return Promise.resolve({ ok: true, deduped: true, msg_id: msgId, from, channel, at, note: "该消息已处理过，未重复执行" });
      }
      store.messages.push({ msg_id: msgId, text, known_order: null });
      return runCaseDetailed(msgId, deps, { offline: true, autoApproveAsk: true, deferApproval: true }).then((outcome) => {
        let pending = null;
        if (outcome.status === "pending" && outcome.ticket && outcome.resume) {
          __pending.set(outcome.ticket.id, { ticket: outcome.ticket, resume: outcome.resume, msg_id: msgId });
          pending = outcome.ticket;
        }
        const payload = withTrace(outcome.result);
        payload.inbound = { msg_id: msgId, from, channel, at };
        __inboundLog.push({
          msg_id: msgId, from, channel, text, at,
          status: outcome.result.pending_approval ? "pending" : "handled",
          outcome: outcome.result.execution_outcome || "",
          result: payload,
        });
        return { ok: true, deduped: false, msg_id: msgId, from, channel, at, result: payload, pending };
      });
    }
    if (path === "/api/approve") {
      const id = String((body && body.id) ?? "");
      const entry = __pending.get(id);
      if (!entry) return Promise.reject(new Error("该审批单不存在或已处理"));
      const approved = !!(body && body.approved === true);
      const approver = String((body && body.approver) || "").trim() || "未署名审批人";
      const note = String((body && body.note) || "");
      // 先取出再删：避免续办抛错后重复执行同一笔处置
      __pending.delete(id);
      return entry.resume(approved, approver, note).then((result) => ({
        ok: true, approved, approver, note,
        result: decorate(withTrace(result), entry.msg_id),
        remaining: __pending.size,
      }));
    }
    if (path === "/api/gate") {
      if (body && body.offline === false) {
        return Promise.reject(new Error("模型通道不可用：" + DEMO_NOTE));
      }
      return Promise.all(samples.map((s) =>
        runCase(s.msg_id, deps, { offline: true, autoApproveAsk: true }).then((result) => {
          const payload = withTrace(result);
          payload.expect_errors = checkExpectation(s, result);
          return { sample_id: s.sample_id, grade: s.grade, actual: actualSummary(result), errors: payload.expect_errors, result: payload };
        })
      )).then((rows) => ({
        ok: true, total: rows.length,
        passed: rows.filter((r) => r.errors.length === 0).length,
        failed: rows.filter((r) => r.errors.length > 0).length,
        rows,
      }));
    }
    return Promise.reject(new Error("单文件演示模式不支持 " + path));
  },

  /* 流式：单文件版没有网络，但「过程事件」照样是真的 —— 引擎就在这个页面里跑，
     回调是同步发生的，不经过任何模拟。所以这里不是「假装流式」，
     而是把同一份 onEvent / signal 直接接上，界面因此只有一套逻辑。 */
  stream(path, body, handlers, opts) {
    if (path !== "/api/run/stream") {
      return Promise.reject(new Error("单文件演示模式不支持 " + path));
    }
    const h = handlers || {};
    const o = opts || {};
    if (body && body.offline === false) {
      return Promise.reject(new Error("模型通道不可用：" + DEMO_NOTE));
    }
    let msgId = String((body && body.msgId) ?? "");
    if (!msgId && body && body.text) {
      msgId = "ADHOC-" + String(Date.now()).slice(-6);
      store.messages.push({ msg_id: msgId, text: String(body.text), known_order: null });
    }
    if (!msgId || !store.messages.some((m) => m.msg_id === msgId)) {
      return Promise.reject(new Error("缺少 msgId 或 text，或消息不存在"));
    }
    if (h.onStart) h.onStart({ type: "start", msg_id: msgId, mode: "offline" });
    return runCaseDetailed(msgId, deps, {
      offline: true,
      autoApproveAsk: !body || body.autoApproveAsk !== false,
      deferApproval: !body || body.deferApproval !== false,
      signal: o.signal,
      onEvent: (line) => { if (h.onEvent) h.onEvent(line); },
    }).then((outcome) => {
      let pending = null;
      if (outcome.status === "pending" && outcome.ticket && outcome.resume) {
        __pending.set(outcome.ticket.id, { ticket: outcome.ticket, resume: outcome.resume, msg_id: msgId });
        pending = outcome.ticket;
      }
      return { type: "result", result: decorate(withTrace(outcome.result), msgId), pending };
    });
  },
};
`;

/* ── 7. 注入 UI：UI 仍是唯一真源，只打两个补丁 ── */
/* 产出前先编译一遍：new Function 只编译不执行，能在写盘前抓住语法错误
   （行内 type 标记漏清就会在这里炸，别等浏览器里才发现） */
try {
  new Function(ENGINE);
} catch (e) {
  throw new Error(`生成的引擎脚本有语法错误：${e.message}`);
}

let ui = readFileSync(join(ROOT, "desktop", "public", "index.html"), "utf8");

const SEAM = "  /* __DEMO_TRANSPORT__ */";
if (!ui.includes(SEAM)) throw new Error("UI 里找不到传输缝 __DEMO_TRANSPORT__，请先补上再构建");
ui = ui.replace(SEAM,
  "  if (window.__AFTERSALES_ENGINE__) return window.__AFTERSALES_ENGINE__.call(path, body);");

// 第二条缝：流式通道。单文件版没有网络，但过程事件是真的（引擎在同一页里跑），
// 所以这里接的是页内引擎的 stream()，界面代码一行都不用改。
const SEAM_STREAM = "  /* __DEMO_STREAM__ */";
if (!ui.includes(SEAM_STREAM)) throw new Error("UI 里找不到流式缝 __DEMO_STREAM__，请先补上再构建");
ui = ui.replace(SEAM_STREAM,
  "  if (window.__AFTERSALES_ENGINE__) return window.__AFTERSALES_ENGINE__.stream(path, body, handlers, opts);");

// 单文件模式没有模型通道。新界面上没有「模式单选项」——判定引擎由 bootstrap 的
// mode / llm_problem 驱动，单文件版会如实标成「内置规则判定」并附上原因。
// 这里只做一次存在性校验：构建出来的界面必须知道自己在用什么引擎。
if (!ui.includes('id="engineTag"')) throw new Error("UI 里找不到判定引擎标识（id=engineTag），单文件版会无法说明自己的判定方式");

// 顶部说明条：样式在 index.html 的 .demo-banner 里（不在此处注入 <style>，
// 避免两处样式漂移），这里只注入节点。grid-column:1/-1 让它横跨整个应用外壳。
ui = ui.replace('<div class="app">', `<div class="app">
<div class="demo-banner">
  <b>单文件演示版</b><span>零安装 · 双击即用 —— 贴一句客户原话即可跑完全程，数据均为合成数据</span>
  <span class="spacer"></span><span>智能模型判定需在本地服务模式运行</span>
</div>`);
if (!ui.includes("demo-banner")) throw new Error("演示横幅未注入（找不到 .app 容器）");

/* 引擎必须早于 UI 脚本就位：UI 的 <script> 是同步执行的，末尾直接调 boot()，
   第一跳 api() 在解析期就发生了。塞在 </body> 前会晚一步，只能走 fetch(file://) 失败。 */
ui = ui.replace("<body>", `<body>
<script>
/* 引擎启动失败必须留痕——静默不挂载会让 UI 退回 fetch(file://)，
   报一个看不懂的网络错误，把真正的原因埋掉 */
try {
${ENGINE}
} catch (e) {
  window.__ENGINE_ERROR__ = e;
  console.error("[单文件演示] 引擎启动失败：", e);
}
</script>`);

writeFileSync(OUT, ui, "utf8");

/* ── 8. 产出后自检：打包结果里不允许再出现模块语法 ── */
const forbidden = ui.split("\n")
  .map((line, i) => ({ line: line.trim(), n: i + 1 }))
  .filter((x) => /^import\s|^export\s|import\.meta/.test(x.line))
  .filter((x) => !x.line.startsWith("/*")); // 注释里的说明文字不算
if (forbidden.length) {
  throw new Error(`打包结果仍含模块语法 ${forbidden.length} 处，首行 ${forbidden[0].n}: ${forbidden[0].line.slice(0, 80)}`);
}
// 传输缝必须已被替换，且引擎必须挂载
if (ui.includes("__DEMO_TRANSPORT__")) throw new Error("传输缝未被替换");
if (ui.includes("__DEMO_STREAM__")) throw new Error("流式缝未被替换");
if (!ui.includes("window.__AFTERSALES_ENGINE__")) throw new Error("引擎未挂载");
// 页内引擎必须真的提供 stream —— 少了它，单文件版点「处理」会走 fetch(file://) 然后无声失败
if (!ui.includes("stream(path, body, handlers, opts)")) throw new Error("页内引擎没有 stream()，单文件版的过程事件会断");

const kb = (Buffer.byteLength(ui) / 1024).toFixed(1);
console.log(`✓ 已生成 ${OUT}（${kb} KB，单文件、零安装）`);
console.log(`  内联模块 ${parts.length} 个 / 数据文件 ${Object.keys(dataFiles).length} 个 / sha256 自校验通过 / 无模块语法残留`);
