import type { CaseRunResult, SampleCase } from "./types.ts";

/**
 * 回归门禁的期望比对逻辑。
 *
 * 从 cli.ts 抽出为独立模块，是为了让桌面端服务（desktop/server.mjs）与命令行
 * 共用同一份判定——UI 上显示的「符合期望」与门禁退出码必须是同一个裁判，
 * 不能出现「命令行说过、UI 说不过」两套标准。
 */
export function checkExpectation(s: SampleCase, r: CaseRunResult): string[] {
  const errs: string[] = [];
  const tier = r.auth?.tier ?? "AUTO";
  const executed = r.executed_tool !== null;
  if (r.classification.case_type !== s.expect.case_type)
    errs.push(`案件类型 期望 ${s.expect.case_type} / 实际 ${r.classification.case_type}`);
  if (r.review.verdict !== s.expect.verdict)
    errs.push(`复核裁决 期望 ${s.expect.verdict} / 实际 ${r.review.verdict}`);
  if (tier !== s.expect.auth_tier) errs.push(`授权档位 期望 ${s.expect.auth_tier} / 实际 ${tier}`);
  if (r.requery_rounds > 0 !== s.expect.requires_requery)
    errs.push(`补证 期望 ${s.expect.requires_requery ? "有" : "无"} / 实际 ${r.requery_rounds > 0 ? "有" : "无"}`);
  if (r.reply.follow_up_required !== s.expect.follow_up_required)
    errs.push(`人工跟进 期望 ${s.expect.follow_up_required} / 实际 ${r.reply.follow_up_required}`);
  if (executed !== s.expect.executed)
    errs.push(`不可逆执行 期望 ${s.expect.executed ? "执行" : "不执行"} / 实际 ${executed ? "执行" : "不执行"}`);
  return errs;
}

/** 汇总一项实际结果，供 UI 表格与 --json 门禁输出共用 */
export function actualSummary(r: CaseRunResult) {
  return {
    case_type: r.classification.case_type,
    verdict: r.review.verdict,
    auth_tier: r.auth?.tier ?? "AUTO",
    requires_requery: r.requery_rounds > 0,
    follow_up_required: r.reply.follow_up_required,
    executed: r.executed_tool !== null,
  };
}
