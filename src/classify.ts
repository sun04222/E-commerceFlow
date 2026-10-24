import type { CaseType, Classification } from "./types.ts";
import type { Store } from "./tools.ts";
import { caseTypeDef, type Sop } from "./policy.ts";

/**
 * 链路二 · 售后问题分类
 *
 * 把归一后的诉求映射到 SOP 里的案件类型，从而决定：
 *   - 走 full / light / clarify 哪条路径
 *   - 必须取哪几类证据（这是只读 Reviewer 判定「取证完整性」的依据）
 *   - 是否需要新建业务单据
 */
export function classify(intentCaseType: CaseType, orderId: string | null, store: Store, sop: Sop): Classification {
  const def = caseTypeDef(sop, intentCaseType);

  const hasRefund = orderId ? store.refunds.some((r) => r.order_id === orderId) : false;
  const moneyCase = def.money_action !== null;
  const needs_new_ticket = moneyCase && !hasRefund;

  const because =
    intentCaseType === "UNCLEAR"
      ? "诉求无法归一，SOP 规定先追问澄清，不进入取证与判责。"
      : `归一为「${def.name}」，按 SOP 走 ${def.sop_path} 路径；要求证据 ${def.required_sources.join(" + ")}。` +
        (needs_new_ticket ? "系统内尚无对应退款单，需在流程中新建工单。" : "");

  return {
    case_type: def.code,
    case_name: def.name,
    sop_path: def.sop_path,
    required_sources: def.required_sources,
    money_action: def.money_action,
    requires_return: def.requires_return,
    needs_new_ticket,
    because,
  };
}
