<!-- 2026-10-08 · owner 问「一个 turn 完了，能不能给用户一些建议输入的文字」，看过效果图（docs/mocks/prompt-suggestions/）后说「按照这个方案帮我实现」。 -->

# Turn 结束后的建议输入

**状态**：已实现（2026-10-08）。owner 同日按方案定了 §9 的五项，全部取推荐项；实现中要偏离本文，先改本文。
**影响面**：runner-go（Claude 适配）、shared（事件类型）、apiserver（领取载荷、账号偏好、几条读路径的排除）、web、OrbitKit + iOS/macOS、Android。

---

## 0. 结论

1. **能做，Claude 会话几乎是现成的。** Claude Code 自带 `--prompt-suggestions`：每个 turn 的 `result` 之后 1–2 秒，
   stream-json 里多一帧 `prompt_suggestion`，内容是「用户接下来大概会打的那句话」（2–12 个词，跟随用户的语言）。
   Orbit 本来就用这个模式驱动 claude，本机 2.1.293 实测可用（§1.3）。
2. **Orbit 只做三件事**：服务端决定这个会话开不开；runner 加参数，把这一帧记成一条持久化的 run event，挂在刚结束的
   turn 上；客户端把它当作空输入框的灰字，行尾一个 **Use**，点一下填进输入框（不发送）。
3. **一条，不是三条。** Claude 的提示词要的是「我正要打这句」的那一条，不给新点子，拿不准就不给。这比一排泛泛的
   选项更像「帮我少打字」，尤其在手机上。
4. **其他引擎没有原生能力**（Codex、Kimi、OpenCode、DeepSeek Harness、Antigravity）。二期可以用服务端已经在用的
   DeepSeek（会话命名用的那把 key）补齐，但要把每轮最后一条回复发给 DeepSeek；owner 定了先不做（§9-⑤）。
5. **代价**：每个合格的 turn 多一次「整段上下文的缓存读」，大约相当于 agent 多走一步，记在该会话的 Claude 账号上。
   所以只给人会来回对话的会话开，并给一个账号级开关（§5）。

---

## 1. 现状与实测

### 1.1 Orbit 今天的 turn 结束

- runner 用 `claude -p --input-format stream-json --output-format stream-json --replay-user-messages …` 驱动一个
  常驻进程（`src/runner-go/claude_spawn.go:35-44`）。每个 turn 的 `result` 帧到来时：发 `turn_end` 事件
  （`src/runner-go/session.go:2482`）→ `POST …/turn-complete`（`session.go:2493`）→ `setTurn("")`，此后到下一条
  消息之前发出的事件都是会话级的（`session.go:2517`）。
- `handleMessage`（`src/runner-go/claude.go:28`）只认 `system` / `assistant` / `user` / `stream_event`，其他类型的
  帧直接丢弃。
- 六个引擎都是先发 `turn_end`、再调 turn-complete，客户端认的「这一轮结束了」就是 `turn_end`：web 收到后
  `setIdle(true)`，收到 `user` 后 `setIdle(false)`（`src/web/src/components/WorkspaceView.tsx:4383-4398`）；Swift 端是
  `TranscriptReducer` 的 `endTurn`（`TranscriptReducer.swift:267`）。引擎自己发起的 turn（后台任务通知、定时唤醒）
  不走 turn-complete，只发一条不带 `turnId` 的 `turn_end`（`src/apiserver/src/runner-api/engine-turn.ts:37-66`）。
- 会话里配置的 DeepSeek 等自定义 ModelProvider 借的是 Claude runtime：控制面注入 `ANTHROPIC_BASE_URL` 等，让同一个
  claude CLI 去连对方的端点（`src/shared/src/events.ts:261-276`）。所以「引擎是 Claude」不等于「连的是 Anthropic」。
- run event 只有一个写入口：runner 上传的批次进 `src/apiserver/src/runner-api/runner-api.controller.ts:5700` 的
  `createMany`。seq 由 runner 编号，服务端不能自己插行（同文件 5675-5678 的注释）。
- 客户端按 per-session SSE 回放/接收 run event 渲染 transcript，类型枚举是 `src/shared/src/enums.ts` 的
  `RunEventType`。Swift 端把未知类型解码成 `.unknown`（`src/macos/OrbitKit/Sources/OrbitKit/Models/Enums.swift:259`），
  web 的 reducer 对未知类型走 default、保持原样（`enums.ts` 里 `RESYNC` 的注释）。所以新增一种事件，旧客户端
  不会出错，只是看不到。
- 仓库里没有任何「建议输入 / quick reply」的概念。最接近的是提问卡（AskUserQuestion、`ask_owner`），那是
  agent 在等一个回答，和本文的「猜下一句」不是一回事（§4.4 规定两者不同时出现）。

### 1.2 引擎能力

| 引擎 | 原生「下一句建议」 | 说明 |
| --- | --- | --- |
| Claude Code | **有**：`--prompt-suggestions` | 要求 `--print` + `--output-format stream-json`，正是 Orbit 的模式 |
| Codex 0.161 | 无 | 只有 `request_user_input` 的「建议答案」（属于提问卡）和插件推荐 |
| Kimi / OpenCode / DeepSeek Harness / Antigravity | 未见 | — |

Claude 的实现要点（读 2.1.293 内置的 JS 得到，均可在二进制里检索到原文）：

- **帧**：`{"type":"prompt_suggestion","suggestion":"…","uuid":"…","session_id":"…"}`，
  schema 描述为 *Predicted next user prompt, emitted after each turn when promptSuggestions is enabled.*
- **生成方式**：`result` 之后 fork 一次请求，沿用主循环的 cache-safe 参数（同模型、同前缀，所以命中缓存），
  禁用全部工具，不写 transcript。
- **提示词大意**：预测用户自己会打什么，而不是你觉得他该做什么；检验标准是用户会不会觉得「我正要打这句」。
  不给评价（"looks good"）、问题、Claude 口吻、用户没提过的新点子、多句话；下一步不明显就不说；涉及安全事件、
  凭据、隐私等敏感内容不说。格式是 2–12 个词，跟随用户的风格。
- **不出建议的情况**：对话里助手回复少于 2 条；上一条是 API 错误；plan 模式；有待批的权限或 elicitation；
  限流状态不允许；缓存已冷；这个 turn 不是用户发起的；生成结果没过过滤（"done"、元话语、过短、超过 12 个词
  或 100 个字符、多句、带格式、评价性……）。
- **新消息到来会取消正在生成的建议**（§1.3 实测）。
- SDK 模式下**没有**交互模式里那个「连续不用就降频」的退避，每个合格 turn 都会生成。
- 另有 `@internal` 的控制请求 `set_prompt_suggestions_paused`（给「输入框不在屏幕上」的宿主暂停生成用）。
  标了 internal，本期不用（§8 P3）。

### 1.3 实测

2026-10-08，本机 claude 2.1.293，`--model haiku`（解析为 claude-haiku-5-5），与 Orbit 相同的 stream-json 双向模式，
临时目录、`--strict-mcp-config`。脚本与原始输出不入库。

| 场景 | 结果 |
| --- | --- |
| 三轮中文对话（写一个 CSV 求平均值的脚本） | 第 1 轮无建议；第 2 轮 `用示例数据测试一下这段代码`（`result` 后 +1.68 s）；第 3 轮 `用一个含空值的示例 CSV 测试一下`（+1.20 s） |
| 抢答：每次 `result` 后 0.1 s 就发下一句 | 被抢答的那几轮没有建议帧；最后一轮 `写几个测试用例`（+1.7 s） |
| `--resume` 新进程接着聊 | 第一轮就有：`试一下这段递归代码的输出`（+0.8 s），历史轮次计入「至少 2 条助手回复」 |
| 成本（`modelUsage` 逐轮差分，开/关参数各跑 4 轮） | 稳定后每条建议 ≈ 21.2k 缓存读 + ~0.5k 未缓存输入 + ~0.15k 输出，即把整段上下文再读一遍；进程内第一条另写了 ~8.1k 缓存 |

---

## 2. 选型：建议从哪来

| 方案 | 质量 | 成本 | 覆盖 | 拖慢 turn 结束？ |
| --- | --- | --- | --- | --- |
| **A. Claude 原生** `--prompt-suggestions` | 全上下文；提示词和过滤是 Anthropic 调好的 | 每 turn 一次缓存读，记在会话的账号上 | 仅 Claude | 否，`result` 之后才生成 |
| B. 服务端 DeepSeek（命名那把 key，`src/apiserver/src/sessions/naming.ts`） | 只看这一轮的一问一答 | 很低（~3k 输入） | 全部引擎 | 否 |
| C. 让 agent 结束前调一个 MCP 工具 `suggest_next` | 全上下文，但靠模型自觉 | 与 A 同量级，另加每个会话的指令 token | 全部引擎 | **是**：多一步采样，turn 晚结束；transcript 多一行工具调用 |
| D. 固定规则（如中断后给「继续」） | 固定话术 | 0 | 全部引擎 | 否 |

**推荐 P1 只做 A。** B 作为二期可选（§8 P2、§9-⑤）。C 不做：成本不比 A 低，还让每个 turn 都晚结束。D 不单独做：
失败、限额、登录失效、中断各自已有卡片和按钮，再加一个话术胶囊是重复。

---

## 3. 数据通路

```
服务端算 promptSuggestions ──领取/重领载荷──▶ runner ──argv──▶ claude --prompt-suggestions
                                                   │
          claude stdout: result … (1–2 s) … prompt_suggestion
                                                   │
                       emitFor(刚结束的 turn, prompt_suggestion)
                                                   ▼
                  runner 事件批次 ──▶ run_event（唯一写入口）──▶ per-session SSE / 回放
                                                                         ▼
                                              客户端派生「当前建议」→ 空输入框里的灰字 + Use
```

### 3.1 服务端决定开不开

沿用领取载荷里「服务端说了算」的做法，在 agent 配置里新增 `promptSuggestions`（`AgentExecConfig`：
`src/shared/src/dto.ts`、`src/runner-go/types.go:929-933`），和 fastMode 一样是启动时读一次的设置。领取
（`src/apiserver/src/queue/queue.service.ts:951`）和重领（`runner-api.controller.ts:2706`）都按同一条规则算。
**缺省为 false**，所以旧服务端永远不会打开它。规则写在 `src/apiserver/src/common/prompt-suggestions-switch.ts`
（`claimPromptSuggestions`）：

```
promptSuggestions =
     owner.preferences.promptSuggestions !== false            // 账号开关，缺省开（§9-④）
  && session 的引擎是 Claude，且没有借用自定义 ModelProvider   // DeepSeek 等端点上未验证
  && session.runSource ∈ { MANUAL, PROJECT_COORDINATOR }      // TASK_LIST_AUTO 不开（§9-③）
  && session.spawnDepth == 0                                  // 别的会话编排出来的子会话不开
  && 不是 Wiki 维护运行
```

- 借 Claude runtime 的自定义 ModelProvider 先不开：CLI 的「缓存是否已冷」「限流状态」两项判断在别家的端点上
  怎么表现没有测过，生成请求的花费也记在那把 key 上。服务端按这次领取解析出的 env 判断：`ANTHROPIC_BASE_URL`
  为空或就是 `https://api.anthropic.com`。测过之后再放开，改的只是这一行条件。
- runner 在 spawn 时再看一遍真实生效的 `ANTHROPIC_BASE_URL`（会话 env 覆盖 runner 自身环境，同 `envWithAgent`）：
  `reload` 换供应商会带来新端点，runner 自己的环境也可能指向别处，这两样服务端都看不到。
- `User.preferences` 是 JSON，加键不需要迁移（`src/apiserver/prisma/schema.prisma:293`）。
  `SessionRunSource` 的取值见 `schema.prisma:106`。
- 开关只影响之后的 spawn。SDK 进程的选项在启动时就定了（同 fastMode，`claude_spawn.go:138-146` 的说明）；
  不做进程内热切换。

### 3.2 runner（只改 Claude 适配）

代码在 `src/runner-go/claude_prompt_suggestion.go`。

1. **argv**：`claudePromptSuggestionsOn(job)` 为真时追加 `--prompt-suggestions`（`claude_spawn.go:48-51`）。
   三个条件：载荷 `agent.promptSuggestions` 为真；引擎连的是 Anthropic（§3.1）；
   `claudeVersionAtLeast(claudeCLIVersion(), "2.1.293")`（`claude_setconfig.go:138`、`transcript_rebuild.go:703`）。
   门槛写测过的版本，不是功能起始版本，和 `claudeUltracodeFloor` 的约定一致。**版本门是必需的**：不认识这个
   参数的旧 CLI 会拒绝启动，会话直接失败。
2. **stdout 循环**（`session.go:2348`）：读到 `prompt_suggestion` 帧时，如果此刻没有在途 turn（`activeOrbitTurnID`
   为空且 `pending` 里没有已经喂给 CLI、还在等 `result` 的消息），就用
   `emitFor(lastAnsweredTurnID, evPromptSuggestion, {text, source: "engine"})` 把它记到刚结束的 turn 上；否则丢弃。
   `lastAnsweredTurnID` 在每个 `result` 处记下（`session.go:2477-2481`）：失败的 turn、引擎自己发起的 turn 记为空，
   之后来的建议一律丢弃。
   - 必须用 `emitFor`：`result` 之后 `setTurn("")`，再发的事件默认是会话级的（`session.go:2517`）。建议说的是
     「这一轮之后」，挂在那个 turn 上，客户端才能判断它是否仍然是最新的。
   - 文本 trim，超过 200 字符丢弃（CLI 自己已经拦了 ≥100 字符的）。
3. 其他引擎不动。
4. 转写重建（`transcript_rebuild.go:297` 起的类型 switch）只认 system / user / assistant / tool_use /
   tool_result，新类型天然被跳过，不会进 `--resume` 的历史。

### 3.3 事件与入库

- `RunEventType.PROMPT_SUGGESTION = 'prompt_suggestion'`，持久化。payload：`{ text: string, source: 'engine' }`
  （二期方案 B 用 `'orbit'`）。Swift 加 `case promptSuggestion`，Android 同步。
- 写入走唯一入口，写入逻辑不用改；它不在 `NON_REPLAYABLE_EVENT_TYPES` 里，所以入库、也随页面与 SSE 回放。
  读路径逐条核过：
  - `hasSessionActivity`（`src/apiserver/src/runner-api/session-activity.ts`）：**改了**，不推进 `lastTurnAt`，
    否则列表排序会被它再顶一次；
  - 会话内查找（`sessions.service.ts` 的 `e.type IN ('user', 'assistant', …)`）与全局搜索（只取 user/assistant）、
    列表预览（只取 assistant，`runner-api.controller.ts:5743`）、`engineTurnActive`（`engine-turn.ts` 的
    `GENERATING` 白名单）、控制面映射（`control-events.ts` 的 default）、推送（只看终态 `status`）：本来就是
    白名单，不用改；
  - 分享页与导出：web `Transcript.tsx`、Swift reducer、Android 读者都不为它画行。
- **为什么用 run event、不加列**：顺序天然正确（建议在 `turn_end` 之后、下一条 `user` 之前）；重连、换设备、
  重开 App 都靠现有回放拿到；不需要在每一个建 turn 的入口（owner 发送、会话间消息、watch 唤醒、待办投递、
  自动重试……）去「清空建议」；也不用迁移。代价是几个客户端各写一遍 §3.4 的派生规则，规则很短。

### 3.4 客户端的「当前建议」

transcript reducer 里加三行，按 seq 顺序回放，结果天然正确：

```
收到 prompt_suggestion  → 当前建议 = 它的 text
收到 user / turn_end    → 当前建议 = 无
本机发出一条消息        → 当前建议 = 无（不等回显）
```

- 建议总是在它那一轮的 `turn_end` 之后才到，所以「后来又有 `turn_end`」就说明有更新的一轮结束了，它已过时。
  不带 `turnId` 的 `turn_end`（引擎自发的 turn）同样清掉。
- 「其他设备发了消息」不用特别处理：那条消息的 `user` 事件到达时就清掉了。

再叠加 §4.4 的显示条件。

---

## 4. 交互

效果图：`docs/mocks/prompt-suggestions/01-board.png`（HTML 同目录）。

### 4.1 iPhone（基准）：方案甲，建议写在空输入框里

- **位置**：输入卡片里文字那一行，也就是 placeholder「Message…」的位置。有建议时 placeholder 换成建议原文，
  行尾多一个 **Use** 小胶囊。卡片高度不变（空闲 91pt），对话区一点不动。
- **样式**：建议文字用系统 placeholder 色（`.placeholderText`），单行，尾部截断；Use 高 26、tint 10% 底、tint 字，
  深色下 tint 18% 底。发送键保持灰色：空输入框不会因为有建议就能发。
- **点 Use**：把文字填进输入框，光标放在末尾，弹出键盘；**不发送**。可以接着改，也可以直接点发送。
- **消失**：输入框一有字就不显示，删空后如果它仍是当前建议就回来，和 placeholder 一个规矩；发出任何消息后作废。
- **不加关闭按钮**：它不挡东西，下一条消息发出去自然就没了；想彻底不要，去设置里关。
- 实现：`ComposerView.offeredSuggestion`（`ComposerView.swift:202`）把 transcript 的 `promptSuggestion` 交给
  `ComposerLogic.offeredPromptSuggestion`（OrbitKit）判断；有建议时 placeholder 让空，`PromptSuggestionLine`
  （`ComposerView.swift:1323`）叠在输入框第一行上：灰字单行截断，只有 Use 接收点按，其余点按落进输入框。
  Use 走现成的 `console.composerText` + `requestFocus()`，不新开发送路径。

### 4.2 方案乙（备选）与为什么不选丙

- **乙：输入卡片上方的单行胶囊**，放在 `ComposerView` 里 reply 条那一层（`ComposerView.swift:273-284`）。
  更显眼，但多占 36pt；它在停车条（Background、建过的任务、分支条）下面，和它回应的那句话隔着这些卡片；
  `docs/mocks/parking-strip-in-composer-ios.html` 那版草案正想把 iPhone 输入框上方的东西减掉。
- **丙：对话末尾一个虚线「幽灵气泡」**。建议比 `turn_end` 晚 1–2 秒，那时在末尾插一行，正在读的内容会被往上顶；
  虚线气泡也容易被看成已经发出的消息。不选。

### 4.3 Web、macOS、iPad、Android

- **Web**：同甲。判断在 `src/web/src/lib/promptSuggestion.ts`（`currentPromptSuggestion` + `offeredPromptSuggestion`），
  会话页在 `composerPlaceholder` 旁边算出 `offeredSuggestion`（`WorkspaceView.tsx:8867`）。有建议时 textarea 的
  placeholder 让空，`.composer-suggestion` 叠在 `.composer-field` 第一行上：灰字单行截断，行尾 Use 胶囊带 `Tab`
  键帽（触屏设备不显示键帽）。Trash、Runner offline、正在回复某条这些状态本来就不提供建议，它们的 placeholder 照旧。
- **Tab**：输入框为空、`/ # @` 菜单没开时，Tab 填入建议。菜单开着时 Tab 仍是选菜单项，这是现有逻辑
  （`WorkspaceView.tsx:10592`），不变；没有建议时 Tab 也不变。Claude Code CLI 本身就是 Tab 接受建议。
- **macOS / iPad**：和 iPhone 是同一个 SwiftUI `ComposerView`；macOS 的 `TextField` 另接 `.onKeyPress(keys: [.tab])`，
  Use 胶囊里多一个 `⇥`。
- **Android**：`SessionComposer.kt` 的 `OutlinedTextField` 用 placeholder（单行截断）+ trailingIcon 的 Use 按钮；
  推导在 core 的 `Transcript.promptSuggestion`，判断在 `ComposerData.kt` 的 `offeredPromptSuggestion`。

### 4.4 显示规则

全部满足才显示：

| # | 条件 | 说明 |
| --- | --- | --- |
| 1 | 有当前建议（§3.4） | — |
| 2 | 会话在 Open，且 `capabilities.canSend` | Completed、Trash、无法发送时不显示 |
| 3 | 没有在跑或排队的 turn | 运行中只有「停止」，不猜下一句 |
| 4 | 没有待处理的审批卡或提问卡（权限审批、AskUserQuestion、`ask_owner`、等你确认完成…） | 这时该回答问题；两种入口同时出现会抢注意力。用会话摘要里现成的 `pendingApprovals == 0` 且 `waitingKind` 为空判断（`src/shared/src/realtime.ts:187-194`） |
| 5 | 输入框为空、没有暂存附件、不在回复某条消息 | 用户已经在写自己的话 |
| 6 | 刚结束的 turn 没有失败（API 错误、登录失效、限额） | CLI 对 API 错误本身就不出；Orbit 把登录失效也算失败，客户端再兜一层 |

---

## 5. 成本与开关

- **量**：每个合格 turn 多一次请求，内容是整段上下文的缓存读 + ~0.5k 未缓存输入 + ~0.15k 输出（§1.3）。
  多步的 agent turn（几十次工具调用）只多几个百分点；一问一答的短 turn，输入侧接近翻倍。
- **记在谁头上**：该会话所用的 Claude 账号（订阅额度或 API key）。这次请求的花费会进 CLI 的累计
  `total_cost_usd` 和 `modelUsage`，在 Orbit 里表现为下一个 turn 报上来的数字大一点。
- **控制**：账号级开关 `preferences.promptSuggestions`（设置页一项，缺省开）；只开 Claude 引擎；任务列表自动跑的
  会话和 Wiki 维护不开。
- **先不做**「连续不用就降频」。CLI 在 SDK 模式下没有这个退避，Orbit 也先不做；上线后看采纳率再定。
  采纳率不需要新字段：建议文本和下一条 user turn 的内容都已入库，事后用 SQL 对比即可。

---

## 6. 边界与竞态

1. **第一轮不出**：CLI 要求至少两条助手回复。新会话第一个 turn 结束后看不到建议，这是正常的。
2. **抢答**：生成中用户又发了消息，CLI 会取消（已实测）；万一帧晚到，runner 发现有在途 turn 就丢；
   客户端收到那条消息的 `user` 事件也会清掉（§3.4）。
3. **引擎自发的 turn**（后台任务通知、定时唤醒）：CLI 不为它生成建议（不是用户发起的）；它的 `turn_end`
   不带 `turnId`，照样把旧建议清掉。
4. **多设备**：一台设备发了消息，`user` 事件到达其他设备时建议就消失。
5. **重开 App、换设备、断线重连**：建议是持久化事件，回放即得。
6. **进程重启、换 runner**：CLI 不会补发旧建议；已经入库的那条仍然有效。
7. **协调会话**：很多「用户消息」其实是平台投递的（watch 唤醒、待办投递、任务结果），CLI 会把它们当成用户
   说的话来学风格，预测可能偏。先开着观察；效果不好，服务端把 `PROJECT_COORDINATOR` 从 §3.1 的条件里去掉即可，
   一行改动。
8. **plan 模式、待批权限**：CLI 本身不出。
9. **敏感内容**：CLI 提示词要求涉及安全、凭据、隐私时不出建议。
10. **滚动升级**：旧客户端看不到，不受影响；旧 runner 不认识这个载荷字段，不开；旧 CLI 被版本门挡住。
11. **发送时不带「来自建议」标记**。点了 Use 之后改没改、改了多少都无所谓，发出去的就是用户自己的话。

---

## 7. 改动清单

| 层 | 文件 | 改动 |
| --- | --- | --- |
| shared | `enums.ts`、`dto.ts` | `RunEventType.PROMPT_SUGGESTION`；`AgentExecConfig.promptSuggestions` |
| runner-go | `claude_prompt_suggestion.go`（新）、`claude_spawn.go`、`session.go`、`types.go` | 版本门 + 端点检查后加参数；处理建议帧；`evPromptSuggestion`；`AgentExecConfig.PromptSuggestions` |
| runner-go | `claude_prompt_suggestion_test.go`（新）、`fake_claude_test.go` | argv 开关、端点、帧解析；假 CLI 吐建议帧，跑真会话循环（正常、下一条已在途、失败与自发 turn） |
| apiserver | `common/prompt-suggestions-switch.ts`（新）、`queue/queue.service.ts`、`runner-api/runner-api.controller.ts` | §3.1 的规则；领取与重领的 agent 配置 |
| apiserver | `users/dto.ts`、`users/users.controller.ts` | 账号偏好 `promptSuggestions` |
| apiserver | `runner-api/session-activity.ts` 及 spec、`common/prompt-suggestions-switch.spec.ts`（新） | 不推进 `lastTurnAt`；规则单测 |
| web | `lib/promptSuggestion.ts`（新）、`components/WorkspaceView.tsx`、`index.css`、`lib/queries.ts`、`pages/SettingsPage.tsx` | 推导与判断；灰字 + Use + Tab；设置页开关 |
| web | `lib/promptSuggestion.test.ts`、`components/WorkspaceView.promptSuggestion.test.tsx`（新） | 推导与判断；会话页出现、Use、Tab、打字让位、新消息作废、卡片在等时不出 |
| OrbitKit | `Models/Enums.swift`、`Transcript/TranscriptReducer.swift`、`App/Composer.swift`、`Models/Preferences.swift`、`App/SettingsHome.swift` | 新事件类型；`TranscriptState.promptSuggestion`（快照兼容）；`ComposerLogic.offeredPromptSuggestion`；偏好与设置行 |
| OrbitKit | `PromptSuggestionTests.swift`（新）、`SettingsHomeTests.swift`、`SettingsStackWiringTests.swift` | reducer、判断、偏好、ComposerView 接线；设置行 |
| OrbitApp | `Views/ComposerView.swift`、`Views/SettingsSheet.swift`、`Views/SettingsAdminView.swift` | 灰字 + Use；macOS Tab；iOS 与 macOS 设置开关 |
| Android | core `Transcript.kt`、app `ComposerData.kt`、`SessionComposer.kt`、`SettingsScreen.kt` + `ic_suggestion.xml`，及两个新测试 | 推导；判断；placeholder + Use；设置开关 |

---

## 8. 分期与验收

- **本次（P1a + P1b + P1c，一起落）**：runner、shared、apiserver、web、iOS/macOS、Android 全部按上文实现。
  验收见交付说明：每层的单测与组件测试，以及把关键判断临时去掉后对应测试变红的反向验证。
- **上线后要看的**：真实 Claude 会话里 `turn_end` 之后 1–2 s 入库一条 `prompt_suggestion`；采纳率（建议文本与下一条
  user turn 的内容对比，SQL 即可）；Claude 账号额度的变化。
- **P2（可选，非 Claude 引擎）**：turn 结束后，runner 请求服务端 `POST /runner/sessions/:id/turns/:turnId/suggestion`。
  服务端用 DeepSeek 生成，输入只有这一轮：owner 消息 ≤600 字、最后一条助手回复 ≤2000 字。照 `naming.ts` 的做法：
  不在热路径上、永不抛错、有并发上限。结果交回 runner，runner 照样发 `prompt_suggestion`（`source: 'orbit'`）。
  seq 仍由 runner 编号，客户端零改动。
- **P3（可选）**：没人看着的会话暂停生成（`set_prompt_suggestions_paused`，等 CLI 去掉 internal 标记再用）；
  推送通知带上建议，作为快捷回复。

---

## 9. 决定（owner，2026-10-08：按推荐项）

| # | 问题 | 定了 | 没选的 |
| --- | --- | --- | --- |
| ① | 放在哪 | **甲：空输入框里的灰字 + Use**（web/macOS 加 Tab） | 乙：输入卡片上方的胶囊（多占 36pt） |
| ② | 点 Use 之后 | **只填进输入框**，再点发送 | 直接发送（「提交」「推送」这类建议一碰就执行） |
| ③ | 哪些会话生成 | **手动会话 + 协调会话** | 只手动会话；也包括任务列表自动跑的会话 |
| ④ | 缺省开还是关 | **开**，设置里可关 | 关 |
| ⑤ | 非 Claude 引擎 | **先不做** | 二期用 DeepSeek 补齐（每轮最后一条回复会发给 DeepSeek） |
