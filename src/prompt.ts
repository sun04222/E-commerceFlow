import type { CaseType, RefundRow, SourceName } from "./types.ts";
import type { Policy, Sop } from "./policy.ts";
import type { ReplyInput } from "./reply.ts";

/** 四段式提示词：角色与边界 / 可用证据与时机 / 输出格式 / 失败与兜底 */

// ── 链路一：咨询理解 ────────────────────────────────────────────────
export function buildUnderstandPrompt(text: string, sop: Sop): { system: string; user: string } {
  const types = sop.case_types.map((c) => `- ${c.code}｜${c.name}｜触发词：${c.trigger_intents.join("、") || "（无，需追问）"}`).join("\n");

  const system = [
    "【一、角色与边界】",
    "你是电商售后受理环节的「咨询理解」角色。你只做一件事：把客户的一句自然语言，归一成一个结构化意图。",
    "你不查任何系统、不给任何承诺、不修改任何单据。订单号解析不出来时，order_id 填 null，由下游决定是否追问。",
    "",
    "【二、可用分类与时机】",
    "可选案件类型如下，只能选其中一个；没有任何触发词命中时选 UNCLEAR：",
    types,
    "",
    "【二·补、类型判定优先级（必须遵守）】",
    "客户一句话里情绪与诉求常常并存。判定 case_type 时，以「可执行的诉求」为准：",
    "1) 同时出现情绪性投诉（投诉、骗人、差评、气愤）与可执行诉求（退款 / 退钱 / 赔付 / 换货 / 退货）时，",
    "   选可执行诉求对应的类型（REFUND_ONLY / RETURN_REFUND / EXCHANGE），不得选 COMPLAINT；",
    "2) 投诉情绪只体现在 sentiment（至少 unhappy）与 needs_escalation（true）两个字段里；",
    "3) 只有纯情绪表达、没有任何可执行诉求时，才选 COMPLAINT。",
    "",
    "【三、输出格式】",
    '只输出一个 JSON 对象，不要解释文字，不要代码围栏：',
    '{"case_type":"...","order_id":"订单号或null","sentiment":"calm|unhappy|angry","',
    ' "needs_escalation":true或false,"slots":{"客户提到的日期/金额等":"值"},"confidence_note":"你的判断依据"}',
    "",
    "【四、失败与兜底】",
    "1) 文本没有任何可识别诉求时，case_type 必须是 UNCLEAR，不得硬猜一个类型。",
    "2) 客户情绪激烈（感叹号、质疑平台、要求赔偿）时 sentiment 至少 unhappy。",
    "3) 不得编造订单号；解析不出就填 null。",
  ].join("\n");

  const user = ["【客户原话】", text, "", "请按第三段格式输出 JSON。"].join("\n");
  return { system, user };
}

// ── 链路三：判据归纳 ────────────────────────────────────────────────
export interface JudgeInput {
  text: string;
  case_name: string;
  refund: RefundRow | null;
  evidence: Partial<Record<SourceName, Record<string, unknown>>>;
  policy: Policy;
  context_block: string;
}

export function buildJudgePrompt(input: JudgeInput): { system: string; user: string } {
  const { text, case_name, refund, evidence, policy, context_block } = input;

  const contract = Object.entries(policy.field_contract)
    .map(([k, v]) => `- ${k}｜来源 ${v.source}｜口径：${v.meaning}`)
    .join("\n");
  const got = Object.keys(evidence).join("、") || "（无）";

  const system = [
    "【一、角色与边界】",
    "你是电商售后处置流程中的「判据归纳」角色。你只做一件事：基于给定证据与规则，产出判据与处置建议。",
    "你不执行任何操作，不调用任何工具，不修改金额，不臆造未提供的字段值。",
    "放行与否由独立的授权闸与只读复核决定，你只负责把判据讲清楚。",
    "",
    "【二、可用证据与时机】",
    `案件类型：${case_name}。本次实际取到的来源：${got}。未取到的来源一律视为未知，不得假设其内容。`,
    "字段口径契约（判断时以此为准）：",
    contract,
    "计算口径：可退上限 = paid_amount + refundable_service_fee；applied_amount 是申请金额，不是判定金额。",
    "",
    context_block,
    "",
    "【三、输出格式】",
    "只输出一个 JSON 对象，不要解释文字，不要代码围栏：",
    '{"decision":"REFUND|PARTIAL_REFUND|EXCHANGE|REJECT|NEED_MORE_INFO|INQUIRY",',
    ' "amount":数字,"criteria":[{"id":"C1","statement":"判据内容","basis":["依据字段名"]}],',
    ' "conflicts":["事实或口径冲突"],"ambiguous":["规则未覆盖的部分"],"rationale":"一段推理"}',
    "",
    "【四、失败与兜底】",
    "1) 证据不足时 decision 必须为 NEED_MORE_INFO，并在 conflicts 写清缺什么。",
    "2) 规则未给出确定口径时写进 ambiguous，不得自行发明口径。",
    "3) 不得编造未提供的字段值；criteria 至少一条，一条都写不出来时 decision 必须是 NEED_MORE_INFO。",
  ].join("\n");

  const rules = [
    "金额规则：",
    ...policy.amount_rules.map((r) => `- ${r.id}｜${r.check}｜违反则 ${r.verdict_on_fail}`),
    "一致性规则：",
    ...policy.consistency_rules.map((r) => `- ${r.id}｜${JSON.stringify(r.when)}｜${r.verdict}｜${r.because}`),
    "模糊地带：",
    ...policy.ambiguous_detectors.map((d) => `- ${d.id}｜${d.note}`),
  ].join("\n");

  const user = [
    "【客户原话】",
    text,
    "",
    "【待处置单据】",
    refund ? `退款单 ${refund.refund_id}｜申请金额 ${refund.applied_amount}｜理由 ${refund.reason_code}（${refund.reason_text}）` : "系统内尚无退款单",
    "",
    "【证据快照】",
    JSON.stringify(evidence, null, 2),
    "",
    "【适用规则】",
    rules,
    "",
    "请输出符合第三段格式的 JSON。",
  ].join("\n");

  return { system, user };
}

// ── 链路四：结果反馈 ────────────────────────────────────────────────
export function buildReplyPrompt(input: ReplyInput): { system: string; user: string } {
  const system = [
    "【一、角色与边界】",
    "你是电商售后结单环节的「结果反馈」角色。你把内部结论转成两段文字。",
    "customer_text 是直接发给客户的话：有温度、不含内部判据细节、不做未获授权的承诺。",
    "internal_note 是给客服/主管看的结单说明：含判据、授权档位、是否需人工跟进。",
    "你不执行任何操作，不承诺系统未确认的结果（例如未获授权的退款不得写成已退）。",
    "",
    "【二、可用信息与时机】",
    `案件类型：${input.case_name}。复核裁决：${input.verdict}。授权档位：${input.auth?.tier ?? "无（未进入授权）"}。`,
    `已生成单据：${input.created.map((c) => c.detail).join("；") || "无"}`,
    "",
    "【三、输出格式】",
    '只输出一个 JSON 对象：{"customer_text":"...","internal_note":"...","follow_up_required":true或false}',
    "",
    "【四、失败与兜底】",
    "1) 复核被阻断时，customer_text 必须说明「需人工核实/跟进」，不得写成已处理完成。",
    "2) 授权未取得时，不得写成已退款或已换货。",
    "3) 不得透露内部规则编号、字段名与判据细节给客户。",
  ].join("\n");

  const user = [
    "【客户原话】",
    input.text,
    "",
    "【复核发现】",
    input.review.findings.map((f) => `- [${f.rule}] ${f.verdict} ${f.because}`).join("\n") || "（无）",
    "",
    "【授权状态】",
    input.auth ? `${input.auth.tier}｜${input.auth.label}｜${input.auth.outcome}｜${input.auth.because}` : "未进入授权",
    "",
    "请按第三段格式输出 JSON。",
  ].join("\n");

  return { system, user };
}
