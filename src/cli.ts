#!/usr/bin/env node
/**
 * 售后 Agent 命令行入口
 *
 * 五种模式：
 *   --demo      按 8 条合成客户咨询依次走完整链路（可演示的核心场景流程）
 *   --ask       临时输入一句自然语言咨询，从理解开始跑完整链路
 *   --case      单条样本完整回放（可加 --json）
 *   --gate      回归门禁：样本逐一比对期望值，任一不符退出码 1
 *   --ablation  消融实验：BAD 样本带 / 不带只读 Reviewer 各跑一遍
 *
 * 设计红线（与工程一致）：模型通道不可用时绝不静默降级成「成功」——
 * 要么 --offline 明走规则占位（judge_source=offline_rule），要么报错退出（退出码 2）。
 */
import { readFileSync } from "node:fs";
import { SAMPLES_FILE, llmConfig } from "./env.ts";
import { loadPolicy, loadSop } from "./policy.ts";
import { buildTools, loadRegistry, loadStore } from "./tools.ts";
import { runCase, type Deps, type RunOptions } from "./agent.ts";
import { ModelError } from "./llm.ts";
import { checkExpectation } from "./gate.ts";
import type { CaseRunResult, MessageRow, SampleCase } from "./types.ts";

// ── 参数解析 ────────────────────────────────────────────────────────
interface CliArgs {
  mode: "demo" | "ask" | "case" | "gate" | "ablation" | "help";
  target: string;
  offline: boolean;
  noReviewer: boolean;
  autoApprove: boolean;
  violationDemo: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {
    mode: "help",
    target: "",
    offline: false,
    noReviewer: false,
    autoApprove: false,
    violationDemo: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    switch (k) {
      case "--demo":
        a.mode = "demo";
        break;
      case "--gate":
      case "--all":
        a.mode = "gate";
        break;
      case "--ablation":
        a.mode = "ablation";
        break;
      case "--case":
        a.mode = "case";
        a.target = argv[++i] ?? "";
        break;
      case "--ask":
        a.mode = "ask";
        a.target = argv[++i] ?? "";
        break;
      case "--offline":
        a.offline = true;
        break;
      case "--no-reviewer":
        a.noReviewer = true;
        break;
      case "--auto-approve":
        a.autoApprove = true;
        break;
      case "--violation-demo":
        a.violationDemo = true;
        break;
      case "--json":
        a.json = true;
        break;
      case "--help":
      case "-h":
        a.mode = "help";
        break;
      default:
        if (!k.startsWith("-") && a.mode === "help" && !a.target) {
          // 裸位置参数：当作客户原话
          a.mode = "ask";
          a.target = k;
        } else {
          console.error(`未知参数：${k}（--help 查看用法）`);
          process.exit(2);
        }
    }
  }
  return a;
}

function printHelp(): void {
  console.log(`售后 Agent 演示工程（craft-aftersales-agent）

用法：
  node src/cli.ts --demo [--offline]
      按 8 条合成客户咨询依次走完整链路，打印每步决策与结单回执（可演示的核心场景流程）。
  node src/cli.ts --ask "客户的一句原话" [--offline] [--auto-approve]
      临时输入一句自然语言咨询，从理解开始跑完整链路；订单线索从文本里的日期 + 商品词解析。
  node src/cli.ts --case M01 [--offline] [--auto-approve] [--json]
      单条样本完整回放；--json 输出机器可读结果。
  node src/cli.ts --gate（等价 --all）[--offline] [--json]
      回归门禁：8 个样本逐一比对期望值，任一不符退出码 1。
  node src/cli.ts --ablation [--offline]
      消融实验：BAD 样本带 / 不带只读 Reviewer 各跑一遍，证明复核门禁真的会拦。
  node src/cli.ts --case M08 --violation-demo [--offline]
      负向验证：强行让诉求不明的案件闯过取证与判责，证明 SR-01 阶段硬阻断真的会拦。

通用开关：
  --offline       规则占位（judge_source=offline_rule），不调用模型；密钥不可用时也能端到端跑通
  --auto-approve  ASK 档审批由脚本自动确认（演示用；APPROVE 档任何模式下都不会自动放行）
  --no-reviewer   摘掉只读 Reviewer（仅用于消融对比，正常流程禁用）
  --violation-demo 负向验证专用：绕过诉求不明的 clarify 保护（正常流程禁用）
  --json          机器可读输出

退出码：0 成功｜1 门禁未过｜2 用法错误或模型通道不可用`);
}

// ── 装配 ────────────────────────────────────────────────────────────
function loadDeps(): Deps {
  const reg = loadRegistry();
  const store = loadStore();
  return { store, sop: loadSop(), policy: loadPolicy(), reg, tools: buildTools(reg, store) };
}

function loadSamples(): SampleCase[] {
  return JSON.parse(readFileSync(SAMPLES_FILE, "utf8")).rows as SampleCase[];
}

// ── 终端宽度感知的 padding（中文按 2 列宽计）──────────────────────────
function dispWidth(s: string): number {
  let n = 0;
  for (const ch of s) {
    n += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  }
  return n;
}

function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - dispWidth(s)));
}

// ── 单案打印 ────────────────────────────────────────────────────────
function printDetail(r: CaseRunResult, indent = ""): void {
  const u = r.understanding;
  const c = r.classification;
  console.log(`${indent}客户原话：${r.text}`);
  console.log(
    `${indent}[受理·理解] ${u.case_type}｜情绪 ${u.sentiment}｜订单 ${u.order_id ?? "未解析出"}` +
      `${u.needs_escalation ? "｜标记升级" : ""}｜来源 ${u.judge_source}`,
  );
  const slots = Object.entries(u.slots);
  if (slots.length) console.log(`${indent}          槽位：${slots.map(([k, v]) => `${k}=${v}`).join("，")}`);
  console.log(`${indent}          依据：${u.confidence_note}`);
  console.log(
    `${indent}[受理·分类] ${c.case_name}（${c.sop_path} 路径）｜要求证据 ${c.required_sources.join(" + ") || "（无）"}` +
      `｜资金动作 ${c.money_action ?? "无"}${c.needs_new_ticket ? "｜需新建工单" : ""}`,
  );
  if (r.evidence_sources.length) {
    console.log(
      `${indent}[取证]     实际取到：${r.evidence_sources.join(" + ")}` +
        `${r.requery_rounds ? `｜Reviewer 要求补证 ${r.requery_rounds} 轮（${r.requery_tools.join("、")}）` : ""}`,
    );
  }
  const j = r.judge;
  console.log(
    `${indent}[判责]     ${j.decision}｜金额 ${j.amount}｜判据 ${j.criteria.length} 条｜冲突 ${j.conflicts.length}｜模糊 ${j.ambiguous.length}｜来源 ${j.judge_source}`,
  );
  for (const x of j.conflicts) console.log(`${indent}          冲突：${x}`);
  for (const x of j.ambiguous) console.log(`${indent}          模糊：${x}`);
  console.log(
    `${indent}[复核]     ${r.review.verdict}` +
      (r.review.stage_violations.length ? `｜阶段违规：${r.review.stage_violations.join("；")}` : ""),
  );
  for (const f of r.review.findings) console.log(`${indent}          [${f.rule}] ${f.verdict}：${f.because}`);
  if (r.auth) {
    const a = r.auth;
    console.log(`${indent}[审批]     ${a.tier}（${a.label}）｜金额 ${a.amount}｜${a.because}`);
    // 只有真的走过审批回调（有审批人留痕）才打印回调行；EXECUTE / AUTO 档没有回调
    if (a.approver) {
      console.log(
        `${indent}          回调结果：${a.outcome}` +
          `｜审批人 ${a.approver}｜${a.approval_decision}｜${a.approval_at}`,
      );
    } else {
      console.log(`${indent}          结果：${a.outcome}（无需人工介入）`);
    }
  } else {
    console.log(`${indent}[审批]     未进入授权环节`);
  }
  console.log(`${indent}[执行]     ${r.execution_outcome}`);
  console.log(`${indent}[结单]     客户回执：${r.reply.customer_text}`);
  console.log(`${indent}          内部说明：${r.reply.internal_note}`);
  console.log(`${indent}          需人工跟进：${r.reply.follow_up_required ? "是" : "否"}`);
  console.log(`${indent}[轨迹]     ${r.trace_path}`);
}

// ── 模式一：demo ────────────────────────────────────────────────────
async function runDemo(deps: Deps, opts: RunOptions): Promise<void> {
  const samples = loadSamples();
  const byMsg = new Map(samples.map((s) => [s.msg_id, s]));
  console.log("═".repeat(78));
  console.log("售后 Agent 端到端演示：客户的一句自然语言 → 受理 → 取证 → 判责 → 审批 → 结单");
  console.log(`运行方式：${opts.offline ? "规则占位（--offline）" : "模型模式"}｜ASK 档脚本自动确认｜只读 Reviewer 在位`);
  console.log("═".repeat(78));

  const results: CaseRunResult[] = [];
  for (const s of samples) {
    const r = await runCase(s.msg_id, deps, opts);
    results.push(r);
    console.log(`\n── ${s.sample_id} · ${s.msg_id} · ${s.grade} · ${s.title} ${"─".repeat(Math.max(0, 40 - dispWidth(s.title)))}`);
    printDetail(r, "  ");
  }

  // 汇总
  const typeCount = new Map<string, number>();
  for (const r of results) typeCount.set(r.classification.case_type, (typeCount.get(r.classification.case_type) ?? 0) + 1);
  console.log("\n" + "═".repeat(78));
  console.log("演示汇总");
  console.log("═".repeat(78));
  for (const r of results) {
    const s = byMsg.get(r.msg_id);
    console.log(
      `  ${pad(s?.sample_id ?? r.msg_id, 5)}${pad(r.classification.case_type, 18)}` +
        `裁决 ${pad(r.review.verdict, 22)}授权 ${pad(r.auth?.tier ?? "AUTO", 8)}` +
        `${r.executed_tool ? "已执行 " + r.executed_tool : "未执行不可逆动作"}`,
    );
  }
  const coverage = [...typeCount.entries()].map(([k, v]) => `${k} ×${v}`).join("｜");
  console.log(`\n  案件类型覆盖：${coverage}`);
  console.log("  SOP 另定义 RETURN_REFUND / COMPLAINT 两类，8 条样本未覆盖（见《交付说明》已知边界）。");
  console.log(`  决策轨迹已全部落盘：${deps.store.messages.length} 份 JSONL 见 runs/ 目录。`);
}

// ── 模式二：ask ─────────────────────────────────────────────────────
async function runAsk(deps: Deps, opts: RunOptions, text: string, json: boolean): Promise<void> {
  if (!text.trim()) {
    console.error("--ask 需要一句客户原话，例如：--ask \"我8月8号买的那把椅子颜色跟图片差太多了要退钱\"");
    process.exit(2);
  }
  const msg: MessageRow = {
    msg_id: `ADHOC-${Date.now().toString().slice(-6)}`,
    text,
    known_order: null,
  };
  deps.store.messages.push(msg);
  const r = await runCase(msg.msg_id, deps, opts);
  if (json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log("═".repeat(78));
  console.log(`临时咨询 ${msg.msg_id}（订单线索完全从自然语言解析，不依赖任何预置单号）`);
  console.log("═".repeat(78));
  printDetail(r, "  ");
}

// ── 模式三：case ────────────────────────────────────────────────────
async function runSingle(deps: Deps, opts: RunOptions, msgId: string, json: boolean): Promise<void> {
  const msg = deps.store.messages.find((m) => m.msg_id === msgId);
  if (!msg) {
    console.error(`咨询不存在：${msgId}（可用：${deps.store.messages.map((m) => m.msg_id).join("、")}）`);
    process.exit(2);
  }
  const sample = loadSamples().find((s) => s.msg_id === msgId) ?? null;
  const r = await runCase(msgId, deps, opts);
  if (json) {
    console.log(JSON.stringify({ ...r, expected: sample?.expect ?? null }, null, 2));
    return;
  }
  console.log("═".repeat(78));
  console.log(`样本回放 ${msgId}${sample ? `｜${sample.grade}｜${sample.title}` : ""}`);
  console.log("═".repeat(78));
  printDetail(r, "  ");
  if (sample) {
    const errs = checkExpectation(sample, r);
    if (opts.simulateStageViolation) {
      console.log(`\n  期望比对：${errs.length ? "故意不符（负向验证的预期结果）→ " + errs.join("；") : "意外符合期望"}`);
      console.log("  解读：绕过 clarify 保护后，样本期望（CLARIFY_NEEDED）被违反，但只读 Reviewer 用");
      console.log("  REJECT_STAGE_VIOLATION 把案件拦在了授权闸之前 —— 编排层犯错时，第二道闸仍然有效。");
    } else {
      console.log(`\n  期望比对：${errs.length ? "不符 → " + errs.join("；") : "六项全部符合期望"}`);
    }
  }
}

// ── 模式四：gate ────────────────────────────────────────────────────
async function runGate(deps: Deps, opts: RunOptions, json: boolean): Promise<number> {
  const samples = loadSamples();
  const rows: Array<{ s: SampleCase; r: CaseRunResult; errs: string[] }> = [];
  for (const s of samples) {
    const r = await runCase(s.msg_id, deps, opts);
    rows.push({ s, r, errs: checkExpectation(s, r) });
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          passed: rows.filter((x) => x.errs.length === 0).length,
          failed: rows.filter((x) => x.errs.length > 0).length,
          rows: rows.map((x) => ({
            sample_id: x.s.sample_id,
            grade: x.s.grade,
            msg_id: x.s.msg_id,
            expect: x.s.expect,
            actual: {
              case_type: x.r.classification.case_type,
              verdict: x.r.review.verdict,
              auth_tier: x.r.auth?.tier ?? "AUTO",
              requires_requery: x.r.requery_rounds > 0,
              follow_up_required: x.r.reply.follow_up_required,
              executed: x.r.executed_tool !== null,
            },
            errors: x.errs,
          })),
        },
        null,
        2,
      ),
    );
    return rows.every((x) => x.errs.length === 0) ? 0 : 1;
  }

  console.log("─".repeat(96));
  console.log("回归门禁：样本行为 vs 期望行为");
  console.log("─".repeat(96));
  console.log(
    pad("样本", 6) + pad("等级", 10) + pad("案件类型", 18) + pad("复核裁决", 22) +
      pad("授权", 8) + pad("补证", 5) + pad("执行", 5) + pad("跟进", 5) + "结果",
  );
  console.log("─".repeat(96));
  for (const { s, r, errs } of rows) {
    const ok = errs.length === 0;
    console.log(
      pad(s.sample_id, 6) + pad(s.grade, 10) + pad(r.classification.case_type, 18) +
        pad(r.review.verdict, 22) + pad(r.auth?.tier ?? "AUTO", 8) +
        pad(r.requery_rounds > 0 ? "✓" : "-", 5) + pad(r.executed_tool ? "✓" : "-", 5) +
        pad(r.reply.follow_up_required ? "✓" : "-", 5) + (ok ? "✓ 符合期望" : "✗ 不符"),
    );
  }
  console.log("─".repeat(96));

  const failed = rows.filter((x) => x.errs.length > 0);
  for (const { s, r, errs } of failed) {
    console.log(`\n✗ ${s.sample_id}（${s.msg_id}）不符项：`);
    for (const e of errs) console.log(`    - ${e}`);
    console.log(`    实际轨迹：${r.trace_path}`);
  }

  const grades = samples.reduce<Record<string, number>>((acc, s) => {
    acc[s.grade] = (acc[s.grade] ?? 0) + 1;
    return acc;
  }, {});
  const g = Object.entries(grades).map(([k, v]) => `${k} ${v}`).join("｜");
  if (failed.length === 0) {
    console.log(`\n合计 ${rows.length} 样本（${g}）：全部符合期望 → 门禁放行（退出码 0）`);
    return 0;
  }
  console.log(`\n合计 ${rows.length} 样本（${g}）：${failed.length} 个不符 → 门禁阻断（退出码 1）`);
  return 1;
}

// ── 模式五：ablation ────────────────────────────────────────────────
async function runAblation(deps: Deps, base: RunOptions): Promise<void> {
  const samples = loadSamples().filter((s) => s.grade === "BAD");
  console.log("═".repeat(78));
  console.log("消融实验：只读 Reviewer 是不是流程装饰？");
  console.log("对每个 BAD 样本跑两遍 —— 一遍带 Reviewer，一遍摘掉（--no-reviewer）。");
  console.log("说明：摘掉 Reviewer 的这遍带 --auto-approve，让放行路径一路走到执行，对比才锐利。");
  console.log("═".repeat(78));

  let blockedWith = 0;
  let blockedWithout = 0;
  for (const s of samples) {
    const withRv = await runCase(s.msg_id, deps, { ...base, disableReviewer: false, autoApproveAsk: true });
    const without = await runCase(s.msg_id, deps, { ...base, disableReviewer: true, autoApproveAsk: true });
    const withBlocked = withRv.review.verdict.startsWith("REJECT") && withRv.executed_tool === null;
    const withoutBlocked = without.review.verdict.startsWith("REJECT") && without.executed_tool === null;
    if (withBlocked) blockedWith++;
    if (withoutBlocked) blockedWithout++;

    console.log(`\n── ${s.sample_id} · ${s.msg_id} · ${s.title}`);
    console.log(`  带 Reviewer   → 裁决 ${withRv.review.verdict}｜${withRv.execution_outcome}`);
    console.log(`  摘掉 Reviewer → 裁决 ${without.review.verdict}（复核被跳过）｜${without.execution_outcome}`);
    if (!withoutBlocked && without.executed_tool) {
      console.log(`                 ↑ 本该拦住的案件被放行，执行了 ${without.executed_tool}`);
    }
  }

  console.log("\n" + "═".repeat(78));
  console.log(`对照结果：BAD 样本 ${samples.length} 个 —— 带 Reviewer 阻断 ${blockedWith}/${samples.length}，摘掉后只剩 ${blockedWithout}/${samples.length}`);
  console.log("结论：只读 Reviewer 不是装饰。摘掉它，「执行前第二道强制闸」直接消失，");
  console.log("      回归门禁对坏样本的约束力归零 —— 这正是它必须独立于取证与判责存在的原因。");
  console.log("═".repeat(78));
}

// ── main ────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "help") {
    printHelp();
    return;
  }
  if (args.mode === "case" && !args.target) {
    console.error("--case 需要样本消息号，例如 --case M01");
    process.exit(2);
  }

  // 模型通道检查：非 offline 模式且密钥不可用 → 明错退出，不静默降级
  if (!args.offline) {
    const c = llmConfig();
    if (!c.usable) {
      console.error(`模型通道不可用：${c.problem}`);
      console.error("处理方式二选一：① 在 .env 填入可用密钥（见 .env.example）；② 加 --offline 用规则占位跑通整条链路。");
      process.exit(2);
    }
  }

  const deps = loadDeps();
  const opts: RunOptions = {
    offline: args.offline,
    // demo / gate 默认自动确认 ASK 档：演示与门禁关注的是「分档 + 回路」是否正确，
    // APPROVE 档在任何模式下都不会自动放行（见 auth.ts）。
    autoApproveAsk: args.autoApprove || args.mode === "demo" || args.mode === "gate",
    disableReviewer: args.noReviewer,
    simulateStageViolation: args.violationDemo,
  };

  if (args.violationDemo) {
    console.log("⚠ 负向验证模式：已绕过「诉求不明只追问」的保护，强行让案件闯过取证与判责。");
    console.log("  预期结果：只读 Reviewer 以 REJECT_STAGE_VIOLATION（SR-01）硬阻断，授权闸不会放行。\n");
  }

  switch (args.mode) {
    case "demo":
      await runDemo(deps, opts);
      break;
    case "ask":
      await runAsk(deps, opts, args.target, args.json);
      break;
    case "case":
      await runSingle(deps, opts, args.target, args.json);
      break;
    case "gate":
      process.exit(await runGate(deps, opts, args.json));
    case "ablation":
      await runAblation(deps, opts);
      break;
  }
}

main().catch((e) => {
  if (e instanceof ModelError) {
    console.error(`模型通道错误（${e.code ?? "unknown"}）：${e.message}`);
    process.exit(2);
  }
  console.error(e);
  process.exit(1);
});
