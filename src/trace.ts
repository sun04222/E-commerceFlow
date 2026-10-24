import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR } from "./env.ts";
import type { Phase, TraceLine } from "./types.ts";

/**
 * 决策轨迹 —— 每一步都落成一行 JSONL。
 *
 * 对应简历要点四：会话以 JSONL 逐行落盘，首行是会话头，其后每行一个事件，
 * 轨迹可按行回放、按步定位到具体一次工具调用。
 * 本工程把轨迹从「取证环节」扩展到「从客户原话到结单回执」全链路。
 *
 * 写入策略：内存缓冲 + 批量落盘（攒够 FLUSH_EVERY 行，或静默 FLUSH_MS 后）。
 * 原先每 append 一次就 writeFileSync 一次 —— 单案件 17~20 行就是 17~20 次
 * 打开/写入/关闭，实测 2~13 ms/行（Windows + 杀软实时扫描），
 * 而「先在内存拼好、一次写入」是 0.005 ms/行。
 *
 * 但缓冲不能拿可靠性换，所以有两条硬规矩：
 *   ① 会话头一创建就落盘 —— 哪怕进程立刻挂掉，也留得下「这次跑过」；
 *   ② 结果返回前必须 flush（由 packResult 调用），保证调用方拿到的
 *      trace_path 指向的文件此刻已经写完，不存在「路径有了、内容还没落」。
 */
const FLUSH_EVERY = 8; // 攒够多少行写一次
const FLUSH_MS = 400; // 或者最多攒这么久

/**
 * 进程退出兜底：缓冲一旦存在，就有「进程没来得及 flush 就退出」的窗口。
 * 这里把所有还活着的 Trace 记下来，在 exit 里补最后一把同步写 ——
 * 退出钩子必须是同步的，appendFileSync 正好满足。
 */
/**
 * 事件出口：轨迹每记一行，就同步交给宿主一份。
 *
 * 为什么它值得存在：界面上原先只能显示「已等待 N 秒」——因为服务端确实没有
 * 告诉过它跑到哪一步，界面上也不肯编一个进度条。而轨迹本来就是这条链路的
 * 真实审计记录，把它同时当成**进度事件源**，界面就能显示真实的过程，
 * 不必再靠「把最终结果分几拍点亮」来假装直播。
 *
 * 事件是旁路：宿主抛错不影响引擎（try/catch 吞掉），引擎也从不依赖有没有人听。
 */
export type RunEventListener = (line: TraceLine) => void;

/** 取消检查点：宿主想在环节边界把这一次跑批停下来时，由它抛出 */
export type RunGuard = () => void;

const live = new Set<Trace>();
let exitHooked = false;
function hookExit(): void {
  if (exitHooked) return;
  // 宿主可能是浏览器（单文件版）：那里 process 只是个垫片，没有 on。
  // 没有退出事件就不装兜底 —— 但 flush 的两条硬规矩仍然成立，不会丢内容。
  if (typeof process === "undefined" || typeof process.on !== "function") return;
  exitHooked = true;
  process.on("exit", () => {
    for (const t of live) {
      try {
        t.flush();
      } catch {
        // 退出阶段尽力而为：这里再抛异常也救不回任何东西
      }
    }
  });
}

export class Trace {
  readonly path: string;
  readonly case_id: string;
  private lines: TraceLine[] = [];
  private pending: string[] = []; // 已序列化、待落盘
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writes = 0; // 真正落盘的次数（验收断言用：看它是否从 O(步数) 降到 O(1)）
  private onEvent?: RunEventListener;
  private guard?: RunGuard;

  constructor(caseId: string, meta: Record<string, unknown>, onEvent?: RunEventListener, guard?: RunGuard) {
    this.case_id = caseId;
    this.onEvent = onEvent;
    this.guard = guard;
    mkdirSync(RUNS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.path = join(RUNS_DIR, `${caseId}-${stamp}.jsonl`);
    this.pending.push(
      JSON.stringify({
        _type: "session_header",
        case_id: caseId,
        started_at: new Date().toISOString(),
        ...meta,
      }) + "\n",
    );
    this.flush(); // 会话头立刻落盘
    live.add(this);
    hookExit();
  }

  append(phase: Phase, kind: TraceLine["kind"], summary: string, detail: Record<string, unknown>): TraceLine {
    const line: TraceLine = { seq: ++this.seq, at: new Date().toISOString(), phase, kind, summary, detail };
    this.lines.push(line);
    this.pending.push(JSON.stringify(line) + "\n");
    if (this.pending.length >= FLUSH_EVERY) this.flush();
    else this.schedule();
    if (this.onEvent) {
      // 旁路：听的人出问题不该影响跑批，更不该污染轨迹
      try {
        this.onEvent(line);
      } catch {
        /* 事件出口是尽力而为 */
      }
    }
    return line;
  }

  /**
   * 取消检查点。放在环节边界上，语义是「在下一步之前停」：
   * 已经发生的处置不回滚（也不假装能回滚），还没发生的动作一定不会发生。
   */
  checkpoint(): void {
    if (this.guard) this.guard();
  }

  /** 攒一行就起个定时器；unref 让它不拖住进程退出（退出前由 flush 兜底） */
  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, FLUSH_MS);
    if (typeof (this.timer as any).unref === "function") (this.timer as any).unref();
  }

  /**
   * 把缓冲一次性落盘。同步是有意的：
   * 结果返回前调用，调用方拿到 trace_path 时文件必须已经写完。
   */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.pending.length) return;
    const buf = this.pending.join("");
    this.pending = [];
    appendFileSync(this.path, buf, "utf8");
    this.writes += 1;
  }

  /** 语义化的收尾（等价 flush，留给调用方读起来更清楚） */
  close(): void {
    this.flush();
    live.delete(this); // 已收尾的不用再进退出兜底
  }

  /** 已经真正写盘的次数 —— 只用于验收，不参与业务 */
  get flush_count(): number {
    return this.writes;
  }

  all(): TraceLine[] {
    return this.lines;
  }
}
