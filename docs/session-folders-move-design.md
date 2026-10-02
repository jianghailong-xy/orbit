# 会话的 Share / Move：文件夹与搬到其他 Workspace

状态：已定稿（2026-10-02）。文件夹用方案 B（进入单独的文件夹页），搬家规则已确认，按项目分任务落地。效果图在 `docs/mocks/session-move/01–03`（HTML 源 + PNG）。
本文是执行会话的契约：写代码前读它；实现与本文冲突时，先说清楚再改，别悄悄偏离。

## 1. 范围

- iOS 会话列表左滑新增 **Share** 和 **Move**，与原有的 **Delete** 并排。
- 新概念 **文件夹**：属于某个 Workspace，一个会话最多在一个文件夹里。
- **Move** 一个入口两种去处：移到当前 Workspace 的某个文件夹；或者搬到其他 Workspace（可同时选那边的文件夹）。
- 本期只做 iOS 界面。macOS 共用 SwiftUI，但列表不显示文件夹，新按钮也只在 iOS 出现；web 照常平铺列表。数据层对三端一致：web / macOS 看到的会话归属（Workspace）是对的，只是不分文件夹。

## 2. 左滑与长按

| 列表 | 左滑（从左到右） | 右滑 | 长按菜单新增 |
|---|---|---|---|
| Open | Share · Move · Delete | Complete · Pin（不变） | Share…、Move… |
| Completed | Share · Move · Delete | Move to Open · Pin（不变） | Share…、Move… |
| Trash | Delete Permanently（不变） | Move to Open（不变） | 无 |

- **Share**：蓝色，`square.and.arrow.up`。打开会话页右上角那个分享面板（同一个 `ShareSheet(kind: .session)`）。回收站的会话不能开分享（`share-links-design.md` §3），所以 Trash 不出现。
- **Move**：靛蓝，`folder`。打开 Move 面板（第 4 节）。
- **Delete**：红色，在最外侧，仍然 `allowsFullSwipe: false`。
- 按钮的形状（原生胶囊还是自绘圆形）由「滑动按钮圆形设计」那条线决定；这里只定清单、顺序、颜色。
- 长按菜单是左滑的“正本”：左滑有的动作，长按里都要有（`SessionRowActions.swift` 文件头的约定）。

## 3. 文件夹

### 3.1 模型

- 新表 `session_folder`：`id uuid`（uuid7）、`owner_id`、`workspace_id`（`ON DELETE CASCADE`）、`name text`、`created_at`、`updated_at`。
  - `UNIQUE (workspace_id, name)`：同一个 Workspace 里不重名。
- `session.folder_id uuid NULL`，外键指向 `session_folder(id)`，`ON DELETE SET NULL`，加索引。
  - 单列外键，不做 `(folder_id, workspace_id)` 复合外键：Prisma 的 `onDelete: SetNull` 会把复合外键的每一列都置空，删文件夹会连带清掉 `workspace_id`。同 Workspace 的约束放在服务层：只有 Move 接口写 `folder_id`，它在同一条 UPDATE 里一起写 `workspace_id` 和 `folder_id`，并校验文件夹属于目标 Workspace。
- 文件夹只是归类，不影响运行：派发、模型、权限、合并都不读 `folder_id`。
- 会话进回收站时保留 `folder_id`，Move to Open 后回到原文件夹；文件夹已被删则回到列表。

### 3.2 接口

- `GET /session-folders`：当前用户全部文件夹（各 Workspace 的都在内），按名字排序。返回 `id, workspaceId, name`。
- `POST /session-folders`：`{workspaceId, name}`，名字 1–60 字、去首尾空格；重名返回 409。
- `PATCH /session-folders/:id`：`{name}`。
- `DELETE /session-folders/:id`：只删文件夹，里面的会话由外键置空，回到列表。
- 会话的移动统一走 `POST /sessions/:id/move`（第 5 节）。
- `POST /sessions`（新建会话）接受可选的 `folderId`：文件夹页里新建的会话直接落在这个文件夹。文件夹必须属于这次新建所在的 Workspace，否则 400。
- 实时推送：文件夹的增删改发用户级事件 `FOLDER_CHANGED`（同 `TAG_CHANGED`，`run_event.type` 是字符串列，不用迁移）；会话移动发 `publishSessionUpdated`。
- 会话列表和详情的返回体加 `folderId`。

### 3.3 列表呈现

文件夹排在列表最上面，按名字排序；下面照旧是 Pinned 和时间分组。进了文件夹的会话不再出现在时间分组里。

文件夹行：`folder` 图标 + 名字 + 会话数。因为里面的会话不在外面露面，文件夹行要替它们报状态，规则同抽屉里的 Workspace 行（`WorkspaceNavigationStatusLogic`）：有会话等你 → 琥珀色数字；有会话在跑 → 转圈。

点文件夹行进入**文件夹页**（方案 B，见效果图 02 中间那台）：

- 标题是文件夹名，下面一行小字是 Workspace 名；返回回到这个 Workspace 的列表。
- 右上角 `⋯` 里是 `Rename…`、`Delete Folder…`；`✎` 新建的会话直接落在这个文件夹（新建请求带 `folderId`）。
- 列表和外面一样：Pinned 在前，然后按时间分组；行、左右滑、长按都相同。
- 文件夹页沿用打开它时列表的范围：从 Open 进来看 Open 的会话，从 Completed 进来看已完成的。
- iPhone：推到 Agents 那一栏的导航栈上（`NavNode` 新增一种页面），系统返回键和左缘右滑返回都可用；在文件夹页里点开会话，返回时回到文件夹页。
- iPad（三栏）：中间栏现在没有自己的导航栈。进文件夹时中间栏换成这个文件夹的列表，栏顶有返回按钮；右侧详情栏照旧跟着选中的会话走。中间栏和 iPhone 用同一个列表视图，只是进出方式不同。
- 被选中的会话搬出了当前文件夹（或文件夹被删）时，页面不跳走，列表里那一行消失即可；文件夹被删时退回 Workspace 列表。

其他规则：

- Open 显示全部文件夹（包括空的）；Completed 只显示里面有已完成会话的文件夹；Trash 平铺，不显示文件夹。
- 按标签筛选或 Group by Tag 时不显示文件夹，列表平铺，避免两套分组叠在一起。
- 搜索结果本来就是跨 Workspace 平铺的，不变。
- 文件夹的分组在客户端算：Open / Completed 列表本来就是整页拉取再按 Workspace 过滤（`AgentsModel.loadSessions`），按 `folderId` 再分一次即可。纯函数放 OrbitKit，带单测。

### 3.4 管理

- 新建：Move 面板里的 `New Folder…`（建好直接把当前会话放进去）；列表右上角 ≡ 菜单里的 `New Folder…`。
- 改名、删除：长按文件夹行 → `Rename…`、`Delete Folder…`。删除确认：`Delete “<name>”?` / `The N sessions in it move back to the list. No session is deleted.`

## 4. Move 面板

原生 sheet（medium / large 两档），样式同标题里的 Workspace 切换面板（`AgentSwitchSheet`）。

- 标题 `Move`，下面一行灰字是会话标题；右上 `Done`。
- 第一组 `Folder in <workspace>`：`No Folder`、各文件夹（带会话数）、`New Folder…`。当前所在的打勾。点一下立即移动、面板关闭，顶部 toast `Moved to “<name>”`。
- 第二组 `Move to Another Workspace`：列出其他 Workspace（品牌标 + 名字 + `<provider> · <runner>`）。点进去选放在那边哪个文件夹，再确认（第 5 节）。不能搬的 Workspace 置灰并写原因；会话本身不能搬时整组置灰，组下写原因。

## 5. 搬到其他 Workspace

一句话：**搬走的是对话，代码留在原地。** 下一条消息在新 Workspace 的目录、runner 和设置下继续这段对话；到目前为止的改动留在原 Workspace 仓库里这个会话的分支上，不删除，也不带走。

### 5.1 搬走什么、留下什么

| | 搬家后 |
|---|---|
| 会话本身（标题、Orbit 里的完整记录、标签、置顶、分享链接） | 跟着走 |
| 文件夹 | 换成目标 Workspace 里选的文件夹，或不在文件夹里 |
| Agent 记得的对话 | 跟着走，怎么接见 5.2 的表 |
| 运行环境：目录、runner、系统提示、环境变量、工具和权限规则、默认合并目标 | 下一轮起全部用新 Workspace 的 |
| 运行时、模型、effort | 不变（Claude 会话还是 Claude；运行时本来就不能中途换，见 `resolveProviderSwitch`） |
| 已做的代码改动 | 留在原仓库的会话分支上（结束时 runner 会把未提交的改动收成一次提交）。新 Workspace 里从它自己仓库的最新代码新建检出，分支名不变。例外：同一台 runner、两个 Workspace 是同一个仓库时，检出原样接上，代码也是连着的 |
| 账号槽位（`claudeAccount` / `codexAccount`） | 同一台 runner：把当前实际在用的账号写到会话上，不跟着新 Workspace 悄悄换账号（空值的意思是“跟随 Workspace”，Codex 的对话又存在账号目录里）。换 runner：清空，跟随新 Workspace（槽位 id 只在本机有效） |

### 5.2 什么时候能搬

会话自身：

- 必须先**结束**（没有 runner 在托管它）。只有结束时 runner 才会收尾提交；没结束就改归属，原 runner 会直接撒手，未提交的改动会被晾在原机器上。
  - 空闲但还没结束的会话：确认框的按钮写 `End and Move`，先结束再搬，一步完成。
  - 正在跑、有排队的消息、在等审批：不能搬，写 `Stop the session first.`
- 不能搬：回收站里的会话；任务的执行会话（归属跟着任务走，暂停的执行会话也按 Workspace 找回）；项目的协调会话（协调位置是项目设置；0164 之后数据库不再拦，只能由搬家接口拦）；还在导入中的会话。
- 暂时不能搬，过一会儿再试：正在结束、合并或提交进行中、合并修复还没处理完、等自动重试。
- 派生出来的子会话可以搬（子会话本来就能建在别的 Workspace）。
- 需要结束时，原 runner 必须在线（收尾提交在它那里做）。已经结束的会话没有这个要求。

运行时 × 目标 runner：

| 会话的运行时 | 同一台 runner 上的其他 Workspace | 其他 runner 上的 Workspace |
|---|---|---|
| Claude | 能。对话原样接上：runner 把对话记录从旧目录搬到新目录 | 能。Orbit 用存下来的记录重建：最近约 10 万 token 原样保留，更早的部分是摘要，图片和思考过程不带 |
| Codex | 能。按 thread 接上，换个工作目录即可 | **不能**。Codex 的对话只存在原机器上 |
| Kimi、OpenCode | 本期不支持（续接方式没验证过） | 本期不支持 |

目标 Workspace：

- 自己的、没删除、没停用；它的 runner 能跑这个会话的运行时，否则置灰写 `<runner> can't run <Runtime>`。
- 目标 runner 必须已经升级到支持搬家的版本（5.5），否则置灰写 `Update <runner> to move sessions here`。
- runner 离线时可以选（只是改归属，下一条消息会排队等它上线），行上写 `Runner offline`。

### 5.3 确认框

标题 `Move to <workspace>?`，正文按情况拼，例子：

- `The conversation moves with it. Your next message continues it in <workspace>.`
- 换 runner 的 Claude 会话加一句：`Earlier parts of the conversation are summarized for the agent.`
- 有改动时加一句：`Changes made so far stay on branch <branch> in <old workspace>.`；还有没合并的改动时写成 `3 changed files aren't merged into <target> yet. They stay on branch <branch> in <old workspace>.`
- 按钮：`Cancel` / `Move`（需要先结束时是 `End and Move`）。

搬完回到原列表，顶部 toast `Moved to <workspace>`；会话从当前列表消失，出现在目标 Workspace 的列表里。

### 5.4 控制面

- `GET /sessions/:id/move-targets`：给 Move 面板用。返回当前 Workspace 的文件夹，以及其他每个 Workspace 能不能搬、不能的原因（文案由服务端给，客户端只渲染），还有这次搬家要不要先结束。判断依据（runner 能力、在线状态、运行时）只有服务端齐全。
- `POST /sessions/:id/move`：`{workspaceId?, folderId?}`。
  - 只换文件夹：同一个 Workspace 内，任何非回收站状态都可以，运行中也可以。
  - 换 Workspace：先 `FOR SHARE` 锁目标 Workspace（`deleted_at IS NULL AND enabled`，同 `rebindCoordinator`；锁序 workspace 在 session 之前，`common/lock-order.ts`），再锁会话行，重新检查 5.2 的条件（不满足返回 409 和原因），然后一条 UPDATE 写完：
    - `workspace_id`、`folder_id`；
    - `assigned_runner_id` 改成目标 Workspace 的 runner。派发、续接、web 列表都按这一列找会话，它建好后从来没被改过，这里是第一处；
    - `branch` 保留原名，只在两边的 worktree 设置不同时生成或置空。`sessions.service.ts` 建会话处写着“分支一经确定不再改，因为 runner 可能已经建了检出”，5.5 的“检出认仓库”就是让这条在搬家时依然成立；
    - 清空描述旧检出的列：`base_sha`、`changed_files`、`isolation_status`、`merge_status` 一组、`branch_merged`、`worktree_branch`、`worktree_dirty`、`merge_target(s)`；
    - 账号槽位按 5.1 处理。
  - 之后：`publishSessionUpdated`；两个 Workspace 都发 `publishWorkspaceChanged`（Workspace 的默认运行时取自它最新的会话，搬家可能改变两边的默认值）；清掉 `RealtimeService` 里这个会话的 owner 缓存（缓存的 `workspaceId` 平时只在会话结束时淘汰）。
  - 新事务登记进 `common/db-write-inventory.ts`。
  - `End and Move` 由客户端编排：先 `POST /sessions/:id/end`，等会话变成已结束，再调 move。move 自己只认已结束的会话，中间若被新消息唤醒就返回 409。
- `POST /runner/sessions/worktrees-removable`：会话已搬到别的 runner 时，也算这台 runner 上的旧检出可回收。目前只看会话是否关闭，搬走的会话在原机器上的检出会一直留着。回收时分支保留，只删目录；有未提交改动的检出 runner 本来就不删。

### 5.5 Runner（新能力 `session-move/v1`）

1. **检出认仓库**：`setupWorktree` 复用 `worktreesDir()/<sessionId>` 下的旧检出之前，先核对它属于这次任务的仓库（`--git-common-dir`）且 HEAD 是这次的分支。不符就先退役旧检出：在它自己的仓库里 `worktree remove`，分支保留；有未提交改动就整个挪到旁边保存。然后新建检出。现在只看“是不是 git 目录”，同一台机器搬到另一个仓库时，agent 会悄悄继续改旧仓库，合并也会失败。
2. **Claude 对话搬目录**：`ensureClaudeTranscript` 在重建之前加一步：从本会话上次的执行目录（记在 `runs/<id>/meta.json`）的位置，把对话记录原样复制到新目录的位置，并改写 `cwd`（`copyTranscriptRewritingCwd` + `copyClaudeConversationDir`）。只认上次的确切目录，不去全盘搜同 id 的文件，和现有注释的立场一致。复制不成再走现有的重建。
3. 只有声明了这个能力的 runner 才会被列为可搬入的目标。

### 5.6 客户端要跟着改的地方

- `SessionUpsert` 收到会话更新时沿用行里原来的 `agent`，列表又按 `agent.id` 分组，搬走的会话会在旧 Workspace 里多待到下一次 4 秒刷新。`agentId` 变了就要换成更新里带的 `agent`。
- `FOLDER_CHANGED` 在 Swift 里要有自己的分支去重新加载文件夹。现在没认出的事件只会刷新 Open 列表（`TAG_CHANGED` 就是这样，别的设备改了标签库，这边不会重新加载）。
- 新增的 `Session.folderId` 等字段一律 `decodeIfPresent`，老服务器不返回也能解码。

### 5.7 这一期不做

- 代码跟着搬（推送分支、跨机器传改动）。
- Codex 跨 runner、Kimi、OpenCode 的搬家。
- web 和 macOS 的 Move 入口与文件夹显示。

## 6. 分两期做

1. **第一期：Share + 文件夹。** 迁移 0343（`session_folder` + `session.folder_id`）、文件夹接口、`POST /sessions/:id/move` 只支持换文件夹、新建会话带 `folderId`、`FOLDER_CHANGED`；iOS 的左滑 Share / Move / Delete、Move 面板的文件夹部分、列表里的文件夹行和文件夹页、文件夹管理。只动 apiserver 和 iOS，不碰 runner。
2. **第二期：搬到其他 Workspace。** `move-targets`、move 的换 Workspace 分支、`worktrees-removable` 的调整；runner 的 `session-move/v1`（检出认仓库 + Claude 对话搬目录）；iOS 面板下半、确认框、End and Move。
   - 发布顺序：先部署 runner 和 apiserver，再发 iOS beta。目标 runner 没升级时，面板里那一行是灰的，不会出错。
