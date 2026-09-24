import XCTest
@testable import OrbitKit

/// The project page's remaining web sections — the overview's banners, the coordinator's dispatch
/// box, Blockers, the Run queue, the criteria card's framing and the task rows' tags — case by case.
final class ProjectPageSectionsTests: XCTestCase {

    // MARK: overview

    func testReadyWorkWithNothingRunningIsSaidInTheBannersWords() {
        let stalled = ProjectPanoramaBuckets(running: 0, ready: 7, done: 5, cancelled: 1)
        XCTAssertTrue(ProjectPage.stalledOnReady(stalled))
        XCTAssertFalse(ProjectPage.stalledOnReady(ProjectPanoramaBuckets(running: 1, ready: 7)))
        XCTAssertEqual(ProjectPage.stalledSentence(ready: 7),
                       "7 tasks are ready, but nothing is running. Check the assignees' runner and provider.")
        XCTAssertEqual(ProjectPage.stalledSentence(ready: 1),
                       "1 task is ready, but nothing is running. Check the assignees' runner and provider.")
    }

    func testAnOpenProjectWhoseWorkHasAllSettledIsReadyToWrapUp() {
        let settled = ProjectPanoramaBuckets(done: 12, cancelled: 1)
        XCTAssertTrue(ProjectPage.wrappingUp(status: .open, settled))
        XCTAssertFalse(ProjectPage.wrappingUp(status: .done, settled))
        XCTAssertFalse(ProjectPage.wrappingUp(status: .open, ProjectPanoramaBuckets(ready: 1, done: 12)))
        XCTAssertFalse(ProjectPage.wrappingUp(status: .open, ProjectPanoramaBuckets()))
        XCTAssertEqual(ProjectPage.wrapUpSentence(settled: 13),
                       "All 13 tasks are settled. The project stays open until its outcome is confirmed.")
    }

    // MARK: coordinator

    func testTheDispatchBoxCountsTheOpenWorkBehindTheConversation() {
        XCTAssertEqual(ProjectPage.dispatchNote(openTaskCount: 7, finished: false).heading, "Manual dispatch")
        XCTAssertEqual(ProjectPage.dispatchNote(openTaskCount: 7, finished: false).text,
                       "7 open tasks are coordinated from this conversation.")
        XCTAssertEqual(ProjectPage.dispatchNote(openTaskCount: 1, finished: false).text,
                       "1 open task is coordinated from this conversation.")
        XCTAssertEqual(ProjectPage.dispatchNote(openTaskCount: nil, finished: false).text,
                       "Open tasks are coordinated from this conversation.")
        XCTAssertEqual(ProjectPage.dispatchNote(openTaskCount: 0, finished: false).text, "No open tasks remain.")
        let finished = ProjectPage.dispatchNote(openTaskCount: 2, finished: true)
        XCTAssertEqual(finished.heading, "Open work")
        XCTAssertEqual(finished.text, "A completed conversation is told nothing new — and 2 open tasks still point at it.")
    }

    func testTheCoordinatorsPressRepliesOnlyWhileItIsWaitingOnTheReader() {
        XCTAssertEqual(ProjectPage.coordinatorPress(finished: false, needsReply: true), "Reply to coordinator")
        XCTAssertEqual(ProjectPage.coordinatorPress(finished: false, needsReply: false), "Open coordinator")
        XCTAssertEqual(ProjectPage.coordinatorPress(finished: true, needsReply: true), "Open coordinator")
    }

    // MARK: blockers

    private let whoNotInTeam = ProjectBlocker(
        id: "b1", kind: "WHO_NOT_IN_TEAM", owner: "USER", severity: "CRITICAL",
        requiredAction: "Add the assigned agent to this project team, or reassign the task.",
        subjectTitle: "合并 TasksView 的两个独立轮询循环", firstSeenAt: "2026-08-21T17:20:23.000Z")

    func testABlockerIsNamedByItsKindBesideWhoHasToAct() {
        let headline = ProjectPage.blockerHeadline(whoNotInTeam)
        XCTAssertEqual(headline, ProjectPage.BlockerHeadline(tag: "Needs you", tone: .warning, title: "Who not in team"))
        let coordinator = ProjectBlocker(id: "b2", kind: "AWAITING_USER_INPUT", owner: "COORDINATOR")
        XCTAssertEqual(ProjectPage.blockerHeadline(coordinator).tag, "Coordinator")
        XCTAssertEqual(ProjectPage.blockerHeadline(coordinator).title, "Awaiting user input")
        let scope = ProjectBlocker(id: "b3", kind: "DELIVERY_REVIEW", detail: .init(reason: "OUTSIDE_DECLARED_SCOPE"))
        XCTAssertEqual(ProjectPage.blockerHeadline(scope).title, "Changed files it didn’t declare")
        XCTAssertEqual(ProjectPage.blockerHeadline(scope).tag, "Needs your approval")
    }

    func testABlockerSaysWhatWorkItIsAboutAndItsFilesInOneLine() {
        XCTAssertEqual(ProjectPage.blockerSubjectLine(whoNotInTeam), "合并 TasksView 的两个独立轮询循环")
        let moved = ProjectBlocker(id: "b", kind: "K", subjectTitle: "Task", criterionOrdinal: 3, criterionRevision: 2,
                                   detail: .init(reason: "ACCEPTANCE_STANDARD_MOVED"))
        XCTAssertEqual(ProjectPage.blockerSubjectLine(moved), "Task · criterion 3 is now revision 2")
        XCTAssertNil(ProjectPage.blockerSubjectLine(ProjectBlocker(id: "b", kind: "K")))
        XCTAssertEqual(ProjectPage.blockerPathsLine(["src/a/one.ts", "src/a/two.ts", "src/b/three.ts"]),
                       "src/a/one.ts · two.ts · +1")
        XCTAssertEqual(ProjectPage.blockerPathsLine(["src/a/one.ts", "lib/x.ts"]), "src/a/one.ts · lib/x.ts")
        XCTAssertNil(ProjectPage.blockerPathsLine([]))
    }

    func testABlockerSaysHowLongItHasStoodAndHowItEnded() throws {
        let now = try XCTUnwrap(RelativeTime.parse("2026-09-24T14:41:12.000Z"))
        XCTAssertEqual(ProjectPage.blockerSince(whoNotInTeam.firstSeenAt, now: now), "since 33d")
        XCTAssertEqual(ProjectPage.blockerSince("2026-09-24T14:10:00.000Z", now: now), "since 31m")
        XCTAssertEqual(ProjectPage.blockerSince(nil, now: now), "since just now")
        let auto = ProjectBlocker(id: "r", kind: "K", resolvedAt: "2026-08-21T16:12:28.738Z", resolvedBy: "AUTO")
        let utc = try XCTUnwrap(TimeZone(identifier: "UTC"))
        XCTAssertEqual(ProjectPage.blockerResolution(auto, timeZone: utc),
                       "Auto-resolved — its condition no longer holds (08-21 16:12)")
        let byYou = ProjectBlocker(id: "r", kind: "K", resolvedBy: "USER", resolutionNote: "  agent added  ")
        XCTAssertEqual(ProjectPage.blockerResolution(byYou, timeZone: utc), "Resolved by you — agent added")
    }

    func testAResolvedBlockerIsNamedThenSaysHowItEnded() throws {
        let utc = try XCTUnwrap(TimeZone(identifier: "UTC"))
        XCTAssertEqual(ProjectPage.blockerName(whoNotInTeam), "Who not in team · 合并 TasksView 的两个独立轮询循环")
        XCTAssertEqual(ProjectPage.blockerName(ProjectBlocker(id: "b", kind: "WHO_NOT_IN_TEAM", subjectTitle: "")),
                       "Who not in team")
        let auto = ProjectBlocker(id: "r", kind: "WHO_NOT_IN_TEAM", subjectTitle: "Baseline",
                                  resolvedAt: "2026-08-21T16:12:28.738Z", resolvedBy: "AUTO")
        XCTAssertEqual(ProjectPage.blockerResolvedLine(auto, timeZone: utc),
                       "Who not in team · Baseline — Auto-resolved — its condition no longer holds (08-21 16:12)")
        XCTAssertEqual(ProjectPage.blockersResolvedSummary(ProjectBlockers(resolved: [auto], resolvedCount: 4),
                                                           timeZone: utc),
                       "4 resolved · latest: Auto-resolved — its condition no longer holds (08-21 16:12)")
        XCTAssertNil(ProjectPage.blockersResolvedSummary(ProjectBlockers()))
        XCTAssertEqual(ProjectPage.resolveBlockerMessage(whoNotInTeam),
                       "Who not in team · 合并 TasksView 的两个独立轮询循环\n\nRecorded with your name and this reason.")
    }

    // MARK: run queue

    func testTheRunQueueSummarySaysWhatIsInItAndHowItIsSorted() {
        let ready = ProjectReadyToRun(readyCount: 7)
        XCTAssertEqual(ProjectPage.queueSummary(ready), "7 ready · sorted by work unblocked")
        XCTAssertEqual(ProjectPage.queueHelp(ready), "Ready tasks can start now.")
        let busy = ProjectReadyToRun(readyCount: 2, queuedCount: 1, runningCount: 3, pausedCount: 1)
        XCTAssertEqual(ProjectPage.queueSummary(busy),
                       "3 running · 1 queued · 2 ready · 1 ready in paused lists · ready tasks sorted by work unblocked")
        let big = ProjectReadyToRun(readyCount: 4, impactTruncated: .init(maxTasks: 2000))
        XCTAssertEqual(ProjectPage.queueSummary(big), "4 ready · stable order")
    }

    func testARunQueueRowSaysWhereItStandsAndWhatStartingItReleases() {
        let row = ProjectReadyToRun.Item(taskId: "t", title: "T", downstreamBlocked: 3)
        XCTAssertEqual(ProjectPage.queueRowState(row), "Prerequisites complete")
        XCTAssertEqual(ProjectPage.queueImpact(row), "Unblocks 3 tasks")
        XCTAssertEqual(ProjectPage.queueImpact(.init(taskId: "t", title: "T", downstreamBlocked: 1)), "Unblocks 1 task")
        XCTAssertEqual(ProjectPage.queueImpact(.init(taskId: "t", title: "T", downstreamBlocked: nil)), "Ready now")
        let list = ProjectReadyToRun.PausedList(id: "l", title: "Backlog", readyCount: 3, autoRunReadyCount: 1)
        let paused = ProjectReadyToRun.Item(taskId: "t", title: "T", runState: .paused, pausedList: list,
                                            downstreamBlocked: nil)
        XCTAssertEqual(ProjectPage.queueRowState(paused), "List paused · Backlog")
        XCTAssertEqual(ProjectPage.queueImpact(paused), "Ready after resume")
        XCTAssertEqual(ProjectPage.resumeListQuestion(list), "Resume “Backlog”?")
        XCTAssertEqual(ProjectPage.resumeListDetail(paused),
                       "This removes the pause from the entire list. 3 otherwise-ready tasks will become eligible. 1 is configured to auto-run and may start immediately. Other automatic or scheduled work in the list can also dispatch once resumed.")
        XCTAssertEqual(ProjectPage.queueRowState(.init(taskId: "t", title: "T", runState: .queued)), "Waiting for runner")
    }

    // MARK: criteria

    func testTheCriteriaCardFramesTheListAndSaysWhatItHides() {
        XCTAssertEqual(ProjectPage.criteriaStanding(count: 12),
                       "12 criteria stated. Whether one is met is read off the work filed under it; nothing in Orbit judges the criteria themselves.")
        XCTAssertTrue(ProjectPage.criteriaStanding(count: 1).hasPrefix("1 criterion stated."))
        let collapsed = ProjectPage.criteriaDisclosure(total: 12, limit: 4, expanded: false, compact: true)
        XCTAssertEqual(collapsed?.press, "View all 12 criteria")
        XCTAssertEqual(collapsed?.meta, "8 more not shown")
        let expanded = ProjectPage.criteriaDisclosure(total: 12, limit: 4, expanded: true, compact: true)
        XCTAssertEqual(expanded?.press, "Show first 4 criteria")
        XCTAssertEqual(expanded?.meta, "Showing all 12 criteria")
        XCTAssertEqual(ProjectPage.criteriaDisclosure(total: 13, limit: 12, expanded: false, compact: false)?.press,
                       "Show all 13 criteria")
        XCTAssertNil(ProjectPage.criteriaDisclosure(total: 4, limit: 4, expanded: false, compact: true))
    }

    // MARK: tasks

    func testARowDropsTheLaneTagItsBandAlreadySays() {
        let ready = ProjectTaskRow(id: "a", title: "A", status: "OPEN", workState: "READY")
        XCTAssertEqual(ProjectPage.rowTags(ready, heading: "Ready · can start now", ref: nil, upstreamRef: nil), [])
        let auto = ProjectTaskRow(id: "b", title: "B", status: "OPEN", workState: "READY", autoRunWhenReady: true)
        XCTAssertEqual(ProjectPage.rowTags(auto, heading: "Ready · can start now", ref: nil, upstreamRef: nil).map(\.text),
                       ["Ready · automatic dispatch"])
        let failed = ProjectTaskRow(id: "c", title: "C", status: "FAILED", workState: "FAILED")
        XCTAssertEqual(ProjectPage.rowTags(failed, heading: "Failed · coordinated continuation", ref: nil,
                                           upstreamRef: nil), [])
        let landed = ProjectTaskRow(id: "d", title: "D", status: "DONE", workState: "DONE",
                                    integration: ProjectTaskIntegration(state: "ON_UPSTREAM"))
        XCTAssertEqual(ProjectPage.rowTags(landed, heading: "Landed", ref: nil, upstreamRef: "main").map(\.text),
                       ["On main"])
    }
}
