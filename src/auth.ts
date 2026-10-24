import type { AuthTier } from "./types.ts";
import type { Policy } from "./policy.ts";
import type { ToolSpec } from "./tools.ts";

export interface AuthDecision {
  tool: string;
  read_only: boolean;
  money_action: boolean;
  amount: number;
  tier: AuthTier;
  label: string;
  threshold: number | null;
  needs_human: boolean;
  because: string;
  outcome: "AUTO_EXECUTED" | "PENDING_ASK" | "PENDING_APPROVAL" | "SKIPPED_BY_GATE";
  approver?: string;
  approval_decision?: string;
  approval_at?: string;
}

/**
 * 三档授权（按操作类型定档 + 按金额参数动态升级）
 *
 * 对应简历要点二：授权策略从提示词的软约束下沉为执行前的强制校验。
 * 判定顺序：
 *   1) 只读工具            → AUTO（任何模式下都允许， Craft 的 always-allowed 同构）
 *   2) 非资金类不可逆动作   → ASK（换货建单、退货运单一旦生成就要寄回）
 *   3) 资金类动作           → 按金额参数动态分档（≤100 执行 / ≤500 询问 / >500 升级审批）
 */
export function classify(tool: ToolSpec, amount: number, policy: Policy): AuthDecision {
  const base = {
    tool: tool.name,
    read_only: tool.readOnly,
    money_action: tool.moneyAction,
    amount,
    threshold: null as number | null,
  };

  const mk = (tier: AuthTier, label: string, because: string, needsHuman: boolean): AuthDecision => {
    // EXECUTE 与 AUTO 一样无需人工介入，outcome 直接记为 AUTO_EXECUTED——
    // 这个值会被回执生成与详情打印消费，错标成 PENDING_APPROVAL 会让「已执行」显示成「挂起中」。
    const outcome: AuthDecision["outcome"] =
      tier === "AUTO" || tier === "EXECUTE"
        ? "AUTO_EXECUTED"
        : tier === "ASK"
          ? "PENDING_ASK"
          : "PENDING_APPROVAL";
    return { ...base, tier, label, needs_human: needsHuman, because, outcome };
  };

  if (tool.readOnly) {
    return mk("AUTO", "只读直通", "只读工具不改变业务状态，无需授权。", false);
  }

  const nonMoney = policy.action_tiers.find((t) => t.match.money_action === false);
  if (!tool.moneyAction) {
    if (!nonMoney) throw new Error("policy.action_tiers 缺少非资金类档位，拒绝在无授权策略的情况下继续");
    return mk("ASK", nonMoney.label, nonMoney.because, true);
  }

  const sorted = policy.amount_tiers
    .filter((t) => t.up_to !== null)
    .sort((a, b) => (a.up_to as number) - (b.up_to as number));
  const hit = sorted.find((t) => amount <= (t.up_to as number));
  const chosen = hit ?? policy.amount_tiers.find((t) => t.up_to === null);
  if (!chosen) throw new Error("policy.amount_tiers 未定义兜底档位，拒绝在无授权策略的情况下继续");

  const threshold = chosen.up_to;
  const because =
    chosen.tier === "EXECUTE"
      ? `资金类动作 ${tool.name}，金额 ${amount} 未超过 ${threshold}，落在「${chosen.label}」档。`
      : chosen.tier === "ASK"
        ? `资金类动作 ${tool.name}，金额 ${amount} 落在「${chosen.label}」档（>100 且 ≤${threshold}）：执行前必须取得一次人工确认，且该确认只对本次参数有效。`
        : `资金类动作 ${tool.name}，金额 ${amount} 超过最高阈值，落在「${chosen.label}」档：Agent 无权执行，必须挂起等待人工审批。`;

  return mk(chosen.tier as AuthTier, chosen.label, because, chosen.tier !== "EXECUTE");
}

export interface ApprovalRequest {
  tool: string;
  amount: number;
  reason: string;
}

export interface ApprovalResolver {
  /** 宿主侧的裁决实现。返回 true = 批准执行；false = 拒绝 */
  resolve: (req: ApprovalRequest) => Promise<{ approved: boolean; approver: string; decision: string }>;
  /**
   * 该解析器的说明，用于在报告里区分三种来源：
   *   interactive —— 宿主当场交互取得（如终端提示）
   *   human       —— 真人就本次参数给出的裁决（审批中心点「批准 / 驳回」后回填）
   *   scripted    —— 脚本演示自动填的（--auto-approve 等），不代表任何真人意见
   */
  kind: "interactive" | "human" | "scripted";
}

/**
 * 审批回调回路：授权请求以回调交回宿主裁决，结果再回写会话状态。
 *
 * 这是简历要点二里「授权请求以回调交回宿主裁决」的落点 —— 上一版只是打印一行
 * 「挂起等待人工」，本版把交回—裁决—回写这三步做成真实可跑的闭环。
 *
 * APPROVE 档的两种处置（关键区别）：
 *   · 默认（scripted / interactive）：Agent 无权执行，连「脚本自动确认」这条路都不给，
 *     一律记 PENDING 挂起 —— 这是「大额不出自动门」的硬约束，不能被演示脚本绕过。
 *   · kind === "human"：真人已在审批中心就这一次的参数给出裁决。此时批准才真的放行执行，
 *     驳回则按未执行收口。裁决只对本次参数有效（金额随决策冻结，不因重新运行而漂移）。
 */
export async function requestApproval(
  decision: AuthDecision,
  resolver: ApprovalResolver,
  reason: string,
): Promise<AuthDecision> {
  const at = new Date().toISOString();
  if (decision.tier === "APPROVE") {
    if (resolver.kind === "human") {
      const r = await resolver.resolve({ tool: decision.tool, amount: decision.amount, reason });
      return {
        ...decision,
        approver: r.approver,
        approval_decision: r.decision,
        approval_at: at,
        outcome: r.approved ? "AUTO_EXECUTED" : "SKIPPED_BY_GATE",
        needs_human: !r.approved,
      };
    }
    // 默认：升级人工审批，Agent 无权执行，连「自动确认」这条路都不给
    return { ...decision, approver: "待指定审批人", approval_decision: "PENDING", approval_at: at };
  }
  const r = await resolver.resolve({ tool: decision.tool, amount: decision.amount, reason });
  return {
    ...decision,
    approver: r.approver,
    approval_decision: r.decision,
    approval_at: at,
    outcome: r.approved ? "AUTO_EXECUTED" : "SKIPPED_BY_GATE",
    needs_human: !r.approved,
  };
}
