# 电商数据连接器（MCP）

`server.mjs` 是一个**零依赖**的标准 stdio MCP 服务端，换行分隔的 JSON-RPC 2.0。
把它接到任意 MCP 宿主上，对方就获得了本项目的数据接入工具面 —— 数据接进来这件事
不必绑死在本项目的界面上。

## 对外暴露的工具

工具名以 `commerce.` 前缀做命名空间化（同一宿主里挂多个数据源不会撞名）。
工具面**不硬编码**，全部由 `../data/connectors.json` 的声明派生。

| 工具 | 作用 | 数据来源 |
| --- | --- | --- |
| `commerce.orders_list` | 按店铺与时间窗拉订单 | `mcp/data/orders.csv` |
| `commerce.orders_get` | 按订单号查单条订单 | 同上 |
| `commerce.refunds_list` | 按店铺与时间窗拉退款申请 | `mcp/data/refunds.csv` |
| `commerce.refunds_get` | 按退款单号查申请 | 同上 |
| `commerce.tickets_list` | 按订单号拉客服工单 | `mcp/data/tickets.csv` |
| `commerce.logistics_list` | 按时间窗拉物流轨迹 | `mcp/data/logistics.csv` |
| `commerce.logistics_get` | 按订单号拉物流与签收事实 | 同上 |
| `commerce.sku_list` | 按店铺拉商品规格 | `mcp/data/sku_specs.csv` |
| `commerce.sku_get` | 按 SKU 拉规格与可退服务费 | 同上 |

`tools/call` 的返回同时给 `content[].text`（JSON 字符串，兼容只认文本的宿主）
和 `structuredContent`（已还原类型的对象数组），调用方不必再解析一遍字符串。

## 接入 MCP 宿主

任意宿主通用的一段配置（把 `<绝对路径>` 换成本工程路径）：

```json
{
  "mcpServers": {
    "commerce": {
      "command": "node",
      "args": ["<绝对路径>/mcp/server.mjs"]
    }
  }
}
```

本项目的本地服务端（`desktop/server.mjs`）就是这么接的：启动时拉起本文件、
走完 `initialize` → `tools/list`，界面上「数据源」里点「拉取」时调 `tools/call`，
返回的行再交给 `src/ingest.ts` 校验并合并。**取数与入库是两件事**，
数据源只管交数据，口径由引擎一侧统一把关。

## 手测

```bash
node mcp/server.mjs --list                          # 打印工具清单
node mcp/server.mjs --call commerce.orders_list     # 调一次工具，看返回 JSON
```

完整握手（initialize → tools/list → tools/call）见 `../.tmp/mcp-selftest.mjs`。

## 换成真实平台

1. 在 `../data/connectors.json` 里改/加一条连接器声明（工具名、数据表、数据文件）；
2. 把 `readRows()` 换成对真实开放平台 API 的调用（抖音小店 / 微信小店 / 天猫 / 拼多多的
   开放平台均为 AppKey + Secret 换 access_token 的形态）；
3. 凭据只从环境变量读，不要写进本目录的任何文件。

`server.mjs` 与 `src/ingest.ts` 都不用改 —— 这是把「数据从哪来」抽成声明的全部意义。

> 本目录下的数据文件均为**合成数据**，只用于演示工程，不对应任何真实商家。
