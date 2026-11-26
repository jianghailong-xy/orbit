# 设计文档：会话列表在上千条 Open 会话下不再卡

状态：v1 · 2026-11-26 · D1 = A1、D2 = 只做 Web、D3 = @tanstack/react-virtual（owner 2026-11-26） · 起因：一个 workspace 的 `GET /sessions?runnerId=…&workspaceId=…&view=open&since=` 返回 `full: true` 共 1348 行，页面明显卡顿
影响面：`src/apiserver`（sessions）、`src/web`（WorkspaceView、BootGate、lib/sessionFolders、lib/sessionProjects）；原生端不在本期（§6 D2）
关联：[list-freshness-design.md](./list-freshness-design.md)（Open 列表的 `since=` 增量与版本）、[session-folders-move-design.md](./session-folders-move-design.md)（文件夹行）、`docs/mocks/session-list-scale/`（架构板）

---

## 1. 问题

两段代价叠在一起，都随 Open 会话数线性增长，而 Open 会话只会越积越多（`lifecycleState = OPEN` 只有手动 Complete 才离开；结束一轮的会话停在 `AWAITING_INPUT`）。

**A · 读得太多。** 一个有文件夹或项目的 workspace 不分页，整读该 workspace 的 Open 列表：

- `WorkspaceView.tsx:3267-3274`：`foldersShown || projectsShown || onFolderPage` 时 `limit: null`；`BootGate.tsx:172-176` 用同一个 key 预热整读。
- 理由写在 `WorkspaceView.tsx:3209-3212`：文件夹行的计数、标记和文件夹页都要它里面的每一个会话；项目行的位置取成员里最新的 `listedAt`（`lib/sessionProjects.ts` `sessionProjectListing`）。分组全在客户端做，所以必须先拿到全部行。
- 增量游标只在内存里（`lib/openListDelta.ts` 的 `held`），每次刷新页面、每个新标签页都是 `since=` 空串 → `full: true` 整包。服务端注释里"几百行约 1.5 MB"，1348 行按比例是数 MB（本期 T4 实测）。
- 已知决定：分页的 Open 读走普通分页、不走 `since=`，因为 `since=` 忽略 `limit`、总回整个范围（wiki「Paged Open lists keep plain read, not since= delta」）。

**C · 画得太多。** 拿到的每一行都进 DOM、每次都重渲染：

- 没有虚拟化：`renderSection`（`WorkspaceView.tsx:10471` 起）把每一行都画成 `SessionListRow`。
- `SessionListRow` 没有 memo；父组件（约 1.4 万行、状态很多）每渲染一次，就为每一行新建菜单数组、`swipe` 对象和 `onOpen` 闭包，1348 行全部重渲染。
- `folderListing` 的 memo（`WorkspaceView.tsx:3880-3905`）依赖 `selectedSession`、`watchingBySession`、`cloneHeardVersion`：每一帧 watch、clone 进度、打开会话的变化，都为全部行重算 `sessionLine` / `statusGlyphMotion`，再重建 `listedSessions` 和时间分组。
- 每次轮询或事件还有全表排序（`:3335`）、`reviewDueAt` 扫描、delta 合并等线性开销。

## 2. 目标

1. 一个 workspace 无论有多少 Open 会话，首屏读和首屏渲染的代价只跟**一页**有关（40 条顶层条目 + 文件夹行 + 项目行）。
2. 滚到多深，DOM 里的会话行数都只是**视口附近**那几十行；一帧 watch/clone 进度只重算看得见的行。
3. 列表长什么样不变：文件夹行的计数和标记、项目行的位置和第二行、Pinned / 时间分组、拖动归档、滑动操作、方向键、Move 对话框，都与今天逐条一致。

不做：Open 会话自动离开 Open（产品决定，另议）；原生端改读法（§6 D2）。

## 3. A：服务端按顶层条目分页

### 3.1 今天 vs 新

| | 今天 | 新 |
|---|---|---|
| 读 | `GET /sessions?view=open&workspaceId=…`（整读，`since=` 增量） | `GET /sessions/listing?workspaceId=…&view=open[&folderId=…]&limit=40[&after=…]` |
| 文件夹行 | 客户端把会话按 `folderId` 分组后数 | 服务端回 `folders[]`：每个文件夹的行数、needsYou、running、jobs |
| 项目行 | 客户端按 `projectMembership` 把成员收成一行，取最新成员定位 | 服务端回一条 `kind: 'project'` 条目，带协调者行和定位时间；成员不在列表里 |
| 文件夹页 | 从整读里筛 `folderId` | 同一个读带 `folderId`，同样分页 |
| 新鲜度 | `since=` 增量 | 普通分页读 + 版本 ETag（304），与现在无文件夹的分页 workspace 一样 |

### 3.2 读法

```
GET /sessions/listing?workspaceId=<id>&view=open|completed[&folderId=<id>][&limit=40][&after=<entry cursor>]
→ {
    folders: Array<{ folderId, rowCount, needsYou, running, jobs }>,   // 只在首页（无 after）且无 folderId 时给
    entries: Array<
      | { kind: 'session', session: SessionListItem }
      | { kind: 'project', projectId, placedAt, spokeAt, memberCount, coordinator: SessionListItem | null }
    >,
    next: string | null,     // 下一页的 after；null = 到底了
    restarted?: true,        // 只在 after 失效时给：这是重新开始的首页，客户端丢掉已有的页、换成它
  }
```

规则逐条照搬 `sessionProjectListing` / `sessionFolderListing` 今天在客户端做的事，由一份共享夹具（`contracts/session-listing.fixtures.json`）钉住，服务端 pg spec 和 web 单测都读它：

- **谁是顶层条目**：不在本 workspace 某个现存文件夹里的会话；被项目行"收走"的会话（项目的协调者在本 workspace 运行，或项目没有协调者）不单列，由项目条目代替。协调者在别的 workspace 的成员照旧是自己的行，带项目标记。
- **项目条目的文件夹**：协调者的 `folderId`；在文件夹页里只列 `folderId` 命中的条目。
- **顺序**：与今天一致，Pinned 在前，再按 `COALESCE(listed_at, created_at) DESC, created_at DESC`；项目条目的 `placedAt` 取它收走的成员里最大的 `listedAt`（无则 `createdAt`），Pinned 跟协调者。Completed 没有 Pinned，且照 `sessionProjectListing` 按"有没有会话被项目收走"切换：一个都没有时保持 `GET /sessions?view=completed` 的顺序（`COALESCE(completed_at, archived_at) DESC, created_at DESC`），有一个就全部按 `listedAt ?? createdAt` 排。
- **游标与重新开始**：`next` 记着写它时用的是哪种顺序。两页之间顺序切换了（Completed 在收走与否之间变化），旧的 `after` 不再能定位，回答就是新顺序的首页，带 `restarted: true` 和首页才有的 `folders`（无 `folderId` 时）；客户端此时丢掉已有的页、换成这一页，不往后追加。正常的下一页没有 `restarted`。
- **文件夹计数**：一个文件夹的行数（项目算一行）；needsYou / running / jobs 复用 `workspaceSessionCounts`（`sessions.service.ts:4110`）已有的判定，按 `folder_id` 再分一层，所以文件夹行、侧栏 workspace 行和行上的图标不会说两样话。
- **范围外不动**：Trash、按标签筛或按标签分组时列表是平的，继续走今天的 `GET /sessions` 分页读，不进这个新读。

项目行要的其余内容（等你的成员、跨 workspace 的会话数）今天已经由 `GET /sessions/project-placement`（`useSessionProjectData`）一次读回，不变。

### 3.3 新鲜度

- 首页和每一页都是普通 GET，带版本 ETag；版本没动回 304，不构建（`open-list-version.ts` 现有机制，scope 加上 `folderId`）。
- 流在线时只在 `sessions.list_changed` 提示或 60 s 兜底读时重读已加载的页（wiki「Web reads only on sessions.list_changed hint or 60s fallback」），断流走现有退避。
- 乐观编辑（置顶、改名、移动、Complete）照旧改缓存，随后的读纠正。移动到文件夹后，该会话从顶层页消失、文件夹行计数 +1：乐观改两处，读回为准。

## 4. C：只画看得见的行

1. **虚拟化会话列**：把 folder 行、各分组标题和会话/项目行展平成一条带类型的列表，交给一个窗口化渲染器，只挂载视口上下各约一屏的行。分组标题照旧是行，不另做 sticky 层。
2. **每帧只算挂载的行**：`sessionLine`、`statusGlyphMotion`、菜单、滑动按钮从 `folderListing` 的 memo 挪到行组件里，只在行挂载时计算；`SessionListRow` 改成按 id 稳定的 props + `memo`，菜单只在打开时构建。`folderListing` 的 memo 不再依赖 `selectedSession` / `watchingBySession` / `cloneHeardVersion`。
3. **行为保持**：方向键选中屏外的行时先 `scrollToIndex` 再聚焦；"接近底部加载下一页"改成看虚拟列表的最后一个可见索引；拖动会话到文件夹行照旧（文件夹行在列表最上面，拖动时自动滚到顶）；手机滑动和长按在行组件内不变；切 workspace / 视图回到顶部，返回列表恢复滚动位置。
4. **已知取舍**：浏览器自带的页内查找（⌘F）找不到没挂载的行；列表已有自己的搜索（⌘K 面板 / 文件夹内搜索），接受。

## 5. 落地（按依赖排）

| # | 内容 | 依赖 | 证据 |
|---|---|---|---|
| T1 | 服务端 `GET /sessions/listing`：顶层条目分页、项目条目、文件夹计数、版本 ETag；共享夹具；登记到路由/公开 id/写入等普查；`docs/api-reference.md` | — | 夹具驱动的 pg spec；1500 会话种子下首页构建耗时与字节数 |
| T2 | Web 改读 `listing`：WorkspaceView 与 BootGate 的整读换成分页条目，文件夹行用服务端计数，项目行用项目条目 + placement；文件夹页同读带 `folderId` | T1、T3（与 T3 同改 WorkspaceView 的列表区段，排在它之后免冲突） | 夹具驱动的单测；Vitest 全量；Playwright 文件夹/项目/拖动/方向键 |
| T3 | Web 虚拟化 + 每帧只算挂载行（§4） | —（与 T1 并行） | Vitest 全量；Playwright 方向键、拖动、滑动、加载更多 |
| T4 | 端到端测量：1500 Open 会话（含文件夹和项目）的种子，改前/改后：首读字节、首屏可交互时间、一帧 watch 的提交耗时、DOM 行数 | T2、T3 | 测量脚本 + 数字表 |

## 6. 决定（owner 2026-11-26：D1 = A1，D2 = 只做 Web，D3 = @tanstack/react-virtual）

**D1 · A 的形状**
- **方案 A1（推荐）**：服务端按顶层条目分页（§3）。首读、首屏只跟一页有关，与总量无关；代价是把"谁是顶层条目、项目行怎么定位"这套规则搬到服务端，用共享夹具保证两边一致。
- 方案 A2：保留客户端分组，服务端加一个精简索引读（每会话只带分组要用的约 15 个字段），整行按可见窗口按 id 取。规则不搬，但仍是 O(N) 的索引（1348 行估计 200–400 KB），且要维护索引和整行两层缓存。

**D2 · 原生端**
- **只做 Web（推荐）**：iOS/macOS/Android 的列表本来就懒渲染（SwiftUI List / LazyColumn），整读只在启动时一次，之后走 `since=` 增量常驻内存，卡顿主要在 Web。新读是加出来的，原生端以后要用随时接。
- 三端一起：三端行为与读法一致，但本期工作量约翻三倍。

**D3 · 虚拟化实现**
- **`@tanstack/react-virtual`（推荐）**：无样式、约 5 KB，动态行高靠 `measureElement`，与已在用的 `@tanstack/react-query` 同一家。
- CSS `content-visibility: auto`：零依赖，省布局和绘制，但 React 仍为每一行建元素，渲染代价不降。
