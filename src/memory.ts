import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, RUNS_DIR } from "./env.ts";
import type { MemoryHit } from "./types.ts";

/**
 * 案件记忆 —— 把「已经落盘但没人读」的决策轨迹变成可检索的经验。
 *
 * 为什么是这一层而不是向量库：
 *   ① 量级不对：几百个案件，BM25 的召回质量完全够，向量库只带来依赖与不可解释；
 *   ② 这个场景最怕「说不清为什么是它」——售后结论要能被追问，
 *      所以每条召回都必须能给出人话理由（同案型 / 金额相近 / 原话有共同词）。
 *
 * 三条纪律，写在这里也写在调用处：
 *   · 只读轨迹、不改轨迹；索引可以随时删掉重建（幂等）。
 *   · 召回结果一律标 advisory —— 它进提示词当参考，**不进授权闸**。
 *     金额档位只认订单账本，不认记忆（否则记忆就成了绕过审批的后门）。
 *   · 索引过期（比最新的轨迹文件还旧）就自动重建，不需要人记得去跑命令。
 */

const MEM_DIR = join(DATA_DIR, "memory");
const INDEX_FILE = join(MEM_DIR, "case_index.json");

/**
 * 这套能力依赖「能扫目录」—— 而单文件演示版跑在浏览器里，文件系统是垫片，
 * 只有读写单个文件、没有目录枚举。所以先探一次能力，而不是等它抛异常再兜。
 * 单文件版因此**没有历史案件可参考**（刷新即重置，本来也没有历史轨迹），
 * 界面上那块就不出现 —— 不做假数据，也不让它挡住一次处置。
 */
const CAN_SCAN = [readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync].every(
  (f) => typeof f === "function",
);

export interface CaseCard {
  key: string; // 一次会话的唯一键：msg_id + 开始时间（同一案件重跑会产生多条，各自独立）
  msg_id: string;
  at: string;
  case_type: string;
  case_name: string;
  verdict: string;
  decision: string;
  amount: number | null;
  tier: string;
  outcome: string;
  requery_rounds: number;
  follow_up_required: boolean;
  missing_evidence: string[];
  judge_source: string;
  /** 客户原话（截断，只用于检索，不用于展示原文） */
  text: string;
}

interface IndexFile {
  built_at: string;
  source_files: number;
  cards: CaseCard[];
}

/* ── 轨迹 → 案件卡 ─────────────────────────────────────────────── */

function readLines(file: string): any[] {
  const out: any[] = [];
  const raw = readFileSync(file, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // 单行坏了就跳过：轨迹是证据，不是账本，不值得为一行坏数据让整次索引失败
    }
  }
  return out;
}

/**
 * 取值顺序：**字段优先，模板兜底**。
 *
 * 为什么不一刀切只认字段：本项目在补字段之前已经写了几百条真实轨迹，
 * 那些证据不该因为「当时还没加字段」就变成不可读的空白。
 * 为什么不一刀切只认 summary：模板是给人看的，改一个标点就全崩，
 * 靠它当主通路太脆 —— 所以它只在字段缺席时顶一下。
 */
function pick(field: unknown, summary: unknown, re: RegExp): string {
  if (typeof field === "string" && field) return field;
  const m = typeof summary === "string" ? re.exec(summary) : null;
  return m ? String(m[1]) : "";
}

function cardFromTrace(file: string): CaseCard | null {
  const rows = readLines(file);
  if (!rows.length) return null;
  const head = rows[0];
  if (head._type !== "session_header") return null;

  let card: CaseCard = {
    key: `${head.case_id}@${head.started_at ?? ""}`,
    msg_id: String(head.case_id ?? ""),
    at: String(head.started_at ?? ""),
    case_type: "",
    case_name: "",
    verdict: "",
    decision: "",
    amount: null,
    tier: "",
    outcome: "",
    requery_rounds: 0,
    follow_up_required: false,
    missing_evidence: [],
    judge_source: String(head.judge_mode === "model" ? "model" : "offline_rule"),
    text: "",
  };

  for (const r of rows) {
    const d = r.detail ?? {};
    switch (r.kind) {
      case "understand":
        if (typeof d.text === "string") card.text = d.text.slice(0, 200);
        break;
      case "classify":
        if (d.classification) {
          card.case_type = String(d.classification.case_type ?? "");
          card.case_name = String(d.classification.case_name ?? "");
        }
        break;
      case "judge":
        if (typeof d.decision === "string" && d.decision) card.decision = d.decision;
        if (typeof d.amount === "number") card.amount = d.amount;
        if (typeof d.judge_source === "string") card.judge_source = d.judge_source;
        break;
      case "review": {
        // 补证后那次会覆盖前一次，取到的就是最终裁决
        const v = pick(d.verdict, r.summary, /Reviewer 裁决：(\S+)/);
        if (v) card.verdict = v;
        if (Array.isArray(d.missing_evidence) && d.missing_evidence.length) {
          card.missing_evidence = d.missing_evidence.map(String);
          card.requery_rounds = Math.max(card.requery_rounds, 1);
        }
        break;
      }
      case "plan":
        if (/轮补证/.test(String(r.summary ?? ""))) card.requery_rounds += 1;
        break;
      case "gate":
        if (typeof d.tier === "string" && d.tier) card.tier = d.tier;
        if (typeof r.summary === "string" && r.summary) card.outcome = r.summary;
        break;
      case "auth": {
        // 档位写在 auth 这条上（带 tier 字段），gate 那条只有结果
        const t = pick(d.tier, r.summary, /授权分档：([A-Z_]+)/);
        if (t) card.tier = t;
        break;
      }
      case "reply":
        if (typeof d.follow_up_required === "boolean") card.follow_up_required = d.follow_up_required;
        break;
      default:
        break;
    }
  }

  // 没有任何判据信息的会话（例如中途异常）不进索引：它教不了任何东西
  if (!card.case_type && !card.decision) return null;
  return card;
}

/* ── 建索引 / 读索引 ───────────────────────────────────────────── */

function newestRunMtime(): number {
  if (!existsSync(RUNS_DIR)) return 0;
  let newest = 0;
  for (const f of readdirSync(RUNS_DIR)) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      const m = statSync(join(RUNS_DIR, f)).mtimeMs;
      if (m > newest) newest = m;
    } catch {
      // 文件在扫描期间被删了，忽略
    }
  }
  return newest;
}

export function buildIndex(): IndexFile {
  const cards: CaseCard[] = [];
  let files = 0;
  if (existsSync(RUNS_DIR)) {
    for (const f of readdirSync(RUNS_DIR)) {
      if (!f.endsWith(".jsonl")) continue;
      files += 1;
      const c = cardFromTrace(join(RUNS_DIR, f));
      if (c) cards.push(c);
    }
  }
  // 最新在前：界面与提示词都先用最近的
  cards.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const index: IndexFile = { built_at: new Date().toISOString(), source_files: files, cards };
  mkdirSync(MEM_DIR, { recursive: true });
  writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), "utf8");
  return index;
}

let cache: IndexFile | null = null;
let lastBuildAt = 0;
/** 重建节流：一次批量跑 8 个案件不该触发 8 次全量重建（429 个文件 × 8 次） */
const REBUILD_MIN_MS = 5000;

/**
 * 读索引；不存在就建，明显过期就重建 —— 不需要人记得跑命令。
 *
 * 过期判据带了节流：索引比最新轨迹旧，且距上次重建超过 5 秒才重建。
 * 也就是说索引最多滞后 5 秒。这个滞后是刻意接受的：
 * 它是「参考经验」，不是「账本」，晚 5 秒看到今天的案子不会影响任何判定。
 */
export function loadIndex(): IndexFile {
  if (!CAN_SCAN) throw new Error("当前运行形态没有可枚举的历史轨迹目录（单文件演示版没有历史案件）");
  const missing = !existsSync(INDEX_FILE);
  const olderThanRuns = !missing && statSync(INDEX_FILE).mtimeMs < newestRunMtime();
  const throttled = Date.now() - lastBuildAt < REBUILD_MIN_MS;

  if (cache && !missing && !olderThanRuns) return cache;
  if (missing || (olderThanRuns && !throttled)) {
    cache = buildIndex();
    lastBuildAt = Date.now();
    return cache;
  }
  if (cache) return cache; // 节流窗口内：先用旧的，别为几分钟的时间差重扫全量
  try {
    cache = JSON.parse(readFileSync(INDEX_FILE, "utf8")) as IndexFile;
  } catch {
    cache = buildIndex(); // 索引文件坏了就重建，不让它挡住处置
    lastBuildAt = Date.now();
  }
  return cache;
}

/* ── 检索：规则过滤 + BM25 ─────────────────────────────────────── */

function tokens(s: string): string[] {
  const t = String(s || "").toLowerCase();
  const latin = t.match(/[a-z0-9]+/g) ?? [];
  const grams: string[] = [];
  for (const seg of t.replace(/[^\u4e00-\u9fa5a-z0-9]/g, " ").split(/\s+/)) {
    if (!/[\u4e00-\u9fa5]/.test(seg)) continue;
    for (let i = 0; i + 1 < seg.length; i++) grams.push(seg.slice(i, i + 2)); // 中文按二元组切
    if (seg.length === 1) grams.push(seg);
  }
  return [...latin, ...grams];
}

/**
 * 找同类案件。返回按分数排序的少量命中，每条都带「为什么召回」。
 * advisory only：调用方只准把它拼进提示词或展示给人，不准拿它当判定依据。
 */
export function retrieveCases(q: {
  case_type?: string;
  amount?: number | null;
  text?: string;
  exclude_msg_id?: string;
  limit?: number;
}): MemoryHit[] {
  if (!CAN_SCAN) return []; // 单文件演示版：没有历史轨迹可读，安静返回「无经验」
  const idx = loadIndex();
  const limit = q.limit ?? 3;
  const out: MemoryHit[] = [];
  // 同一个案子可能跑过多次（补事实重跑、审批后重跑），索引里就有多张卡。
  // cards 已按时间倒序，所以每个 msg_id 的**第一张**就是最近一次 —— 只留它，
  // 否则「参考了 3 条」里可能有 2 条是同一个案子的两个旧版本，等于没参考。
  const seen = new Set<string>();

  for (const c of idx.cards) {
    if (q.exclude_msg_id && c.msg_id === q.exclude_msg_id) continue; // 别拿自己当参考
    if (q.case_type && c.case_type && c.case_type !== q.case_type) continue; // 先按案型收敛
    if (seen.has(c.msg_id)) continue;
    seen.add(c.msg_id);

    const why: string[] = [];
    let score = 0;
    if (q.case_type && c.case_type === q.case_type) {
      score += 2;
      why.push(`同属「${c.case_name || c.case_type}」`);
    }
    if (typeof q.amount === "number" && typeof c.amount === "number" && q.amount > 0) {
      const diff = Math.abs(c.amount - q.amount) / q.amount;
      if (diff <= 0.3) {
        score += 1;
        why.push(diff === 0 ? "金额相同" : `金额接近（差 ${Math.round(diff * 100)}%）`);
      }
    }
    out.push({
      key: c.key,
      msg_id: c.msg_id,
      at: c.at,
      case_type: c.case_type,
      case_name: c.case_name,
      verdict: c.verdict,
      decision: c.decision,
      amount: c.amount,
      outcome: c.outcome,
      score,
      why,
    });
  }

  // BM25：只在粗筛后的集合里算，几百条数据，成本可以忽略
  const qTokens = tokens(`${q.text ?? ""}`);
  if (qTokens.length && out.length) {
    const k1 = 1.2;
    const b = 0.75;
    const docs = out.map((h) => {
      const card = idx.cards.find((c) => c.key === h.key)!;
      const tf = new Map<string, number>();
      const toks = tokens(`${card.text} ${card.case_name} ${card.verdict}`);
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      return { h, tf, len: toks.length };
    });
    const avgLen = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, docs.length);
    const df = new Map<string, number>();
    for (const t of new Set(qTokens)) {
      df.set(t, docs.filter((d) => d.tf.has(t)).length);
    }
    for (const d of docs) {
      let s = 0;
      let shared = 0;
      for (const t of new Set(qTokens)) {
        const f = d.tf.get(t);
        if (!f) continue;
        shared += 1;
        const n = docs.length;
        const idf = Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
        s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / Math.max(1, avgLen))));
      }
      d.h.score += s;
      if (shared > 0) d.h.why.push(`客户原话有 ${shared} 处共同措辞`);
    }
  }

  return out
    .filter((h) => h.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, limit);
}

/** 拼成给模型看的一段参考。刻意写明「仅供参考，不构成判定依据」 */
export function renderMemoryBlock(hits: MemoryHit[]): string {
  if (!hits.length) return "";
  const lines = hits.map((h, i) => {
    const amt = h.amount != null ? `¥${h.amount}` : "无金额";
    return `${i + 1}. ${h.case_name || h.case_type}｜判据 ${h.decision || "—"}｜最终 ${h.verdict || "—"}｜${amt}｜${h.why.join("；")}`;
  });
  return [
    "",
    "【历史同类案件 · 仅供参考，不构成判定依据】",
    "下面这些是过去处理过的同类案件。它们可以帮助你理解这类问题的常见处理方式，",
    "但本条必须依据本次取证到的事实与政策判断 —— 不得因为「上次这么判」就直接沿用结论。",
    ...lines,
  ].join("\n");
}

export const MEMORY_INDEX_FILE = INDEX_FILE;
