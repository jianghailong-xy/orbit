# agy 1.2.15 stream-json 样本

2026-10-03 在本机 runner 上用**真 agy 1.2.15** 加 [`../mockgemini`](../mockgemini) 录制，供阶段 1 的事件解析和
进程管理测试回放。结论见 [`docs/antigravity-runtime-contract.md`](../../../../docs/antigravity-runtime-contract.md)，
录制脚本是 [`docs/evidence/antigravity-cli-1.2.15/gen_samples.py`](../../../../docs/evidence/antigravity-cli-1.2.15/gen_samples.py)。

每个样本一个目录：

| 文件 | 内容 |
| --- | --- |
| `stdin.jsonl` | runner 写进 agy stdin 的每一行，原样 |
| `stdout.jsonl` | agy 的 stdout，一行一个事件，原样 |
| `stderr.txt` | agy 的 stderr（去掉了录制时间戳） |
| `meta.json` | argv、settings.json 里加的键、写入 gemini 目录的配置文件、退出码、驱动动作顺序（写第几行、等第几个 result、发什么信号）、一句话说明 |

机器相关的值已替换：工作区 `/work/repo`、Orbit 的每会话 gemini 目录 `/work/orbit-gemini`、HOME `/work/home`、
mock 地址 `http://127.0.0.1:MOCK`、辅助脚本 `/work/tools/`。所有样本的环境都带 `AGY_CLI_DISABLE_AUTO_UPDATE=true`
和 `ORBIT_SESSION_ID=sample-session`，settings.json 为 `{"modelProvider":"gemini","enableTelemetry":false}`。

| 样本 | 退出码 | 看点 |
| --- | --- | --- |
| `text-multiturn` | 0 | 两轮；正文先是 `ACTIVE` 的 `text_delta`，最后一块在 `DONE` 里；模型发的思考不出现；`num_turns`、`usage` 按会话累计 |
| `tools-skip-permissions` | 0 | `run_command`、`write_to_file`、`replace_file_content`、`view_file`、失败命令、未知工具；`ACTIVE` → `DONE`/`ERROR`；参数只给展示子集 |
| `denied-default` | 0 | 默认模式：需要审批的工具被软拒绝，整轮立即结束、`response` 为空、`status` 仍是 `SUCCESS`；`denied_actions` 是累计去重集合；每轮一行 `jetski: no output produced` |
| `error-invalid-key` | 3 | `error_message` 步骤、`status:"ERROR"`、stderr 上的 `AGY_ERROR:` JSON；进程退出，第二条输入没人处理 |
| `error-quota-429` | 3 | 429 带 40s RetryInfo：不重试，`retryable:true` |
| `interrupt-sigint-streaming` | 1 | 流式中途 SIGINT：`error:"interrupted"`，`response` 是已经流出的部分 |
| `interrupt-sigint-tool` | 1 | 命令运行中 SIGINT：工具步骤停在 `ACTIVE`，agy 自己杀掉命令的进程组 |
| `midturn-message-queued` | 0 | 轮次中写入的第二条输入排队，成为第二轮 |
| `slash-model-ends-session` | 2 | 流里出现 `/model`：`ERROR` 后进程退出 |
| `unknown-conversation` | 0 | `--conversation` 指向不存在的 id：stderr 一行 warning，然后悄悄开新会话 |
| `ask-question-headless` | 0 | `ask_question` 只表现为 `step_type:"unknown"`，模型得到 "User Skipped" |
| `mcp-call` | 0 | `call_mcp_tool`（`ServerName`/`ToolName`/`Arguments`）调到 gemini 目录里配置的 stdio MCP 服务器 |
| `hook-deny` | 0 | skip 模式下 PreToolUse hook 拒绝：工具 `ERROR`，理由回给模型，轮次继续 |
| `resume/` | 0, 0 | 第二个进程 `--conversation` 续上：同一个 `conversation_id`、`step_index` 接着数、多一个 `system_message` 步骤、累计值包含上一个进程 |
| `resume-after-error/` | 3, 0 | 先报错退出，再续上：两轮都成功（没有 `error_message`、进程不退），但每个 `result` 仍是 `ERROR` 加旧错误 |

这些是 mock 驱动的样本：模型侧的字节是脚本写的，agy 侧的事件、退出码、stderr 是真 agy 产生的。
真实 Gemini key 下的样本（真实思考、缓存命中、真实配额错误）见契约 §11 的待补项。
