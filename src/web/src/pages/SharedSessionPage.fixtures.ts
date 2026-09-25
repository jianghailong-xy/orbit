import type { SharedEvent } from '../api';

/**
 * Transcript rows copied verbatim out of this deployment's `run_event` table (orbit-postgres,
 * 2026-09-25) — type, payload, turn id and time exactly as stored, which is what GET /shared/:token
 * pages out — each stamped with the row it came from:
 *
 *   select seq, type, payload, turn_id, created_at from run_event where id = '<run_event id>';
 *
 * Only `seq` is not theirs. The rows come from six sessions and a share shows one, so the spec
 * lays them out in one sequence of its own (SharedSessionPage.test.tsx).
 *
 * The session rows below are `session` columns as stored, from which the share derives the state
 * fields it answers with (sessions.service.ts `getShared` → `withSessionState`).
 */

type Row = Omit<SharedEvent, 'seq'>;

/** A progress line from the T6 run. (run_event 01a0d656-3e63-720c-addb-e29774f3d4ea: session eb4677c5-44c5-5257-8bbb-02e7da5fbbd2, seq 53) */
export const OLDER_PROGRESS_1: Row = {
  "type": "assistant",
  "payload": {
    "text": "正在读项目背景与相关记忆（变异证红的约束、overlay 铺法），接下来去看代码里的守卫位置。"
  },
  "turnId": "01a0d655-d462-7018-87f6-4b1a905b358c",
  "ts": "2026-09-25T02:12:51.204Z"
};

/** Another, later in the same run. (run_event 01a0d656-ac4d-71ab-b6e8-5b84fd25722b: session eb4677c5-44c5-5257-8bbb-02e7da5fbbd2, seq 113) */
export const OLDER_PROGRESS_2: Row = {
  "type": "assistant",
  "payload": {
    "text": "在读 claim / 池解析 / 准入的实现，接着看 T3b 已有的 `pool-provider-doors.pg.spec.ts` 和其余入口，避免重复。"
  },
  "turnId": "01a0d655-d462-7018-87f6-4b1a905b358c",
  "ts": "2026-09-25T02:13:19.332Z"
};

/** A person pasting this deployment's own address of a session. (run_event 019ee44a-7a4a-7281-be42-64e13f250a65: session 019ee446-de81-7fb3-b11f-9a0e765f63d7, seq 1) */
export const SAME_ORIGIN_URL: Row = {
  "type": "user",
  "payload": {
    "text": "https://orbit.wikova.com/sessions/33bYErXW8JTlgtJeBFfG5 这个 session 它其实是运行失败了，但是任务卡在了 in process 状态。这种情况，你帮我设计一下怎么处理比较好。"
  },
  "turnId": "019ee44a-76a7-76b2-a776-10bd06101c78",
  "ts": "2026-06-20T09:09:06.320Z"
};

/** The turn that started the T6 run: a Task started card (TaskStartCard) with its project. (run_event 01a0d655-e6d4-76da-9945-39d8f99bf490: session eb4677c5-44c5-5257-8bbb-02e7da5fbbd2, seq 1) */
export const TASK_STARTED: Row = {
  "type": "user",
  "payload": {
    "text": "请开始执行任务「T6 安全边界：跨 owner、准入与凭据不外泄的回归断言」。\n\n任务描述：\n本任务属于项目「Claude 账号池：按订阅配额均衡派发」。先 project_get 34JNIW4b31ujSVqEG784v 读目标、验收标准和作业指导。\n\n做什么：把池引入后必须守住的安全边界写成**独立的回归断言**，而不是散落在 T1/T3 的实现 spec 里顺带覆盖。这些是「一旦回退就没有下游会再问一遍」的性质。\n\n要断言的：\n- 个人 BYOK 池只对其 owner 的会话解析：跨 owner 解析拿不到 token，且不是靠错误信息推断，是断言解析结果本身。\n- 非订阅 token（sk-ant-api 前缀）与非 api.anthropic.com 端点的行既不被 plan-usage 探测，也不能成为池成员。准入复用 probesSubscriptionUsage。\n- 凭据不出现在任何浏览器可见的载荷里：对 providers 列表与池相关的所有响应做否定断言，全文不含 sk-ant 前缀。\n- 凭据不落 agent.env，只在 claim 时解密注进 job env。\n\n每条断言都要先做阴性控制：把对应的守卫去掉，确认它真的会红，再恢复。没红过的断言不算数。\n\n做法上尽量把断言写在能独立跑的层次（非 pg 的优先），需要真库的部分再走 pg spec。\n\n验收标准（判定本任务是否完成的依据）：\n新增的安全边界断言全部为绿，覆盖：跨 owner 解析池拿不到 token；sk-ant-api 前缀与非 api.anthropic.com 端点的行入池被拒；providers 与池相关响应全文不含 sk-ant 前缀；凭据不出现在 agent.env。且每一条都附一次阴性对照的记录：去掉守卫时它确实失败。\n\n请按以下步骤进行：\n1. 先用 task_get 查看该任务的完整信息与历史评论。\n2. 执行任务。\n3. 完成后，用 task_evidence_submit 提交完成证据信封，四个字段缺一不可：claim（你主张完成了什么）、criterion（{key, text}，抄自 project_get 的验收条目）、checks（每条 {kind, ref}，kind 取 TOOL_CALL / COMMIT / ARTIFACT，ref 指向本任务会话下已有的行；至少一条必须解析成功，否则整次提交被拒）、gaps（本次证据没能确立的部分，没有就给空数组）。TOOL_CALL 可再写 command/succeeded，服务端会拿它和被引 tool_call 逐字节核对。不要把命令原始输出抄进证据——Orbit 已经存了它；只由退出码回答的工作属于 EXECUTABLE 验收，不属于这里。不要用 task_comment 代替证据提交，也不要写 status——DONE 是解锁下游任务的授权，只能由任务声明的 completionCriterion 求值产生；服务端会拒绝任何主体直接写 DONE。\n4. 如果执行失败或未能完成，先用 task_comment 说明失败/未完成的原因，再用 task_update 将状态（status）置为 FAILED。不要置为 DONE，也不要置为 IN_PROGRESS——IN_PROGRESS 会被下游当成普通等待一直等下去，FAILED 才会把下游标成需要人介入。",
    "delivery": "enqueued",
    "taskStart": {
      "auto": true,
      "title": "T6 安全边界：跨 owner、准入与凭据不外泄的回归断言",
      "taskId": "01a0702b-242d-74ed-8c72-75d49d5b498b",
      "project": {
        "id": "01a07006-33b5-764d-ad26-26958a4bbcd9",
        "title": "Claude 账号池：按订阅配额均衡派发"
      },
      "description": "本任务属于项目「Claude 账号池：按订阅配额均衡派发」。先 project_get 34JNIW4b31ujSVqEG784v 读目标、验收标准和作业指导。\n\n做什么：把池引入后必须守住的安全边界写成**独立的回归断言**，而不是散落在 T1/T3 的实现 spec 里顺带覆盖。这些是「一旦回退就没有下游会再问一遍」的性质。\n\n要断言的：\n- 个人 BYOK 池只对其 owner 的会话解析：跨 owner 解析拿不到 token，且不是靠错误信息推断，是断言解析结果本身。\n- 非订阅 token（sk-ant-api 前缀）与非 api.anthropic.com 端点的行既不被 plan-usage 探测，也不能成为池成员。准入复用 probesSubscriptionUsage。\n- 凭据不出现在任何浏览器可见的载荷里：对 providers 列表与池相关的所有响应做否定断言，全文不含 sk-ant 前缀。\n- 凭据不落 agent.env，只在 claim 时解密注进 job env。\n\n每条断言都要先做阴性控制：把对应的守卫去掉，确认它真的会红，再恢复。没红过的断言不算数。\n\n做法上尽量把断言写在能独立跑的层次（非 pg 的优先），需要真库的部分再走 pg spec。",
      "listInstructions": null,
      "acceptanceCommand": null,
      "acceptanceCriteria": "新增的安全边界断言全部为绿，覆盖：跨 owner 解析池拿不到 token；sk-ant-api 前缀与非 api.anthropic.com 端点的行入池被拒；providers 与池相关响应全文不含 sk-ant 前缀；凭据不出现在 agent.env。且每一条都附一次阴性对照的记录：去掉守卫时它确实失败。",
      "completionCriterion": "EVIDENCE_JUDGMENT",
      "acceptanceExpectedExitCode": null
    }
  },
  "turnId": "01a0d655-d462-7018-87f6-4b1a905b358c",
  "ts": "2026-09-25T02:12:28.850Z"
};

/** A Bash call from the same run … (run_event 01a0d656-4793-751e-8919-17d2433a1717: session eb4677c5-44c5-5257-8bbb-02e7da5fbbd2, seq 56) */
export const BASH_CALL: Row = {
  "type": "tool_use",
  "payload": {
    "id": "toolu_01A3VzPt5yDrfxuZf72SWuJh",
    "name": "Bash",
    "input": {
      "command": "git log --oneline -15 && git status --short | head && ls src/apiserver/src/providers/ && ls src/apiserver/src/sessions/ | grep -i pool; ls src/apiserver/src/queue/ | grep -i pool",
      "description": "Inspect branch history and pool-related files"
    }
  },
  "turnId": "01a0d655-d462-7018-87f6-4b1a905b358c",
  "ts": "2026-09-25T02:12:53.594Z"
};

/** … and its result, 2051 characters: longer than the 2048 a page keeps (MAX_EVENT_PAYLOAD). (run_event 01a0d656-4a88-737b-abd3-9472778ad806: session eb4677c5-44c5-5257-8bbb-02e7da5fbbd2, seq 58) */
export const BASH_RESULT: Row = {
  "type": "tool_result",
  "payload": {
    "content": "774b8ba61 Update db-write-inventory.ts and 12 more files\nbc4fa5012 Merge refs/heads/main into refs/heads/project/34JNIW4b31ujSVqEG784v\n60c6bcf8c docs(mocks): the parking-strip row for tasks a session created\n39c8401b4 chore(release): publish the ALREADY_MERGED receipt check as 0.1.182\n41263384f fix(runner): merge_receipt refuses an ALREADY_MERGED sourceSha the target does not contain\n71c31f595 fix(projects): draw a blocked promotion's card where it was blocked\n2002efe70 perf(apiserver): the Ready badge and the dependency graph ask the prerequisite guard first\nb2529057b Merge refs/heads/project/34JNIW4b31ujSVqEG784v into refs/heads/main\nd4fbd7c5b Merge branch 'orbit/t-land-t1-t4-main-7e6301' into main\nbe81e86d4 feat(apiserver): quotaGate, auto-retry and retry arming let an account pool with room through\n339ce8433 Update migration.sql and 12 more files\nf0e8e28e1 feat(providers): pick an account pool member by 5-hour room, as a pure selector\n0ba446ce9 feat(apiserver): add provider pool schema for grouped subscription providers\n0feca4933 perf(apiserver): the project index narrows READY before it walks a dependency chain\n969e0109b feat(apiserver): quotaGate, auto-retry and retry arming let an account pool with room through\nadmin-providers.controller.ts\ncodex-account.ts\ncustom-provider.spec.ts\ncustom-provider.ts\ndto.spec.ts\ndto.ts\nkimi-runtime-migration.spec.ts\nlist-public-plan-usage.spec.ts\nlist-usable.spec.ts\nmodel-catalog.service.ts\nmodel-catalog.spec.ts\nmodel-catalog.ts\nmoonshot-kimi-migration.spec.ts\nopencode-compatibility-provider.spec.ts\nplan-usage-accounts.spec.ts\nplan-usage-accounts.ts\nplan-usage.service.spec.ts\nplan-usage.service.ts\nplan-usage.spec.ts\nplan-usage.ts\npool-select.spec.ts\npool-select.ts\npreset-overlay.spec.ts\npreset-overlay.ts\nprovider-crypto.spec.ts\nprovider-crypto.ts\nprovider-pool.pg.spec.ts\nprovider-slug.spec.ts\nprovider-slug.ts\nproviders.controller.ts\nproviders.module.ts\nproviders.service.ts\nreveal-key.spec.ts\ntest-connection.spec.ts\npool-provider-doors.pg.spec.ts\npool-claim-selection.pg.spec.ts",
    "isError": false,
    "toolUseId": "toolu_01A3VzPt5yDrfxuZf72SWuJh"
  },
  "turnId": "01a0d655-d462-7018-87f6-4b1a905b358c",
  "ts": "2026-09-25T02:12:54.355Z"
};

/** A reply naming a task, a session and a project the way agents are told to (`orbit-task:` …). (run_event 01a0d61f-ae75-7415-a402-e2b910164b23: session 01a0d61b-4395-758a-bcc4-a7c12cd36055, seq 720) */
export const REFERENCES_REPLY: Row = {
  "type": "assistant",
  "payload": {
    "text": "这次不需要新动作：失败已经处理好了，[T3b 放开池 slug 的写入口](orbit-task:34ORZ0jC7dpeqvYxg35Rn) 在 01:09 重启后已经真正跑起来。\n\n**为什么死**：01:04 那次会话在起跑前就被 runner 拒了（`DEPENDENCY_BASE_NOT_LANDED`），要求基底包含 `59c066d2b`。这个 SHA 来自 01:03 给 T3 补记的 ALREADY_MERGED 回执，是 T3 在 09-14 的原分支 tip。T3 的内容是以改写过 SHA 的副本进的 main，所以这个 SHA 既不在 main 上，也不在项目分支上。系统自动评论建议「让集成线吸收 main」（SYNC_INTEGRATION_LINE），这招在这里没用：main 自己也不含这个 SHA，同步完照样会拒。\n\n**已经做了什么**：协调会话拆掉了 T3b 对 T3 的依赖边，并在 01:09 重启了任务。我查库核实了新会话 [执行任务：T3b](orbit-session:1wSVXdBhiCI1t54AHKoaVv)：\n- 状态是 RUNNING，已经在读代码；\n- 基底是项目分支 `be81e86d4`，它的树和 main 完全一致，池代码都在；\n- 「必须包含」列表为空，任务上的拒绝记录已清掉。\n\n**还剩一个隐患**：T1–T4 那四条 ALREADY_MERGED 回执填的 SHA 都不是 main 的祖先。回执只能追加，补记一条对的也盖不掉错的。所以以后给任何任务加指向 T1–T4 的依赖边，那个任务都会永远被这样拒。目前的依赖链是 T3b → T5、T6 → T7，没有这种边。\n\n我写了什么：\n- 在 T3b 上留了一条评论，写清根因、那条自动评论的处置为什么不适用，以及上面这个隐患；\n- 协调会话已为此写过一条记忆，我补了一行：拆边这个办法已实测有效。\n\n我没有开新任务，也没有重复启动 T3b。[项目](orbit-project:34JNIW4b31ujSVqEG784v)还没满足的判据 1、5、6、7 各有任务对应：T3b 正在跑，T5、T6 等它完成，T7 等 T5 和 T6。"
  },
  "turnId": "01a0d61b-44a1-709c-b8d0-0c09930c38ec",
  "ts": "2026-09-25T01:13:15.552Z"
};

/** A message with an `orbit-task:` reference and the `<referenced-task>` note delivery appended (ReferencedTaskNote). (run_event 01a0a2e1-2bc8-76b6-8cde-02a1227751ea: session 62d37865-5c42-5ca9-9b42-1a4606e92531, seq 1953) */
export const REFERENCED_TASK: Row = {
  "type": "user",
  "payload": {
    "text": "协调会话（项目 34ODoUKJGEsfbgcJDGS4q）：你的修复还没提交，这一轮把收尾做完就行，别写新功能。\n\n现状：分支 `orbit/claude-2-1-270-set-model-real-cli-main-667546` 的 tip 还等于开工基线 `98219b02c`，工作树里只有一个改动文件 `src/runner-go/claude_setconfig_real_cli_test.go`。任务已经按验收命令判成 DONE，但成果没进 git。\n\n1. `git status --porcelain` 核对一遍，只提交该提交的。\n2. 提交到当前分支，信息按仓库习惯（`fix(runner-go): …` 或 `test(runner-go): …`），结尾加：\n   `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`\n3. `git fetch origin && git rebase origin/main`。main 已经走到 `170b59cd5`，其中有一个提交动了 `src/runner-go/mcp.go`，和你改的测试文件不重叠，正常不会冲突；真冲突就停下来在评论里写明。\n4. 在 rebase 后的树上原样重跑验收命令 `cd src/runner-go && go test -count=1 -run '^TestRealClaude' ./...`，确认退出 0。\n5. 完成评论里补上：分支名、commit sha、改动前红与改动后绿两段输出，以及这两条测试现在断言的是 CLI 的哪个行为（你上一条评论里的探测结论很好，这里只要把「测试现在守住什么」写清楚）。\n6. 不要 merge，不要改任务状态。\n\n合入由我来做。你落地之后，我会重跑 [runner 从项目集成线的 tip 创建 worktree](orbit-task:34OEE9MQXMEm0h0Ptm1GG) 的验收，把它那条被这个 main 红误判的 FAILED 翻正。\n\n<referenced-task id=\"34OEE9MQXMEm0h0Ptm1GG\">\n  标题   runner 从项目集成线的 tip 创建 worktree\n  状态   FAILED\n  所属   (无列表) · 负责 orbit\n  运行   共 1 次，其中执行过 turn 的 1 次；最近一次：FAILED (unattributed), 31 turns\n  详情请用 task_get 自取。\n</referenced-task>",
    "delivery": "enqueued",
    "controlPlaneNote": "\n\n<referenced-task id=\"34OEE9MQXMEm0h0Ptm1GG\">\n  标题   runner 从项目集成线的 tip 创建 worktree\n  状态   FAILED\n  所属   (无列表) · 负责 orbit\n  运行   共 1 次，其中执行过 turn 的 1 次；最近一次：FAILED (unattributed), 31 turns\n  详情请用 task_get 自取。\n</referenced-task>"
  },
  "turnId": "01a0a2df-ed56-77ef-9786-7930206ce5ae",
  "ts": "2026-09-15T02:24:20.675Z"
};

/** A turn a watch queued, naming the task that changed (WatchWakeCard). (run_event 01a0c4ac-ce30-7670-b5b7-24ab46147c4c: session 01a09b58-aabf-7429-a003-20d67c52d73e, seq 726504) */
export const WATCH_WAKE: Row = {
  "type": "user",
  "payload": {
    "text": "Orbit Watch 01a0c4ac-a4c5-743e-a28d-651d1d44fa5c matched at generation 1: ANY TASK_TERMINAL 1/1\n\nThis turn was queued by the watch, not typed by a person. What the watch recorded when its condition held:\n\n```json\n{\n  \"watchId\": \"01a0c4ac-a4c5-743e-a28d-651d1d44fa5c\",\n  \"generation\": 1,\n  \"matchedAt\": \"2026-09-21T15:54:07.475Z\",\n  \"reason\": \"ANY TASK_TERMINAL 1/1\",\n  \"changedTargets\": [\n    {\n      \"kind\": \"TASK\",\n      \"id\": \"01a0c49c-468f-766f-80ff-1fd6245c6dd0\",\n      \"state\": \"SATISFIED\",\n      \"observed\": {\n        \"status\": \"DONE\"\n      }\n    }\n  ],\n  \"latestSnapshot\": {\n    \"evaluatedAt\": \"2026-09-21T15:54:07.475Z\",\n    \"targets\": [\n      {\n        \"kind\": \"TASK\",\n        \"id\": \"01a0c49c-468f-766f-80ff-1fd6245c6dd0\",\n        \"epoch\": 0,\n        \"state\": \"SATISFIED\",\n        \"changed\": true,\n        \"leaves\": {\n          \"TASK_TERMINAL\": true\n        },\n        \"observed\": {\n          \"status\": \"DONE\"\n        }\n      }\n    ]\n  }\n}\n```",
    "delivery": "enqueued"
  },
  "turnId": "01a0c4ac-c588-7609-8d63-5f3e7ce71506",
  "ts": "2026-09-21T15:54:14.034Z"
};

/** An exception item delivered to a coordinator: an Open item card (OpenItemDeliveryCard) with its task and the failed session. (run_event 01a0d61d-baff-76eb-8b84-905e2cd2618f: session 01a06fff-ff20-7638-b8ed-56be3c7741a2, seq 8287) */
export const EXCEPTION_ITEM: Row = {
  "type": "user",
  "payload": {
    "text": "【例外待办】Merge conflict: T4 刹车让路：池内有余量时 quotaGate 与 auto-retry 不再空等\n\n项目 34JNIW4b31ujSVqEG784v 的一次集成没有把工作放进集成线：\n合并冲突（REBASE），目标分支 refs/heads/project/34JNIW4b31ujSVqEG784v 没有动。\n冲突的文件（3 个）：\n- src/apiserver/src/common/db-write-inventory.ts\n- src/apiserver/src/tasks/task-judgment-data-preserved.spec.ts\n- src/shared/src/codec.ts\n\n这条待办的负责人是你。平台不会自己重试一次没有落地的集成，所以不会有第二次作业自己出现；要判断的是下一步。\n先读这条任务（task_get，taskId 传 34JOHuCjY8f8HG5IuyuOb，评论与它的会话都在上面），再决定是重新跑（task_start）、另起一个取代它的任务（task_create 带 supersedesTaskId），还是取消（task_update 置 CANCELLED）。任务落地、被取消或被取代之后，这条待办由平台自己关闭，你不用回报。平台自己关不掉的情况——这项工作已经用别的方式在目标分支上了，或者你已经另行处理过——用 open_item_resolve 写明理由把它关掉，理由会留在待办上。\n\n待办编号 34UffopHomSXqNTFWo7E0。这是一条通知，不是打断：你正在跑的那一轮不会被它中断，你是在那一轮结束之后才读到它的，所以以你自己刚读到的库里状态为准。",
    "delivery": "enqueued",
    "openItemDelivery": {
      "kind": "INTEGRATION_CONFLICT",
      "task": {
        "id": "01a0702b-23f8-767d-94a1-4cedbce91875",
        "title": "T4 刹车让路：池内有余量时 quotaGate 与 auto-retry 不再空等",
        "sessionId": "8e5051f4-33e2-5d22-9e19-95e34b4ff4d2"
      },
      "check": null,
      "files": [
        "src/apiserver/src/common/db-write-inventory.ts",
        "src/apiserver/src/tasks/task-judgment-data-preserved.spec.ts",
        "src/shared/src/codec.ts"
      ],
      "title": "Merge conflict: T4 刹车让路：池内有余量时 quotaGate 与 auto-retry 不再空等",
      "itemId": "01a0d616-7353-73ca-bb34-87e7678dead0",
      "actions": [
        "OPEN_COORDINATOR",
        "OPEN_TASK_SESSION",
        "RETRY",
        "CANCEL_TASK"
      ],
      "failure": null,
      "landing": {
        "state": "ON_UPSTREAM",
        "receipts": 1,
        "upstream": "main",
        "integration": "project/34JNIW4b31ujSVqEG784v"
      },
      "errorCode": null,
      "targetRef": "refs/heads/project/34JNIW4b31ujSVqEG784v"
    }
  },
  "turnId": "01a0d616-74f3-722a-9df0-9cfc55f7f2b5",
  "ts": "2026-09-25T01:11:07.560Z"
};

/** A `session` row's state columns, the title and when it began, and its workspace's name. */
export interface SessionRow {
  title: string;
  status: string;
  endReason: string | null;
  completedAt: string | null;
  archivedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  workspaceName: string | null;
}

/** The T6 run: finished, and filed Completed when its task was done. (session eb4677c5-44c5-5257-8bbb-02e7da5fbbd2) */
export const T6_RUN: SessionRow = {
  "title": "执行任务：T6 安全边界：跨 owner、准入与凭据不外泄的回归断言",
  "status": "SUCCEEDED",
  "endReason": "task_done",
  "completedAt": "2026-09-25T03:23:13.808Z",
  "archivedAt": "2026-09-25T03:23:13.808Z",
  "deletedAt": null,
  "createdAt": "2026-09-25T02:12:20.367Z",
  "workspaceName": "orbit"
};

/** A coordinator conversation, open and waiting for its next message. (session 01a06fff-ff20-7638-b8ed-56be3c7741a2) */
export const COORDINATOR: SessionRow = {
  "title": "Claude 账号池：按订阅配额均衡派发",
  "status": "AWAITING_INPUT",
  "endReason": null,
  "completedAt": null,
  "archivedAt": null,
  "deletedAt": null,
  "createdAt": "2026-09-05T05:17:23.104Z",
  "workspaceName": "orbit"
};

/** The run that wrote this file, while it ran. (session 554722e4-3add-528d-ae9b-6724b086969c) */
export const THIS_RUN: SessionRow = {
  "title": "执行任务：T2 公开会话页：统一外壳、按页加载、公开页不再出现 app 链接、/s/ 响应头",
  "status": "RUNNING",
  "endReason": null,
  "completedAt": null,
  "archivedAt": null,
  "deletedAt": null,
  "createdAt": "2026-09-25T09:08:44.574Z",
  "workspaceName": "orbit"
};
