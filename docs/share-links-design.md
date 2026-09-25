# 分享链接：会话 / 任务 / 项目的公开只读链接

状态：设计已定（2026-09-25），按项目「分享能力」分 9 张任务落地。效果图在 `docs/mocks/share-links/01–07`（HTML 源 + PNG）。
本文是执行会话的契约：写代码前读它；实现与本文冲突时，先在任务评论里说清楚再改，别悄悄偏离。

## 1. 模型：一个链接 = 一个根对象 + 勾选的层

- 根对象恰好是 **Session / Task / Project** 之一。一个对象同时最多有一个开着的链接。
- 链接只读、免登录，token 本身就是凭据（192 bit，`randomBytes(24).toString('base64url')`，沿用现状）。
- 访客能看到的 = 根对象 + 勾选的层。**范围外的东西在公开页上不显示，也不能点。** 公开内容里的 Orbit 引用（orbit-task / orbit-session、Task started 卡片上的「Open the task ↗」、项目链接等），在范围内就跳到对应的公开页，在范围外只显示文字。一律不指向要登录的 app 路由。

| 层 | 项目链接 | 任务链接 | 会话链接 |
|---|---|---|---|
| Overview（锁定，总是包含） | Goal、Work overview、Task graph、Chain progress、Acceptance criteria、Tasks（标题+状态） | 标题/结果、判定方式、Description、Acceptance、Dependencies（同项目内）、Runs 列表 | Messages |
| Task pages | 默认开：任务可点开，内容同「任务链接的 Overview」 | — | — |
| Comments & files | 默认关（需先开 Task pages） | 默认关 | — |
| Conversations | 默认关：各任务的 Run + 本项目协调会话 | 默认关：本任务的 Run | —（它本身就是） |
| Tool output | 随 Conversations | 随 Conversations | 默认开；关掉时只留消息和工具名 |

每层在对话框里都写出**数量**（「29 comments」「14 transcripts」），让所有者按「会露出多少」来判断。

## 2. 设置

- **Access**：`Only you`（等于撤销）/ `Anyone with the link`。以后可以加「People signed in to this Orbit」，本期不做。
- **Updates**：本期只有 Live。对话框里写一行静态说明「Live — viewers see changes as they happen」，不放分段控件。Snapshot 不在本期范围。
- **Expires**：`Never`（默认）/ `1 day` / `7 days` / `30 days`。到期按撤销处理，采用惰性判断：公开解析时比较 `expires_at`。

## 3. 生命周期

| 事件 | 链接 |
|---|---|
| Access 改成 Only you | 记 `revoked_at`，立即 404。再开会新建一行、发新 token，旧 token 永不复活。 |
| 到期 | 同上，清单里显示 Expired，并提供「Share again」（新 token）。 |
| 会话进回收站 | 暂停：公开页返回与撤销**同一个** 404，不透露对象还在。Restore 后恢复。删除确认框和清单里要写明（`Paused · in Trash`）。回收站里的会话**不能**开启分享。 |
| 永久删除会话 / 删任务 / 删项目 | 外键 `ON DELETE CASCADE`，链接一起删除。项目和任务本来就是硬删除。 |
| 任务 Superseded / Abandoned | 页面照常，显示「Superseded by …」；后继任务在范围内才能点。 |
| 项目 Completed / Cancelled | 页面照常，显示终态。 |

## 4. 数据模型（新表 `share_link`）

- `id uuid`、`owner_id uuid`、`token text UNIQUE`。
- `session_id` / `task_id` / `project_id`：三个可空外键，都是 `ON DELETE CASCADE`，并加 `CHECK (num_nonnulls(session_id, task_id, project_id) = 1)`。
- `include jsonb`：键为 `taskPages`、`commentsAndFiles`、`conversations`、`toolOutput`。缺失的键按第 1 节的默认值处理。
- `expires_at`、`revoked_at`、`revoked_reason`（`TURNED_OFF` | `EXPIRED`）、`view_count int default 0`、`last_viewed_at`、`created_at`、`updated_at`。
- 三个部分唯一索引：`(session_id) WHERE revoked_at IS NULL`，task、project 各一个同样的索引。
- 迁移把现有 `session.share_token` 原样回填成 `share_link` 行（token 字符串不变，旧 `/s/<token>` 继续有效）。`session.share_token`、`shared_at` 两列不再写入，标 deprecated，留给以后单独删除。
- `view_count` 只在打开根页时（`GET /shared/:token`）加一。翻页、附件和子页面都不计数。

## 5. 接口

所有者接口（JWT，按 `ownerId` 过滤）：

- `GET|PUT|DELETE /sessions/:id/share`、`/tasks/:id/share`、`/projects/:id/share`。
  - `PUT` 的 body 是 `{include?, expiresAt?}`：没有链接时新建，有链接时修改，是幂等的。
  - `DELETE` 等于 Access → Only you。
  - 旧接口 `POST /sessions/:id/share` 保留：用默认值 upsert，返回 `{shareToken, sharedAt}`，给还在用的旧 iOS 版本。会话详情里的 `shareToken` 继续返回。
- `GET /share-links`：管理页用。每行包含 kind、目标的最小投影（id、title、状态）、include、到期时间、访问次数、最近访问时间，以及 `state`（`ACTIVE` | `PAUSED` | `ENDED`）和原因。
- `DELETE /share-links/:id`：单个撤销。批量关闭（例如「30 天前完成的会话」）走显式的 id 列表。

公开接口（无 JWT；`token` 已在 `public-id-coverage.spec.ts` 的 `NON_ID_PARAMS` 里）：

- `GET /shared/:token`：返回 `{kind, include, sharedAt, root}`。
  - 会话根：保留旧字段（title、各状态字段、createdAt、workspaceName），另加 `events` = 尾部一页、`hasMore`，旧页面照样能渲染。
- `GET /shared/:token/events?before=&limit=`：翻页。`GET /shared/:token/events/:seq`：取单条全文。
  - 这两条只对会话根生效。范围内的其他会话走 `/shared/:token/sessions/:sessionId/...`，形状相同。
- `GET /shared/:token/tasks/:taskId`：项目链接内的任务页，要求 Task pages 已勾选，且任务属于该项目。
- `GET /shared/:token/sessions/:sessionId`（以及 `/events`）：范围内的对话记录。要求勾了 Conversations，并且会话是范围内任务的 Run，或本项目的协调会话。会话在回收站 → 404。
- `GET /shared/:token/attachments/:id`：只返回范围内会话的附件。
- `GET /shared/:token/artifacts?path=`：**只返回已经落库的附件**。不往所有者会话里插 turn，不叫 runner 取文件，不扫描整段 run_event。
- 所有 `/shared` 响应带 `Cache-Control: no-store` 和 `X-Robots-Tag: noindex, nofollow`，并按 IP+token 做进程内限流（超限返回 429）。web nginx 给 `/s/` 加 `X-Robots-Tag: noindex, nofollow` 和 `Referrer-Policy: no-referrer`。
- 公开投影各写一个**显式 select**，不复用所有者 DTO（`GET /tasks/:id` 会把整行展开返回）。每种投影配一条否定断言的 spec：响应全文里不能出现第 6 节列出的字段名和值。

## 6. 红线：勾什么都不会公开

- 账号：owner 与用户的 id、邮箱、姓名。人写的评论一律署名「Owner」，agent 写的署工作区名。
- 机器：runner 名、workDir、任何本机路径根（`/root/…`、`~/.orbit/…`）。
- 代码：仓库地址、分支名、SHA、合并检查命令、merge 回执细节。落地状态只说 on main / not on main yet / no merge receipt either way。
- 算力：provider、模型、账号池成员、费用、token 用量。
- 项目内部：Instructions、Open items、Blockers、Run queue、Coordinator 卡（Workspace、Wake-ups、Self-started）、Crossings、Attribution、Followed by、派发/收敛/验证的内部字段、评论 @ 投递记录。
- 跨项目依赖：只写「N prerequisite(s) in another project」，不给标题。
- 所有者的动作：Delete、Run、Resolve、Merge、Reply……在公开页上一个都不渲染。

## 7. 公开页

同一个外壳：品牌 + 面包屑（即范围）+ 右侧「● Live」/状态 + `Read-only`，底部是 `Shared from Orbit · read-only`。

- **项目页**：app 项目页的 16 个区块只保留 7 个，顺序不变：Header（去掉三个动作）→ Work overview（去掉横幅；Coordinator 卡整张不出现，勾了 Conversations 时换成一行「Coordinator conversation ›」）→ Goal → Task graph → Chain progress → Acceptance criteria（文案一字不改）→ Tasks（去掉 New task 和判据摘录）。手机宽度沿用 web 手机布局。
- **任务页**：区块顺序照 app 的任务面板：Header（结果 + 判定方式 + 时间）→ Dependencies → Description → Acceptance → Runs → Comments（要勾选）。Runs 只列状态、时间和时长；勾了 Conversations 才出现「View conversation ›」，否则写「Conversation not shared」。
- **对话页**：现有 Transcript 组件不改，只接一个「按范围解析链接」的 resolver。页头显示会话状态；Download HTML 保留。

## 8. 入口与文案（英文 UI）

- 统一两个词：`Copy link` 是给自己用的登录链接；`Share…` 打开公开设置。开着链接时，入口显示 `Shared · Live` 或 `Share… · Live link`。
- web：
  - 会话 ⋯：Copy link / Share… / Download HTML。
  - 任务 ⋯：Copy link / Share… / Copy as Markdown。
  - 项目页头：状态胶囊 + Copy link；项目 ⋯ 菜单加 Copy as Markdown。
  - 会话列表：已公开的会话在时间旁显示地球图标。
- 管理页：Settings → `Shared links`（`/settings/shared-links`）。
  - 结构照 Following 页：tab 为 Active / Paused / Ended。
  - 提示条：「N links are for sessions completed more than 30 days ago.」，配「Turn off these N」。
  - 每行三个动作：Copy / Settings / Turn off。
- iOS/macOS：
  - 项目菜单里现在的「Share link」（分享登录地址）改名为 `Copy Link`，新增 `Share…`。
  - 分享面板是对话框的 Form 版：Access Picker → 链接、Copy Link、Share Link… → Includes 开关 → Expires → 访问次数。
  - 会话、任务、项目共用这一个面板。
- 对话框的关闭确认：`Turn off this link?` / `Anyone who has it loses access right away.`
- 对话记录层的风险提示固定写作：`Can include command output and file contents.`

## 9. 不做（本期）

Snapshot；「People signed in to this Orbit」；agent 通过 MCP 创建公开链接（以后要做也必须走确认卡）；搜索引擎收录开关（一律 noindex）；公开页上的评论和反应。
