# Wiki 评论发起改动：选中 → 会话 → 合并 → 文档跟上（2026-10-09 产品方案草案）

> owner 10-09 问：在 wiki 里看到技术上想改的地方，能不能直接选中内容写评论、由此发起会话去改系统，改完之后 wiki 自己更新？
> owner 10-09 定：§11 的六条全部按推荐，第 7 条选「两边都做」；「现在差的也一起补」指 §1 那三处缺口，第三处对所有合并都补，即不经评论的合并也要让 wiki 及时跟上、看得到改了什么（§12）。
> 本文是产品方案，还没有任何实现。效果图：`docs/mocks/wiki/36-comment-to-session`（web 桌面）、
> `37-comment-to-session-phone`（web 手机 | iOS | 说明）。图里的评论、会话和改动都是**示意**：拿样稿 3.1 §3 里一句真话
> （`SESSION_RUNNER_OFFLINE_AFTER_MS = 90_000`，`src/apiserver/src/sessions/session-state.ts:18`）演一遍。

---

## 0. 一页结论

1. **今天做不到一步到位。** 三段里只有最后一段有一半：文档页不能选中、不能评论；wiki 里没有开会话的入口；改动合进 main 之后，
   wiki 要等维护到期才会重写，而且你不知道哪一节因为你的改动变了（§1）。
2. **评论挂在句子上。** 文档本来就按句存、按句带脚注（`wiki_doc_sentence` / `wiki_doc_footnote`），所以选区按句吸附，评论记下这几句。
   它们的脚注（代码 `path@sha#L`、设计文档章节、会话原话）随评论交给会话。agent 拿到的是具体的代码位置，不用先猜这句话说的是哪段代码。
3. **会话就是普通会话。** 它开在这个 space 绑定的 workspace 里，引擎和权限模式用这个 workspace 的默认值。你的评论原样作为第一条消息；
   选中的原文和出处用现有的「⊕ Orbit attached」附在后面。审批照拨盘走，**合并仍由你来按**。
4. **「改完」指改动进了 main。** 可以是会话的 Merge 合进 main，也可以是 runner 报告这场会话的分支已在 main 里（`✓ In main`）。
   这件事一发生，Orbit 就把被评论的节标为待重写，并排一个只写这几节的作业。它和生成作业一样排在后台维护前面，不等 20 个会话，
   也不等 24 小时。这次合并改到的文件如果还被别的节引用，那些节也一起重写。
5. **评论自己收尾。** 重写完，评论上出现 `Wiki updated · See changes`，可以逐句对照前后；然后评论自动转为已解决。没写成的情况分三种：
   会话没合并就结束了、重写被挡住了、重写后这几句读起来一样。每种都在评论上写明，不静默；后两种算进 Wiki 的「等你」数。
6. **不新增权限，也不新增时钟。** 评论不改文档：文档是视图，改的是 main。wiki 跟着 main 走，不再问你一次：合并就是你给的授权。
   重写只由合并这一事实触发。
7. **现在的缺口一起补**（owner 10-09）。不经评论的合并也一样：改动一进 main，受影响的节马上重写，不等阈值，追赶期也不跳过。
   任何一节被重写，都留一版旧文：文档页和 Activity 看得到改了什么、是因为哪次合并（§12）。

---

## 1. 现状：三段各有多少

| 环节 | 今天 | 差什么 |
|---|---|---|
| 选中、写评论 | 文档页只能点脚注看原文、点标记看原因（`WikiDocPage.tsx`、`WikiDocView.swift`），没有选区，也没有评论 | 全新 |
| 从 wiki 开会话 | wiki 只能跳到**已有**会话（出处、运行记录）。想改的话，得自己复制原文、到 workspace 里新建会话，再把代码位置讲一遍 | 全新 |
| 改完 wiki 跟上 | **有，但慢，也看不见**：<br>• 合并回执只计入 backlog，自己不发事件（契约 §19.1）；<br>• 维护要等到期才建运行：水位之后有 ≥20 个会话的事实，或新事实到达时最老的未处理事实已超过 24 小时；<br>• 每日次数用完就挡住；space 落后（追赶）时整步跳过文档（§19.8）；<br>• 只重写「它读的文件在 main 上变了」的节（§19.6）。改动落在这一节没引用的文件里（比如心跳间隔在 `runloop.go`，3.1 §3 只引了 `docs/architecture.md` 和 `session-state.ts`），这一处不会跟着变；<br>• 没有任何地方告诉你「因为你的改动，哪一节变成了什么」 | 一条从「这次合并」直达「这几节」的线，加上看得见的结果 |

---

## 2. 主流程（web 桌面，图 36）

1. **选中。** 在文档正文里拖选。选区按句吸附：碰到半句就算整句，吸附后的范围用浅色标出来。选区上方浮出一个按钮 `Comment`。
   - 选区可以跨段、跨节，最多 20 句。代码块按整块算。标题也能选，选中标题等于对整节评论。
   - 被撤下的句子（删除线）、No source、Not verified 的句子都能评论。对后两种，评论框里提示一句：这句没有出处或没核对上，
     可能是 wiki 写错了，而不是系统该改。
2. **评论框**（右侧边栏的弹层，不遮正文）：
   - 头：`Comment · 3.1 › §3 turn 投递与 inbox 领取 · 1 sentence`；
   - 原文：选中的句子，带脚注号；
   - `Orbit attaches`：这几句的脚注，一条一行（`docs/architecture.md § Realtime and recovery`、`session-state.ts L17–18 @ 99cd3c4`……），
     最多列 6 条，其余折成 `N more`；
   - 输入框：`What should change, and why?`；
   - `Run in`：workspace · 引擎 · 模式，三个都用 New session 同一套选择器。默认的 workspace：你最近在其中开过会话的那个绑定
     workspace → 维护用的 workspace → 第一个绑定的；
   - 按钮：`Start session`（主，⌘↩）、`Save`（只存评论，先不开会话）。
3. **Start session 之后留在文档上**（已定 1）。评论卡变成活的：`● Running · 缩短 runner 判离线时间`，带 `Open session ›`。
   右下角提示 `Session started in orbit · Open`。你可以接着读，接着评论。
4. **会话里**（图 36 ②）：
   - 第一条消息就是你的评论，原话不改；
   - 下面是 `⊕ Orbit attached: Wiki selection · 3.1 §3 · 1 sentence · 2 sources`，展开后是：原文；出处链接（代码到行，记录到那一条）；
     一句给 agent 的话：`When this session's changes reach main, Orbit rewrites this section from main. Don't edit the wiki; change the code, or the design doc the sentence cites.`；
   - 页头多一个来处标签 `From Wiki · 3.1 §3`，点了回到文档，并打开这条评论；
   - 之后和任何会话一样：agent 读代码、改代码、按模式问你；改完你在 worktree 条上按 `Merge`。
5. **合进 main 之后**，会话里出现两行 Orbit 的记录。它们只给人看，不投递给 agent：
   - `Wiki · Rewriting 3.1 §3 from main@7f3e2a1…`
   - `Wiki updated · 3.1 §3 · 1 sentence changed · also 7.1 §2 · See changes ›`
6. **回到文档**（图 36 ③）：
   - 新写的句子左侧有一道绿线，悬停写 `Updated from your comment`，看过一次后消失；
   - 评论卡显示 `✓ Wiki updated · Resolved`，`See changes` 逐句对照：删掉的划线，新写的加底色，新脚注指向 `7f3e2a1` 上的代码。

---

## 3. 评论卡的状态

评论只存它自己的事实：挂在哪几句、原文、你的话、关联的会话、重写的结果、是否已解决。显示的状态在读的时候从
评论、会话、合并和重写作业推导出来，不另存一份状态（同落地会话「活性读时推导」的做法）。

| # | 显示 | 条件 | 动作 |
|---|---|---|---|
| 1 | `Not started` | 只存了评论，没开会话 | Start session · Delete |
| 2 | `● Running` | 会话有回合在跑 | Open session |
| 3 | `Needs you`（琥珀） | 会话在等审批或提问 | Open session |
| 4 | `Not merged · 3 files changed` | 会话停着，有没合进 main 的改动 | Open session |
| 5 | `No changes` | 会话停着，什么也没改（多半是问答） | Open session · Resolve |
| 6 | `Ended without merging`（灰） | 会话结束、进了 Trash，或合进了别的分支，改动都没到 main | Start new session · Resolve |
| 7 | `Merged · Rewriting §3`（蓝） | 已进 main，重写在排队或在跑 | — |
| 8 | `Merged · Rewrite waiting: <原因>`（琥珀） | 重写作业被挡住：runner 不在线、System model 不可用、维护没配 workspace…… 原因照 Activity 的说法 | Settings（原因归你修时）|
| 9 | `✓ Wiki updated`（绿），自动 Resolved | 重写后，被评论的句子有变化 | See changes · Reopen |
| 10 | `Merged · §3 reads the same`（琥珀） | 重写成功，但被评论的句子一句没变 | See changes · Open session · Resolve |
| 11 | `Rewrite failed`（红） | 重写作业以内容失败结束 | Try again |
| — | `Outdated`（标签） | 评论还没解决，被评论的句子已经被别的重写（例如维护）换掉了 | 原文照留；其余照上表 |

- 3（Needs you）**不**算进 Wiki 的「等你」数，它已经在会话那边算了。8、10、11 算进去，理由同 §12.3.3「等你的每一件都算进 W」（已定 5）。
- 9 是唯一自动解决的情况，其余的都留着，等你按 Resolve。

---

## 4. wiki 怎么跟上

### 4.1 触发：一个事实，不是时钟

- 触发和 §12 的跟进作业是**同一个**：Orbit 记下的每个「改动进了 main」的事实都会触发跟进（§12.1）。评论只是给这次跟进多加了几节必写的节。
- 对评论来说，算数的事实是**它关联的会话，改动到了 main**：会话合并的回执（目标是 main），或 runner 报告分支已是 main 的祖先（`✓ In main`）。
  只合进项目分支、或别的分支的不算，等它晋升到 main 那一刻才算。文档读的是 origin/main。
- P2 再加一种：会话自己建出来的任务落地到 main（会话已经记录了它建了哪些任务，就是会话页那条 created-tasks strip），评论跟着那些任务走。
- 事实到达、提交之后：把被评论的节标 `stale_at`（复用 §22.6 的撤句机制，下一次写这一节不看指纹），再排跟进作业。
  平台的「时钟不得启动 agent 工作」不受影响。

### 4.2 写哪几节

- 这场会话名下所有评论挂着的节，强制重写。
- 加上**这次合并改到的文件**被别的节引用的那些节。这是 §19.6 的仓库比较，只是范围缩到这次合并改到的文件，不扫全部文档。
  这样 3.1 §3 改成 45 秒的同时，7.1 里讲心跳的那一节也跟着改，不会一处 45、一处 90。
- 一篇里有节重写，它的概述节照旧交给写法，写不写由指纹决定（§22.11 第 10 步）。
- 写法、核对、句子状态、整篇待审的规则都不变（§22.2–22.5）。服务端执行的账号走 `docs_build` 作业（§22.13），带上 `only`；
  runner 模式在维护清单里建一个只跑 `orbit wiki docs build --doc --section` 的任务。两种都排在后台维护前面。

### 4.3 多给的两样材料

只靠这一节原本读的材料，改动落在它没引用的文件里时会写回原样（§1 表里的例子）。所以重写时多给两样：

1. **这次合并改到的文件**：按 §22.11 第 2 步的切法（符号、匹配的声明、章节），读重写时的 origin/main；
2. **这场会话的三条记录**：你的评论（owner 原话）、合并前 agent 的最后一轮（它说清楚改了什么）、合并回执。

句子照旧要逐句引一手原文、逐字核对。评论本身不是出处，文档也不是（§22.8）；能引的是会话里那条 turn 和代码。

### 4.4 结果怎么判

- 拿被评论的句子在重写前后比。有一句变了（删、改、新增），就是 9：自动解决，会话里写一行 `Wiki updated`。
- 一句都没变，就是 10，留给你看：可能这次改动确实不影响这句话说的事，也可能写法没读到改动。`Open session` 问 agent 最快。
- 重写前，把被评论的节的旧句子在评论上存一份，供 `See changes` 用；只存被评论过的节。今天节是整节替换的（§22.5），不留旧文。

### 4.5 条目那边：不另做

- 锚在被改符号上的条目，下一次锚点复验会变成 `changed`，退出推送并进 Review。这条路今天就有（§17.4）。
- 会话里讲清楚的「为什么改成 45 秒」，下一次维护会从案卷里抽成 decision 条目，再按审阅模式生效。这些都不为本功能提前。

---

## 5. 手机与 iOS（图 37）

- **iOS：长按段落 → `Comment`**。正文是 SwiftUI `Text`，系统选区做不了半段选中，也加不了自定义菜单项（已定 3）。
  弹出的 sheet 上方逐行列出这一段的句子，点哪句选哪句，至少选一句；下面是输入框、`Run in` 一行和按钮。
  按钮照 §15.1 第 1 条：手机上整宽竖排，`Start session` 在上，`Save` 在下。
- **web 手机：系统选区 + 底部条。** 选中后，底部浮出 `Comment on 1 sentence`，不和系统菜单抢位置；点了出 sheet，内容同 iOS。
- **标记**：被评论的最后一句后面跟一个小气泡图标加数字（iOS 用 `text.bubble`），颜色就是状态色。点开是评论 sheet：状态行、原文、你的话、`Open session`、`See changes`。
- **See changes**：全屏 sheet，逐句对照。
- iPad 与 macOS 同 web 桌面：选区 + 边栏卡片。

---

## 6. 边界与规则

| 情况 | 怎么办 |
|---|---|
| 一篇已经有一个评论开的、还开着的会话，又写了一条 | 默认开新会话：一次改动一次合并，可以分开合。`Start session ▾` 里多一项 `Add to <会话标题>`：这条评论的话、原文和出处作为下一条消息发过去，两条评论都挂这场会话（P2，已定 2） |
| 一场会话挂了几条评论，分在几节 | 合并后一起重写。每条按自己的句子判 9 / 10 |
| 维护先把这一节重写了（会话还没合并） | 评论标 `Outdated`，原文留着，照常跟着会话。合并后照样重写这一节 |
| plan 改了，这一节没了 | 评论写 `Section no longer in the plan`。合并后不重写它，评论按 5 / 6 处理 |
| 会话 Trash 了又恢复 | 状态跟着会话走，6 会变回 2–4 |
| 会话认为不用改代码，是 wiki 写错了 | 评论卡上有 `Rewrite §3` 让你按：这一节标待重写，材料加上会话记录（4.3 第 2 条）（P2） |
| workspace 的 runner 不在线 | 和在 workspace 里新建会话一样；`Run in` 那一行写明 runner 不在线 |
| space 没绑 workspace | `Comment` 能写、能 Save；`Start session` 灰着，写 `Bind a workspace to this space in Wiki settings` |
| 分享链接的访客 | 没有 `Comment`，也看不到评论 |
| 你删了评论 | 会话不受影响，只是去掉来处标签；合并后不再为这条评论重写 |
| 评论长度 | 原文最多 1000 字，你的话最多 4000 字，一条最多 20 句。超过的提示改成对整节评论 |

---

## 7. 对照产品理念

| 理念（出处） | 这里怎么守 |
|---|---|
| 「产品理念是人驱动 agent 去做事」（owner） | 评论就是你下的目标，原话是第一条消息；agent 去做 |
| 「人只对目标、风险、预算和不可委托授权负责」（owner） | 目标：评论。风险：会话里的审批照拨盘走。不可委托：`Merge` 还是你按 |
| 「人已经授过的权，不该再问第二遍」（owner） | 合并之后，wiki 跟上不再问你；文字变了评论就自己关 |
| 「Nothing blocks in silence」（`docs/product-intro.md`） | 每个停住的地方都写在评论上（3 表的 6、8、10、11），该你处理的算进「等你」数 |
| 「时钟不得启动 agent 工作」（`open-item-escalation.service.ts:84-91`） | 重写只由「改动到了 main」这个事实触发；没合并的会话不催 |
| 文档是视图，不是知识（契约 §22.8） | 评论不改字、不当出处；改的是 main，文档从 main 重写；句子照旧逐句引一手原文 |
| agent 只能提议（设计 §0 第 3 条） | 会话里的 agent 写不了文档，也不需要写；条目照旧走 `wiki_propose` 和审阅模式 |
| 「Calm, precise, capable, and honest about boundaries」（`docs/project-maturity.md`） | 结果只分四种：变了、没变、等着、失败，各自如实说；`See changes` 逐句对照 |

---

## 8. 不做

- **不在文档上直接改字（Suggest edit）。** 文档是从 main 和记录写出来的，手改的字下一次重写就被冲掉。要改的是 main，或它引用的设计文档。
- **不自动合并。** 合并是不可委托的授权。
- **不把评论变成条目或出处。** 能当出处的是会话里那条 turn。
- **不分「Ask」「Change」两种评论。** 会话本身就能问能改；只想先问，就在 `Run in` 里选 Plan 模式。
- **不按时间催。** 没合并的会话不提醒；会话自己的 Needs you 照旧。
- **不加反向入口。** 会话里不加「评论到 wiki」，09-26 定的「会话里没有手动加条目的入口」不动。

---

## 9. 落点（实现时要动的地方，供估算）

| 层 | 文件 | 要点 |
|---|---|---|
| 契约 | `contracts/wiki.contract.json`、`docs/wiki-contract.md` 新一节 `comments` | 状态推导表、限额、文案向量；TS / Swift / Kotlin 钉回 |
| 迁移 | `wiki_doc_comment`（挂的节与句、原文、你的话、会话 id、结果、解决时间）；`wiki_doc_section_version`（节的旧版与原因，§12.2）；跟进作业的排队状态 | 迁移号照「先扫 main 和各项目分支」的规矩取；`public-id-coverage`、`db-write-inventory`、ledger 三张普查 |
| apiserver | `wiki/wiki-doc-comments.ts`（user 门：增删、开会话、解决）；会话合并回执、落地回执与 `branchMerged` 的落点挂一个 `onReachedMain`（§12.1）；节的改动读接口（§12.2） | 开会话复用 New session 的路径；投递时追加 `wiki selection` 附注（`control-plane-note`） |
| wiki 作业 | 服务端：wiki-worker 新作业 `docs_follow`，复用 `runWikiDocsBuild` 的 `only`，加额外材料。runner：新命令 `orbit wiki docs follow`（`wiki_docs_follow.go`），复用 `wiki_maintain_docs.go` 与 `wiki_docs_build.go`，由维护清单里的跟进任务跑（§11 第 7 条） | 两边的确定性部分读同一份金样；合并排队、优先级、每日节数闸；被挡的原因进 Activity |
| web | `WikiDocPage.tsx`（选区、浮钮、边栏卡、高亮、节旁 `Updated`）、新 `WikiComment*.tsx`、`lib/wikiComments.ts`、`WikiActivityPage.tsx`（Recently changed 的节行）、`Transcript.tsx` 的附注种类（`deliveredMessage.ts` 的 `describeNote`）与 Wiki 记录行、会话页头的来处标签 | `index.css` 一万多行的全局表，新类名先 grep |
| iOS | `WikiDocView.swift`（段落 `contextMenu`、评论 sheet、气泡、节旁 `Updated`）、Activity 的节行、`WikiDocLogic`（状态推导）、`WikiCopy` parity | SwiftUI 只在 CI 编 |
| Android | `wiki/WikiDocPage.kt` 同 iOS | P2 |

---

## 10. 分期

- **P1：闭环先通，缺口一起补**（owner 10-09）。
  - web 桌面 + iOS：按句评论 → 开新会话 → 卡片状态（3 表的 2–11 和 Outdated；1 随 Save 放 P2）→ 进 main 后定向重写
    （被评论的节，加上被合并文件牵到的节）→ `See changes` → 自动解决；
  - §12：任何进 main 的合并都触发跟进作业；任何一节的重写都留痕，文档页（web 各宽度）和 iOS、两端的 Activity 都看得到。
- **P2：** web 手机上的评论；`Save` 与 `Not started`；`Add to <会话>`；Activity 加一张 `Comments` 卡，列出所有没解决的评论；
  跟着会话建出的任务落地；`Rewrite §3`（wiki 写错了）；Android（评论与 §12 的留痕）；要不要也能建任务。

---

## 11. 已定（owner 2026-10-09：全部按推荐）

1. `Start session` 之后**留在文档上**：卡片变成 `● Running`，右下角提示 `Session started in orbit · Open`。
2. 已有评论开的、还开着的会话时，新评论**默认开新会话**（一次改动一次合并）；`Add to <会话>` 放在 `Start session ▾` 里，P2。
3. iOS **长按段落，在 sheet 里点选句子**；不做真选区。
4. 重写后被评论的句子有变化就**自动解决**，`Reopen` 留着。
5. 3 表的 8、10、11 **算进 Wiki 的「等你」数**。
6. 「建任务」P2 再定。

7. **跟进作业两边都做**（owner 10-09，没选推荐的「只做服务端」）。服务端执行的账号由 wiki-worker 的 `docs_follow` 作业跑；
   runner 模式的账号在维护清单里建一个跟进任务，由维护会话跑 `orbit wiki docs follow`。两边的确定性部分读同一份金样，
   包括受影响的节、材料、指纹和结果，钉成同一个答案，同 P7 的 `wiki-docs-build.fixture.json`。今天的 runner 模式马上就有跟进，不用等 P10。
   这一条是 owner 对服务端执行项目「P11 之前不改变 runner 路径的行为」那条约定开的例外。P11 删除旧路径时，Go 这份一起删。

---

## 12. 现在的缺口一起补（owner 10-09）

§1 表里的缺口，不只对评论补，对所有改动都补。

### 12.1 任何改动进 main，wiki 都马上跟上

- **触发**：Orbit 记下的每个「进 main」的事实：
  - 会话合并到 main 的回执；
  - 落地线把任务或项目合进 main 的回执（MAIN 线的任务落地、项目晋升 MERGED）；
  - 评论关联的会话被 runner 报告分支已在 main 里（`✓ In main`）。
  - Orbit 之外直接推到 main 的提交没有事实，下一次跟进或常规维护会一并带上：跟进作业总是比到运行时的 main 头。
- **作业**：每个 space 同时最多排一个跟进作业（runner 模式下是维护清单里的一个跟进任务）。排队期间再来的事实并进这一个；运行中再来的，等它结束后再排一个。
  有评论要写时优先级同生成作业（1），否则同后台维护（0）。没有事实就不排作业。
- **写哪几节**：
  - 每节按自己的 `repoSha` 和运行时的 main 比，只看改到的文件里这一节引用的那些，规则同契约 §19.6；
  - 节引用的文件没了，先撤句（§22.6）；
  - 再加上评论强制的节和它们多给的材料（§4.2、§4.3）；
  - 指纹没变的节不调模型，什么都不写。
- **不跳过**：space 在追赶时，常规维护的文档步骤照旧跳过；跟进作业照跑，它只写受影响的几节。
- **成本闸**：不带评论的节，每个 space 每天至多写 40 节（`followSectionsPerDay`，可在 Wiki 设置里改）。超出的留给常规维护，
  Activity 写明「N sections left for the next maintenance run」。带评论的节不受此限。
- **会话里也说**：一场会话直接合并到 main，跟进因此重写了节的，会话里同样出现 `Wiki updated · <节> — N sentences changed · See changes ›`，
  不论有没有评论。落地线的合并，原因记在 Activity 里，不往各任务的会话里写。
- **执行路径**：两边都做，见 §11 第 7 条。runner 模式下，跟进任务和维护任务共用维护会话的干净启动与护栏（§16.5）；
  维护任务在跑时，跟进任务排在它后面。

### 12.2 任何一节被重写，都看得到改了什么、为什么

- **留痕**：每次重写一节，都把旧句子存一版，并记下原因。重写可能来自常规维护、生成作业或跟进作业；原因可能是哪次运行、哪个合并
  （会话或任务的标题加 sha）或哪条评论。每节最多留 5 版。指纹没变、没重写的节不留。
- **文档页**：
  - 你上次打开这篇之后被重写的节，标题旁有一个带蓝点的 `Updated`，沿用 `wikiSeenKey` 的「上次来过」；
  - 点开是 See changes：一行原因（`After 缩短 runner 判离线时间 merged · 7f3e2a1 · Oct 9 10:47`），加上逐句对照，和评论卡是同一个组件；
    下面是 `Earlier changes`，最多 4 版；
  - 页头的更新行写最近一次的原因（`§3 rewritten after a merge`）。
- **Activity**：Recently changed 加一种行，`3.1 §3 rewritten · after 缩短 runner 判离线时间 merged · 1 sentence changed`，
  点开同样是 See changes；上次来之后的带蓝点，照现有规则计数。
- **iOS 同步**：节标题旁同样的 `Updated`，点开是 sheet；Activity 也是同一种行。Android 在 P2。
- 效果图：图 36 ⑥（web）、图 37 ⑤（iOS）。
