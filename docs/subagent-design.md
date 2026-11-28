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
| `readonly` | `true` → 不给编辑工具；各引擎都沿用父会话的权限模式，只读靠引擎自己的只读设置（§5.3） | — |
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
   区域不可用只去掉 `claude` 引擎上对 Anthropic 的凭据（`credentialIsAnthropicBound`：Claude 自己的登录、Claude 号池、
   `anthropic` preset 或 anthropic.com 的 key），理由 `claude can’t use Anthropic on <runner>`；DeepSeek 等 key 和别的引擎照常
   （docs/claude-region-check-contract.md §8）。远程 delegate 和 `provider_list --workspace` 走同一个判断；
4. 额度 ≥ 90%（`ENGINE_QUOTA_LIMIT`）、账号暂停中、或 endpoint 拒了它的 key 的。

只有「跑不起来」才去掉。**凡是在 Orbit 注册了的都参与路由，只是先后不同**（owner，2026-11-19）：

- **所有档位都进池**，不只是要的那一档。没有档位的不再去掉：一个 Provider × 引擎**一个档位都没有**时（目录里没有一个已知
  家族模型、owner 也没标档位的内置引擎，例如只报 `grok-4.7` 之类的 Cursor；没标档位的自定义 endpoint），它的**默认模型**以「无档位」进池——runner 报的该引擎默认模型，
  否则 Provider 自己的默认模型，否则列表第一个；列表里其余的模型记为去掉（`The model has no tier; <provider> runs <model>`），
  点名照样能用。已有档位的 Provider 里个别没档位的模型仍记为去掉。
- **额度读不到**的订阅（runner 没报这个账号、或报了但没有窗口）不去掉，也不当作 100% 余量：排在额度已知的之后。

**档位表**从「每个引擎一张」扩成「每个模型一行」：`(provider, model, effort) → 档位`。preset 的模型由目录提供档位和价格
（价格取自 models.dev，preset 列表本来就从那里刷新，`providerPresets.ts`）；Claude / Codex 内置登录沿用今天
`DEFAULT_MODEL_TIER_TABLE` 的映射，Kimi 内置登录也在这张表里（S/M 用 K3，L/XL 用 K3.1 Pro，没有就 K3；只给 SubAgent 用）。
其余内置引擎（Cursor、Antigravity、OpenCode、DSH）的目录按**模型家族**定档（`MODEL_FAMILY_TIERS`：Claude Sonnet S/M、
Claude Opus L/XL、Gemini Flash S/M、Gemini L/XL、Composer S、Claude Haiku S、Kimi K3 S/M、Kimi K3.1 Pro L/XL（无 K3.1 Pro 时 K3 顶替 L/XL；`kimi-k2.*` 不定档）），每档取该家族版本最新的模型，effort 夹到模型自己报的等级
（`clampEffort`）；不属于任何已知家族的模型（Cursor 的 `grok-4.7`、`kimi-k2.*`，Antigravity 的 `gpt-oss-120b` 等）没有档位。

**owner 给内置引擎的模型定档**（owner，2026-11-20：表总会漏，漏了应该点一下就能补，而不是等发版）：任何内置引擎目录里的
任何模型，owner 都可以在 Providers 页的 Tier 列设一个档位或清除，存在账号偏好 `builtinModelTiers`（引擎 → 模型 → 档位），
只经 `PATCH /providers/builtin/:engine/model-tier` 写（`tier: null` 清除）。设了档位的模型在该引擎上**只**占 owner 定的那一档，
取代内置表和家族给它的档位；effort 是该档要的（S low、M medium、L high、XL max）夹到模型报的等级。清除后回到内置表 / 家族的档位，
没有就回到无档位。只对 runner 报了的模型生效；用同一引擎目录的 key（例如 Claude Code 上的 Anthropic key）也读这份档位。
owner 什么都没设时 Claude / Codex / Kimi 的行与以前逐字节相同；任务 run 的路由（`routeTaskRun`）不读它。

**先按贴合度**：要的那一档 → 更高的档（近的先）→ 无档位的默认模型 → 更低的档（近的先）。选中的不在要的档时，理由里写明
（`Nothing in tier M can run: …`）。贴合度在每种模式下都是最外层的键。

**同一贴合度内分两步：先选模型，再选账号**（owner，2026-11-22，策略版本 `p7-model-then-account-1`）。之前所有
「凭据 × 引擎 × 模型」一起按额度排，结果是哪个账号的额度先过期就由它决定模型（S 档跑成了 Kimi K3 69 次、Sonnet 9 次），
同一个模型在两个凭据上也被拆成两行报告。现在：

1. **选模型**：同一贴合度里按模型 id 合并（`gpt-6.2-sol` 在 Codex 内置登录和 Codex Pool 上是同一个模型），按模型偏好排：
   owner 在 Providers 页排的顺序（取这个模型最靠前的那个 Provider × 引擎）→ 档位来源（owner 自己定的档 > 规则：模型家族、实测、
   preset 目录 > 引擎内置表）→ 表里同一档内原有的顺序。质量分（任务 351Ah51IZjAikVJUEduNc）以后会进这一步，现在路由不读它。
   Intelligence 在这之前先按「档位上限高的模型先」（例如 L 档里 Opus 先于只到 L 的模型）。
2. **选账号**：能跑这个模型的所有凭据（引擎自己的登录、号池、key）里，订阅先于计费 key；订阅里额度已知的先，再**先过期的先**，
   再余量多的先；key 里便宜的先；最后按 owner 的顺序。

严格程度跟 Optimize For（Settings › General，`optimizeForOf`）走：

| Optimize For | 规则 |
|---|---|
| Cost | 不分两步，和以前一样：所有候选一起排——订阅先于计费 key，订阅里额度已知的先、再先过期的先、再余量多的先；key 里便宜的先 |
| Balance（默认） | 先模型后账号，两个例外，同档的另一个模型可以接手：① 首选模型**没有一个订阅还有余量**（都 `quotaNearLimit`，或只有计费 key）时，按偏好的下一个有余量的模型；② 另一个模型的**周 / 月额度 24 小时内重置**（快要作废）、而首选模型没有这样的账号时，重置最早的那个模型。① ② 同时成立时 ② 优先 |
| Intelligence | 严格先模型后账号：只有首选模型**没有一个账号能跑**（移除、未登录、到额度上限、被拒）时才换下一个模型；快用完、别的额度要作废都不换 |

**「快要作废」的窗口取 24 小时**（`SUBAGENT_WASTE_WINDOW_MS`）：一天够当天的 run 把剩下的额度用掉，又短到首选模型仍拿着
周窗口七天里的六天。只算窗口本身长于一天的（周、月）：5 小时窗口总在几小时内重置，每几个小时就还回来，不算作废；窗口长度未知的也不算。
路由时刻由调用方传入（`SubagentRoutingInput.now`），没有时不触发这条。只有一个计费 key 的模型在 Balance 里算「没有余量」：
免费额度先于花钱（owner，2026-11-19）。

**理由**里写明哪一步定的：`Picked gpt-6.2-sol · low on codex-pool (Balance): model gpt-6.2-sol, preferred in tier S;
account codex-pool: its quota resets first, a subscription pool whose account … has 70% of its quota left until …`；
接手时写 `takes over tier S from the preferred claude-sonnet-5-5, which has every account near its limit` 或
`…: its quota on kimi resets at …, within a day, and would otherwise go to waste`。Cost 的理由和以前逐字相同。

**候选（fallbacks）按同一个顺序**：选中模型的所有账号 → 同档下一个模型的账号 → 下一个贴合度。额度 / 容量失败后换的就是这个顺序（§4.3）。

**任务 run 不变**（`routeTaskRun` 借用这个路由器选候选）：它传 `rankTogether`，在每种模式下都照旧把所有候选一起排
（Balance 等同 Cost，Intelligence 是上限高的先、再额度、再价格）。原因：默认的 Balance 下两步会改变 Agent 自己的引擎接不了时
任务 run 拿到的模型，这次没有要这个改变。由 `model-routing-two-step.spec.ts` 钉住。

**先过期的先**（owner，2026-11-19）：和 runner 上选账号同一条规则（`planUsage.ts` `rankAccounts`）——快用完的
（`quotaNearLimit`：5 小时窗口 ≥ 80%，更长的 ≥ 90%）排最后，其余按额度作废的时刻（`quotaExpiresAt`：最长那个窗口的重置，
有周窗口就是周窗口）早的先。号池选它的成员也按这条。Kimi 的月窗口算在内。

最后按 owner 在 Providers 页排的顺序打破平局。结果和理由冻结在 `subagent_run` 里，续跑不重算。

**点名的模型**（调用或定义文件里写的）：列出它、且在这台 runner 上跑得起来（上面 1–4 条）的 Provider × 引擎，按 owner 的顺序，
第一个是选中的，其余是它的候选；跑不起来的都记为去掉。有人列出但都跑不起来：调用被拒（`No usable provider on … offers …`），
定义文件里写的则按 auto 路由。没人列出：照旧在父会话的 Provider 上按名字跑。

**续跑**（`resume`）：在它上次跑的引擎、Provider、模型和 effort 上接着跑，不再路由——对话是那个引擎的，换引擎只会拿到模型却没有对话。
那个目标现在起不来就拒绝（`SUBAGENT_RESUME_CANNOT_START`），不换到别处；runner 把 `resumeOf` 带上，服务端据此识别本机续跑。

**Opus 的周窗口**：Claude 账号的 Opus 周额度 ≥ 90% 时，该账号上的 Opus 行去掉（`Opus's weekly quota is at …`），Sonnet 照常；
模型家族的窗口不算进账号的「快用完」和过期时刻。runner 自己的登录报「未登录」只去掉那个登录，订阅 token 的 key 用自己的 token，不受影响。

### 4.3 失败

- **额度 / 容量失败**（`USAGE_LIMIT_ERROR_MARKERS`、`MODEL_AT_CAPACITY_ERROR_MARKER`）：同档下一个候选重开，
  Why 追加 `Moved to <model> after <model>'s account hit its limit`（容量：`… was at capacity`）。同一次 `delegate` 最多换 2 次。
  runner 问 `POST /runner/sessions/:id/subagents/:runId/fallback`（带子进程的原话）；服务端从开跑时存下的决策里取
  候选（选中的那个 + `decision.fallbacks`，同档按排序剩下的），跳过已经撞过限额的 Provider，所以影子模式下同样生效。
  每次尝试记进 `subagent_run.attempts`（引擎、Provider、模型、结果、原话）。自己的账号池（Claude 或 Codex）可以是选中项，
  也可以是换去的目标：SubAgent 自己选池成员（`subagentPoolMember`；Claude 池规则同 claim 的 `choosePoolMember`，
  Codex 池同 claim 的 `choosePoolCredential`：先选能跑的 ChatGPT 账号，没有再用池里的 API key），记在那次尝试的 `poolMember` 上
  （`{providerId}` / `{accountId}` / `{keyId}` 加 `label`），不写父会话的 `poolMemberProviderId` / `poolCodexAccountId` / `poolKeyId`。
  Codex 池的子进程拿一张只给它铸的网关 token（`mintSubagentPoolLoginToken`，迁移 0800：`pool_login_token.account_id` / `key_id`），
  网关按 token 上的账号或 key 发请求，而不是父会话行上的；这种 token 只在 codex 网关有效，网关也不给父会话记换号提示。
  别人的池（包括别人共享、没把本人加进去的池）不是候选，按名字点它也会被拒。
  换第 3 次时回 `SUBAGENT_FALLBACK_SPENT`，不是额度 / 容量 / 登录失败回 `SUBAGENT_NOT_A_LIMIT_FAILURE`。
- **登录失败**（2026-11-16 追加；`isAuthErrorText` 的 `Failed to authenticate`，例如 `OAuth session expired and could not be
  refreshed`，以及开头是 `Not logged in` / `OAuth session expired` 的原话；Cloudflare 拦截、断连不算）：和额度失败同一条路，
  同档下一个候选、最多换 2 次、每次记进 `attempts`（结果 `AUTH_FAILED`），Why 追加 `Moved to <model> after <model>'s login failed`。
  runner 在 `subagentLimitFailure` 里同样认这些原话（`isSubagentLoginFailure`，和服务端的 `isLoginFailureText` 保持一致）。
  **调用方点名了模型**（`decision.tierSource = named-model`）时不换：回 `SUBAGENT_NAMED_MODEL_NOT_MOVED`，失败原样交回父 Agent。
- **开跑时选中项起不来**（例如账号池里没有能跑的账号、凭证缺失）：按排序取同档下一个，被跳过的记进 `candidates` 并带原因，
  Why 里计入被去掉的数目。
- **活本身失败**：不升档、不重跑，交回父 Agent，结果里写明。父 Agent 决定加档再派，还是自己做。
- 池子是空的：`delegate` 立刻返回错误 `NO_SUBAGENT_PROVIDER`，并列出每个 Provider 被去掉的原因；不会退回父会话的模型。

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

- 权限模式（owner 2026-11-23：任何模型、任何 coding agent 都透传父会话的权限模式，优先 Auto）：子 Agent 的模式**一律是父会话的模式**，
  只读与否、哪个引擎都一样（`subagentChildMode`）；定义里写了模式且不比父会话宽（`isWiderThanParent`）时用它，只读的不用。
  引擎守不住这个模式时取它守得住、又不更宽的最近一个，不拒绝：DSH 的 Plan → Don't Ask、Accept Edits → Default、Bypass → Auto；
  Cursor 的 Default → Plan。
  只读靠各引擎自己的只读设置，子 Agent 请求的批准按父会话**当时**的模式回答（`readonlySubagentAnswer`）：父会话 Auto / Bypass → 直接放行、
  不出卡；Don't Ask → 直接拒绝；其他模式 → 照常出卡。编辑工具（Edit / MultiEdit / Write / NotebookEdit，各引擎的拼写）的请求一律拒绝
  （`readonlySubagentRefusesEdit`）。各引擎：
  - Claude：父会话的模式，去掉编辑工具（plan 下每次 Bash 都要问人，父会话开 Auto 时只读子 Agent 反而最打扰人）。
  - Codex：只能用 shell 读仓库，而它的 plan 拒绝一切命令，所以用 Codex 自己的 `read-only` 沙箱（无写、无网络）加 `never`：
    命令不问人，在沙箱里跑，写入由沙箱拒绝（`codexReadonlySubagentMode`）。会话本身的 plan 含义不变。
  - Kimi：plan（关掉编辑），它请求的批准按上面的规则回答。
  - Cursor：plan（关掉编辑）；plan 本来拒绝一切请求，只读子 Agent 的请求改按上面的规则回答，父会话问人时出卡。
  - DSH：没有 plan，用它的只读文件策略（Default）；越出沙箱的请求按上面的规则回答，写文件的一律拒绝。
  - OpenCode：运行中不能回答任何请求（它的 ask 一律被拒），所以启动时按父会话的模式定一次：Auto / Bypass → 那个模式，
    拒绝编辑和它自己的 subagent（`openCodeReadonlyFollowsParent`）；其他 → plan。
  - Antigravity：agy 的 plan 自己拒绝一切命令，所以改走 Orbit 的审批 hook（同 Default）：写文件拒绝（agy 自己的 artifact 除外），
    其余按启动时父会话的模式回答（`agyApprovalPolicy.ReadonlyParentMode`）。
  - 远程运行：领取里带父会话的模式（`RemoteSubagentClaim.parentPermissionMode`），目标 runner 按它回答，Plan 门也读它；
    旧服务端不带时退回子 Agent 自己的模式。
  runner 不检查命令本身（owner 2026-11-20）：父会话 Auto / Bypass 时，Claude 和 Codex 以外的只读子 Agent 的「只读」只靠关掉编辑工具和指令约束，
  写文件的 shell 命令也会被执行。
  写的子 Agent 继承父会话的 Auto 时，在 Kimi、OpenCode、Antigravity 上等同 Bypass（`runsAsBypass`）；按透传的规则这是预期的，
  `isWiderThanParent` 只约束定义里点名的模式。
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
| `rating_score`、`rating_note`、`rated_at` | 父会话对结果的评分 1–5 与一句理由（`subagent_rate`，§7.1，migration 1429）；再评一次即替换 |
| `rater_engine`、`rater_provider`、`rater_model` | 评分时父会话自己的引擎、provider 和模型 |

花费：SubAgent 结束时 `cost_usd` 同时加到父会话的 `cost_usd`，所以今天读会话花费的预算和上限（`attempt-budget-meter`）
自动把它算进去。今天的 `session_create` 子会话不汇总，这里不改它。

### 6.2 服务端

- `runner-api`：`POST/PATCH /runner/sessions/:id/subagents`；`RUNTIME_SUBAGENT_TOOLS` 加入 `mcp__orbit__delegate`
  （`runner-api.controller.ts`），`runningSubagents` 的增减照旧。
- 路由：`model-routing.ts` 增加 `routeSubagent(input)`，与 `routeTaskRun` 共用档位表和引擎状态读取；档位表扩成按模型。
- 审批：`ApprovalCreateRequest` 加 `subagentRunId`；`reapApprovalsOfReturnedCalls` 跳过它。
- 设置：Agent（workspace）上加 `subagentsEnabled`、`subagentsMaxRunning`；屏蔽列表放 owner 级
  `UserPreferences.subagentBlockedProviders`；Optimize For 是账号级的 `UserPreferences.optimizeFor`（没设过 = Balance，owner，2026-11-19；
  原先复用 Agent 的 `modelRoutingOptimizeFor`，已不再读）。

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

- **设置 → General → New sessions**（2026-11-22 起在 Providers → Model routing）：Optimize For（Cost / Balance / Intelligence），账号级，紧跟 Smart model selection
  （owner，2026-11-19，board `docs/mocks/routing-mode-account`）。
- **Agent 设置 → SubAgents**：开关、Providers（默认全部，点进去屏蔽）、
  Running at once。
- **Providers 页**：每个模型多一列 Tier；preset 的档位和价格跟目录走，自定义 endpoint 显示 `Not set`，点开可以标。
  内置引擎（Claude Code、Codex、Cursor、Antigravity……）列出 runner 目录里的**每个**模型：内置表或家族给了档位的显示该档位，
  其余显示 `Not set`；每一行都可以点开设档位（覆盖目录的档位）或清除（`builtinModelTiers`，§4.2）。
- **报告**：沿用 model routing 报告页，加一个 SubAgents 视图：按档位、模型统计次数、成功率、花费、额度换候选次数、
  没给 `size` 的比例。
  已做（2026-11-20，owner 批准的效果图 [`mocks/subagent-workflow/08-report.html`](./mocks/subagent-workflow/08-report.html)）：
  model routing 报告原本只有接口、没有页面，于是新开 **设置 → Routing report**（`/settings/routing-report`），两个视图
  SubAgents 与 Workflows（`subagent-workflow-design.md` §8 P4），接口 `GET /tasks/model-routing/report/subagents?since=&agentId=`。
  一次运行算在 Orbit **选的**档位和模型下（同任务报告「算在首次决策」的口径），换了候选记一次 Moved on；`agentId` 是父会话的
  Agent；workflow 的调用就是 SubAgent 运行，两个视图数同一批 `subagent_run` 行，所以 workflow 的调用合计恒等于 SubAgents 里的
  workflow 调用数。任务的路由报告以后作为第三个视图 Tasks 放进同一页。
- **合并为 Model routing**（owner，2026-11-22）：Model tiers 与 Routing report 合成 **设置 → Providers → Model routing**
  （`/settings/providers/routing`；旧地址 `/settings/providers/tiers`、`/settings/routing-report` 带着查询参数跳过来）。
  页首是 Route by tier（原名 Smart model selection，同日改名）与 Optimize For（从 General 搬来），下面每个模型一行：档位（可改）、价格、Ran at（按档位分的
  运行条，跑在当前没设的档位上的部分标出来）、Runs / Done / Cost，点开看分档明细；按名字调用和未路由的另起两段，没档位也没运行的
  模型折叠。Workflows 视图不变。原生客户端仍在 General 里画这两个开关，待跟进。

### 7.1 完成质量（只显示，不参与路由）

owner（2026-11-21）：Model tiers 表每个模型一行多一列 **Quality**，同一格里放两个来源；**只显示，`routeSubagent` 和
`routeTaskRun` 都不读它**（`model-quality.spec.ts` 守着这一点）。效果图 `docs/mocks/model-quality/01-board.png`。

- **父模型给 SubAgent 打分**：MCP 工具 `subagent_rate`（CLI `orbit subagent rate RUN_ID --score N [--note TEXT]`），
  参数 `runId`、`score` 1–5、可选 `note`（≤ 500 字符）。分数按父会话拿结果做了什么来定：1 = 丢掉或自己重做，3 = 改过才能用，
  5 = 原样用上。只有发起这次运行的会话能评（`POST /runner/sessions/:id/subagents/:runId/rating`，run 按 (id, 该会话) 匹配，
  别的会话读作不存在）；还在跑的运行拒绝 `SUBAGENT_RUN_RUNNING`；一次运行一条评分，再评即替换；SubAgent 自己拿不到这个工具。
  写进 `subagent_run` 的评分列，连同评分时父会话自己的 engine / provider / model（§6.1）。
  `<orbit-subagent-finished>` 块和前台 `delegate` 的返回各多一句，请父会话用过结果后打分；可选，没有任何东西等它。
- **任务运行的首次通过**：沿用路由报告的口径（`task-model-routing-report.service.ts` 的 `taskFirstPassByModel`）：
  已完成（DONE）的任务按其第一次运行的 provider × engine × model 计，只跑了一次、没有 FAILED、没有验证 FAIL、没有被退回即算首次通过。
  因用量上限或模型满载失败的运行（`limitFailure`）**整条不算**：既不算失败，也不算一次运行，与路由的处理一致。
- **汇总**（`GET /providers/subagent-tiers` 每个模型的 `quality`，`runner-api/model-quality.ts`）：近 90 天。
  SubAgent：结束了的运行数、被评的数、按评分时间衰减的加权平均（半衰期 30 天），不足 5 条评分不给平均（显示 Not enough ratings），
  另附评分者的模型及各自条数。任务：完成数、首次通过数、通过率，不足 10 个完成任务不给通过率（Not enough tasks）。
  一次 SubAgent 运行算在交出结果的模型下：最后一次 attempt 的，影子行算父会话的引擎和它实际跑的模型，否则是决策选的。
  一行模型把其 provider 各引擎的数加在一起。
- **界面**（owner 在效果图上选 A1 · B1 · C1，2026-11-21）：Quality 一格两行，各带灰色小字来源——
  `SubAgents  4.4 · 23 rated of 41`、`Tasks  86% first pass · 52 tasks`；不到门槛的一行灰色写 `Not enough ratings` /
  `Not enough tasks`，两样都没有的模型只写一行 `No runs yet`；有平均分时，SubAgents 那行的提示写评分者
  `Rated by Opus 5.5 (15) · Sonnet 5.5 (8)`（web 和 Mac 悬停，iPhone 和 Android 点一下）。表下多一句说明：只显示、不参与路由，
  以及两个数各自的口径。Web 和 Mac 是 Tier 后面的一列；iPhone 和 Android 把两行放在模型名下面。
  各端共用同一套文字规则：web `qualityLines`（`lib/subagentTiers.ts`）、Apple `SubagentSettings.qualityLines`、Android
  `Subagents.qualityLines`。

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

- owner 决策（2026-11-17）：点名 `workspace` 可选同一 owner 的任意仓库，不比较 `repoUrl`（任一为空也允许）；仅按 `needs` 自动选取时仍限父会话同一仓库。
- runner 目前不报告操作系统；runner 任务要加上 `os:<GOOS>`（`os:darwin`、`os:linux`）。其他能力沿用 `Runner.capabilities`。
- 目标 workspace 的 Agent 必须开着 SubAgents（`subagentsEnabled`），并发上限按**目标**会话树算在父会话的上限里。

### 10.2 在哪里跑、改动去哪

- 服务端把 SubAgent 派给目标 runner；目标 runner 在该 workspace 的 workDir 上建一个**临时的、detached 的 worktree**
  （目标 workspace 自己的 HEAD），子引擎在里面跑；结束后整个删掉。
- **workDir 不是 git 仓库**（owner 决策 2026-11-19）：
  - **只读的 SubAgent**（`type: explore`，或定义文件 `readonly: true`）**就地跑**：子引擎直接在 workDir 里跑，不建也不删
    worktree。claim 带 `inPlace: true`；目标 runner 不管自己读到的定义怎么写，一律按只读起子引擎（Claude 去掉
    Edit/MultiEdit/Write/NotebookEdit，Bash 仍按父会话的模式；Codex 用只读沙箱，**不能联网**，连数据库这类检查要用 Claude）。
    run.json 记 `inPlace`、`tree` 为空，恢复和 GC 都不会删 workDir。续跑时 workDir 是不是 git 仓库变了就失败，提示重开。
    目标 runner 要声明 `subagent-remote-in-place/v1`（`SUBAGENT_REMOTE_IN_PLACE_V1`），否则不派（`SUBAGENT_WORKSPACE_LACKS_NEEDS`，
    按 `needs` 选时列为不满足）。
  - **可能改文件的 SubAgent** 仍拒绝（`SUBAGENT_WORKSPACE_NOT_GIT`），不在别人的工作目录里乱写。拒绝文案指出两条不改目录的路：
    改成只读委派，或在那个 workspace 上开会话；并明确劝阻 `git init`：它会改动那个目录，第一次提交还会把里面的东西（含密钥）
    一起提交。
  - 已知边界：就地只读挡住的是编辑工具，不是 shell；Claude 子引擎的 Bash 写下的东西不会被丢弃。worktree 本来也只隔离文件，
    挡不住数据库写入和网络请求。
- **只交回文字结果**：不把任何文件带回父会话，也不留在目标 workspace。结果末尾由 runner 附一行
  `Discarded changes: <n> files (<paths…>)`，让父 Agent 知道它改过什么但没有带回。
- **文件用 `file_upload` 交回**（owner 决策 2026-11-21）：改动不带回，但子 Agent 可以把截图、报告这类产物用 `file_upload`
  存进 Orbit，挂在父会话下（不进父会话的工作区）。目标 runner 不托管父会话，所以：
  - 子引擎的 `orbit mcp` 对上传、文件夹清单和 pin 的请求带 `?subagentRunId=<run>`；服务端（`sessionOfRemoteSubagent`）
    只在这次运行属于该会话和账号、派给的正是这台 runner、且仍是 `RUNNING` 时放行，其余照旧按托管会话的 runner 判断。
  - 目标 runner 上没有父会话的 socket，Plan 门读不到实时模式；远程运行的子引擎带 `ORBIT_SUBAGENT_REMOTE_MODE`
    （领取时父会话的模式，旧服务端不带时是子 Agent 自己的模式），Plan 门按它判断。所以在 Plan 模式下领取的运行仍然不能上传。
  - 远程运行的 worktree 在 `~/.orbit/remote-subagents/<run>/tree`，在 Orbit 自己的目录里；`file_upload` 把这次运行自己的
    worktree 当作它的 checkout 放行（别的运行的不放行），父会话的 uploads 目录照旧可用。
  - `file_fetch` 也带 `?subagentRunId=<run>`（2026-11-28）：描述和字节两个请求都按上面的规则放行，所以父 Agent 可以先
    `file_upload` 一个文件（比如补丁），把 id 写进 prompt，远程子 Agent 再 `file_fetch` 取回，下载时校验 sha256。
    其他 Orbit 写操作没有放开：服务端仍只认托管父会话的 runner。
- 看不到父会话未提交的改动：工具描述里写明「remote SubAgents run on that workspace's own HEAD and return text only」，
  父 Agent 需要它看到新代码时，自己先提交并推送（或者在 prompt 里写清楚）。
- **续跑**：worktree 随结束删掉，对话留下。目标 runner 把结束的运行记成 `ended`（`remote-subagents/<runId>/run.json`：
  引擎、会话 id、引擎状态目录、worktree 路径），最后一次运行后保留 7 天（`gcRemoteSubagentConversations`）。父 runner
  为远程运行也写 `run.json`（带 `workspace`）；`resume` 它时带上 `resumeOf` 和新 prompt，不带 `workspace`/`needs`。服务端
  （`openRemoteResume`）把新运行派回原 workspace 和原 runner，claim 里带 `resumeOf`；运行中、原 workspace 已删或换了
  runner、目标 runner 没声明 `subagent-remote-resume/v1` 时拒绝。目标 runner 在**同一路径**重建 worktree（引擎按 cwd 找对话），
  用原来的会话 id 和状态目录续上，prompt 前加一句说明旧 worktree 已丢弃。引擎换了、记录已过期、或同一对话正在被另一次续跑时失败并说明原因。
- **记录的回收**：父 runner 上 `runs/<session>/subagents/` 存着续跑要的 `run.json` 和各次尝试的引擎状态。worktree GC 的同一轮
  问 `worktrees-removable`，父会话已 Completed、删除、不存在或移走时整个删掉（`gcSubagentRuns`）；`runs/<session>/` 其余内容不动。

### 10.3 路由、显示、生命周期

- 路由（§4）的候选池按**目标 runner** 的引擎、登录、额度算；`decision` 记 `workspaceId` 和选中它的理由。
  实现（2026-11-16，`planRemoteSubagent`）：
  - **点名模型**（`delegate(model=…)`）：在目标 runner 上找提供它的 Provider × 引擎，过 §4.2 的 1–4 条（屏蔽、范围、
    装没装、登录没登录、额度、暂停），第一个能起的就用它；一个都没有，开跑前立刻回 `SUBAGENT_TARGET_CANNOT_RUN`，
    写明每个提供者被去掉的原因，并列出这个 workspace 能跑的模型（按 Provider 和引擎）。**不会换成别的模型。**
  - **没点名**：先看目标 workspace 自己的默认引擎在目标 runner 上能不能用（同样过 §4.2 的 1–4 条，登录看
    `engines[].auth` 和 `engineState` 的 `signedOut`，含 `loginExpiresAt`）。能用就照旧跑默认引擎和模型
    （`tierSource: not-routed`，`policyVersion: subagent-remote-v2`）；不能用就按 `routeSubagent` 在目标 runner 的报告上选，
    跳过的默认引擎和原因写进 `reasons`（`Skipped <workspace>'s default <provider>: <reason>`）和 `candidates`。
    一个能用的都没有，回 `NO_SUBAGENT_PROVIDER`，列出每个 Provider 的原因；不会退回父会话的模型。
  - 定义文件里的 `model` 在父会话那台机器上读，跨 workspace 时不参与选择。
  - 领取（claim）按开跑时记下的候选建 `exec`；记的是默认引擎的，按默认引擎重建。
  - 目标 runner 上的跑没有 §4.3 的换候选回路：开跑前已经跳过没登录的引擎，跑起来再撞上登录失败或额度，失败交回父 Agent。
- 事件由目标 runner 发给服务端，服务端以父会话的 `sessionId`、`parentToolUseId` = `delegate` 调用写进父会话的事件流；
  只有被派到的那台 runner 能为这次运行写事件（按 `subagent_run` 的 `target_runner_id` 鉴权）。
- 块头多一项：`general · M · Claude Sonnet 5.5 · on orbit-macos`；Why 里写 workspace 是怎么选出来的。
- 审批卡照 §5.3 发到父会话。父会话停止 / 结束时，服务端通知目标 runner 停掉它（宽限 10 s）；目标 runner 掉线时记
  `INTERRUPTED` 并唤醒父会话。花费照样计入父会话。
- `subagent_run` 加列：`workspace_id`、`target_runner_id`。

**服务端实现（2026-11-12）**：父会话的事件 seq 由父会话的 runner 编号（`runner-go/session.go` 的 `sessionEventBuffer`），
服务端直接插 `run_event` 会占掉它下一条事件的 seq。所以事件分两段走：目标 runner 把子引擎的原始事件发到
`POST /runner/subagent-runs/:runId/events`（只认 `target_runner_id`），服务端按 `rewriteSubagentEvent` 的规则改写
（`parentToolUseId` = `delegate` 调用，子 id 加 run id 前缀）后存进 `subagent_relay_event`；父会话的 runner 从
`GET /runner/sessions/:id/subagents/:runId/events?after=` 读出，再由它编号写进父会话的事件流。其余门：
目标 runner 的 heartbeat 带 `remoteSubagentRuns`（待领取）和 `stopSubagentRunIds`（父会话已停止或结束）；
`POST /runner/subagent-runs/:runId/claim` 交回开跑时选定的候选（默认是目标 workspace 自己的默认引擎和模型）的 `exec`；`PATCH /runner/subagent-runs/:runId`
报结束；父会话 runner 用 `POST /runner/sessions/:id/subagents/:runId/stop` 停它；审批卡由目标 runner 以父会话 id +
`subagentRunId` 提交。目标 runner 掉线由唤醒 sweep 记 `INTERRUPTED`。代码：`apiserver/src/runner-api/subagent-remote.ts`。
