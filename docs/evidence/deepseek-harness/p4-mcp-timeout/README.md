# dsh：Orbit MCP 长等待调用与 60 秒调用期限

固定 `@deepseek-ai/dsh@0.2.0-rc.2`（Linux x64、Node 26，CLI sha256 `1a03dee1…f307f`，与 P0 记录一致），在仓库根运行：

```sh
bash scripts/test-dsh-mcp-timeout.sh [--evidence <dir>]
```

脚本在隔离目录 `npm ci` canonical 的 P0 锁文件并核对版本与哈希，以 `go test -json` 执行 13 个具名 Go 场景（其中 3 个跑真 dsh），再对 10 个进程内场景跑 `go test -race`；缺失、未匹配、跳过、失败都非零退出，真实 `~/.dsh`、`~/.agents` 前后指纹必须一致。`summary.json`、`acceptance-output.txt`、`race-output.txt` 与 `recordings/` 来自 `--evidence` 运行。真场景沿用 P4 的方式：生产会话循环和准备器，脚本化的本地模型，本 runner 的真实 `orbit mcp`，以及隔离的控制面替身。

## 1. 实测：超时与取消

`TestDshRealMCPTimeoutCancelsTheCall`（Auto 模式，挂一个记录全部入站帧、对 `hold` 永不回复的 stdio MCP）：

| 观察 | 实测 |
| --- | --- |
| 模型收到的结果 | 60 秒时工具结果为 `failed`，内容是 `Error: Request timed out` |
| 发给 server 的帧 | 先是 `tools/call`（id 2），随后是 `notifications/cancelled {"requestId":2,"reason":"SdkError: Request timed out"}` |

dsh 会发送取消通知。但修复前的 `orbit mcp` 收不到这个通知：`serve` 循环是串行的，`askBeforeCreate`/`awaitApprovalDecision` 阻塞期间不读 stdin，而 `handle` 对 `notifications/cancelled` 本来也只是忽略。

修复前的复现：在 `8dab80ea6`（P4 落地后的项目分支）上打上 `before/probe.patch`，运行 `TestDshRealOrbitMCPTimeoutBefore`。确认卡在 60 秒内无人处理，模型看到 `Error: Request timed out`（`failed`），回合结束；之后确认卡片，替身控制面上**照样创建了 1 个任务**（`before/TestDshRealOrbitMCPTimeoutBefore.json`、`before/go-test-output.txt`）。这正是本任务要消除的不一致。

## 2. 方案

采用 (a)，以 runner 注入的 env 识别 dsh 会话：`dshOrbitMCPEnv` 增加 `ORBIT_MCP_CALL_TIMEOUT_SECONDS=60`，其他运行时都不设置。

- **等人的调用转为非阻塞**：`task_create`、`task_create_batch`（`dryRun` 除外）、`project_create`、`project_blocker_resolve`、`tasklist_propose_dag`、`provider_create|update|delete`。在设置了期限的会话里，`orbit mcp` 不再在本次调用中出卡等待，而是：
  - 把原样的 `tools/call` 请求写入临时文件，经会话的 runner 后台作业服务启动一个 `watch` 作业（`wakeOnExit`）。作业就是同一个 `orbit mcp`，只服务这一个工具、去掉期限，并带上原会话的 agent/task/编排身份；请求文件打开后即删除。
  - 立即返回 `Not done yet — handed to runner-hosted job bgj_…`：说明尚未写入，只有确认后才由作业执行，不要重复调用，作业结束时会唤醒会话并附上本次调用本应返回的结果。
  - 作业出卡时卡片带 `backgroundJobId`，因此不会在回合结束时被回收。确认后由作业写入；拒绝则不写入。作业退出的唤醒里带有 JSON-RPC 结果（创建出的对象，或拒绝原因）。
- **无法一致时明确拒绝**：会话没有后台作业服务或无法解析 orbit 可执行文件时，调用以 `isError` 返回“was not run, and nothing was filed or written”，不出卡，不触达控制面。
- **有界的内联等待限制在期限的一半内**：`session_create` 的 `wait` 从约 10 分钟降到 30 秒。这次等待本身已记录 watch，超时后返回会话的最新状态，由 watch 负责后续唤醒。`session_merge` 的 `waitSeconds` 上限降到 30（加客户端余量共 50 秒）；等待耗尽本来就不算失败，结果由 `merge_receipts` 给出。
- `ask_owner` 本来就是立即返回的，不需要改动。
- **(b) 未做**：取消已实测存在，但有了 (a) 之后，dsh 会话里已没有任何会等人超过期限的 Orbit 调用，取消通知到达时也就没有可撤回的等待；为此给 `serve` 引入并发得不偿失。
- **(c) 未采用**。

## 3. 修复后（真 dsh）

`TestDshRealOrbitMCPConfirmationOutlastsTimeout`（Default 模式，带生产同款后台作业服务）：同一会话里连续两轮 `task_create`，卡片都在调用后 65 秒才处理，即超过 dsh 的 60 秒期限。

| 轮次 | 模型看到 | 期间写入 | 处理 | 最终写入 | 唤醒内容 |
| --- | --- | --- | --- | --- | --- |
| t1 | `completed`：`Not done yet — handed to … bgj_44753404ed25`，0 秒返回 | 0 | 允许 | 1（`X-Orbit-Agent-Id: p4-agent`，会话头为原会话） | `{"id":"p4-double-task","title":"P4 confirmed late"}` |
| t2 | `completed`：`Not done yet — handed to … bgj_a2f793bda4c7`，0 秒返回 | 0 | 拒绝 | 0 | `the human rejected this task: denied by the user` |

模型被告知的（尚未执行、结果稍后送达）与实际发生的一致，不再出现“报告失败、随后写入”。`TestDshRealOrbitMCPAndAgentInstructions`（P4 场景）同步调整为走作业路径：自动允许的卡片仍然只有一张 `orbit_task_create`，任务仍以本 agent 身份写入。

## 4. 回归（非 dsh 行为不变）

- `TestMCPOwnerWaitBlocksInTheCallWithoutAnEngineDeadline`：未设期限时，`task_create` 仍在调用内由本进程出卡（卡片不带 `backgroundJobId`），确认前不返回，确认后写入并返回结果。
- `TestMCPInlineWaitsEndBeforeAnEngineDeadline`：未设期限时 `sessionWaitPolls(0)` 仍是 200，`session_merge` 仍按原值 120 发送；设为 60 时分别降到 ≤30 秒和 30。
- 原有的 `TestMCPTaskCreateBatch*`、`TestMCPSessionCreateWaitTellsTheModelTheWaitIsNotLost` 与 `TestDshMCPServers`（新增 env 断言）照常通过。
- `TestMCPOwnerWaitIsHandedOffUnderAnEngineDeadline`：进程内走真实 socket 与作业的全链路，覆盖允许和拒绝两条路径，并检查请求文件没有残留。
- `TestMCPOwnerWaitIsRefusedWithoutAJobService`：8 个工具都被拒绝，且没有触达控制面。

## 剩余限制

- 作业由会话的 runner 托管：会话结束时作业随之被杀，之后再确认也不会写入（没有进程消费这个答案）。卡片何时从界面上收回由服务端现有规则决定，本证据未验证这一点。runner 跨版本自更新时按现有后台作业交接规则处理，同样未单独实测。
- 唤醒内容是作业的输出尾部（JSON-RPC 原文）；大批量创建的完整结果需用 `bg_output` 读取。
- 工具描述（例如 `task_create` 的“BLOCKS until they answer”）在所有运行时共用，没有为 dsh 单独改写；dsh 上的实际行为以返回文本为准。
- 参数校验错误在 dsh 上不会内联返回，而是随作业结果（通常几秒内）送达。
- 未覆盖：真实 DeepSeek API/模型、macOS/Windows、HTTP MCP，以及卡片在 Web/macOS/iOS 上的呈现。
