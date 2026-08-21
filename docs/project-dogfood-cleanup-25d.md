# 25D — 清理验证资源并完成真实 guarded-auto Dogfood

在线上 `0128` 部署上做的一次生产级 dogfood，外加把 25/25B 留下的五个 PostgreSQL 测试夹具收干净。
本文记录命令、关键输出、提交 SHA、环境与残留。所有数字都是从库里数出来的，不是断言出来的。

## 环境

| | |
|---|---|
| Runner | `wikova` (`33aHx39nnWbvJhYO2blSk`)，Linux 6.12.38+deb13-cloud-amd64 |
| Worker Session | `34Atn3gtRcfAZZ3mW9IlE`（Claude / claude-opus-5） |
| 工作分支 | `orbit/25d-guarded-auto-dogfood-20aa12` |
| 基线 | `main = 54744005`，`feat/project = 35e9a24b`（25C 落地后） |
| 部署 | apiserver / web / gateway 重建，postgres 未动；迁移 `0127`、`0128` 于 08:46 应用 |

### 基线门

`main` 与 `feat/project` 分别读取后，用快进把工作分支推到当时最新的 `feat/project`：

```
git merge --ff-only feat/project      # Updating 54744005..35e9a24b, 77 files changed
```

全程无 `reset` / `stash` / `update-ref`。

`/root/.orbit/worktrees/feat-project-deploy` 中用户既有的暂存内容，合并前后逐字未动：

| 路径 | 暂存态 | blob |
|---|---|---|
| `README.md` | `M` | `8da88cf699312bc74ed66da8f93d066ac53dc408` |
| `docs/project-agent-contract.md` | `D`（暂存删除） | 不在索引中 |

## 一、五个遗留测试容器

### 删除前的身份与引用审计

五个都是 25/25B 的 pg spec 夹具，各自挂一个匿名数据卷：

| 容器 | id | 匿名卷 | 端口 | 库 |
|---|---|---|---|---|
| `pcc14-34amsq-pg16` | `4bb687e82de2` | `41274b66edca…` | `127.0.0.1:32788` | `pcc14_dispatch` |
| `pcc15-34AOqoHF-pg16` | `c1c760f68ca9` | `211984ad8632…` | `127.0.0.1:55461` | `pcc15_aggregate_verify` |
| `pcc16-34AQDd-pg16` | `3b1cc2b8cfdf` | `901b56bc6bbe…` | `127.0.0.1:55462` | `pcc16_verdict_verify` |
| `pcc17-34ASQ-pg16` | `79f7f2de83f2` | `c21db49d41f4…` | **`0.0.0.0:55617`** | `pcc17_blocker`, `pcc17_full` |
| `pcc18-34AUU-pg16` | `0dd527d33173` | `dc799c6b6570…` | `127.0.0.1:55618` | `pcc18_verify`, `pcc18_lin` |

清空前逐条确认无活动依赖：

- 每个实例 `pg_stat_activity` 里 `client backend` 计数为 **0**；
- 五个端口在 `/proc/*/environ` 中无任何进程引用，`COORDINATOR_PG_URL` 未出现在任何存活进程环境里；
- 每个匿名卷 `docker ps -a --filter volume=<id>` 只回来它自己那一个容器；
- 仓库里 `main` 与 `feat/project` 对 `pcc1[4-8]` 的引用只有文档叙述与 spec 内的 schema/邮箱字面量，没有任何一条指向这些**运行中实例**。

顺带一件该说的事：`pcc17` 发布在 `0.0.0.0:55617` 而不是 loopback，密码是固定的 `pcc17pass`，日志尾部是 2026-08-20 22:59 到 2026-08-21 01:25 连续的 `invalid length of startup packet` —— 一个测试夹具在应答公网扫描。

证据留在 `docs/evidence/25d/pcc-teardown-manifest.json`（含库清单、表数、卷、端口、镜像摘要）与 `pcc-container-logs-tail.txt`。

### 删除

按**精确容器 id** 删除，不用名字通配、不用 `prune`，`-v` 让匿名卷随容器一起走：

```
docker rm -f -v 4bb687e82de2… c1c760f68ca9… 3b1cc2b8cfdf… 79f7f2de83f2… 0dd527d33173…
```

### 删除后核对

- 五个 id 与五个名字 `docker inspect` 全部 **not found**；五个匿名卷全部 not found；
- 容器总数 38 → **33**，正好五个；
- 五个端口全部不再 listen；
- `orbit-postgres` 的**容器 id 与 `StartedAt` 与删除前逐字相同**（`272e3999362c…` / `2026-08-19T15:15:24.477443791Z`）—— 它连重启都没有发生过，更不用说重建；
- `orbit_orbit_pg`、`orbit_pg-socket` 两个命名卷完好，五个 orbit 服务健康。

核对结果在 `docs/evidence/25d/pcc-teardown-verification.json`。

## 二、部署

25C 的新门要上线才生效。线上当时停在 `0126`，`session_merge_receipt` 与 `project_acceptance_run` 两张表都不存在，
线上 `orbit` CLI 也还没有 `session merge-receipt`。

从干净的 25D 工作树跑仓库的升级脚本，无 `--pull-base`、无 `--allow-dirty`。两件必须记下来的事：

1. **`COMPOSE_PROJECT_NAME=orbit` 是必需的**。线上那套是 compose project `orbit`（由目录 `/root/orbit` 推出），
   compose 文件里没有顶层 `name:`，`.env` 里也没有 `COMPOSE_PROJECT_NAME`。从工作树直接跑会推出另一个 project 名，
   而 compose 文件给每个服务写死了 `container_name: orbit-*`，于是撞名。第一次尝试正是这样安全地停在了重建之前。
2. **gateway 的绑定挂载会被指到工作树里**。`gateway` 挂的是相对路径 `./gateway/nginx.conf`；线上解析为
   `/root/orbit/gateway/nginx.conf`，从工作树跑则解析为会话工作树里的那一份 —— 而会话工作树以后会被回收，
   届时 gateway 一重启就挂不上。两份 `nginx.conf` 内容逐字相同（`1cb979f5…`），所以升级后从 `/root/orbit` 单独
   重建 gateway 把持久路径换了回来，`inspect` 现在是 `working_dir=/root/orbit`、`/root/orbit/gateway/nginx.conf`、healthy。

`--no-deps` 在这里不是可有可无的：从工作树解析时 postgres 的绑定挂载会指向**空的** `data/postgres`，
脚本里那行 `docker compose up -d --wait --no-deps apiserver web gateway` 正是挡住这件事的东西。

结果：`0127`、`0128` 于 08:46 应用，两张表与 `task` 的三个 supersession 列都在，postgres id 与 `StartedAt` 未变。

`.env` 用的是指向 `/root/orbit/.env` 的临时符号链接（`.env` 同时在 `.gitignore:21` 与 `.dockerignore` 里，
因此既不污染 `git status --porcelain --untracked-files=no`，也不会被烤进镜像），健康检查通过后已删除。

### 一个仍然存在的交付缺口

runner 的 `/usr/local/bin/orbit` 仍是旧二进制：新 web 镜像里那份 `orbit-linux-x64.gz` 含 `merge-receipt`
（13 处，sha `44037f61…`），跑着的那份**一处都没有**（sha `3b1adfc3…`），而两者的版本号都是 `0.1.129` ——
`package.json` 没有 bump，于是 runner 的自更新不认为有新版本可拿。本次 dogfood 因此全程走 HTTP 门而不是 CLI。

## 三、guarded-auto canary

### 两个 canary，与一条授权边界

第一个 canary（`34AuGP2sMDmDZD647Fj29`）用 runner 门 `POST /projects` 且**不带** `x-orbit-session-id` 建立，
它拿到了 `GUARDED_AUTO` + `coordinatorEnabled=true`，但 `coordinatorAgentId` 为空，控制环因此停在
`PLANNING` / `NO_COORDINATOR_AGENT`。这不是缺陷，是 25C 划的边界：runner 门对
`coordinatorEnabled`、`automationPolicy`、`maxConcurrentTasks`、`sessionBudgetPerDay` 与 `coordinatorAgentId`
这五个字段**显式拒绝而不是静默丢弃**，理由写在代码注释里 —— 能写这些字段的 agent 等于在给自己授权。

第二个 canary（`34AuOT8lXTeys5ObMG2vS`）走的是产品自己的合法路径：在一个专门开的 Claude Session 里调
`project_create`，于是 coordinator 的 **agent / session / workspace 在同一次写入里原子绑定**，无需任何 owner PATCH。

第一个 canary 保留为 `NO_COORDINATOR_AGENT` 的可审计证据，状态如实置为 `CANCELLED`，未伪造。

### 控制环真实产生的东西

| 证据 | 实测 |
|---|---|
| `project_decision` | **23** 条，`decidedBy=ORCHESTRATOR`，各带 `decisionInputHash` 与 fencing token |
| `project_action` | **4** 条，全部 `APPLIED`，各带真实幂等键 |
| verification | **2** 条 PASS；其中一条走完 `FAIL@rev1 → PASS@rev2` |
| blocker open→resolved | **2** 条完整生命周期，均 `resolvedBy=AUTO` |
| merge receipt | **1** 条，绑定 Session / Task / Project 与每个可复核 SHA |
| acceptance run | **1** 条 `PASS`，`decidedBy=COORDINATOR_AGENT` |
| 父阶段聚合 | `VERIFICATION_PASSED` 在 6 秒内自动完成，无人手写状态 |

两条 blocker 分别是：

- `AWAITING_USER_INPUT`（owner `USER`，recovery `HUMAN`，INFO）—— 协调 Session 进入 `AWAITING_INPUT` 时升起，
  09:00:27 自动消解；
- `VERIFICATION_FAILED`（owner `COORDINATOR`，recovery `EVENT`，CRITICAL）—— 我把校验任务判成 `FAIL` 时升起，
  改判 `PASS` 后 09:04:09 自动消解。`requiredAction` 是「Fix what the verification found, then run the check again.」

四条 action 就是这两条 blocker 的 `RAISE_BLOCKER` / `CLEAR_BLOCKER`，成对出现。

### merge receipt 修好了原本永远在说谎的两列

25C 要解决的正是「分支实际上靠工作树里的 `git merge --ff-only` 落地，于是 `mergeStatus` 与 `branchMerged`
永远为空」。canary 的工作 Session 真的跑出一个分支，我真的合了它，然后记了回执：

```
source  65759b46a866973fa4dd84e1ef8e0027b87463f4
target  orbit/25d-guarded-auto-dogfood-20aa12
        99aadc2c5bdfb4c2fba273c2169d5851692ca6b9 -> 9f9677d16635e85ed6dc5bfdc025535b99779fb4
rebase  54744005f6aa8cb82146b51a6e9a7d6fd87d4b0c
```

写回执之后再读那个 Session：`mergeStatus: merged`、`branchMerged: true`、`mergeTarget`、`mergedAt` 都有了。

### 项目验收门，正反两面都验过

- **反面**：没跑过验收的 canary#1 请求 `DONE` → `409 ACCEPTANCE_MISSING`，
  「no project acceptance has been run — DONE is a claim about evidence, and there is none」，
  且带 `owner`、`requiredAction`、`acceptanceDigest`；
- **正面**：验收 `PASS` 之后的 canary#2 请求 `DONE` → 通过，且 `acceptedRunId` 钉在那次 PASS 的 run 上。

### 无静默 fallback

给任务钉一个不存在的 provider slug，在**创建**时就被 `400 provider not available` 挡下，
没有落库、更没有换个 provider 悄悄跑掉。

## 四、阻塞缺陷：Coordinator 从不自派发

这是本次 dogfood 最重要的发现，已作为 25D 的阻塞子任务 `34AuihrV8lUqHepiC3bNI` 立项。

canary#2 的工作任务 `autoRunWhenReady=true`、`dispatchAuthority=COORDINATOR`、assignee 已绑定 runner、
无 open blocker、并发额度 3/3 空闲。控制环连着做了 23 次 decision，`dispatch_attempt` **恒为 0**，
任务恒 `OPEN`，从未产生任何 `DISPATCH_TASK`。两次工作 Session 都是我手动 `POST /tasks/:id/execute` 起的。

根因不是哪里写错了，而是**少了一个单元**：

- `plannedActions()` 只规划 `ROTATE_COORDINATOR_SESSION`，注释写明这是故意的 ——
  「every other action in §7.3's table is proposed by the unit that applies it, which passes its own list」；
- `ProjectTaskDispatcherService` 已完整实现、已在 `projects.module.ts` 注册、闸门齐全；
- 但全仓库 non-spec 的调用方只有 `project-e2e-harness.ts:417` 这个测试夹具，
  其注释恰是「exactly as a pass that chose to would」—— 没有任何 pass 真的会这么做；
- `project-reconcile.service.ts` 类头也写着「Semantic planning is added by later units」。

因此项目验收标准 AC3（OPEN 且未等待人工时必须在规定时间内启动合法下一任务）在生产上不可能成立。
在该缺陷修复并重新部署、重跑 dispatch canary 之前，**25D 不置 DONE**。

## 残留

- 容器 / 网络 / 卷：**零**。canary 全程没有创建任何 docker 资源，容器数停在清理后的 33。
- canary 的两个工作分支已合入本分支后删除，SHA 钉在各自的 merge receipt 里。
- `orbit/25d-canary-coordinator-289122` 及其工作树保留：它属于协调 Session `34AuO7SuMUOc2G2JshIfm`，
  该 Session 仍 `AWAITING_INPUT`，而本轮硬约束禁止 `session complete/end/cancel`，故不动它。
- runner 二进制交付缺口（版本未 bump）如上，需要一次版本号 bump 才能把新 CLI 送到 runner。

## 机器可读证据

```
docs/evidence/25d/pcc-teardown-manifest.json      删除前的容器身份/卷/端口/库清单
docs/evidence/25d/pcc-container-logs-tail.txt     删除前的日志尾部
docs/evidence/25d/pcc-teardown-verification.json  删除后的逐项核对与受保护资源未受影响的证明
docs/evidence/25d/canary-ledger.json              canary 的 decision/action/blocker/receipt/acceptance/task 全量账
docs/evidence/25d/canary-coordinator-status.json  控制环终态快照
docs/evidence/25d/canary-verifications.json       校验视图终态
docs/evidence/25d/canary-note.md                  canary#1 工作 Session 的产物
docs/evidence/25d/canary-note-bound.md            canary#2 工作 Session 的产物
```
