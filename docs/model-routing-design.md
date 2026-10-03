# 任务智能选择模型（Model Routing）设计

**状态**：P0 设计稿（2026-10-03），等 owner 审阅。项目「任务智能选择模型」（`34Z2CCqHygFxrbqBlPljx`）。
契约边界在 [`project-agent-contract.md`](./project-agent-contract.md) v1.4（§0.3、§7.2 P6 / P7、§7.4 R1–R4、§7.5、
§8.2、§11.1 L1 / L7、§11.4）；本文写规则细节，与契约冲突时以契约为准。

**效果图**：[`mocks/model-routing-web.png`](./mocks/model-routing-web.png)（Web）、
[`mocks/model-routing-ios.png`](./mocks/model-routing-ios.png)（iOS / macOS）。界面文案以同目录的 `.html` 源文件为准。

> **用词**：本文的 **Agent** 指线上叫 Agent 的 `workspace` 行（契约 §2 Legacy agent alias），不是契约 §3.1 的 `agent` 表。
> 这个功能在界面上叫 **Smart model selection**，在代码和契约里叫 **Model Routing（路由）**；**档位**指 S / M / L / XL。

## 0. 一页结论

- 派发任务时，为每一次**新建运行**选 model 和 effort。只管任务运行，不管人自己开的会话。
- **第一版是简易版**：coordinator 给每个任务建议一个档位（`task.modelHint`：S / M / L / XL，附一句理由），路由器照建议
  按档位表选模型；上一次运行因非额度原因失败，下一次升一档（最高 XL）；没有建议、上次也没失败的任务**不路由**，保持原来的
  选择。按任务结构 / 关键词自动判断的规则引擎和 LLM 分类器留到后续（§3.5 写明接在哪里）。
- **默认影子模式**：每次新建运行都算一遍、记一条决策（`task_route_decision`），但不改变派发结果；owner 在 Agent 设置里
  打开 Smart model selection 后才生效。
- **人定的优先**：任务上手动指定的 model 永远优先；路由结果不写回 `task.model` / `task.provider`。
- **不悄悄换引擎**：默认只在本 Agent 的引擎内选档；跨引擎只能选 owner 在 Agent 上显式勾选的引擎（P5），每次都写理由。
- 路由器是**纯函数**，派发路径上不发网络请求；结果冻结在 run target 里，接管重放不重算。
- 分六期 P0–P5（§11）：先影子两周，再在以 EXECUTABLE 为主的 Agent 上开启、对比（§10.2）。

## 1. 目标与非目标

**目标**

1. 简单的活用便宜的档（Sonnet、低 effort），难的活用强的档（Opus、高 effort）：通过率不降，token 更少。
2. 失败后自动加力：上一次非额度失败，下一次升一档，不用人去改 pin。
3. 每一次选择都有记录、有理由，能按档位统计效果，用数据决定开不开、档位表怎么调。
4. 没打开的 Agent，派发结果与今天逐字段相同。

**非目标**

- **人自己开的会话**：输入框新建的会话、MCP `session_create`、@-mention 打开的对话、coordinator 会话，一律不路由，
  模型标签和今天完全一样。
- **已经开始的运行**：RESUME（把提示词作为新一轮投给暂停的运行）、ADOPT、`AutoRetryService` 在同一会话上的重试都不重新选；
  Session 的 model / effort 在首次 claim 后冻结（契约 §6）。
- **自动判断档位**：第一版不按任务结构 / 关键词推断，也不调 LLM 分类器，只认 coordinator（或人）给的建议和失败历史（§3.5）。
- **写回任务**：路由结果不写 `task.model` / `task.provider`，那是人明确指定的值。
- **契约的 V1 路径**：V1（`task.execution_contract`）尚未落库，路由只接在 LEGACY 链上（契约 §0.3）。
- **其他引擎**：Kimi、OpenCode 和自带模型空间的配置 provider 不路由（§4.3）。

## 2. 现状：不路由时怎么选（基线）

任务的新建运行今天走契约 §11.1 的 LEGACY 链。下表就是本文说的**基线** —— 影子模式下真正跑的就是它：

| 维度 | 今天的来源（先到先得） | 代码 |
|---|---|---|
| provider | `task.provider` pin → `agentProviderSeed(workspace)`：这个 Agent 上最近一次**人开的**会话用的引擎（任务运行和 agent 派生的子会话不算），从没开过 = `claude` | `workspaces/workspace-provider.ts` |
| model | `task.model` pin → create 时留空，首次 claim 时物化为目标 runner 上报的运行时默认模型（`runtimeDefaultModels`），没有就取模型目录第一行，再没有用内置默认（`DEFAULT_MODEL_BY_PROVIDER`） | `providers/custom-provider.ts` `resolveProviderExec` |
| effort | `workspace.effort` → 账号默认 `UserPreferences.defaultEffort` → 模型自己的默认 | `sessions.service.ts` `resolveDefaultEffort` |
| 权限模式 | 账号默认 `UserPreferences.defaultPermissionMode`；所选 Claude 模型不支持 Auto 时，claim 把这次运行派生为 Default | `common/runtime-provider.ts` `normalizeBuiltinPermissionMode` |

路由必须绕开两个现成的坑：

- **别名会被当成退役模型**。派发时用 `isRetiredModel(model, 目录里的 value, 运行时默认)` 判断一个 model 还有没有效。
  runner 的 Claude 目录只列精确 id（`claude-opus-5-5`、`claude-sonnet-5-5`……），写 `sonnet` 这样的别名会被判为退役，
  悄悄换回默认模型（通常是 Opus）。路由器**只输出目录里的精确 id**（§4.4）。
- **Auto 会被悄悄降级**。账号默认是 Auto、而所选 Claude 模型不支持 Auto 时，claim 会把这次运行降成 Default —— 无人值守的
  任务运行就会停在审批卡上没人点。路由器**不选不支持 Auto 的模型**（§5）。

## 3. 定档（简易版）

### 3.1 档位与 coordinator 选档标准

| 档 | 什么样的活 | 例子 | Claude | Codex |
|---|---|---|---|---|
| **S** | 机械修改、改文案、升级版本 | 改按钮文案；升级一个依赖的版本；按既定规则批量改名 | Sonnet · low | 默认模型 · low |
| **M** | 需求清楚的功能或修复 | 加一个接口和它的 spec；修一个复现路径清楚的 bug | Sonnet · medium | 默认模型 · medium |
| **L** | 根因不明、并发、跨模块、迁移、改派发等核心路径 | 偶发的竞态；同时改 apiserver 和 runner；数据库迁移；`tasks.service.ts` 的派发路径 | Opus · high | 默认模型 · high |
| **XL** | 架构设计、长时间无人值守、L 档反复失败 | 新子系统的设计；要跑几个小时没人看的大改；L 档已经失败过两次 | Opus · max | 默认模型 · xhigh |

- coordinator 建任务时给每个任务填 `modelHint` 和一句 `modelHintReason`；看到项目里缺建议的任务也补上。理由写判断依据，
  例如 "one service plus its spec; an acceptance command decides it"，它会显示在任务详情的 Suggested 下面，也会出现在 Why 里。
  人也可以在任务详情里改。
- 拿不准时按"判错的代价"定：验收命令当场判对错的（EXECUTABLE）可以往低选 —— 判错了会自动失败、自动升档；只能靠人看或
  靠验证任务判的往高选 —— 一次返工要等人。
- 引擎仍用 `provider` 字段指定；`modelHint` 只说"多难"，不说"用谁"。
- 存的是**档位**，不是模型：模型换代时只改档位表（§4），任务不用动。

### 3.2 定档规则

按顺序，第一条命中即止：

| # | 条件 | 结果 | reason 示例 |
|---|---|---|---|
| 1 | `task.model` 有 pin | **不路由**，用 pin | `Model pinned on the task: claude-opus-5-5` |
| 2 | 执行引擎没有档位表（§4.3） | **不路由** | `No tier table for kimi — keeps the agent's model` |
| 3 | 上次运行因**非额度**原因失败，且上次档位可知（§3.3） | 档位 = min(XL, max(上次档位 + 1, `modelHint`)) | `Tier L — one above run 1 (M), because run 1 failed its acceptance command` |
| 4 | 有 `modelHint` | 档位 = `modelHint` | `Tier M: suggested by the coordinator — one service plus its spec` |
| 5 | 其他 | **不路由**，保持基线 | `No suggestion — keeps the agent's model, as today` |

- **provider pin 不关掉路由**：只有 `task.provider` 有 pin 时，引擎就是它，路由器只在这个引擎里选 model / effort。
  coordinator 建的任务通常都 pin 了 provider（引擎用 `provider` 指定）；如果 provider pin 也算"手动指定"，这些任务就永远
  不会被路由（契约 §7.2 P7 第 1 条）。
- 第 3 条取 `max(…, modelHint)`：上次失败之后 coordinator 把建议调高了，就用更高的那个。
- 没有建议的任务：第一次运行、以及上次没失败的运行都不路由；上次非额度失败时照样升档（上次档位按 §3.3 反查）。
- 不路由时也写一条决策：`level` 为空，provider / model / effort 记基线，`reasons` 写原因（§7.3）。定出了档位、却因为目标
  runner 没报模型目录而选不出模型（§5 第 1 条）时同样按不路由记，`reasons` 里写明想要的档位。

### 3.3 失败升档

**失败口径**与 `tasks.service.ts` 的 `autoRunHoldOff`（自动重跑的失败预算）一致，另加两种"跑完了但被判不合格"：

| 算失败 | 判据 |
|---|---|
| 运行失败 | 工作会话 `status = FAILED`，且 `error` 不含 `USAGE_LIMIT_ERROR_MARKERS`（`src/shared/src/events.ts`）中的任何一条；`error` 为空也算 |
| 验收命令失败 | 已含在上一行：验收不过时，会话以 `acceptance command exited N; expected M` 落 FAILED（`executable-acceptance-round.ts`） |
| 验证 FAIL | 这次运行之后，验证这个任务的 verifier 任务给出 `verdict = FAIL` |
| owner 退回 | 这次运行之后，owner 对任务的 `task_evidence_decision` 是 `SEND_BACK` |

- **判定归哪次运行**：验证 FAIL 与退回归到判定时最近创建的那次工作运行，与 §10.1 报告同一口径（verifier 取当前
  `verdict` 与 `updated_at`，退回取 `decided_at`）—— 路由据以升档的失败，就是报告计入的失败。同一次运行有几种失败时
  只算一次：`outcome` 先取运行自己的结局（验收失败 / 失败），再取验证 FAIL，最后取退回。
- **上次运行** = 该任务最近一次工作运行（`starts_task_work` 的会话，按创建时间），**跳过额度失败的运行**。额度失败与这次
  的活无关，不计入：它既不升档，也不打断此前的升档（M 失败 → L 撞额度 → 下一次仍是 L，见 §3.4）。
- **上次档位** = 上次运行那条决策的 `level`（按 `session_id` 取）。影子决策也算：影子模式模拟的是"如果开了"，升档也按
  "如果开了"的档位链算。没有决策或 `level` 为空时，按上次**实际用的**模型反查档位表：Opus 系 → L，Sonnet 系 → M，
  Codex 按 effort（low / medium / high / xhigh → S / M / L / XL）；反查不出就当上次档位未知，落到 §3.2 的第 4 / 5 条。
- **封顶 XL**：XL 再失败仍是 XL。之后要不要换做法、拆任务，是 coordinator 和人的判断，不是路由器的。
- 只有**新建运行**会重新定档：自动重跑（`rearmEndedAutoRuns`）、Run Now、`task_start`、各 sweep 都带新的 request token，
  会走到这里；`AutoRetryService` 在同一会话上的重试不会。
- 不依赖 `TaskAttempt`、`convergenceCounters`、`TaskVerificationFailure`：前两者没有生产写入方，后者自迁移 0272 起不再写入。

### 3.4 例子

`modelHint = M`，Agent 已开启：

| 运行 | 发生了什么 | 档位 | 选出的模型 |
|---|---|---|---|
| run 1 | 第一次运行 | M | Sonnet 5.5 · medium |
| run 2 | run 1 验收命令失败 | L ↑ | Opus 5.5 · high |
| run 3 | run 2 撞了周额度（不计入，上次运行仍是 run 1） | L ↑ | Opus 5.5 · high |
| run 4 | run 3 被 owner 退回 | XL ↑ | Opus 5.5 · max |
| run 5 | run 4 失败 | XL（已是最高档，不再标 ↑） | Opus 5.5 · max |

### 3.5 以后接在哪里：规则引擎与 LLM 分类器

- **位置**：§3.2 第 4 条（`modelHint`）之后、第 5 条（不路由）之前，作为**没有建议时的补充来源**。coordinator 或人给的建议
  永远优先；补充来源也给不出时才不路由。失败升档（第 3 条）照旧作用在它们给出的档位上。
- **规则引擎**（按任务结构 / 关键词）是纯函数，直接放进路由器；输入就是决策里已经在攒的 `features`（§7.3）。
- **LLM 分类器**不能在派发时调用（路由器不发网络请求）：要在任务创建 / 修改时异步算好、存下结果，路由器只读存下来的值。
- 每接一个来源，`policyVersion` + 1，`reasons` 写明档位来自哪里（例如 `Tier M: inferred from the task's shape`），先在影子
  模式里跑一轮，按 §10 与建议档位的效果比较，再决定是否生效。两个补充来源同时存在时谁优先，用各自的影子数据决定。

## 4. 档位表

### 4.1 Claude

| 档 | 模型系 | 前缀 | effort | 今天解析到（示例） |
|---|---|---|---|---|
| S | Sonnet | `claude-sonnet-` | low | `claude-sonnet-5-5` |
| M | Sonnet | `claude-sonnet-` | medium | `claude-sonnet-5-5` |
| L | Opus | `claude-opus-` | high | `claude-opus-5-5` |
| XL | Opus | `claude-opus-` | max | `claude-opus-5-5` |

### 4.2 Codex

同一个默认模型，只换 effort：S / M / L / XL = low / medium / high / xhigh。模型取目标 runner 上报的
`runtimeDefaultModels.codex`，没有就取 Codex 目录第一行 —— 与首次 claim 物化默认模型的顺序相同，所以 Codex 的路由不换模型。

### 4.3 哪些引擎有档位表

按**执行 runtime** 判断，不按 slug：

- 内置 `claude`，以及 Claude 账号池 → Claude 表；
- 内置 `codex`，以及 Codex 账号池（含共享池）这类 runtime 为 codex 的 provider → Codex 表；
- `kimi`、`opencode`、自带模型空间的配置 provider（`ModelProvider` 行声明了自己的模型）→ **没有档位表，不路由**。

### 4.4 怎么从模型系得到精确 id

- runner 心跳上报的 Claude 目录（`runner.modelCatalog.claude`）是 runner 让 CLI 把 `opus` / `fable` / `sonnet` / `haiku`
  四个别名各解析成一个精确 id 得到的（`src/runner-go/claude_models.go`），`priority` 就是这个顺序。
- 路由器在**目标 runner** 的目录里找 `value` 以该系前缀开头的行，取 `priority` 最小的一行，输出它的 `value`。
- 永远不输出别名（理由见 §2）；目录里没有这个系，按 §5 第 4 条换系。
- 同系出了新一代（例如 Sonnet 6），runner 的别名会自动解析到新 id，档位表不用改；只有"哪一档用哪个系、什么 effort"变了
  才改档位表，并把 `policyVersion` + 1。

## 5. 约束

档位表给出"想要的系 + effort"之后，依次检查：

1. **只选模型目录里有的**：目标 runner 没报模型目录（还没上报过，或探测失败）→ 不路由，reason
   `This runner has not reported its models — keeps the agent's model`。目录里找不到某个系 → 该系不可用。
2. **Auto 权限模式过滤**：账号默认权限模式是 Auto、引擎是 Claude 时，`autoAvailable(runtime, model, false, 目标 runner 的目录)`
   为假的模型视为不可用。用的是派发时的同一个函数，两边不会给出不同答案。
3. **Opus 周额度**：目标 runner 心跳里的 `planUsage.claude.sevenDayOpus.utilization ≥ 90` 时，Opus 系对这一次决策视为不可用。
   窗口缺失（套餐没有单独的 Opus 窗口、旧 runner）= 不触发。
4. **换系不换档**：想要的系不可用时，档位不变，换另一个系 —— L / XL 改用 Sonnet 系 + xhigh（Opus 周额度紧张时就是这一条），
   S / M 改用 Opus 系 + 该档的 effort；两个系都不可用 → 不路由。档位是"这件活多难"的判断，不随机器变；变的只是这一次用
   哪个模型，决策里 `level` 仍是判断出的档位，`model` / `effort` 是实际选的（评估按两者一起分组，§10）。
5. **effort 只发模型支持的**：目录行带 `reasoningLevels` 时（今天是 Codex），effort 必须在其中，不在就取最近的一档
   （同距取高）。Claude 目录行今天不带这个字段，effort 按 CLI 的统一取值（low / medium / high / xhigh / max）下发。

每一处偏离档位表都写一条理由，例如 `Opus weekly quota at 93% — stepped down to Sonnet 5.5 · xhigh`；L / XL 没换系也写一条，
例如 `Opus weekly quota at 41% — no step-down needed`。

## 6. 跨引擎（P5）

契约 §7.4 R1–R4 定边界，这里定做法：

- **候选引擎** = 本 Agent 的引擎 ∪ `workspace.modelRoutingProviders`（只算有档位表的）。默认空数组 = 只有本 Agent 的引擎，
  永不跨引擎；界面上 Engines it may use 默认只勾本 Agent 的引擎。`task.provider` 有 pin 时候选只有它。
- **本 Agent 的引擎** = 基线的 provider（§2 表第一行）。
- **排除**：目标 runner 上没登录的引擎（`runner.engines` 的登录状态），以及这次运行会用的账号额度已用到 90% 以上的引擎
  （`planUsage` 里该引擎对应的窗口）。
- **选择**：验证任务（`verifiesTaskId` 非空）优先选与被验证任务上一次运行**不同**的引擎 —— 换一双眼睛；其余情况留在本 Agent
  的引擎，只有它被排除时才换到另一个候选。
- **档位不变**，按新引擎的档位表映射；每一步写理由，例如 `Engine codex: claude is above 90% of its weekly quota`。
- **换引擎 = 新会话**：新建运行本来就是新会话，Session 的 provider 终生固定。
- **闸门跟着改**：sweep 的额度闸门（`tasks.service.ts` 的 `quotaGate`）今天按 Agent 的种子引擎判断，P5 改成按路由选出的
  引擎（或任务 pin）判断 —— 否则闸门挡的和实际要用的不是同一个引擎。

P5 实现的口径（`model-routing.ts` 的 `chooseEngine`，读取在 `task-route-decision.ts`）：

- **登录**：与 `sessions.create` 的登录预检（`signedOutEngineRefusal`）同一个判断，看这次运行会用的那个账号；runner 离线、
  报 `unknown`、带自己的凭据都不算未登录。
- **额度**：看这次运行会用的账号（Agent 交给 Orbit 选账号时，就是 `automaticAccount` 选出的那个）里**管整个引擎**的窗口 ——
  Claude 的 5 小时与周窗口、Codex 的 primary / secondary —— 任一 ≥ 90% 且没过重置时间即排除。模型系自己的窗口
  （Opus 周窗口）只按 §5 第 3 条换系，不排除整个引擎。
- 目标 runner 没上报模型目录的其他引擎也不选：档位表映射不到具体模型。
- 只有一个候选（没勾其他引擎，或任务 pin 了 provider）、或者没定出档位时，不看以上任何一条，理由与 P5 之前逐字相同。
- **理由**：`Engine codex: claude is at 93% of its weekly quota` · `Engine codex: claude is signed out on this runner` ·
  `Engine codex: the task it verifies last ran on claude`；想换却没有可换的：`Engine claude: this agent's own engine — no
  other engine it may use is available`，后面每个被排除的引擎一行（`codex is signed out on this runner`）。
  `features` 另记 `modelRoutingProviders`、`engineStates`、`verifiedRunEngine`。
- **闸门**：就绪扫描与自动重跑的重试决策（`autoRunRetryDecisions`）判断的都是「这次运行会建在哪个引擎上」：Agent 开了智能
  选择且路由生效 → 路由选出的引擎；否则任务的 provider pin；再否则 Agent 的种子引擎。只有开了开关的 Agent 才在闸门前
  算路由，pin 与开关随扫描的同一条 SQL 读出。
- **界面**：Engines it may use 只列有档位表的引擎（claude、codex），本 Agent 的引擎勾上且不能取消；kimi 没有档位表，勾了也
  选不到，所以不列（效果图里的 kimi 不出现）。

## 7. 数据模型

所有新列和新表由 P1 的一个迁移一次加齐，后续各期不再加迁移。

### 7.1 `task`

| 列 | 类型 | 说明 |
|---|---|---|
| `model_hint`（`modelHint`） | text，可空，CHECK 只允许 S / M / L / XL | coordinator（或人）建议的档位 |
| `model_hint_reason`（`modelHintReason`） | text，可空，≤ 500 字 | 一句理由，界面原样显示 |

- **写入口**：`task_create`、`task_create_batch`（每一项）、`task_update`（MCP 与 CLI 的 `--model-hint` /
  `--model-hint-reason` / `--clear-model-hint`）、REST create / update（update 三态：不传 / 设值 / `null` 清空），以及 Web 与
  原生的任务详情。新 MCP 参数必须同时进 `copyIfPresent` 白名单、CLI 参数、capability 说明和帮助文本，否则会被静默丢掉。
- **与 `task.model` 的区别**：`model` 是硬指定（pin）—— 永远优先，不升档，换代要人改；`modelHint` 是建议 —— 失败可以升档
  盖过它，换代不用改。
- `modelHint` 和 `modelHintReason` 均可空；update 分别按不传保留、设值替换、`null` 清空。CLI 的 `--clear-model-hint` 同时清空档位与理由，不能与设置这两个字段的旗标并用；create 也可显式声明空建议，batch 用每项的 JSON `null`。
- 批量审批卡的 digest（`handoffPayloadDigest`）带建议或理由时升到 v6，绑定 `modelHint` 与 `modelHintReason`：只改了建议的两次批量请求不是同一张卡。两者皆空时保留旧版本，旧审批身份不变。

### 7.2 `workspace`（Agent）

| 列 | 类型 | 说明 |
|---|---|---|
| `model_routing`（`modelRouting`） | boolean，默认 false | Smart model selection 开关：true = 生效，false = 影子模式 |
| `model_routing_providers`（`modelRoutingProviders`） | text[]，默认空数组 | owner 显式授权的其他引擎（P5）；空 = 只在本 Agent 的引擎内选档 |

两列都**只能通过用户 API 改**（`workspaces/dto.ts` + `workspaces.service.ts`），不进
`runner-api/runner-agents.controller.ts` 的 `ORCHESTRATOR_WORKSPACE_CREATE_FIELDS` / sanitize：这是影响花费和引擎的开关，
agent 不能给自己打开（契约 §8.2）。

### 7.3 `task_route_decision`

每个 run request 一行，影子模式也写。

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid v7 | |
| `owner_id` | uuid | 租户边界，所有读都按它过滤 |
| `task_id` | uuid，task 删除时级联 | |
| `request_token` | text | 这次 run request 的 token：单次派发是租约上的 request token，批量是该项的 `TASK_RUN_TRIGGER.batch(press, task)` |
| `session_id` | uuid，可空，**无外键** | plan 给出的会话 id。写决策时会话还不存在（与 `desired_session_id` 不带外键同理）；派发随后被拒的，它永远不会存在 |
| `applied` | boolean | 是否用于派发：`modelRouting` 打开且定出了档位 |
| `policy_version` | int | 档位表与规则的版本，第一版 1 |
| `level` | text，**可空**，CHECK 只允许 S / M / L / XL | 定出的档位；不路由时为空 |
| `provider` | text | 选出的引擎；不路由时 = 基线 |
| `model` | text，可空 | 选出的精确 id；不路由且基线没有 model 时为空（= 运行时默认） |
| `effort` | text，可空 | 选出的 effort；不路由时 = 基线 |
| `baseline` | jsonb | 不路由时会用的值 |
| `features` | jsonb | 任务特征与历史，只记录；§3.5 的补充来源用它校准 |
| `reasons` | text[] | 给人看的英文短句，界面原样显示 |
| `created_at` | timestamptz | 决定的时刻（Why 页脚的 "decided …"） |

- **约束与索引**：`UNIQUE (task_id, request_token)`（接管重放 `ON CONFLICT DO NOTHING`）；`(owner_id, created_at)`（报告按
  时间段扫）；`(session_id)`（任务详情 / 会话详情按会话取）。
- 四个 uuid 列要在 `src/shared/src/codec.ts` 的 `PUBLIC_ID_FIELDS` / `NEVER_PUBLIC_ID_FIELDS` 里归类，否则
  `public-id-coverage.spec.ts` 会红。

`level` 与 `applied` 只有三种组合：

| `level` | `applied` | 含义 |
|---|---|---|
| 空 | false | 没路由（任务 pin、没有档位表、没有建议、选不出模型），派发用基线 |
| 非空 | false | 影子：如果开了会选这个，实际跑的是基线 |
| 非空 | true | 生效：实际跑的就是这个 |

`baseline` 与 `features` 的样子（字段可以加，不要删 —— 评估要读历史行）：

```jsonc
// baseline：不路由时 create 会用的值
{ "provider": "claude", "providerSource": "agent-seed",      // 或 "task-pin"
  "model": null, "runtimeDefaultModel": "claude-opus-5-5",   // model 为空 = 首次 claim 用运行时默认
  "effort": "max", "permissionMode": "auto" }

// features：只记录，第一版只有失败历史参与定档
{ "modelHint": "M", "completionCriterion": "EXECUTABLE", "hasAcceptanceCommand": true,
  "verifiesTask": false, "isForeman": false, "dependents": 2, "promptChars": 1830,
  "priorRuns": 1, "priorFailures": 1, "quotaFailuresSkipped": 0,
  "lastRun": { "ordinal": 1, "level": "M", "model": "claude-sonnet-5-5", "outcome": "ACCEPTANCE_FAILED" },
  "escalatedFrom": "M", "opusWeeklyUtilization": 41, "modelRouting": true }
```

- `features` 里**不放 id**：上次运行用序号指代（run 1、run 2），与界面说法一致，也就不会有 uuid 混进出站 JSON（契约 §10 B3
  那一类坑）。
- `lastRun.outcome` 取 `FAILED` / `ACCEPTANCE_FAILED` / `VERIFICATION_FAILED` / `SENT_BACK` / `OK` 之一（额度失败的运行被
  跳过，不会出现在这里，只计入 `quotaFailuresSkipped`）。
- `escalatedFrom` 非空 = 这次因上次失败比上次高了一档（界面上的 ↑），不另设列；XL 封顶、档位没变时为空。

**`reasons` 的写法**：英文短句，按"档位从哪来 → 升档时上次的档位从哪来 → 引擎 → 约束"的顺序，一条一句；模型用目录里的
`label`（Opus 5.5）称呼。页脚 "Policy v1 · decided Oct 3, 10:24 · a failure from a usage limit would not have moved the tier"
由客户端用 `policy_version` 和 `created_at` 拼，不进 `reasons`。效果图里那一次 L 档运行的 `reasons` 是：

```
Tier L — one above run 1 (M), because run 1 failed its acceptance command
Run 1 started at M: suggested by the coordinator — one service plus its spec
Engine claude: this agent's own engine
Opus weekly quota at 41% — no step-down needed
```

失败的说法：`failed` / `failed its acceptance command` / `was failed by its verifier` / `was sent back by the owner`；
上次档位是反查出来的：`Run 1 ran on Opus 5.5, which counts as tier L`；跳过额度失败：`Run 2 hit a usage limit — not counted`。
措辞以 P1 的实现为准，客户端原样显示，不自己推算。

### 7.4 run target v2

`task-run-receipt.ts`：

- `TaskRunExecuteTarget` 与 `TaskRunBatchPlan` 的 `v` 从 1 升到 2；单次 target 与批量的每一项（`TaskRunBatchItemPlan`）都加：
  - `effort: string | null` —— 下发给 `sessions.create` 的 effort；`null` = 不指定（沿用 workspace / 账号默认，与今天相同）；
  - `route: TaskRunRoute | null` —— 决策快照，内容与 `task_route_decision` 的一行相同；只有 `plan.kind = 'CREATE'` 时非空。
- `provider` / `model` / `effort` = 实际要下发的值：`route.applied` 为真时取路由结果，provider **显式写上**（不留给 create
  再推导种子 —— 接管时种子可能已经变了，model 就会落到另一个引擎上）；否则与今天相同（`task.provider` / `task.model` / `null`）。
- 读方：v2 与 v1 都能读（v1 按 `effort = null`、`route = null` 处理，用来接管升级前写下的 receipt）；不认识的版本照旧拒绝
  （`TASK_RUN_REQUEST_UNREADABLE`）—— 滚动部署时旧副本读到 v2 会拒绝，由新副本接着答，这是 receipt 已有的行为。
- 接管者**不重新路由**：额度、目录、失败历史都会变，路由和其他派发判断一样，只在第一次计划时决定一次。

```ts
interface TaskRunRoute {
  policyVersion: number;
  applied: boolean;
  level: 'S' | 'M' | 'L' | 'XL' | null;
  provider: string;
  model: string | null;
  effort: string | null;
  baseline: Record<string, unknown>;
  features: Record<string, unknown>;
  reasons: string[];
}
```

### 7.5 接口

- **任务**：`modelHint` / `modelHintReason` 随任务一起返回。任务详情另带 `modelHintOptions`：按该任务 Assignee 的 runner 目录
  解析好的四档（档位、模型 label、effort），由路由器的同一份档位表算出 —— Suggested 下拉直接显示它（Codex 任务显示 Codex 的
  模型），客户端不自己维护档位表。
- **运行**：任务详情（`loadDetail`）的 `sessions[]` 与会话详情各带 `route`：
  `{ level, provider, model, effort, applied, escalated, reasons, policyVersion, decidedAt }`，按 `session_id` 从
  `task_route_decision` 取，没有就是 `null`。
- **Agent**：`modelRouting` / `modelRoutingProviders` 随 workspace 一起返回。
- **报告**（P5）：`GET /tasks/model-routing/report?since=&agentId=`，只返回当前用户自己的数据（§10.1）。
- 以上全部是可选字段，旧客户端照常工作（契约 §11.4）。

## 8. 接入点

### 8.1 单次派发：`TasksService.executeLeased`

Run Now、`task_start` / `orbit task start`、依赖解锁、自动重跑、定时、foreman 与验证任务的派发都经过这里。在
`planWorkspaceRun()` 之后、构建冻结目标（`frozen: TaskRunExecuteTarget`）之前：

1. `planned.kind` 不是 `CREATE` → 不路由，`route = null`，其余与今天相同。
2. `CREATE` → 在租约内、事务外补读路由器的输入：任务的 pin、`modelHint` / `modelHintReason`、完成判据与验收命令、
   `verifiesTaskId`、下游依赖数；Assignee（`workspace`）的 `modelRouting` / `modelRoutingProviders` / `effort`；账号偏好里的
   默认权限模式和默认 effort；没有 provider pin 时的 `agentProviderSeed()`；目标 runner 的 `modelCatalog` /
   `runtimeDefaultModels` / `engines` / `planUsage`；该任务以往的工作会话（status、error、provider、model、effort、创建时间）、
   它们的决策，以及其后的验证 FAIL 与 owner 退回（§3.3）。
3. 调用 `routeTaskRun(input)`（`src/apiserver/src/tasks/model-routing.ts`，纯函数）。
4. 按 §7.4 构建 v2 冻结目标。
5. `applyExecuteTarget` 在 `bindRunRequest` 成功之后、`applyWorkspaceRun` 之前，用**已 bind 的** target 里的 `route` 写决策行
   （`ON CONFLICT (task_id, request_token) DO NOTHING`）：接管者 bind 到的是别人的计划时，写下的也是那份计划的决策。派发
   随后被拒的，决策照样留着，评估时按会话不存在排除。

### 8.2 批量派发：`TasksService.batchExecuteLeased`

批量 Run 不经过 `executeLeased`，它自己逐项调用 `planWorkspaceRun()`。在构建 `planned.items` 的循环里，对 `CREATE` 的每一项
做 §8.1 的第 2–4 步（runner、账号偏好这类可以按批读一次）；整份 plan bind 之后、`applyBatchPlan` 之前，逐项写决策行。

### 8.3 下发：`applyWorkspaceRun` 的 CREATE 分支

今天只把 `task.provider` / `task.model` 传给 `sessions.create`；P3 起再把 target 的 `effort` 传进去（`CreateSessionDto` 已经
支持 `effort`）。RESUME 分支不路由；它上面任务 pin 的 model 没有生效的已知问题由 P3 顺带修复（见该任务）。

### 8.4 不经过路由的入口

| 入口 | 为什么 |
|---|---|
| RESUME / ADOPT | 不是新建运行 |
| `AutoRetryService` 同会话重试 | 同上 |
| @-mention 打开的对话（`contextTaskId`） | 是关于任务的对话，不是任务运行 |
| 输入框、MCP `session_create`、coordinator 会话 | 人（或 agent）自己开的会话 |

## 9. 界面

| 位置 | 改动 | 效果图 |
|---|---|---|
| Agent 设置页 | Worktree isolation 下面加 Smart model selection for tasks 开关（默认关，只有用户 API 能改）；P5 再加 Engines it may use，默认只勾本 Agent 的引擎 | Web §1 · iOS ③ |
| 任务详情 · Details | 多一行 Suggested（No suggestion / S / M / L / XL，每档显示对应模型、effort 和一句说明），理由用灰字显示在下面；Assignee 开了智能选择时，Model 的占位文字是 ✦ Smart selection；在这里选定一个模型就是 pin，优先于建议 | Web §2 · iOS ① |
| 任务详情 · Runs | 每行副标题加"模型 · effort · 档位"，档位标签 ✦ M，升档时 ✦ L ↑；点开看 Why（决策里的 `reasons` 加页脚）；Agent 没开启时多一行紫色影子提示 Smart selection would have picked … | Web §3 · iOS ①② |
| 任务会话输入框 | 路由选出的任务会话，模型标签加 ✦ 和浅蓝底；下拉顶部说明为什么是它；在这里换模型只影响这一次运行，想固定去任务上 pin | Web §4 · iOS ④ |

- 自己开的会话、没开启智能选择的任务会话，标签与今天完全一样。
- Web 与 iOS / macOS 文案一致（`TaskDetailCopyParityTests` 比对两边的标签）。

## 10. 评估

### 10.1 指标

以 `task_route_decision` 为主表，join `session`、`usage`、`task`、verifier 任务的 `verdict` 与 `task_evidence_decision`。

**分组**：`policy_version × level × provider × model`，影子（`applied = false`）与生效（`applied = true`）分开给。provider /
model 一律取**实际运行**的（会话上首次 claim 之后的值）：生效行就是路由选的，影子行是基线 —— 于是"同一档、不同模型"正好是
"影子 vs 生效"的对比。`level` 为空的行是"没路由"的对照组。

| 指标 | 粒度 | 口径 |
|---|---|---|
| 样本数 | 运行 | 组内决策行数，只算会话真的建出来的 |
| 一次通过率 | 任务 | 第一次新建运行就让任务到达 DONE、且没有验证 FAIL / owner 退回的任务占比 |
| 失败次数 | 任务 | 平均每个任务的非额度失败次数（§3.3 的口径：运行失败、验收失败、验证 FAIL、退回） |
| token / 花费 | 任务 | 每完成一个任务的 token（`usage` 行的 input + output + cache 读写）与花费（`session.cost_usd`），计该任务的**全部**运行 |
| 耗时 | 运行 | 单次运行 `created_at → finished_at` 的 p50 |

注意：

- 任务级指标把任务归到它**第一次**新建运行所在的组：从 S 起步的任务，失败升档以后那几次运行的失败和花费也算在 S 头上 ——
  这才是"从 S 起步"的真实代价。第一次运行早于影子接入（没有决策）的任务不进任务级指标。
- 档位不是随机分配的（S 的活本来就简单），**只在同一档内比较**，不跨档比。
- Codex 运行之前不落 token，P1 补上 `usage` 行，`cost_usd` 记 0（订阅计费，没有按量价格）：跨引擎只能比 token，不能比花费。
- 额度失败不计入失败次数，但它用掉的 token 照算。

**报告接口契约（P5）**：用户 bearer 鉴权的 `GET /tasks/model-routing/report?since=&agentId=`，返回
`{ shadow: ReportGroup[], applied: ReportGroup[] }`。`since` 是可选的 ISO 时间（含边界，筛决策的 `created_at`）；
`agentId` 是可选的 Agent（workspace）公开 id / UUID，筛实际运行的 `workspace_id`，不读任务当前的指派。
没有匹配项（含别人的 Agent）返回空数组；无效时间 / id 返回 400；所有关联数据都限定为当前 owner。

每组含 `policyVersion`、`level`（NULL = not routed）、`provider`、`model`，以及：

| 字段 | 含义 |
|---|---|
| `sampleCount` | 匹配过滤条件且已创建工作会话的决策数 |
| `taskCount` / `completedTaskCount` / `firstPassTaskCount` | 首次工作运行的决策匹配过滤条件的任务数 / 当前 DONE 数 / 一次通过数 |
| `firstPassRate` | `firstPassTaskCount / taskCount`（0–1）；任务当前 DONE、仅有一次工作运行、运行未 FAILED 且没有验证 FAIL / 退回才算一次通过 |
| `averageFailureCount` | 每个入组任务的失败工作运行次数均值；运行 FAILED、验证 FAIL、SEND_BACK 在同一次工作运行上去重，额度失败除外 |
| `tokensPerCompletedTask` / `costUsdPerCompletedTask` | 组内 DONE 任务的全部工作运行的 token / 会话花费之和，除以 DONE 任务数；包含后续升档、换 Agent、无决策或额度失败的工作运行 |
| `durationP50Ms` | 匹配样本中已结束工作运行的耗时 p50（毫秒，偶数样本线性插值） |

没有任务级样本时，通过率与失败均值为 NULL；没有 DONE 任务时，每完成任务的 token / 花费为 NULL；
没有已结束样本时，耗时为 NULL。首次运行按 `session.created_at, id` 确定，读取全部 `starts_task_work` 历史，
不因 `since` / `agentId` 截断而重新编号；第一次运行没有决策的任务只计运行级指标。
验证 FAIL 用 verifier 的当前 `verdict` 和 `updated_at`，SEND_BACK 用 `decided_at`，归到判定时最近创建的工作运行；
同一工作运行的多个失败信号只计一次。任务当前状态与完成判据从 task 读取，不把 SUCCEEDED 会话当作 DONE 任务。

### 10.2 开启节奏

1. **影子两周**：P1 的影子接入与 P2 的建议档位都落地后开始计时。所有 Agent 默认关闭，每次新建运行都写影子决策。期间看两件事：
   建议覆盖率（有 `modelHint` 的新建运行占比，覆盖不够先让 coordinator 补建议，否则影子数据大半是"没路由"）；各档在基线
   模型上的一次通过率与 token。
2. **先在以 EXECUTABLE 为主的 Agent 上开启**：这类任务由验收命令当场判对错，档位选低了会自动失败、自动升档，不用人返工；
   以 OWNER_CONFIRMED / VERIFICATION 为主的 Agent 往后放。开关在 Agent 设置页，只有 owner 能开。
3. **对比**：开启后与同一批 Agent 的影子期按档对比。建议的默认门槛（owner 可改）：每组至少 20 个样本再下结论；同档一次
   通过率比影子期低不超过 5 个百分点；每完成一个任务的 token 明显下降 —— 不降，开启就没有意义。
4. **调整**：哪一档不达标，先改档位表（`policyVersion` + 1），不要逐个改任务的建议；新版本照样先影子、再对比。
5. **扩大与回退**：达标后再开其他 Agent。回退就是关开关：只影响之后的新建运行，在跑的运行不受影响。

## 11. 分期（P0–P5）

| 期 | 任务 | 交付 | 证明 |
|---|---|---|---|
| P0 | `34ZI8yUtHWCE4C5m5AfYj` 文档 | 契约 v1.4 + 本文 | owner 审阅 diff 后确认 |
| P1 | `34ZI8ynbaUrVlpnyLSR9R` 迁移 | §7.1–§7.3 的列和表，一个迁移一次加齐 | `task-model-routing-schema.pg.spec.ts` |
| P1 | `34ZI8yteJSJAkcosOwsFz` 路由器 | `model-routing.ts` 纯函数与默认档位表（§3–§5），不接派发 | `model-routing.spec.ts` |
| P1 | `34ZI8yv70ciW9gAQBMvSb` 影子接入 | §8.1 / §8.2、run target v2、§7.5 的接口字段；行为不变 | `task-model-routing-shadow.pg.spec.ts` |
| P1 | `34ZI8yx3vPqLKilGe29XJ` Codex token | Codex 的 turn-complete 写 `usage` 行 | `codex-usage-rows.pg.spec.ts` |
| P2 | `34ZI8yyKXdqlduWOowdIo` 建议档位 | `modelHint` 贯通 API / MCP / CLI；coordinator 开场指令要求给每个任务建议档位（§3.1） | `task-model-hint.pg.spec.ts` · runner-go parity 测试 |
| P3 | `34ZI8z3grAY01dlLX90b5` 生效 | `modelRouting` 开关（只能人改）、effort 下发（§8.3）、修 RESUME 丢模型 | `task-model-routing-apply.pg.spec.ts` |
| P3 | `34ZI8z6uKh1KsgdDco5BA` 失败升档 | 失败历史接进路由器（§3.3） | `task-model-routing-escalation.pg.spec.ts` |
| P4 | `34ZI8zEPiDbOSBJPFZRFe` Web | §9 的四处 | Web 组件测试 |
| P4 | `34ZI8zFsQpNIaGbCoAq0D` macOS / iOS | 同 Web，文案一致 | parity 测试 · Mac CI · owner 在 beta 构建上目视 |
| P5 | `34ZI8z8GyQY5Vjxh65K05` 评估报告 | §10.1 的只读接口 | `task-model-routing-report.pg.spec.ts` |
| P5 | `34ZI8zN5f9zmzzGsFUIHL` 跨引擎 | §6 | `task-model-routing-cross-provider.pg.spec.ts` |

影子期（§10.2）从 P1 影子接入与 P2 都落地开始；生效（P3）之前，影子数据就已经在攒。

## 12. 风险与开放问题

- **账号粒度的 Opus 额度**：第一版读目标 runner 默认账号的 `planUsage.claude.sevenDayOpus`。会话最终落在哪个账号（Agent 固定
  的账号、按额度自动选的账号、账号池成员）要到 create / claim 才定，可能与读到的不是同一个账号。P5 做额度过滤时再细分。
  P5 的引擎排除已按这次运行会用的账号读额度（§6）；Opus 换系（§5 第 3 条）仍读默认账号。
- **闸门按引擎、不按模型系**：`planUsageBlockedUntil` 看该引擎快照里的所有窗口；Opus 周窗口用满时，路由到 Sonnet 的运行
  也会被挡住。P5 改闸门时一并考虑要不要按模型系看窗口。P5 只改了闸门判断哪个引擎，窗口口径没动：Opus 周窗口用满时，
  路由到 Sonnet 的 claude 运行仍会被挡住，按模型系看窗口留给后续。
- **本 Agent 的引擎会漂**：它来自 `agentProviderSeed()`（最近一次人开的会话），人临时用另一个引擎开一次会话，任务运行的
  引擎也跟着变。这是今天 LEGACY 链的行为（契约 §7.2 P5 说的"位置决定引擎"），路由不放大也不修正它；要固定就在任务上
  pin provider。
- **建议的质量**：第一版完全依赖 coordinator 的判断。建议系统性偏低或偏高，会直接体现在各档的通过率与失败次数上；那时先调
  选档标准（§3.1）和 coordinator 指令，再考虑 §3.5 的补充来源。
- **跨引擎的花费不可比**（§10.1）。
