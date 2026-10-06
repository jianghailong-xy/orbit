import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

/// One project's page, card by card: the same cells, sentences, pills, bands and tags the web's
/// project page draws for the same reads.
final class ProjectPageTests: XCTestCase {

    private static let now = RelativeTime.parse("2026-09-24T12:00:00.000Z")!

    private func iso(_ secondsBeforeNow: TimeInterval) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: Self.now.addingTimeInterval(-secondsBeforeNow))
    }

    // MARK: Work overview

    func testOverviewWithoutIntegrationDrawsTheSevenLanesAndDoneCarriesItsShare() {
        let cells = ProjectPage.overviewCells(
            ProjectPanoramaBuckets(running: 4, ready: 1, blocked: 2, done: 27), taskCount: 34, line: nil)
        XCTAssertEqual(cells.map(\.label),
                       ["Running", "Ready", "Waiting", "Awaiting verification", "Done", "Failed", "Cancelled"])
        XCTAssertEqual(cells.first { $0.key == "done" }?.footnote, "79% complete")
        XCTAssertEqual(ProjectPage.overviewCells(ProjectPanoramaBuckets(), taskCount: 0, line: nil)
                        .first { $0.key == "done" }?.footnote, "no tasks yet")
    }

    func testOverviewWithIntegrationSplitsDoneAndShowsOnlyNonZeroExtras() {
        let b = ProjectPanoramaBuckets(running: 4, ready: 0, blocked: 2, done: 28, failed: 1,
                                       integrating: 1, onIntegrationLine: 4, onUpstream: 23,
                                       doneNotIntegrated: 0, waitingForLanding: 1)
        let branch = ProjectPage.overviewCells(b, taskCount: 35, line: .projectBranch)
        XCTAssertEqual(branch.map(\.label),
                       ["Running", "Ready", "Waiting", "Pending landing", "On project branch", "On main", "Failed"])
        XCTAssertEqual(branch.first { $0.key == "blocked" }?.footnote, "1 waiting for a prerequisite to land")
        XCTAssertEqual(branch.first { $0.key == "integrating" }?.footnote, "no landing receipt yet")
        // A project landing straight into main has no branch to strand work on.
        XCTAssertFalse(ProjectPage.overviewCells(b, taskCount: 35, line: .main)
                        .contains { $0.key == "onIntegrationLine" })
    }

    func testOverviewSubtitleCountsTasksAndDependencies() {
        XCTAssertEqual(ProjectPage.overviewSubtitle(.init(taskCount: 34, edgeCount: 18)), "34 tasks · 18 dependencies")
        XCTAssertEqual(ProjectPage.overviewSubtitle(.init(taskCount: 1, edgeCount: 1)), "1 task · 1 dependency")
    }

    // MARK: Acceptance criteria

    func testCriterionWorkSaysWhereMetWorkIsAndNothingForAnUnansweredOne() {
        let onMain = ProjectCriterion(id: "c1", ordinal: 1, text: "A", satisfied: true, landing: "LANDED")
        let onBranch = ProjectCriterion(id: "c2", ordinal: 2, text: "B", satisfied: true,
                                        landing: "ON_INTEGRATION_LINE")
        let noReceipt = ProjectCriterion(id: "c3", ordinal: 3, text: "C", satisfied: true, landing: "UNKNOWN")
        let unanswered = ProjectCriterion(id: "c4", ordinal: 4, text: "D")

        XCTAssertEqual(ProjectPage.criterionWork(onMain, integrationRef: "project/x")?.state, "Met by its work")
        XCTAssertEqual(ProjectPage.criterionWork(onMain, integrationRef: "project/x")?.landing, "on main")
        let branch = ProjectPage.criterionWork(onBranch, integrationRef: "project/x")
        XCTAssertEqual(branch?.landing, "on project/x")
        XCTAssertEqual(branch?.landingWarning, "not on main yet")
        let flagged = ProjectPage.criterionWork(noReceipt, integrationRef: nil)
        XCTAssertEqual(flagged?.landing, "no merge receipt either way")
        XCTAssertEqual(flagged?.landingFlagged, true)
        XCTAssertNil(ProjectPage.criterionWork(unanswered, integrationRef: nil))
        XCTAssertEqual(ProjectPage.criterionMark(unanswered), .unanswered)
        XCTAssertEqual(ProjectPage.criterionMark(onMain), .met)
    }

    func testUnmetWorkNamesEveryReasonAndTheTasksHoldingItInWords() {
        let c = ProjectCriterion(id: "c", ordinal: 1, text: "X", satisfied: false, unmet: [
            ProjectCriterionUnmet(clause: "SERVING_WORK_UNSETTLED", heldUpBy: [
                ProjectCriterionHeldUpBy(taskId: "t1", title: "Wire it", requiredAction: "RUN_ACCEPTANCE_COMMAND"),
                ProjectCriterionHeldUpBy(taskId: "t2", title: "Odd", requiredAction: "SOMETHING_NEW"),
            ]),
            ProjectCriterionUnmet(clause: "NEW_CLAUSE"),
        ], landing: "UNKNOWN")
        let work = try! XCTUnwrap(ProjectPage.criterionWork(c, integrationRef: nil))
        XCTAssertEqual(work.state, "Not met by its work")
        // Landing is not said beside work that has not met its criterion.
        XCTAssertNil(work.landing)
        XCTAssertEqual(work.reasons.map(\.sentence),
                       ["Work filed under it has not settled by the criterion that work declared.", "NEW_CLAUSE"])
        XCTAssertEqual(work.reasons.first?.heldUpBy.map(\.action),
                       ["needs its acceptance command to run", "SOMETHING_NEW"])
    }

    // MARK: Coordinator

    private func status(_ state: ProjectCoordinationState,
                        session: ProjectCoordinatorStatus.Session? = nil) -> ProjectCoordinatorStatus {
        ProjectCoordinatorStatus(projectId: "p", readAt: iso(0), state: state,
                                 coordination: .init(sessionId: session?.id, session: session))
    }

    func testCoordinatorPillFollowsTheWebsTruthTable() {
        let live = { (run: SessionRunState, active: Bool, pending: Int) in
            ProjectPage.coordinatorPill(self.status(.live, session: .init(
                id: "s", runState: run, lifecycleState: .open, engineTurnActive: active,
                pendingApprovals: pending))).label
        }
        XCTAssertEqual(live(.running, false, 1), "Needs you")      // a pending card blocks inside the turn
        XCTAssertEqual(live(.running, false, 0), "Working")
        XCTAssertEqual(live(.awaitingInput, true, 0), "Working")
        XCTAssertEqual(live(.awaitingInput, false, 0), "Needs you")
        XCTAssertEqual(live(.failed, false, 0), "Idle")
        XCTAssertEqual(ProjectPage.coordinatorPill(status(.live, session: .init(
            id: "s", runState: .awaitingInput, lifecycleState: .completed))).label, "Completed")
        XCTAssertEqual(ProjectPage.coordinatorPill(status(.neverOpened)).label, "Not started")
        XCTAssertEqual(ProjectPage.coordinatorPill(status(.trashed)).label, "Deleted")
        XCTAssertEqual(ProjectPage.coordinatorPill(status(.unavailable)), .init(label: "Cannot be opened", tone: .error))
    }

    func testCoordinatorRowsReadTheWayTheWebCardDoes() {
        XCTAssertEqual(ProjectPage.coordinatorOrdinal("0"), "1st coordinator of this project")
        XCTAssertEqual(ProjectPage.coordinatorOrdinal("1"), "2nd coordinator of this project")
        XCTAssertEqual(ProjectPage.coordinatorOrdinal("10"), "11th coordinator of this project")
        XCTAssertEqual(ProjectPage.coordinatorOrdinal("21"), "22nd coordinator of this project")
        XCTAssertEqual(ProjectPage.wakeupsLine(.init(state: "DELIVERED", at: iso(240)), now: Self.now),
                       "delivered · last 4m ago")
        XCTAssertEqual(ProjectPage.wakeupsLine(.init(state: "NONE"), now: Self.now), "none yet")
        XCTAssertEqual(ProjectPage.selfStartedLine(.init(selfStartedToday: 6, limit: 30)), "6 of 30")
        XCTAssertEqual(ProjectPage.selfStartedLine(.init(selfStartedToday: 6)), "6 · no limit")
        XCTAssertEqual(ProjectPage.selfStartedLine(.init(selfStartedToday: 30, limit: 30, paused: true)),
                       "30 of 30 · paused")
        XCTAssertEqual(ProjectPage.selfStartedFraction(.init(selfStartedToday: 31, limit: 30)), 1)
        XCTAssertNil(ProjectPage.selfStartedFraction(.init(selfStartedToday: 3)))
        XCTAssertEqual(ProjectPage.lastActive(.init(id: "s", startedAt: iso(3_600), finishedAt: iso(720)),
                                              readAt: iso(0)), "last active 12m ago")
        // Started a month ago, talked twelve minutes ago: the newest turn is what it was last active at.
        XCTAssertEqual(ProjectPage.lastActive(.init(id: "s", startedAt: iso(2_592_000), lastTurnAt: iso(720)),
                                              readAt: iso(0)), "last active 12m ago")
    }

    // MARK: Open items

    private func item(_ kind: ProjectOpenItemKind, assignee: ProjectOpenItemAssignee,
                      waited: TimeInterval, escalateIn: TimeInterval? = nil,
                      actions: [ProjectOpenItemAction] = [], sessionId: String? = nil,
                      fuse: String? = nil) -> ProjectOpenItemRow {
        ProjectOpenItemRow(itemId: "i", kind: kind, title: "T", waitingSince: iso(waited),
                           assignee: assignee,
                           escalateAt: escalateIn.map { iso(-$0) },
                           sessionId: sessionId, fuseEpisodeId: fuse, actions: actions)
    }

    func testOpenItemsSummaryKeepsCoordinatorItemsQuietUntilTheServerReassignsThem() throws {
        let coordinator = item(.integrationCheckFailed, assignee: .coordinator, waited: 3_600,
                               escalateIn: -60)
        let quiet = try XCTUnwrap(ProjectPage.openItemsSummary(
            status: .open, started: true, items: .init(withCoordinator: [coordinator])))
        XCTAssertEqual(quiet.count, 1)
        XCTAssertEqual(quiet.needsYou, 0)
        XCTAssertNil(quiet.attention, "a local countdown reaching zero does not reassign an item")
        XCTAssertEqual(quiet.subtitle, "No action needed from you · 1 with the coordinator")

        let owner = item(.integrationCheckFailed, assignee: .owner, waited: 3_600)
        let escalated = try XCTUnwrap(ProjectPage.openItemsSummary(
            status: .open, started: true, items: .init(needsYou: [owner])))
        XCTAssertEqual(escalated.count, 1)
        XCTAssertEqual(escalated.attention, "1 item needs you")
        XCTAssertEqual(escalated.subtitle, "1 item needs you")

        let pause = item(.fusePaused, assignee: .owner, waited: 60, actions: [.resume], fuse: "f1")
        let mixed = try XCTUnwrap(ProjectPage.openItemsSummary(
            status: .open, started: true,
            items: .init(needsYou: [owner, pause], withCoordinator: [coordinator])))
        XCTAssertEqual(mixed.count, 3)
        XCTAssertEqual(mixed.attention, "2 items need you", "the existing Resume action remains discoverable")
        XCTAssertEqual(mixed.subtitle, "2 items need you · 1 with the coordinator")
    }

    /// The coordinator's request to record the project done is one of the owner's items while the
    /// project is OPEN — the page's count and its reminder say so — and the owner's own Record as
    /// done… is not, any more than their own Start… is. A server that also listed the request among
    /// the owner's rows would not have it counted twice (the browser filters it the same way).
    func testOpenItemsSummaryCountsTheRequestToRecordTheProjectDone() throws {
        let request = ProjectOpenItemRow(itemId: "d", kind: .unknown, title: ProjectDone.heading,
                                         waitingSince: iso(240),
                                         doneRequest: DoneRequest(criteriaDigest: "c", judgment: "j"))
        let asked = try XCTUnwrap(ProjectPage.openItemsSummary(
            status: .open, started: true, items: .init(doneRequest: request)))
        XCTAssertEqual(asked.needsYou, 1)
        XCTAssertEqual(asked.attention, "1 item needs you")
        let twice = try XCTUnwrap(ProjectPage.openItemsSummary(
            status: .open, started: true, items: .init(needsYou: [request], doneRequest: request)))
        XCTAssertEqual(twice.needsYou, 1, "the request has its own row and is counted once")
        XCTAssertEqual(ProjectPage.needsYouRows(.init(needsYou: [request])), [])
        let unasked = try XCTUnwrap(ProjectPage.openItemsSummary(status: .open, started: true, items: .init()))
        XCTAssertEqual(unasked.needsYou, 0, "the owner's own Record as done… is waiting on nobody")
        let done = try XCTUnwrap(ProjectPage.openItemsSummary(
            status: .done, started: true, items: .init(doneRequest: request)))
        XCTAssertEqual(done.needsYou, 0, "a project already done is asked nothing")
    }

    func testOpenItemsSummaryDoesNotTurnAnUnreadInboxIntoAnEmptyOne() throws {
        XCTAssertNil(ProjectPage.openItemsSummary(status: .open, started: true, items: nil))
        let empty = try XCTUnwrap(ProjectPage.openItemsSummary(
            status: .open, started: true, items: .init()))
        XCTAssertEqual(empty.count, 0)
        XCTAssertNil(empty.attention)
        XCTAssertEqual(empty.subtitle, "No open items")
    }

    func testWaitingLabelCountsDownToTheOwner() {
        XCTAssertEqual(ProjectPage.waitingLabel(item(.integrationConflict, assignee: .coordinator,
                                                     waited: 18 * 60, escalateIn: 102 * 60), now: Self.now),
                       "18m · goes to you in 1h 42m")
        XCTAssertEqual(ProjectPage.waitingLabel(item(.integrationConflict, assignee: .coordinator,
                                                     waited: 3 * 3_600, escalateIn: -60), now: Self.now),
                       "3h · due to come to you")
        XCTAssertEqual(ProjectPage.waitingLabel(item(.coordinatorQuestion, assignee: .owner,
                                                     waited: 35 * 60), now: Self.now),
                       "waiting 35m")
    }

    func testPrimaryActionIsTheFirstThisClientCanCarryOut() {
        XCTAssertEqual(ProjectPage.primaryAction(item(.taskFailed, assignee: .owner, waited: 60,
                                                      actions: [.retry, .openTaskSession, .cancelTask],
                                                      sessionId: "s1")), .openTaskSession)
        XCTAssertNil(ProjectPage.primaryAction(item(.taskFailed, assignee: .owner, waited: 60,
                                                    actions: [.retry, .openTaskSession])))
        XCTAssertEqual(ProjectPage.primaryAction(item(.coordinatorQuestion, assignee: .owner, waited: 60,
                                                      actions: [.answer])), .answer)
        XCTAssertNil(ProjectPage.primaryAction(item(.fusePaused, assignee: .owner, waited: 60,
                                                    actions: [.resume])))
        XCTAssertEqual(ProjectPage.primaryAction(item(.fusePaused, assignee: .owner, waited: 60,
                                                      actions: [.resume], fuse: "f1")), .resume)
        XCTAssertEqual(ProjectPage.actionLabel(.review), "Review")
        XCTAssertNil(ProjectPage.actionLabel(.cancelTask))
    }

    func testOwnerItemKindFoldsEveryExceptionIntoEscalated() {
        XCTAssertEqual(ProjectPage.ownerItemKind(item(.promotionApproval, assignee: .owner, waited: 1)), .promotionApproval)
        XCTAssertEqual(ProjectPage.ownerItemKind(item(.coordinatorQuestion, assignee: .owner, waited: 1)), .coordinatorQuestion)
        XCTAssertEqual(ProjectPage.ownerItemKind(item(.fusePaused, assignee: .owner, waited: 1)), .fusePaused)
        for kind in [ProjectOpenItemKind.integrationConflict, .integrationCheckFailed, .integrationError, .taskFailed] {
            XCTAssertEqual(ProjectPage.ownerItemKind(item(kind, assignee: .owner, waited: 1)), .escalated)
        }
    }

    // MARK: Integration line

    func testIntegrationFactsOnABranchAndOnMain() {
        let branch = ProjectIntegrationView(line: .projectBranch, ref: "project/bg-jobs", upstreamRef: "main",
                                            commitsAheadOfUpstream: 7, lastUpstreamSyncAt: iso(720),
                                            integratingCount: 1, queuedCount: 1, mergeCheckOnTip: "PASSING")
        XCTAssertEqual(ProjectPage.integrationFacts(branch, now: Self.now), [
            "project/bg-jobs", "7 commits ahead of main at last measurement", "synced with main 12m ago",
            "Running jobs 1 · Queued 1", "Last landing check ✓ passing",
        ])
        let main = ProjectIntegrationView(line: .main, upstreamRef: "main", commitsAheadOfUpstream: 3,
                                          mergeCheckOnTip: "UNKNOWN")
        XCTAssertEqual(ProjectPage.integrationFacts(main, now: Self.now),
                       ["main", "Running jobs 0 · Queued 0", "Last landing check not checked"])
        XCTAssertNil(ProjectPage.integrationFacts(ProjectIntegrationView(), now: Self.now))
    }

    // MARK: The landing in flight

    /// The row the owner approved: `◌ Landing <task> · checking · 1m 20s`.
    func testTheLandingLineNamesTheTaskAndCountsSecondsWhileTheChecksRun() {
        let view = ProjectIntegrationView(
            integratingCount: 1, queuedCount: 0,
            inFlight: .init(taskTitle: "T2 wiki 契约、迁移与共享类型", state: "RUNNING",
                            startedAt: iso(80), kind: "LAND_TASK", phase: "CHECK"))
        XCTAssertEqual(ProjectPage.landingLine(view, now: Self.now), ProjectPage.LandingLine(
            what: "T2 wiki 契约、迁移与共享类型", running: true, state: "checking", clock: "1m 20s", word: "Landing"))
    }

    func testTheLandingLineIsQueuedAndStillWhileTheJobWaitsItsTurn() {
        let view = ProjectIntegrationView(
            integratingCount: 0, queuedCount: 1,
            inFlight: .init(taskTitle: "T1", state: "QUEUED", startedAt: iso(40)))
        XCTAssertEqual(ProjectPage.landingLine(view, now: Self.now), ProjectPage.LandingLine(
            what: "T1", running: false, state: "queued", clock: "0m 40s", clockLabel: "Queued for"))
    }

    /// The oldest job's state and clock, but the COUNT in the name slot: a title would have said
    /// "this is the only thing happening", which is the one thing the line must not say.
    func testTheLandingLineNamesTheCountWhenSeveralAreInFlight() {
        let view = ProjectIntegrationView(
            integratingCount: 2, queuedCount: 1,
            inFlight: .init(taskTitle: "T1", state: "RUNNING", startedAt: iso(80)))
        XCTAssertEqual(ProjectPage.landingLine(view, now: Self.now)?.what, "3 jobs")
    }

    func testLandingRefreshFailureFreezesTheClockAndStopsClaimingActivity() {
        let view = ProjectIntegrationView(integratingCount: 1, inFlight: .init(
            state: "RUNNING", startedAt: iso(80), kind: "LAND_TASK", phase: "CHECK"))
        let later = Self.now.addingTimeInterval(60)
        let line = ProjectPage.landingLine(view, now: later, updatedAt: Self.now, refreshFailed: true)
        XCTAssertEqual(line?.state, "Update unavailable")
        XCTAssertEqual(line?.running, false)
        XCTAssertEqual(line?.clock, "1m 20s")
        XCTAssertEqual(line?.updated, "Updated 1m ago")
        XCTAssertEqual(ProjectPage.landingLine(view, now: Self.now.addingTimeInterval(91),
                                              updatedAt: Self.now)?.running, false)
        XCTAssertEqual(ProjectPage.landingLine(view, now: later, updatedAt: later)?.running, true)
    }

    func testLandingHeartbeatCanBeStaleEvenWhenTheAPIReadSucceeds() {
        let view = ProjectIntegrationView(integratingCount: 1, inFlight: .init(
            state: "RUNNING", startedAt: iso(720), kind: "LAND_TASK", phase: "CHECK", heartbeatAt: iso(660)))
        let line = ProjectPage.landingLine(view, now: Self.now, updatedAt: Self.now)
        XCTAssertEqual(line?.running, false)
        XCTAssertEqual(line?.state, "Update unavailable")
        XCTAssertEqual(line?.clock, "1m 0s")
        XCTAssertEqual(line?.updated, "Updated 11m ago")
    }

    func testManualAndPausedReadyWorkUseTheirActualStartConditions() {
        let buckets = ProjectPanoramaBuckets(ready: 1)
        XCTAssertEqual(ProjectPage.overviewCells(buckets, taskCount: 1, line: nil, manualReadyCount: 1)
            .first { $0.key == "ready" }?.footnote, "can start manually")
        XCTAssertEqual(ProjectPage.overviewCells(buckets, taskCount: 1, line: nil, paused: true, manualReadyCount: 1)
            .first { $0.key == "ready" }?.footnote, "project is paused")
    }

    /// Nothing in flight is the row's absence, and so is a project whose server never described a
    /// job — an older apiserver, or one that has nothing to describe.
    func testTheLandingLineIsAbsentWhenNothingIsLanding() {
        XCTAssertNil(ProjectPage.landingLine(
            ProjectIntegrationView(integratingCount: 0, queuedCount: 0, inFlight: nil), now: Self.now))
        XCTAssertNil(ProjectPage.landingLine(ProjectIntegrationView(), now: Self.now))
    }

    /// A job that names no task — a promotion of the project's own branch, a merge check — keeps
    /// the row's word and state; an instant the clock cannot read counts from zero rather than
    /// printing a number nobody sent.
    func testTheLandingLineKeepsItsWordsForAJobWithNoTaskAndNoReadableClock() {
        let view = ProjectIntegrationView(
            integratingCount: 1, queuedCount: 0,
            inFlight: .init(taskTitle: nil, state: "RUNNING", startedAt: "not a date"))
        XCTAssertEqual(ProjectPage.landingLine(view, now: Self.now), ProjectPage.LandingLine(
            what: nil, running: true, state: "running", clock: "0m 0s"))
    }

    func testMergeJobsDescribeTheirKindAndActualPhase() {
        for (kind, word) in ProjectPage.integrationJobWords {
            for (phase, state) in ProjectPage.integrationPhaseWords {
                let view = ProjectIntegrationView(inFlight: .init(
                    state: "RUNNING", startedAt: iso(80), kind: kind, phase: phase))
                XCTAssertEqual(ProjectPage.landingLine(view, now: Self.now)?.word, word)
                XCTAssertEqual(ProjectPage.landingLine(view, now: Self.now)?.state, state)
            }
        }
        let queued = ProjectIntegrationView(inFlight: .init(
            state: "QUEUED", startedAt: iso(80), kind: "LAND_PROMOTION", phase: "CHECK"))
        XCTAssertEqual(ProjectPage.landingLine(queued, now: Self.now)?.word, "Merge to main")
        XCTAssertEqual(ProjectPage.landingLine(queued, now: Self.now)?.state, "queued")
        XCTAssertFalse(ProjectPage.landingLine(queued, now: Self.now)!.running)
    }

    /// Minutes AND seconds, at every length: this is not `RelativeTime.span`, which rounds to the
    /// largest unit it needs and would show "2m" twice a minute apart.
    func testTheLandingClockNeverRoundsAwayTheSeconds() {
        XCTAssertEqual(ProjectPage.landingClock(80), "1m 20s")
        XCTAssertEqual(ProjectPage.landingClock(40), "0m 40s")
        XCTAssertEqual(ProjectPage.landingClock(0), "0m 0s")
        XCTAssertEqual(ProjectPage.landingClock(59), "0m 59s")
        XCTAssertEqual(ProjectPage.landingClock(3_600), "60m 0s")
        // A clock a little behind the server (skew) counts from zero, never backwards.
        XCTAssertEqual(ProjectPage.landingClock(-5), "0m 0s")
        XCTAssertEqual(RelativeTime.span(80), "1m")   // what this deliberately is not
    }

    // MARK: Tasks

    func testUnfinishedWorkKeepsItsWorkLaneDespiteAnEarlierLanding() {
        for (state, key) in [("READY", "ready"), ("FAILED", "failed"), ("CANCELLED", "settled"),
                             ("AWAITING_VERIFICATION", "awaiting-verification")] {
            for integration in ["QUEUED", "CHECK_FAILED", "ON_UPSTREAM"] {
                let row = ProjectTaskRow(id: "reopened", title: "Work", workState: state,
                                          integration: .init(state: integration))
                XCTAssertEqual(ProjectPage.taskGroups([row]).map(\.key), [key])
            }
        }
    }

    func testTaskBandsFollowTheWebsOrder() {
        let rows = [
            ProjectTaskRow(id: "done", title: "d", status: "DONE", workState: "DONE"),
            ProjectTaskRow(id: "lvl2", title: "b2", topoLevel: 2, dependencyState: "BLOCKED", workState: "BLOCKED"),
            ProjectTaskRow(id: "ready", title: "r", workState: "READY"),
            ProjectTaskRow(id: "run", title: "x", status: "IN_PROGRESS", workState: "RUNNING"),
            ProjectTaskRow(id: "landing", title: "l", dependencyState: "BLOCKED", workState: "BLOCKED",
                           landingWaitCount: 1),
            ProjectTaskRow(id: "integ", title: "i", status: "DONE", workState: "DONE",
                           integration: .init(state: "CHECK_FAILED", handler: "COORDINATOR")),
            ProjectTaskRow(id: "landed", title: "o", status: "DONE", workState: "DONE",
                           integration: .init(state: "ON_UPSTREAM")),
            ProjectTaskRow(id: "lvl1", title: "b1", topoLevel: 1, dependencyState: "BLOCKED", workState: "BLOCKED"),
        ]
        let groups = ProjectPage.taskGroups(rows)
        XCTAssertEqual(groups.map(\.key), ["running", "integrating", "ready", "waiting-for-landing",
                                           "level-1", "level-2", "landed", "settled"])
        XCTAssertEqual(groups.map(\.heading), [
            "Running", "Pending landing", "Ready · can start now",
            "Waiting · for a prerequisite to land", "Blocked · topology level 1", "Blocked · topology level 2",
            "Landed", "Done / Cancelled",
        ])
        XCTAssertEqual(groups.last?.settled, true)
    }

    func testAnOlderServersOpenRowIsNeverPromotedToReady() {
        XCTAssertEqual(ProjectPage.workState(ProjectTaskRow(id: "t", title: "t", status: "OPEN")), "BLOCKED")
        XCTAssertEqual(ProjectPage.workState(ProjectTaskRow(id: "t", title: "t", status: "OPEN",
                                                            completionPolicy: "VERIFICATION_PASSED")),
                       "AWAITING_VERIFICATION")
    }

    func testTaskTagsNameTheLaneAndWhoHasAFailure() {
        XCTAssertEqual(ProjectPage.workTag(ProjectTaskRow(id: "t", title: "t", workState: "READY",
                                                          autoRunWhenReady: true))?.text,
                       "Ready · automatic dispatch")
        XCTAssertNil(ProjectPage.workTag(ProjectTaskRow(id: "t", title: "t", dependencyState: "BLOCKED",
                                                        workState: "BLOCKED", landingWaitCount: 2)))
        let tag = { (state: String, handler: String?) in
            ProjectPage.integrationTag(ProjectTaskRow(id: "t", title: "t",
                                                      integration: .init(state: state, handler: handler)),
                                       ref: "project/x", upstreamRef: "main")?.text
        }
        XCTAssertEqual(tag("CONFLICT", "OWNER"), "Conflict · you")
        XCTAssertEqual(tag("CHECK_FAILED", "COORDINATOR"), "Checks failed · coordinator")
        XCTAssertEqual(tag("ON_INTEGRATION_LINE", nil), "On project/x")
        XCTAssertEqual(tag("ON_UPSTREAM", nil), "On main")
        XCTAssertNil(tag("SOMETHING_NEW", nil))
        XCTAssertEqual(ProjectPage.integrationTag(
            ProjectTaskRow(id: "t", title: "t", integration: .init(state: "RUNNING", checksRunningForMs: 180_000)),
            ref: nil, upstreamRef: nil)?.text, "Integrating · checking")
        XCTAssertEqual(ProjectPage.integrationTag(
            ProjectTaskRow(id: "t", title: "t", dependencyState: "BLOCKED", landingWaitCount: 1),
            ref: nil, upstreamRef: nil)?.text, "Waits for 1 task to land")
    }

    // MARK: decoding

    func testDecodesTheProjectDocumentAndCoordinatorStatusAsServed() throws {
        let doc = try JSONDecoder().decode(ProjectDocument.self, from: Data("""
        {"id":"p1","title":"Landing","status":"OPEN","goal":"G","instructions":null,
         "createdAt":"2026-09-23T00:00:00.000Z","updatedAt":"2026-09-24T00:00:00.000Z",
         "coordinatorEnabled":true,"configRevision":"7","coordinatorSessionId":"s1",
         "maxConcurrentTasks":3,"_count":{"tasks":7},"tasksByStatus":{"OPEN":4,"DONE":3},
         "acceptanceCriteriaItems":[{"id":"c1","ordinal":1,"text":"T","revision":2,"satisfied":false,
           "unmet":[{"clause":"NO_WORK_SERVES_IT","heldUpBy":[]}],"landing":"UNKNOWN",
           "verificationMethod":"read it"}],
         "integration":{"line":"PROJECT_BRANCH","lineAbsentReason":null,"ref":"project/landing",
           "upstreamRef":"main","source":"EXPLICIT","locked":true,"startedAt":null,
           "mergeCheckCommand":"npm test","mergeCheckCommandAbsentReason":null,
           "mergeCheckTimeoutSeconds":null,"escalationSeconds":7200},
         "blockers":{"open":[],"recentlyResolved":[]},"derivedDone":{"done":false}}
        """.utf8))
        XCTAssertEqual(doc.taskCount, 7)
        XCTAssertEqual(doc.configRevision, "7")
        XCTAssertEqual(doc.coordinatorEnabled, true)
        XCTAssertEqual(doc.acceptanceCriteriaItems.first?.unmet.first?.clause, "NO_WORK_SERVES_IT")
        XCTAssertEqual(doc.integration?.ref, "project/landing")
        XCTAssertEqual(doc.integration?.locked, true)

        let status = try JSONDecoder().decode(ProjectCoordinatorStatus.self, from: Data("""
        {"projectId":"p1","readAt":"2026-09-24T12:00:00.000Z","state":"LIVE",
         "coordination":{"sessionId":"s1","sessionIdAbsentReason":null,
           "session":{"id":"s1","title":"Coord","runStatus":"RUNNING","runState":"RUNNING",
             "lifecycleState":"OPEN","filingState":"OPEN","endReason":null,"startedAt":"2026-09-24T11:00:00.000Z",
             "finishedAt":null,"completedAt":null,"deletedAt":null,"engineTurnActive":true,"pendingApprovals":0},
           "sessionAbsentReason":null,"coordinatorGeneration":"1","workspaceId":"w1",
           "workspaceIdAbsentReason":null,"workspaceName":"orbit","agentId":"w1","agentName":"orbit",
           "wakeups":{"state":"DELIVERED","at":"2026-09-24T11:56:00.000Z"},
           "fuse":{"selfStartedToday":6,"limit":30,"paused":false,"episodeId":null}},
         "openability":{"canOpen":true,"willCreate":false,"refusalCode":null,"refusalDetail":null,
           "refusalCodeAbsentReason":"NOTHING_REFUSES","requiredAction":null,
           "landing":{"workspaceId":null,"workspaceName":null}}}
        """.utf8))
        XCTAssertEqual(status.state, .live)
        XCTAssertEqual(status.coordination.session?.runState, .running)
        XCTAssertEqual(status.coordination.coordinatorGeneration, "1")
        XCTAssertEqual(status.coordination.fuse?.limit, 30)
        XCTAssertEqual(ProjectPage.coordinatorPill(status).label, "Working")
    }

    func testDecodesATaskPageAndPanorama() throws {
        let page = try JSONDecoder().decode(ProjectTaskPage.self, from: Data("""
        {"items":[{"id":"t1","title":"A","status":"OPEN","parentTaskId":null,"createdAt":"x","updatedAt":"y",
          "childCount":0,"unmetCount":1,"blocksCount":2,"topoLevel":1,"dependencyState":"BLOCKED",
          "workState":"BLOCKED","integration":{"state":"NOT_APPLICABLE","since":null,"handler":null,
          "openItemId":null,"jobId":null,"checksRunningForMs":null},"landingWaitCount":0}],
         "nextCursor":"c2"}
        """.utf8))
        XCTAssertEqual(page.items.first?.blocksCount, 2)
        XCTAssertEqual(page.items.first?.integration?.state, "NOT_APPLICABLE")
        XCTAssertEqual(page.nextCursor, "c2")

        let panorama = try JSONDecoder().decode(ProjectPanorama.self, from: Data("""
        {"buckets":{"running":1,"ready":2,"blocked":1,"awaitingVerification":0,"done":3,"failed":0,
          "cancelled":0,"integrating":1,"onIntegrationLine":1,"onUpstream":1,"doneNotIntegrated":0,
          "waitingForLanding":0},"shape":{"taskCount":7,"edgeCount":5,"ratio":0.7,"maxDepth":2,"form":"chain"}}
        """.utf8))
        XCTAssertTrue(ProjectPage.reportsIntegrationLanes(panorama.buckets))
        XCTAssertEqual(panorama.shape.edgeCount, 5)
    }
}

// MARK: - the routes

private final class ProjectAPIURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) -> (status: Int, body: String))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let result = Self.handler?(request) ?? (status: 500, body: "")
        let response = HTTPURLResponse(url: request.url!, statusCode: result.status,
                                       httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(result.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class ProjectRequestLog: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []

    func record(_ request: URLRequest) {
        guard let url = request.url else { return }
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.query.map { "?\($0)" } ?? ""
        var body = ""
        if let data = request.httpBody ?? request.httpBodyStream.map(Self.drain) {
            // Key order is the encoder's business, not the contract's: compare bodies sorted.
            if let object = try? JSONSerialization.jsonObject(with: data),
               let sorted = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) {
                body = " " + String(decoding: sorted, as: UTF8.self)
            } else {
                body = " " + String(decoding: data, as: UTF8.self)
            }
        }
        lock.lock()
        lines.append("\(request.httpMethod ?? "?") \(url.path)\(query)\(body)")
        lock.unlock()
    }

    private static func drain(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }

    var all: [String] {
        lock.lock()
        defer { lock.unlock() }
        return lines
    }
}

/// Each project read and write hits the route `projects.controller.ts` serves for it.
final class ProjectAPIClientTests: XCTestCase {
    override func tearDown() {
        ProjectAPIURLProtocol.handler = nil
        super.tearDown()
    }

    func testEveryProjectCallHitsItsRoute() async throws {
        let log = ProjectRequestLog()
        let document = #"{"id":"p1","title":"T","status":"OPEN","createdAt":"x","_count":{"tasks":0}}"#
        ProjectAPIURLProtocol.handler = { request in
            log.record(request)
            let path = request.url?.path ?? ""
            switch (request.httpMethod ?? "", path) {
            case ("GET", "/api/projects"): return (200, "[\(document)]")
            case ("GET", "/api/projects/p1"), ("PATCH", "/api/projects/p1"): return (200, document)
            case ("GET", "/api/projects/p1/panorama"): return (200, #"{"buckets":{},"shape":{}}"#)
            case ("GET", "/api/projects/p1/integration"): return (200, #"{"line":null}"#)
            case ("GET", "/api/projects/p1/tasks/page"): return (200, #"{"items":[],"nextCursor":null}"#)
            case ("GET", "/api/projects/p1/coordinator/status"):
                return (200, #"{"projectId":"p1","state":"NEVER_OPENED","coordination":{},"openability":{"canOpen":true}}"#)
            case ("POST", "/api/projects/p1/coordinator"):
                return (201, #"{"sessionId":"s1","created":true,"workspaceId":"w1"}"#)
            case ("PATCH", "/api/projects/p1/integration"):
                return (200, #"{"line":"MAIN","locked":false,"mergeCheckCommand":null,"escalationSeconds":3600}"#)
            case ("POST", "/api/projects/p1/pause"):
                return (201, #"{"projectId":"p1","startedAt":"s","pausedAt":"p","pausedReason":"OWNER"}"#)
            case ("POST", "/api/projects/p1/resume"):
                return (201, #"{"projectId":"p1","startedAt":"s","pausedAt":null,"pausedReason":null}"#)
            case ("DELETE", "/api/projects/p1"): return (200, "{}")
            default: return (404, "")
            }
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProjectAPIURLProtocol.self]
        let api = APIClient(baseURL: URL(string: "https://orbit.test")!, tokenStore: InMemoryTokenStore(),
                            session: URLSession(configuration: configuration))

        let listed = try await api.projects()
        _ = try await api.projects(status: .open)
        _ = try await api.project("p1")
        _ = try await api.projectPanorama("p1")
        _ = try await api.projectIntegration("p1")
        _ = try await api.projectTaskPage("p1", cursor: "c2", limit: 50)
        let status = try await api.projectCoordinatorStatus("p1")
        let opened = try await api.openProjectCoordinator("p1")
        _ = try await api.updateProjectStatus("p1", to: .done)
        _ = try await api.updateProjectAuthorization(
            "p1", UpdateProjectAuthorizationRequest(automatic: true, expectedConfigRevision: "7"))
        _ = try await api.updateProjectAuthorization(
            "p1", UpdateProjectAuthorizationRequest(maxConcurrentTasks: 4, expectedConfigRevision: "8"))
        let line = try await api.updateProjectIntegration(
            "p1", UpdateProjectIntegrationRequest(line: .main, mergeCheckCommand: .some(nil),
                                                  exceptionEscalationSeconds: 3600))
        let paused = try await api.pauseProject("p1")
        let resumed = try await api.resumeProject("p1")
        try await api.deleteProject("p1")

        XCTAssertEqual(listed.map(\.id), ["p1"])
        XCTAssertEqual(status.state, .neverOpened)
        XCTAssertEqual(opened, ProjectCoordinatorOpened(sessionId: "s1", created: true, workspaceId: "w1"))
        XCTAssertEqual(line.line, .main)
        XCTAssertEqual(line.escalationSeconds, 3600)
        XCTAssertEqual(paused.pausedAt, "p")
        XCTAssertNil(resumed.pausedAt)
        XCTAssertEqual(log.all, [
            "GET /api/projects",
            "GET /api/projects?status=OPEN",
            "GET /api/projects/p1",
            "GET /api/projects/p1/panorama",
            "GET /api/projects/p1/integration",
            "GET /api/projects/p1/tasks/page?limit=50&cursor=c2",
            "GET /api/projects/p1/coordinator/status",
            "POST /api/projects/p1/coordinator",
            #"PATCH /api/projects/p1 {"status":"DONE"}"#,
            // `automatic`, never `coordinatorEnabled`, whose off the server also reads as a pause.
            #"PATCH /api/projects/p1 {"automatic":true,"expectedConfigRevision":"7"}"#,
            #"PATCH /api/projects/p1 {"expectedConfigRevision":"8","maxConcurrentTasks":4}"#,
            #"PATCH /api/projects/p1/integration {"exceptionEscalationSeconds":3600,"line":"MAIN","mergeCheckCommand":null}"#,
            "POST /api/projects/p1/pause",
            "POST /api/projects/p1/resume",
            "DELETE /api/projects/p1",
        ])
    }
}
