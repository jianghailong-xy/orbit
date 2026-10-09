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

    /// The row the owner approved: `◌ Landing <task> · checking · 1m 20s`, with the runner's own
    /// last report under it — a claimed job reports, and the row says how long ago it did.
    func testTheLandingLineNamesTheTaskAndCountsSecondsWhileTheChecksRun() {
        let view = ProjectIntegrationView(
            integratingCount: 1, queuedCount: 0,
            inFlight: .init(taskTitle: "T2 wiki 契约、迁移与共享类型", state: "RUNNING",
                            startedAt: iso(80), kind: "LAND_TASK", phase: "CHECK", heartbeatAt: iso(0)))
        XCTAssertEqual(ProjectPage.landingLine(view, now: Self.now, updatedAt: Self.now), ProjectPage.LandingLine(
            what: "T2 wiki 契约、迁移与共享类型", running: true, state: "checking", clock: "1m 20s",
            word: "Landing", updated: "Updated just now"))
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
            inFlight: .init(taskTitle: "T1", state: "RUNNING", startedAt: iso(80), heartbeatAt: iso(0)))
        XCTAssertEqual(ProjectPage.landingLine(view, now: Self.now)?.what, "3 jobs")
    }

    func testLandingRefreshFailureFreezesTheClockAndStopsClaimingActivity() {
        let view = ProjectIntegrationView(integratingCount: 1, inFlight: .init(
            state: "RUNNING", startedAt: iso(80), kind: "LAND_TASK", phase: "CHECK", heartbeatAt: iso(0)))
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

    /// A runner that has gone quiet is a fact about the REPORTS, and the row says exactly that.
    /// It used to say "Update unavailable", which read as "the app cannot see the server" and, to a
    /// reader watching a landing sit still, as "this timed out" — neither of which is what happened.
    func testLandingHeartbeatCanBeStaleEvenWhenTheAPIReadSucceeds() {
        let view = ProjectIntegrationView(integratingCount: 1, inFlight: .init(
            state: "RUNNING", startedAt: iso(720), kind: "LAND_TASK", phase: "CHECK", heartbeatAt: iso(660)))
        let line = ProjectPage.landingLine(view, now: Self.now, updatedAt: Self.now)
        XCTAssertEqual(line?.running, false)
        XCTAssertEqual(line?.state, ProjectPage.landingNoReport)
        XCTAssertEqual(line?.clock, "1m 0s")
        XCTAssertEqual(line?.updated, "No report for 11m")
        // Never a timeout: a timeout is the job's own verdict, and the server words it in the
        // landing's `blockingReason` (`LandTaskStatus`), which is the only place it appears.
        XCTAssertFalse("\(line?.state ?? "") \(line?.updated ?? "")".lowercased().contains("timed out"))
        // A claim whose runner has not reported once says that instead of counting a silence it
        // cannot measure.
        let silentFromTheStart = ProjectIntegrationView(integratingCount: 1, inFlight: .init(
            state: "RUNNING", startedAt: iso(240), kind: "LAND_TASK", phase: "FETCH"))
        XCTAssertEqual(ProjectPage.landingLine(silentFromTheStart, now: Self.now, updatedAt: Self.now)?.updated,
                       ProjectPage.landingNoReportYet)
    }

    /// The other half of "how long is this taking": a job claimed 2m 24s after it was queued, and
    /// 4m 41s into its work, is a different story from one that has been working for 7m 5s.
    func testTheLandingLineSaysWhatTheJobWaitedBeforeItWasClaimed() {
        let view = ProjectIntegrationView(integratingCount: 1, inFlight: .init(
            taskTitle: "C5", state: "RUNNING", startedAt: iso(281), kind: "LAND_TASK", phase: "FETCH",
            heartbeatAt: iso(5), waitMs: 143_637))
        let line = ProjectPage.landingLine(view, now: Self.now, updatedAt: Self.now)
        XCTAssertEqual(line?.clock, "4m 41s")
        XCTAssertEqual(line?.wait, "2m 23s")
        // A queued job's whole clock IS its wait, which `Queued for` already says.
        let queued = ProjectIntegrationView(integratingCount: 0, queuedCount: 1, inFlight: .init(
            taskTitle: "C5", state: "QUEUED", startedAt: iso(126), kind: "LAND_TASK", waitMs: 126_000))
        XCTAssertEqual(ProjectPage.landingLine(queued, now: Self.now)?.clockLabel, "Queued for")
        XCTAssertNil(ProjectPage.landingLine(queued, now: Self.now)?.wait)
        // And a job that never waited says nothing about waiting.
        XCTAssertNil(ProjectPage.landingLine(ProjectIntegrationView(integratingCount: 1, inFlight: .init(
            state: "RUNNING", startedAt: iso(80), heartbeatAt: iso(0))), now: Self.now)?.wait)
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
            inFlight: .init(taskTitle: nil, state: "RUNNING", startedAt: "not a date", heartbeatAt: iso(0)))
        XCTAssertEqual(ProjectPage.landingLine(view, now: Self.now, updatedAt: Self.now), ProjectPage.LandingLine(
            what: nil, running: true, state: "running", clock: "0m 0s", updated: "Updated just now"))
    }

    func testMergeJobsDescribeTheirKindAndActualPhase() {
        for (kind, word) in ProjectPage.integrationJobWords {
            for (phase, state) in ProjectPage.integrationPhaseWords {
                let view = ProjectIntegrationView(inFlight: .init(
                    state: "RUNNING", startedAt: iso(80), kind: kind, phase: phase, heartbeatAt: iso(0)))
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

    // MARK: The jobs in flight (docs/mocks/landing-jobs-sheet)

    /// One `inFlightJobs` element, its instants counted in seconds before `now`.
    private func job(_ id: String, kind: String = "LAND_TASK", state: String = "RUNNING",
                     phase: String? = "FETCH", taskId: String? = "t-c5", title: String? = "C5 · 托管 runner",
                     generation: Int = 1, started: TimeInterval = 80, queued: TimeInterval = 95,
                     heartbeat: TimeInterval? = 20, runner: String? = "workstation-gpu",
                     retriedBy: String? = nil, timedOut: Bool = false, limit: Int? = 600,
                     retryable: Bool = false) -> ProjectIntegrationJob {
        ProjectIntegrationJob(jobId: id, kind: kind, state: state, phase: phase, taskId: taskId, taskTitle: title,
                              generation: generation, startedAt: iso(started), queuedAt: iso(queued),
                              heartbeatAt: heartbeat.map { iso($0) }, runnerName: runner, retriedBy: retriedBy,
                              timedOut: timedOut, limitSeconds: limit, retryable: retryable)
    }

    /// The 21:57 screen: a landing whose runner took it 110 minutes ago and has said nothing since,
    /// and a merge into main queued behind it.
    private func stuckLanding() -> ProjectIntegrationView {
        let stuck = job("j-c5", started: 6_630, queued: 6_640, heartbeat: 6_620, timedOut: true, retryable: true)
        let merge = job("j-merge", kind: "LAND_PROMOTION", state: "QUEUED", phase: nil, taskId: nil, title: nil,
                        started: 2_468, queued: 2_468, heartbeat: nil, runner: nil, limit: nil)
        return ProjectIntegrationView(
            integratingCount: 1, queuedCount: 1,
            inFlight: .init(taskTitle: stuck.taskTitle, state: "RUNNING", startedAt: stuck.startedAt,
                            kind: "LAND_TASK", phase: "FETCH", heartbeatAt: stuck.heartbeatAt),
            inFlightJobs: [stuck, merge])
    }

    func testTheHelpersSayTheCountTheLimitTheTitleAndTheClockTime() throws {
        XCTAssertEqual(ProjectPage.landingJobsCount(2, timedOut: 0), "2 jobs")
        XCTAssertEqual(ProjectPage.landingJobsCount(2, timedOut: 1), "2 jobs · 1 timed out")
        XCTAssertEqual(ProjectPage.landingLimit(600), "limit 10m")
        XCTAssertEqual(ProjectPage.landingLimit(4_500), "limit 75m")
        // Rounded as `Math.round` rounds: half a minute goes up.
        XCTAssertEqual(ProjectPage.landingLimit(630), "limit 11m")
        XCTAssertEqual(ProjectPage.landingLimit(629), "limit 10m")
        XCTAssertEqual(ProjectPage.landingJobsTitle(1), "1 job in flight")
        XCTAssertEqual(ProjectPage.landingJobsTitle(2), "2 jobs in flight")
        XCTAssertEqual(ProjectPage.landingJobsTitle(0), "0 jobs in flight")
        // A local 24-hour clock, in the zone it is asked for: the reader's own by default.
        let claimed = try XCTUnwrap(RelativeTime.parse("2026-10-07T12:07:30.000Z"))
        let utc = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let east = try XCTUnwrap(TimeZone(secondsFromGMT: 8 * 3_600))
        let west = try XCTUnwrap(TimeZone(secondsFromGMT: -4 * 3_600))
        XCTAssertEqual(ProjectPage.landingClockTime(claimed, timeZone: utc), "12:07")
        XCTAssertEqual(ProjectPage.landingClockTime(claimed, timeZone: east), "20:07")
        XCTAssertEqual(ProjectPage.landingClockTime(claimed, timeZone: west), "08:07")
        XCTAssertEqual(ProjectPage.landingClockTime(claimed.addingTimeInterval(36_480), timeZone: utc), "22:15")
        XCTAssertEqual(ProjectPage.landingClockTime(claimed.addingTimeInterval(43_500), timeZone: utc), "00:12")
        // The one cached formatter goes back to the zone asked for, call after call.
        XCTAssertEqual(ProjectPage.landingClockTime(claimed, timeZone: utc), "12:07")
    }

    /// The row on a server that lists its jobs: the count says how many timed out, and a lead the
    /// server judged timed out says so — how long nothing was heard, against its limit.
    func testTheLandingLineSaysTheLeadTimedOutAndCountsTheTimedOutJobs() {
        XCTAssertEqual(ProjectPage.landingLine(stuckLanding(), now: Self.now, updatedAt: Self.now),
                       ProjectPage.LandingLine(what: "2 jobs · 1 timed out", running: false, state: "Timed out",
                                               clock: "110m", word: "Landing", clockLabel: "No report for",
                                               updated: "limit 10m", timedOut: true))
        // One job: the name slot is its task, as ever.
        let one = ProjectIntegrationView(
            integratingCount: 1, queuedCount: 0,
            inFlight: .init(taskTitle: "C5", state: "RUNNING", startedAt: iso(6_630), kind: "LAND_TASK",
                            phase: "CHECK", heartbeatAt: nil),
            inFlightJobs: [job("j", phase: "CHECK", started: 6_630, heartbeat: nil, timedOut: true, limit: 4_200)])
        let line = ProjectPage.landingLine(one, now: Self.now, updatedAt: Self.now)
        XCTAssertEqual(line?.what, "C5")
        XCTAssertEqual(line?.clock, "110m", "no report since the claim, when the runner never made one")
        XCTAssertEqual(line?.updated, "limit 70m")
        // Jobs in flight that did not time out: the count alone.
        let running = ProjectIntegrationView(
            integratingCount: 1, queuedCount: 1,
            inFlight: .init(taskTitle: "C5", state: "RUNNING", startedAt: iso(80), kind: "LAND_TASK", phase: "FETCH",
                            heartbeatAt: iso(20)),
            inFlightJobs: [job("j1"), job("j2", state: "QUEUED", phase: nil, heartbeat: nil, runner: nil)])
        XCTAssertEqual(ProjectPage.landingLine(running, now: Self.now, updatedAt: Self.now),
                       ProjectPage.LandingLine(what: "2 jobs", running: true, state: "fetching", clock: "1m 20s",
                                               word: "Landing", updated: "Updated just now"))
    }

    /// "Update unavailable" is this app unable to read the server, and it outranks what the last
    /// read said — a timed-out lead included: nobody knows what it is doing now.
    func testTheLandingLineCannotReadTheServerEvenWhenTheLeadTimedOut() {
        for (updatedAt, failed) in [(Self.now, true), (Self.now.addingTimeInterval(-91), false)] {
            let line = ProjectPage.landingLine(stuckLanding(), now: Self.now, updatedAt: updatedAt,
                                               refreshFailed: failed)
            XCTAssertEqual(line?.state, "Update unavailable")
            XCTAssertEqual(line?.running, false)
            XCTAssertEqual(line?.timedOut, false)
            XCTAssertEqual(line?.what, "2 jobs · 1 timed out")
            XCTAssertEqual(line?.clockLabel, "Elapsed")
            // Frozen at the runner's last report, ten seconds after its claim.
            XCTAssertEqual(line?.clock, "0m 10s")
            XCTAssertEqual(line?.updated, "Updated 110m ago")
        }
    }

    /// A server that lists its jobs decides what timed out; an old heartbeat alone is no longer
    /// "Update unavailable" — a long check is silent for as long as it runs.
    func testAServerThatListsItsJobsIsNotSecondGuessedFromTheHeartbeat() {
        let inFlight = ProjectIntegrationInFlight(taskTitle: "T", state: "RUNNING", startedAt: iso(720),
                                                  kind: "LAND_TASK", phase: "CHECK", heartbeatAt: iso(660))
        let listed = ProjectIntegrationView(integratingCount: 1, inFlight: inFlight, inFlightJobs: [
            job("j", phase: "CHECK", started: 720, heartbeat: 660, limit: 4_200),
        ])
        XCTAssertEqual(ProjectPage.landingLine(listed, now: Self.now, updatedAt: Self.now),
                       ProjectPage.LandingLine(what: "T", running: true, state: "checking", clock: "12m 0s",
                                               word: "Landing", updated: "Updated 11m ago"))
        // An empty list is still a server that lists them; no list at all is an older server, whose
        // row reads the reports for itself — and reads them for what they are: a runner that has
        // said nothing for a while is "No report", never a timeout (only the job's own verdict, the
        // server's `blockingReason`, may word one) and never "Update unavailable", which is this app
        // failing to READ the server.
        let empty = ProjectIntegrationView(integratingCount: 1, inFlight: inFlight, inFlightJobs: [])
        XCTAssertEqual(ProjectPage.landingLine(empty, now: Self.now, updatedAt: Self.now)?.state, "checking")
        let older = ProjectIntegrationView(integratingCount: 1, inFlight: inFlight)
        XCTAssertEqual(ProjectPage.landingLine(older, now: Self.now, updatedAt: Self.now)?.state, "No report")
        XCTAssertEqual(ProjectPage.landingLine(older, now: Self.now, updatedAt: Self.now)?.updated,
                       "No report for 11m")
        XCTAssertEqual(ProjectPage.landingLine(older, now: Self.now, updatedAt: Self.now)?.timedOut, false)
    }

    /// One line per job, in the server's order, each drawn as the row: its task in the name slot,
    /// a running job's phase and clock, a queued job's wait.
    func testTheJobLinesDrawEachJobAsTheRow() {
        let view = ProjectIntegrationView(
            integratingCount: 1, queuedCount: 2, inFlight: .init(state: "RUNNING", startedAt: iso(80)),
            inFlightJobs: [
                job("j1"),
                job("j2", phase: "REBASE", started: 130, heartbeat: nil),
                // Re-queued after an earlier claim: the raw row still carries that claim's step and
                // report, and neither is this wait's.
                job("j3", state: "QUEUED", phase: "PUSH", started: 2_468, heartbeat: 3_000, runner: nil, limit: nil),
            ])
        let lines = ProjectPage.landingJobLines(view, now: Self.now, updatedAt: Self.now.addingTimeInterval(-75))
        XCTAssertEqual(lines.map(\.id), ["j1", "j2", "j3"])
        XCTAssertEqual(lines[0], ProjectPage.LandingJobLine(
            jobId: "j1", taskId: "t-c5",
            line: ProjectPage.LandingLine(what: "C5 · 托管 runner", running: true, state: "fetching", clock: "1m 20s",
                                          word: "Landing", updated: "Updated just now"),
            detail: nil, retryable: false))
        // No report yet: how fresh the line is comes from the read, as the row's does.
        XCTAssertEqual(lines[1].line, ProjectPage.LandingLine(what: "C5 · 托管 runner", running: true,
                                                               state: "rebasing", clock: "2m 10s", word: "Landing",
                                                               updated: "Updated 1m ago"))
        XCTAssertEqual(lines[2].line, ProjectPage.LandingLine(what: "C5 · 托管 runner", running: false,
                                                               state: "queued", clock: "41m 8s", word: "Landing",
                                                               clockLabel: "Queued for", updated: "Updated 1m ago"))
        XCTAssertNil(lines[2].detail)
        XCTAssertEqual(ProjectPage.landingJobLines(ProjectIntegrationView(
            integratingCount: 1, inFlight: .init(state: "RUNNING", startedAt: iso(80))), now: Self.now), [],
            "an older server lists nothing")
    }

    /// A timed-out job says who took it and when, where it stopped, and whether a push may already
    /// have happened — and offers Retry when the server says it can be retried.
    func testATimedOutJobSaysWhereItsRunnerStoppedAndOffersRetry() throws {
        let claimed = try XCTUnwrap(RelativeTime.parse(iso(6_630)))
        let at = ProjectPage.landingClockTime(claimed)
        let lines = ProjectPage.landingJobLines(stuckLanding(), now: Self.now, updatedAt: Self.now)
        XCTAssertEqual(lines.map(\.id), ["j-c5", "j-merge"])
        XCTAssertEqual(lines[0], ProjectPage.LandingJobLine(
            jobId: "j-c5", taskId: "t-c5",
            line: ProjectPage.LandingLine(what: "C5 · 托管 runner", running: false, state: "Timed out", clock: "110m",
                                          word: "Landing", clockLabel: "No report for", updated: "limit 10m",
                                          timedOut: true),
            detail: "Runner workstation-gpu took it at \(at) · stopped at fetching · no push recorded",
            retryable: true))
        // A promotion lands no single task: no title, nothing to open.
        XCTAssertEqual(lines[1], ProjectPage.LandingJobLine(
            jobId: "j-merge", taskId: nil,
            line: ProjectPage.LandingLine(what: nil, running: false, state: "queued", clock: "41m 8s",
                                          word: "Merge to main", clockLabel: "Queued for", updated: "Updated just now"),
            detail: nil, retryable: false))

        func detail(phase: String?, runner: String? = "workstation-gpu") -> String? {
            let view = ProjectIntegrationView(inFlight: .init(state: "RUNNING", startedAt: iso(6_630)), inFlightJobs: [
                job("j", phase: phase, started: 6_630, heartbeat: 6_620, runner: runner, timedOut: true),
            ])
            return ProjectPage.landingJobLines(view, now: Self.now, updatedAt: Self.now).first?.detail
        }
        XCTAssertEqual(detail(phase: "PUSH"), "Runner workstation-gpu took it at \(at) · stopped at pushing · may have been pushed")
        XCTAssertEqual(detail(phase: "VERIFY"), "Runner workstation-gpu took it at \(at) · stopped at verifying · may have been pushed")
        XCTAssertEqual(detail(phase: "MERGE"), "Runner workstation-gpu took it at \(at) · stopped at merging · no push recorded")
        XCTAssertEqual(detail(phase: nil, runner: nil), "The runner took it at \(at) · stopped at running · no push recorded")
        // Retry is the server's to offer: a timed-out job it will not take has none.
        let refused = ProjectIntegrationView(inFlight: .init(state: "RUNNING", startedAt: iso(6_630)), inFlightJobs: [
            job("j", started: 6_630, heartbeat: 6_620, timedOut: true, retryable: false),
        ])
        XCTAssertEqual(ProjectPage.landingJobLines(refused, now: Self.now, updatedAt: Self.now).first?.retryable, false)
    }

    /// The run a retry started says which generation it is, who asked, and when.
    func testARetriedJobSaysItsGenerationAndWhoAsked() throws {
        let asked = try XCTUnwrap(RelativeTime.parse(iso(12)))
        let at = ProjectPage.landingClockTime(asked)
        let view = ProjectIntegrationView(inFlight: .init(state: "RUNNING", startedAt: iso(12)), inFlightJobs: [
            job("j2", generation: 2, started: 12, queued: 12, heartbeat: 2, retriedBy: "OWNER"),
            job("j3", state: "QUEUED", phase: nil, generation: 3, started: 12, queued: 12, heartbeat: nil, runner: nil,
                retriedBy: "COORDINATOR", limit: nil),
        ])
        let lines = ProjectPage.landingJobLines(view, now: Self.now, updatedAt: Self.now)
        XCTAssertEqual(lines.map(\.detail), ["Generation 2 · retried by you at \(at)",
                                             "Generation 3 · retried by the coordinator at \(at)"])
        XCTAssertEqual(lines[0].line.state, "fetching")
        XCTAssertEqual(lines[0].line.clock, "0m 12s")
    }

    /// While this app cannot read the server, every job says so — the timed-out one too — and its
    /// clock stops where the row's does. What the last read said under it stays.
    func testTheJobLinesCannotReadTheServerEither() {
        let lines = ProjectPage.landingJobLines(stuckLanding(), now: Self.now, updatedAt: Self.now,
                                                refreshFailed: true)
        XCTAssertEqual(lines.map(\.line.state), ["Update unavailable", "Update unavailable"])
        XCTAssertEqual(lines.map(\.line.timedOut), [false, false])
        XCTAssertEqual(lines.map(\.line.running), [false, false])
        XCTAssertEqual(lines[0].line.clock, "0m 10s")
        XCTAssertEqual(lines[0].line.updated, "Updated 110m ago")
        XCTAssertEqual(lines[0].detail?.hasSuffix("stopped at fetching · no push recorded"), true)
        XCTAssertEqual(lines[0].retryable, true)
        XCTAssertEqual(ProjectPage.landingJobLines(stuckLanding(), now: Self.now,
                                                   updatedAt: Self.now.addingTimeInterval(-91)).first?.line.state,
                       "Update unavailable")
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
         "coordinatorEnabled":true,"configRevision":"7","coordinatorSessionId":"s1","coordinatorWorkspaceId":"w1",
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
        XCTAssertEqual(doc.coordinatorWorkspaceId, "w1", "the workspace whose Wiki space the Wiki opens from the project")
        XCTAssertEqual(try JSONDecoder().decode(ProjectDocument.self, from: JSONEncoder().encode(doc)).coordinatorWorkspaceId, "w1")
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

    /// `inFlightJobs` as the server sends it — a timed-out landing and a merge queued behind it —
    /// and its absence from an older server, which is not an empty list.
    func testDecodesTheJobsInFlightAndAnOlderServersAbsence() throws {
        let view = try JSONDecoder().decode(ProjectIntegrationView.self, from: Data("""
        {"line":"PROJECT_BRANCH","ref":"project/runner","upstreamRef":"main","integratingCount":1,"queuedCount":1,
         "mergeCheckOnTip":"PASSING",
         "inFlight":{"taskTitle":"C5","kind":"LAND_TASK","phase":"FETCH","state":"RUNNING",
           "startedAt":"2026-10-07T12:07:04.000Z","heartbeatAt":"2026-10-07T12:07:13.000Z"},
         "inFlightJobs":[
           {"jobId":"j-c5","kind":"LAND_TASK","state":"RUNNING","phase":"FETCH","taskId":"t-c5","taskTitle":"C5",
            "generation":1,"startedAt":"2026-10-07T12:07:04.000Z","queuedAt":"2026-10-07T12:06:58.000Z",
            "heartbeatAt":"2026-10-07T12:07:13.000Z","runnerName":"workstation-gpu","retriedBy":null,
            "timedOut":true,"limitSeconds":600,"retryable":true},
           {"jobId":"j-merge","kind":"LAND_PROMOTION","state":"QUEUED","phase":null,"taskId":null,"taskTitle":null,
            "generation":2,"startedAt":"2026-10-07T13:16:00.000Z","queuedAt":"2026-10-07T13:16:00.000Z",
            "heartbeatAt":null,"runnerName":null,"retriedBy":"COORDINATOR","timedOut":false,"limitSeconds":null,
            "retryable":false,"somethingNewer":1}]}
        """.utf8))
        XCTAssertEqual(view.inFlight?.taskTitle, "C5")
        XCTAssertEqual(view.inFlightJobs, [
            ProjectIntegrationJob(jobId: "j-c5", kind: "LAND_TASK", state: "RUNNING", phase: "FETCH", taskId: "t-c5",
                                  taskTitle: "C5", generation: 1, startedAt: "2026-10-07T12:07:04.000Z",
                                  queuedAt: "2026-10-07T12:06:58.000Z", heartbeatAt: "2026-10-07T12:07:13.000Z",
                                  runnerName: "workstation-gpu", retriedBy: nil, timedOut: true, limitSeconds: 600,
                                  retryable: true),
            ProjectIntegrationJob(jobId: "j-merge", kind: "LAND_PROMOTION", state: "QUEUED", generation: 2,
                                  startedAt: "2026-10-07T13:16:00.000Z", queuedAt: "2026-10-07T13:16:00.000Z",
                                  retriedBy: "COORDINATOR"),
        ])

        let older = try JSONDecoder().decode(ProjectIntegrationView.self, from: Data(#"""
        {"integratingCount":1,"queuedCount":0,"inFlight":{"state":"RUNNING","startedAt":"2026-10-07T12:07:04.000Z"}}
        """#.utf8))
        XCTAssertNotNil(older.inFlight)
        XCTAssertNil(older.inFlightJobs, "an older server's absence, which no client reads as none in flight")
        let none = try JSONDecoder().decode(ProjectIntegrationView.self, from: Data(#"{"inFlightJobs":[]}"#.utf8))
        XCTAssertEqual(none.inFlightJobs, [])
        // An element that leaves its optional facts out decodes to their empty forms.
        let sparse = try JSONDecoder().decode(ProjectIntegrationView.self, from: Data(#"""
        {"inFlightJobs":[{"jobId":"j","kind":"LAND_TASK","state":"QUEUED","startedAt":"s","queuedAt":"q"}]}
        """#.utf8))
        XCTAssertEqual(sparse.inFlightJobs, [ProjectIntegrationJob(jobId: "j", kind: "LAND_TASK", state: "QUEUED",
                                                                   startedAt: "s", queuedAt: "q")])
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
            case ("POST", "/api/projects/p1/integration/jobs/j1/retry"):
                return (201, #"{"line":"PROJECT_BRANCH","integratingCount":0,"queuedCount":1,"inFlightJobs":[]}"#)
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
        let retried = try await api.retryIntegrationJob("p1", jobID: "j1")
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
        XCTAssertEqual(retried.queuedCount, 1, "the Retry answers the line read again")
        XCTAssertEqual(retried.inFlightJobs, [])
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
            // The owner's Retry carries no body: the job is the whole of what it names.
            "POST /api/projects/p1/integration/jobs/j1/retry",
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
