import type {
  Classification,
  Judgment,
  OrderRow,
  RefundRow,
  ReviewFinding,
  ReviewResult,
  SourceName,
  VerdictKind,
} from "./types.ts";
import type { Policy } from "./policy.ts";
import type { Phase } from "./types.ts";

export interface ReviewInput {
  refund: RefundRow | null;
  order: OrderRow | null;
  evidence: Partial<Record<SourceName, Record<string, unknown>>>;
  judge: Judgment;
  policy: Policy;
  classification: Classification;
  /** 实际走完的环节，用于判定 SOP 阶段合规 */
  stages_completed: Phase[];
}

/**
 * 裁决严重度刻度：一次复核可能同时命中多条规则，取最严重的那条作为最终裁决。
 * 刻度刻意拉开：CLARIFY_NEEDED(1) 必须高于 PASS(0)，否则「只追问」这个正确行为
 * 会被 reduce 误判成 PASS；WARN(2) 高于 CLARIFY，各类 REJECT 按阻断强度 3–7 递增。
 */
const SEVERITY: Record<VerdictKind, number> = {
  REJECT_STAGE_VIOLATION: 7,
  REJECT_MISSING_EVIDENCE: 6,
  REJECT_AMOUNT: 5,
  REJECT_FACT_CONFLICT: 4,
  REJECT_NO_CRITERIA: 3,
  WARN_AMBIGUOUS: 2,
  CLARIFY_NEEDED: 1,
  PASS: 0,
};

interface FlatCtx {
  reason_code: string;
  logistics_signed: boolean | null;
  logistics_signer: string;
  paid_amount: number | null;
  applied_amount: number;
  case_type: string;
  evidence_complete: boolean;
  criteria_count: number;
}

function flatten(input: ReviewInput): FlatCtx {
  const ev = input.evidence;
  return {
    reason_code: input.refund?.reason_code ?? "",
    logistics_signed: (ev.logistics?.signed as boolean | undefined) ?? null,
    logistics_signer: String(ev.logistics?.signer ?? ""),
    paid_amount: (ev.orders?.paid_amount as number | undefined) ?? null,
    applied_amount: input.refund?.applied_amount ?? 0,
    case_type: input.classification.case_type,
    evidence_complete: input.classification.required_sources.every((s) => ev[s] !== undefined),
    criteria_count: input.judge.criteria.length,
  };
}

/** 极小条件匹配器：等值 + `<字段>_contains` 子串 */
function matchWhen(when: Record<string, unknown>, ctx: FlatCtx): boolean {
  for (const [k, v] of Object.entries(when)) {
    if (k.endsWith("_contains")) {
      const field = k.slice(0, -"_contains".length) as keyof FlatCtx;
      if (!String(ctx[field] ?? "").includes(String(v))) return false;
    } else {
      const field = k as keyof FlatCtx;
      if (ctx[field] !== v) return false;
    }
  }
  return true;
}

function requeryPlan(missing: SourceName[], refund: RefundRow | null, order: OrderRow | null) {
  const orderId = order?.order_id ?? refund?.order_id ?? "";
  const map: Record<SourceName, { tool: string; args: Record<string, unknown> }> = {
    orders: { tool: "aftersales.query_order", args: { order_id: orderId } },
    refunds: { tool: "aftersales.query_refund", args: { refund_id: refund?.refund_id ?? "" } },
    sku_specs: { tool: "aftersales.query_sku_spec", args: { sku_id: order?.sku_id ?? "" } },
    logistics: { tool: "aftersales.query_logistics", args: { order_id: orderId } },
    tickets: { tool: "aftersales.query_ticket", args: { order_id: orderId } },
    action: { tool: "", args: {} },
  };
  return missing.map((s) => map[s]).filter((p) => p.tool);
}

/**
 * 只读 Reviewer
 *
 * 对应简历要点四的「只读 Reviewer 角色独立核验」：它的输入是已经取到的数据与已走完的环节，
 * 手里没有工具句柄，因此结构上不可能执行任何操作 —— 只有两种权力：驳回，以及要求补证。
 *
 * 本版把复核范围从上一版的「只查取证完整性」扩展到两类：
 *   A. 取证与事实：证据齐不齐、金额口径、事实一致性、判据留痕、模糊例识别
 *   B. SOP 合规：该追问时有没有追问、没取齐就进判责、没判据就结单
 */
export function review(input: ReviewInput): ReviewResult {
  const { refund, policy, judge, classification } = input;
  const ctx = flatten(input);
  const present = Object.keys(input.evidence) as SourceName[];
  const findings: ReviewFinding[] = [];
  const stageViolations: string[] = [];

  // ═══ 诉求不明分支 ═══════════════════════════════════════════════════
  // SOP 规定：诉求无法归一时只追问，不进取证与判责。
  // Reviewer 在这里的职责是「确认该追问时追问了」——给出 CLARIFY_NEEDED 裁决；
  // 若编排层违规闯过了取证/判责，则照常升级为 REJECT_STAGE_VIOLATION 阻断。
  if (classification.sop_path === "clarify") {
    findings.push({
      rule: "SR-01",
      verdict: "CLARIFY_NEEDED",
      because: "诉求无法归一，按 SOP 只追问澄清，未进入取证与判责；待客户补充信息后再走完整链路。",
    });
    for (const rule of policy.stage_rules) {
      if (!matchWhen(rule.when, ctx)) continue;
      const violated = rule.forbid.filter((p) => input.stages_completed.includes(p));
      if (violated.length) {
        stageViolations.push(`${rule.id}：${rule.because}（实际走过 ${violated.join(" → ")}）`);
        findings.push({ rule: rule.id, verdict: "REJECT_STAGE_VIOLATION", because: rule.because });
      }
    }
    const verdict = findings.reduce<VerdictKind>(
      (acc, f) => (SEVERITY[f.verdict] > SEVERITY[acc] ? f.verdict : acc),
      "PASS",
    );
    return { verdict, findings, missing_evidence: [], requery_plan: [], stage_violations: stageViolations, readonly: true };
  }

  // A1 —— 取证完整性：以 SOP 对该案件类型要求的来源为准。
  // 这是「可恢复」的驳回：给出补查计划，取证方照单补证后重判再审，不是硬阻断。
  let missing: SourceName[] = [];
  missing = classification.required_sources.filter((s) => !present.includes(s));
  if (missing.length) {
    findings.push({
      rule: "EV-01",
      verdict: "REJECT_MISSING_EVIDENCE",
      because: `「${classification.case_name}」要求证据 ${classification.required_sources.join(" + ")}，实际缺 ${missing.join(" + ")}。`,
      missing,
    });
  }

  // A2 —— 金额口径
  for (const rule of policy.amount_rules) {
    if (!refund) continue;
    const fee = Number((input.evidence.sku_specs?.refundable_service_fee as number | undefined) ?? 0);
    const cap = (ctx.paid_amount ?? 0) + fee;
    if (ctx.applied_amount > cap) {
      findings.push({
        rule: rule.id,
        verdict: "REJECT_AMOUNT",
        because: `${rule.because} 实测 applied_amount=${ctx.applied_amount} > 封顶 ${cap}。`,
      });
    }
  }

  // A3 —— 事实一致性
  for (const rule of policy.consistency_rules) {
    if (matchWhen(rule.when, ctx)) {
      findings.push({
        rule: rule.id,
        verdict: (rule.verdict === "BLOCK" ? "REJECT_FACT_CONFLICT" : "WARN_AMBIGUOUS") as VerdictKind,
        because: rule.because,
      });
    }
  }

  // A4 —— 判据留痕：结论必须能回放到具体字段，一条判据都没有 = 硬阻断
  if (!judge.criteria || judge.criteria.length === 0) {
    findings.push({
      rule: "JT-01",
      verdict: "REJECT_NO_CRITERIA",
      because: "结论没有任何判据条目，无法回放这一步为什么这样判。",
    });
  }

  // B —— SOP 阶段合规
  for (const rule of policy.stage_rules) {
    if (!matchWhen(rule.when, ctx)) continue;
    const done = input.stages_completed;
    const violated = rule.forbid.filter((p) => done.includes(p));
    if (violated.length) {
      stageViolations.push(`${rule.id}：${rule.because}（实际走过 ${violated.join(" → ")}）`);
      findings.push({ rule: rule.id, verdict: "REJECT_STAGE_VIOLATION", because: rule.because });
    }
  }

  // A5 —— 模糊例：规则未给出确定口径，只告警不阻断
  for (const d of policy.ambiguous_detectors) {
    if (matchWhen(d.when, ctx)) {
      findings.push({ rule: d.id, verdict: "WARN_AMBIGUOUS", because: d.note });
    }
  }

  const verdict = findings.reduce<VerdictKind>(
    (acc, f) => (SEVERITY[f.verdict] > SEVERITY[acc] ? f.verdict : acc),
    "PASS",
  );

  const plan = requeryPlan(missing, refund, input.order);
  // 结构护栏：Reviewer 永远不能产出可执行动作
  for (const p of plan) {
    if (!p.tool.startsWith("aftersales.query_")) {
      throw new Error(`Reviewer 越权：补查计划里出现了非只读工具 ${p.tool}`);
    }
  }

  return {
    verdict,
    findings,
    missing_evidence: missing,
    requery_plan: plan,
    stage_violations: stageViolations,
    readonly: true,
  };
}
