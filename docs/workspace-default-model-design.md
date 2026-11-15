# Workspace 默认模型：产品方案

> 状态：方向已定（owner 2026-11-13）：不改界面、不新增存储；账号级模型记忆停用，草稿的模型跟引擎同一个来源。
> 代码基线 `main` 72aeac1ec（2026-11-13）。方案图：`docs/mocks/workspace-default-model/01-board.html`。
> 起因：owner 2026-11-13 在 workspace `orbit-develop` 里新开一个会话用 GPT 问了个问题，之后同一 workspace 里的项目工作改跑 GPT。

## 0. 一页结论

**今天只有一个「默认」，它同时服务两件性质相反的事：**

| | 人开新会话时预选什么 | 没人看着的工作用什么 |
|---|---|---|
| 例子 | 输入框里的引擎 / 模型 | 任务运行、协调者、协调者裁决、MCP 子会话、@ 提及投递、任务列表控制台、飞书 |
| 该有的性质 | 顺手：记住我刚才用的 | 稳定：只在有人明确改它时才变 |
| 今天的来源 | 这个 workspace 最新一条 `task_id`、`parent_session_id` 都为空的 CONVERSATION 会话的 (engine, provider) | **同一个** |

来源是推导出来的（`workspace-provider.ts` `lastProviderByWorkspace`，迁移 0088 删掉了存储列），所以任何一条新对话——包括协调者自己——都会改掉所有无人值守工作的引擎。`docs/project-agent-contract.md` §7.2 P5 早就点名过这个耦合。

**方案：每类工作跟着「本来就由人选定的那个会话」走，不新增设置。**

| 场景 | 今天 | 改为 |
|---|---|---|
| 项目里没 pin 的任务运行 | workspace 最新一条对话 | 这个项目**当前协调者会话**的 (engine, provider) |
| 协调者补建 / 替换 / 裁决 | 轮换已跟前任（`coordinator-rotation-source`）；补建、裁决跟最新一条对话 | 这个项目**上一个协调者**的 (engine, provider)；从未有过协调者时，同下面最后一行 |
| MCP `session_create` 子会话（未给引擎） | **目标** workspace 最新一条对话 | **父会话**的 (engine, provider) |
| 人开新会话的预选、@ 提及投递、任务列表控制台、飞书、非项目任务 | 最新一条对话，协调者、wiki、飞书等开的也算 | 仍是最新一条对话，但**只算人亲手开的会话** |
| 新会话草稿的**模型** | 账号级记忆 `preferences.defaultModels['<engine>:<provider>']`，任何会话里换模型都会写 | 与引擎、凭据同一个来源：那条会话的 `model`；账号级记忆停用，不读不写 |

结果：

- 单独开一条 GPT 对话，只影响自己下一次开会话的预选；项目任务、协调者、子会话都不动。
- 要把整个项目换模型：在协调者会话里换凭据 / 模型（现有界面）；换引擎就新开一个协调者（现有「替换协调者」）。之后的任务跟着走。
- 不加界面、不加列、不做数据迁移。

## 1. 使用数据（生产库只读，2026-09-14 至 2026-11-13，60 天）

分类：任务运行 = `task_id` 非空；子会话 = `parent_session_id` 非空；协调者 = 项目的 `coordinator_session_id` 或 `run_source = PROJECT_COORDINATOR`；其余 CONVERSATION 为人开的会话。

| 指标 | 数值 | 说明 |
|---|---|---|
| 人开的会话 | 871（一个账号占 859） | 用了 7 个引擎；`orbit-develop` 一个 workspace 里出现 11 种 (engine, 凭据) 组合 |
| 人开会话里**明确换了**的比例 | 184 / 871 = 21% | 与当时种子不同，只能是草稿里手选的 |
| 种子被改的次数 | 236（人 184，**协调者 52**） | 换引擎 87，只换凭据 149 |
| 换了之后下一条会话还用新的 | 143 / 236 = 61% | 人的选择大多有延续性 |
| 换了之后下一条就换回去（一次性试用） | 58 次，中位持续约 30 分钟 | 窗口里 69 次未 pin 的任务运行、24 个协调者、27 个子会话跟着跑在了试用的组合上 |
| 换之前 6 小时内旧凭据有限额 / 报错 | 41 / 236 ≈ 17% | 限额是原因之一，不是主因 |
| 未 pin 的项目任务运行，引擎与建它的协调者不同 | 141 / 1519 = 9% | 凭据不同 364（24%） |
| agent 建的项目任务带 pin | 963 / 2177 = 44% | 最多的是 `claude:claude`（661）：agent 在用 pin 绕开种子 |
| 整段迁移 | `orbit-develop` 2026-09-28 那一周 45 条 codex 对 13 条 claude，下周回到 claude | 有意整体换引擎的情况真实存在 |

结论：人开会话的选择按会话、有延续性，草稿预选沿用「上次用的」；无人值守的工作不能跟着它走；项目工作天然有一个人选定的锚点——协调者。

## 2. 规则

### 2.1 解析链

所有入口在请求、任务 pin 都没给时：

```
请求 / 任务 pin  →  智能选模型（开启时，只填 pin 的空位）  →  锚点  →  claude（兜底）
```

锚点按场景（§0 表）取：项目任务 = 当前协调者会话；协调者 = 上一个协调者；子会话 = 父会话；其余 = workspace 里最新一条人亲手开的会话。智能选模型的基线同样改为锚点（`model-routing-design.md` §2）。

### 2.2 「人亲手开的会话」

`lastProviderByWorkspace` 的条件在今天的三列之外，再排除：协调者会话（项目的 `coordinator_session_id` 指向过的、`run_source = PROJECT_COORDINATOR`）、协调者裁决、`prompt_by_orbit = true` 的、wiki 对话、飞书会话、任务列表控制台、service-token 会话、@ 提及回复会话。实现上以创建入口写入一个来源标记为准（例如已有的 `run_source` / `source` 扩值），不靠标题。

### 2.3 锚点失效

- 协调者 / 父会话的凭据已删除或停用：与今天对种子的处理一致，拒绝并说明是哪个会话的凭据失效；不静默换引擎（`project-agent-contract.md` §7.4）。
- 项目没有协调者会话（`coordinator_session_id` 为空——从未建过或已被删除——或指向的会话已进回收站）：项目任务退回 workspace 最新一条人开会话。`coordinator_enabled` 是项目的「自动」开关，不表示有没有协调者，不参与判断。
- 子会话跨 workspace 派生，父会话的凭据在目标机器上不可用：拒绝，与今天跨 workspace 的引擎检查一致。

### 2.4 草稿的模型

- workspace payload 在 `lastEngine` / `lastProvider` 旁边增加 `lastModel`：同一条会话的 `model`（首次 claim 后才有值；为空则用 runner / key 的默认）。
- 客户端新会话草稿：模型 = `lastModel`（与预选的引擎、凭据一致时），否则 runner / key 默认。
- 客户端不再读、也不再写 `preferences.defaultModels`。服务端 DTO 继续接受旧客户端的写入（不拒绝），但不再有人读它。
- effort 不在本次范围：照旧 请求 → `workspace.effort` → `preferences.defaultEffort`。

### 2.5 显示

不新增界面元素。任务详情「Runs with」、`orbit status` 这类只读展示按 §2.1 的锚点显示，与实际开跑一致。

## 3. 分期

| 期 | 内容 |
|---|---|
| P0 服务端 | 锚点解析（项目任务、协调者、子会话）；种子只算人亲手开的会话；`lastModel`；只读展示改读锚点；规约测试：新建一条 Codex 对话后，项目任务 / 协调者 / 子会话的引擎都不变，下一次人开会话预选 Codex |
| P1 客户端 | web、iOS / macOS、Android：草稿模型改读 `lastModel`，停止读写 `defaultModels`；任务详情「Runs with」与服务端一致 |

## 4. 不做的（记录在案）

- workspace 上的显式默认、设置页「Default model」、草稿里的「也用于任务」：owner 2026-11-13 认为界面改动非必要。
- 凭据撞限额时按 `workspace.provider_fallbacks` 显式顺序换凭据：另立一期。
- 删除 `agent.default_*`、`workspace.model` 遗留列：另行清理。
