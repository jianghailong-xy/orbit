import Foundation
import XCTest
@testable import OrbitKit

/// The landing page's words, the Landings group's, the entrances', the X-E5 card's and the task
/// page's Landing section, looked up one by one in the web source they were ported from. The web
/// defines them; OrbitKit reads the same sentences to the same readers. A missing counterpart is a
/// FAILURE, never an `XCTSkip`.
final class LandingCopyParityTests: XCTestCase {
    private static let landingPage = "src/web/src/lib/landingSession.ts"
    private static let sessionProjects = "src/web/src/lib/sessionProjects.ts"
    private static let panorama = "src/web/src/components/ProjectPanoramaHeader.tsx"
    private static let progressStatus = "src/web/src/components/ProjectProgressStatus.tsx"
    private static let landTaskStatus = "src/web/src/components/LandTaskStatus.tsx"
    private static let deliveryCard = "src/web/src/components/OpenItemDeliveryCard.tsx"
    private static let projectMerge = "src/web/src/lib/projectMerge.ts"

    private struct Missing: Error, CustomStringConvertible {
        let file: String
        var description: String {
            "\(file) was not found above this test file. The native landing page is one half of a "
                + "pair; if the web half moved, move this check with it rather than deleting it."
        }
    }

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
                    .replacingOccurrences(of: "['`]\\s*\\+\\s*['`]", with: "", options: .regularExpression)
                    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(file: relative)
    }

    private func assertSays(_ web: String, _ literal: String, in file: String,
                            line: UInt = #line) {
        XCTAssertTrue(web.contains(literal), "\(file) no longer says \(literal)", line: line)
    }

    /// Every literal the landing page adds, key for key, against the web's `LANDING_PAGE_COPY`.
    func testTheLandingPagesWordsAreTheWebsOwn() throws {
        let web = try source(Self.landingPage)
        let constants: [(String, String)] = [
            ("CHIP", LandingPageCopy.chip),
            ("RUN_BY_ORBIT", LandingPageCopy.runByOrbit),
            ("SETTLED", LandingPageCopy.settled),
            ("LAND", LandingPageCopy.land),
            ("MERGE_ROUND", LandingPageCopy.mergeRound),
            ("INTO_MAIN", LandingPageCopy.intoMain),
            ("LANDED", LandingPageCopy.landed),
            ("ALREADY_LANDED", LandingPageCopy.alreadyLanded),
            ("NOTHING_TO_LAND", LandingPageCopy.nothingToLand),
            ("HANDLED", LandingPageCopy.handled),
            ("DECLINED", LandingPageCopy.declined),
            ("CANCELLED", LandingPageCopy.cancelled),
            ("DELETED", LandingPageCopy.deleted),
            ("MERGED_INTO", LandingPageCopy.mergedInto),
            ("NOW_ON", LandingPageCopy.nowOn),
            ("LANDED_ON", LandingPageCopy.landedOn),
            ("ALREADY_ON", LandingPageCopy.alreadyOn),
            ("NOT_LANDED", LandingPageCopy.notLanded),
            ("NOT_MERGED", LandingPageCopy.notMerged),
            ("READY", LandingPageCopy.ready),
            ("PASSED_CHECK", LandingPageCopy.passedCheck),
            ("PASSED_ON_THE_TREE", LandingPageCopy.passedOnTheTree),
            ("LANDED_EXACTLY", LandingPageCopy.landedExactly),
            ("AS_A_MERGE_COMMIT", LandingPageCopy.asAMergeCommit),
            ("BY_FAST_FORWARD", LandingPageCopy.byFastForward),
            ("AUTOMATICALLY", LandingPageCopy.automatically),
            ("BY_YOU", LandingPageCopy.byYou),
            ("QUEUED", LandingPageCopy.queued),
            ("CANCELLING", LandingPageCopy.cancelling),
            ("TIMED_OUT", LandingPageCopy.timedOut),
            ("UPDATE_UNAVAILABLE", LandingPageCopy.updateUnavailable),
            ("TASK_ACCEPTANCE", LandingPageCopy.taskAcceptance),
            ("MERGE_CHECK", LandingPageCopy.mergeCheck),
            ("RUNNING", LandingPageCopy.running),
            ("CHECKS_FAILED", LandingPageCopy.checksFailed),
            ("EXIT", LandingPageCopy.exit),
            ("AFTER", LandingPageCopy.after),
            ("ON_THE_COMBINED_TREE", LandingPageCopy.onTheCombinedTree),
            ("NOTHING_PUSHED_CLAUSE", LandingPageCopy.nothingPushedClause),
            ("STOPPED_WITH_AN_ERROR", LandingPageCopy.stoppedWithAnError),
            ("COULD_NOT_MERGE", LandingPageCopy.couldNotMerge),
            ("CONFLICT", LandingPageCopy.conflict),
            ("STOPPED_NOT_LANDED", LandingPageCopy.stoppedNotLanded),
            ("CHECKS_TIMED_OUT", LandingPageCopy.checksTimedOut),
            ("TOOK_IT_AT", LandingPageCopy.tookItAt),
            ("STOPPED_AT", LandingPageCopy.stoppedAt),
            ("THE_RUNNER", LandingPageCopy.theRunner),
            ("RUNNER", LandingPageCopy.runner),
            ("NO_REPORT_FOR", LandingPageCopy.noReportFor),
            ("NO_REPORT_FROM", LandingPageCopy.noReportFrom),
            ("SINCE", LandingPageCopy.since),
            ("LIMIT", LandingPageCopy.limit),
            ("NOTHING_WAS_PUSHED", LandingPageCopy.nothingWasPushed),
            ("MAY_HAVE_BEEN_PUSHED", LandingPageCopy.mayHaveBeenPushed),
            ("NOTHING_PUSHED_SENTENCE", LandingPageCopy.nothingPushedSentence),
            ("MAY_HAVE_PUSHED_SENTENCE", LandingPageCopy.mayHavePushedSentence),
            ("OPEN_TASK", LandingPageCopy.openTask),
            ("OPEN_SOURCE_SESSION", LandingPageCopy.openSourceSession),
            ("OPEN_COORDINATOR", LandingPageCopy.openCoordinator),
            ("OPEN_COORDINATOR_LINK", LandingPageCopy.openCoordinatorLink),
            ("REVIEW_CARD", LandingPageCopy.reviewCard),
            ("STOP_LANDING", LandingPageCopy.stopLanding),
            ("CANCEL_MERGE", LandingPageCopy.cancelMerge),
            ("ABANDON", LandingPageCopy.abandon),
            ("RETRY", LandingPageCopy.retry),
            ("RERUN_THE_CHECK", LandingPageCopy.rerunTheCheck),
            ("BEFORE_PUSH_ONLY", LandingPageCopy.beforePushOnly),
            ("CANCEL_BEFORE_PUSH", LandingPageCopy.cancelBeforePush),
            ("ENDS_NOTHING_PUSHED", LandingPageCopy.endsNothingPushed),
            ("ENDS_MAY_HAVE_PUSHED", LandingPageCopy.endsMayHavePushed),
            ("STOP_FAILED", LandingPageCopy.stopFailed),
            ("CANCEL_FAILED", LandingPageCopy.cancelFailed),
            ("ABANDON_FAILED", LandingPageCopy.abandonFailed),
            ("RETRY_FAILED", LandingPageCopy.retryFailed),
            ("RERUN_FAILED", LandingPageCopy.rerunFailed),
            ("RERUN_END", LandingPageCopy.rerunEnd),
            ("ABANDON_END", LandingPageCopy.abandonEnd),
            ("NO_RETRY_MERGE", LandingPageCopy.noRetryMerge),
            ("LEGACY_PUSH_VARIANT", LandingPageCopy.legacyPushVariant),
            ("ORBIT_RUNS_THIS_LANDING", LandingPageCopy.orbitRunsThisLanding),
            ("THIS_LANDING_IS_COMPLETE", LandingPageCopy.thisLandingIsComplete),
            ("LOADING_LANDING", LandingPageCopy.loadingLanding),
            ("LOADING_LOG", LandingPageCopy.loadingLog),
            ("LOG_UNAVAILABLE", LandingPageCopy.logUnavailable),
            ("LOG_EMPTY", LandingPageCopy.logEmpty),
            ("SHOW_MORE", LandingPageCopy.showMore),
            ("LOG", LandingPageCopy.log),
            ("OLDER_ATTEMPTS_HIDDEN", LandingPageCopy.olderAttemptsHidden),
            ("DECISIONS_THE_COORDINATOR", LandingPageCopy.decisionsTheCoordinator),
            ("A_CLEAN_PASS_MERGES_ON_ITS_OWN", LandingPageCopy.aCleanPassMergesOnItsOwn),
            ("MERGING_IS_DECIDED_ON_THE_CARD", LandingPageCopy.mergingIsDecidedOnTheCard),
        ]
        for (key, copy) in constants {
            assertSays(web, "\(key): '\(copy)',", in: Self.landingPage)
        }
        // The templates, in the web's own spelling.
        assertSays(web, "`Task acceptance exited ${code} (expected ${expected}) on the combined tree`",
                   in: Self.landingPage)
        assertSays(web, "`May have been pushed — it reported starting the push at ${time}, then went silent.`",
                   in: Self.landingPage)
        assertSays(web, "`${bytes} bytes omitted`", in: Self.landingPage)
        assertSays(web, "`The next merge into main opens a new landing (#${next}).`",
                   in: Self.landingPage)
        // §2.7a: a RUNNING attempt four seconds, a queued one fifteen, and nothing once settled.
        assertSays(web, "return landing.currentAttempt?.state === 'RUNNING' ? 4_000 : 15_000;",
                   in: Self.landingPage)
        XCTAssertEqual(LandingPageCopy.taskAcceptanceExited("1", expected: "0"),
                       "Task acceptance exited 1 (expected 0) on the combined tree")
        XCTAssertEqual(LandingPageCopy.nextMergeOpens(10),
                       "The next merge into main opens a new landing (#10).")
        XCTAssertEqual(LandingPageCopy.bytesOmitted(4_096), "4096 bytes omitted")
    }

    /// The Landings group's words and the source session's derived label.
    func testTheLandingsGroupsAndSourceLabelsWordsAreTheWebsOwn() throws {
        let web = try source(Self.sessionProjects)
        for (key, copy) in [("TITLE", SessionLandingsCopy.title),
                            ("EARLIER", SessionLandingsCopy.earlier),
                            ("LANDED", SessionLandingsCopy.landed),
                            ("NOTHING_TO_LAND", SessionLandingsCopy.nothingToLand),
                            ("WITH_YOU", SessionLandingsCopy.withYou),
                            ("WITH_COORDINATOR", SessionLandingsCopy.withCoordinator),
                            ("WAITING", SessionLandingsCopy.waiting)] {
            assertSays(web, "\(key): '\(copy)',", in: Self.sessionProjects)
        }
        for (key, copy) in [("LANDING", SessionLandingsCopy.landing),
                            ("ON", SessionLandingsCopy.on),
                            ("NOTHING_TO_LAND", SessionLandingsCopy.sourceNothingToLand),
                            ("CHECKS_FAILED", SessionLandingsCopy.checksFailed),
                            ("CONFLICT", SessionLandingsCopy.conflict),
                            ("ERROR", SessionLandingsCopy.error),
                            ("QUEUED", SessionLandingsCopy.queued),
                            ("RUNNING", SessionLandingsCopy.running)] {
            assertSays(web, "\(key): '\(copy)',", in: Self.sessionProjects)
        }
        // The 24-hour window, and the fold's one line.
        assertSays(web, "export const LANDINGS_SETTLED_WINDOW_MS = 24 * 60 * 60 * 1_000;",
                   in: Self.sessionProjects)
        XCTAssertEqual(landingsSettledWindow, 24 * 60 * 60)
        assertSays(web, "return `${SESSION_LANDINGS_COPY.EARLIER} · ${earlier.landed} ${SESSION_LANDINGS_COPY.LANDED} · ${earlier.nothing} ${SESSION_LANDINGS_COPY.NOTHING_TO_LAND}`;",
                   in: Self.sessionProjects)
        XCTAssertEqual(SessionProjectLandings.earlierLine(landed: 31, nothing: 3),
                       "Earlier · 31 landed · 3 nothing to land")
        // The item reasons the group's rows print.
        for reason in ["Merge conflict", "Checks failed", "Integration error", "Task failed",
                       "Delivery review", "No report from the runner"] {
            assertSays(web, "'\(reason)'", in: Self.sessionProjects)
        }
    }

    /// The entrances (owner 2026-10-19, 方案 A): `Open landing ›`, the grey sentence, `All jobs ›`,
    /// and the merge card's `+N job queued`.
    func testTheLandingEntrancesWordsAreTheWebsOwn() throws {
        let web = try source(Self.panorama)
        assertSays(web, "LANDING_OPEN = '\(LandingPageCopy.openLanding)';", in: Self.panorama)
        assertSays(web, "LANDING_NO_PAGE = '\(LandingPageCopy.noLandingPage)';", in: Self.panorama)
        assertSays(web, "LANDING_ALL_JOBS = '\(LandingPageCopy.allJobs)';", in: Self.panorama)
        XCTAssertEqual(LandingPageCopy.moreJobsQueued(3), "+2 jobs queued")
        XCTAssertEqual(LandingPageCopy.moreJobsQueued(2), "+1 job queued")
        XCTAssertNil(LandingPageCopy.moreJobsQueued(1))
        let merge = try source(Self.projectMerge)
        assertSays(merge, "return `+${others} job${others === 1 ? '' : 's'} queued`;",
                   in: Self.projectMerge)
        assertSays(merge, "if (promotion?.landingSessionId) return promotion.landingSessionId;",
                   in: Self.projectMerge)
        // The entry's two answers are the link's own words.
        XCTAssertEqual(LandingEntry.link("s").label, LandingPageCopy.openLanding)
        XCTAssertEqual(LandingEntry.noPage.label, LandingPageCopy.noLandingPage)
    }

    /// The owner card's landing doors — their labels, consequences and J12's push half.
    func testTheOwnerCardsLandingDoorsAreTheWebsOwn() throws {
        let web = try source(Self.progressStatus)
        assertSays(web, "OPEN_LANDING: '\(ExceptionCards.openLanding)',", in: Self.progressStatus)
        assertSays(web, "ABANDON: '\(ExceptionCards.abandon)',", in: Self.progressStatus)
        for consequence in ExceptionCards.actionConsequences.values {
            // The map's one-line consequences, each the browser's own sentence.
            assertSays(web, consequence, in: Self.progressStatus)
        }
        assertSays(web, "export const ABANDON_MAY_HAVE_PUSHED = '\(ExceptionCards.abandonMayHavePushed)';",
                   in: Self.progressStatus)
        // §4.6 X-E5: escalated at birth, its heading counts the claim's silence.
        assertSays(web, "'Now yours — no report from the runner'", in: Self.progressStatus)
        assertSays(web, "`Now yours — no report from the runner for ${silent}m`",
                   in: Self.progressStatus)
        assertSays(web, "`Owner: you · ${waited}`", in: Self.progressStatus)
    }

    /// The task page's Landing section: the badge words, `generation N`, `stopped while …`, and the
    /// six fact rows.
    func testTheTaskPagesLandingWordsAreTheWebsOwn() throws {
        let web = try source(Self.landTaskStatus)
        for (state, label) in TaskLandingCopy.labels {
            assertSays(web, "\(state): '\(label)',", in: Self.landTaskStatus)
        }
        assertSays(web, "generation {job.generation}", in: Self.landTaskStatus)
        assertSays(web, "`stopped while ${step}`", in: Self.landTaskStatus)
        assertSays(web, "Task {taskStatus}", in: Self.landTaskStatus)
        assertSays(web, "`On ${main}`", in: Self.landTaskStatus)
        assertSays(web, "Waiting to land: the landing has not been queued yet", in: Self.landTaskStatus)
        assertSays(web, "by an existing receipt.", in: Self.landTaskStatus)
        for label in [TaskLandingCopy.targetLabel, TaskLandingCopy.queueWaitLabel,
                      TaskLandingCopy.queuedLabel, TaskLandingCopy.startedLabel,
                      TaskLandingCopy.heartbeatLabel, TaskLandingCopy.finishedLabel] {
            assertSays(web, "<dt>\(label)</dt>", in: Self.landTaskStatus)
        }
        assertSays(web, "data-liveness=\"LEGACY\"", in: Self.landTaskStatus)
        let panorama = try source(Self.panorama)
        assertSays(panorama, "REPORTS_ONLY_BETWEEN_STEPS", in: Self.panorama)
        XCTAssertEqual(TaskLandingCopy.reportsOnlyBetweenSteps, ProjectPage.landingReportsOnlyBetweenSteps)
    }

    /// The delivery card's third link.
    func testTheDeliveryCardsLandingLinkIsTheWebsOwn() throws {
        let web = try source(Self.deliveryCard)
        assertSays(web, OpenItemDeliveryCard.openLanding, in: Self.deliveryCard)
        XCTAssertEqual(OpenItemDeliveryCard.openLanding, "Open the landing ↗")
    }

    /// The group's 24-hour window and the page's 90-second read guard are the same numbers as the
    /// web's; a cadence that drifted would poll a page the other client leaves alone.
    func testTheCadencesAndReadGuardsMatchTheWeb() throws {
        let web = try source(Self.landingPage)
        assertSays(web, "const LEASE_STALE_MS = 90_000;", in: Self.landingPage)
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        XCTAssertTrue(LandingPageCopy.readUnavailable(now: now,
                                                      updatedAt: now.addingTimeInterval(-91), failed: false))
        XCTAssertFalse(LandingPageCopy.readUnavailable(now: now,
                                                       updatedAt: now.addingTimeInterval(-89), failed: false))
        XCTAssertTrue(LandingPageCopy.readUnavailable(now: now, updatedAt: nil, failed: true))
        assertSays(web, "export function landingRefetchMs(", in: Self.landingPage)
        // The task page's cadence: 4 s running, 15 s queued (the same two numbers).
        let running = TaskIntegrationView(state: "RUNNING", landTask: LandTaskIntegrationView(
            jobId: "j", state: "RUNNING", targetRef: "r"))
        XCTAssertEqual(TaskLandingCopy.refetchInterval(running), 4)
        let queued = TaskIntegrationView(state: "QUEUED")
        XCTAssertEqual(TaskLandingCopy.refetchInterval(queued), 15)
        XCTAssertNil(TaskLandingCopy.refetchInterval(TaskIntegrationView(state: "ON_UPSTREAM")))
    }
}
