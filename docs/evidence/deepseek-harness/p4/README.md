# P4：Orbit MCP、工具审批与 Agent 指令

固定 `@deepseek-ai/dsh@0.2.0-rc.2`（Linux x64、Node 26），在仓库根运行：

```sh
bash scripts/test-dsh-mcp-approval.sh [--evidence <dir>]
```

脚本先以 TAP 文件运行 `test/test-dsh-mcp-approval.test.mjs` 的防护用例，再重建 shared、编译 API 测试并执行具名的权限能力用例，随后在隔离目录 `npm ci` 当前仓库 canonical 的 P0 锁文件、核对 CLI 版本与哈希，以 `go test -json` 执行全部具名 Go 场景（其中 8 个跑真 dsh），最后对进程内场景跑 `go test -race`。缺失、未匹配、跳过、失败或启动失败都非零退出；真实 `~/.dsh` 与 `~/.agents` 前后指纹必须一致。本目录的 `summary.json`、`acceptance-output.txt`、`race-output.txt` 与 `recordings/` 来自 `--evidence` 运行。

真场景都走生产会话循环（`runDshSessionProcess`）和生产准备器（`prepareDshAgentConfigAt` + 会话 agent overlay）：模型是脚本化的本地 Messages SSE 端点；Orbit MCP 是本 runner 二进制的真实 `orbit mcp` 代码，`ORBIT_HOME` 指向临时配置，所有调用（含 `task_create`、`task_comment` 及其审批卡）只到达隔离的控制面替身。录制把审批卡、控制面请求、Orbit 事件与文件副作用放在一起对照。

## 权限模式（实测）

| Orbit 模式 | dsh 启动策略 | 未获批动作 | 场景 |
| --- | --- | --- | --- |
| Default | `read-only` + 审批桥接 | 每次写（工具或命令）先出一张 Orbit 审批卡，允许只放行这一次 | `TestDshRealApprovalAllowOnce`、`TestDshRealApprovalReject`、`TestDshRealApprovalStop`、`TestDshRealApprovalDisconnect` |
| Don't Ask | `read-only`，提权请求一律 `reject-once` | 拒绝，不出卡，转录中有 `permission_denied` | `TestDshRealDontAskRejectsUnasked` |
| Auto | `workspace-write` + 审批桥接 | 工作区与临时目录内的写和命令直接执行；其他位置被沙箱拒绝，提权出卡 | `TestDshRealAutoWorkspaceBoundary` |
| Plan、Accept Edits、Bypass | 无可强制的等价策略 | 服务端拒绝（`assertDshPermissionMode`），runner 启动前以 `DSH_PERMISSION_UNSUPPORTED` 拒绝 | `TestDshPermissionPolicy/unsupported-modes-refused-before-launch` 及 API 用例 |

shared 的 `derivePermissionSemantics` 与服务端准入用同一集合 `DSH_PERMISSION_MODES`，因此客户端标注为不支持的模式正是服务端拒绝的模式（`P4 dsh: the server admits exactly the modes the picker describes as honored`）。

## 审批

- `session/request_permission` 只带 `toolCallId`。dsh 在请求前 drain 该调用的 `tool_call`；runner 的单读者在同一顺序里先应用更新，所以 `dshEventMapper.toolCall` 能取到名称与 `rawInput`，审批卡显示 `toolName`、`input`、`toolUseId`（录制回放 `TestDshEventsToolCallJoin`，真 CLI `TestDshRealApprovalAllowOnce`）。找不到对应调用时回复 `reject-once` 并记录 `permission_denied`；选项不是 P0 记录的 `allow-once`/`reject-once` 时回复 `cancelled`，从不默认放行。
- 只有 Orbit 的 `ALLOWED` 映射为 `allow-once`，`DENIED` 为 `reject-once`；卡片无法创建或读取即无决定（`cancelled`）。没有“记住/始终允许”：第二个操作重新出卡。
- 审批等待在独立 goroutine 上，读者不阻塞（`TestDshACPPermissionRoundTrip`）。停止、结算、关机、租约丢失与传输断开先关闭审批桥，再发 `session/cancel`；“允许”的检查与写出共用一把锁，所以停止之后到达的许可不会写给 dsh（`TestDshPermissionBridge/late-allow-after-stop-is-never-sent`、`TestDshRealApprovalStop`）。dsh 进程断开时回合以 FAILED 结算、未终态工具补 failed，卡片轮询随回合停止，迟到许可没有接收方（`TestDshRealApprovalDisconnect`）。服务端在回合结束后回收这类卡片（`abandoned-approvals.ts`）。

## MCP

- Orbit MCP 按 P0 契约注入每次 `session/new` 与 `session/resume` 的 `mcpServers`：无 `type` 的 stdio entry，绝对路径的 runner 可执行文件 + `mcp`，env 显式携带 `ORBIT_SESSION_ID/AGENT_ID/TASK_ID`、编排/Watch/Wiki 开关、`ORBIT_MCP_PERMISSION_PROMPT=0`、`ORBIT_SPAWN_DEPTH`、`ORBIT_HOME` 与后台作业变量（dsh 只按声明的 env 启动 stdio server）。Harness Key 不进入 MCP env。
- 预校验，不信任 `session/new` 成功：SSE entry 会被 ACP SDK 静默丢弃，启动前以 `DSH_MCP_UNSUPPORTED` 拒绝；HTTP MCP 未经实测，同样拒绝；相对命令、占用会话身份变量的 env 被拒绝。
- MCP 工具从不触发 ACP 审批，即使声明 `destructiveHint`（`TestDshRealThirdPartyMCPRunsUnasked`）。因此 agent 自配的 stdio server 只在 Auto 中挂载；Default 与 Don't Ask 下以 `DSH_MCP_UNENFORCEABLE` 拒绝启动。Orbit 自己的 MCP 在所有 runtime 中都属 `ALWAYS_ALLOWED_TOOLS`，其有副作用的创建类调用自带 Orbit 审批卡。
- **60 秒调用期限**：dsh 对经 ACP 挂载的 MCP 调用固定 60 秒超时（`toolCallTimeoutMs` 默认值，ACP 不可配置），超时后模型看到 `Error: Request timed out`，并向 server 发送 `notifications/cancelled`（实测 `TestDshRealMCPTimeoutCancelsTheCall`）。修复前，需要人工确认的 Orbit MCP 调用会出现“模型收到失败、确认后副作用照常发生”。现在 runner 在 Orbit MCP env 中注入 `ORBIT_MCP_CALL_TIMEOUT_SECONDS=60`：等人的调用（`task_create`、`task_create_batch`、`project_create`、`project_blocker_resolve`、`tasklist_propose_dag`、`provider_*`）立即返回“尚未执行”，把等待交给 runner 托管的后台作业，确认后由作业执行写入并唤醒会话；无作业服务时明确拒绝、不出卡。`session_create` 的 wait 与 `session_merge` 的 `waitSeconds` 限制在 30 秒内。实测、复现命令与剩余限制见 [`../p4-mcp-timeout/README.md`](../p4-mcp-timeout/README.md)。

## Agent 配置

- 系统提示：agent 的 `systemPrompt`、`appendSystemPrompt` 与 Orbit CLI 指引合成一段，作为字面量追加段（`interpolate:false`、`order:10201`），由会话目录内带版本 manifest 的小插件加载，目录名含代码哈希；Harness 默认 identity 与工具指导保留（`TestDshRealOrbitMCPAndAgentInstructions` 检查模型请求的 system 字段）。文本只是提示内容，不作为 provider 配置或模板。agent overlay 是独立的第二个 `--patch`，纳入 `ConfigHash`。
- 发现：工作区 `AGENTS.md` 与项目 `.agents/skills`、`.dsh/skills` 进入模型上下文；`DSH_AGENTS_HOME` 固定在会话目录，runner 用户的 `~/.agents` 技能不进入会话。
- 工具限制：`disallowedTools` 无法在 dsh 执行前强制（读、沙箱内命令、MCP 都不询问），以 `DSH_TOOL_POLICY_UNSUPPORTED` 拒绝启动；`allowedTools` 不用于放宽任何东西，提权仍出卡。

## 继承边界

- 原生工具：只有文件沙箱提权会询问；读文件、只读命令、web 工具不询问。沙箱不限制命令的网络访问，也不是同 UID 读取凭据的隔离边界（P0 §5）。
- MCP：见上；不受文件沙箱约束，从不询问。
- 子代理：实测子代理的提权请求不会到达 ACP（被静默拒绝），其工具调用也不投影给 Orbit；在 workspace-write 下子代理可在工作区写入而 Orbit 不可见。Orbit overlay 因此禁用 `subagent`、`subagent_fork`、`send_message`/`list_agents` 控制与 `workflow`；模型调用 `subagent` 得到 unknown tool 失败（`TestDshRealOrbitMCPAndAgentInstructions`）。

## 未覆盖

真实 DeepSeek API 与模型、macOS/Windows、HTTP MCP、Web/macOS/iOS 的审批卡呈现与模式选择器（P5）不由本证据确立。
