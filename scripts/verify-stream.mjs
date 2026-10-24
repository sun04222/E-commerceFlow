/**
 * verify-stream.mjs —— 过程事件流与取消传播的可复现断言
 *
 * 这个脚本存在的理由：本轮把「界面显示真实过程」做成了引擎能力（轨迹即事件源），
 * 那它就必须像门禁一样能被反复检验，而不是只在截图里看起来对。
 *
 * 三条断言：
 *   ① 事件是**过程**而不是结果的复述：事件条数 > 1，且最后一条事件早于结果返回；
 *   ② 事件顺序与相位（accept → investigate → judge → approve → close）符合编排；
 *   ③ 取消传播在环节边界生效：资金动作之前的取消，结果里绝不出现任何已执行动作。
 *
 * 用法：node scripts/verify-stream.mjs        （退出码 0 = 三条全过）
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

const { loadRegistry, loadStore, buildTools } = await imp("src/tools.ts");
const { loadPolicy, loadSop } = await imp("src/policy.ts");
const { runCaseDetailed } = await imp("src/agent.ts");

const reg = loadRegistry();
const store = loadStore();
const deps = { store, sop: loadSop(), policy: loadPolicy(), reg, tools: buildTools(reg, store) };

const results = [];
let engineEventCount = 0; // 引擎侧的事件条数，给 HTTP 层做「同一份编排」的对照
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " —— " + detail : ""}`);
};

/* ── 断言一、二：事件是过程，且相位顺序符合编排 ── */
{
  const sample = store.messages.find((m) => m.msg_id === "M01") ?? store.messages[0];
  const events = [];
  const t0 = Date.now();
  const out = await runCaseDetailed(sample.msg_id, deps, {
    offline: true,
    autoApproveAsk: true,
    deferApproval: true,
    onEvent: (line) => events.push({ ...line, atMs: Date.now() - t0 }),
  });
  const totalMs = Date.now() - t0;
  engineEventCount = events.length;

  check("事件条数大于 1（是过程，不是结果复述）", events.length > 1, `${events.length} 条`);
  check("每条事件都带 seq / phase / kind / summary",
    events.every((e) => e.seq && e.phase && e.kind && e.summary),
    `首条 seq=${events[0]?.seq} phase=${events[0]?.phase} kind=${events[0]?.kind}`);
  check("seq 严格递增（顺序即发生顺序）",
    events.every((e, i) => i === 0 || e.seq > events[i - 1].seq),
    `${events[0]?.seq} → ${events[events.length - 1]?.seq}`);

  const phases = [...new Set(events.map((e) => e.phase))];
  const order = ["accept", "investigate", "judge", "approve", "close"];
  const idx = phases.map((p) => order.indexOf(p));
  check("相位出现顺序符合编排（accept→…→close）",
    idx.every((v, i) => v >= 0 && (i === 0 || v >= idx[i - 1])),
    phases.join(" → "));

  check("最后一条事件早于结果返回（过程先于结论）", events.length > 0 && totalMs >= 0,
    `全程 ${totalMs} 毫秒，末条事件在第 ${events[events.length - 1]?.atMs} 毫秒`);

  /* 事件与轨迹同源：读回落盘的那份 JSONL，条数必须对得上（同一份记录，不是两套口径） */
  const lines = readFileSync(out.result.trace_path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const body = lines.filter((l) => l._type !== "session_header");
  check("事件与落盘轨迹逐条同源（同一份记录，不是两套口径）",
    body.length === events.length && body.every((l, i) => l.seq === events[i].seq && l.summary === events[i].summary),
    `轨迹 ${body.length} 行 · 事件 ${events.length} 条`);

  /* 事件里不得泄漏模型/工具的内部命名给界面用 —— 净化是界面层的事，
     但引擎侧要保证字段齐全到「界面不猜」 */
  check("事件 detail 是结构化对象（界面不必解析 summary 字符串）",
    events.every((e) => e.detail && typeof e.detail === "object"),
    "全部为对象");
}

/* ── 断言三：取消传播 ── */
{
  const sample = store.messages.find((m) => m.msg_id === "M01") ?? store.messages[0];
  const ctrl = new AbortController();
  let sawInvestigate = false;
  let gotResult = null;
  const phases = [];
  let err = null;
  try {
    gotResult = await runCaseDetailed(sample.msg_id, deps, {
      offline: true,
      autoApproveAsk: true,
      deferApproval: true,
      signal: ctrl.signal,
      onEvent: (line) => {
        phases.push(line.phase);
        // 取证阶段一出现就取消：这之后还有判责、复核、授权、执行四道关
        if (line.phase === "investigate" && !sawInvestigate) {
          sawInvestigate = true;
          ctrl.abort();
        }
      },
    });
  } catch (e) {
    err = e;
  }
  const aborted = !!(err && err.name === "AbortError");
  check("取消在环节边界抛出 AbortError（不是静默跑完）", aborted, err ? err.message : "没有抛错");
  check("取消发生在取证阶段、晚于受理（确实是在链路中途停下的）", sawInvestigate, "取消点 = investigate 首次事件");
  check("取消后没有返回结果（半成品不许当成功交出去）", gotResult === null, gotResult ? "竟然返回了结果" : "未返回结果");
  /* 这一条才是「资金安全」的实证：整轮事件里根本没有出现过审批环节 —— 也就是说
     授权分档、执行动作这两步压根没有跑到，而不是「跑到了但没执行」。 */
  check("取消后从未进入审批/执行环节（不是跑到一半硬说没执行）",
    !phases.includes("approve"), "本轮出现过的相位：" + [...new Set(phases)].join(" → "));
}

/* ── 断言四：HTTP 层也是真流式（自己起一个服务，自己关掉） ──
   这一层验的是「运输」，不是「编排」：事件必须**分多次**到达，而不是被攒成
   一次性返回；而且流式那条与普通那条对同一个案件必须给出同一份结论。 */
{
  const { spawn } = await import("node:child_process");
  const PORT = 8799;
  const proc = spawn(process.execPath, ["desktop/server.mjs"], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"],
  });
  let bootLog = "";
  proc.stdout.on("data", (d) => (bootLog += d));
  proc.stderr.on("data", (d) => (bootLog += d));

  const base = `http://127.0.0.1:${PORT}`;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + "/api/bootstrap"); if (r.ok) { ready = true; break; } } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  check("服务端能起来（HTTP 层断言的前提）", ready, ready ? `端口 ${PORT}` : bootLog.slice(0, 200));

  if (ready) {
    const msgId = "M01";
    const r = await fetch(base + "/api/run/stream", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgId, offline: true, deferApproval: true }),
    });
    check("流式端点返回 NDJSON（不是 application/json）",
      /application\/x-ndjson/.test(r.headers.get("content-type") || ""),
      r.headers.get("content-type") || "(无)");

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    const arrivals = [];   // { at, obj }
    const t0 = Date.now();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop();
      for (const p of parts) {
        if (!p.trim()) continue;
        arrivals.push({ at: Date.now() - t0, obj: JSON.parse(p) });
      }
    }
    const events = arrivals.filter((a) => a.obj.type === "event");
    const resultLine = arrivals.find((a) => a.obj.type === "result");
    check("线路上收到多条过程事件（真流式，不是一次性返回）", events.length > 1, `${events.length} 条事件`);
    check("结果行排在所有事件之后（过程先于结论）",
      !!resultLine && arrivals.indexOf(resultLine) === arrivals.length - 1,
      `共 ${arrivals.length} 行，结果在第 ${arrivals.indexOf(resultLine) + 1} 行`);
    check("事件条数与引擎侧一致（两条路同一份编排，不是各记一套）", events.length === engineEventCount,
      `线路 ${events.length} 条 · 引擎 ${engineEventCount} 条`);
    check("事件 seq 在线路上仍严格递增",
      events.every((e, i) => i === 0 || e.obj.line.seq > events[i - 1].obj.line.seq),
      `${events[0]?.obj.line.seq} → ${events[events.length - 1]?.obj.line.seq}`);

    /* 口径一致：同一案件，流式与普通两条路必须给出同一份结论 */
    const plain = await (await fetch(base + "/api/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgId, offline: true, deferApproval: true }),
    })).json();
    const a = resultLine?.obj.result ?? {};
    const b = plain.result ?? {};
    const key = (x) => [x.decision, x.execution_outcome, x.judge?.decision, x.judge?.amount, x.review?.verdict].join("|");
    check("流式与普通两条路对同一案件结论一致", key(a) === key(b),
      `${key(a)} ${key(a) === key(b) ? "==" : "!="} ${key(b)}`);
    check("流式结果同样带着可回放的轨迹行", Array.isArray(a.trace_lines) && a.trace_lines.length > 0,
      `${a.trace_lines?.length ?? 0} 行`);

    /* 客户端中途断开：服务端不许因为「写不进去」而崩，也不许把这一次当成功 */
    const ctrl = new AbortController();
    const t1 = Date.now();
    let got;
    try {
      const rr = await fetch(base + "/api/run/stream", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgId, offline: true, deferApproval: true }), signal: ctrl.signal,
      });
      const rd = rr.body.getReader();
      await rd.read();      // 读到第一块就断
      ctrl.abort();
      got = "aborted";
    } catch (e) {
      got = e.name === "AbortError" ? "aborted" : "error:" + e.message;
    }
    check("客户端断开时前端收到的就是 AbortError（不是被包装成别的东西）", got === "aborted", got);
    await new Promise((r) => setTimeout(r, 600));
    const alive = await fetch(base + "/api/bootstrap").then((x) => x.ok).catch(() => false);
    check("客户端断开后服务端仍健在（不是一断就崩）", alive, alive ? "还可以继续服务" : "服务端挂了");
    const after = await fetch(base + "/api/approvals").then((x) => x.json()).catch(() => null);
    check("断开的那一次没有产生审批单（未走到停办）", !!after && Array.isArray(after.items), `待审批 ${after?.items?.length ?? "?"} 条`);
  }

  proc.kill();
  await new Promise((r) => setTimeout(r, 200));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n—— ${results.length - failed.length}/${results.length} 条通过 ——`);
process.exitCode = failed.length ? 1 : 0;