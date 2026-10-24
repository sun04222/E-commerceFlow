import { resolve } from "node:path";
import { callModel, extractJson, ModelError } from "./llm.ts";
import { buildJudgePrompt } from "./prompt.ts";
import { classify } from "./classify.ts";
import { understand } from "./understand.ts";
import { judgeOffline } from "./judge.ts";
import { review } from "./reviewer.ts";
import { replyOffline, replyWithModel } from "./reply.ts";
import { classify as classifyAuth, requestApproval, type ApprovalResolver, type AuthDecision } from "./auth.ts";
import { buildContext, disclosureStats } from "./context.ts";
import { Trace, type RunEventListener } from "./trace.ts";
import { retrieveCases, renderMemoryBlock } from "./memory.ts";
import {
  assemble,
  buildTools,
  invoke,
  type Policy,
  type Sop,
  type Store,
  type ToolRegistry,
  type ToolSpec,
} from "./tools.ts";
import type {
  CaseRunResult,
  CaseType,
  Classification,
  Judgment,
  MemoryHit,
  MessageRow,
  PendingApproval,
  Phase,
  ReviewResult,
  RunBudgetReport,
  SampleGrade,
  SourceName,
} from "./types.ts";

export interface Deps {
  store: Store;
  sop: Sop;
  policy: Policy;
  reg: ToolRegistry;
  tools: ToolSpec[];
}

export interface RunOptions {
  offline: boolean;
  autoApproveAsk: boolean;
  approvalResolver?: ApprovalResolver;
  /** 消融开关：拆掉只读 Reviewer，用于证明回归门禁真的会拦 */
  disableReviewer?: boolean;
  /**
   * 负向验证开关：模拟「编排层违规」——诉求不明时不走 clarify 分支，强行往下走完整链路。
   * 只用于 --violation-demo 证明 SR-01 阶段硬阻断真的会拦，正常流程严禁打开。
   */
  simulateStageViolation?: boolean;
  /**
   * 自主模式的「停办转审批」：遇到超出 Agent 自动处置范围的大额动作时不就地等待，
   * 而是把这一次的参数冻结成一张待审批单交回宿主（审批中心），由真人裁决后调用
   * resume 续办——批准则执行并结单，驳回则按未执行收口并结单。
   *
   * 不开这个开关（命令行 / 门禁）时行为与之前完全一致：APPROVE 档一律挂起、绝不自动执行。
   */
  deferApproval?: boolean;
  /**
   * 执行预算：给一次会话封顶，别让它无限跑。
   *
   * 为什么需要：补证回路是「Reviewer 提补查 → 取证方照单补 → 再判再审」，
   * 天然可能套娃；模型调用与工具调用也可能被上游反复触达。
   * 没有上限的 Agent 不是自主，是不可控。
   *
   * 两条边界刻意写死：
   *   · 预算耗尽**不改变判定口径**，只把「该调模型的地方」降级为规则判定，并在结果里
   *     用 degraded 如实标出（judge_source 同时会变成 offline_rule，界面上本来就显示）；
   *   · 授权与资金动作完全不受预算影响 —— 预算不参与 auth 分档，绝不因为"省钱"就自动放行。
   */
  budget?: {
    max_model_calls?: number;
    max_tool_calls?: number;
    max_requery_rounds?: number;
  };
  /**
   * 过程事件出口：轨迹每落一行，同步回调一次。
   *
   * 这是「界面能不能显示真实过程」的那半边。没有它，20–30 秒的模型链路里
   * 宿主只知道「还没回来」，界面上只能显示一个转圈 —— 要么编一个假进度条，
   * 要么承认看不见。有了它，界面显示的就是引擎自己的审计轨迹，逐条对得上。
   */
  onEvent?: RunEventListener;
  /**
   * 取消传播：宿主（比如浏览器标签页被关掉、用户点了取消）可以在这里说停。
   *
   * 语义刻意定死在「环节边界」：下一个环节开始前检查一次，已发生的处置不回滚
   * （也不假装能回滚），尚未发生的动作 —— 尤其是资金动作 —— 一定不会发生。
   */
  signal?: AbortSignal;
}

/** 停办转审批时交回宿主的续办句柄（仅存在于同一进程内，不落盘、不跨进程） */
export interface RunOutcome {
  status: "completed" | "pending";
  result: CaseRunResult;
  ticket?: PendingApproval;
  /** 仅 status === "pending" 时存在：由审批中心裁决后调用，接着把这次会话跑完 */
  resume?: (approved: boolean, approver: string, note: string) => Promise<CaseRunResult>;
}

/**
 * 首轮取证计划：取「SOP 要求的来源」与「三源保守集」的交集。
 * 刻意保守 —— 给只读 Reviewer 的「驳回并要求补证」留下真实可拦的对象。
 * 真实场景里首轮计划可由模型产出，机制不变：取证是否完整不由取证者自己说了算。
 */
const CONSERVATIVE: SourceName[] = ["orders", "refunds", "logistics"];

export async function runCase(msgId: string, deps: Deps, opts: RunOptions): Promise<CaseRunResult> {
  return (await runCaseDetailed(msgId, deps, opts)).result;
}

/**
 * 全链路编排（含「停办 → 审批 → 续办」）。
 *
 * runCase 只是它的薄封装：命令行、门禁、消融只关心「一次跑完」的结果，
 * 不需要知道停办与续办的存在。桌面端则用 runCaseDetailed 拿到 ticket 与 resume，
 * 才能把「大额停办」做成审批中心里真实可点的闭环。
 */
export async function runCaseDetailed(msgId: string, deps: Deps, opts: RunOptions): Promise<RunOutcome> {
  const { store, sop, policy, reg, tools } = deps;
  const msg = store.messages.find((m) => m.msg_id === msgId);
  if (!msg) throw new Error(`咨询不存在：${msgId}`);

  const trace = new Trace(
    msgId,
    {
      judge_mode: opts.offline ? "offline_rule" : "model",
      namespace: reg.namespace,
      conservative_first_round: CONSERVATIVE,
      sop_stages: sop.stages.map((s) => s.id),
    },
    opts.onEvent,
    () => {
      // 取消只发生在环节边界上：调用点都写 trace.checkpoint()，一眼能数清有几处
      if (opts.signal && opts.signal.aborted) {
        const err = new Error("已取消：在环节边界停下，未执行资金处置");
        err.name = "AbortError";
        throw err;
      }
    },
  );

  const stages: Phase[] = [];

  // ── 执行预算：只统计、只降级，不参与判定 ────────────────────────
  // 上限的默认值按「现有最大案件的两倍」给：先别误伤正常案件，
  // 跑满 8 样本 + 消融之后再决定要不要收紧。
  const budget: RunBudgetReport = {
    model_calls: 0,
    model_limit: opts.budget?.max_model_calls ?? 8,
    tool_calls: 0,
    tool_limit: opts.budget?.max_tool_calls ?? 24,
    requery_rounds: 0,
    requery_limit: opts.budget?.max_requery_rounds ?? 2,
    degraded: [],
  };

  /** 还能不能再叫一次模型？不能就记一笔，让调用方退回规则路径（口径不变，来源如实标注） */
  const canModel = (label: string, phase: Phase = "judge"): boolean => {
    if (budget.model_calls >= budget.model_limit) {
      if (!budget.degraded.includes(label)) budget.degraded.push(label);
      trace.append(phase, "plan", `模型调用已达预算上限（${budget.model_limit} 次），「${label}」改用规则判定`, {
        model_calls: budget.model_calls,
        model_limit: budget.model_limit,
      });
      return false;
    }
    budget.model_calls += 1;
    return true;
  };

  // ═══ 环节一 · 受理：用户咨询理解 ═══════════════════════════════
  trace.checkpoint();
  stages.push("accept");
  const useModelU = !opts.offline && canModel("咨询理解", "accept");
  const u = await understand(msg, store, sop, !useModelU);
  trace.append("accept", "understand", `咨询理解完成（来源：${u.judge_source}）`, {
    text: msg.text,
    intent: u.intent,
  });

  // ═══ 环节二 · 分类 ═════════════════════════════════════════════
  const cls = classify(u.intent.case_type, u.intent.order_id, store, sop);
  trace.append("accept", "classify", `分类结果：${cls.case_name}（${cls.sop_path} 路径）`, {
    classification: cls,
    why: cls.because,
  });

  const order = store.orders.find((o) => o.order_id === u.intent.order_id) ?? null;
  const refund = order ? store.refunds.find((r) => r.order_id === order.order_id) ?? null : null;

  const ctx = {
    order,
    refund,
    fetched: new Map<SourceName, unknown>(),
    created: [] as Array<{ kind: string; id: string; detail: string }>,
  };

  const evidence: Partial<Record<SourceName, Record<string, unknown>>> = {};
  let judge: Judgment;
  let rv: ReviewResult;
  let requeryRounds = 0;
  const requeryTools: string[] = [];
  /** 本次召回的历史同类案件（函数级：结果里要一并交给界面展示） */
  let memHits: MemoryHit[] = [];

  // ═══ 诉求不明：按 SOP 只追问，不进取证与判责 ═══════════════════
  // （simulateStageViolation 是负向验证开关：强行绕过本分支，让 Reviewer 去拦阶段违规）
  if (cls.sop_path === "clarify" && !opts.simulateStageViolation) {
    judge = judgeOffline({
      case_name: cls.case_name,
      case_type: cls.case_type,
      refund: null,
      evidence: {},
      policy,
    });
    rv = opts.disableReviewer
      ? ablateReviewer(trace)
      : review({
          refund: null,
          order: null,
          evidence: {},
          judge,
          policy,
          classification: cls,
          stages_completed: stages,
        });
    trace.append("accept", "review", `Reviewer 裁决：${rv.verdict}`, {
      findings: rv.findings,
      stage_violations: rv.stage_violations,
    });
  } else {
    // ═══ 环节三 · 取证：按环节装配，只读工具 ════════════════════
    stages.push("investigate");
    const evidenceTools = assemble(tools, "investigate");
    if (evidenceTools.some((t) => !t.readOnly)) {
      throw new Error("装配越界：取证环节出现了可执行工具");
    }
    trace.append("investigate", "plan", `取证环节装配：${evidenceTools.length} 个只读工具`, {
      assembled_tools: evidenceTools.map((t) => t.name),
      note: "取证环节的装配里不含任何可执行工具",
    });

    const fetchInto = (sources: SourceName[], why: string) => {
      for (const s of sources) {
        trace.checkpoint();
        // 预算只掐「取证」这类读操作，绝不掐处置动作 —— 资金动作被预算挡住会出现
        // 「案子判了但没执行」的半成品，比慢一点危险得多。
        if (budget.tool_calls >= budget.tool_limit) {
          trace.append("investigate", "plan", `工具调用已达预算上限（${budget.tool_limit} 次），停止继续取证`, {
            tool_calls: budget.tool_calls,
            tool_limit: budget.tool_limit,
            stopped_at: why,
          });
          return;
        }
        const t = tools.find((x) => x.source === s && evidenceTools.includes(x));
        if (!t) throw new Error(`来源 ${s} 的工具在当前环节不可见`);
        const args = argsFor(s, ctx, msg);
        budget.tool_calls += 1;
        const { record, payload } = invoke(t, args, ctx);
        if (!payload) {
          trace.append("investigate", "tool_call", `${t.name} 未取到数据（${why}）`, { args: record.args });
          continue;
        }
        evidence[s] = record.fields_snapshot;
        ctx.fetched.set(s, payload);
        trace.append("investigate", "tool_call", `${t.name} 取数成功（${why}）`, {
          tool: t.name,
          args: record.args,
          args_hash: record.args_hash,
          fields_snapshot: record.fields_snapshot,
        });
      }
    };

    const firstRound = cls.required_sources.filter((s) => CONSERVATIVE.includes(s));
    fetchInto(firstRound, "首轮保守集");

    // ═══ 环节四 · 判责（三层上下文按需展开）══════════════════════
    const contextBundle = buildContext({
      phase: "judge",
      tools,
      policy,
      relevant_fields: cls.required_sources,
      progress: `已取证 ${Object.keys(evidence).join(" + ")}`,
    });
    trace.append("judge", "plan", `三层上下文披露：${disclosureStats(contextBundle)}`, {
      phase: "judge",
      layers: contextBundle.layers.map((l) => ({ layer: l.layer, disclosed: l.disclosed, chars: l.content.length })),
    });

    // ═══ 判据之前：翻一遍历史同类案件（只作参考）═════════════════
    // 记忆失败绝不能拖垮一次处置：整段包在 try 里，取不到就当没有经验。
    try {
      memHits = retrieveCases({
        case_type: cls.case_type,
        amount: refund?.applied_amount ?? null,
        text: msg.text,
        exclude_msg_id: msgId,
        limit: 3,
      });
    } catch (e) {
      trace.append("judge", "plan", `历史案件索引不可用，本次不带参考：${(e as Error).message}`, {});
    }
    if (memHits.length) {
      trace.append("judge", "plan", `参考历史同类案件 ${memHits.length} 条（advisory：只作提示，不参与判定与授权）`, {
        advisory: true,
        hits: memHits.map((h) => ({
          msg_id: h.msg_id,
          score: Number(h.score.toFixed(2)),
          verdict: h.verdict,
          why: h.why,
        })),
      });
    }
    const judgeContext = contextBundle.rendered + renderMemoryBlock(memHits);

    const useModelJ = !opts.offline && canModel("判据归纳");
    trace.checkpoint();
    judge = await judgeOnce(
      msg,
      cls,
      refund,
      evidence,
      policy,
      judgeContext,
      useModelJ ? opts : { ...opts, offline: true },
    );
    stages.push("judge");
    trace.append("judge", "judge", `判据归纳完成（来源：${judge.judge_source}）`, {
      decision: judge.decision,
      amount: judge.amount,
      // 轨迹回读要用它区分「模型判的」与「规则判的」，别靠 summary 抠字
      judge_source: judge.judge_source,
      criteria: judge.criteria,
      conflicts: judge.conflicts,
      ambiguous: judge.ambiguous,
    });

    // ═══ 只读 Reviewer 复核 ══════════════════════════════════════
    rv = opts.disableReviewer
      ? ablateReviewer(trace)
      : review({ refund, order, evidence, judge, policy, classification: cls, stages_completed: stages });
    if (!opts.disableReviewer) {
      trace.append("judge", "review", `Reviewer 裁决：${rv.verdict}`, {
        // verdict 单独落一份：轨迹回读（案件索引）要按它归类，
        // 从 summary 里正则抠字符串太脆，字段就该是字段
        verdict: rv.verdict,
        findings: rv.findings,
        missing_evidence: rv.missing_evidence,
        stage_violations: rv.stage_violations,
        readonly: rv.readonly,
      });
    }

    // ═══ 补证：Reviewer 提出补查请求 → 取证方照单补 → 再判再审 ════
    // 原先只跑一轮（写死 1）。现在按预算跑：最多 requery_limit 轮，
    // 每轮之前都确认「轮次没超、工具还有余量、模型还能叫」，
    // 任何一项用尽就停下并留痕 —— 停下来的理由必须能被追问，不能悄悄少跑一轮。
    while (rv.missing_evidence.length) {
      trace.checkpoint();
      if (budget.requery_rounds >= budget.requery_limit) {
        trace.append("investigate", "plan", `补证已达轮次上限（${budget.requery_limit} 轮），停止继续补证`, {
          still_missing: rv.missing_evidence,
          requery_rounds: budget.requery_rounds,
        });
        break;
      }
      if (budget.tool_calls >= budget.tool_limit) {
        trace.append("investigate", "plan", "工具调用预算耗尽，停止补证", { still_missing: rv.missing_evidence });
        break;
      }
      budget.requery_rounds += 1;
      requeryRounds = budget.requery_rounds;
      for (const p of rv.requery_plan) if (!requeryTools.includes(p.tool)) requeryTools.push(p.tool);
      trace.append("investigate", "plan", `第 ${budget.requery_rounds} 轮补证：${rv.missing_evidence.join(" + ")}`, {
        requery_plan: rv.requery_plan,
        still_missing: rv.missing_evidence,
      });
      fetchInto(rv.missing_evidence, `第 ${budget.requery_rounds} 轮补证`);
      const useModelJ2 = !opts.offline && canModel("补证后重新归纳");
      judge = await judgeOnce(
        msg,
        cls,
        refund,
        evidence,
        policy,
        judgeContext,
        useModelJ2 ? opts : { ...opts, offline: true },
      );
      trace.append("judge", "judge", `补证后重新归纳判据（来源：${judge.judge_source}）`, {
        decision: judge.decision,
        amount: judge.amount,
        judge_source: judge.judge_source,
        conflicts: judge.conflicts,
        ambiguous: judge.ambiguous,
      });
      if (opts.disableReviewer) break; // 没有复核者就不会再产生补查请求，套娃没有意义
      rv = review({ refund, order, evidence, judge, policy, classification: cls, stages_completed: stages });
      trace.append("judge", "review", `补证后 Reviewer 裁决：${rv.verdict}`, {
        verdict: rv.verdict,
        findings: rv.findings,
        missing_evidence: rv.missing_evidence,
        stage_violations: rv.stage_violations,
      });
    }
  }

  // ═══ 环节五 · 审批：授权闸 + 审批回调回路 ══════════════════════
  let auth: CaseRunResult["auth"] = null;
  let executedTool: string | null = null;
  let executionOutcome = "";
  // 动作工具与参数在此冻结：停办转人工后，续办必须执行「同一次参数」，
  // 不能重新跑一遍让金额漂移——审批人批的是具体那笔钱，不是一类操作。
  let actionTool: ToolSpec | null = null;
  let actionArgs: Record<string, unknown> | null = null;
  let deferred: PendingApproval | null = null;

  if (cls.sop_path === "clarify" && !opts.simulateStageViolation) {
    executionOutcome = "诉求不明，按 SOP 未进入审批与执行";
    trace.append("accept", "gate", executionOutcome, { sop_path: cls.sop_path });
  } else if (rv.verdict.startsWith("REJECT")) {
    executionOutcome = `被复核门禁阻断（${rv.verdict}），未进入授权执行`;
    trace.append("approve", "gate", executionOutcome, { verdict: rv.verdict, findings: rv.findings });
  } else if (!cls.money_action) {
    executionOutcome = "无不可逆动作，按 SOP 直接结单";
    trace.append("approve", "gate", executionOutcome, { case_type: cls.case_type });
  } else {
    // 资金动作之前最后一次取消检查点：过了这里就没有回头路了
    trace.checkpoint();
    stages.push("approve");
    const approveTools = assemble(tools, "approve");
    actionTool = approveTools.find((t) => t.name === cls.money_action) ?? null;
    if (!actionTool) throw new Error(`审批环节的装配里缺少动作工具 ${cls.money_action}`);

    trace.append("approve", "plan", "进入审批环节，装配发生变化", {
      assembled_tools: approveTools.map((t) => t.name),
      added: approveTools.filter((t) => !assemble(tools, "investigate").includes(t)).map((t) => t.name),
    });

    auth = classifyAuth(actionTool, judge.amount, policy);
    trace.append("approve", "auth", `授权分档：${auth.tier}（${auth.label}）`, {
      // 档位单独落一份：轨迹回读要按它归类，别去 summary 里正则抠
      tier: auth.tier,
      tool: auth.tool,
      amount: auth.amount,
      threshold: auth.threshold,
      needs_human: auth.needs_human,
      because: auth.because,
    });

    actionArgs =
      actionTool.short === "decide_refund"
        ? {
            refund_id: refund?.refund_id ?? "",
            decision: judge.decision,
            amount: judge.amount,
            criteria_ids: judge.criteria.map((c) => c.id),
          }
        : {
            order_id: order?.order_id ?? "",
            target_spec: String(u.intent.slots["目标规格"] ?? "同款"),
          };

    // 停办转审批的两种触发：
    //   ① 大额（APPROVE 档）—— Agent 本来就无权执行，一律交人；
    //   ② 关闭了「小额自动确认」—— 中额动作不再走「无人响应即挂起」的死路，
    //      而是正经生成审批单进审批中心，让人真的能处置。
    const deferThis = auth.needs_human && opts.deferApproval && (auth.tier === "APPROVE" || opts.autoApproveAsk === false);
    if (deferThis) {
      // 自主模式：不停不等，把这一次的参数冻结成待审批单交回宿主。
      // Agent 到这一步为止已经做完了全部能自己做的事（理解 / 取证 / 判责 / 复核），
      // 剩下的只是「这笔钱该不该出」——那是人的判断，不是 Agent 可以自我授权的。
      const at = new Date().toISOString();
      auth = { ...auth, approver: "待指定审批人", approval_decision: "PENDING", approval_at: at };
      executionOutcome =
        auth.tier === "APPROVE"
          ? "已停办并转入人工审批队列（该金额超出 Agent 自动处置范围）"
          : "已停办并转入人工审批队列（小额自动确认已关闭）";
      trace.append("approve", "gate", executionOutcome, {
        tier: auth.tier,
        pending: true,
        to_approval_center: true,
        agent_authorized: false,
      });
      deferred = buildPendingTicket({
        msgId,
        auth,
        judge,
        rv,
        cls,
        policy,
        text: msg.text,
        evidence,
        requested_at: at,
      });
    } else if (auth.needs_human) {
      const resolver: ApprovalResolver =
        opts.approvalResolver ?? {
          kind: "scripted",
          resolve: async () => ({
            approved: opts.autoApproveAsk,
            approver: opts.autoApproveAsk ? "human(脚本自动确认)" : "human(未响应)",
            decision: opts.autoApproveAsk ? "APPROVED" : "PENDING",
          }),
        };
      auth = await requestApproval(auth, resolver, `案件 ${msgId}｜${cls.case_name}`);
      trace.append("approve", "auth", `审批回调结果：${auth.approval_decision}`, {
        // 留痕三件套：审批人 / 决策 / 时间，全部落进行内 detail，供按步回放
        approver: auth.approver,
        approval_decision: auth.approval_decision,
        approval_at: auth.approval_at,
        resolver_kind: resolver.kind,
      });
    }

    if (deferred) {
      // 已转审批中心：本轮到停办为止，不执行、不结单
    } else if (auth.outcome === "AUTO_EXECUTED" || (auth.needs_human === false && auth.tier !== "APPROVE")) {
      const { record } = invoke(actionTool, actionArgs, ctx);
      executedTool = actionTool.name;
      executionOutcome = `授权闸放行并执行 ${actionTool.name}`;
      trace.append("approve", "gate", executionOutcome, {
        tool: actionTool.name,
        args_hash: record.args_hash,
        tier: auth.tier,
      });
    } else {
      executionOutcome =
        auth.tier === "APPROVE"
          ? "挂起等待人工审批（Agent 无权执行）"
          : "挂起等待人工确认（未取得授权，不执行）";
      trace.append("approve", "gate", executionOutcome, {
        tier: auth.tier,
        pending: true,
        agent_authorized: auth.tier !== "APPROVE",
      });
    }
  }

  // ═══ 环节六 · 结单：结果反馈 ═══════════════════════════════════
  const replyInputFor = (finalAuth: CaseRunResult["auth"], followUpOverride?: boolean) => ({
    case_type: cls.case_type,
    case_name: cls.case_name,
    text: msg.text,
    verdict: rv.verdict,
    auth: finalAuth,
    review: rv,
    created: ctx.created,
    follow_up_required:
      followUpOverride ??
      (rv.verdict.startsWith("REJECT") ||
        rv.verdict === "WARN_AMBIGUOUS" ||
        rv.verdict === "CLARIFY_NEEDED" ||
        (finalAuth?.needs_human ?? false)),
    logistics_signed: (evidence.logistics?.signed as boolean | undefined) ?? null,
  });

  const packResult = (
    finalAuth: CaseRunResult["auth"],
    finalExecuted: string | null,
    finalOutcome: string,
    reply: CaseRunResult["reply"],
  ): CaseRunResult => {
    // 先刷盘再读计数：调用方拿到 trace_path 时，文件必须已经写完；
    // trace_writes 也必须包含这一次刷盘，否则数字会少 1
    trace.flush();
    return {
      msg_id: msgId,
      text: msg.text,
      sample_id: null,
      grade: null,
      title: null,
      understanding: { ...u.intent, judge_source: u.judge_source },
      classification: cls,
      evidence_sources: Object.keys(evidence) as SourceName[],
      requery_rounds: requeryRounds,
      requery_tools: requeryTools,
      judge,
      review: rv,
      auth: finalAuth,
      executed_tool: finalExecuted,
      execution_outcome: finalOutcome,
      reply,
      stages_completed: [...stages],
      trace_path: resolve(trace.path),
      trace_writes: trace.flush_count,
      budget: { ...budget, degraded: [...budget.degraded] },
      memory_hits: memHits,
    };
  };

  /** 结单：正常路径与「人工审批后续办」路径共用，保证回执口径与留痕位置完全一致 */
  const close = async (
    finalAuth: CaseRunResult["auth"],
    finalExecuted: string | null,
    finalOutcome: string,
    afterApproval: boolean,
  ): Promise<CaseRunResult> => {
    if (!stages.includes("close")) stages.push("close");
    const input = replyInputFor(finalAuth);
    // 回执也吃预算：模型额度用尽时退回确定性回执 ——
    // 不能因为「没预算了」就不给客户答复，那是最差的降级方式。
    const useModelR = !opts.offline && canModel("结单回执", "close");
    const reply = useModelR ? await replyWithModel(input) : replyOffline(input);
    trace.append("close", "reply", afterApproval ? "人工审批后续办完成，结单回执已生成" : "结单回执已生成", {
      customer_text: reply.customer_text,
      internal_note: reply.internal_note,
      follow_up_required: reply.follow_up_required,
      reply_source: reply.reply_source,
      created_docs: ctx.created,
      after_approval: afterApproval,
    });
    return packResult(finalAuth, finalExecuted, finalOutcome, reply);
  };

  // ── 停办：本轮到审批中心为止。给客户一句确定性的过渡回执，不声称任何未完成的结果 ──
  if (deferred) {
    const ticket = deferred;
    const holding = replyOffline(replyInputFor(auth, true));
    const result = packResult(auth, null, executionOutcome, holding);
    return {
      status: "pending",
      result: { ...result, pending_approval: ticket },
      ticket,
      resume: async (approved: boolean, approver: string, note: string) => {
        const at = new Date().toISOString();
        const finalAuth: AuthDecision = {
          ...(auth as AuthDecision),
          approver: approver?.trim() || "未署名审批人",
          approval_decision: approved ? "APPROVED" : "REJECTED",
          approval_at: at,
          outcome: approved ? "AUTO_EXECUTED" : "SKIPPED_BY_GATE",
          needs_human: !approved,
        };
        trace.append("approve", "auth", `人工审批结论：${approved ? "批准" : "驳回"}（审批人 ${finalAuth.approver}）`, {
          approver: finalAuth.approver,
          approval_decision: finalAuth.approval_decision,
          approval_at: at,
          approval_note: note || "",
          ticket_id: ticket.id,
          resolved_by: "human",
        });

        let finalExecuted: string | null = null;
        let finalOutcome: string;
        if (approved) {
          const tool = actionTool as ToolSpec;
          const { record } = invoke(tool, actionArgs as Record<string, unknown>, ctx);
          finalExecuted = tool.name;
          finalOutcome = `人工审批通过后执行 ${finalExecuted}（审批人 ${finalAuth.approver}）`;
          trace.append("approve", "gate", finalOutcome, {
            tool: finalExecuted,
            args_hash: record.args_hash,
            tier: finalAuth.tier,
            resolved_by: "human",
          });
        } else {
          finalOutcome = `人工审批驳回，未执行任何处置动作（审批人 ${finalAuth.approver}）`;
          trace.append("approve", "gate", finalOutcome, {
            tier: finalAuth.tier,
            resolved_by: "human",
            approval_note: note || "",
          });
        }
        return close(finalAuth, finalExecuted, finalOutcome, true);
      },
    };
  }

  return { status: "completed", result: await close(auth, executedTool, executionOutcome, false) };
}

/**
 * 审批单号：业务化的「日期-当日序号」，例如 20261015-01。
 * 刻意不用带系统前缀的字符串码——单号是要被客服在群里引用的东西，
 * 长得像一张单据号，而不是一段程序生成的键。
 */
let approvalSeq = 0;

function todayStamp(): string {
  const d = new Date();
  return (
    d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0")
  );
}

function ticketId(): string {
  return todayStamp() + "-" + String(++approvalSeq).padStart(2, "0");
}

/**
 * 用历史单号把当日序号续上。
 *
 * 为什么必须做：单号是「日期-当日序号」，而序号在进程内从 1 数起。
 * 一旦审批单落了盘，重启后再发一张就又变成 `-01`，与台账里那张重号；
 * 回放时「新单被裁决」会连带把旧单一起抹掉 —— 看起来像「重启后单子凭空消失」。
 * 这个 bug 只有把「持久化」和「按单号回放」凑到一起才会出现。
 */
export function seedApprovalSeq(existingIds: string[]): void {
  const stamp = todayStamp();
  let max = 0;
  for (const id of existingIds) {
    if (typeof id !== "string" || !id.startsWith(stamp + "-")) continue;
    const n = Number(id.slice(stamp.length + 1));
    if (Number.isFinite(n) && n > max) max = n;
  }
  if (max > approvalSeq) approvalSeq = max;
}

/**
 * 组装一张「能在 15 秒内做出判断」的待审批单。
 *
 * 参照人工审批控制台的四问：为什么停在这里 / 依据是什么 / 我能做什么 / 做完会怎样。
 * `uncertainties` 特意把 Agent 考虑过但不能据此强判的项也列出来——只给结论的审批界面
 * 会把人变成橡皮图章，把备选摊开才谈得上复核。
 */
function buildPendingTicket(args: {
  msgId: string;
  auth: AuthDecision;
  judge: Judgment;
  rv: ReviewResult;
  cls: Classification;
  policy: Policy;
  text: string;
  evidence: Partial<Record<SourceName, Record<string, unknown>>>;
  requested_at: string;
}): PendingApproval {
  const { msgId, auth, judge, rv, cls, policy, text, evidence, requested_at } = args;
  const autoLimit = Math.max(
    ...policy.amount_tiers.filter((t) => t.up_to !== null).map((t) => t.up_to as number),
  );
  const isRefund = auth.tool.endsWith("decide_refund");

  const basis: string[] = [];
  for (const c of judge.criteria) basis.push(c.statement);
  const refundRow = evidence.refunds;
  const orderRow = evidence.orders;
  if (refundRow && typeof refundRow.applied_amount === "number") basis.push(`退款申请金额 ¥${refundRow.applied_amount}`);
  if (orderRow && typeof orderRow.paid_amount === "number") basis.push(`订单实付金额 ¥${orderRow.paid_amount}`);
  const lg = evidence.logistics;
  if (lg) {
    basis.push(
      lg.signed
        ? `物流状态：已签收（签收人 ${String(lg.signer ?? "未知")}）`
        : "物流状态：尚未签收",
    );
  }

  const uncertainties = Array.from(
    new Set([
      ...judge.ambiguous,
      ...rv.findings.filter((f) => f.verdict === "WARN_AMBIGUOUS").map((f) => f.because),
    ]),
  );

  return {
    id: ticketId(),
    msg_id: msgId,
    case_name: cls.case_name,
    customer_text: text,
    action: auth.tool,
    amount: auth.amount,
    auto_limit: autoLimit,
    tier: auth.tier,
    stop_reason:
      auth.tier === "APPROVE"
        ? `该笔处置金额 ¥${auth.amount} 超出 Agent 可自动处置上限 ¥${autoLimit}，按政策必须由人工审批后执行。`
        : `当前已暂停小额自动确认，金额 ¥${auth.amount} 的处置需要人工审批后执行。`,
    basis,
    uncertainties,
    if_approved: isRefund
      ? `执行退款 ¥${auth.amount}，向客户发送退款到账通知，本次会话直接结单。`
      : `生成换货工单并通知客户寄回与换发流程，本次会话直接结单。`,
    if_rejected: isRefund
      ? "不执行退款，改为转交专人跟进并向客户说明，本次会话结单。"
      : "不生成换货工单，改为转交专人跟进并向客户说明，本次会话结单。",
    holding_reply: "已受理，正在等待人工审批结果",
    requested_at,
  };
}

function argsFor(s: SourceName, ctx: { order: { order_id: string; sku_id: string } | null; refund: { refund_id: string } | null }, _msg: MessageRow): Record<string, unknown> {
  switch (s) {
    case "orders":
      return { order_id: ctx.order?.order_id ?? "" };
    case "refunds":
      return { refund_id: ctx.refund?.refund_id ?? "" };
    case "sku_specs":
      return { sku_id: ctx.order?.sku_id ?? "" };
    case "logistics":
      return { order_id: ctx.order?.order_id ?? "" };
    case "tickets":
      return { order_id: ctx.order?.order_id ?? "" };
    default:
      return {};
  }
}

async function judgeOnce(
  msg: MessageRow,
  cls: { case_name: string; case_type: CaseType },
  refund: { refund_id: string; applied_amount: number; reason_code: string; reason_text: string } | null,
  evidence: Partial<Record<SourceName, Record<string, unknown>>>,
  policy: Policy,
  contextBlock: string,
  opts: RunOptions,
): Promise<Judgment> {
  if (opts.offline) {
    return judgeOffline({ case_name: cls.case_name, case_type: cls.case_type, refund: refund as any, evidence, policy });
  }
  const { system, user } = buildJudgePrompt({
    text: msg.text,
    case_name: cls.case_name,
    refund: refund as any,
    evidence,
    policy,
    context_block: contextBlock,
  });
  const res = await callModel(system, user, 0);
  const raw = extractJson<any>(res.text);
  return normalize(refund, raw);
}

function normalize(refund: { refund_id: string } | null, raw: any): Judgment {
  const allowed = new Set(["REFUND", "PARTIAL_REFUND", "EXCHANGE", "REJECT", "NEED_MORE_INFO", "INQUIRY"]);
  if (!allowed.has(raw?.decision)) {
    throw new ModelError(`模型返回的 decision 非法：${JSON.stringify(raw?.decision)}`, undefined, "bad_shape");
  }
  const amount = Number(raw?.amount);
  if (!Number.isFinite(amount)) {
    throw new ModelError(`模型返回的 amount 不是数字：${JSON.stringify(raw?.amount)}`, undefined, "bad_shape");
  }
  const criteria = Array.isArray(raw?.criteria)
    ? raw.criteria
        .filter((c: any) => c && typeof c.statement === "string")
        .map((c: any, i: number) => ({
          id: String(c.id ?? `C${i + 1}`),
          statement: String(c.statement),
          basis: Array.isArray(c.basis) ? c.basis.map(String) : [],
        }))
    : [];
  return {
    refund_id: refund?.refund_id ?? null,
    decision: raw.decision,
    amount,
    criteria,
    conflicts: Array.isArray(raw?.conflicts) ? raw.conflicts.map(String) : [],
    ambiguous: Array.isArray(raw?.ambiguous) ? raw.ambiguous.map(String) : [],
    rationale: String(raw?.rationale ?? ""),
    judge_source: "model",
  };
}

/** 消融实验：把只读 Reviewer 从链路里摘掉 */
function ablateReviewer(trace: Trace): ReviewResult {
  trace.append("judge", "review", "消融实验：Reviewer 被移除，本环节不做任何复核", { ablated: true, readonly: true });
  return { verdict: "PASS", findings: [], missing_evidence: [], requery_plan: [], stage_violations: [], readonly: true };
}
