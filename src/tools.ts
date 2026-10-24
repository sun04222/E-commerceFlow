import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./llm.ts";
import { DATA_DIR, readJson } from "./env.ts";
import type {
  FetchRecord,
  LogisticsRow,
  MessageRow,
  OrderRow,
  Phase,
  RefundRow,
  SkuRow,
  SourceName,
  TicketRow,
  ToolSpec,
} from "./types.ts";

// ── 声明式工具注册表 ────────────────────────────────────────────────
export interface ToolDecl {
  short: string;
  source: SourceName;
  title: string;
  read_only: boolean;
  money_action: boolean;
  phases: Phase[];
  signature: Record<string, string>;
}

export interface ToolRegistry {
  namespace: string;
  tools: ToolDecl[];
}

export function loadRegistry(): ToolRegistry {
  return readJson<ToolRegistry>("tool-registry.json");
}

export interface Store {
  orders: OrderRow[];
  refunds: RefundRow[];
  sku_specs: SkuRow[];
  logistics: LogisticsRow[];
  tickets: TicketRow[];
  messages: MessageRow[];
}

export function loadStore(): Store {
  return {
    orders: readJson<{ rows: OrderRow[] }>("orders.json").rows,
    refunds: readJson<{ rows: RefundRow[] }>("refunds.json").rows,
    sku_specs: readJson<{ rows: SkuRow[] }>("sku_specs.json").rows,
    logistics: readJson<{ rows: LogisticsRow[] }>("logistics.json").rows,
    tickets: readJson<{ rows: TicketRow[] }>("tickets.json").rows,
    messages: readJson<{ rows: MessageRow[] }>("messages.json").rows,
  };
}

/** 全限定名生成 —— 统一命名空间，杜绝跨系统工具同名覆盖 */
export function fq(namespace: string, short: string): string {
  return `${namespace}.${short}`;
}

export interface RunContext {
  order: OrderRow | null;
  refund: RefundRow | null;
  fetched: Map<SourceName, unknown>;
  /** 流程中生成的业务单据（退货运单 / 换货工单），用于结单回执 */
  created: Array<{ kind: string; id: string; detail: string }>;
}

type Runner = (args: Record<string, unknown>, ctx: RunContext) => Record<string, unknown> | null;

/**
 * 从声明式注册表构建工具面。
 *
 * 这是简历要点一的落点：全部工具挂在统一命名空间下；每个工具自己声明
 * 「允许出现在哪些环节 / 是否只读 / 是否资金类动作」。
 * 新增一个数据源 = 在 data/tool-registry.json 加一条声明 + 在这里挂一个执行体，
 * 装配、命名空间、授权分档、三层上下文全部自动继承，编排代码不用改。
 */
export function buildTools(reg: ToolRegistry, store: Store): ToolSpec[] {
  const runners: Record<string, Runner> = {
    query_order: (a, ctx) => {
      const row = ctx.order;
      return row && row.order_id === String(a.order_id) ? { source: "orders", row } : null;
    },
    query_refund: (a, ctx) => {
      const row = ctx.refund;
      return row && row.refund_id === String(a.refund_id) ? { source: "refunds", row } : null;
    },
    query_sku_spec: (a) => {
      const row = store.sku_specs.find((r) => r.sku_id === String(a.sku_id));
      return row ? { source: "sku_specs", row } : null;
    },
    query_logistics: (a) => {
      const row = store.logistics.find((r) => r.order_id === String(a.order_id));
      return row ? { source: "logistics", row } : null;
    },
    query_ticket: (a) => {
      const rows = store.tickets.filter((r) => r.order_id === String(a.order_id));
      return rows.length ? { source: "tickets", rows } : null;
    },
    create_return_label: (a, ctx) => {
      const id = `RL-${Date.now().toString().slice(-8)}`;
      ctx.created.push({
        kind: "return_label",
        id,
        detail: `退货运单｜订单 ${String(a.order_id)}｜原因 ${String(a.reason)}`,
      });
      return { source: "action", created: { kind: "return_label", id } };
    },
    create_exchange: (a, ctx) => {
      const id = `EX-${Date.now().toString().slice(-8)}`;
      ctx.created.push({
        kind: "exchange",
        id,
        detail: `换货工单｜订单 ${String(a.order_id)}｜目标 ${String(a.target_spec)}`,
      });
      return { source: "action", created: { kind: "exchange", id } };
    },
    decide_refund: (a, ctx) => ({
      source: "action",
      executed: true,
      refund_id: String(a.refund_id),
      decision: String(a.decision),
      amount: Number(a.amount),
      order_id: ctx.order?.order_id ?? null,
    }),
  };

  return reg.tools.map((d) => ({
    name: fq(reg.namespace, d.short),
    namespace: reg.namespace,
    short: d.short,
    source: d.source,
    title: d.title,
    readOnly: d.read_only,
    moneyAction: d.money_action,
    phases: d.phases,
    signature: d.signature,
    run: runners[d.short] ?? (() => null),
  }));
}

/** 按环节动态装配可见工具集 —— 环节由 SOP 决定，不由模型决定 */
export function assemble(tools: ToolSpec[], phase: Phase): ToolSpec[] {
  return tools.filter((t) => t.phases.includes(phase));
}

/** 供提示词使用的工具清单（只暴露当前环节可见的那些） */
export function toolCatalog(tools: ToolSpec[], phase: Phase): string {
  return assemble(tools, phase)
    .map(
      (t) =>
        `- ${t.name}｜${t.title}｜${
          t.readOnly ? "只读" : t.moneyAction ? "可执行·资金类(按金额分档)" : "可执行·不可逆(需确认)"
        }｜入参 ${sig(t)}`,
    )
    .join("\n");
}

function sig(t: ToolSpec): string {
  const entries = Object.entries(t.signature).map(([k, v]) => `${k}: ${v}`);
  return `{ ${entries.join(", ")} }`;
}

/** 快照：只留判据真正用到的字段，不把整行灌进上下文 */
function snapshot(source: SourceName, payload: Record<string, unknown>): Record<string, unknown> {
  const row: any = payload.row ?? null;
  const rows: any[] = (payload.rows as any[]) ?? (row ? [row] : []);
  switch (source) {
    case "orders":
      return { paid_amount: row?.paid_amount, sku_id: row?.sku_id, status: row?.status, paid_at: row?.paid_at };
    case "refunds":
      return {
        applied_amount: row?.applied_amount,
        reason_code: row?.reason_code,
        reason_text: row?.reason_text,
        applied_at: row?.applied_at,
      };
    case "sku_specs":
      return { title: row?.title, spec: row?.spec, refundable_service_fee: row?.refundable_service_fee };
    case "logistics":
      return { signed: row?.signed, signer: row?.signer, nodes: row?.nodes?.length ?? 0 };
    case "tickets":
      return { count: rows.length, first_content: rows[0]?.content ?? null, created_at: rows[0]?.created_at ?? null };
    default:
      return payload;
  }
}

export interface CallResult {
  record: FetchRecord;
  payload: Record<string, unknown> | null;
}

/** 走一次工具调用，并把它落成可回放的取数记录 */
export function invoke(tool: ToolSpec, args: Record<string, unknown>, ctx: RunContext): CallResult {
  const argsStr = JSON.stringify(args ?? {});
  const payload = tool.run(args ?? {}, ctx);
  const record: FetchRecord = {
    source: tool.source,
    tool: tool.name,
    args: args ?? {},
    args_hash: sha256(tool.name + "|" + argsStr),
    at: new Date().toISOString(),
    rows: payload ? (Array.isArray((payload as any).rows) ? (payload as any).rows.length : 1) : 0,
    fields_snapshot: payload ? snapshot(tool.source, payload) : {},
  };
  return { record, payload };
}

/** 读注册表原文，供三层上下文的 Schema 层按需展开 */
export function registryRaw(): string {
  return readFileSync(join(DATA_DIR, "tool-registry.json"), "utf8");
}
