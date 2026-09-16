/**
 * Wake blocks in the wording that shipped until 2026-09-15, copied verbatim out of this
 * deployment's `run_event` rows — the 73 turns already in the record are not migrated, so these
 * are what the parser meets in every transcript older than that day. Each is stamped with the row
 * it came from; none of it is typed out by hand.
 */

/** run_event 01a09fef-6038-758d-94b8-8c265ee9cc98. */
export const ZH_JOB_FAILED = `<background-job-wake>
  你用 bg_run 起的后台作业有了你在等的消息，控制面为此给你开了这一轮：
    bgj_209fc7f9f47a｜job｜sleep 5; exit 3｜Smoke: wakeOnExit on a job that exits 3
      已结束｜failed｜退出码 3
      输出 /root/.orbit/runs/e8385a27-7c62-53b7-923c-9e7c048be9c1/bgj_209fc7f9f47a.output｜这次说到的是第 0–0 字节
      （没有输出）
  这是控制面替你记下的，不是用户说的。完整输出用 mcp__orbit__bg_output 按 id 读，sinceOffset 填上面的起点就只读新的部分。
</background-job-wake>`;

/** run_event 01a0a5ce-df7e-775d-93b2-876856622791. */
export const ZH_JOB_DONE = `<background-job-wake>
  你用 bg_run 起的后台作业有了你在等的消息，控制面为此给你开了这一轮：
    bgj_cc4b4ef84b39｜watch｜gh run watch 34970575848 --exit-status >/dev/null 2>&1; echo "CI 34970575848 (rerun of Test web, bb4a144ff) exit: $?"｜watch main CI rerun 34970575848
      已结束｜completed｜退出码 0
      输出 /root/.orbit/runs/01a0992f-f058-7605-be10-6a02467ac860/bgj_cc4b4ef84b39.output｜这次说到的是第 0–54 字节
      输出末尾：
        CI 34970575848 (rerun of Test web, bb4a144ff) exit: 1
  这是控制面替你记下的，不是用户说的。完整输出用 mcp__orbit__bg_output 按 id 读，sinceOffset 填上面的起点就只读新的部分。
</background-job-wake>`;

/** run_event 01a0a50b-1c0e-72b7-af6b-fd4793c6ef65. */
export const ZH_SCHEDULED = `<scheduled-wakeup>
  你用 schedule_wakeup 约的唤醒到点了，控制面为此给你开了这一轮：
    2026-09-15T11:29:14.912Z 约在 3600 秒后，2026-09-15T12:29:14.911Z 到点
    理由：复跑负载闸门 12:16Z 超时必开跑，12:26Z 检查时应有部分结果；防 waiter 被 drain 杀
    你留给这一轮的话：
      兜底检查：入口 400 复跑 unit rerun-400-104631 现在状态如何？负载闸门 deadline 12:16Z 已过，应已开跑或已完成。读 /root/.orbit/uploads/01a0992f-f058-7605-be10-6a02467ac860/scratch/rerun-400-1046.log 尾部与 systemctl show -p Result,ExecMainStatus rerun-400-104631.service 处理结论；仍在跑则续挂兜底。
  这是控制面替你记下的，不是用户说的。还要再等，就再调一次 mcp__orbit__schedule_wakeup。
</scheduled-wakeup>`;

/** run_event 01a0a648-e8ca-7644-b92b-825c83b5f8aa. */
export const ZH_WAKE_WITH_COORDINATOR_CONTEXT = `<background-job-wake>
  你用 bg_run 起的后台作业有了你在等的消息，控制面为此给你开了这一轮：
    bgj_1cddac2b7a92｜watch｜target=3a7686cf2ddad5595c46fe3bd908c2408ef2e8d2
while true; do
  if gh run list --workflow=ci.yml --commit "$target" --json databaseId,status,conclusion 2>/dev/null | grep -q '"status":"completed"'; then
    break
  fi
  sleep 30
done
gh run list --workflow=ci.yml --commit "$target" --json databaseId,conclusion --limit 1 -q '.[0] | "main CI \\(.databaseId) done: \\(.conclusion)"'｜Watch push-triggered main CI for merged tip 3a7686cf2
      已结束｜completed｜退出码 0
      输出 /root/.orbit/runs/01a0992f-f058-7605-be10-6a02467ac860/bgj_1cddac2b7a92.output｜这次说到的是第 0–36 字节
      输出末尾：
        main CI 35005981340 done: cancelled
  这是控制面替你记下的，不是用户说的。完整输出用 mcp__orbit__bg_output 按 id 读，sinceOffset 填上面的起点就只读新的部分。
</background-job-wake>

<orbit_project_coordinator_context>
你是项目（id: 34DGqqkpCEVavXwRLFWKU）的协调会话。

这里用来跟进这个项目的进展、协调它下面的任务，不是用来替它干活的——具体实现交给各个任务自己的会话去做。

先读再说：用 project_get 读这个项目的目标、验收标准和作业指导，再用 task_list（projectId 传上面那个 id）看它下面的任务各自停在哪里。这两样都不在任务的描述里，不读就只能靠猜。读完先简短汇报现状。

推进靠的是跟人对话：把现状说清楚，该问的问，商量下一步，然后动手。没有任何自动的环会替你决定什么时候动。

该动的时候你手上有工具：project_update 改这个项目的标题、目标、作业指导；task_create、task_update、task_start 管它下面的任务。

这条会话里冒出来的新工作，记成这个项目下的任务，别提议新建项目：一个会话只能协调一个项目，从这里建一个只会让服务器另开一条会话去接手它，而那条会话对这里的来龙去脉一无所知。真觉得该另起一个项目，把理由说清楚，交给屏幕这边的账号所有者去开。

有两件事不是你来定：改这个项目的验收标准，和把它记成 DONE。验收标准是判定这个项目做没做完的那把尺子，改尺子的人可以让任何结论成立；DONE 是「目标达成了」这句话本身，说错了没有下游会再问一遍。这两件都由账号所有者通道记录——你把该改什么、还差什么说清楚，让屏幕这边的账号所有者决定。这里的 HUMAN_ONLY 是角色隔离和按动作留痕，不是服务器对“真人在场”的密码学证明。

没给你的工具就别去找：列出或删除项目、另开一个协调会话、直接指挥 runner，都不在你手上。
</orbit_project_coordinator_context>`;

/** run_event 01a0a5db-b181-779f-8a26-91c340b4ccf2: two jobs answered on one turn. */
export const ZH_TWO_JOBS = `<background-job-wake>
  你用 bg_run 起的后台作业有了你在等的消息，控制面为此给你开了这一轮：
    bgj_52843eb345d1｜job｜cd /tmp/import-e2e && node e2e.mjs > /tmp/import-e2e/stdout.log 2>&1｜session import full-stack E2E (disposable PG + apiserver + runner + real claude resume)
      已结束｜failed｜退出码 1
      输出 /root/.orbit/runs/b8340627-86f5-50cf-b124-b9848ee96bf9/bgj_52843eb345d1.output｜这次说到的是第 0–0 字节
      （没有输出）
    bgj_974ceb2c3d52｜job｜cd /tmp/import-e2e && node e2e.mjs > /tmp/import-e2e/stdout.log 2>&1｜session import full-stack E2E (disposable PG + apiserver + runner + real claude resume)
      已结束｜failed｜退出码 1
      输出 /root/.orbit/runs/b8340627-86f5-50cf-b124-b9848ee96bf9/bgj_974ceb2c3d52.output｜这次说到的是第 0–0 字节
      （没有输出）
  这是控制面替你记下的，不是用户说的。完整输出用 mcp__orbit__bg_output 按 id 读，sinceOffset 填上面的起点就只读新的部分。
</background-job-wake>`;

/**
 * run_event 01a0a62e-a26b-72a5-84b4-ec8bfa9756cb: the one turn in the record both blocks came on —
 * a job's wake, and a wakeup that came due while it ran.
 */
export const ZH_JOB_AND_SCHEDULED = `<background-job-wake>
  你用 bg_run 起的后台作业有了你在等的消息，控制面为此给你开了这一轮：
    bgj_13c53745a88a｜job｜/root/orbit/.claude/skills/upgrade/upgrade.sh --pull｜upgrade to 39551b637 (catalog-window fix + session-import)
      已结束｜completed｜退出码 0
      输出 /root/.orbit/runs/01a0a5c5-d908-7553-ad1d-b62ee4ff388e/bgj_13c53745a88a.output｜这次说到的是第 0–16570 字节
      输出末尾：
        
        #63 [apiserver] resolving provenance for metadata file
        #63 DONE 0.2s
         Image orbit-apiserver:local Built 
         Image orbit-web Built 
        ==> Recreating changed services (apiserver applies DB migrations on boot)
         Container orbit-postgres Running 
         Container orbit-apiserver Recreate 
         Container orbit-apiserver Recreated 
         Container orbit-web Recreate 
         Container orbit-web Recreated 
         Container orbit-gateway Running 
         Container orbit-postgres Waiting 
         Container orbit-postgres Healthy 
         Container orbit-apiserver Starting 
         Container orbit-apiserver Started 
         Container orbit-apiserver Waiting 
         Container orbit-apiserver Healthy 
         Container orbit-web Starting 
         Container orbit-web Started 
         Container orbit-apiserver Waiting 
         Container orbit-web Waiting 
         Container orbit-apiserver Healthy 
         Container orbit-web Healthy 
         Container orbit-web Waiting 
         Container orbit-gateway Waiting 
         Container orbit-postgres Waiting 
         Container orbit-apiserver Waiting 
         Container orbit-apiserver Healthy 
         Container orbit-gateway Healthy 
         Container orbit-postgres Healthy 
         Container orbit-web Healthy 
        ==> Stack status
        NAME              IMAGE                   COMMAND                  SERVICE     CREATED              STATUS                    PORTS
        orbit-apiserver   orbit-apiserver:local   "docker-entrypoint.s…"   apiserver   About a minute ago   Up 34 seconds (healthy)   3000/tcp
        orbit-gateway     nginx:alpine            "/docker-entrypoint.…"   gateway     2 weeks ago          Up 2 weeks (healthy)      0.0.0.0:2086->80/tcp, [::]:2086->80/tcp
        orbit-pgbackup    postgres:16-alpine      "/bin/sh /usr/local/…"   pgbackup    2 weeks ago          Up 10 days                5432/tcp
        orbit-postgres    postgres:16-alpine      "/bin/sh -c 'mkdir -…"   postgres    3 weeks ago          Up 3 weeks (healthy)      5432/tcp
        orbit-web         orbit-web               "/docker-entrypoint.…"   web         39 seconds ago       Up 12 seconds (healthy)   80/tcp
        ✓ Upgrade complete — all services healthy.
  这是控制面替你记下的，不是用户说的。完整输出用 mcp__orbit__bg_output 按 id 读，sinceOffset 填上面的起点就只读新的部分。
</background-job-wake>

<scheduled-wakeup>
  你用 schedule_wakeup 约的唤醒到点了，控制面为此给你开了这一轮：
    2026-09-15T17:35:28.715Z 约在 720 秒后，2026-09-15T17:47:28.715Z 到点
    理由：升级作业的备份验证:runner 自更新可能中断本会话,12 分钟后的服务端持有唤醒确保有人检查部署结果
    你留给这一轮的话：
      升级备份唤醒:检查 bg_run 升级作业(upgrade to 39551b637)是否已结束且成功 — 1) apiserver 容器 dist 含 CLAUDE_CODE_MAX_CONTEXT_TOKENS 且 import catalogModels;2) 迁移 0274_session_import_source 已应用;3) 四服务健康;4) runner 自更新情况(web 镜像 ORBIT_SOURCE_SHA=39551b637)。若作业还在跑则再等。完成或失败都向用户汇报。
  这是控制面替你记下的，不是用户说的。还要再等，就再调一次 mcp__orbit__schedule_wakeup。
</scheduled-wakeup>`;
