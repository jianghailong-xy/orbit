# 额度用尽（真实触发，2026-10-16 17:52 UTC）

所有者的 Cursor 账号是 Free 套餐。第 20 次真实 prompt（场景 `background-shell-and-commit`，run `2026-10-16T17-45-59-200Z`）发出后：

- **ACP 上看到的**（[`protocol/background-shell-and-commit.ndjson`](../../protocol/background-shell-and-commit.ndjson) seq 7–8）：
  只有一条 `agent_message_chunk`，文本 `"\n\nUpgrade your plan to continue"`，580 ms 后 `session/prompt` 返回
  `{"stopReason":"end_turn"}`。没有 JSON-RPC 错误，没有工具调用，没有 usage。
- **CLI 内部**（[`debug-log-excerpt.json`](debug-log-excerpt.json)，取自 CLI 自己的调试日志，已脱敏）：agent 流返回 Connect
  `ResourceExhausted`（code 8），`aiserver.v1.ErrorDetails` 解码后：
  - `error` = 51，`isExpected` = true
  - `details.title` = `You've hit your usage limit`
  - `details.detail` = `Get Cursor Pro for more Agent usage, unlimited Tab, and more.`
  - `additionalInfo`：`limitType=included_usage`，`spendLimitHit=false`，`spendLimits=[50,100,200]`，
    `chatMessage="*You've hit your free requests limit. [Upgrade to Pro](…) … Your usage limits will reset when your monthly cycle ends on 10/24/2026.*"`
  - 按钮 `View Usage` / `View Pricing` / `Upgrade to Pro`，动作 `upgrade`

  CLI 判定为 `ActionRequiredError`、不重试（`willRetry:false`），然后把它渲染成 ACP 正文里的固定句子
  `Upgrade your plan to continue`（源码 6136.index.js@15087 的 `upgrade` 文案）。服务端给的标题、说明和重置日期**不会**出现在 ACP 上。
- **同一时刻的用量接口**：`DashboardService/GetCurrentPeriodUsage` 仍返回 `totalPercentUsed: 0`、
  `displayMessage: "You've used 0% of your included usage"`。`GetPlanInfo` 返回 `planName: "Free"`。
  也就是说，这条免费请求上限**不在**用量接口里体现（见契约 §11）。

之后同一账号的每次 prompt 都会得到同样的结果，直到 2026-10-24 账期结束。所以 P0a 剩下需要真实 prompt 的场景没能运行，契约里标为待验。
