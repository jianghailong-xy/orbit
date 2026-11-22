# Wiki 聊天窗口：边聊边改（2026-11-06 产品方案）

> owner 11-06 问：wiki 页面上要有一个聊天窗口，用来边聊天边修改 wiki。
> owner 11-06 定：入口是右下角的圆形悬浮按钮；五条按推荐；orbit 这个 space 默认用 `orbit-develop`（HPC）；定向重写只绕开不写文档的作业（§8.5）。全部见 §12。
> owner 11-07 定：面板的输入框换成 session 页的 composer，用方案 A（效果图 `docs/mocks/wiki/43-chat-session-composer`，§4.1、§4.2）。
> owner 11-21 定：按 agent-first 的第一原理重写 agent 的行为（§4.3）。起因是一次真实对话：owner 在 wiki 首页说「帮我把数据库的 Schema 设计更新到 wiki 里」，agent 因为读不到文档和 plan，回答「打开对应的页面，再发一条消息」，把找东西的活交回给人。改的是：agent 读得到你看得到的 wiki（读与引分开，并在出处校验上真正挡住，§4.2）；先自己查清楚再起草；只问该你答的问题。
> owner 11-22 定：你的话本身就是授权，用方案 A（§7.2、§12.1 第 13 条）：在写死的边界内，「从 main 重写」起草即写，卡上给结果和 `Undo`，不再按一次。11-21 那版的起草时预览（`docs_preview`）随之去掉：A 之后它只剩代价（§7.4）。这一版吸收了 11-21 修订的独立评审。
> 本文最初是产品方案；§1 是 11-06 写方案时的现状。聊天、草稿、`wiki_draft`、`docs_follow`、留版已经实现（契约 §28–§30），11-21 与 11-22 的修订还没有实现。效果图：`docs/mocks/wiki/42-wiki-chat`（图里的对话、条目和合并都是示意）；面板的输入框以效果图 43 为准。
> 它取代 `docs/wiki-comment-to-session-design.md` 的入口部分（§2、§3、§5、§11.1–§11.5），留用那份的 §12（任何改动进 main 都跟上、任何重写都留版），去掉其中的 runner 路径（§11.7）：P11（2026-10-19）已经删了 runner 上写文档的路径。

---

## 0. 一页结论

总原则（owner 11-21 定）：**你给目标和授权，其余都是 agent 的。** 找东西、收集上下文、判断落在哪一层、起草、核对，都由 agent 做。agent 不把能自己做的事交回给你：一轮结束时留给你的，只能是该你做的决定（§4.3）。

1. **聊天就是一场普通会话，停靠在 wiki 页面里。** 不另造模型循环和对话存储。工具、审批、权限模式、费用、会话列表、手机端都沿用。
2. **聊天不改文档的字，改字的来源。** 文档是服务端从代码和记录生成的，手改的字下次重写就没了。所以每句要求落到重写后还在的地方：条目、这一节的重写、plan，或者 main（§6）。
3. **按压只给请求没授过的权（11-22 定，方案 A）。** 「从 main 重写」在写死的边界内起草即写，卡上是结果和 `Undo`：这次改动的担保来自代码，你的话已经授过权（§7.2）。条目、plan 改动、读过网页的聊天、超出边界的重写照旧要按 Apply：草稿不进 Review，不走机器核实，不占待审名额，按下等于 Review 的 Accept：trust = confirmed（§7）。
4. **写完给你看结果。** 条目立刻生效，受影响的节定向重写。不等维护的 20 个会话或 24 小时。写完能逐句看改了什么，也能撤销。同一 space 正在跑的 articles、verify、import 不挡它；有写文档的作业在跑时要等它结束，卡上写明（§8）。
5. **入口是右下角的圆形悬浮按钮。** 聊天收起后不结束，按钮带状态（§3）。
6. **你看得到的 wiki，agent 都读得到。** 文档、plan、条目都能读（只读），当前页只是「你多半在说哪里」的提示，不是 agent 视野的边界。读和引分开：读 wiki 的调用不能当出处，这一条在出处校验上挡住（§4.2）。你附上的当前页和选中的句子显示在输入框里，可以叉掉，没显示的不发（§4）。
7. **跑在 workspace 所在的 runner 上，用独立 worktree，起点是 `origin/main`。** workspace 每个 space 选一次，之后记住，不自动换机器（§5）。

---

## 1. 现状

| 环节 | 今天 | 差什么 |
|---|---|---|
| 文档 | 只有服务端的 `docs_build` 与 `maintain` 作业能写（契约 `docs.who`），user 门只有 3 个读路由（`wiki-docs.controller.ts`）。整节替换，不留旧文（§22.5） | 留版；单节重写的入口 |
| 条目 | owner 有表单（`WikiEntryDrawer.tsx`、`WikiNewEntry.tsx`），agent 走 `wiki_propose`。11-02 的数据：owner 的 3 个 space 里 28,489 条有效条目，经人确认的 142 条，owner 亲手写的 0 条 | 一条比表单省事的路 |
| plan | owner 能编辑、确认、重建（`wiki-plan.controller.ts`）。会话读不了也写不了（契约 `plan.who`） | 从聊天发起的路 |
| 会话 | 能读条目，读不到文档和 plan（契约 §22.8），也不知道你在看哪一页。11-21 实测：在 wiki 首页说「把数据库 Schema 设计更新到 wiki」，agent 连有没有讲 schema 的文档都查不到，只能让你去开页面 | 读得到你看得到的一切（§4.2），页面作为提示带给它 |
| 选区、开会话 | 文档页没有选区。[评论项目](orbit-project:34cbCXaNMJIHWoigS7XWd) 10-09 建好，到今天 `startedAt` 还是空，10 个任务全 OPEN | 由本方案接手 |
| 单节重写 | `runWikiDocsBuild` 进程里有 `only`（`wiki-docs-build.ts`），但 build 路由按整个 plan 版本，`docs_follow` 还不存在 | 作业和入口 |

---

## 2. 主流程（web 桌面，图 42 ⓪–③）

1. 右下角圆按钮打开面板。面板停靠在右边，挤开正文。
2. 拖选一句，选区按句吸附（规则照 10-09 的设计 §2），浮出 `Ask`。按了把这几句放进输入框，不弹窗。
3. 你说话，在哪一页都行，不用先找到「对的那一页」。你的话原样成为消息，附件单独存。
4. agent 自己查：`origin/main` 的代码和设计文档、wiki 的全部结构（plan、文档、节、各节写的是什么、什么时候写的）、已有的条目，比出差距。再判断这话该落在哪一层（§6），起草（§4.3）。
5. 聊天里出现一张改动卡，先用一两句白话说落在哪、为什么，左边正文标出会牵动的节。在 A 的边界内的「从 main 重写」（§7.2）不等你按，起草即开始写；其余的卡等你。不满意就接着说，新卡替换旧卡。
6. 要按的卡按 `Apply`。条目立刻生效，卡变成 `Applied`，这几节开始重写。
7. 写完，左边新句有绿线，节旁 `Updated`；卡上 `Wiki updated`，`See changes` 逐句对照。重写被挡住或失败，卡上写明、圆按钮亮琥珀色（§3），不沉默；agent 在你下一句话时随附注知道结果（§7.2）。
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

- **头：** 标题（点开是这个 space 的聊天历史）、`+` 新开、`↗` 换成完整会话页、`✕` 收起。
- **默认展开（owner 11-11 定，效果图 45 ①②，契约 `chat.panel.openByDefault`）：** 窗口宽到面板停靠（≥ 1200）时，Settings 以外的 wiki 页打开就显示面板，接上圆按钮会打开的那一场（等你的 → 最近说过话、还开着的 → New chat）。点 `✕` 就记住收起：存在本机、按 space 记，新标签和重启都不再自动展开，直到再点一次圆按钮（Q1 A）；收起后照旧是圆按钮（Q2 A）。地址带 `?chat=` 的照样打开。自动展开不写地址：窗口拉窄到不停靠时随之收起，拉宽回来再展开。聊天列表读回之前，正文先按面板宽度排好，不跳。
- **历史（owner 11-11 定，效果图 45 ④，契约 `chat.panel.history`、`chat.list.page`）：** 点标题，整个面板换成列表（Q3 A），标题变成 `Chats`，再点或按 Esc 回到原来那场，正在输入的字不丢。顶上按标题搜索（服务端 `?q=`），每页 50 场，`Show more` 再取下一页（`?offset=`）。分 Open 和 Completed（Q4 A，同 session 列表）：Open 里先是等你的，再是正在跑的，其余按最后说话的时间；Completed 默认折着，搜索时一起列出。每行第二行是灰字：`1 needs you`、`Working…` 或多久前说过。行的 `⋯` 是 session 列表的 `Rename…`、`Open as a full session`、`Complete`、`Move to Trash`，走同一组接口，带 Undo；Trash 在 session 列表里，面板底部一行字说明（session 列表的 Trash 没有可链接的地址）。删掉的是正在看的那场，面板回到 New chat。
- **iPad 与 macOS（owner 11-11 定）：** 同样默认展开与历史。面板是第三栏（iPad 常规宽度、Mac）时打开 wiki 就显示，接上圆按钮会打开的那一场；`✕` 或收起这一栏都按 space 记在本机（UserDefaults），直到再点圆按钮。iPad 变窄成 sheet 时，自动展开的面板随之收起，变宽再回来。点标题整栏换成历史：搜索、Open / Completed、每行 `⋯` 与右键菜单里的 `Rename…`、`Open as a full session`、`Complete`、`Move to Trash`，带 Undo。iPhone 的 sheet 不自动展开，标题仍是原来的菜单。
- **页头没有 New entry（owner 11-11 定，效果图 45 ③）：** 手写条目在聊天里说，卡片按 Apply 写入算 owner 自己的写。
- **Runs in（owner 11-07 定，效果图 43 ②）：** 新聊天时标题下一行是 `Runs in`，只放 workspace，只在新聊天出现，发出第一句后收起。聊天开始以后不再显示 workspace，session 页也是开了就不能换。机器离线时照旧另写一行（§5.1）。
- **地址：** 带 `?chat=<session>`，翻页不关，刷新还在。
- **输入框（owner 11-07 定，效果图 43 ②④⑤）：** 就是 session 页的 composer，是同一个组件，不是照着仿一个：附件行、输入框、工具栏、斜杠菜单，运行中的排队、插话与 Stop。工具栏和 session 页一样：`+`（图片、文件、命令、技能）、模式、模型与思考强度、用量圈、发送。发送键在运行中且输入框为空时变成 `Stop`；这时再发的消息按 session 页的规则插进这一轮，按住发送键或 ⌥Enter 排到下一轮，排队和插话中的消息在输入框上方，可以收回。以后 session 页改了，面板跟着变。
  - 新聊天在工具栏选的模型、思考强度、速度与模式随第一句建聊天（`POST /api/wiki/spaces/:id/chats` 的 `model`、`effort`、`fastMode`、`permissionMode`）；聊天开始以后，改它们和 session 页一样改这场会话的配置。
  - 占位文字沿用 wiki 的两句：`Ask about this page, or say what should change`；有卡片等你按时是 `Reply, or say what to change in the draft`。
  - 面板宽 374 px 时工具栏一行放得下，不挤压模型芯片（效果图 43 ⑥ 是反例）。
  - 和 session 页不同的只有两处：换 provider 与账号只在完整会话页（`↗`）；新聊天的第一句是 owner 的原话（§4.2），所以 `!` 命令要等聊天开始以后再发。
- **聊天的归属：** 一场聊天属于一个 space，换 space 看到的是那个 space 的聊天。它也在 workspace 的会话列表里，页头有来处标签 `From Wiki`。

| 窗口宽 | 面板 | 目录栏 |
|---|---|---|
| ≥ 1440 | 页面最右的一栏，从窗口顶到底，不是盖在页面上的浮层（owner 11-13 定，效果图 `docs/mocks/wiki-rail` 03 Ⓑ）；默认窗口宽的 1/3（400–720），可拖 320 到窗口宽的一半（owner 11-11 定） | 照旧 |
| 1200–1439 | 同上，一栏，默认宽度同上（这一档是 400–480）；应用侧栏收成图标条（03 C2），侧栏的切换键可临时展开，不改用户自己的收起设置 | 照旧 |
| 640–1199 | 从右滑出，盖住正文右侧，不加遮罩 | Contents 抽屉 |
| < 640 | 底部 sheet，半屏与全屏两档 | Contents 抽屉 |

条目抽屉开在面板左边。这组数按真页面校准。

### 4.2 附件

- **当前页：** 自动跟着你走，发送时定格。文档页带篇和节（按滚动位置取最近的节标题），条目抽屉带条目，plan 页带篇。
- **引用：** 选中的句子，带脚注的代码位置、记录和经由的条目。最多 20 句。
- **在输入框的附件行里（owner 11-07 定，效果图 43 ④）：** 当前页与引用排在附件行的最前面，和图片、文件排在一起，各带 `×`。
- **都能叉掉，没显示的不发。** 发送时定格，叉掉的就不发。发出后气泡下面是 `⊕ Orbit attached: Wiki selection · 3.1 §3 · 1 sentence · 2 sources`，展开看全文。
- **图片与文件：** 和 session 页一样上传，消息只带它们的 id。之后的消息走这场会话自己的发消息门；新聊天的第一条在建聊天的门（`POST /api/wiki/spaces/:id/chats` 的 `attachmentIds`）带上，和第一句在同一个事务里挂到第一条 turn 上。
- **在服务端展开。** 客户端只发 `{ docSlug, sectionKey, sentenceIds }`，投递时服务端读当时的句子和脚注，走现有的附注机制（`control-plane-note.ts`、`deliveredMessage.ts` 的 `describeNote`）。`conversation_turn.content` 仍然只有你的话，所以这句话能被当一手出处（契约 `tiered.auto.ownerWords` 要求 owner 经 user 门发、带 UUID 的 client turn id）。
- **附件是提示，不是视野。** 当前页说的是「你多半在说哪里」；agent 要的其余上下文自己去读（下一条），不靠你翻页带给它。
- **没带页面时附上目录（owner 11-21 定，第一步，不用 runner 发版）。** 一条消息没带当前页（wiki 首页、Activity、Review，或你叉掉了页面）时，服务端照附注机制加一段 `<orbit_wiki_contents>`：已确认 plan 的版本；每篇的编号、slug、标题、分类；每节的 key、标题、是否写过、写成时的提交。不带 `covers` 和句子，一个 35 篇的 space 约 3k token。一场聊天里只在第一次需要时附，plan 换了版本再附。这一段单独就能解掉 11-21 那次对话：有没有讲 schema 的文档、在哪几节，agent 都看得到，「从 main 重写」要的 slug 和 key、plan 卡新开一篇要的分类也都有了。发出后气泡下面照样列出 `Wiki contents`。
- **`wiki_read`：按需读（owner 11-21 定，第二步，要 runner 发版；取代 11-06 的「不加读文档的工具」）。** 只读，**先只对聊天会话开放**，和 `wiki_draft` 一样；别的会话以后看用量再说。
  - 不带参数：同上面的目录；带 `q`：标题、`covers` 与句子里含这些词的节。
  - `doc`：这一篇在已确认 plan 里的完整定义（plan 卡的 `change.docs` 要的就是它，含 `covers`）和写成的句子与脚注；再带 `section` 只取一节。
  - `draft`：这场聊天的一张卡：状态、要写的节、写的进展与结果（§8.3），以及写成的新旧句子。
  - 另带 agent 撞墙前该知道的事：plan 有没有待确认的草稿（有的话 `wiki_draft` 会拒 `WIKI_PLAN_STALE`），这个 space 正在跑或排着的写文档作业。
  - 一次回答至多 `readMaxChars` = 60,000 字，超出的截断并给 `more`，契约写明。只靠未经担保、带污染标记的条目写成的句子，照条目读的规则不给。每次读照 `wiki_get` 记 `wiki_exposure`。
- **读和引分开，在出处校验上挡住（11-22 按评审改）。** 11-06 不给读，是怕文档的话被当成知识的出处，绕一圈又写回文档。11-21 那版说「没有出处种类指向文档，所以放开读也安全」，这不对：`tool_call` 和 `event` 是出处种类，引一次调用时，引文按调用连同结果（`toolCallText`）核对（`wiki.service.ts` 的 `tool_call` 分支），所以引一次读 wiki 的调用，就能把文档的句子当出处；聊天按下又不走核实，直接成 confirmed 的条目。今天读 wiki 的调用（`wiki_search`、`wiki_get`）也只是降成非 `observed`，没有被拒。要补三处，各配一个 pg spec：
  1. **出处解析拒读 wiki 的调用。** `tool_call` 或 `event` 出处指向的调用是读 wiki 的（`wikiCallReadsWiki`），一律 `WIKI_SOURCE_UNRESOLVED`。这也改了今天 `wiki_search`、`wiki_get` 被引时的行为：从降级变成拒，理由相同——wiki 说过的话不是它所说之事的证据。
  2. **`wiki_read` 与 `orbit wiki read` 进读 wiki 的名单**（`src/shared/src/wiki.ts` 的 `WIKI_READ_TOOL`、`WIKI_READ_COMMAND`，契约 `maintenance.dossier.wikiReads`）：案卷跳过它，证据分级不算 `observed`。
  3. **写文档的材料不收读 wiki 的调用。** 否则一节的脚注可以指向一次 `wiki_read` 的结果：文档引文档。
  - 目录附注和 `wiki_read` 的结果头上都写明「这是视图，不是出处：要引就引它脚注指向的代码和记录」。文档照旧不进自动推送的 `<orbit_wiki_context>`。
- **给 agent 的话（`<orbit_wiki_chat>`）：** 你在 wiki 页旁边聊天；当前页只是提示，wiki 的结构在 `Wiki contents` 附注里，内容用 `wiki_read` 自己查，不要让 owner 去开页面；先判断该改哪一层；条目改动用 `wiki_propose`，重写和 plan 用 `wiki_draft`；在边界内的「从 main 重写」起草即写，其余都是草稿；不要改文档；不要引读 wiki 的调用；只问该 owner 答的问题，问时带上你的推荐。
  - **改了也要送到已有的聊天。** 今天这一段只随一场聊天的第一条消息走，而圆按钮接上的多半是最近一场还开着的旧聊天。所以服务端记下这场聊天上次送达的版本，这段话的文字变了，就随下一条消息再送一次；同样的规则写进 `wiki_read` 的工具说明和 agent 指令，不只靠这一段。

### 4.3 Agent 的行为（owner 11-21 定）

第一原理：人给目标和授权，agent 做其余的一切。agent 看得比人少，人就得替它取上下文，角色就反了。检查放在写、放在「谁担保这是真的」、放在超出所说范围的改动上，不放在读上。

**一个请求的六步。** 以「帮我把数据库的 Schema 设计更新到 wiki 里」为例：

1. **读出目标。** 你要的是 wiki 准确地讲现在的 schema、放在对的地方。你不需要知道层、slug、重建这些词，agent 的回答里也不拿它们当前提。
2. **自己查。** `origin/main` 的 `schema.prisma` 和最近的迁移、解释表为什么长这样的设计文档；目录附注和 `wiki_read` 看整个 wiki 有没有、在哪里讲 schema；相关条目；比出差距。
3. **判断落在哪，用白话说。** 有一篇但落后于 main：重写那几节。散在几篇里：plan 卡，把它们收拢。没有：plan 卡加一篇。设计的「为什么」没记下来：条目。这几样可以在一次回答里一起起草。
4. **你判断的是结果，不是机制。** 在 A 的边界内的重写直接写，你看到的是写成的新旧对照和 `Undo`（§7.4）；要按的卡上写的是改完的样子：条目的全文、plan 改完的目录。
5. **只问真正的分岔，带默认。** 比如「你也可能是想改 schema 的设计本身。我按『把现在的设计写进 wiki』理解，不对就说」。不问「这在哪一页」：那是 agent 自己查得到的。
6. **说实话，不替没读过的东西担保。** 句子由服务端的写作模型写，agent 在起草这一轮里看不到。回答说它要求了什么、排上了什么；写成的样子在卡上（`See changes`）。agent 可以用 `wiki_read` 的 `draft` 读结果，你下一句话时结果也随附注送到（§7.2）。写完不另开一轮去核：句子已由服务端逐句对原文核过，agent 能动的只有条目和 `covers`，另开一轮只花钱、没有补救的手段。

**好的回答长这样（示意）：**

> wiki 里没有专讲 schema 的文档。表结构零散在 3.1 §4 和 5.2 §2，两处都早于迁移 0412–0418。我起草了一篇新文档「Database schema」，放在 Architecture 下，6 节；原来那两节改成指向它，不再重复。这是 plan 的改动，卡上是改完的目录，按 Apply & rebuild 写入。

另一种情况（示意）：

> wiki 的 4.2「Data model」讲的就是 schema，但 §2、§3 早于迁移 0412–0418。我已按 main 重写这两节，进展在卡上；不对就按 Undo。

**不做：**

- 一轮结束时把能自己做的事交给你（「打开那一页再发一次」「告诉我文档叫什么」）。
- 只说「我做不到」而不说做到了哪一步、还差什么、谁能补上。读不到的东西（比如机器离线、仓库读不到）照实说，同时给出下一步。
- 把内部机制当成你要理解的前提：卡的种类、层、slug 留在卡上给想看的人看，回答先说结果。

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
| 「这个数早就变了」 | 文档落后于 main | 重写这一节 | `Rewrite from main` | 在 A 的边界内起草即排 `docs_follow`；否则按下排（§7.2） |
| 「这篇太长，拆开」「写给新人看」 | 结构和写法 | plan（写法要求落在节的 `covers` 上，指纹包含它，下次重写还在） | `Plan change`：一张卡可改几篇，拆一篇就是一张卡（移一节到新开的一篇），卡面先写移节、再逐篇写改动（图 42 ③） | 现有 `plan/edits`、`confirm`、`build`，一按三步；几篇的改动合成一次 plan 编辑，对改完的整份 plan 过一次闸，任何一篇过不了就什么都不写、卡上列出全部错误。Undo 把 plan 和那次重建写过的节放回去（§7.2） |
| 「这里应该改成 45 秒」 | 系统本身 | 代码或它引用的设计文档 | 没有卡，是会话的改动条 | 审批照拨盘走，Merge 你按，进 main 后 §8.1 跟上 |

「你说」这一列只是举例。你不必说成哪一种，也不必在对应的那一页上说：agent 用目录附注、`wiki_read` 和代码自己查出该落在哪一行（§4.3）。一个请求可以同时落到几行，比如「把 schema 设计更新到 wiki」可能是一张 plan 卡加一篇文档，再加几条记设计原因的条目。

agent 判断错了怎么办：你接着说，或者按 Discard。卡上先用白话写落在哪、为什么，再写层，这个判断是看得见的。

---

## 7. 改动卡

### 7.1 草稿

- 一场聊天是带 `wiki_chat_space_id` 的会话。这样的会话调 `wiki_propose`，**所有 op 都先成草稿**（包括平时自动生效的 `reinforce`、`challenge`，和 `wiki_note` 的 `corrects`）：照常跑校验（schema、出处、引文、脱敏、CAS、污染标记），不写条目，回答 `status: "draft"`。这样「不按就不变」才是真话。不带 `corrects` 的 `wiki_note` 不变，它本来就只是留给维护的线索。
- 重写和 plan 用新工具 `wiki_draft`，只对聊天会话开放，别的会话调用被拒。需要 runner 发版。它不接受、不确认，也不是页面覆写。它要的 slug、节的 key 在目录附注里，plan 里一篇的完整定义用 `wiki_read` 取（§4.2），不靠你开着那一页。
- **A 之后 `wiki_draft` 会引起文档的写（11-22）。** 在边界内的重写卡，起草即排 `docs_follow`：字仍然只由服务端的作业写，agent 仍然没有接受、确认、覆写页面的工具。契约 `agentSurface.notTools` 与 §7.2 照此改写措辞：「agent 能让服务端按 main 重写它点名的节，不能决定写什么字」。
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
- **agent 下一轮知道结果。** Applied、Discarded、Undone 与重写的结果随下一条消息作为附注送达，不单独开回合：按压和作业结束都不启动 agent（理由见 §4.3 第 6 步）。
- **安全底线不动。** `decide` 仍然只在 owner 门上；agent 仍然没有接受、确认的工具。
- **什么必须按（owner 11-21 定原则，11-22 选 A）：** 按压只用在请求本身没授过的权上：担保一件事是真的（条目的 trust = confirmed 只有你能给）；结构的改动（plan）；撤不回的事。读不需要按。

**方案 A：不按就写的边界。** 「是不是你说的范围」服务端判断不了：agent-first 下你说的是目标，节是 agent 挑的。所以边界写成服务端能查的条件，全部满足才不按就写，缺一条就照旧等你按，卡上写明为什么：

| 条件 | 不满足时卡上写 |
|---|---|
| 卡是 `kind: rewrite`，不带条目 op、不带 plan 改动 | —（本来就是要按的卡） |
| 节都在已确认的 plan 里、已经写过，至多一张卡 5 节 | —（`wiki_draft` 照旧拒） |
| 这场聊天没读过网页（没有污染标记） | `Apply to write: this chat read web content` |
| 这个 space 今天不按就写的节没超过 `chatAutoSectionsPerDay` = 20（强制的节不算 `followSectionsPerDay`，没有这道闸，agent 一循环就是没有上限的 System model 花费） | `Apply to write: today's automatic rewrites are used up` |
| 这场聊天里没有还等你按、会重写同一节的卡 | 不改写法，只等：那张卡按了或弃了再写，同一节只写一次 |

- **不按就写的节，不给你的原话当材料。** §8.2 的强制材料里有「这场聊天里你的原话」，它能被引成脚注，开了 Footnotes 的分享链接上访客读得到（§10）。没经你按就发布你的话不对，所以这类重写只用代码、记录和条目；要把你的话写进去，那是条目卡，要按。
- **卡上不写 `Confirmed by you`。** 没按过就不是你确认的。这类卡的标题是 `Rewritten from main`，写的进展和结果照 §8.3，动作是 `Undo` 与 `See changes`（§7.3）。

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

不按就写的重写卡（§7.2 方案 A）：

| 显示 | 条件 | 动作 |
|---|---|---|
| `Rewritten from main`，下面接 §8.3 的进展与结果 | 起草即排上，或已写完 | Undo · See changes（写完后） |
| `Draft · Rewrite from main`，下一行 §7.2 表里的原因 | 边界缺一条，等你按 | Apply · Discard |
| `Undone` | 写完又按了 Undo | — |

重写的进展接在卡下面，见 §8.3。

### 7.4 结果在卡上（owner 11-21 定原则，11-22 去掉预览）

你判断的应该是结果，不是机制。11-21 那版想在起草时就把节写成预览（`docs_preview`），按下即发布。选了 A 以后，预览只剩代价，所以去掉：

- **不按就写的重写，结果就是写成的那一版。** 卡上 `See changes` 逐句对照新旧，不对就 `Undo`，回到写之前那一版（§8.4）。这比先看预览再按少一步，看到的是同一个东西。
- **条目卡：** 卡上就是条目的全文，按下写的就是它；牵动的节在按下之后重写，结果接在卡下面。
- **plan 卡：** 改完的目录（新篇、移节、改名、新的 `covers`）就是这次结构改动的结果；那次重建的句子在按下之后写。
- **预览还有哪些没解决的问题（留作记录）：** 按下时核「预览是否还新鲜」要重新收集材料，经维护 workspace 的 runner 读仓库，做不成一个短事务；在 Apply 的事务里发布预览是一次绕过「一个 space 只有一个写文档的作业」（§8.5）的写；起草时新条目还没有 id 和修订，脚注的 `via_entry_id` 无从写起；plan 卡要对着一个还没存、没确认的 plan 版本写；被弃和被替换的草稿也花模型调用。以后真要预览，从这几条开始。

---

## 8. 定向重写与跟进

### 8.1 一个作业，两种触发

沿用 10-09 §12 的 `docs_follow`，只跑 wiki-worker：

- **聊天：** 按下 Apply，或不按就写的重写卡起草时（§7.2 方案 A），卡上列的节强制重写（写 `stale_at`，不看指纹），优先级 1。不按就写的节计入 `chatAutoSectionsPerDay`，不计 `followSectionsPerDay`。
- **改动进 main：** 会话合并回执、落地线进 main 的回执。只写引用了被改文件的节，指纹没变不调模型，追赶期照跑，每个 space 每天至多 40 节（`followSectionsPerDay`），超出的留给常规维护，Activity 写明。优先级 0；这场合并来自聊天时是 1。
- 每个 space 最多排一个，排队中再来的并进去。重写只由这两个事实触发，不加时钟。

### 8.2 写哪几节、多给什么

**卡上的 `Rewrites`** 在起草时算好：附件里的节；经由这条条目的句子所在的节（脚注的 `via_entry_id`）；新条目按 `sectionFit` 排名靠前的节。一张卡至多 5 节。

**强制的节多给两样材料**，否则新条目可能被 `entriesPerSection` 的上限挤掉，写回原样：这次改动的条目（及其出处）、这场聊天里你的原话。句子照旧逐句引一手原文、逐字核对；你的 turn 是能引的，文档、评论和读 wiki 的调用不是（§22.8，§4.2）。不按就写的重写不给你的原话（§7.2）。

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

撤销 `Rewrite from main` 卡（owner 11-07 定）：恢复的旧版是按旧提交写的。如果 main 改过这一节引用的文件，下一次维护按 main 再写一遍。这是有原因的重写，不算无故，行为不变；但不能静默，撤销后的这类卡上写一句 `If main has changed the files this section draws on, the next maintenance run writes it from main again.`（web 的 `WIKI_CHAT_UNDONE_REWRITE_NOTE`，iOS 的 `WikiChatCopy.cardUndoneRewriteNote`）。main 没改过这些文件时，指纹不变，下一次维护不动这一节。

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
| 重复条目 | 语义检索没开，agent 判断「库里有没有」可能不准（11-06 搜 `wiki chat` 返回 10 条，没一条讲聊天）。目录附注和 `wiki_read` 让 agent 看得到文档里已经讲了什么，能缓解；按压前卡上显示 `similar[]` |
| 你说的地方在 wiki 里找不到 | agent 自己判断是该新开一篇还是并进已有的一篇，起草出来让你看；不让你去找 |
| agent 读不到（机器离线、仓库读不到） | 照实说读不到什么、因此做到了哪一步，并给出下一步；不把找东西的活交给你 |
| plan 有待确认的草稿 | `wiki_read` 先告诉 agent；它不去撞 `WIKI_PLAN_STALE`，照实说要先处理那份草稿，并给出 Plan 页的链接 |
| 不按就写的重写读起来一样 | 卡上 `§3 reads the same`，算进「等你」（§8.3）：agent 判断它落后于 main，写出来却没变，值得你看一眼 |

---

## 11. 对照产品理念与不做

| 理念（出处） | 这里怎么守 |
|---|---|
| 「产品理念是人驱动 agent 去做事」（owner） | 你说，agent 查和起草；你在哪一页说都行，agent 自己找到地方（§4.3） |
| 人给目标和授权，agent 做其余的一切（owner 11-21） | agent 读得到你看得到的 wiki；一轮结束时留给你的只有该你做的决定；问时带推荐 |
| 你判断的是结果，不是机制（owner 11-21） | 不按就写的看写成的对照，要按的看条目全文和改完的目录（§7.4） |
| 「人只对目标、风险、预算和不可委托授权负责」（owner） | Apply 和 Merge 是你的，其余 agent 做 |
| 「人已经授过的权，不该再问第二遍」（owner） | 一张卡一按，按下之后的重写不再问；你的话已经授过的「从 main 重写」不再按（§7.2 方案 A） |
| 「Nothing blocks in silence」（`docs/product-intro.md`） | 被挡住的重写写在卡上、算进「等你」，圆按钮也亮 |
| 「时钟不得启动 agent 工作」（`open-item-escalation.service.ts`） | 重写只由按压和进 main 触发；草稿不催、不过期 |
| 文档是视图，不是知识（契约 §22.8） | 不改字，不当出处；读得到，引不了：读 wiki 的调用在出处校验上被拒（§4.2） |
| 确认只存在于 owner 通道（设计 §0 第 3 条） | 草稿不是确认，按压在 JWT 门上；不按就写的重写不写 `Confirmed by you`，也不给任何条目 trust |

**不做：** 直接改文档的字；服务端另造聊天；分 Ask / Edit 两种模式；自动合并；「自动应用」开关（方案 A 的边界写死在 §7.2，不是开关；要放宽先看真实的 Undo 比例）；起草时预览（§7.4）；对聊天以外的会话开放 `wiki_read`；评论卡和它的 11 种状态；访客聊天；Android。

---

## 12. 决定

### 12.1 已定（owner 2026-11-06）

1. 入口是窗口右下角的圆形悬浮按钮，页头不放。
2. 聊天不直接改文档的字。
3. 聊天是普通会话，跑在 workspace 所在的 runner 上，用独立 worktree，起点是 `origin/main`。
4. 每张卡都要按 Apply，按下即 confirmed，跳过机器核实。（11-22 改：边界内的「从 main 重写」不按，见第 13 条。）
5. 评论项目并进来：留用留版和跟进，不做 Go 那份和评论卡。
6. 第一版：web 桌面先通条目、重写、代码三条路，iOS 紧跟，plan 卡放第二步。
7. orbit 这个 space 默认 `orbit-develop`（HPC）。

8. 定向重写只绕开不写文档的作业（§8.5）。
9. 新项目开工后，关掉旧的评论项目。

**owner 2026-11-21 定（agent-first 修订）：**

10. agent 的行为按 §4.3：人给目标和授权，agent 做其余的一切，只问该你答的问题，问时带推荐。
11. agent 读得到你看得到的 wiki：先是没带页面时的目录附注，再是只对聊天开放的只读工具 `wiki_read`；读与引分开，读 wiki 的调用在出处校验上被拒（§4.2）。取代 11-06 的「不加读文档的工具」。
12. 卡上给你看结果，不是机制（§7.4）。

**owner 2026-11-22 定：**

13. 你的话本身就是授权，用方案 A（§7.2）：在写死的边界内，「从 main 重写」起草即写，卡上是结果、`See changes` 和 `Undo`，标题 `Rewritten from main`，不写 `Confirmed by you`，不用你的原话当材料；条目、plan、读过网页的聊天、超出每日节数的，照旧要按。
14. 去掉 11-21 那版的起草时预览（`docs_preview`）：A 之后它只剩代价，没解决的问题记在 §7.4。
15. 按压和作业结束都不启动 agent 的回合；结果随你的下一句话送到（§4.3 第 6 步）。

### 12.2 待定

没有。`chatAutoSectionsPerDay` = 20、`readMaxChars` = 60,000 是起步的数，按 §14 量到的再调。

---

## 13. 契约与落点

| 层 | 文件 | 要点 |
|---|---|---|
| 契约 | `contracts/wiki.contract.json`、`docs/wiki-contract.md` 新增 `chat`、`docs.follow`、`docs.versions`；改 `agentSurface`（`wiki_draft`、聊天会话的 `wiki_propose`）、`jobs`（`onePerSpace` 的例外，§8.5）、`reviewModes`（按压的效果）；`docs/project-source-contract.md` 补聊天的 SOURCE | 状态向量、限额、文案；TS 与 Swift 钉回 |
| 迁移 | `wiki_chat_draft`；`wiki_doc_section_version`；`session.wiki_chat_space_id`；`wiki_job` 的新 kind 与索引 | 取号前扫 main、`project/*`、已推的 `orbit/*`；普查照规矩登记 |
| apiserver | 新 `wiki/wiki-chat.ts` 与 controller（建聊天、列聊天、草稿的读与按压）；`sessions.service.ts` 建会话的选项；`projects/session-source.ts`；`runner-api/control-plane-note.ts` 的附注；`wiki.service.ts` 的草稿分支；`wiki/wiki-docs.ts` 留版；`wiki/wiki-dossier.ts` | user 门 JWT，带会话头拒 |
| wiki-worker | 新 `docs_follow` 作业，复用 `runWikiDocsBuild` 的 `only`，加额外材料；`wiki-jobs.ts` | 合并排队、每日节数闸、被挡原因进 Activity |
| runner | `wiki_tools.go`、`wiki_cli.go`（`wiki_draft`、`wiki_read`，cli/mcp 对照、help、agent_instructions 三张表）；`worktree.go`（空分支清理） | 需要发版 |
| agent-first 修订（11-21、11-22）· 出处 | `wiki.service.ts` 的出处解析：`tool_call`、`event` 指向读 wiki 的调用一律 `WIKI_SOURCE_UNRESOLVED`；`src/shared/src/wiki.ts` 的 `WIKI_READ_TOOL`、`WIKI_READ_COMMAND` 加 `wiki_read`；写文档的材料去掉读 wiki 的调用；契约 §22.8、`maintenance.dossier.wikiReads` 照改 | 三处各一个 pg spec；先于 `wiki_read` 上线 |
| 同上 · 目录附注 | `wiki-chat-notes.ts` 加 `<orbit_wiki_contents>`（复用读已确认 plan 与写成节的函数）与「上次送达的版本」；`<orbit_wiki_chat>` 文字变了再送；`WIKI_CHAT_PROMPT`（`src/shared/src/wikiChat.ts`）按 §4.2 改；契约 `chat.notes` 加 `contents`；web `deliveredMessage.ts`、iOS 的附注标签 `Wiki contents` | 不用 runner 发版，单独就能解掉 11-21 那次对话 |
| 同上 · `wiki_read` | runner 的 `operation_catalog.go`、`wiki_tools.go`、`wiki_cli.go`（cli/mcp 对照、help、agent_instructions 三张表）；apiserver 的 runner 门读路由；契约 §11 的「五个工具」改六个、`TestWikiAgentSurfaceIsTheContracts`、`docs.tool`、`plan.who` 加聊天会话的只读、`readMaxChars` | 要 runner 发版 |
| 同上 · 方案 A | `wiki_draft` 的 rewrite 分支在边界内起草即排 `docs_follow`；`chatAutoSectionsPerDay` 与每日计数；不按就写的不给原话材料；同节等待；契约 `chat.drafts.states` 加 `Rewritten from main`、`chat.copy` 加两句 `Apply to write: …`，`agentSurface.notTools` 改措辞；web、iOS 的卡对照 | 端到端验收：在 wiki 首页说「把数据库 Schema 设计更新到 wiki」，agent 不让你开页面：有落后的节就直接重写、卡上带 `Undo`，没有就给出 plan 卡 |
| web | 从 `WorkspaceView.tsx` 抽实时流（`EventSource` 那个 effect）和 `Transcript` 外面那 9 层 provider，成可复用的会话组件；新 `WikiChatFab`、`WikiChatPanel`、`WikiDraftCard`、`WikiSeeChanges`、`lib/wikiChat.ts`；`WikiPage.tsx`、`WikiDocPage.tsx`；`deliveredMessage.ts` 的附注标签；`WikiActivityPage.tsx` 的 Docs 行 | 这是最大的一块：实时流和输入框都在这个 12,646 行的文件里。`Transcript` 本身已能单独用（分享页）。先做不改行为的拆分，再做面板 |
| iOS | `WikiDocView.swift`；`Console/ConsoleView.swift` 的 `TranscriptView` 放进 sheet，要核对依赖；OrbitKit 的状态逻辑与 `WikiCopy` 对照 | SwiftUI 只在 CI 编 |

---

## 14. 分期与还没量的

**第一步（web 桌面）：** 量 → 契约 → 留版 → 跟进 → 聊天会话 → 草稿与按压 → 拆分 → 面板与入口 → 选区与卡 → 端到端。

**第二步：** iOS；plan 卡（web 与 iOS）；owner 走查（部署、runner 发版、iOS 发版之后）。

**agent-first 修订（11-21、11-22）：** 出处校验补三处 → 目录附注与提示词（不用 runner 发版，先解掉「去开页面」）→ 方案 A → `wiki_read`（runner 发版）。出处一步必须先于 `wiki_read`。

**还没量的，排在最前面：**

1. 重写一节要多久（真实 System model）。
2. orbit space 有多少时间被作业占着，各是什么作业。这个数说明 §8.5 的例外值多少，也说明维护写文档时按下要等多久。
3. 新会话带 worktree 到首次回复要多久；一个 worktree 占多少磁盘。

交互按异步设计，这些数不改变流程，但决定手感。如果第 1 项要几分钟，要考虑按下后先显示「重写中」时左边的提示怎么写，也可能要给第 3 项做预热；到时再定，不提前做。
