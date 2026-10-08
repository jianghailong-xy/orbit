# 维护运行在服务端：本机隔离部署的 canary 证据（服务端执行 P8）

`docs/wiki-server-execution-design.md` §8 的 P8 判据要求「canary 空间连续 3 次维护运行成功，游标有推进」。
生产从 `main` 构建，本任务落地之后才生效，所以生产 canary 在任务内做不到；这里用**本机隔离部署**跑通：
本分支的 `dist` 起的真 apiserver 与 wiki-worker 进程、真的 PostgreSQL（一次性容器）、fake 的 System model、
本项目的 runner 二进制（0.1.225，声明 `wiki-repo-op/v1`）读本分支的 checkout，`ORBIT_WIKI_EXECUTOR=canary`
并把账号放进名单。生产 canary 按计划在 P10 统一跑。

## 怎么跑

```bash
bash docs/evidence/wiki-maintain-server-canary/run.sh
# ORBIT_BIN=/path/to/orbit 换一个 runner 二进制；WORKTREE=/path/to/worktree 换一个工作区
```

脚本做这几件事，然后把 `drive.mjs` 的 JSON（本节 `evidence.json` 就是它的输出）打到 stdout：

1. 构建本分支的 `src/apiserver/dist`；
2. 把本分支 clone 成一个有人读的 checkout（`origin/main` 指向本分支 HEAD）；
3. 起一次性 PostgreSQL，跑迁移（最后一次是 `0407_wiki_maintain_job`）；
4. 用本分支的 Prisma client 造 fixture（`seed.cjs`）：一个账号、一台机器、一个读 checkout 的 workspace、一个
   打开维护的空间（`reviewMode: manual`，所以它的 op 等 owner，不问核实结论），绑好空间与 workspace，
   25 个十分钟前停下的会话（各带一条 owner 发言，fake model 就引它），以及 6 个待触发的任务；
5. 起 fake System model（`fake-model.mjs`）：`/health` 回 200，抽取请求按案卷里那一行回一条 pitfall、
   引文就是那一行的原话、锚点指本分支的一个真实路径；
6. 起 apiserver（`ORBIT_WIKI_EXECUTOR=canary`，账号在名单里）与 wiki-worker（同一开关，System model 只配给它）；
7. 起本项目 0.1.225 的 runner，读第 2 步的 checkout；
8. `drive.mjs` **发起 3 次运行**：owner 用 `PATCH /api/tasks/:id` 取消空间 workspace 上的一个任务——这是一次真实
   提交的事实，apiserver 进程内的触发器收到它、按 §27.1 建 `maintain` 作业，wiki-worker 领走并跑完整条流水线
   （快照 → 案卷 → 抽取 → 批次提交 → 推进游标 → 锚点 → 文档），然后检查并输出证据。

## 跑出的是什么（`evidence.json`）

- `checkSummary`：**12 项全过、0 项失败**。逐项见 `checks`：3 次运行成功、每次游标都推进、
  每次都**没有任务**（隐藏维护列表里 0 个任务）、有运行记下 op 之后排出了文章作业。
- `runs`：3 次 `wiki_maintenance_run`，`outcome: succeeded`、`opsRefused: 0`、`catchUp: null`，
  游标位置依次为 `a512292f…` → `2ccc3c6c…` → `aa5988d1…`（每次两条会话的推进）。
- `jobs`：3 个 `maintain` 作业全部 `succeeded`，每个后面跟着一个 `articles` 作业（前两个也已跑完，
  最后一个仍是 `queued`——就是「运行结束后排出了文章作业」这一行）。第一次 maintain 作业 `attempts: 3`：
  runner 还没上报 `wiki-repo-op/v1` 时它是 infra 失败、退避重试，**没有计入连续失败**（游标 `failures: 0`），
  这正是 §5.5 的 infra 语义。
- `requests`：6 条 `wiki_model_request`，全部 `step: extract`、`succeeded`——每个案卷一个请求，走队列、由 worker 执行；
  没有任何用户 provider 参与（空间 pin 的 `claude` 在服务端执行下不被校验、也不被使用）。
- `cursor`：3 次运行之后的游标行，`consecutive_failures: 0`。

## 和 runner 路径一致的部分

确定性部分同一份实现/同一套检查：抽取的行解析、引文对照 spans 与案卷行、锚点查快照、批次大小（30 / Manual 5）、
dry run 的引文剥离与熔断读数、游标推进（op 记下即推进、熔断挡回时停在那一页起点）。这些由
`src/apiserver/src/wiki-worker/wiki-maintain.spec.ts`（逐条移植 `wiki_maintain_test.go`）和
`wiki-maintain-job.pg.spec.ts`（整条流水线、批次与熔断、追赶跳过文档、两次失败分类）覆盖；
两条路径的对照由本目录这次 canary 的同空间、同案卷、同配额见证。

## 与本次改动无关的红 spec

合并检查里若有与本次改动无关的红 spec，按任务要求会在基线的临时 worktree 里跑出相同的失败用例名
（`git worktree add --detach` + `bash scripts/worktree-overlay.sh`），证据附在任务评论里。
