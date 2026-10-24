import type { AuthDecision } from "./auth.ts";
import type { CaseType, JudgeSource, Reply, ReviewResult, VerdictKind } from "./types.ts";
import { callModel, extractJson, ModelError } from "./llm.ts";
import { buildReplyPrompt } from "./prompt.ts";

/**
 * 链路四 · 结果反馈
 *
 * 把内部结论转成两样东西：
 *   customer_text —— 可以直接发给客户的话（有温度、不含内部判据细节、不含未确认承诺）
 *   internal_note  —— 给客服/主管看的结单说明（含判据、授权档位、是否需人工跟进）
 */

export interface ReplyInput {
  case_type: CaseType;
  case_name: string;
  text: string;
  verdict: VerdictKind;
  auth: AuthDecision | null;
  review: ReviewResult;
  created: Array<{ kind: string; id: string; detail: string }>;
  follow_up_required: boolean;
  /** 物流签收事实（仅物流查询类回执使用），未取证时为 null */
  logistics_signed?: boolean | null;
}

/** 规则版反馈（离线占位） */
export function replyOffline(input: ReplyInput): Reply {
  const { case_type, verdict, auth, review, created } = input;
  let customer_text: string;
  let internal_note: string;

  // 分支顺序即优先级：
  //   1) 复核硬阻断 —— 最高优先。物流查询撞上事实冲突时，客户该收到的是核实请求而不是物流播报；
  //      负向验证下「诉求不明却被强行推进」也一样：该收到的是转人工，而不是追问短信。
  //   2) 已执行且经人工审批 —— 必须排在「告警 / 挂起」之前：批准后已经真的退了钱，
  //      回执还停在「已提交审批」就是把已完成说成未完成。
  //   3) 人工审批驳回 —— 不得写成已处理，也不得静默重试。
  //   4) 授权挂起（审批中 / 确认中）—— 未取得授权不得写成已处理。
  //   5) 案件类型（追问 / 物流播报 / 换货工单）
  //   6) 已执行的不可逆动作（小额直通）
  //   7) 通用兜底。
  if (verdict.startsWith("REJECT")) {
    const first = review.findings.find((f) => f.verdict === verdict);
    customer_text =
      verdict === "REJECT_AMOUNT"
        ? "您好，您申请的退款金额超出了该订单实付金额，我们只能按实付金额核算，已为您提交人工复核。"
        : verdict === "REJECT_FACT_CONFLICT"
          ? "您好，您反馈的情况与系统记录存在出入（物流显示已签收），为避免误判，我们需要先与您核实签收情况，核实后立即处理。"
          : "您好，该笔售后暂无法自动处理，已转交专人跟进，请留意后续联系。";
    internal_note = `被复核门禁阻断：${verdict}。判据：${(first?.because ?? "无").replace(/。$/, "")}。需人工介入。`;
  } else if (case_type === "UNCLEAR") {
    customer_text =
      "您好，为了尽快帮您处理，麻烦补充一下：这笔订单大致是哪天下单的、您希望的处理方式（退款 / 换货 / 仅催物流）？";
    internal_note = "诉求不明，按 SOP 先追问澄清，未进入取证与判责。";
  } else if (auth && auth.outcome === "AUTO_EXECUTED" && auth.tier === "APPROVE") {
    // 人工审批通过 → Agent 已继续执行
    customer_text = `您好，您的退款申请已通过人工审批，退款金额 ${auth.amount} 元将按原支付路径退回，请注意查收。`;
    internal_note = `人工审批通过（审批人 ${auth.approver}）后执行 ${auth.tool}，金额 ${auth.amount}。`;
  } else if (auth && auth.needs_human && auth.approval_decision === "REJECTED") {
    customer_text = "您好，该笔申请经人工复核后未予通过，我们已安排专人与您联系说明具体情况并协助后续处理。";
    internal_note = `人工审批驳回（审批人 ${auth.approver}），未执行 ${auth.tool}。金额 ${auth.amount} 超出可自动处置范围且未获批准。`;
  } else if (verdict === "WARN_AMBIGUOUS") {
    customer_text =
      "您好，您反馈的问题我们已记录并受理。此类签收情形需要专人核实责任归属，我们会在核实后第一时间回复您处理结果。";
    const authNote = auth ? `授权档位 ${auth.tier}（${auth.label}）｜${auth.outcome}。` : "无不可逆动作。";
    internal_note = `责任归属无确定口径，仅告警不阻断。${review.findings.map((f) => f.rule).join("、")}。${authNote}`;
  } else if (auth?.tier === "APPROVE" && auth.outcome === "PENDING_APPROVAL") {
    customer_text = "您好，您的退款申请已受理并提交人工审批，审批结果出来后会第一时间通知您，请留意站内消息。";
    internal_note = `金额 ${auth.amount} 超过自动执行阈值，挂起等待人工审批，Agent 无权执行。`;
  } else if (auth?.tier === "ASK" && auth.needs_human) {
    // 未取得人工确认（含「无人响应」与「被驳回」两种 outcome 值）——对外只说在确认中
    customer_text = "您好，您的申请已进入人工确认环节，确认后我们立即为您处理，处理结果会同步给您。";
    internal_note = `金额 ${auth.amount} 落在执行前询问档，尚未取得人工确认（${auth.outcome}），已挂起。`;
  } else if (case_type === "LOGISTICS_INQUIRY") {
    const signed = input.logistics_signed;
    customer_text =
      signed === false
        ? "您好，已为您查到该订单的物流状态：包裹已到达派送站，仍在派送中，尚未签收。我们已同步联系站点优先处理，请您再耐心等待；如需进一步帮助请告诉我们。"
        : signed === true
          ? "您好，已为您查到该订单的物流状态：包裹显示已签收。若您实际未收到，请告诉我们，我们会立即核实签收记录并跟进处理。"
          : "您好，已为您查询该订单的物流记录，暂未查到有效轨迹，我们已安排专人核实，稍后回复您。";
    internal_note = `物流查询类咨询，未产生资金动作，按 SOP 结单。签收事实：${signed === null || signed === undefined ? "未取证" : signed ? "已签收" : "未签收"}。`;
  } else if (case_type === "EXCHANGE") {
    const ex = created.find((c) => c.kind === "exchange");
    customer_text = ex
      ? `您好，换货工单已生成（单号 ${ex.id}），我们会尽快为您寄出同款，退回商品请按后续短信指引寄回。`
      : "您好，换货申请已受理，我们会尽快为您安排换发。";
    internal_note = ex ? `换货工单 ${ex.id} 已生成。` : "换货申请已受理。";
  } else if (auth && auth.outcome === "AUTO_EXECUTED") {
    customer_text = `您好，您的退款已处理完成，退款金额 ${auth.amount} 元将按原支付路径退回，请注意查收。`;
    internal_note = `授权闸放行并执行 ${auth.tool}，金额 ${auth.amount}。`;
  } else {
    customer_text = "您好，您的申请已受理，我们会尽快为您处理并回复结果。";
    internal_note = "已按 SOP 受理。";
  }

  return { customer_text, internal_note, follow_up_required: input.follow_up_required, reply_source: "offline_rule" };
}

/** 模型版反馈。同样校验形状，不吃默认值。 */
export async function replyWithModel(input: ReplyInput): Promise<Reply> {
  const { system, user } = buildReplyPrompt(input);
  const res = await callModel(system, user, 0.3);
  const raw = extractJson<any>(res.text);
  if (typeof raw?.customer_text !== "string" || !raw.customer_text.trim()) {
    throw new ModelError("模型未给出 customer_text", undefined, "bad_shape");
  }
  return {
    customer_text: String(raw.customer_text),
    internal_note: String(raw.internal_note ?? ""),
    // follow_up_required 由编排层按确定性安全逻辑计算（阻断 / 挂起 / 模糊 / 澄清 → true）。
    // 模型可以影响 customer_text 的措辞，但无权推翻这个安全标记——否则同一个字段在
    // 离线模式与模型模式下含义不一致，样本期望就失去意义。模型的意见只用于其措辞参考。
    follow_up_required: input.follow_up_required,
    reply_source: "model",
  };
}
