# 模型提供方拒答（真实触发，2026-10-16 17:32 UTC）

旧版 `crash-recover-and-move` 场景（run `2026-10-16T17-30-18-093Z`，场景定义后来拆成 `crash-recover-and-move` + `crash-continue`）在崩溃并搬运会话后发的续聊 prompt
（"Two steps: 1) Run the shell command `env | sort > env-after-move.txt`. 2) Then tell me the exact shell command you ran in the previous turn…"）被拒：

- **ACP 上**（[`protocol.ndjson`](protocol.ndjson)；回放样本 [`src/runner-go/testdata/cursor/provider-refusal-after-crash/moved/`](../../../../../../src/runner-go/testdata/cursor/provider-refusal-after-crash/moved/)）：
  一条 `agent_message_chunk`，文本 `"\n\nRequest blocked We are unable to complete this request because it was blocked under the model provider's usage guidelines. Try a less sensitive prompt."`，
  然后 `session/prompt` 返回 `{"stopReason":"end_turn"}`。没有 JSON-RPC 错误。
- **会话库**（[`store-excerpt.json`](store-excerpt.json)，只取 JSON 消息块；二进制块用每个库自己的密钥加密，已省略）：加载后、下一轮发出时，CLI 给崩溃时没完成的
  Shell 调用补了一条工具结果 `"Error: Shell command was interrupted before it completed. It may still be running."`（`isError: true`）。
  被拒的这一轮在库里是一条空的 assistant 消息。第一轮由 Auto 路由到 `cursor-grok-4.5-high`，这个模型名只出现在库里，ACP 上看不到。

在另一次同样的崩溃加搬运之后（run `2026-10-16T17-45-08-331Z`，`crash-continue-and-shell-wrapper` 的第一问），换成不导出环境变量的续聊问题，
模型准确答出上一轮的命令。所以拒答针对的应是 prompt 内容（导出全部环境变量），不是崩溃后会话结构坏了。这一点是推断，没有在同一会话上重放验证。

这条记录保留下来作「模型拒答」的真实错误形状。原场景的其他断言见 [`scenario.json`](scenario.json)。
