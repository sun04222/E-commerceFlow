import { createHash } from "node:crypto";
import { llmConfig } from "./env.ts";

/** 模型通道错误——带上足够信息，避免把失败伪装成成功 */
export class ModelError extends Error {
  status?: number;
  code?: string;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "ModelError";
    this.status = status;
    this.code = code;
  }
}

export interface ModelCallResult {
  text: string;
  model: string;
  latency_ms: number;
}

/**
 * 全工程唯一一处模型调用。
 * 本工程有四条链路，其中「咨询理解 / 问题分类 / 判据归纳 / 结果反馈」都可以由模型承担；
 * 但工具面、按环节装配、授权闸、轨迹、只读复核全部是确定性逻辑。
 * 密钥不可用时用 --offline 走规则占位（judge_source=offline_rule），链路照样端到端跑通。
 */
export async function callModel(system: string, user: string, temperature = 0): Promise<ModelCallResult> {
  const c = llmConfig();
  if (!c.usable) throw new ModelError(`模型通道不可用：${c.problem}`, undefined, "config_missing");

  const url = c.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), c.timeout * 1000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify({
        model: c.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature,
        stream: false,
      }),
      signal: ac.signal,
    });

    const raw = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new ModelError(`响应不是合法 JSON：${raw.slice(0, 200)}`, res.status);
    }
    if (!res.ok) {
      const code = body?.error?.code ?? body?.code ?? null;
      throw new ModelError(`模型服务返回 ${res.status}：${body?.error?.message ?? raw.slice(0, 200)}`, res.status, code);
    }
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      throw new ModelError(`响应中没有可用内容：${raw.slice(0, 200)}`, res.status);
    }
    return { text, model: body?.model ?? c.model, latency_ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** 宽容地从模型输出里取出 JSON；取不到就抛错，绝不用默认值糊过去 */
export function extractJson<T = any>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first < 0 || last <= first) {
    throw new ModelError(`模型输出里找不到 JSON 对象：${text.slice(0, 300)}`, undefined, "no_json");
  }
  return JSON.parse(body.slice(first, last + 1)) as T;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
