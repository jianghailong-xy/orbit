import Foundation

/// `<background-jobs>` blocks copied verbatim out of this deployment's `run_event` rows — both
/// the wording written today and the one that shipped until 2026-09-15, which 85 of the 106
/// blocks in the record still carry.
///
/// None of it is typed out here: every block is transcribed from the browser's own fixtures
/// (`src/web/src/lib/backgroundJobs.fixtures.ts`), which is where each is stamped with the row it
/// came from. `BackgroundJobsCopyParityTests` reads that file back and fails if the two ends ever
/// come to hold different text — a reading proved against a block nobody sends is no reading.
enum BackgroundJobsFixtures {

    /// One job, ended: the shape 85 of the 106 blocks in this deployment have. (run_event 01a08842-5caa-7717-a77c-de1ebd7f701c)
    static let zhEnded = #"""
<background-jobs>
  你不在的时候结束了：
    bgj_0f012a1b9d50｜job｜/root/orbit/.claude/skills/upgrade/upgrade.sh 2>&1｜completed｜退出码 0｜输出 /root/.orbit/runs/01a066d7-5db3-763e-a3c4-0291a933ee0b/bgj_0f012a1b9d50.output
  这是控制面替你记下的，不是用户说的。输出文件由 runner 持有，engine 换过也还在。
  用 mcp__orbit__bg_output 按 id 读输出，mcp__orbit__bg_list 取完整清单。
</background-jobs>
"""#

    /// A job a runner killed, with the reason it recorded. (run_event 01a0a100-56d1-7012-9bad-c708439a2d78)
    static let zhKilled = #"""
<background-jobs>
  你不在的时候结束了：
    bgj_bf9bcf1f21d9｜job｜bash /root/.orbit/uploads/2e80923e-98c2-5d7d-b4b3-20414a203277/chain.sh > /root/.orbit/uploads/2e80923e-98c2-5d7d-b4b3-20414a203277/chain.log 2>&1｜killed｜原因 drain_cap｜输出 /root/.orbit/runs/2e80923e-98c2-5d7d-b4b3-20414a203277/bgj_bf9bcf1f21d9.output
  这是控制面替你记下的，不是用户说的。输出文件由 runner 持有，engine 换过也还在。
  用 mcp__orbit__bg_output 按 id 读输出，mcp__orbit__bg_list 取完整清单。
</background-jobs>
"""#

    /// A job whose runner process died without reporting an end: two fields, one outcome. (run_event 01a0a5dc-ac21-7056-b4f0-d4361ec7d326)
    static let zhNoEnd = #"""
<background-jobs>
  你不在的时候结束了：
    bgj_9056fe0308d8｜job｜/usr/bin/python3 /root/gpu-ladder.py｜没有结束报告｜托管它的 runner 进程已经不在了（重启、自更新或崩溃），按已停止处理，没有退出码｜输出 /root/.orbit/runs/01a0a34b-e497-762e-9742-1db4f1a0b7b0/bgj_9056fe0308d8.output
  这是控制面替你记下的，不是用户说的。输出文件由 runner 持有，engine 换过也还在。
  用 mcp__orbit__bg_output 按 id 读输出，mcp__orbit__bg_list 取完整清单。
</background-jobs>
"""#

    /// Both sections at once. (run_event 01a09db7-c545-775d-8ecd-237f3797fb8a)
    static let zhRunningAndEnded = #"""
<background-jobs>
  仍在运行（runner 托管，不随 engine 重启而死）：
    bgj_06e2cae99078｜service｜bash scratch/watch-task.sh 34OMyBQVd0YL67e5l47hV 'markDue 等锁取舍' 34NvlUSPiXQYp2g9I34SW 24 '会话已结束但任务仍 OPEN（等 owner 裁决证据）：读完成评论，给 owner 写一段结论摘要（改或不改、依据、风险），请其裁决，并再挂一个监控等任务 DONE；任务 DONE：看是否改了产品代码，改了就安排合入 main（合入闭包或 session_merge，合前 fetch 并确认含 origin/main）；失败：读会话输出判断原因，重跑或上报。' 20｜输出 /root/.orbit/runs/01a0992f-f058-7605-be10-6a02467ac860/bgj_06e2cae99078.output
  你不在的时候结束了：
    bgj_6dff87bf9125｜service｜bash scratch/watch-task.sh 34NPZIL9Hfavd9uqJ8tjD '核心复验 QA' 34NvlUSPiXQYp2g9I34SW 16 '读复验结论（verdict、评论、证据）。PASS：确认核心门禁 34NJZsv3am8LrTpZ4jc09 已完成，检查 P2 任务（34DGtxUKIA3u3K62T3Y0u、34DGtxXdn1PcOJxwF1k2n、34DGtxcc4kgCWg19LFgVZ、34DGtxfvTXBne7JmbkFZZ）和 P3 结构化进度任务是否按依赖开跑，再向 owner 汇报；FAIL 或 INCONCLUSIVE：为每个 P0/P1 建修复任务，修完后建新的独立复验任务（不覆盖旧 verdict），向 owner 汇报；会话失败或卡住：读会话输出判断原因，重跑或上报。之后给下一个要等的任务挂同样的监控作业。' 20｜completed｜退出码 0｜输出 /root/.orbit/runs/01a0992f-f058-7605-be10-6a02467ac860/bgj_6dff87bf9125.output
  这是控制面替你记下的，不是用户说的。输出文件由 runner 持有，engine 换过也还在。
  用 mcp__orbit__bg_output 按 id 读输出，mcp__orbit__bg_list 取完整清单。
</background-jobs>
"""#

    /// A Monitor section, which is nobody's row: it sits between a job and the closing narration. (run_event 01a09ef6-0c34-7521-a1d8-10adeb02e0ac)
    static let zhMonitor = #"""
<background-jobs>
  你不在的时候结束了：
    bgj_76417c73491e｜job｜bash scripts/run-pg-spec.sh src/apiserver/src/projects/evidence-judgment-removal.pg.spec.ts src/apiserver/src/tasks/task-judgment-removal.pg.spec.ts src/apiserver/src/projects/project-acceptance-wiring-removal.pg.spec.ts src/apiserver/src/sessions/needs-you-owner-decision.pg.spec.ts｜completed｜退出码 0｜输出 /root/.orbit/runs/01a09d97-5b36-7028-86a7-f4c2a27651cb/bgj_76417c73491e.output
  随上一个 engine 一起停掉的 Monitor（它跑在 engine 进程里，不会再通知你）：
    bw5y5c7g3｜Monitor｜tool_use toolu_014ZNoYjEsHpmEucpLSzBGzT｜timeout 3000000ms
  还要等的事，请重新安排等待。
  这是控制面替你记下的，不是用户说的。输出文件由 runner 持有，engine 换过也还在。
  用 mcp__orbit__bg_output 按 id 读输出，mcp__orbit__bg_list 取完整清单。
</background-jobs>
"""#

    /// A command that runs to several lines, some of them at the section indent. (run_event 01a0a622-610c-73dd-bfcc-84fc2b52ad5b)
    static let zhMultilineCommand = #"""
<background-jobs>
  仍在运行（runner 托管，不随 engine 重启而死）：
    bgj_e5753c1a7d36｜job｜set -o pipefail; python3 /root/bench-tp2-concurrency.py --ns 1,2,4,8,16 --repeats 3 --max-tokens 320 2>&1 | tee /root/glimmer-tp2-concurrency.log｜输出 /root/.orbit/runs/43de28bf-99da-5af0-980d-e9b81e8b9b5e/bgj_e5753c1a7d36.output
    bgj_5beaf98d55a4｜job｜setsid python3 /root/bench-tp2-concurrency.py --ns 1,2,4,8,16 --repeats 3 --max-tokens 320 > /root/glimmer-tp2-concurrency.log 2>&1 < /dev/null &
BGPID=$!
echo "workload pid=$BGPID (setsid 独立会话)"
wait $BGPID
echo "EXIT=$?"｜输出 /root/.orbit/runs/43de28bf-99da-5af0-980d-e9b81e8b9b5e/bgj_5beaf98d55a4.output
    bgj_dd920b03adc6｜job｜chmod +x /root/run-context-after-ladder.sh
setsid bash /root/run-context-after-ladder.sh > /root/run-context-after-ladder.out 2>&1 < /dev/null &
BGPID=$!
echo "chained pid=$BGPID"
wait $BGPID
echo "CHAIN EXIT=$?"｜输出 /root/.orbit/runs/43de28bf-99da-5af0-980d-e9b81e8b9b5e/bgj_dd920b03adc6.output
  这是控制面替你记下的，不是用户说的。输出文件由 runner 持有，engine 换过也还在。
  用 mcp__orbit__bg_output 按 id 读输出，mcp__orbit__bg_list 取完整清单。
</background-jobs>
"""#

    /// The wording that shipped 2026-09-15, which is what a block written today looks like. (run_event 01a0aa12-71ff-7508-84d7-a782a04c0827)
    static let enEnded = #"""
<background-jobs>
  Ended while you were away:
    bgj_41314cd48e66｜job｜cd src/macos/OrbitKit && swift test && cd ../OrbitApp/Sources/OrbitApp && for f in *.swift Views/*.swift Views/Console/*.swift; do swift -frontend -parse "$f" >/dev/null || exit 1; done; echo "ACCEPTANCE_EXIT=$?"｜completed｜exit code 0｜output /root/.orbit/runs/6add2dbe-be98-5ea7-a619-4b729c74e82f/bgj_41314cd48e66.output
  The control plane recorded this for you; the user did not say it. The output files belong to the runner, so they are still there after an engine change.
  Read output with mcp__orbit__bg_output by id; mcp__orbit__bg_list gives the whole list.
</background-jobs>
"""#

    /// Both sections, in the wording written today. (run_event 01a0aa12-711c-7761-bb2d-2f70cdd39c22)
    static let enRunningAndEnded = #"""
<background-jobs>
  Still running (runner-hosted, so an engine restart does not kill them):
    bgj_b6ac1419950c｜job｜bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-criterion-satisfaction.pg.spec.ts src/apiserver/src/projects/project-get-criterion-landing.pg.spec.ts src/apiserver/src/projects/project-get-criterion-satisfaction.pg.spec.ts src/apiserver/src/tasks/executable-acceptance-runtime-removal.pg.spec.ts src/apiserver/src/tasks/task-completion-criterion.pg.spec.ts src/apiserver/src/tasks/task-status-derived-end-to-end.pg.spec.ts src/apiserver/src/tasks/task-verification-doors.pg.spec.ts; echo "AFTER_EXIT=$?"｜output /root/.orbit/runs/4b424d6e-42c0-501a-a7e7-c191f899c441/bgj_b6ac1419950c.output
  Ended while you were away:
    bgj_e95780ddaf25｜job｜bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-criterion-satisfaction.pg.spec.ts src/apiserver/src/projects/project-get-criterion-landing.pg.spec.ts src/apiserver/src/projects/project-get-criterion-satisfaction.pg.spec.ts src/apiserver/src/tasks/executable-acceptance-runtime-removal.pg.spec.ts src/apiserver/src/tasks/task-completion-criterion.pg.spec.ts src/apiserver/src/tasks/task-status-derived-end-to-end.pg.spec.ts src/apiserver/src/tasks/task-verification-doors.pg.spec.ts; echo "BASELINE_EXIT=$?"｜completed｜exit code 0｜output /root/.orbit/runs/4b424d6e-42c0-501a-a7e7-c191f899c441/bgj_e95780ddaf25.output
  The control plane recorded this for you; the user did not say it. The output files belong to the runner, so they are still there after an engine change.
  Read output with mcp__orbit__bg_output by id; mcp__orbit__bg_list gives the whole list.
</background-jobs>
"""#

    /// Every block, under the name the browser's fixtures give it.
    static let all: [String: String] = [
        "ZH_ENDED": zhEnded,
        "ZH_KILLED": zhKilled,
        "ZH_NO_END": zhNoEnd,
        "ZH_RUNNING_AND_ENDED": zhRunningAndEnded,
        "ZH_MONITOR": zhMonitor,
        "ZH_MULTILINE_COMMAND": zhMultilineCommand,
        "EN_ENDED": enEnded,
        "EN_RUNNING_AND_ENDED": enRunningAndEnded,
    ]
}
