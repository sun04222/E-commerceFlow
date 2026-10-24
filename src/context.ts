import type { ContextLayer, Phase } from "./types.ts";
import type { Policy } from "./policy.ts";
import { toolCatalog, type ToolSpec } from "./tools.ts";

/**
 * 三层渐进式上下文披露
 *
 * 对应简历要点三：五源工具说明与字段口径全量注入会导致上下文膨胀与「中间遗忘」，
 * 因此按当前环节只展开与本案相关的那一层。
 *
 *   摘要层      —— 系统能力概览，任何环节都在场，但很短
 *   Schema 层   —— 工具的输入输出结构，只列当前环节装配得到的工具
 *   字段级契约  —— 关键字段的定义与计算口径，只列本案真正用到的字段
 */
export interface ContextBundle {
  phase: Phase;
  layers: ContextLayer[];
  rendered: string;
}

export interface ContextInput {
  phase: Phase;
  tools: ToolSpec[];
  policy: Policy;
  /** 本案实际用到的字段名（决定字段级契约展开哪些条目） */
  relevant_fields: string[];
  /** 本案已发生的动作简述，供摘要层交代进度 */
  progress: string;
}

export function buildContext(input: ContextInput): ContextBundle {
  const { phase, tools, policy, relevant_fields, progress } = input;
  const layers: ContextLayer[] = [];

  const summary = [
    `当前环节：${phase}`,
    `进度：${progress}`,
    `可用数据来源：${policy.source_names.join("、")}`,
    `本环节可调用工具 ${tools.length} 个（其余工具未装配，不可见也不可调）`,
    `约束：只读工具不改变状态；不可逆动作必须经授权闸；判据必须可回溯到字段。`,
  ].join("\n");

  layers.push({ layer: "summary", name: "摘要层", content: summary, disclosed: true });

  const needSchema = phase === "investigate" || phase === "judge" || phase === "approve";
  layers.push({
    layer: "schema",
    name: "Schema 层",
    content: needSchema ? toolCatalog(tools, phase) : "（本环节不需要工具结构，未展开）",
    disclosed: needSchema,
  });

  const needContract = phase === "judge";
  const contractLines = needContract
    ? relevant_fields
        .filter((f) => policy.field_contract[f])
        .map((f) => `- ${f}｜来源 ${policy.field_contract[f].source}｜口径：${policy.field_contract[f].meaning}`)
    : [];
  layers.push({
    layer: "field_contract",
    name: "字段级契约",
    content: contractLines.length ? contractLines.join("\n") : "（本环节未展开字段口径）",
    disclosed: contractLines.length > 0,
  });

  const rendered = layers
    .filter((l) => l.disclosed)
    .map((l) => `【${l.name}】\n${l.content}`)
    .join("\n\n");

  return { phase, layers, rendered };
}

/** 展开率统计 —— 用于在报告里证明「上下文是渐进披露的，不是全量灌入」 */
export function disclosureStats(bundle: ContextBundle): string {
  return bundle.layers.map((l) => `${l.name}${l.disclosed ? "✓" : "✗"}`).join(" / ");
}
