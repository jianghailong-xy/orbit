# SubAgent Workflow 设计

**状态**：设计稿（2026-11-19）；§9 的五项 owner 已于 2026-11-19 拍板。效果图：[`mocks/subagent-workflow/board.html`](./mocks/subagent-workflow/board.html)
（PNG 在同一目录），定稿前不动客户端。

> **用词**：**Workflow** 指父会话交给 Orbit 的一段编排脚本：脚本里的每次 `agent()` 是一次 SubAgent 运行
> （[`subagent-design.md`](./subagent-design.md)），控制流（循环、条件、并行、流水线）由脚本决定，不由父模型逐轮决定。
> **workflow run** 是一次脚本执行；**调用**是脚本里的一次 `agent()`。参照对象是 Claude Code 的 Workflow 工具。

## 0. 一页结论

- 新的 Orbit MCP 工具 `workflow`：父模型交一段 JavaScript 脚本，runner 在父会话的进程树里执行它，脚本里的
  `agent()` / `parallel()` / `pipeline()` / `phase()` / `log()` 与 Claude Code Workflow 同名同义，模型不用学新接口。
- **每次 `agent()` 就是一次 `delegate`**：路由、额度换候选、跨引擎、跨 workspace、审批、花费计入父会话，全部沿用
  SubAgent 现成的路径。Workflow 只加三样 SubAgent 没有的东西：**确定的控制流**、**按 schema 校验的返回值**、**可重放的日志**。
- 总是后台：调用立即返回 `workflowRunId`，结束时用 SubAgent 的唤醒路径（`subagent-wake.ts`）给父会话起一轮，带脚本的返回值。
- 日志在服务端：`subagent_run` 加 `workflow_run_id`、`call_index`、`call_key`、`output`。runner 重启、父引擎换进程都不丢；
  `resumeFrom` 按调用顺序重放没变的前缀。
- 花费上限可选、默认没有：父模型给了 `maxCostUsd` 才设上限，超了 `agent()` 抛错，脚本照常收尾。
- 并发与 SubAgent 共用一个上限 `subagentsMaxRunning`，默认从 4 改成 8。
- 与 Task DAG 不重叠：Workflow 是一轮之内、同一 worktree、几分钟到几小时的扇出；跨天、要完成标准和落地的仍然是
  Task + 依赖（`tasklist_propose_dag`）。

## 1. 为什么现有的 `delegate` 不够

今天父模型已经能「后台派 N 个 SubAgent，结束一轮，被逐个唤醒再派下一批」。这条路能用，但有四个问题：

| | 后台 `delegate` + 唤醒 | Workflow |
|---|---|---|
| 控制流 | 父模型每次被唤醒时重新决定；同样的输入两次跑出不同的扇出 | 脚本决定，可复现 |
| 父会话花费 | 每个 SubAgent 结束都起一轮父模型，上下文越滚越长 | 整个 workflow 结束只起一轮 |
| 返回值 | 自由文本，父模型自己解析 | `schema` 校验过的对象，脚本直接用 |
| 中断后 | 父模型凭记忆重派，常常重复或漏掉 | 按日志重放，已完成的调用不再花钱 |

另外两条限制在 Workflow 里也要处理：同机 SubAgent 共用 cwd、不加锁（`subagent-design.md` §5.4），并行写文件只能靠 prompt
划分；每个父会话今天最多同时 4 个（`subagentsMaxRunning`，本设计改成默认 8，见 §3.2）。

## 2. 调用接口

```
workflow({
  description: string,            // 3–8 个词，块头显示
  script?: string,                // 脚本正文；与 scriptPath 二选一
  scriptPath?: string,            // cwd 内的脚本文件，例如 .orbit/workflows/review.js
  args?: any,                     // 脚本里的全局 args，原样传入
  maxCostUsd?: number,            // 可选，默认没有上限，见 §4.4
  resumeFrom?: string             // 之前某个 workflowRunId，见 §4.3
})
→ { workflowRunId, status: "running" }
结束时父会话收到 <orbit-workflow-finished>：{ workflowRunId, status, result, costUsd, calls: { done, failed, cached }, changedFiles }
```

脚本开头必须是 `export const meta = { name, description, phases? }`，纯字面量（与 Claude 相同，便于在不执行脚本时读出名字和阶段）。

### 2.1 脚本里能用的

| 名字 | 含义 | 与 Claude 的差别 |
|---|---|---|
| `agent(prompt, opts?)` | 起一次 SubAgent。`opts`：`label`、`phase`、`schema`、`type`、`size`、`model`、`workspace`、`needs`、`isolation` | Claude 的 `model` / `effort` / `agentType` 对应 Orbit 的 `model` / `size` / `type`；`workspace` / `needs` 是 Orbit 独有 |
| `parallel(thunks)` | 并发执行，全部结束才返回；失败的项为 `null`，本身不抛错 | 同 |
| `pipeline(items, ...stages)` | 每项独立走完所有阶段，阶段之间无屏障 | 同 |
| `phase(title)` / `log(msg)` | 进度分组 / 旁白 | 同 |
| `args` | 调用时的 `args` | 同 |
| `budget` | `{ maxCostUsd, spentUsd(), remainingUsd() }`；没给上限时 `maxCostUsd` 为 `null`、`remainingUsd()` 为 `Infinity` | Claude 按 token 计，Orbit 按美元计，因为不同引擎的 token 不可比 |

`agent()` 没有 `schema` 时返回结果文本；有 `schema` 时返回校验过的对象。运行失败（活本身失败、换候选用完、被停止）返回 `null`。

不提供：`Date.now()`、`Math.random()`、无参 `new Date()`（会破坏重放，调用即抛错）；文件系统、网络、子进程；嵌套 `workflow()`（P1 不做）。

### 2.2 示例

```js
export const meta = { name: 'review-changes', description: 'Review the diff by dimension, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }] }
const FINDINGS = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object',
  properties: { file: { type: 'string' }, line: { type: 'integer' }, claim: { type: 'string' } },
  required: ['file', 'claim'] } } }, required: ['findings'] }
const VERDICT = { type: 'object', properties: { real: { type: 'boolean' }, why: { type: 'string' } }, required: ['real'] }

const results = await pipeline(args.dimensions,
  d => agent(`Review the current diff for ${d}. Report findings only.`,
             { type: 'explore', size: 'M', phase: 'Review', label: `review:${d}`, schema: FINDINGS }),
  r => parallel(r.findings.map(f => () =>
         agent(`Try to refute: ${f.claim} (${f.file}:${f.line}).`,
               { type: 'explore', size: 'S', phase: 'Verify', schema: VERDICT }).then(v => ({ ...f, verdict: v })))))
return results.flat().filter(Boolean).filter(f => f.verdict?.real)
```

## 3. 执行

### 3.1 在哪里跑

脚本在**父会话的 runner** 上执行，嵌入 Go 的 JavaScript 解释器（推荐 goja：纯 Go、无 cgo、可中断、可去掉全局对象；
§9 D1）。理由：

- 同机 `agent()` 本来就在父会话的 cwd 里起子进程（`subagent.go`），脚本放在同一处，不用再走一趟网络。
- 生命周期直接套用后台 SubAgent 的规则（`subagent-design.md` §5.2）：一轮结束时 workflow 在跑 → 会话保持 Running；
  停放推迟到它结束；用户停止 → 先停 workflow 和它的全部 SubAgent。
- 跨 workspace 的 `agent({ workspace })` 走现成的远程路径（§10），脚本不用在意。

服务端执行（脚本放 apiserver 跑）的好处是 runner 掉线不中断，但同机 SubAgent 仍然要回到 runner 起进程，多一跳，
而服务端日志已经让中断可以重放（§4.3），所以不选。

### 3.2 时序

1. 父模型调用 `mcp__orbit__workflow`。runner 的 `orbit mcp` 读出脚本、解析 `meta`（不执行），转给 runner。
2. runner `POST /runner/sessions/:id/workflows`：服务端检查开关、父会话权限模式，写 `subagent_workflow_run`
  （`RUNNING`），返回 `workflowRunId`。`resumeFrom` 时同时返回旧运行的调用日志（§4.3）。
3. runner 在解释器里执行脚本。每次 `agent()`：
   - 算 `call_key`（§4.3），命中重放就直接返回日志里的 `output`；
   - 否则按 `delegate` 的同一路径 `POST /runner/sessions/:id/subagents`，多带 `workflowRunId`、`callIndex`、`callKey`、
     `schema`、`label`、`phase`，之后路由、起子进程、事件改写、审批、换候选都不变；
   - 并发与 SubAgent 共用一个上限（§9 D3）：父会话同时在跑的 SubAgent（`delegate` 起的和 workflow 起的合计）不超过
     `subagentsMaxRunning`，默认从 4 改成 8（`workspaces.service.ts` 的默认值、`runner-subagents.controller.ts` 的兜底值、
     已有 Agent 行里仍是 4 的一并迁移）。workflow 的调用由 runner 排队，排队的在块里显示 `Queued`；服务端满额时回
     `SUBAGENT_LIMIT`，runner 把它当作排队而不是失败。
4. 每个调用结束，runner `PATCH` 它的 `subagent_run`（带 `output`），服务端累计 workflow 的花费。
5. 脚本返回或抛错：`PATCH /runner/sessions/:id/workflows/:wfId`（状态、返回值、花费），服务端置 `wake_owed`，
   由 `subagent-wake.ts` 的同一条 sweep 给父会话起一轮。

### 3.3 事件与显示

- `workflow` 那次调用是一个块；它的每个 `agent()` 是块里的一个 SubAgent 子块，`parentToolUseId` = `workflow` 调用的 id，
  子块再嵌它自己的事件（比今天的 SubAgent 多一层，各端的嵌套渲染要支持到三层）。
- 子块按 `phase` 分组，组头写 `done / running / queued` 计数；`log()` 是块里的一行灰字。
- 块头：`Workflow · review-changes · 7/12 · $0.84 of $5.00`，结束后加用时。界面先出效果图。

## 4. 新增的三样东西

### 4.1 结构化返回值

有 `schema` 的调用，子 Agent 的 `orbit mcp` 多给一个工具 `return_result`，它的 `inputSchema` 就是这次的 `schema`。
子进程本来就跑 `orbit mcp`（带 `envSubagentRunID`，今天用它去掉 `delegate`），所以**所有引擎同一条路**，不依赖
Claude 的 `--json-schema` 或 Codex 的 `--output-schema`。

- 固定前言加一句：结束前必须调用 `return_result`，它的参数就是你的结果。
- `orbit mcp` 收到后按 schema 校验（JSON Schema draft 2020-12 的子集：type、properties、required、items、enum）；不通过时
  回一条错误文本，子 Agent 在同一轮里重试。
- 子 Agent 一轮结束仍没有成功的 `return_result`：runner 用同一个对话续一次（`resume` 的路径），提示只交结果；还没有就记
  `FAILED`（`SUBAGENT_RESULT_MISSING`），`agent()` 返回 `null`。
- 校验过的对象存 `subagent_run.output`；`result_summary` 照旧存文本，供界面显示。
- 脚本里的 schema 在 `agent()` 被调用时先检查一遍（根必须是 object、`required` ⊆ `properties`），不合格直接抛错，不花钱。

### 4.2 写文件的并行：`isolation: 'worktree'`

同机并行写文件今天只能靠 prompt 划分。`isolation: 'worktree'` 的调用：

1. runner 用 `git stash create` 给父会话的当前工作区（含未提交改动）做一个快照提交，不动父会话的 stash 栈和工作区；
2. 在 `runs/<session>/workflows/<wfId>/<callIndex>/` 建 detached worktree 指向快照，子 Agent 在里面跑；
3. 结束时把子 worktree 相对快照的改动做成补丁，存进 `subagent_run`（大小有上限，超了只存文件列表并记明），然后删掉 worktree；
4. `agent()` 的返回值多一个字段 `patch`（有 schema 时放在 `__orbit.patch`，不混进对象）。

**补丁不自动应用**：由脚本或父模型决定（§9 D5）。脚本里提供 `applyPatch(patch)`：在父会话 cwd 里 `git apply --3way`，
冲突时返回冲突文件列表而不是抛错。这是脚本唯一能动父会话工作区的入口，因此它也进日志、可重放。

不隔离的调用照旧直接改父会话的 cwd，`changedFiles` 和 `Also changed by` 提示不变。

### 4.3 日志与重放

`call_key` = SHA-256(`callIndex` ‖ prompt ‖ 规范化的 opts)。`callIndex` 按脚本发起 `agent()` 的顺序编号；`parallel` /
`pipeline` 里的调用按**发起顺序**编号，而发起顺序只取决于脚本和已返回的值，所以脚本和 `args` 不变时编号稳定。

`resumeFrom = 旧 workflowRunId`：

- 服务端交回旧运行的调用日志（`callIndex` → `callKey`、`status`、`output`、`patch`）；
- runner 执行新脚本，逐个调用比对：`callKey` 相同且旧状态 `DONE` → 直接返回旧 `output`，记一条 `cached` 的 `subagent_run`
  （花费 0，指向旧行）；
- **第一个不匹配、失败或没跑完的调用及其之后的所有调用**都真跑。和 Claude 的位置缓存同一口径：简单、可预测，
  不做按内容寻址的跨位置复用。
- 旧运行必须属于同一父会话、已结束（`DONE` / `FAILED` / `INTERRUPTED` / `STOPPED`）。

runner 重启时在跑的 workflow 记 `INTERRUPTED` 并唤醒父会话，唤醒文本提示可以 `resumeFrom` 续上。

### 4.4 花费上限

- 默认**没有上限**（§9 D4）。父模型可以给 `maxCostUsd`；不给时 workflow 只在花费显示上可见，不会因花费停下。
- 给了上限时：已花费 = 结束的调用的 `cost_usd`（P1；在跑调用的实时花费以后再计入，所以并行时可能略超上限）。
  达到上限后在跑的调用让它们跑完（不硬杀，避免写一半的文件），之后的 `agent()` 抛 `WorkflowBudgetSpent`；脚本可以
  `try/catch` 后交回已有结果。
- 失控循环的兜底不按花费：一次 workflow 最多 1000 次 `agent()`（与 Claude 相同），超了抛 `WorkflowCallLimit`。
- 订阅账号的花费按 SubAgent 现有的折算记（`subagent-design.md` §9 A 只影响排序，不影响记账）。

## 5. 数据

### 5.1 新表 `subagent_workflow_run`

| 列 | 说明 |
|---|---|
| `id` | uuid7；公开 id 走 base62 |
| `owner_id`、`session_id` | 父会话 |
| `tool_use_id` | `workflow` 那次调用 |
| `name`、`description`、`phases` | 来自 `meta` |
| `script`、`script_sha256`、`args` | 脚本正文（上限 512 KB）与参数 |
| `resume_of` | 重放的旧运行 |
| `status` | `RUNNING` / `DONE` / `FAILED` / `INTERRUPTED` / `STOPPED` |
| `result`、`error` | 脚本返回值（截断）/ 抛出的错误 |
| `max_cost_usd`、`cost_usd` | 上限（可空）与累计 |
| `wake_owed`、`wake_filed_at` | 同 `subagent_run` |
| `created_at`、`ended_at` | |

### 5.2 `subagent_run` 加列

`workflow_run_id`（可空，外键）、`call_index`、`call_key`、`label`、`phase`、`schema`（Json）、`output`（Json）、`patch`（text）、
`cached_from`（重放命中时指向旧行）。唯一索引 `(workflow_run_id, call_index)`。

`workflow` 里的调用没有自己的 `delegate` tool_use id；`tool_use_id` 写 `<workflow 调用 id>#<callIndex>`，现有的
`@@unique([sessionId, toolUseId])` 不变。

花费：调用结束时照旧计入父会话的 `cost_usd`（`attempt-budget-meter` 自动算进去），同时累加到 workflow 行。

## 6. 改动面

- **runner**：`mcp.go` 加 `workflow` 工具；新 `subagent_workflow.go`：解释器沙箱、`agent()` 到 SubAgent 的桥、并发队列、
  重放比对、补丁与 `applyPatch`；子 Agent 的 `orbit mcp` 按 schema 提供 `return_result`；停放与停止规则把 workflow 算进去。
  注意 `runner-go/mcp.go` 的工具描述被 JS 侧的 spec 读取，改它要跑全量 CI。
- **服务端**：`runner-api` 加 `POST/PATCH /runner/sessions/:id/workflows`；`runner-subagents.controller.ts` 接受 workflow 字段；
  `subagent-wake.ts` 认 workflow 行；`RUNTIME_SUBAGENT_TOOLS` 加 `mcp__orbit__workflow`。
- **客户端**（web / iOS / macOS / Android）：三层嵌套、阶段分组、块头进度与花费。先出效果图。
- **Agent 设置 → SubAgents**：加 `Workflows` 开关；`Running at once` 不变，现在同时管 workflow 的调用，默认 8。

## 7. 与 Task DAG 的分界

| | Workflow | Task + 依赖 |
|---|---|---|
| 时长 | 一轮之内，分钟到小时 | 跨天 |
| 工作区 | 父会话的 worktree（或临时隔离 worktree） | 每个任务自己的 worktree 与分支 |
| 完成 | 脚本返回 | 完成标准、证据、落地 |
| 谁决定下一步 | 脚本 | 依赖图 + 协调者 |

工具描述里写明：要留记录、要验收、要落地的，用 Task；只要结果回来的扇出，用 Workflow。

## 8. 分期

| 期 | 内容 | 验收 |
|---|---|---|
| P1 | `workflow` 工具、goja 沙箱、`agent` / `parallel` / `pipeline` / `phase` / `log`、走 SubAgent 路径、后台 + 唤醒、可选的 `maxCostUsd`、`subagentsMaxRunning` 默认改 8、停止与停放 | 一个 Claude 会话跑 §2.2 的脚本，12 个调用、跨两种引擎，结束只唤醒父会话一次；会话停止时全部调用被停掉 |
| P2 | `schema` + `return_result`（各引擎）、服务端日志、`resumeFrom` 重放 | 同一脚本中途重启 runner 后 `resumeFrom`，已完成的调用全部 cached、花费 0 |
| P3 | `isolation: 'worktree'`、补丁、`applyPatch` | 4 个并行调用改同一文件的不同函数，补丁依次应用无冲突；有冲突时返回冲突列表 |
| P4 | 三端界面（效果图定稿后）、SubAgents 报告里的 Workflow 视图（设置 → Routing report，效果图 `08-report.html`，见 `subagent-design.md` §7） | — |

P1 不带 schema 也能用（返回文本），先验证编排和生命周期这一最难的部分。

## 9. 已定（owner，2026-11-19）

- **D1 脚本形态**：JavaScript，接口与 Claude Workflow 相同（goja）。不做声明式 JSON DAG。
- **D2 谁能发起**：任何开了 SubAgents（和 Workflows）的会话，不发确认卡，与 `delegate` 一致。
- **D3 并发**：workflow 与 SubAgent **共用一个上限** `subagentsMaxRunning`，默认从 4 改成 8。
- **D4 花费上限**：**没有默认值**。`maxCostUsd` 可选，给了才生效；Agent 设置里不加花费上限。
- **D5 隔离调用的补丁**：只交回，由脚本的 `applyPatch` 或父模型决定是否应用，不自动应用。
