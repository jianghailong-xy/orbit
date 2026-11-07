# Wiki 聊天窗口：边聊边改（2026-11-06 产品方案）

> owner 11-06 问：wiki 页面上要有一个聊天窗口，用来边聊天边修改 wiki。
> owner 11-06 定：入口是右下角的圆形悬浮按钮；五条按推荐；orbit 这个 space 默认用 `orbit-develop`（HPC）；定向重写只绕开不写文档的作业（§8.5）。全部见 §12。
> 本文是产品方案，还没有任何实现。效果图：`docs/mocks/wiki/42-wiki-chat`（图里的对话、条目和合并都是示意）。
> 它取代 `docs/wiki-comment-to-session-design.md` 的入口部分（§2、§3、§5、§11.1–§11.5），留用那份的 §12（任何改动进 main 都跟上、任何重写都留版），去掉其中的 runner 路径（§11.7）：P11（2026-10-19）已经删了 runner 上写文档的路径。

---

## 0. 一页结论

1. **聊天就是一场普通会话，停靠在 wiki 页面里。** 不另造模型循环和对话存储。工具、审批、权限模式、费用、会话列表、手机端都沿用。
2. **聊天不改文档的字，改字的来源。** 文档是服务端从代码和记录生成的，手改的字下次重写就没了。所以每句要求落到重写后还在的地方：条目、这一节的重写、plan，或者 main（§6）。
3. **agent 只起草，你按 Apply 才写。** 草稿不进 Review，不走机器核实，不占待审名额。按下等于 Review 的 Accept：trust = confirmed（§7）。
4. **按下之后，条目立刻生效，受影响的节定向重写。** 不等维护的 20 个会话或 24 小时。写完能逐句看改了什么，也能撤销。同一 space 正在跑的 articles、verify、import 不挡它；有写文档的作业在跑时要等它结束，卡上写明（§8）。
5. **入口是右下角的圆形悬浮按钮。** 聊天收起后不结束，按钮带状态（§3）。
6. **上下文都看得见。** 当前页和选中的句子显示在输入框里，可以叉掉，没显示的不发（§4）。
7. **跑在 workspace 所在的 runner 上，用独立 worktree，起点是 `origin/main`。** workspace 每个 space 选一次，之后记住，不自动换机器（§5）。

---

## 1. 现状

| 环节 | 今天 | 差什么 |
|---|---|---|
| 文档 | 只有服务端的 `docs_build` 与 `maintain` 作业能写（契约 `docs.who`），user 门只有 3 个读路由（`wiki-docs.controller.ts`）。整节替换，不留旧文（§22.5） | 留版；单节重写的入口 |
| 条目 | owner 有表单（`WikiEntryDrawer.tsx`、`WikiNewEntry.tsx`），agent 走 `wiki_propose`。11-02 的数据：owner 的 3 个 space 里 28,489 条有效条目，经人确认的 142 条，owner 亲手写的 0 条 | 一条比表单省事的路 |
| plan | owner 能编辑、确认、重建（`wiki-plan.controller.ts`）。会话读不了也写不了（契约 `plan.who`） | 从聊天发起的路 |
| 会话 | 能读条目，读不到文档和 plan（契约 §22.8），也不知道你在看哪一页 | 把页面带给它 |
| 选区、开会话 | 文档页没有选区。[评论项目](orbit-project:34cbCXaNMJIHWoigS7XWd) 10-09 建好，到今天 `startedAt` 还是空，10 个任务全 OPEN | 由本方案接手 |
| 单节重写 | `runWikiDocsBuild` 进程里有 `only`（`wiki-docs-build.ts`），但 build 路由按整个 plan 版本，`docs_follow` 还不存在 | 作业和入口 |

---

## 2. 主流程（web 桌面，图 42 ⓪–③）

1. 右下角圆按钮打开面板。面板停靠在右边，挤开正文。
2. 拖选一句，选区按句吸附（规则照 10-09 的设计 §2），浮出 `Ask`。按了把这几句放进输入框，不弹窗。
3. 你说话。你的话原样成为消息，附件单独存。
4. agent 查代码和条目，先判断这话该落在哪一层（§6），再起草。
5. 聊天里出现一张改动卡，左边正文标出会牵动的节。不满意就接着说，新卡替换旧卡。
6. 按 `Apply`。条目立刻生效，卡变成 `Applied`，这几节开始重写。
7. 写完，左边新句有绿线，节旁 `Updated`；聊天里 `Wiki updated`，`See changes` 逐句对照。
8. 不想要了按 `Undo`。

只想问问题时，agent 带引用地回答，没有卡，什么都不变。设计 §1.1 的实测是 owner 的问句以诊断和现行逻辑居多，所以问答多半是这个窗口最常见的用法。回答里的 `orbit-wiki` 链接和节号在左边打开，不离开聊天。

---

## 3. 入口：右下角的圆形悬浮按钮（owner 11-06 定）

- 窗口右下角，只有图标，悬停写 `Chat`。页头不放 Chat，其余按钮不动。
- 尺寸：桌面 52、距边 24；手机 56、距边 16 加安全区。品牌蓝。
- 点开时：继续这个 space 最近还开着的一场，没有就新开。面板或 sheet 打开时按钮藏起来，关掉回到原处。
- Wiki 各页都有，Settings 和分享链接没有。固定在窗口上，不随正文滚动。
- 右下角今天是空的：Toast 在右上角（`.toast-viewport`），手机 web 没有底部导航，wiki 页没有底部操作条。要让的两处：正文底部多留 88 的空白；条目抽屉也贴右边（`.wk-drawer`，`z-index: 5`），按钮浮在它上面。

| 状态 | 样子 | 悬停文案 | 条件 |
|---|---|---|---|
| 平时 | 图标 | `Chat` | 没有进行中的事 |
| 在忙 | 外面转一圈 | `Working…` | 这场聊天有回合在跑，或文档在重写 |
| 等你 | 琥珀数字 | `N needs you` | 草稿没处理、有审批，或重写被挡住、失败、读起来一样 |
| 写完 | 绿色对勾 | `Wiki updated` | 重写完了，打开看过就消失 |

状态在读的时候从会话、草稿和作业推导，不另存一份（同落地会话「活性读时推导」）。点开直接滚到要看的那张卡。

---

## 4. 面板与上下文

### 4.1 面板

- **头：** 标题（点开是这个 space 的聊天历史）、`+` 新开、`↗` 换成完整会话页、`✕` 收起。标题下一行字写 `workspace · 机器 · 引擎 · 模式`，一直看得见在哪跑。
- **地址：** 带 `?chat=<session>`，翻页不关，刷新还在。
- **输入框：** 精简版：文字、附件、发送、Stop。别的（`#` 引用、模型切换、斜杠命令）交给 `↗`。
- **聊天的归属：** 一场聊天属于一个 space，换 space 看到的是那个 space 的聊天。它也在 workspace 的会话列表里，页头有来处标签 `From Wiki`。

| 窗口宽 | 面板 | 目录栏 |
|---|---|---|
| ≥ 1440 | 右侧停靠，默认 400，可拖 320–560 | 照旧 |
| 1200–1439 | 右侧停靠 | 收进现有的 Contents 抽屉 |
| 640–1199 | 从右滑出，盖住正文右侧，不加遮罩 | Contents 抽屉 |
| < 640 | 底部 sheet，半屏与全屏两档 | Contents 抽屉 |

条目抽屉开在面板左边。这组数按真页面校准。

### 4.2 附件

- **当前页：** 自动跟着你走，发送时定格。文档页带篇和节（按滚动位置取最近的节标题），条目抽屉带条目，plan 页带篇。
- **引用：** 选中的句子，带脚注的代码位置、记录和经由的条目。最多 20 句。
- **都能叉掉，没显示的不发。** 发出后气泡下面是 `⊕ Orbit attached: Wiki selection · 3.1 §3 · 1 sentence · 2 sources`，展开看全文。
- **在服务端展开。** 客户端只发 `{ docSlug, sectionKey, sentenceIds }`，投递时服务端读当时的句子和脚注，走现有的附注机制（`control-plane-note.ts`、`deliveredMessage.ts` 的 `describeNote`）。`conversation_turn.content` 仍然只有你的话，所以这句话能被当一手出处（契约 `tiered.auto.ownerWords` 要求 owner 经 user 门发、带 UUID 的 client turn id）。
- **不加读文档的工具。** 契约 §22.8「没有读写文档的 MCP 工具」不动：屏幕上有的，附注带过去；plan 同样由页面带。
- 这一场的第一条消息多一段给 agent 的话（`<orbit_wiki_chat>`）：你在 wiki 页旁边聊天；先判断该改哪一层；条目改动用 `wiki_propose`，重写和 plan 用 `wiki_draft`，都只是草稿；不要改文档。

---

## 5. 跑在哪

| 环节 | 在哪里 |
|---|---|
| 聊天、读代码、改代码 | 选定 workspace 所在的 runner |
| 存草稿、记录按压、写条目 | apiserver |
| 重写文档 | wiki-worker，用 System model；读仓库时发给**维护 workspace** 的 runner（可以和聊天不是同一台） |

### 5.1 选哪个 workspace

- 同仓库的 workspace 都算绑定，除非 owner 在 Wiki 设置里把它留在外面（设计 §2.1）。orbit 仓库今天有 5 个，分布在 4 台机器上，其中 `orbit-prod`、`orbit-prod-fcm` 在 wikova，后者的说明写着改生产 `.env`。
- 图 36 的默认（最近开过会话的）可能把聊天带到生产机上，所以不用。
- **每个 space 第一次聊天时选一次，存进 `space.settings.chat.workspaceId`，之后记住。** `Runs in` 里可以换。
- **只列开了 worktree 的。** 一个都没有时，面板写 `Turn on worktrees for a workspace in this repository to chat here`。
- 机器离线时面板写明，wiki 照常读，不自动换机器。
- orbit 这个 space 默认 `orbit-develop`（HPC，owner 11-06 定）：worktree 已开，Claude 的登录只有这台上有，也不是生产机。

### 5.2 用什么代码

文档读 `origin/main`。普通会话的 worktree 从 workDir 当前的 HEAD 分出（`worktree.go`），没开 worktree 的直接跑在共享目录。11-06 实测：写这份方案的会话开出时的提交比 main 落后 5 个，`/root/orbit` 落后 1 个。这样 agent 可能对着旧代码说「文档写错了」。

- **聊天的 SOURCE 是 `origin/main`：** 建会话时冻结选择器（ref + `REMOTE`），首次领取时冻结提交，走项目任务已有的 SOURCE 机制（`docs/project-source-contract.md`、`projects/session-source.ts`、runner 的 `needsSourcePin`）。runner 一侧按会话判断；服务端怎么给非任务会话选源，由实现任务核对，契约 SR1 只规定了项目任务，要补一条。
- **聊久了 main 会走。** 每条附注带这一节的 `repoSha`，agent 自己比较，需要时读 `origin/main`。
- **聊完没有提交，就删掉这场的分支。** §13.8 的 `noWorktree` 说过同样的顾虑：没改代码的对话留下一个未合并的分支，读起来像被放弃的工作。要改 runner，需要发版。

### 5.3 不选的路

服务端 System model 跑聊天：不靠 runner、不花额度，但要新写模型循环、工具调用和对话存储，读不了 checkout，也改不了代码。设计 §8.2 也明确 wiki-worker 里没有 agent 回合。

---

## 6. 四种去处

| 你说 | 其实要改的 | 落到 | 卡 | 门 |
|---|---|---|---|---|
| 「这句的原因写错了」「这个坑修好了」 | 知识 | 条目 | `Add / Amend / Supersede / Retire` | 现有写入口，经草稿 |
| 「这个数早就变了」 | 文档落后于 main | 重写这一节 | `Rewrite from main` | 新：按下排 `docs_follow` |
| 「这篇太长，拆开」「写给新人看」 | 结构和写法 | plan（写法要求落在节的 `covers` 上，指纹包含它，下次重写还在） | `Plan change`：一张卡可改几篇，拆一篇就是一张卡（移一节到新开的一篇），卡面先写移节、再逐篇写改动（图 42 ③） | 现有 `plan/edits`、`confirm`、`build`，一按三步；几篇的改动合成一次 plan 编辑，对改完的整份 plan 过一次闸，任何一篇过不了就什么都不写、卡上列出全部错误。Undo 把 plan 和那次重建写过的节放回去（§7.2） |
| 「这里应该改成 45 秒」 | 系统本身 | 代码或它引用的设计文档 | 没有卡，是会话的改动条 | 审批照拨盘走，Merge 你按，进 main 后 §8.1 跟上 |

agent 判断错了怎么办：你接着说，或者按 Discard。卡上写明落在哪一层，这个判断是看得见的。

---

## 7. 改动卡

### 7.1 草稿

- 一场聊天是带 `wiki_chat_space_id` 的会话。这样的会话调 `wiki_propose`，**所有 op 都先成草稿**（包括平时自动生效的 `reinforce`、`challenge`，和 `wiki_note` 的 `corrects`）：照常跑校验（schema、出处、引文、脱敏、CAS、污染标记），不写条目，回答 `status: "draft"`。这样「不按就不变」才是真话。不带 `corrects` 的 `wiki_note` 不变，它本来就只是留给维护的线索。
- 重写和 plan 用新工具 `wiki_draft`，只对聊天会话开放，别的会话调用被拒。需要 runner 发版。它不接受、不确认，也不是页面覆写，契约 `agentSurface.notTools` 不破。
- 草稿存自己的表（`wiki_chat_draft`），不进 `wiki_changeset`，所以不占 `pendingOpsPerSpace` 的 30 个名额，也不留 `proposed` 的条目。
- 卡从工具结果里的 `draftId` 画，状态读服务端，不解析对话文字。任何引擎都一样，完整会话页和手机上画的是同一张卡。
- 案卷跳过聊天里的草稿调用（同 `wiki-dossier.ts` 跳过读 wiki）。否则被你 Discard 的草稿，下一次维护可能又读回来。你的原话照常进案卷。

### 7.2 按压

| 动作 | 门 | 结果 |
|---|---|---|
| `Apply` | `POST /api/wiki/chat-drafts/:id/apply`，只认 JWT，带会话头拒 `WIKI_OWNER_CHANNEL_ONLY` | 同一个事务里记变更集（origin agent，会话是这场聊天）并接受：trust = confirmed，不走核实。原则类是你自己的写入：trust = owner。然后排 §8 的重写 |
| `Edit` | 同一道门 | 同 Review 的 Edit：记 edited，修订作者是你 |
| `Discard` | 同一道门 | 只标记草稿。不记 Not true，不留反例 |
| `Undo` | 现有 `changesets/:id/revert`，加恢复节的旧版 | 整次撤回，节恢复到 Apply 之前那一版。plan 卡（owner 11-07 定）：plan 回到这张卡按之前的内容，作为你的新版本存下并确认；那次重建改写或拿掉的节恢复到重建前留下的那一版，不调模型，留一版原因 `restore`；plan 在这张卡之后又动过时不可撤 |

- **一张卡一按。** 一张卡可以有几个 op，一起生效。
- **agent 下一轮知道结果。** Applied、Discarded、Undone 随下一条消息作为附注送达，不单独开回合。
- **安全底线不动。** `decide` 仍然只在 owner 门上；agent 仍然没有接受、确认的工具。

### 7.3 卡的状态

| 显示 | 条件 | 动作 |
|---|---|---|
| `Draft · <种类>` | 刚起草 | Apply · Edit · Discard |
| `Replaced` | 这场聊天里有新草稿替换了它 | — |
| `Changed since this draft` | 条目的 `baseRevision` 或节的版本变了 | Redo（发一句话让 agent 重起草） |
| `Based on web content`（标签） | 这场聊天读过网页（污染标记照旧） | 照上 |
| `Applied · Confirmed by you` | 已按 | Undo · Open entry |
| `Discarded` | 已弃 | — |
| `Not applied` | 聊天结束了，草稿没处理 | — |
| `Undone` | 已按，又按了 Undo | — |

plan 卡（§6 第三行，一张卡可改几篇）：

| 显示 | 条件 | 动作 |
|---|---|---|
| `Draft · Plan change` | 刚起草；卡面先写移节（`3.1 §3 … → new document 3.5`），再逐篇写改动和新的 covers，Rewrites 每篇一个（图 42 ③） | Apply & rebuild · Open in Plan · Discard |
| `Changed since this draft` | plan 在起草之后又存过版本（草稿或确认版） | Redo · Discard |
| `Applied · Confirmed by you` | 已按，plan 还停在这张卡按出的版本 | Undo · Open in Plan |
| `Applied · Confirmed by you`，下一行 `The plan has changed since, so this can no longer be undone.` | 已按，plan 之后又动过 | Open in Plan |
| `Undone` | 已撤：plan 回到按之前的内容（新的一版，已确认），重建写过的节放回去 | — |

重写的进展接在卡下面，见 §8.3。

---

## 8. 定向重写与跟进

### 8.1 一个作业，两种触发

沿用 10-09 §12 的 `docs_follow`，只跑 wiki-worker：

- **聊天按压：** 卡上列的节强制重写（写 `stale_at`，不看指纹），优先级 1。
- **改动进 main：** 会话合并回执、落地线进 main 的回执。只写引用了被改文件的节，指纹没变不调模型，追赶期照跑，每个 space 每天至多 40 节（`followSectionsPerDay`），超出的留给常规维护，Activity 写明。优先级 0；这场合并来自聊天时是 1。
- 每个 space 最多排一个，排队中再来的并进去。重写只由这两个事实触发，不加时钟。

### 8.2 写哪几节、多给什么

**卡上的 `Rewrites`** 在起草时算好：附件里的节；经由这条条目的句子所在的节（脚注的 `via_entry_id`）；新条目按 `sectionFit` 排名靠前的节。一张卡至多 5 节。

**强制的节多给两样材料**，否则新条目可能被 `entriesPerSection` 的上限挤掉，写回原样：这次改动的条目（及其出处）、这场聊天里你的原话。句子照旧逐句引一手原文、逐字核对；你的 turn 是能引的，文档和评论不是（§22.8）。

### 8.3 结果

| 显示 | 条件 | 算进 Wiki「等你」 |
|---|---|---|
| `Rewriting 3.1 §3…` | 排队或在跑 | 否 |
| `Rewrite waiting · <原因>` | 有写文档的作业在跑、runner 离线、System model 不可用、维护没配 workspace | 是 |
| `Wiki updated · N sentences · See changes` | 句子变了 | 否 |
| `§3 reads the same` | 写完一句没变 | 是 |
| `Rewrite failed · Try again` | 模型失败或核对不过 | 是 |

### 8.4 留版

任何来源的重写（维护、生成、跟进）都留一版旧句子和原因，每节至多 5 版，指纹没变不留（10-09 §12.2 原样）。`See changes` 逐句对照；节旁 `Updated`；Activity 的 Recently changed 加 Docs 行；原因可以是「After chat <标题>」。

`Undo` 恢复的是这张卡触发的那一版之前的句子。恢复后这节按原指纹算，不会被下一次维护无故重写。

### 8.5 和「一个 space 只跑一个作业」的冲突（owner 11-06 定）

契约 `jobs.onePerSpace`：同一 space 同时只跑一个作业，running 的作业不会被打断，优先级只决定排队中谁先走。`jobs.priority` 记过 canary 上一个 articles 作业跑了一个半小时以上（673 次调用），后面的作业等了 1 小时 47 分。生产上 orbit space 两周的模型请求 81% 是 articles（11-04 的数据）。

也就是说，**不改这条的话，按了 Apply 可能要等很久才看到新句子**，正好打在这个功能最要紧的地方。模型请求队列不是问题：优先级 1 排在维护前面（`modelQueue.priority`）。

**定下的做法：`docs_follow` 只绕开不写文档的作业。**

- 它可以和同 space 正在跑的 `articles`、`verify`、`import`、`smoke` 同时跑。这些作业不写 `wiki_doc_*`：articles 写的是按主题的旧文章（§18）。
- 遇到 `maintain`、`docs_build`、`plan_draft`、`plan_revise` 和另一个 `docs_follow` 照等，卡上写 `Rewrite waiting · Maintenance is running`。
- 要改的是契约 `jobs.onePerSpace` 这一条和它的部分唯一索引：`state = 'running'` 的唯一性只在写文档的这一组作业里算。领取作业时，同样按这一组判断这个 space 是否空闲。
- `verify` 的结论会撤句、给节写 `stale_at`（§22.6），写在条目自己的事务里，和文档写入的锁序一致（先条目、后文档），所以并行不会死锁成环。实现任务要用 pg spec 证明这一点。
- 留下的代价：维护正在写文档时按下的，仍可能等很久。等多久由「还没量的」第 2 项给出数，到时再看要不要让维护在节与节之间让一次。

---

## 9. 手机与 iOS（图 42 ⑤）

- **入口：** 右下角圆按钮；长按段落多一项 `Ask`，点选句子照 10-09 §5 的 sheet，选完进输入框。
- **半屏档：** sheet 下面的正文不变灰、还能滚（`presentationBackgroundInteraction`，部署目标 iOS 17 够用）。
- **全屏档：** 看卡。按钮整宽竖排，`Apply` 在上。
- **收起：** 聊天不结束，按钮带状态，重写完左边浮一条结果。
- **iPad 与 macOS：** 第三栏（设计 §12.3.5）。
- web 手机同样两档。Android 不在这一期，但新附注和新卡不能让它崩或数错（未知附注画成通用的 Orbit attached，工具结果按普通工具画）。

---

## 10. 边界

| 情况 | 怎么办 |
|---|---|
| space 没有开了 worktree 的 workspace | 按钮照常在，面板写明怎么办（§5.1） |
| 选定的 workspace 被删或留在外面 | 下次打开让你重选 |
| 分享链接的访客 | 没有按钮，也看不到聊天 |
| 你的话被引成脚注 | 开了 Footnotes 的分享链接，访客读得到这句引文（`share-links/public-wiki.ts`）。卡的 Sources 上写明 |
| 维护先把这一节重写了 | 引用标 `Outdated`，原文留着；草稿按 §7.3 |
| plan 改了，这一节没了 | 卡写 `Section no longer in the plan`，不重写 |
| 会话 Trash | 聊天从历史里消失，已 Apply 的不受影响，没处理的草稿成 `Not applied` |
| 配额、槽位 | 同普通会话：`Waiting for slot` 等照旧显示 |
| 重复条目 | 语义检索没开，agent 判断「库里有没有」可能不准（11-06 搜 `wiki chat` 返回 10 条，没一条讲聊天）。附注带上当前页能缓解；按压前卡上显示 `similar[]` |

---

## 11. 对照产品理念与不做

| 理念（出处） | 这里怎么守 |
|---|---|
| 「产品理念是人驱动 agent 去做事」（owner） | 你说，agent 查和起草 |
| 「人只对目标、风险、预算和不可委托授权负责」（owner） | Apply 和 Merge 是你的，其余 agent 做 |
| 「人已经授过的权，不该再问第二遍」（owner） | 一张卡一按，按下之后的重写不再问 |
| 「Nothing blocks in silence」（`docs/product-intro.md`） | 被挡住的重写写在卡上、算进「等你」，圆按钮也亮 |
| 「时钟不得启动 agent 工作」（`open-item-escalation.service.ts`） | 重写只由按压和进 main 触发；草稿不催、不过期 |
| 文档是视图，不是知识（契约 §22.8） | 不改字，不当出处 |
| 确认只存在于 owner 通道（设计 §0 第 3 条） | 草稿不是确认，按压在 JWT 门上 |

**不做：** 直接改文档的字；服务端另造聊天；分 Ask / Edit 两种模式；自动合并；第一版的「自动应用」开关（先看真实的按压和 Discard 比例）；评论卡和它的 11 种状态；访客聊天；Android。

---

## 12. 决定

### 12.1 已定（owner 2026-11-06）

1. 入口是窗口右下角的圆形悬浮按钮，页头不放。
2. 聊天不直接改文档的字。
3. 聊天是普通会话，跑在 workspace 所在的 runner 上，用独立 worktree，起点是 `origin/main`。
4. 每张卡都要按 Apply，按下即 confirmed，跳过机器核实。
5. 评论项目并进来：留用留版和跟进，不做 Go 那份和评论卡。
6. 第一版：web 桌面先通条目、重写、代码三条路，iOS 紧跟，plan 卡放第二步。
7. orbit 这个 space 默认 `orbit-develop`（HPC）。

8. 定向重写只绕开不写文档的作业（§8.5）。
9. 新项目开工后，关掉旧的评论项目。

### 12.2 待定

没有。

---

## 13. 契约与落点

| 层 | 文件 | 要点 |
|---|---|---|
| 契约 | `contracts/wiki.contract.json`、`docs/wiki-contract.md` 新增 `chat`、`docs.follow`、`docs.versions`；改 `agentSurface`（`wiki_draft`、聊天会话的 `wiki_propose`）、`jobs`（`onePerSpace` 的例外，§8.5）、`reviewModes`（按压的效果）；`docs/project-source-contract.md` 补聊天的 SOURCE | 状态向量、限额、文案；TS 与 Swift 钉回 |
| 迁移 | `wiki_chat_draft`；`wiki_doc_section_version`；`session.wiki_chat_space_id`；`wiki_job` 的新 kind 与索引 | 取号前扫 main、`project/*`、已推的 `orbit/*`；普查照规矩登记 |
| apiserver | 新 `wiki/wiki-chat.ts` 与 controller（建聊天、列聊天、草稿的读与按压）；`sessions.service.ts` 建会话的选项；`projects/session-source.ts`；`runner-api/control-plane-note.ts` 的附注；`wiki.service.ts` 的草稿分支；`wiki/wiki-docs.ts` 留版；`wiki/wiki-dossier.ts` | user 门 JWT，带会话头拒 |
| wiki-worker | 新 `docs_follow` 作业，复用 `runWikiDocsBuild` 的 `only`，加额外材料；`wiki-jobs.ts` | 合并排队、每日节数闸、被挡原因进 Activity |
| runner | `wiki_tools.go`、`wiki_cli.go`（`wiki_draft`，cli/mcp 对照、help、agent_instructions 三张表）；`worktree.go`（空分支清理） | 需要发版 |
| web | 从 `WorkspaceView.tsx` 抽实时流（`EventSource` 那个 effect）和 `Transcript` 外面那 9 层 provider，成可复用的会话组件；新 `WikiChatFab`、`WikiChatPanel`、`WikiDraftCard`、`WikiSeeChanges`、`lib/wikiChat.ts`；`WikiPage.tsx`、`WikiDocPage.tsx`；`deliveredMessage.ts` 的附注标签；`WikiActivityPage.tsx` 的 Docs 行 | 这是最大的一块：实时流和输入框都在这个 12,646 行的文件里。`Transcript` 本身已能单独用（分享页）。先做不改行为的拆分，再做面板 |
| iOS | `WikiDocView.swift`；`Console/ConsoleView.swift` 的 `TranscriptView` 放进 sheet，要核对依赖；OrbitKit 的状态逻辑与 `WikiCopy` 对照 | SwiftUI 只在 CI 编 |

---

## 14. 分期与还没量的

**第一步（web 桌面）：** 量 → 契约 → 留版 → 跟进 → 聊天会话 → 草稿与按压 → 拆分 → 面板与入口 → 选区与卡 → 端到端。

**第二步：** iOS；plan 卡（web 与 iOS）；owner 走查（部署、runner 发版、iOS 发版之后）。

**还没量的，排在最前面：**

1. 重写一节要多久（真实 System model）。
2. orbit space 有多少时间被作业占着，各是什么作业。这个数说明 §8.5 的例外值多少，也说明维护写文档时按下要等多久。
3. 新会话带 worktree 到首次回复要多久；一个 worktree 占多少磁盘。

交互按异步设计，这些数不改变流程，但决定手感。如果第 1 项要几分钟，要考虑按下后先显示「重写中」时左边的提示怎么写，也可能要给第 3 项做预热；到时再定，不提前做。
