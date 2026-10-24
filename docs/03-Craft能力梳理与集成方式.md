# 03 · Craft（craft-agents-oss）可用能力梳理与集成方式

> 本文回答任务书的第一个要求：「先认真研读飞书 crfact 相关资料、接口文档和示例，梳理可用能力与集成方式」。
> 梳理基准是 craft-agents-oss 仓库源码（前序会话已逐条核验，非二手资料）；本工程**参考其设计、未复用其任何代码**——本工程是零依赖单仓演示，Craft 是完整的 Agent 运行时，两者体量与定位不同。
> 简历表述口径：本项目为「参考 Craft Agents 架构思想自建的最小可运行实现」，凡写进简历的能力点都以本仓库 `src/` 下的可运行代码为准。

---

## 一、能力清单：Craft 里有什么，本项目对应什么

下表左列是 Craft 源码中真实存在的能力项（R 编号为源码内定位），右列是本项目 `src/` 下的对应实现。**「对应实现」列全部可跑、可指到文件行**，不是概念映射。

| # | Craft 能力（源码定位） | 它解决什么问题 | 本项目对应实现（文件） | 集成方式 / 差异 |
|---|---|---|---|---|
| R06 | **Permission Mode + PreToolUse 管线**：工具执行前有一道强制校验管线，权限模式决定「谁能批准什么」 | 把授权从「提示词里写请勿执行」的软约束，变成执行前的硬校验 | `src/auth.ts` 的 `classify()` + `requestApproval()`；`src/agent.ts` 审批环节 | **同构复刻**：三档授权（只读 AUTO / 非资金不可逆 ASK / 资金类按金额分档）+ 审批回调回路（请求交回宿主 → 裁决 → 回写留痕）。Craft 的管线挂在进程边界上，本项目挂在编排函数里，判定顺序与分档逻辑一致 |
| R17 | **SessionToolContext**：每个会话持有自己的工具上下文，工具可见性随会话状态变化 | 防止「工具全量常驻」导致的误调用与上下文膨胀 | `src/tools.ts` 的 `assemble(tools, phase)`；`src/agent.ts` 各环节开头 | **同构复刻**：按 SOP 环节动态装配。取证环节的装配里结构上不存在可执行工具（`agent.ts` 里有断言，出现即抛错）；到审批环节才装入 3 个动作工具 |
| R18 | **Sources / Skills / MCP ServerBuilder**：多来源工具统一注册，命名空间消解同名覆盖 | 跨系统工具名冲突（两个系统都有 `query_order`） | `data/tool-registry.json` + `src/tools.ts` 的 `buildTools()` / `fq()` | **同构复刻**：全部工具挂 `aftersales.*` 统一命名空间；声明式注册表（每个工具自声明 `phases` / `read_only` / `money_action` / `signature`），新数据源只加一条声明 + 一个 runner，装配/授权/三层上下文自动继承 |
| R09 | **JSONL 双模型**：会话以 JSONL 逐行落盘，首行会话头，可按行回放、按步定位 | 决策不可回放 = 不可审计 | `src/trace.ts` 的 `Trace` 类；运行产物在 `runs/*.jsonl` | **同构复刻并扩展**：Craft 的轨迹覆盖执行层；本项目把轨迹从「客户原话」延伸到「结单回执」全链路，每次工具调用带 `args_hash` + `fields_snapshot` |
| R13 | **Channel Map 契约测试**：渠道与能力之间有显式契约，契约可测试 | 「换了渠道/数据源后行为静默漂移」 | `data/policy.json` 的 `field_contract` + `src/context.ts` 三层披露；`samples/cases.json` 回归门禁 | **同构复刻**：字段口径写成显式契约（`paid_amount` 是什么、封顶怎么算）；`--gate` 对 8 个样本逐一比对期望行为，契约被破坏立即退出码 1 |
| R25 | **行为评测（Behavioral Eval）**：用样本集验证 Agent 行为，而非只测函数返回值 | 单元测试全绿但 Agent 行为仍旧跑偏 | `samples/cases.json` 三级样本（GOLD/BAD/AMBIGUOUS）+ `src/cli.ts --gate` + `--ablation` + `--violation-demo` | **同构复刻并加强**：除期望比对外，提供两个负向实验证明门禁有效——摘掉 Reviewer（BAD 样本放行率 2/2 → 0/2）、绕过 clarify 保护（SR-01 硬阻断） |

## 二、Craft 有而本项目刻意没有的（边界声明）

诚实标注差距，面试被问到时不虚：

| Craft 能力 | 本项目为什么不实现 |
|---|---|
| 进程隔离 / 沙箱执行 | 演示工程单机单进程，工具 runner 就是内存函数。生产形态应把 runner 换成真实 RPC，`invoke()` 的签名不变 |
| 凭据 Broker（密钥不落 Agent 上下文） | 本项目的模型密钥走 `.env` + `src/env.ts` 占位检测，没有 broker。真实集成时应把 `callModel` 的取密钥动作换成 broker 调用 |
| 多模型路由 / 流式 / 重试策略 | `src/llm.ts` 只做「唯一一处调用 + 形状校验 + 失败不静默降级」。路由与重试是运行时职责，不属于本演示范围 |
| 完整的 Skill / MCP 加载器 | 用「声明式注册表 + runner 闭包」等效表达。新增数据源的成本结构相同（改数据不改编排），但加载机制是简化版 |
| 前端 / 多端渠道 | 本项目的「渠道」就是 CLI。结单回执的 `customer_text` / `internal_note` 双轨结构就是为多渠道准备的：换成 IM 渠道只需替换渲染层 |

## 三、如果要接进真实 Craft：集成路径

按「改动量从大到小」排列，三条路径都验证过接口假设（本项目 `Deps` / `RunOptions` 的边界就是按这些假设切的）：

1. **工具面接入（最完整）**：把 `data/tool-registry.json` 的每条声明翻成 Craft 的 tool 注册，`src/tools.ts` 的 runner 换成真实业务 RPC。授权分档直接复用 R06 管线——本项目的 `classify()` 判定顺序（只读 → 非资金 → 按金额）可以逐条翻译成 Craft 的 permission rule。
2. **评审器接入（最实用）**：只把只读 Reviewer（`src/reviewer.ts` 的 A1–A5 + B 组检查）作为一个独立 Agent 角色接进 Craft 的会话，让它持有「只读工具 + 驳回权 + 补查请求权」，不给它任何执行工具——这与 R17 的 SessionToolContext 天然契合。
3. **轨迹接入（最轻）**：把 `runs/*.jsonl` 的格式（session_header + 每行一事件 + `args_hash`）作为审计格式对接 Craft 的 R09 落盘，本项目已有的 8 个样本可直接当回归用例。

## 四、歧义与假设（任务书要求「资料存在歧义，自行做合理假设并在交付中说明」）

1. **「crfact」= craft-agents-oss**：用户口误，按 craft-agents-oss 理解；若指其他仓库，工具面与授权两层设计不受影响，SOP 与数据需重造。
2. **Craft 未提供「售后 SOP」本体**：五环节 SOP（受理 → 取证 → 判责 → 审批 → 结单）与六种案件类型是本项目的领域契约（`data/sop.json`），参照电商售后通用流程自拟，非任何真实平台流程，数据全部合成。
3. **模型通道**：Craft 本身不绑定模型；本项目用 OpenAI 兼容 `/chat/completions`（智谱 GLM 为默认配置）。本机沿用的密钥已失效（HTTP 401），因此全部验证在 `--offline` 规则占位模式下完成——工具面、装配、授权、复核、轨迹这些确定性逻辑与模型无关，模型只承担「理解 / 判责 / 回执」三个文本环节。
4. **「接口文档和示例」**：craft-agents-oss 的接口形态即源码本身（无独立 API 文档），因此梳理基准为源码结构；本文所有「源码定位」指前序会话的核验结论。
