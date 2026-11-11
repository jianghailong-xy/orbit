# Orbit Wiki — 没有 git 也能维护：仓库分档（2026-11-11）

> 状态：设计，owner 2026-11-11 定。它改的是 `docs/wiki-design.md` §8.2 和 `docs/wiki-server-execution-design.md` §5.5、§7 里
> 「维护要先读 git 仓库」这一条；知识模型、写入口、审阅模式、配额、System model 都不变。
>
> 效果图：`docs/mocks/wiki/44-repo-tiers.html`（第 1–8 部分）。
>
> owner 的决定（2026-11-11）：
>
> - 工作目录可以当事实来源；
> - Q1：space 有仓库地址、但工作目录不是 git checkout 时，也走文件夹档，用路径重合度防止选错目录；
> - Q2：第 0 档抽出的条目照常进 Review，代码锚点标为未核，核过之前不进推送块；
> - Q3：一个 wiki 仍然只读一个 workspace。
>
> 修订：
>
> - 2026-11-11（来自 P4 的真实 runner 演练）：文件夹档抽取时不收条目写的 commit 锚点，不标 `deferred`，也不算作别的仓库的；
>   否则这些锚点在文件夹上永远核不了，条目永远不进推送块（§5.1、§5.2）。

---

## 0. 一页结论

1. **wiki 的原料是会话，不是仓库。** 维护运行读的是服务端从会话里抽好、脱敏过的案卷；仓库只用来核代码锚点、重写文档、给 prompt 一句「这个仓库是什么」。
   但今天运行的第一步是 git 快照（`wiki-maintain-job.ts` `steps()`），这一步失败，整次运行就不跑了。
2. **仓库分三档，每次运行由 runner 判断读到哪一档：**
   - **第 2 档 git**：和今天完全一样，读 fetch 后的 origin/main；
   - **第 1 档 文件夹**：目录在、但不是 git checkout，就直接扫工作目录，快照格式不变，树哈希当 sha；
   - **第 0 档 只有会话**：什么都读不到。
3. **每一档都会抽条目、提议、推进游标。** 只有代码锚点和文档按档位降级：第 1 档不核提交锚点，第 0 档代码锚点和文档都推迟到能读的时候。
4. **只有一种情况拒绝读目录：** 读到的是别的仓库（origin 不同、根提交不同，或者文件夹和上一份快照几乎不重合）。这时健康行变红，但条目照样从会话里抽。
5. **持久的前提错误不再进重试循环。** 目录丢了、不是 git、凭据被拒，都不再按 infra 重试 10 次；改为当场降档，并把原因写进健康行。
6. **owner 有恢复入口。** 开维护时先探测一次；Settings 里有 `Check again and run now`，不用等下一个事实。

---

## 1. 现状与问题

### 1.1 起因（2026-11-11 核实，会话 34vT2aqedGWw58z5WI5oS）

一个 space 的维护 11-04 之后再没成功过：11-05 和 11-06 每来一个事实就建一次运行，每次都死在
`REPO_OP_FAILED: … is not a git checkout`，重试 10 次后结束；之后不再建运行。健康行一直是 `Maintenance behind`。

### 1.2 代码里的原因

| 位置 | 事实 |
|---|---|
| `src/runner-go/wiki_repo_ops.go` `wikiRepoOpCheckout` | 每个仓库操作第一步都是 `git rev-parse --show-toplevel`，不是 git 就失败 |
| `src/apiserver/src/wiki-worker/wiki-maintain-job.ts` `steps()` | `readSnapshot()` 是第一步，失败抛 `WikiJobInfraError`，后面的案卷、抽取、提议、游标都不跑 |
| `wiki-server-execution-design.md` §5.5 | infra 失败不计入连续失败，所以 `look` 永远停在 `behind`，到不了 `failing`，连续失败 3 次那条通知也不会发 |
| `wiki-repo-ops.ts` `readWikiRepoReadiness` | 只看 workspace、runner 在线、能力，不看 `workspace.work_dir_is_git`，也不比对 repo URL |
| `src/apiserver/src/wiki-worker/wiki-maintain.ts` `buildWikiMaintainOps` | 没有快照时（`repo = null`），凡是写了代码锚点的条目都会被当成「别的仓库的知识」丢掉 |
| 契约 §20.1 | `lastFailure` 已经在 health 里，三个客户端都没画 |

### 1.3 产品上的矛盾

可以建「没有仓库的 wiki」（`wiki.controller.ts` 的 `POST /wiki/spaces`），也可以把没有仓库的 workspace 加进 space（`wiki-design.md` §2.1）；
开维护时只要求选一个 workspace（`wiki-maintenance-settings.ts`）。但这样的 space 每次运行都会死在 `rev-parse`，所以永远维护不了。

---

## 2. 档位

### 2.1 定义

| 档位 | 怎么认（runner 每次判断） | 快照的 sha | 抽条目、推游标 | 路径 / 符号锚点 | 提交锚点 | 文档重写 |
|---|---|---|---|---|---|---|
| `git`（2） | 是 git checkout，origin 等于 space 的仓库，根提交一致 | fetch 后 origin/main 的提交 | ✓ | ✓ | ✓ | ✓ |
| `git`（2，本地） | 是 git checkout，**没有 origin 这个远端**，space 也没有仓库地址 | HEAD 的提交 | ✓ | ✓ | ✓ | ✓ |
| `folder`（1） | 目录在，不是 git checkout | 树哈希（§4.2） | ✓ | ✓ | 不核 | ✓ |
| `sessions`（0） | 读不到：没有 workspace、没有工作目录、目录不存在、runner 没有、不在线、要升级、文件太多 | 无 | ✓ | 未核 | 未核 | 推迟 |
| `wrong_repository` | 读到的是别的仓库（§2.3） | 无 | ✓（照第 0 档） | ✗ | ✗ | ✗ |

- 档位是**读的结果，不是设置**。维护设置里仍然只选一个 workspace（Q3）。owner 修好目录，下一次运行自动回到第 2 档。
- 第 2 档的行为一个字都不改：仍然只读 origin/main，不读没提交的改动；fetch 锁、根提交校验、读缓存都照旧。
- 文件夹档**只在目录不是 git checkout 时**启用。是 git、但 fetch 失败的，不降成扫目录（§6）。
- 本地 git（没有 origin）只给没有仓库地址的 space：有仓库地址的 space 必须有 origin 才能核对身份，否则就是 `wrong_repository`。

### 2.2 判断在哪里做

- **readiness**（服务端，不问 runner）：`no_workspace`、`runner_missing`、`runner_offline`、`runner_upgrade` 照旧由
  `readWikiRepoReadiness` 读出来。不同的是：今天这些情况会让运行挂起或失败，以后直接按第 0 档跑。
- **probe**（runner）：readiness 为 `ready` 时，`snapshot` 操作的回答里带上档位 `source: "git" | "folder"`；读不到时，回答
  `state: "failed"` 并附结构化原因 `reason`（§6 的表），不再只有一句文字。
- 运行行和健康行上记的都是这次运行**实际用的档位**和原因。

### 2.3 防止选错目录（Q1）

- 第 2 档：照旧比对 origin 和根提交（`wikiRepoOpCheckout`）。
- 第 1 档、**space 有仓库地址或有上一份快照**时，服务端在快照落地之前算路径重合度：
  `|新快照的路径 ∩ 上一份快照的路径| / |上一份快照的路径|`。
  - 不到 `repoOps.folder.minPathOverlap`（0.5）：这份快照不落地，本次运行记为 `wrong_repository`，原因是
    `~/work/app shares 12% of its files with the last snapshot of github.com/x/app`。
  - space 有仓库地址但从来没有快照（还没成功读过一次）：不做比对，直接接受。仓库地址本身不能证明文件夹是谁的；这时的风险由 owner 在设置里看到的
    `Folder, not git` 承担。
- 上一份快照是 git 档的也一样比：只比路径，不比内容。

---

## 3. 一次运行（`maintain` 作业）

```
probe ─► dossiers ─► extract / claims ─► self-check ─► breaker ─► propose ─► advance ─► verify ─► anchors ─► docs
  │                                                                                                  │          │
  └ 档位、快照（第 1/2 档）                                                                    按档位核 / 推迟   按档位写 / 推迟
```

| 步骤 | 今天 | 新 |
|---|---|---|
| probe（原 `repo`） | git 快照；失败 = 整次运行失败 | 读出档位；第 1/2 档拿到快照；第 0 档记下原因继续走。只有瞬时故障按 infra 重试（§6） |
| dossiers … advance | 依赖上一步 | **不依赖仓库** |
| extract 的 prompt | README 首段 | 有快照用 README 首段，否则用 space 的 title |
| extract 的锚点过滤 | `repo = null` 时，写了代码锚点的条目全丢 | 有快照：照旧，全部锚点都不在仓库里的条目当作别的仓库的（文件夹快照不收 commit 锚点，§5.1）；没快照：锚点照收，标 `deferred`（§5.2） |
| verify | 照旧 | 照旧 |
| anchors | runner 的 `anchors` 操作 | 服务端锚点（`criterion`、`record`、`merge_evidence`）每一档都核；`path` / `symbol` 第 1/2 档核；`commit` 只有第 2 档核。核不了的保留上一次结果，`anchors_due` 保持置位 |
| docs | 按 plan 重写受影响的节 | 第 1/2 档照旧；第 0 档跳过，受影响的节留到下次读得到时再写，复用追赶模式「落后时跳过、回来后统一重写」的记账（`maintenance.job.catchUp`） |

- 运行的结局：第 0 档跑完、没有别的失败，就是 `succeeded`。读不到仓库**不是**运行的失败，而是写在健康行上的一条状态（§7）。
- 运行报告多两个字段：`repo.tier`（`git` / `folder` / `sessions`）和 `repo.reason`（第 0 档和 `wrong_repository` 时的原因）。

### 3.1 其他要读仓库的作业

| 作业 | 第 1 档 | 第 0 档 |
|---|---|---|
| `plan_draft`（起草第一版 plan） | 照常 | 不能起草；健康行和 plan 卡说明原因，读得到时 owner 再要一次（§5.6 的入口不变） |
| `docs_build`、`docs_follow` | 照常；`docs_follow` 由 merge 和 landing 触发，文件夹档本来就没有这两种事实 | 推迟，同 docs 步骤 |
| `import` | 照常 | 不能导入，说明原因 |
| `articles`、`verify` | 照常 | 读不了原文的部分推迟 |

这些作业今天各自调用 `operation('snapshot' | 'read' | 'diff')`，都改为通过同一个「读出档位」的入口；除了维护运行，其他作业遇到第 0 档的行为
（等待或失败）不变，只是把原因换成结构化的那一句。

---

## 4. 文件夹快照（runner）

### 4.1 读什么、不读什么

- 从 workspace 的工作目录往下走，不跟随符号链接，不出工作目录。
- 先应用**内置排除表**（`repoOps.folder.exclude`，在 `.gitignore` 之前生效，也不能被它重新包含）：
  `.git/`、`.env`、`.env.*`、`*.pem`、`*.key`、`*.p12`、`id_rsa*`、`id_ed25519*`、`.ssh/`、`.aws/`、`.npmrc`、`.netrc`、
  `node_modules/`、`.venv/`、`venv/`、`__pycache__/`、`target/`、`dist/`、`build/`、`.next/`、`.gradle/`、`DerivedData/`。
- 再应用目录里的 `.gitignore`（各层都读，规则和 git 一样；没有 `.git` 也读这个文件）。
- 不是 UTF-8 文本的文件（前 8 KB 里有 NUL）只记路径和大小，不读内容。
- 单个文件仍然以 2 MB 为上限（`repoOps.read.wholeFileBytes`）。
- 文件数上限 `repoOps.folder.maxFiles`（100,000，按排除之后的数算；本仓库的 git 跟踪文件约 3.1 万）。超过就不建快照，按第 0 档处理，原因 `too_many_files`。

### 4.2 快照

- 格式和 git 快照的 `wikiRepoOpIndex` 一样（路径和大小、文档标题、符号、contracts 清单、README 首段），另外：
  - `source: "folder"`（git 快照写 `"git"`，旧快照没有这个字段时按 `"git"` 读）；
  - 每个文件多一个 `hash`（内容的 sha256，二进制文件也算）；
  - `commits` 为空数组；`date` 是建快照的时间。
- **树哈希**：把 `路径 \0 大小 \0 内容 sha256 \n` 按路径排序拼接，取 sha1，得到 40 位十六进制。它放进 `wiki_repo_snapshot.sha`，
  所以 `skipSha`、按 `(space, sha, path)` 的读缓存、快照换代清理都不用改。文件没变，树哈希就不变，`skipSha` 照样省掉重传。
- `read` 操作给的 sha 是树哈希时，runner 先重算当前的树哈希：一致就读磁盘上的文件；不一致说明目录在这期间变了，就回答
  `state: "failed"`、`reason: "folder_moved"`，服务端为这次运行重建一次快照再读，最多一次，之后再变就推迟这一节。
- 没有 `diff`：文件夹档不存历史。需要「从哪个版本以来变了什么」的地方，一律当作变了（§5.3、§3）。

### 4.3 能力与旧 runner

- 新能力 `wiki-repo-op-folder/v1`。服务端只在 runner 声明了它时才在 `snapshot` 的输入里写 `allowFolder: true`。
- 没声明的 runner 遇到非 git 目录，照旧报 `not a git checkout`：服务端把这个错误读成 `not_git`，按第 0 档跑，健康行写
  `Upgrade the runner to read folders`。

---

## 5. 锚点

### 5.1 各档能核什么

| 锚点 | 第 2 档 | 第 1 档 | 第 0 档 |
|---|---|---|---|
| `path` | `git cat-file -e`（不变） | 文件或目录存在 | 保留上次结果 |
| `symbol` | `git grep` + 区域哈希（不变） | 在文件上做同样的查找和区域哈希 | 保留上次结果 |
| `commit` | `merge-base --is-ancestor`（不变） | 不核，保留上次结果 | 保留上次结果 |
| `criterion`、`record`、`merge_evidence` | 服务端核（不变） | 同左 | 同左 |
| `command` | 不变 | 不变 | 不变 |

- 文件夹档抽取时，条目写的 `commit` 锚点直接不收：不标 `deferred`，也不算「全部锚点都不在仓库里」；`path` / `symbol` 锚点照旧按快照核。
  只写了 `commit` 锚点的条目照收，只是没有代码锚点。原因：文件夹档不核 `commit`，收下的话它会一直是 `deferred`，条目永远不推送（§5.2）。
- 文件夹档核出的检查记录：`ref` 是树哈希，另带 `source: "folder"`。`wiki_get` 和条目抽屉据此显示「核于文件夹」而不是某个提交。
- `anchorHoldsAt` 对 `source: "folder"` 的检查只认同一个树哈希：树哈希变了就整条重核。核查只是 runner 上的 stat 和查找，不调模型，
  每次运行的上限沿用 `anchorRules.verify` 的数字。
- 目录后来变成 git checkout：文件夹上核过的锚点在下一次运行时于 origin/main 上重核。
- 文件夹里可能有还没提交的改动：锚点以后不见了，复验就是 `missing`，走今天的 challenge 流程，不需要新机制。

### 5.2 第 0 档抽出的条目（Q2）

- 没有快照时，抽取不再丢掉写了代码锚点的条目，而是收下锚点，并在每个代码锚点上标 `deferred: true`
  （「抽取时没有对着任何代码树检查过」）。
- 只有没有快照（第 0 档）才这样标；文件夹档有快照，`path` / `symbol` 当场核，`commit` 锚点不收（§5.1），所以不会留下 `deferred`。
- 条目照常进 Review；owner 照常 Accept / Edit / Reject。
- **推送**：今天的推送只排除 `changed` 和 `missing`（`wiki-push.ts` `OUT_OF_PUSH_ANCHORS`），`unchecked` 的条目会推。新增一条：
  有任何一个 `deferred` 且还没有检查记录的代码锚点的条目，不进 `<orbit_wiki_context>`。第一次核过（任何一档），`deferred` 就去掉，条目按今天的规则推。
- 第一次核的时候，锚点不在这个仓库里的，结局和今天抽取时的过滤一样：整条条目的代码锚点**全部**不在，就对该条目提一条 challenge
  `None of its code anchors exist in this repository`，由 owner 在 Review 里 Retire 或 Amend；不自动删除，因为它已经被 owner 确认过。
- 条目抽屉在 `deferred` 的锚点旁写 `Not checked yet: the code could not be read when this was learned`。

### 5.3 文档节

- 文档节记着它写于哪个 sha。第 1 档下，写于另一个树哈希的节都当作「材料可能变了」，交给节的指纹（`docs.regeneration`）判断：
  材料没变就不调模型、不重写，和今天快照没有某个提交时的处理一样（`wiki-maintain-job.ts` 的 `taken as changed`）。
- 代价：工作目录一变，下一次运行要重读这些节引用的文件来算指纹。读缓存按 `(space, sha, path)` 存，换了树哈希就读不中。
  后续可以改成按内容 hash 缓存（快照里已有每个文件的 hash），这一版不做。

---

## 6. 失败分类

runner 的失败回答多一个 `reason`（`repoOps.reasons`），服务端照它分类，不再从错误文字里猜：

| reason | 归类 | 档位 | 重试 | 健康行 |
|---|---|---|---|---|
| `no_workspace`、`no_work_dir` | 前提 | 0 | 否 | 琥珀 |
| `not_found`（目录不存在） | 前提 | 0 | 否 | 琥珀 |
| `not_git`（旧 runner，或文件夹档没打开） | 前提 | 0 | 否 | 琥珀 |
| `too_many_files` | 前提 | 0 | 否 | 琥珀 |
| `wrong_repository`、`root_mismatch`、`path_overlap` | 前提 | 只做第 0 档的事 | 否 | 红 |
| `fetch_refused`（凭据被拒，`errGitAuthFailed`） | 前提 | 0 | 否 | 红 |
| `runner_offline`、`runner_missing`、`runner_upgrade` | 前提（readiness） | 0 | 否 | 琥珀（今天已有的原因句） |
| `fetch_failed`（网络）、操作超时、runner 在操作中掉线 | 瞬时 | — | 按 infra 退避，最多 `repoOps.probe.maxAttempts`（3）次，之后按第 0 档继续 | 琥珀 |
| `folder_moved` | 瞬时 | — | 重建一次快照（§4.2） | 不显示 |

- 前提错误不进 `WIKI_JOB.maxAttempts` 的重试循环，一次运行里也不重复问 runner。
- 红色的（要 owner 去修）连续 3 次运行都出现时，发一次通知，并在 Following 的 Needs attention 里出现一条。复用今天「Maintenance failed 3 times」
  的通知通道，文案换成原因。修好、读到一次之后计数清零。
- 维护运行自己的失败分类（infra / content，`maintenance.job.recovery`）不变：仓库降档不算运行失败。

---

## 7. 健康行与界面

### 7.1 健康契约

`GET /api/wiki/spaces/:id/health` 的 `repo` 增加：

- `tier`：最后一次运行（或探测）实际用的档位，`git` / `folder` / `sessions` / `wrong_repository`，从没读过时为 null；
- `reason`：§6 的 reason，`git` 和 `folder` 时为 null；
- `detail`：给人看的一句英文（已脱敏），比如 `~/work/app was not found on MacBook`；
- `checkedAt`：这次判断的时间。

`look`（`ready` / `no_workspace` / …）保留，旧客户端照旧读它。

### 7.2 文案（英文，三端一致，由 `src/shared/src/wiki-health.fixture.json` 约束）

健康行前半句（维护部分）照旧，后面接仓库部分：

| tier | 仓库部分 | 颜色 | 链接 |
|---|---|---|---|
| `git` | 无 | — | — |
| `folder` | `Reading the folder, not git` | 灰 | Settings；悬停 `Commit anchors are not checked: <dir> is not a git checkout.` |
| `sessions` | `Code checks paused: <detail>` | 琥珀点 | `Fix in Settings` |
| `wrong_repository` | `<detail>` | 红点 | `Fix in Settings` |

- 窄屏（iOS、Android、web 手机宽度）只写短句：`Reading the folder` / `Code checks paused` / `Wrong folder`，完整的句子在 Settings 里。
- readiness 已有的原因句（`Waiting for the runner to come online`、`Upgrade the runner to read the repository`）照旧，
  它们现在属于 `sessions` 档的 `detail`。
- 今天 `behind` 的那一行不再是「每次都失败、看起来却像在排队」：读不到仓库的运行照样成功，backlog 会降下来，原因写在仓库部分。

### 7.3 维护设置

- **开启前探测**：选 workspace 时，服务端问一次 runner（新的 `probe` 操作，只判断档位，不建快照），结果写在下拉框下面：
  - `Git checkout of github.com/x/app`（绿）；
  - `Folder, not git` + `Entries and code checks work. Commit anchors are not checked.`（紫）；
  - `<dir> was not found on <runner>` + `Maintenance can still learn from sessions. Code checks wait until the folder is back.`（琥珀）；
  - `<dir> is a clone of <url>, not this wiki's repository`（红，`Turn on` 不可用）。
  runner 不在线时写 `Could not check: <runner> is offline`，允许开启。
- **`Check again and run now`**：出现在维护卡上（tier 不是 `git` 时，或最近一次运行失败时）。它重新探测，然后立刻建一次维护运行，
  不等下一个事实。计入每日次数；今天已到上限时按钮不可用，写 `Daily limit reached`。
  新路由 `POST /api/wiki/spaces/:id/maintenance/run`，只给 owner，同一个 space 已有运行在跑时返回 409 `WIKI_MAINTENANCE_RUNNING`。
- 记录为 `path_overlap` 时，维护卡上多一个 `Use this folder`：owner 确认之后，这一次跳过重合度检查，新快照落地，以后就和它比。
- `Change workspace…` 打开同一个设置表单。

### 7.4 Activity

Runs 卡每行多一个档位标记：`git` / `folder` / `sessions only`，以及第 0 档的原因。

---

## 8. 契约与数据的改动

- `contracts/wiki.contract.json`
  - `repoOps.tiers`、`repoOps.reasons`、`repoOps.folder`（`exclude`、`maxFiles`、`minPathOverlap`、树哈希的写法）、`repoOps.probe`；
  - `repoOps.kinds.snapshot`：输入 `allowFolder`，回答 `source`；新 kind `probe`；
  - `maintenance.job.run.steps`：probe 的新语义、各步按档位的行为；
  - `maintenance.health`：`repo.tier`、`reason`、`detail`、`checkedAt`；
  - `anchorRules`：`deferred`、`source: "folder"` 的检查、推送的新排除条件；
  - 新路由 `maintenance.run`。
- 迁移：
  - `wiki_repo_snapshot` 加 `source text not null default 'git'`；
  - `wiki_maintenance_run`（运行行）加 `repo_tier`、`repo_reason`；
  - `wiki_cursor` 加 `repo_attention_runs int not null default 0`（红色原因连续出现的次数，§6）。
- 锚点的 `deferred` 和检查记录的 `source` 存在条目的 `anchors` jsonb 里，不用迁移。
- `docs/wiki-design.md` §8.2、`docs/wiki-server-execution-design.md` §5.5 / §7、`docs/wiki-contract.md` §20、§26、§27 同步改，并指向本文。

---

## 9. 安全

- 文件夹档会读到 git 档读不到的东西：没提交的改动、没跟踪的文件。内置排除表在 `.gitignore` 之前生效，`.gitignore` 不能重新包含被它排除的文件。
- 上传前的脱敏不变：owner 的 `workspace.env` 真实值逐字遮蔽（`wiki-design.md` §10.2，`ownerEnvLiterals`）。
- 读缓存和快照只对 owner 可见、随 space 删除，不变。
- runner 只读工作目录，不写；不跟随符号链接，不出工作目录。
- 路径重合度检查只拦「明显是别的目录」，不是身份证明。设置里的 `Folder, not git` 让 owner 看到读的是哪个目录。

---

## 10. 分阶段与判据

每一阶段单独落地，前一阶段不依赖后一阶段。

### P1 · 仓库不再是闸门（只改 wiki-worker 和 apiserver，runner 不用升级）

- `steps()`：probe 失败按 §6 分类；前提错误按第 0 档继续跑 dossiers … advance；anchors 只核服务端锚点；docs 跳过并记账。
- 抽取：没有快照时锚点标 `deferred`，不再丢弃；推送排除未核的 `deferred` 条目。
- 旧 runner 的 `not a git checkout` 读成 `not_git`。
- 判据：
  1. pg spec：workspace 目录不是 git 时，一次维护运行以 `succeeded` 结束，提议出条目，游标前进，运行行记 `repo_tier = sessions`、`repo_reason = not_git`；
  2. pg spec：同一场景下，带路径锚点的条目被提议，锚点上有 `deferred`，这个条目不在推送块里；之后一次第 2 档的运行核过它，它进推送块；
  3. pg spec：fetch 网络失败重试 3 次后按第 0 档继续，运行 `succeeded`；凭据被拒不重试；
  4. 已有的维护、docs、anchors 的 pg spec 全部照旧通过。

### P2 · 健康行与失败可见

- health 的 `repo.tier/reason/detail/checkedAt`；三端的仓库部分文案；红色原因连续 3 次的通知。
- 判据：`wiki-health.fixture.json` 加四种 tier 的用例，web `lib/wikiHealth.test.ts`、iOS `WikiHealthCopyParityTests`、Android `WikiHealthTest` 通过；
  pg spec 证明红色原因第 3 次运行发且只发一次通知。

### P3 · 探测与立即重跑

- `probe` 操作；设置表单的四种回答；`POST /maintenance/run`。
- 判据：pg spec 覆盖 probe 的四种回答、重跑计入每日次数、已有运行时 409；web 与 iOS 的设置表单截图对照效果图 44 第 5 部分。

### P4 · 文件夹快照（runner + 服务端）

- `wiki-repo-op-folder/v1`：扫目录、排除表、`.gitignore`、树哈希、`read` 的树哈希校验、文件夹上的 path / symbol 锚点核查；
  服务端的路径重合度检查和 `source: "folder"` 检查记录。
- 判据：
  1. Go 测试：排除表优先于 `.gitignore`；符号链接不跟随；同样的文件得到同样的树哈希，改一个字节就变；超过 `maxFiles` 回答 `too_many_files`；
  2. pg spec：非 git 目录上的运行走 `folder`，路径和符号锚点被核，提交锚点保留原结果，文档节按指纹判断；
  3. pg spec：有仓库地址的 space，文件夹和上一份快照路径重合不到一半时记 `wrong_repository`，快照不落地；
  4. 真实 runner：在一个删掉 `.git` 的仓库副本上开维护，健康行显示 `Reading the folder, not git`，条目、锚点、文档都正常。

### P5 · 文档同步

§8 列出的设计文档和契约文档改完；`src/shared` 的契约测试（`wikiContract.spec.ts`）照新的键通过。

---

## 11. 风险与没做的

- **工作目录变得很快。** 开发机上每次保存都会换树哈希：快照几乎每次运行都要重传，文档节要重读文件算指纹。快照只有路径、标题、符号，体积和 git
  快照同量级；按内容 hash 缓存原文留到以后（§5.3）。
- **文件夹档的锚点比 git 档的弱。** 它核的是「这台机器上这一刻的文件」，可能是没提交的改动。检查记录上的 `source: "folder"` 让读的人分得清。
- **路径重合度会误判。** 一次大规模重构（比如把源码整体挪进 `src/`）会让重合度掉到一半以下，被当作别的目录。owner 在 Settings 里点 `Use this folder`
  接受新目录（§7.3）。
- **没做：** 多个 workspace 备选（Q3 定为不做）；git checkout 在 fetch 失败时退到读本地 origin/main 或工作区；`.gitignore` 之外的用户自定义排除规则。
