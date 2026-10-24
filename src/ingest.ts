import type { LogisticsRow, OrderRow, RefundRow, SkuRow, Store, TicketRow } from "./tools.ts";
import type { SourceName } from "./types.ts";

/**
 * 数据导入（Ingest）
 *
 * 定位：把「外部平台数据」变成引擎认得的数据行。
 * 这里是整条数据接入链路的收口 —— MCP 连接器拉回来的、用户粘的 CSV、上传的 JSON，
 * 最后都走 mergeRows() 落到同一份 store 上，因此：
 *   · 只有一处校验口径（缺主键 / 类型不对一律拒绝并报错，不吃默认值）
 *   · 只有一处合并口径（按主键 upsert，重复导入不会产生脏数据）
 *   · 引擎的取数工具读的就是这份 store，导入完立刻对新案件生效
 */

export type Dataset = Exclude<SourceName, "action">;

export const DATASETS: Dataset[] = ["orders", "refunds", "sku_specs", "logistics", "tickets"];

/** 每个数据集的主键与其列定义：列定义同时用于 CSV 表头校验与 JSON 字段裁剪 */
export const DATASET_SPEC: Record<Dataset, { key: string; label: string; fields: Record<string, string> }> = {
  orders: {
    key: "order_id",
    label: "订单",
    fields: {
      order_id: "订单号",
      buyer_id: "买家 ID",
      sku_id: "商品规格 ID",
      qty: "数量",
      paid_amount: "实付金额",
      currency: "币种",
      paid_at: "支付时间",
      status: "订单状态",
      sales_channel: "销售渠道",
    },
  },
  refunds: {
    key: "refund_id",
    label: "退款单",
    fields: {
      refund_id: "退款单号",
      order_id: "订单号",
      applied_amount: "申请退款金额",
      reason_code: "退款原因码",
      reason_text: "退款原因",
      applied_at: "申请时间",
      status: "处理状态",
    },
  },
  sku_specs: {
    key: "sku_id",
    label: "商品规格",
    fields: {
      sku_id: "规格 ID",
      title: "商品名称",
      unit_price: "单价",
      spec: "规格",
      refundable_service_fee: "可退服务费",
    },
  },
  logistics: {
    key: "order_id",
    label: "物流",
    fields: {
      order_id: "订单号",
      carrier: "承运商",
      signed: "是否签收",
      signer: "签收人",
      nodes: "物流节点",
    },
  },
  tickets: {
    key: "ticket_id",
    label: "客服工单",
    fields: {
      ticket_id: "工单号",
      order_id: "订单号",
      created_at: "创建时间",
      agent: "受理人",
      content: "工单内容",
    },
  },
};

const NUMERIC: Record<Dataset, string[]> = {
  orders: ["qty", "paid_amount"],
  refunds: ["applied_amount"],
  sku_specs: ["unit_price", "refundable_service_fee"],
  logistics: [],
  tickets: [],
};
const BOOLEAN: Record<Dataset, string[]> = { orders: [], refunds: [], sku_specs: [], logistics: ["signed"], tickets: [] };
const JSONISH: Record<Dataset, string[]> = { orders: [], refunds: [], sku_specs: ["spec"], logistics: ["nodes"], tickets: [] };

/* ═══════════ 分隔符文本解析（CSV / TSV，支持双引号包裹与 "" 转义） ═══════════ */

export interface ParsedTable {
  headers: string[];
  rows: Record<string, string>[];
}

export function parseDelimited(text: string): ParsedTable {
  const clean = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!clean) return { headers: [], rows: [] };

  const firstLine = clean.split("\n")[0];
  const delim = firstLine.includes("\t") && firstLine.split("\t").length > firstLine.split(",").length ? "\t" : ",";

  const cells: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delim) { row.push(field); field = ""; continue; }
    if (ch === "\n") { row.push(field); cells.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  row.push(field);
  cells.push(row);

  const headers = (cells.shift() ?? []).map((h) => h.trim());
  const rows = cells
    .filter((r) => r.some((c) => c.trim() !== ""))
    .map((r) => {
      const o: Record<string, string> = {};
      headers.forEach((h, i) => { o[h] = (r[i] ?? "").trim(); });
      return o;
    });
  return { headers, rows };
}

/* ═══════════ 行归一化与校验 ═══════════ */

export interface IngestReport {
  dataset: Dataset;
  added: number;
  updated: number;
  rejected: number;
  errors: string[];
}

function coerce(dataset: Dataset, raw: Record<string, unknown>): { row?: Record<string, unknown>; error?: string } {
  const spec = DATASET_SPEC[dataset];
  const out: Record<string, unknown> = {};

  for (const field of Object.keys(spec.fields)) {
    let v = raw[field];
    if (v === undefined || v === null || v === "") {
      if (field === spec.key) return { error: `第 ${field} 列（主键）为空` };
      continue;
    }
    if (typeof v === "string") {
      const t = v.trim();
      if (NUMERIC[dataset].includes(field)) {
        const n = Number(t);
        if (!Number.isFinite(n)) return { error: `${field} 不是数字：${t}` };
        out[field] = n;
      } else if (BOOLEAN[dataset].includes(field)) {
        const low = t.toLowerCase();
        if (["true", "1", "yes", "y", "是", "已签收", "已签"].includes(low)) out[field] = true;
        else if (["false", "0", "no", "n", "否", "未签收", "未签"].includes(low)) out[field] = false;
        else return { error: `${field} 不是布尔值：${t}` };
      } else if (JSONISH[dataset].includes(field)) {
        try { out[field] = JSON.parse(t); } catch { return { error: `${field} 不是合法 JSON：${t.slice(0, 40)}` }; }
      } else out[field] = t;
    } else if (typeof v === "number" || typeof v === "boolean") {
      out[field] = v;
    } else {
      out[field] = v; // 已经是对象/数组（JSON 导入）
    }
  }

  if (dataset === "orders" && (out.qty === undefined || out.paid_amount === undefined)) {
    return { error: "缺少 qty 或 paid_amount" };
  }
  if (dataset === "logistics" && out.signed === undefined) out.signed = false;
  if (dataset === "logistics" && !Array.isArray(out.nodes)) out.nodes = [];
  if (dataset === "sku_specs" && (out.spec === undefined || typeof out.spec !== "object" || Array.isArray(out.spec))) {
    out.spec = {};
  }
  if (!out.currency && dataset === "orders") out.currency = "CNY";
  return { row: out };
}

/* ═══════════ 合并进 store（按主键 upsert） ═══════════ */

type AnyRow = Record<string, any>;

export function mergeRows(store: Store, dataset: Dataset, incoming: AnyRow[]): IngestReport {
  const spec = DATASET_SPEC[dataset];
  const target = (store as unknown as Record<Dataset, AnyRow[]>)[dataset];
  const report: IngestReport = { dataset, added: 0, updated: 0, rejected: 0, errors: [] };

  incoming.forEach((raw, idx) => {
    const { row, error } = coerce(dataset, raw);
    if (error || !row) {
      report.rejected++;
      if (report.errors.length < 8) report.errors.push(`第 ${idx + 1} 行：${error}`);
      return;
    }
    const k = String(row[spec.key as string]);
    const at = target.findIndex((r) => String(r[spec.key]) === k);
    if (at >= 0) { target[at] = { ...target[at], ...row }; report.updated++; }
    else { target.push(row); report.added++; }
  });
  return report;
}

/** 把一段文本（CSV/TSV/JSON）导入到指定数据集；JSON 支持 {rows:[]} 或裸数组 */
export function ingestText(store: Store, dataset: Dataset, text: string): IngestReport {
  const trimmed = text.trim();
  if (!trimmed) return { dataset, added: 0, updated: 0, rejected: 0, errors: ["没有可导入的内容"] };
  let rows: AnyRow[];
  try {
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      const parsed = JSON.parse(trimmed);
      rows = Array.isArray(parsed) ? parsed : parsed.rows;
      if (!Array.isArray(rows)) return { dataset, added: 0, updated: 0, rejected: 0, errors: ["JSON 里没有 rows 数组"] };
    } else {
      rows = parseDelimited(trimmed).rows;
    }
  } catch (e) {
    return { dataset, added: 0, updated: 0, rejected: 0, errors: ["解析失败：" + (e as Error).message] };
  }
  return mergeRows(store, dataset, rows);
}

/** 当前 store 里各数据集的规模，用于界面显示「已接入多少数据」 */
export function storeStats(store: Store): Record<Dataset, number> {
  return {
    orders: store.orders.length,
    refunds: store.refunds.length,
    sku_specs: store.sku_specs.length,
    logistics: store.logistics.length,
    tickets: store.tickets.length,
  };
}

/** 表头（= 字段清单），供界面提示「该按什么列头组织数据」 */
export function datasetHeader(dataset: Dataset): string {
  return Object.keys(DATASET_SPEC[dataset].fields).join(",");
}

/**
 * 一条可直接导入的示例行（表头 + 一行数据）。
 *
 * 界面上「填示例」用它是为了省掉翻文档这一步：粘进去点导入就能看到
 * 「新增 / 更新 / 拒绝」的判定，FormatError 也当场看得见。
 */
export const DATASET_SAMPLE: Record<Dataset, string> = {
  orders: [
    "order_id,buyer_id,sku_id,qty,paid_amount,currency,paid_at,status,sales_channel",
    "O20261015-5501,U-9951,SKU-9901,1,268.00,CNY,2026-10-15T09:20:00+08:00,paid,微信小店",
  ].join("\n"),
  refunds: [
    "refund_id,order_id,applied_amount,reason_code,reason_text,applied_at,status",
    "R20261015-8801,O20261015-5501,268.00,COLOR_DIFF,收到的颜色与详情页不一致,2026-10-15T10:05:00+08:00,applied",
  ].join("\n"),
  sku_specs: [
    "sku_id,title,unit_price,spec,refundable_service_fee",
    'SKU-9910,岩板餐桌,459.00,"{""color"":""浅灰"",""size"":""140cm""}",0',
  ].join("\n"),
  logistics: [
    "order_id,carrier,signed,signer,nodes",
    'O20261015-5501,中通快递,false,,"[{""at"":""2026-10-15T11:00:00+08:00"",""event"":""运输中"",""station"":""长沙转运中心""}]"',
  ].join("\n"),
  tickets: [
    "ticket_id,order_id,created_at,agent,content",
    "T20261015-9901,O20261015-5501,2026-10-15T10:02:00+08:00,小周,客户反馈餐桌颜色与详情页不一致",
  ].join("\n"),
};
