import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, readJson } from "./env.ts";
import { DATASET_SPEC, ingestText, type Dataset, type IngestReport } from "./ingest.ts";
import type { Store } from "./tools.ts";

/**
 * 连接器（Connector）
 *
 * 定位：把「数据从哪来」从代码里抽出来，变成一份声明（data/connectors.json）。
 * 引擎不认识任何平台 —— 它只认识五张表（订单 / 退款申请 / 商品规格 / 物流 / 工单）。
 * 连接器负责把这五张表的口径对齐，于是：
 *   · 新增一个平台 = 在 data/connectors.json 加一条声明 + 在 mcp/ 里挂一个数据源，引擎零改动
 *   · 界面上的「接入数据」按钮走的和 MCP 工具调用是同一条收口（src/ingest.ts）
 *   · 导入只按主键合并，重复导入不会产生重复行，也不会悄悄覆盖成默认值
 *
 * 三种连接方式：
 *   mcp      —— 由 mcp/server.mjs 以 MCP 协议对外提供服务，可被任意 MCP 宿主连接
 *   file     —— 用户直接粘 / 传 CSV、TSV、JSON
 *   webhook  —— 消息入站（当前为微信客户消息），进来即触发处置
 */

export type ConnectorKind = "mcp" | "file" | "webhook";
export type ToolOp = "list" | "get" | "ingest" | "inbound";

export interface ConnectorTool {
  name: string;
  title: string;
  op: ToolOp;
  dataset?: Dataset;
  /** 相对项目根目录的数据文件（MCP 服务端与离线快照共用同一份） */
  file?: string;
  /** get 类工具用来定位行的主键字段 */
  key?: string;
}

export interface ConnectorDecl {
  id: string;
  name: string;
  kind: ConnectorKind;
  badge: string;
  platforms: string[];
  desc: string;
  auth: string;
  tools: ConnectorTool[];
}

export interface ConnectorManifest {
  protocol: string;
  namespace: string;
  server: string;
  notice: string;
  connectors: ConnectorDecl[];
}

export function loadConnectors(): ConnectorManifest {
  const raw = readJson<ConnectorManifest & { _notice?: string }>("connectors.json");
  return {
    protocol: raw.protocol,
    namespace: raw.namespace,
    server: raw.server,
    notice: raw._notice ?? "",
    connectors: raw.connectors,
  };
}

export function snapshotPath(file: string): string {
  return join(ROOT, file);
}

/** 参与批量拉取的源：每个连接器声明里的 list 类工具，一条一个数据表 */
export function listSources(c: ConnectorDecl): ConnectorTool[] {
  return c.tools.filter((t) => t.op === "list" && t.dataset && t.file);
}

/** 某个连接器覆盖的数据表 */
export function connectorDatasets(c: ConnectorDecl): Dataset[] {
  const out: Dataset[] = [];
  for (const t of c.tools) if (t.dataset && !out.includes(t.dataset)) out.push(t.dataset);
  return out;
}

/**
 * 按声明的数据文件把连接器的数据合并进 store。
 *
 * 这是 MCP 服务端不在场时的等价通路（同一份文件、同一套校验、同一处 upsert），
 * 单文件演示版也走这里 —— 所以演示时看到的条数与本地服务模式完全一致。
 */
export function pullFromFiles(store: Store, c: ConnectorDecl): IngestReport[] {
  const reports: IngestReport[] = [];
  for (const t of listSources(c)) {
    let text = "";
    try {
      text = readFileSync(snapshotPath(t.file as string), "utf8");
    } catch {
      reports.push({ dataset: t.dataset as Dataset, added: 0, updated: 0, rejected: 0, errors: [`数据文件不可读：${t.file}`] });
      continue;
    }
    reports.push(ingestText(store, t.dataset as Dataset, text));
  }
  return reports;
}

export interface ConnectorView {
  id: string;
  name: string;
  kind: ConnectorKind;
  badge: string;
  platforms: string[];
  desc: string;
  auth: string;
  tools: Array<{ name: string; title: string; op: ToolOp; fq: string; live: boolean }>;
  datasets: Array<{ dataset: Dataset; label: string; rows: number }>;
}

/** MCP 通道状态（由调用方探测：本地服务端是真探测，单文件版如实标成不可用） */
export interface McpState {
  ready: boolean;
  problem: string;
  serverInfo: { name?: string; version?: string } | null;
  tools: string[];
}

/**
 * 把「声明 + 实时规模 + 通道状态」拼成界面直接可渲染的数据源视图。
 *
 * 本地服务端与单文件演示版共用这一段 —— 否则两边会各自长出一套
 * 「哪个连接器算联通」的判断，迟早对不上。
 */
export function buildConnectorViews(
  manifest: ConnectorManifest,
  stats: Record<Dataset, number>,
  mcp: McpState,
): ConnectorView[] {
  return manifest.connectors.map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    badge: c.badge,
    platforms: c.platforms,
    desc: c.desc,
    auth: c.auth,
    tools: c.tools.map((t) => ({
      name: t.name,
      title: t.title,
      op: t.op,
      fq: `${manifest.namespace}.${t.name}`,
      // 只有真走 MCP 协议的工具才有「在线」一说；文件 / 入站口恒为可用
      live: t.op === "list" || t.op === "get" ? mcp.tools.includes(`${manifest.namespace}.${t.name}`) : true,
    })),
    datasets: connectorDatasets(c).map((d) => ({ dataset: d, label: DATASET_SPEC[d].label, rows: stats[d] })),
  }));
}
