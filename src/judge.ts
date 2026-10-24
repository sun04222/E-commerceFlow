import type { Judgment, RefundRow, SourceName } from "./types.ts";
import type { Policy } from "./policy.ts";

/**
 * 判据归纳（规则版 / 离线占位）
 *
 * 与模型版同构：产出同一个 Judgment 结构，但 judge_source 标为 offline_rule。
 * 它存在的意义是：工具面、装配、授权闸、轨迹、只读复核全是确定性逻辑，
 * 没有可用模型密钥时，整条链路依然端到端跑通并被回归门禁校验。
 */
export interface OfflineJudgeInput {
  case_name: string;
  case_type: string;
  refund: RefundRow | null;
  evidence: Partial<Record<SourceName, Record<string, unknown>>>;
  policy: Policy;
}

export function judgeOffline(input: OfflineJudgeInput): Judgment {
  const { case_type, refund, evidence, policy } = input;
  const criteria: Judgment["criteria"] = [];
  const conflicts: string[] = [];
  const ambiguous: string[] = [];

  // 没有退款单的案件（换货 / 物流查询 / 诉求不明）
  if (!refund) {
    if (case_type === "EXCHANGE") {
      criteria.push({
        id: "C1",
        statement: "客户明确要求换货且不接受退款，SOP 走换货路径，不产生资金动作。",
        basis: ["messages.text", "tickets.content"],
      });
      return {
        refund_id: null,
        decision: "EXCHANGE",
        amount: 0,
        criteria,
        conflicts,
        ambiguous,
        rationale: "换货诉求明确，按 SOP 生成换货工单；非资金类不可逆动作，需人工确认后执行。",
        judge_source: "offline_rule",
      };
    }
    if (case_type === "LOGISTICS_INQUIRY") {
      criteria.push({
        id: "C1",
        statement: "诉求为物流查询/催件，无资金动作，按 SOP 结单并回执物流状态。",
        basis: ["logistics.signed", "logistics.nodes"],
      });
      return {
        refund_id: null,
        decision: "INQUIRY",
        amount: 0,
        criteria,
        conflicts,
        ambiguous,
        rationale: "物流查询类咨询，不进入判责与授权。",
        judge_source: "offline_rule",
      };
    }
    criteria.push({
      id: "C1",
      statement: "文本无可识别诉求，按 SOP 先追问澄清，不进入取证与判责。",
      basis: ["messages.text"],
    });
    return {
      refund_id: null,
      decision: "NEED_MORE_INFO",
      amount: 0,
      criteria,
      conflicts,
      ambiguous,
      rationale: "诉求不明，需向客户补充信息后才能继续。",
      judge_source: "offline_rule",
    };
  }

  const paid = Number((evidence.orders?.paid_amount as number | undefined) ?? NaN);
  const fee = Number((evidence.sku_specs?.refundable_service_fee as number | undefined) ?? 0);
  const applied = refund.applied_amount;

  if (Number.isFinite(paid)) {
    const cap = paid + fee;
    criteria.push({
      id: "C1",
      statement: `可退上限 = paid_amount + refundable_service_fee = ${paid} + ${fee} = ${cap}`,
      basis: ["orders.paid_amount", "sku_specs.refundable_service_fee"],
    });
    if (applied > cap) {
      conflicts.push(`申请金额 ${applied} 超过可退上限 ${cap}`);
    } else {
      criteria.push({
        id: "C2",
        statement: `申请金额 ${applied} 未超过可退上限 ${cap}，金额口径一致`,
        basis: ["refunds.applied_amount", "orders.paid_amount"],
      });
    }
  } else {
    conflicts.push("缺少订单实付金额，无法核算可退上限");
  }

  const signed = evidence.logistics?.signed;
  if (typeof signed === "boolean") {
    criteria.push({
      id: "C3",
      statement: `物流签收事实：signed=${signed}，签收人=${String(evidence.logistics?.signer ?? "未知")}`,
      basis: ["logistics.signed", "logistics.signer"],
    });
    if (refund.reason_code === "NOT_RECEIVED" && signed) {
      conflicts.push("理由为「未收到货」，但物流显示已签收，事实冲突");
    }
  } else {
    conflicts.push("缺少物流签收事实，无法核对理由是否成立");
  }

  if (evidence.tickets) {
    criteria.push({
      id: "C4",
      statement: `客服工单已核验，记录条数 ${Number(evidence.tickets.count ?? 0)}`,
      basis: ["tickets.content"],
    });
  }

  for (const d of policy.ambiguous_detectors) {
    const signer = String(evidence.logistics?.signer ?? "");
    if (
      d.when.reason_code === refund.reason_code &&
      String(d.when.logistics_signer_contains ?? "") &&
      signer.includes(String(d.when.logistics_signer_contains))
    ) {
      ambiguous.push(d.note);
    }
  }

  const cap = Number.isFinite(paid) ? paid + fee : applied;
  const decision: Judgment["decision"] = conflicts.length ? "NEED_MORE_INFO" : case_type === "EXCHANGE" ? "EXCHANGE" : "REFUND";

  return {
    refund_id: refund.refund_id,
    decision,
    amount: Math.min(applied, cap),
    criteria,
    conflicts,
    ambiguous,
    rationale: conflicts.length
      ? `存在未澄清的事实/口径冲突 ${conflicts.length} 项，暂不出最终处置结论，需补证或人工澄清。`
      : `证据链与金额口径一致，建议按可退上限 ${Math.min(applied, cap)} 处置。`,
    judge_source: "offline_rule",
  };
}
