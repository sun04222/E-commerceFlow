import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** 项目根目录 = src 的上一级 */
export const ROOT = resolve(here, "..");
export const DATA_DIR = join(ROOT, "data");
export const RUNS_DIR = join(ROOT, "runs");
export const SAMPLES_FILE = join(ROOT, "samples", "cases.json");

function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

let cache: Record<string, string> | null = null;

export function fileEnv(): Record<string, string> {
  if (cache) return cache;
  const p = join(ROOT, ".env");
  cache = existsSync(p) ? parseDotEnv(readFileSync(p, "utf8")) : {};
  return cache;
}

/**
 * 清掉缓存，让下一次 cfg() 重新读盘。
 *
 * 配置页保存完必须调它 —— 否则改完 .env 也只是改了个文件，
 * 进程里还是旧值，表现为「保存成功但不生效」。
 */
export function resetEnvCache(): void {
  cache = null;
}

export function cfg(key: string): string {
  return process.env[key] ?? fileEnv()[key] ?? "";
}

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeout: number;
  usable: boolean;
  problem: string;
}

export function llmConfig(): LlmConfig {
  const baseUrl = cfg("LLM_BASE_URL");
  const model = cfg("LLM_MODEL");
  const apiKey = cfg("LLM_API_KEY");
  const timeout = Number(cfg("LLM_TIMEOUT") || 60);

  let usable = true;
  let problem = "";
  if (!baseUrl || !model || !apiKey) {
    usable = false;
    problem = "缺少 LLM_BASE_URL / LLM_MODEL / LLM_API_KEY";
  } else if (/在此填入|your[_-]?key|placeholder|^xxx/i.test(apiKey)) {
    usable = false;
    problem = "LLM_API_KEY 仍是占位值，未填入真实密钥";
  }
  return { baseUrl, model, apiKey, timeout, usable, problem };
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(join(DATA_DIR, file), "utf8")) as T;
}
