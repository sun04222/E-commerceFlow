// 领域类型定义 —— 全部为可辨识联合，不用 enum（Node 类型擦除不支持含运行时的 TS 语法）

/** 五环节 SOP 的环节标识，与 data/sop.json 的 stages 一一对应 */
export type Phase = "accept" | "investigate" | "judge" | "approve" | "close";

export type SourceName = "orders" | "refunds" | "sku_specs" | "logistics" | "tickets" | "action";

export type CaseType = "REFUND_ONLY" | "RETURN_REFUND" | "EXCHANGE" | "LOGISTICS_INQUIRY" | "COMPLAINT" | "UNCLEAR";

export type AuthTier = "AUTO" | "EXECUTE" | "ASK" | "APPROVE" | "BY_AMOUNT";

export type VerdictKind =
  | "PASS"
  | "CLARIFY_NEEDED"
  | "REJECT_MISSING_EVIDENCE"
  | "REJECT_FACT_CONFLICT"
  | "REJECT_AMOUNT"
  | "REJECT_NO_CRITERIA"
  | "REJECT_STAGE_VIOLATION"
  | "WARN_AMBIGUOUS";

export type SampleGrade = "GOLD" | "BAD" | "AMBIGUOUS";

export type JudgeSource = "model" | "offline_rule";

// ── 数据行 ──────────────────────────────────────────────────────────
export interface OrderRow {
  order_id: string;
  buyer_id: string;
  sku_id: string;
  qty: number;
  paid_amount: number;
  currency: string;
  paid_at: string;
  status: string;
  sales_channel: string;
}

export interface SkuRow {
  sku_id: string;
  title: string;
  unit_price: number;
  spec: Record<string, string | boolean>;
  refundable_service_fee: number;
}

export interface LogisticsRow {
  order_id: string;
  carrier: string;
  signed: boolean;
  signer: string;
  nodes: Array<{ at: string; event: string; station: string; signer?: string }>;
}

export interface RefundRow {
  refund_id: string;
  order_id: string;
  applied_amount: number;
  reason_code: string;
  reason_text: string;
  applied_at: string;
  status: string;
}

export interface TicketRow {
  ticket_id: string;
  order_id: string;
  created_at: string;
  agent: string;
  content: string;
}

export interface MessageRow {
  msg_id: string;
  text: string;
  known_order: string | null;
}

// ── 链路一：咨询理解 ────────────────────────────────────────────────
export interface Intent {
  /** 归一后的诉求类型，直接映射到 SOP 的 case_types */
  case_type: CaseType;
  /** 客户提到的订单线索（可能是订单号，也可能是日期+商品的自然语言描述） */
  order_ref: string | null;
  /** 解析到的订单号（resolveOrder 之后填入） */
  order_id: string | null;
  /** 情绪烈度 */
  sentiment: "calm" | "unhappy" | "angry";
  /** 是否需要立刻交人 */
  needs_escalation: boolean;
  /** 关键槽位，供下游复用 */
  slots: Record<string, string>;
  /** 理解置信度的说明，用于诚实标注 */
  confidence_note: string;
}

// ── 链路二：问题分类 ────────────────────────────────────────────────
export interface Classification {
  case_type: CaseType;
  case_name: string;
  sop_path: "full" | "light" | "clarify";
  required_sources: SourceName[];
  money_action: string | null;
  requires_return: boolean;
  /** 是否需要新建工单（系统里没有对应单据时） */
  needs_new_ticket: boolean;
  /** 分类依据 */
  because: string;
}

// ── 链路三：工单 / 业务单据处理 ─────────────────────────────────────
export interface FetchRecord {
  source: SourceName;
  tool: string;
  args: Record<string, unknown>;
  args_hash: string;
  at: string;
  rows: number;
  fields_snapshot: Record<string, unknown>;
}

export interface Judgment {
  refund_id: string | null;
  decision: "REFUND" | "PARTIAL_REFUND" | "EXCHANGE" | "REJECT" | "NEED_MORE_INFO" | "INQUIRY";
  amount: number;
  criteria: Array<{ id: string; statement: string; basis: string[] }>;
  conflicts: string[];
  ambiguous: string[];
  rationale: string;
  judge_source: JudgeSource;
}

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
  /** 审批人 / 决策 / 时间戳 —— 三项全链路留痕 */
  approver?: string;
  approval_decision?: string;
  approval_at?: string;
}

// ── 链路四：结果反馈 ────────────────────────────────────────────────
export interface Reply {
  /** 可直接发给客户的文本 */
  customer_text: string;
  /** 内部结单说明（给客服/主管看的） */
  internal_note: string;
  /** 是否需要人工跟进 */
  follow_up_required: boolean;
  reply_source: JudgeSource;
}

// ── 三层上下文 ─────────────────────────────────────────────────────
export interface ContextLayer {
  layer: "summary" | "schema" | "field_contract";
  name: string;
  content: string;
  disclosed: boolean;
}

// ── 复核 ───────────────────────────────────────────────────────────
export interface ReviewFinding {
  rule: string;
  verdict: VerdictKind;
  because: string;
  missing?: SourceName[];
}

export interface ReviewResult {
  verdict: VerdictKind;
  findings: ReviewFinding[];
  missing_evidence: SourceName[];
  requery_plan: Array<{ tool: string; args: Record<string, unknown> }>;
  stage_violations: string[];
  readonly: true;
}

// ── 轨迹 ───────────────────────────────────────────────────────────
export interface TraceLine {
  seq: number;
  at: string;
  phase: Phase;
  kind: "understand" | "classify" | "plan" | "tool_call" | "judge" | "auth" | "review" | "reply" | "gate";
  summary: string;
  detail: Record<string, unknown>;
}

// ── 样本 ───────────────────────────────────────────────────────────
export interface SampleCase {
  sample_id: string;
  grade: SampleGrade;
  msg_id: string;
  title: string;
  expect: {
    case_type: CaseType;
    verdict: VerdictKind;
    /** 授权档位；auth 为 null（无不可逆动作 / 被门禁阻断未进入授权）时记 AUTO */
    auth_tier: AuthTier;
    requires_requery: boolean;
    follow_up_required: boolean;
    /** 是否真的执行了不可逆动作 */
    executed: boolean;
  };
}

// ── 待人工审批单 ───────────────────────────────────────────────────
/**
 * 自主模式下，大额处置不会「当场问一句就继续」，也不会永远卡死——而是生成一张待审批单
 * 交给使用者在审批中心裁决。单子自带足以在 15 秒内做判断的全部信息：
 * 停办理由、判断依据、金额与上限、批准与驳回各自的后果。
 */
export interface PendingApproval {
  /** 审批单号 */
  id: string;
  msg_id: string;
  /** 业务口径的案件名 */
  case_name: string;
  /** 客户原话（审批人判断的第一依据） */
  customer_text: string;
  /** 触发停办的业务动作，如 refund / exchange（展示层再翻译成业务话术） */
  action: string;
  /** 金额与上限：金额 > 上限，所以必须过人 */
  amount: number;
  auto_limit: number;
  tier: AuthTier;
  /** 为什么停在这里（政策口径） */
  stop_reason: string;
  /** Agent 的判断依据（判据 + 关键事实） */
  basis: string[];
  /** Agent 考虑过但不能据此强判的不确定项（把备选摊开，避免审批人只看结论） */
  uncertainties: string[];
  /** 批准后会发生什么 */
  if_approved: string;
  /** 驳回后会发生什么 */
  if_rejected: string;
  /** 客户当前收到的临时回复 */
  holding_reply: string;
  requested_at: string;
}

// ── 端到端结果 ─────────────────────────────────────────────────────
/**
 * 一次召回命中的历史案件。**只为「给人和模型看」而存在。**
 * 类型定义放在这里（而不是 memory.ts）是为了让 types.ts 保持零依赖：
 * 构建单文件版时模块清单是手写的，类型反向引用会把模块拓扑弄成环。
 */
export interface MemoryHit {
  key: string;
  msg_id: string;
  at: string;
  case_type: string;
  case_name: string;
  verdict: string;
  decision: string;
  amount: number | null;
  outcome: string;
  score: number;
  /** 为什么召回它 —— 人话，界面上直接显示 */
  why: string[];
}

/**
 * 执行预算的实际消耗。刻意只记录、不参与判定：
 * 预算是「别让它无限跑」，不是「少花点钱换个结论」。
 */
export interface RunBudgetReport {
  model_calls: number;
  model_limit: number;
  tool_calls: number;
  tool_limit: number;
  requery_rounds: number;
  requery_limit: number;
  /** 哪几处因为预算耗尽而降级（例如 "判据归纳" 退回规则判定）；空数组表示没降级 */
  degraded: string[];
}

export interface CaseRunResult {
  msg_id: string;
  text: string;
  sample_id: string | null;
  grade: SampleGrade | null;
  title: string | null;
  understanding: Intent & { judge_source: JudgeSource };
  classification: Classification;
  evidence_sources: SourceName[];
  requery_rounds: number;
  requery_tools: string[];
  judge: Judgment;
  review: ReviewResult;
  auth: AuthDecision | null;
  executed_tool: string | null;
  execution_outcome: string;
  reply: Reply;
  stages_completed: Phase[];
  trace_path: string;
  /** 轨迹真正写盘的次数（缓冲批量写之后应远小于步数）；只作可观测性，不参与判定 */
  trace_writes?: number;
  /** 执行预算的实际消耗与是否发生过降级；只作可观测性，不参与判定 */
  budget?: RunBudgetReport;
  /**
   * 本次参考过的历史同类案件（advisory）。
   * 三个地方会读它：界面右栏「同类案子过去怎么处理的」、轨迹留痕、离线复盘。
   * **它不参与判定、不进授权闸** —— 金额档位只认订单账本，记忆永远只是提示。
   */
  memory_hits?: MemoryHit[];
  expected?: SampleCase["expect"];
  /** 自主模式下挂起待人工审批时存在；批准 / 驳回后由续办流程清除 */
  pending_approval?: PendingApproval;
}
