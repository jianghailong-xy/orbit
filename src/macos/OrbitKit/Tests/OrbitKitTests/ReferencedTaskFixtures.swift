import Foundation

/// `<referenced-task>` notes copied verbatim out of this deployment's `run_event` rows.
///
/// None of it is typed out here: every note is transcribed from the browser's own fixtures
/// (`src/web/src/lib/referencedTask.fixtures.ts`), which is where each is stamped with the row it
/// came from. `ReferencedTaskCopyParityTests` reads that file back and fails if the two ends ever
/// come to hold different text — a reading proved against a note nobody sends is no reading.
enum ReferencedTaskFixtures {

    /// One reference, the shape 25 of this deployment's 26 notes have. (run_event 01a0a2e1-2bc8-76b6-8cde-02a1227751ea)
    static let oneTask = #"""
<referenced-task id="34OEE9MQXMEm0h0Ptm1GG">
  标题   runner 从项目集成线的 tip 创建 worktree
  状态   FAILED
  所属   (无列表) · 负责 orbit
  运行   共 1 次，其中执行过 turn 的 1 次；最近一次：FAILED (unattributed), 31 turns
  详情请用 task_get 自取。
</referenced-task>
"""#

    /// A task nothing has run yet, unassigned and in no list. (run_event 01a01abc-1366-7132-a39f-8d147103a0ba)
    static let neverRan = #"""
<referenced-task id="349vy0HknpSjHwdwJ31O1">
  标题   P0｜审阅并发布文档与社区基线
  状态   OPEN
  所属   (无列表) · 负责 (未指派)
  运行   共 0 次，其中执行过 turn 的 0 次；最近一次：从未运行
  详情请用 task_get 自取。
</referenced-task>
"""#

    /// Two references in one note, the first of them a verification task. (run_event 01a095e9-453d-75ee-b48c-942726d7650c)
    static let twoTasks = #"""
<referenced-task id="34DH29mTc7OQ6AwxAFIJu">
  标题   Claude QA：验证 Watch 核心后端与恢复语义
  状态   DONE · 验收任务
  所属   (无列表) · 负责 orbit
  运行   共 1 次，其中执行过 turn 的 1 次；最近一次：SUCCEEDED, 144 turns
  详情请用 task_get 自取。
</referenced-task>

<referenced-task id="34NNZFNbWKndTBsVbh8jc">
  标题   P1 补：RESUME_SESSION Watch 到期未成立时向观察者交付一个 EXPIRED turn（契约 §5 / 向量 20）
  状态   OPEN
  所属   (无列表) · 负责 orbit
  运行   共 1 次，其中执行过 turn 的 0 次；最近一次：RUNNING, 0 turns
  详情请用 task_get 自取。
</referenced-task>
"""#

    /// Eight in one note — the most anyone has referenced at once, which is also the cap (MAX_REFERENCES). (run_event 01a09d8b-0140-74dd-918d-ffd9f31ca493)
    static let eightTasks = #"""
<referenced-task id="34ONkD7V6aKjyLdHXyimz">
  标题   合入闭包 2：四个 Watch 跟进修复落到 main，补上 :revoked / :unresolvable 唤醒的排空缺口
  状态   DONE
  所属   (无列表) · 负责 orbit
  运行   共 1 次，其中执行过 turn 的 1 次；最近一次：SUCCEEDED, 125 turns
  详情请用 task_get 自取。
</referenced-task>

<referenced-task id="34OAsTIS8JuGm5H2j95qO">
  标题   合入闭包：Watch 核心实现、D1/D2/D3 修复与独立 QA spec 线性落到本地 main
  状态   DONE
  所属   (无列表) · 负责 orbit
  运行   共 1 次，其中执行过 turn 的 1 次；最近一次：SUCCEEDED, 59 turns
  详情请用 task_get 自取。
</referenced-task>

<referenced-task id="34NcCcju6ItuCcHBoeaqd">
  标题   Watch：D1 与 D2 修复合流后，排队中的 EXPIRED 唤醒被会话结束排空仍记 DELIVERED
  状态   DONE
  所属   (无列表) · 负责 orbit
  运行   共 1 次，其中执行过 turn 的 1 次；最近一次：SUCCEEDED, 71 turns
  详情请用 task_get 自取。
</referenced-task>

<referenced-task id="34NaYaztogra0gaMFo4mY">
  标题   Watch：打断观察者或撤回排队 turn 时，排队中的唤醒被删除，delivery 仍记 DELIVERED
  状态   DONE
  所属   (无列表) · 负责 orbit
  运行   共 1 次，其中执行过 turn 的 1 次；最近一次：SUCCEEDED, 113 turns
  详情请用 task_get 自取。
</referenced-task>

<referenced-task id="34NaebW9aR15Mr8WrYyV5">
  标题   RESUME_SESSION Watch 落为 REVOKED / UNRESOLVABLE 时向观察者交付一个终态 turn（CANCELLED 不交付）
  状态   DONE
  所属   (无列表) · 负责 orbit
  运行   共 1 次，其中执行过 turn 的 1 次；最近一次：SUCCEEDED, 132 turns
  详情请用 task_get 自取。
</referenced-task>

<referenced-task id="34Nb44UnFuiGKvXwWfxFY">
  标题   Watch QA spec 负载下不稳：QA-03 撞 P2028 后泄漏 invariant 连接、整份 spec 挂到 rc=124；QA-05 并发前提在负载下不成立
  状态   DONE
  所属   (无列表) · 负责 orbit
  运行   共 1 次，其中执行过 turn 的 1 次；最近一次：SUCCEEDED, 171 turns
  详情请用 task_get 自取。
</referenced-task>

<referenced-task id="34NJZsv3am8LrTpZ4jc09">
  标题   完成门禁：Watch 核心后端通过独立 Claude QA
  状态   OPEN
  所属   (无列表) · 负责 (未指派)
  运行   共 0 次，其中执行过 turn 的 0 次；最近一次：从未运行
  详情请用 task_get 自取。
</referenced-task>

<referenced-task id="34DH29mTc7OQ6AwxAFIJu">
  标题   Claude QA：验证 Watch 核心后端与恢复语义
  状态   DONE · 验收任务
  所属   (无列表) · 负责 orbit
  运行   共 1 次，其中执行过 turn 的 1 次；最近一次：SUCCEEDED, 144 turns
  详情请用 task_get 自取。
</referenced-task>
"""#

    /// A reference sharing a note with the inventory a returning engine was handed: two blocks, neither of them the other's to draw. (run_event 01a09e3a-fedf-7406-b60a-c87c02edce1e)
    static let withBackgroundJobs = #"""
<referenced-task id="34NPZIL9Hfavd9uqJ8tjD">
  标题   Claude QA 复验：Watch 核心后端（D1/D2/D2b 修复后）
  状态   DONE · 验收任务
  所属   (无列表) · 负责 orbit
  运行   共 1 次，其中执行过 turn 的 1 次；最近一次：SUCCEEDED, 101 turns
  详情请用 task_get 自取。
</referenced-task>

<background-jobs>
  你不在的时候结束了：
    bgj_0c8d57e95552｜job｜bash -c 'F="src/apiserver/src/watches/watch-wake-drain.ts src/apiserver/src/watches/watch-delivery.service.ts"; git checkout HEAD~1 -- $F || exit 99; git status --short; bash scripts/run-pg-spec.sh src/apiserver/src/watches/watch-delivery.pg.spec.ts src/apiserver/src/watches/watch-end-delivery.pg.spec.ts > /root/.orbit/uploads/6eec9888-7e05-5f08-8ecb-5e9003516277/negctl-red.log 2>&1; rc=$?; git checkout HEAD -- $F; echo "restored:"; git status --short; echo "run-pg-spec rc=$rc"; exit $rc'｜failed｜退出码 1｜输出 /root/.orbit/runs/6eec9888-7e05-5f08-8ecb-5e9003516277/bgj_0c8d57e95552.output
  这是控制面替你记下的，不是用户说的。输出文件由 runner 持有，engine 换过也还在。
  用 mcp__orbit__bg_output 按 id 读输出，mcp__orbit__bg_list 取完整清单。
</background-jobs>
"""#

    /// Every note, under the name the browser's fixtures give it.
    static let all: [String: String] = [
        "ONE_TASK": oneTask,
        "NEVER_RAN": neverRan,
        "TWO_TASKS": twoTasks,
        "EIGHT_TASKS": eightTasks,
        "WITH_BACKGROUND_JOBS": withBackgroundJobs,
    ]
}
