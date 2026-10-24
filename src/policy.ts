import { readJson } from "./env.ts";
import type { CaseType, Phase, SourceName } from "./types.ts";

export interface EvidenceRule {
  id: string;
  when: Record<string, unknown>;
  require: SourceName[];
  because: string;
}

export interface StageRule {
  id: string;
  when: Record<string, unknown>;
  forbid: Phase[];
  because: string;
}

export interface AmbiguousDetector {
  id: string;
  when: Record<string, unknown>;
  note: string;
}

export interface Policy {
  field_contract: Record<string, { source: string; type: string; meaning: string }>;
  action_tiers: Array<{ match: Record<string, unknown>; tier: string; label: string; because: string }>;
  amount_tiers: Array<{ up_to: number | null; tier: string; label: string }>;
  amount_rules: Array<{ id: string; check: string; verdict_on_fail: string; because: string }>;
  consistency_rules: Array<{ id: string; when: Record<string, unknown>; verdict: string; because: string }>;
  stage_rules: StageRule[];
  ambiguous_detectors: AmbiguousDetector[];
  /** 数据来源名清单，供摘要层交代能力边界 */
  source_names: string[];
}

export interface SopStage {
  id: Phase;
  name: string;
  entry: string;
  exit: string;
}

export interface CaseTypeDef {
  code: CaseType;
  name: string;
  trigger_intents: string[];
  requires_return: boolean;
  money_action: string | null;
  required_sources: SourceName[];
  sop_path: "full" | "light" | "clarify";
}

export interface Sop {
  stages: SopStage[];
  case_types: CaseTypeDef[];
}

export function loadPolicy(): Policy {
  const p = readJson<Omit<Policy, "source_names">>("policy.json");
  return {
    ...p,
    source_names: ["orders", "refunds", "sku_specs", "logistics", "tickets"],
  };
}

export function loadSop(): Sop {
  return readJson<Sop>("sop.json");
}

export function caseTypeDef(sop: Sop, code: CaseType): CaseTypeDef {
  const d = sop.case_types.find((c) => c.code === code);
  if (!d) throw new Error(`SOP 中未定义案件类型 ${code}`);
  return d;
}
