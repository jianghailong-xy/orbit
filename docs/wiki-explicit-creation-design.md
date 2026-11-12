# Orbit Wiki：wiki 只由 owner 建（2026-11-12）

> 状态：设计，等 owner 定 D1–D3。它改的是 `docs/wiki-design.md` §2.1、§12.3.1，`docs/wiki-contract.md` §2.1（`:218`）和
> `plan.jobs.triggers` 里「会话提议时隐式建的 space」这一条；知识模型、审阅模式、维护、System model 都不变。
>
> 效果图：`docs/mocks/wiki/46-explicit-creation.html`（第 1–6 部分）。

---

## 0. 一页结论

1. **今天，agent 的一次 `wiki_search` 就能建出一个 wiki。** 每个会话的系统提示都让 agent「改文件之前先用 `wiki_search` 搜这个路径」；
   服务端处理任何 wiki 工具调用（search、get、propose、draft、note）时，只要 workspace 有 `repo_url`、这个仓库还没有 space，就当场建一个，
   并排一次 plan 起草。
2. **以后 wiki 只有 owner 能建。** 入口是 `POST /api/wiki/spaces`（Create wiki 表单）。工具调用不再建 space。
3. **没有 wiki 时，读照常回答，写被拒。** `wiki_search`、`wiki_get` 回答空结果并附一句说明；`wiki_propose`、`wiki_note`、`wiki_draft`
   以 `WIKI_SPACE_UNBOUND` 拒绝，原因写「这个仓库还没有 wiki」。
4. **补上「建第二个 wiki」的入口。** 今天 `Create wiki…` 只在账号一个 wiki 都没有时出现（`WikiFirstStartCard`），所以后来的四个 wiki
   全是隐式建出来的。新入口是侧栏 Wiki 组的最后一行 `New wiki…`，以及 wiki 页头切换器的最后一项，打开的就是现有的 Create wiki 表单。
5. **已有的 wiki 不动。** 被 owner 用起来的三个保留；`lfs-builder` 由 owner 移进 Trash，修复上线后它不会再回来。

---

## 1. 起因（2026-11-12 在生产库核实，只读）

### 1.1 lfs-builder 这个 wiki 是怎么来的

| 时间（UTC） | 事 |
|---|---|
| 11-11 16:27:30.421 | workspace `lfs`（`git@github.com:jianghailong-xy/lfs-builder.git`）里一个探测内网 WireGuard 的会话调 `orbit__wiki_search`，`query: "/etc/wireguard/wg1.conf"` |
| 16:27:30.819 | `wiki_space` `github-com-jianghailong-xy-lfs-builder` 建成（`bindOnFirstUse`） |
| 16:27:30.856 | `wiki_space_workspace` 把 `lfs` 绑进去 |
| 16:27:30.923 | `wiki_plan_job` `draft`，`trigger = space_created`，`requested_by_user_id = null`，因 `no_maintenance_workspace` 挂起 |

这个会话根本不是在做 `lfs-builder` 的代码，只是想改一个系统文件，照提示先搜了一下。

### 1.2 账号里所有 wiki 的来历

| wiki | 建于 | 怎么建的 | 之后 owner 用了吗 |
|---|---|---|---|
| `github-com-jianghailong-xy-orbit` | 09-26 | 起草作业出现之前，无从判断 | 用：22,368 条，4 个 workspace |
| `orbit-vllm-preview` | 09-27 | 同上 | 14,165 条 |
| `github-com-jianghailong-xy-wikova` | 10-07 | **隐式**（起草作业 `requested_by_user_id` 为空） | 用：开了维护，确认了 plan，6 个审阅决定，81 次运行 |
| 一个 gitlab 上的文档仓库 | 10-15 | **隐式** | 用：59 个审阅决定，120 次运行 |
| 一个公司 git 上的服务仓库 | 10-28 | **隐式** | 用：96 个审阅决定，95 次运行 |
| `github-com-jianghailong-xy-lfs-builder` | 11-11 | **隐式** | 没用：0 条，维护关着 |

从来没有一个 wiki 是从 Create wiki 表单建的：`trigger = space_created` 且 `requested_by_user_id` 不为空的起草作业是 0 个。

结论：隐式建出来的四个里有三个后来被用起来了。原因不是隐式建有多好，而是**账号已经有 wiki 之后，界面上没有别的办法再建一个**（§2.3）。

---

## 2. 代码里的原因

### 2.1 读也会建

| 位置 | 事实 |
|---|---|
| `src/runner-go/agent_instructions.go:141` | `orbitWikiPathInstructions`：「Before changing a file, use wiki_search with its path…」，进每个会话（11-05，`0b934cea2`） |
| `src/apiserver/src/runner-api/runner-wiki.controller.ts` | `GET search`（:106）、`POST changesets`（:138）、`POST drafts`（:183）、`POST notes`（:241）、`GET entries/:id`（:398）都先调 `resolveSpaceForCall` |
| `src/apiserver/src/wiki/wiki.service.ts:958` `resolveSpaceForCall` | workspace 没有绑定行、但有 `repo_url` → `bindOnFirstUse` |
| `wiki.service.ts:1007` `bindOnFirstUse` | 同仓库没有 space 就 `createSpaceRow`，再 `spaceCreated` 排起草作业（:1048） |

### 2.2 和已定的设计相矛盾

- `wiki-design.md` §12.3.1（owner 2026-11-02 定）：「**建 wiki 就等于开维护：没有『只建不开』，那种 wiki 什么也不会发生。**」
  隐式建出来的 space 维护是关着的（`WIKI_DEFAULT_MAINTENANCE_SETTINGS.enabled = false`），正是「只建不开」的那种。
- 契约 `plan.jobs.triggers` 写的是「会话**提议**时隐式建的 space」，代码却是任何工具调用都会建，读也会建。
- 移进 Trash 之后，下一个会话再搜一次就会建出一个新的空 wiki（`resolveSpaceForCall` 的注释：「made empty if there is none」），
  所以 owner 今天删不掉一个不要的 wiki。

### 2.3 第二个 wiki 没有入口

`Create wiki…`（`WIKI_CREATE_OPEN`）只在 `WikiPage` 读到零个 space 时画（`WikiFirstStartCard`，`src/web/src/pages/WikiPage.tsx:119`）。
侧栏 Wiki 组只有各个 wiki 的行和 Trash 行；页头切换器只列已有的 space。iOS、macOS、Android 也一样（`WikiStartLogic.create` 只用在第一个 wiki 的卡上）。

---

## 3. 新的规则

### 3.1 谁能建 space

| 入口 | 今天 | 新 |
|---|---|---|
| `POST /api/wiki/spaces`（Create wiki 表单） | 建 space、开维护、起草 plan | 不变 |
| 会话的 wiki 工具（任何一个） | 仓库没有 space 就建 | **不建** |
| 带会话头调 `POST /api/wiki/spaces`（agent 用 PAT 直接调路由；runner 的 CLI 没有这个命令） | 允许，只是不能带 `maintenance` | `WIKI_OWNER_CHANNEL_ONLY`（403），同 review mode 的规矩 |
| 管理员、导入、维护作业 | 不建 | 不变 |

`spaceCreated`（起草作业，`trigger = space_created`）以后只有 `createSpace` 一个调用方。

### 3.2 workspace 怎么进 wiki（不变的部分）

- 仓库和 space 相同的 workspace 照旧**读取时**就算在这个 space 里（`wiki/wiki-workspaces.ts`），不需要写行。
- 第一次调工具时写一行 `wiki_space_workspace` 也照旧，只是只对已有的 space 写。
- 没有仓库地址的 workspace 照旧由 owner 在 Wiki 设置里加入。

### 3.3 会话在没有 wiki 的 workspace 里调工具

「没有 wiki」指：workspace 没有绑定行，且（没有 `repo_url`，或者同仓库没有在用的 space）。被 owner 留在外面（`leftOutAt`）的照旧拒绝，不在此列。

| 工具 | 回答 | 说明文字（英文，agent 读） |
|---|---|---|
| `wiki_search` | `200`，`{ q, semantic: false, hits: [], unavailable: "no_wiki" }` | runner 把它渲染为 `No wiki for this repository yet, so there is nothing to look up. Carry on without it.` |
| `wiki_get` | `404`，`WIKI_SPACE_UNBOUND` | `This workspace has no wiki.` |
| `wiki_propose`、`wiki_note`、`wiki_draft` | `409`，`WIKI_SPACE_UNBOUND`（D1 = A） | `No wiki for this repository yet: the owner creates one in Wiki (Create wiki…). Nothing was recorded.` |

- 仓库有 space 但在 Trash：搜索同上（空），写入的原因换成 `The wiki for this repository is in Trash: the owner restores it from Trash.`
- `wiki_search` 回答空结果而不是报错，是因为系统提示要求每次改文件前都搜一次：报错会让 agent 停下来解释，空结果不打扰它。
  今天没有仓库地址的 workspace 每次搜索都报 `WIKI_SPACE_UNBOUND`，这次一并改成空结果。
- `unavailable` 是 `WikiSearchOutcome` 新加的可选字段，闭集 `["no_wiki", "wiki_in_trash"]`，在契约里登记；
  有了它，「搜过但没搜到」和「根本没有 wiki」就能分开。
- 搜索空结果也照旧记录曝光（`recordExposure`，0 条）吗？不记：没有 space 就没有可记的 space id。

### 3.4 建第二个 wiki 的入口

- **侧栏 Wiki 组**（web `TasksSidePanel.tsx`；iOS、macOS 抽屉；Android 抽屉）：各个 wiki 的行之后、Trash 行之前，加一行 `New wiki…`。
  图标用 `PlusOutlined`（web）/ `plus`（SF Symbols）/ `Icons.Outlined.Add`，灰字，样式照 Trash 行（`tp-item tp-wiki-trash`），不带计数。
- **wiki 页头的切换器**：列表最后、分隔线下面加一项 `New wiki…`。
- 两个入口打开的都是**现有的** `WikiCreateDialog`（「下拉框按仓库分组，没有仓库的 workspace 不列」），提交照旧走 `POST /wiki/spaces`，
  一次建 space、开维护、起草 plan，成功后进新 wiki。已经有 wiki 的仓库在下拉框里灰掉，并标 `Has a wiki`（同一仓库只能有一个 space：
  `unique (owner_id, repo_url_norm)`；今天重复提交会撞这个约束、答 500，改为先查、答 409 `WIKI_SPACE_EXISTS`，
  文字 `This repository already has a wiki.`）。
- 账号还没有 wiki 时，侧栏没有 Wiki 组，入口照旧是 `Set up your first wiki` 卡。

D2 问的是要不要再在 workspace 行的 ⋯ 菜单里加 `Create wiki…`。

### 3.5 系统提示

`orbitWikiPathInstructions` 不改：它本来就写了「if your tool list has it」，没有 wiki 的仓库搜到的是空结果，agent 继续干活。

---

## 4. 已有的 wiki（D3）

- 不批量删任何 space，也不追认：`wikova` 和另外两个公司仓库的 wiki 已经被 owner 用起来了，保留原样。
- `lfs-builder`：修复上线之后移进 Trash（D3 = A：我拿到 owner 的同意后在生产执行一次 `POST /api/wiki/spaces/:id/trash`；
  B：owner 自己在侧栏它的 ⋯ 菜单里移）。修复上线之前移是没用的：下一个会话一搜它就回来了。
- 它挂起的起草作业：`no_maintenance_workspace` 挂着，没花过钱；space 进 Trash 时照现有规则一起结束。

---

## 5. 测试

- pg spec（`wiki.service`）：在有 `repo_url`、没有 space 的 workspace 里调 search、get、propose、note、draft，五种调用之后 `wiki_space`
  和 `wiki_plan_job` 都是 0 行；search 回答 `hits: []`、`unavailable: "no_wiki"`；三种写入回答 409 `WIKI_SPACE_UNBOUND`，文字照 §3.3。
- pg spec：同一仓库已经有 space 时，工具调用照旧把 workspace 绑进去（写一行），起草作业不新增。
- pg spec：space 在 Trash 时，search 回答 `unavailable: "wiki_in_trash"`，写入的文字照 §3.3，不建新 space（替换今天的
  「made empty if there is none」用例）。
- runner-go：`unavailable` 两个值的渲染文字。
- 三端：侧栏 / 抽屉的 `New wiki…` 行打开 Create wiki 表单；下拉框里已有 wiki 的仓库灰掉并标 `Has a wiki`。
  三端用同一份 `src/shared/src/wiki-start.fixture.json`（加一组「已有 wiki 的仓库」用例）。
- 文案是英文，`copyLanguage.test.ts` 照旧。

---

## 6. 落地（按代价排）

1. **服务端**（apiserver + shared + 契约）：删掉 `bindOnFirstUse` 的建 space 分支，`resolveSpaceForCall` 区分读和写，
   `WikiSearchOutcome.unavailable`，契约 §2.1、`plan.jobs.triggers`、错误文字。单独一次部署就止住了新 wiki 的出现。
2. **runner-go**：渲染 `unavailable`；旧 runner 读到空 `hits` 也能正常工作，所以不必等 runner 发版。
3. **web**：侧栏 `New wiki…`、页头切换器、Create wiki 表单里已有 wiki 的仓库灰掉。
4. **iOS / macOS**（OrbitKit 共用）和 **Android**：同 3。
5. owner 定 D3 之后处理 `lfs-builder`。

---

## 7. 待定 · 要 owner 拍板

| | A（推荐） | B |
|---|---|---|
| **D1** 没有 wiki 时，agent 的提议怎么办 | 拒绝，告诉 agent「这个仓库还没有 wiki」，什么都不记 | 照旧建 space，但不起草 plan、不出现在列表里，等 owner 打开（需要新的「隐藏」状态） |
| **D2** 第二个 wiki 的入口 | 侧栏 Wiki 组的 `New wiki…` 行 + 页头切换器 | A，再加 workspace 行 ⋯ 菜单里的 `Create wiki…`（只对有仓库、还没有 wiki 的 workspace 显示） |
| **D3** `lfs-builder` | 上线后我征得你同意，在生产把它移进 Trash | 你自己从侧栏移 |
