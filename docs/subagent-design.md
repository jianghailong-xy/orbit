# SubAgent 设计

**状态**：设计稿（2026-11-11）；§9 的三项 owner 已于 2026-11-11 拍板，均按推荐。效果图：[`mocks/subagent/board.html`](./mocks/subagent/board.html)
（PNG 在同一目录）。界面文案以效果图里的英文为准。

> **用词**：**SubAgent** 指父会话通过 `delegate` 工具交出去的一次运行，不是一个 Agent（Agent 是长期存在的身份，见
> [`project-agent-contract.md`](./project-agent-contract.md) §3.1）。界面上它叫 `SubAgent`，代码里叫 subagent run。
> **父会话**是调用 `delegate` 的那个会话。**档位**指 S / M / L / XL，同 [`model-routing-design.md`](./model-routing-design.md) §3.1。

## 0. 一页结论

- 父会话的模型调用一个新的 Orbit MCP 工具 `delegate`，Orbit 在**同一台 runner、同一个 cwd**（父会话的 worktree，或不开
  worktree 时的工作目录）里起一个子引擎进程去做这段活。子引擎可以和父会话不同：Claude 会话可以把活交给 DeepSeek、Codex、Kimi。
- 过程**内嵌在父会话的消息流里**，和引擎自带的 Agent 工具一样：一个可折叠的块，前台时父模型等它返回，后台时父模型继续，
  结束时唤醒父会话。
- **执行者由 Orbit 选**：先定档（父 Agent 给的 `size` / 定义文件 / 内置类型默认），再从**所有已启用的 Provider** 里按
  Optimize For 和额度选模型。每次选择都记一条决策，块头始终显示「档位 · 模型」。
- 子 Agent **直接改文件、不提交**；可以并行，写冲突由父 Agent 自己避开；不能再派 SubAgent；不能向人提问；权限模式不宽于父会话。
- 定义来自仓库现成的文件：`.claude/agents/*.md`、`.cursor/agents/*.md`（也读 `.codex/agents/`），另有内置 `explore` 和 `general`。
- **不建 Session 行**：SubAgent 的事件写进父会话的事件流（`parentToolUseId` = `delegate` 那次调用的 id），另有一张小表
  `subagent_run` 记路由决策、状态和花费，花费同时计入父会话。

## 1. 为什么不是 Task，也不是 `session_create`

| | 引擎自带 Agent 工具 | `session_create`（L3） | SubAgent |
|---|---|---|---|
| 在哪里跑 | 父进程内，同一 cwd | 新会话，**新 worktree，从 workDir HEAD 分出**（`worktree.go` `setupCheckout`），看不到父会话未提交的改动 | runner 上父会话的进程树内，同一 cwd |
| 显示 | 内嵌折叠块 | 另一个会话，消息流里一张跳转卡 | 内嵌折叠块 |
| 引擎 / 账号 | 只能是父会话自己的 | 任意，但要调用方手填 | 任意，Orbit 路由 |
| 记录 | 只在 transcript 里 | 完整 Session | 父会话事件 + `subagent_run` |

Task 带着完成标准、证据、落地和项目门禁，这些对「顺手交出去的一段活」全是负担；`session_create` 的独立 worktree 正好和
「在当前 worktree 下直接修改」相反。所以 SubAgent 是第三种东西，形态抄引擎自带的 Agent 工具，执行者用 Orbit 的路由。

## 2. 调用接口

```
delegate({
  description: string,          // 3–8 个词，块头显示
  prompt: string,               // 自包含的 brief
  type?: string,                // "explore" | "general" | 定义文件名；默认 "general"
  size?: "S" | "M" | "L" | "XL",// 父 Agent 判断的难度
  sizeReason?: string,          // 一句理由，进 Why
  model?: string,               // 点名模型（provider_list 里的 id），跳过路由
  background?: boolean,         // 默认 false
  resume?: string               // 续跑之前某个 SubAgent（它的 runId）
})
→ 前台：{ runId, status, result, changedFiles, model, costUsd }
→ 后台：{ runId, status: "running" }，结束时父会话收到一条 <orbit-subagent-finished> 并起新一轮
```

- 工具描述里列出当前 cwd 下能用的定义（名字 + `description`），父模型据此选 `type`，和 Cursor / Claude Code 一样。
  runner 的 `orbit mcp` 每次启动时在 cwd 里扫描，所以会话分支上新加的定义也能用（heartbeat 的资产扫描只看 workDir，见 §6.4）。
- 前台调用受 MCP 工具超时限制。等不完时按 `session_create wait` 的做法降级（`session_wait.go`）：交回「still running」，
  服务端持有一个 watch，SubAgent 结束时唤醒父会话；块仍在原位置。
- `changedFiles` 是 runner 从子 Agent 的编辑类工具事件里收集的路径，不是 `git status`（并行时 `git status` 分不清谁改的）。

## 3. 定义文件

读三处，同名时 `.cursor/` > `.claude/` > `.codex/`，项目 > 用户目录（`~/.claude/agents/` 等），与 Cursor 的优先级一致。

| frontmatter | 含义 | 不认识的值 |
|---|---|---|
| `name` | 默认取文件名 | — |
| `description` | 给父模型看，决定是否委派 | — |
| `model` | `inherit` = 父会话的模型；`auto` = 路由；具体 id = 点名 | 当作 `auto`，Why 里写明 |
| `size` | Orbit 扩展：S / M / L / XL | 忽略 |
| `readonly` | `true` → 权限模式降为只读（plan），不给编辑工具 | — |
| `tools` / `disallowedTools` | 原样传给支持它的引擎；不支持的引擎忽略并在 Why 里写明 | — |
| `is_background` | 作为 `background` 的默认值 | — |

正文是子 Agent 的系统提示，拼在 Orbit 的固定前言之后。固定前言（英文）说明：你在别人的 worktree 里，别提交、别切分支、别
`git stash`，做完用一段话交回结果。

内置类型：

| 类型 | 默认档 | 权限 | 用途 |
|---|---|---|---|
| `explore` | S | 只读 | 查找、阅读、回答「X 在哪里 / 怎么工作」 |
| `general` | M | 同父会话（不宽于） | 任何要改文件的活 |

## 4. 路由

### 4.1 定档（参考 Cursor：父 Agent 判断）

第一条命中即止：

| # | 条件 | 结果 | Why 示例 |
|---|---|---|---|
| 1 | `delegate(model=…)` | 用它，不路由 | `Model named by the caller: claude-opus-5-5` |
| 2 | 定义文件 `model: <id>` / `inherit` | 用它 / 父会话的模型，不路由 | `Model set by spec-writer.md` |
| 3 | `delegate(size=…)` | 这个档 | `Tier M, set by the caller: one service plus its spec` |
| 4 | 定义文件 `size:` | 这个档 | `Tier S, set by explorer.md` |
| 5 | 内置类型默认 | `explore` S，其余 M | `Tier M: default for general` |

Optimize For 只在第 5 条（没人给档位）时抬档：Balance 至少 M，Intelligence 至少 L，与 `model-routing-design.md` §3.5.3
的「只对没有建议的任务生效」同一口径。父 Agent 明确给的档位在任何模式下都不改。

**不在派发路径上跑分类器。** Cursor Router 用 ML 分类器逐请求判断；我们的父模型刚读完上下文，它给的档位不额外花钱，
而且路由器保持纯函数、不发网络请求（`model-routing-design.md` §0 的不变量）。没给 `size` 的调用会在报告里单独统计，
用来调内置默认值。

### 4.2 候选池与排序

**候选** = 所有已启用的 Provider × 它能跑的引擎（`provider_list` 的 `engines`）× 它的模型 × 引擎的 effort。依次去掉：

1. owner 在 SubAgents 设置里屏蔽的 Provider；
2. `usableProviderScope` 之外的（共享 Provider 只给管理员）；
3. 父会话所在 runner 上没装、没登录、区域不可用的引擎（`task-route-decision.ts` `engineState` 已有这些读法）；
4. 额度 ≥ 90%（`ENGINE_QUOTA_LIMIT`）或账号暂停中的；
5. **没有档位的模型**。自定义 endpoint 的模型要先在 Providers 页标档位才进池；点名（§4.1 第 1 条）不受影响。

**档位表**从「每个引擎一张」扩成「每个模型一行」：`(provider, model, effort) → 档位`。preset 的模型由目录提供档位和价格
（价格取自 models.dev，preset 列表本来就从那里刷新，`providerPresets.ts`）；Claude / Codex 内置登录沿用今天
`DEFAULT_MODEL_TIER_TABLE` 的映射。

**排序**（同档内）：

| Optimize For | 规则 |
|---|---|
| Cost（默认） | 边际花费最低的先（见 §9 待定 A），并列时额度余量多的先 |
| Balance | 同档里额度余量多的先，并列时便宜的先 |
| Intelligence | 同档里档位上限高的模型先（例如 L 档里 Opus 先于 Sonnet-high），并列时便宜的先 |

最后按 owner 在 Providers 页排的顺序打破平局。结果和理由冻结在 `subagent_run` 里，续跑不重算。

### 4.3 失败

- **额度 / 容量失败**（`USAGE_LIMIT_ERROR_MARKERS`、`MODEL_AT_CAPACITY_ERROR_MARKER`）：同档下一个候选重开，
  Why 追加 `Moved to <model> after <model>'s account hit its limit`（容量：`… was at capacity`）。同一次 `delegate` 最多换 2 次。
  runner 问 `POST /runner/sessions/:id/subagents/:runId/fallback`（带子进程的原话）；服务端从开跑时存下的决策里取
  候选（选中的那个 + `decision.fallbacks`，同档按排序剩下的），跳过已经撞过限额的 Provider，所以影子模式下同样生效。
  每次尝试记进 `subagent_run.attempts`（引擎、Provider、模型、结果、原话）。账号池暂不作为换去的目标（选池成员会写到
  会话上）；换第 3 次时回 `SUBAGENT_FALLBACK_SPENT`，不是额度失败回 `SUBAGENT_NOT_A_LIMIT_FAILURE`。
- **活本身失败**：不升档、不重跑，交回父 Agent，结果里写明。父 Agent 决定加档再派，还是自己做。
- 池子是空的：`delegate` 立刻返回错误 `NO_SUBAGENT_PROVIDER`，并列出每个 Provider 被去掉的原因。

## 5. 执行

### 5.1 时序

1. 父模型调用 `mcp__orbit__delegate`。runner 的 `orbit mcp` 收到后，在 cwd 里解析定义文件。
2. runner `POST /runner/sessions/:id/subagents`（会话凭证鉴权），带 `type / size / model / definition 的 model 与 size /
   readonly / background`。服务端：
   - 检查开关、并发上限、父会话权限模式；
   - 读 runner 行（模型目录、额度、暂停）和 owner 的 Provider，调用纯函数路由器；
   - 写 `subagent_run`（`RUNNING`），返回执行目标：引擎、模型、effort、权限模式、凭证环境（与 session claim 下发的同一形状，
     `resolveProviderExec`）。
3. runner 在**父会话的 cwd** 里起子引擎进程，复用各引擎现有的启动代码，像 `bg_run` 那样挂在父会话的进程树下
   （`background_job.go`）。子 Agent 拿不到 `delegate`。
4. 子进程的每个事件改写后写进**父会话的事件流**：`parentToolUseId` = `delegate` 的 tool_use id，子事件自己的 tool id
   加上 runId 前缀以免撞号。这样 web / iOS / Android 现有的嵌套渲染直接可用。
5. 结束：runner 回报 `PATCH /runner/sessions/:id/subagents/:runId`（状态、结果、changedFiles、用量与花费）。
   - 前台：作为 `delegate` 的 tool_result 交回父模型。
   - 后台：发一条终态 `background_task` 事件（清 `runningSubagents`），并经 `background-wake` 唤醒父会话。

### 5.2 与父会话生命周期

| 父会话发生的事 | SubAgent |
|---|---|
| 一轮结束（有后台 SubAgent 在跑） | 继续跑；会话显示 `Running Agent`（`runningSubagentCount` 已经把它算进去） |
| 空闲停放（park） | **等后台 SubAgent 结束才停放**，否则停放时的检查点提交会把子 Agent 写了一半的文件提交进去（`worktree.go` 的 `Orbit-Park-Checkpoint`） |
| 用户停止 / 会话结束 | 先停掉所有 SubAgent（宽限 10 s），再走 `finalizeWorktree` |
| runner 重启 / 升级 | 和 `bg_run` 一样：子进程随之结束，`subagent_run` 记 `INTERRUPTED`，父会话被唤醒并收到原因 |
| 手动 Commit 按钮 | 今天在 `runningSubagents` 非空时已经拒绝（`sessions.service.ts` `commitWorktree`），沿用 |

### 5.3 权限与审批

- 权限模式：定义里 `readonly` → plan；否则与父会话相同。不会比父会话宽（沿用 `assertChildModeOrNarrow` 的规则）。
- 审批卡用父会话的 `sessionId` 发出，`toolUseId` 加 runId 前缀，并带 `subagentRunId`（与 `backgroundJobId` 同一作用：
  父会话的 tool_result 到达时不把它当作已返回的调用收走）。卡片出现在父会话的审批区，标题写明来自哪个 SubAgent。
- 子 Agent 的 AskUserQuestion / 计划审批一律拒绝，提示它把疑问写进结果里交回。Cursor 在 subagent 里也是这样。

### 5.4 并行与冲突

按 owner 的决定**不加锁**：同一 cwd 可以有多个会写文件的 SubAgent 同时跑，父 Agent 在 `prompt` 里划分文件范围。Orbit 做两件事：

- 工具描述里写明「SubAgents share your working tree; give parallel ones disjoint files」；
- 每个 SubAgent 的结果带 `changedFiles`；两个并行的 SubAgent 改了同一个文件时，后结束的那个的结果里加一句
  `Also changed by <runId>: <path>`，父 Agent 能看到并自己核对。

并发上限：每个父会话同时最多 4 个（设置可调），另受 runner 的 `maxConcurrent` 之外的一个进程上限保护，与 `bg_run` 的上限
分开计数。

## 6. 数据与改动面

### 6.1 新表 `subagent_run`

| 列 | 说明 |
|---|---|
| `id` | uuid7；公开 id 走 base62 |
| `owner_id`、`session_id` | 父会话 |
| `tool_use_id` | `delegate` 那次调用 |
| `type`、`definition_source` | `explore` / `general` / 定义文件路径 |
| `background` | bool |
| `status` | `RUNNING` / `DONE` / `FAILED` / `INTERRUPTED` / `STOPPED` |
| `decision` | Json：`level`、`tierSource`、`optimizeFor`、`engine`、`provider`、`model`、`effort`、`reasons[]`（英文）、`candidates`（被去掉的各自原因）、`policyVersion` |
| `attempts` | Json：额度失败换候选的记录 |
| `result_summary` | 交回的结果（截断） |
| `changed_files` | text[] |
| `cost_usd`、`usage` | 子进程自己的用量 |
| `created_at`、`ended_at` | |

花费：SubAgent 结束时 `cost_usd` 同时加到父会话的 `cost_usd`，所以今天读会话花费的预算和上限（`attempt-budget-meter`）
自动把它算进去。今天的 `session_create` 子会话不汇总，这里不改它。

### 6.2 服务端

- `runner-api`：`POST/PATCH /runner/sessions/:id/subagents`；`RUNTIME_SUBAGENT_TOOLS` 加入 `mcp__orbit__delegate`
  （`runner-api.controller.ts`），`runningSubagents` 的增减照旧。
- 路由：`model-routing.ts` 增加 `routeSubagent(input)`，与 `routeTaskRun` 共用档位表和引擎状态读取；档位表扩成按模型。
- 审批：`ApprovalCreateRequest` 加 `subagentRunId`；`reapApprovalsOfReturnedCalls` 跳过它。
- 设置：Agent（workspace）上加 `subagentsEnabled`、`subagentsMaxRunning`；屏蔽列表放 owner 级
  `UserPreferences.subagentBlockedProviders`；Optimize For 复用 `modelRoutingOptimizeFor`。

### 6.3 runner

- `mcp.go`：`delegate` 工具（schema + handler），启动时扫描 cwd 下的定义文件，写进工具描述。
- 新的 `subagent.go`：起子引擎进程、事件改写（`parentToolUseId`、id 前缀）、`changedFiles` 收集、停止与回报。
  复用各引擎的启动和事件解析代码，按「子模式」关掉它们的会话级副作用（不写会话 checkout、不 finalize）。
- 停放：有 SubAgent 在跑时不停放；会话结束先停 SubAgent。

### 6.4 客户端

- Web：`Transcript.tsx` 的 `isSubWorkspace` / `isBackgroundTaskCall` 认 `mcp__orbit__delegate`；`describeTool` 给它
  `SubAgent` 标签、类型 + description 摘要、右侧「档位 · 模型 · 用时 · 花费」；展开后第一行灰色 Why。
- iOS / macOS / Android：同一份事件形状，同一个块；窄屏把「档位 · 模型」放第二行。
- 定义列表暂不进 heartbeat：工具描述在 runner 本地生成，界面也不需要列出。以后要在设置里展示，再给 heartbeat 加
  `agents` 事实（记得加进 `RUNNER_ROW_FACTS`）。

## 7. 设置与界面

- **Agent 设置 → SubAgents**：开关、Optimize For（Cost / Balance / Intelligence）、Providers（默认全部，点进去屏蔽）、
  Running at once。
- **Providers 页**：每个模型多一列 Tier；preset 的档位和价格跟目录走，自定义 endpoint 显示 `Not set`，点开可以标。
- **报告**：沿用 model routing 报告页，加一个 SubAgents 视图：按档位、模型统计次数、成功率、花费、额度换候选次数、
  没给 `size` 的比例。

## 8. 分期

| 期 | 内容 | 验收 |
|---|---|---|
| P1 | `delegate` 工具（前台 + 后台 + 续跑）、内置 `explore` / `general`、读 `.claude/agents` 与 `.cursor/agents`、同 cwd 子进程、事件内嵌、`subagent_run`、花费计入父会话、生命周期（§5.2）、审批 | 一个 Claude 会话在同一 worktree 里前台、后台各派一个 SubAgent，三端都显示内嵌块；会话停止时后台 SubAgent 被停掉，文件不被提交 |
| P2 | 路由：按模型的档位表、候选池、Optimize For、额度换候选；先影子两天（只记决策，执行目标仍是父会话的引擎和模型） | 影子决策与实际对比报告 |
| P3 | 路由生效、跨 Provider / 引擎执行、Providers 页 Tier 列、SubAgents 设置页 | DeepSeek / Codex 作为 Claude 会话的 SubAgent 在同一 worktree 改文件并交回 |
| P4 | 报告视图、根据数据调内置默认档位 | — |

P1 不路由，所以可以先把最难的部分（同 cwd 子进程、事件内嵌、生命周期）单独验证。

## 9. 已定（owner，2026-11-11）

形态、写代码、定档参考 Cursor、候选为所有已启用 Provider、可并行不加锁、P1 含后台、P1 读定义文件并内置 `explore` /
`general`，这些在设计讨论中已定；下面三项在审阅效果图后拍板，均按推荐：

- **A. Cost 模式的边际花费**：有余量的订阅（Claude / Codex / Kimi 等登录账号）先用，订阅之间按额度余量排；之后才用按量
  计费的 key，key 之间按 models.dev 价格排。不把订阅折算成 API 价格。
- **B. 默认开**，Optimize For = Cost。Agent 设置里可关。
- **C. 一轮结束时还有后台 SubAgent**：会话保持 Running，SubAgent 结束时唤醒父会话，与 `bg_run` 一致；停放推迟到它们结束。

## 10. 跨 workspace 的 SubAgent（owner，2026-11-11 追加）

例：`orbit-develop`（HPC）上的会话把「在 Mac 上跑 iOS 构建和测试」交给 `orbit-macos`（Mac mini）。两台机器没有共同的
工作目录，所以跨 workspace 的 SubAgent 与同机的有三点不同。owner 已定：**只回文字，不带改动**；**点名或按能力自动选**；
**加进本项目**。

### 10.1 选哪个 workspace

| # | 条件 | 结果 |
|---|---|---|
| 1 | `delegate(workspace="orbit-macos")` | 点名的那个 |
| 2 | `delegate(needs=["os:darwin"])` 或定义文件 `needs:` | 在候选 workspace 里选：同一 owner、启用、`repoUrl` 与父会话的 workspace 相同、runner 在线且报告了全部所需能力；多个时按额度余量，再按 Agents 列表顺序 |
| 3 | 都没写 | 父会话本机（§5，同一 cwd） |

- `repoUrl` 不同（或任一为空）一律拒绝：`SUBAGENT_WORKSPACE_REPO_MISMATCH`。跨仓库的活用 `session_create`。
- runner 目前不报告操作系统；runner 任务要加上 `os:<GOOS>`（`os:darwin`、`os:linux`）。其他能力沿用 `Runner.capabilities`。
- 目标 workspace 的 Agent 必须开着 SubAgents（`subagentsEnabled`），并发上限按**目标**会话树算在父会话的上限里。

### 10.2 在哪里跑、改动去哪

- 服务端把 SubAgent 派给目标 runner；目标 runner 在该 workspace 的 workDir 上建一个**临时的、detached 的 worktree**
  （目标 workspace 自己的 HEAD），子引擎在里面跑；结束后整个删掉。workDir 不是 git 仓库时直接拒绝
  （`SUBAGENT_WORKSPACE_NOT_GIT`），不在别人的工作目录里乱写。
- **只交回文字结果**：不把任何文件带回父会话，也不留在目标 workspace。结果末尾由 runner 附一行
  `Discarded changes: <n> files (<paths…>)`，让父 Agent 知道它改过什么但没有带回。
- 看不到父会话未提交的改动：工具描述里写明「remote SubAgents run on that workspace's own HEAD and return text only」，
  父 Agent 需要它看到新代码时，自己先提交并推送（或者在 prompt 里写清楚）。

### 10.3 路由、显示、生命周期

- 路由（§4）的候选池按**目标 runner** 的引擎、登录、额度算；`decision` 记 `workspaceId` 和选中它的理由。
- 事件由目标 runner 发给服务端，服务端以父会话的 `sessionId`、`parentToolUseId` = `delegate` 调用写进父会话的事件流；
  只有被派到的那台 runner 能为这次运行写事件（按 `subagent_run` 的 `target_runner_id` 鉴权）。
- 块头多一项：`general · M · Claude Sonnet 5.5 · on orbit-macos`；Why 里写 workspace 是怎么选出来的。
- 审批卡照 §5.3 发到父会话。父会话停止 / 结束时，服务端通知目标 runner 停掉它（宽限 10 s）；目标 runner 掉线时记
  `INTERRUPTED` 并唤醒父会话。花费照样计入父会话。
- `subagent_run` 加列：`workspace_id`、`target_runner_id`。
