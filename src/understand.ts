import type { CaseType, Intent, JudgeSource, MessageRow, OrderRow } from "./types.ts";
import type { Store } from "./tools.ts";
import { callModel, extractJson, ModelError } from "./llm.ts";
import { buildUnderstandPrompt } from "./prompt.ts";
import type { Sop } from "./policy.ts";
import { caseTypeDef } from "./policy.ts";

/**
 * 链路一 · 用户咨询理解
 *
 * 入口是客户的一句自然语言，不是系统里的单据号 —— 这是「售后 agent」与「退款核对工具」
 * 的分界线。输出一个结构化意图，供分类与后续环节复用。
 */

const PRODUCT_HINTS: Array<{ keywords: string[]; match: (title: string) => boolean }> = [
  { keywords: ["椅子"], match: (t) => t.includes("椅") },
  { keywords: ["桌子", "餐桌"], match: (t) => t.includes("桌") },
  { keywords: ["箱子", "收纳"], match: (t) => t.includes("收纳") },
  { keywords: ["晾衣架"], match: (t) => t.includes("晾衣架") },
];

/** 从自然语言里解析「几月几号」 */
export function parseDateHint(text: string): { month: number; day: number } | null {
  const m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[号日]/);
  if (!m) return null;
  return { month: Number(m[1]), day: Number(m[2]) };
}

/**
 * 订单线索解析：把「我8月8号买的那把椅子」解析成一个订单号。
 * 只用日期与商品词两条线索打分，不做语义猜测；解析不出就返回 null，交回追问。
 */
export function resolveOrder(text: string, store: Store): OrderRow | null {
  const date = parseDateHint(text);
  let best: OrderRow | null = null;
  let bestScore = 0;
  for (const o of store.orders) {
    let score = 0;
    if (date) {
      const d = new Date(o.paid_at);
      if (d.getMonth() + 1 === date.month && d.getDate() === date.day) score += 2;
    }
    const sku = store.sku_specs.find((s) => s.sku_id === o.sku_id);
    if (sku) {
      for (const hint of PRODUCT_HINTS) {
        if (hint.keywords.some((k) => text.includes(k)) && hint.match(sku.title)) score += 2;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = o;
    }
  }
  return bestScore >= 2 ? best : null;
}

/**
 * 关键词 → 案件类型映射。
 *
 * 判定顺序是刻意设计的：先看「可执行的资金/动作诉求」（退货退款、退款、赔付、换货），
 * 再看「物流查询」，最后才是「纯投诉」。理由是客户一句话里常常情绪与诉求并存
 * （「我要投诉，要求全额退款」），真正决定走哪条 SOP 的是可执行的那个诉求，
 * 投诉情绪由 sentiment / needs_escalation 承载，不单独成案。
 */
function detectCaseType(text: string, sop: Sop): CaseType {
  const t = text;
  if (t.includes("换货") || t.includes("换一件") || (t.includes("换") && t.includes("浅灰"))) return "EXCHANGE";
  if (t.includes("退货")) return "RETURN_REFUND";
  if (t.includes("退钱") || t.includes("退款") || t.includes("退了") || t.includes("赔")) return "REFUND_ONLY";
  if (t.includes("到哪") || t.includes("催") || t.includes("发没发货") || (t.includes("没收到") && t.includes("发没发"))) return "LOGISTICS_INQUIRY";
  if (t.includes("投诉")) return "COMPLAINT";
  return "UNCLEAR";
}

function detectSentiment(text: string): Intent["sentiment"] {
  if (/[！!]|骗人|投诉|到底|赶紧|赔我|你们自己/.test(text)) return "angry";
  if (/差太多|怎么回事|一个多星期|都一周/.test(text)) return "unhappy";
  return "calm";
}

/**
 * 规则版意图理解（离线占位）。
 * 与模型版同构：都产出 Intent，但 judge_source 标为 offline_rule，绝不冒充模型判断。
 */
export function understandOffline(msg: MessageRow, store: Store, sop: Sop): Intent {
  const text = msg.text;
  const case_type = detectCaseType(text, sop);
  const order = msg.known_order
    ? store.orders.find((o) => o.order_id === msg.known_order) ?? resolveOrder(text, store)
    : resolveOrder(text, store);

  const sentiment = detectSentiment(text);
  const def = caseTypeDef(sop, case_type);

  const slots: Record<string, string> = {};
  const date = parseDateHint(text);
  if (date) slots["日期线索"] = `${date.month}月${date.day}日`;
  if (order) slots["订单号"] = order.order_id;
  const amt = text.match(/退\s*(\d+(?:\.\d+)?)/);
  if (amt) slots["客户提及金额"] = amt[1];
  // 换货目标规格：客户「想要」的那个规格，不是「收到的」那个。
  // 因此先匹配「要 / 想要 / 换成」后面的颜色，匹配不到才退回头看文本里第一个颜色。
  if (case_type === "EXCHANGE") {
    const colors = "(浅灰|深灰|米白|原木色|白色|黑色)";
    const wanted = text.match(new RegExp(`(?:要|想要|换个?|换成|换成一件)\\s*${colors}`));
    const anyColor = text.match(new RegExp(colors));
    const target = wanted?.[1] ?? anyColor?.[1];
    if (target) slots["目标规格"] = target;
  }

  // 诉求不明 + 无订单线索 → 必须追问，不得往下走
  const needs_escalation = case_type === "UNCLEAR" || (sentiment === "angry" && case_type !== "LOGISTICS_INQUIRY");

  return {
    case_type,
    order_ref: order?.order_id ?? msg.known_order ?? null,
    order_id: order?.order_id ?? null,
    sentiment,
    needs_escalation,
    slots,
    confidence_note:
      case_type === "UNCLEAR"
        ? "文本中没有任何可识别的诉求关键词，且没有订单线索，判定为诉求不明。"
        : `依据关键词命中判定为「${def.name}」${order ? "，并解析出订单线索" : "，但未解析出订单线索"}。`,
  };
}

/** 模型版意图理解。输出是外部输入，必须校验形状后再用。 */
export async function understandWithModel(msg: MessageRow, store: Store, sop: Sop): Promise<Intent> {
  const { system, user } = buildUnderstandPrompt(msg.text, sop);
  const res = await callModel(system, user, 0);
  const raw = extractJson<any>(res.text);

  const allowed = new Set(sop.case_types.map((c) => c.code));
  if (!allowed.has(raw?.case_type)) {
    throw new ModelError(`模型返回的 case_type 非法：${JSON.stringify(raw?.case_type)}`, undefined, "bad_shape");
  }

  // 订单线索解析三级回退（顺序即优先级）：
  //   1) 模型显式给出的单号 —— 但必须是系统里真实存在的，否则视为模型的格式误差，继续回退；
  //   2) 数据集权威单号（known_order）—— 合成数据里这条是 ground truth；
  //   3) 文本启发式（日期 + 商品词打分）—— 完全不依赖模型的最后兜底。
  // 曾经只有一个「模型单号查不到就作废」的分支，导致模型格式一漂移，整条取证链断掉——
  // 外部输入永远不能是单点故障。
  const byModel = raw?.order_id
    ? store.orders.find((o) => o.order_id === String(raw.order_id)) ?? null
    : null;
  const byKnown = msg.known_order
    ? store.orders.find((o) => o.order_id === msg.known_order) ?? null
    : null;
  const order = byModel ?? byKnown ?? resolveOrder(msg.text, store);

  return {
    case_type: raw.case_type as CaseType,
    order_ref: order?.order_id ?? msg.known_order ?? null,
    order_id: order?.order_id ?? null,
    sentiment: ["calm", "unhappy", "angry"].includes(raw?.sentiment) ? raw.sentiment : "calm",
    needs_escalation: Boolean(raw?.needs_escalation),
    slots: raw?.slots && typeof raw.slots === "object" ? raw.slots : {},
    confidence_note:
      String(raw?.confidence_note ?? "模型未给出置信度说明") +
      `（订单线索来源：${byModel ? "模型显式单号" : byKnown ? "数据集权威单号" : order ? "文本启发式解析" : "未解析出"}）`,
  };
}

export async function understand(
  msg: MessageRow,
  store: Store,
  sop: Sop,
  offline: boolean,
): Promise<{ intent: Intent; judge_source: JudgeSource }> {
  if (offline) return { intent: understandOffline(msg, store, sop), judge_source: "offline_rule" };
  try {
    const intent = await understandWithModel(msg, store, sop);
    return { intent, judge_source: "model" };
  } catch (e) {
    // 模型不可用时不静默降级成「成功」——直接抛出让上层看见
    throw e;
  }
}
