import Foundation
import XCTest
@testable import OrbitKit

/// The landing session page's model, held to `src/web/src/lib/landingSession.test.ts` case for case:
/// the status card's five livenesses and three job kinds, J12's push verdict, the owner doors, the
/// ⋯ menu, the settle outcome, and the header/footer words.
final class LandingSessionPageTests: XCTestCase {
    // Local wall-clock instants: the page draws a reader's own clock, so no assertion may hard-code
    // a UTC time (the landing merge check runs in the runner's zone).
    private func at(_ hour: Int, _ minute: Int, _ second: Int = 0) -> String {
        var components = DateComponents()
        components.year = 2026
        components.month = 9
        components.day = 25
        components.hour = hour
        components.minute = minute
        components.second = second
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let date = calendar.date(from: components)!
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = .current
        return formatter.string(from: date)
    }

    private func date(_ hour: Int, _ minute: Int, _ second: Int = 0) -> Date {
        RelativeTime.parse(at(hour, minute, second))!
    }

    private var now: Date { date(14, 58, 30) }
    private var step: String { at(14, 56, 40) }

    private func attempt(_ over: (inout AttemptBuilder) -> Void = { _ in }) -> SessionLandingAttempt {
        var b = AttemptBuilder(step: step, at: at)
        over(&b)
        return b.build()
    }

    private struct AttemptBuilder {
        let step: String
        let at: (Int, Int, Int) -> String
        var jobId = "job-1"
        var kind = "LAND_TASK"
        var state = "RUNNING"
        var generation = 1
        var phase: String? = "CHECK"
        var round: Int? = 1
        var stepName: String? = nil
        var claim = 1
        var runnerName: String? = "wikova"
        var sourceSessionId: String? = "source-1"
        var startedAt: String?
        var heartbeatAt: String?
        var outputMovedAt: String?
        var progressProtocol: String? = "v2"
        var check: LandingAttemptCheck?
        var liveness: String? = "LIVE"
        var blockingReason: LandTaskBlockingReason? = nil
        var timedOut = false
        var limitSeconds: Int? = 600
        var retryable = false
        var pushBoundaryPassed = false

        init(step: String, at: @escaping (Int, Int, Int) -> String) {
            self.step = step
            self.at = at
            startedAt = step
            heartbeatAt = at(14, 58, 30)
            outputMovedAt = at(14, 58, 24)
            check = LandingAttemptCheck(name: "MERGE_CHECK", index: 1, count: 3,
                                        budgetSeconds: 3_600, startedAt: step)
        }

        func build() -> SessionLandingAttempt {
            SessionLandingAttempt(
                jobId: jobId, kind: kind, state: state, generation: generation, phase: phase,
                round: round, step: stepName, claim: claim, runnerName: runnerName,
                sourceSessionId: sourceSessionId, targetRef: "refs/heads/project/p1",
                startedAt: startedAt ?? step, heartbeatAt: heartbeatAt,
                outputMovedAt: outputMovedAt, progressProtocol: progressProtocol, check: check,
                liveness: liveness, blockingReason: blockingReason, timedOut: timedOut,
                limitSeconds: limitSeconds, retryable: retryable,
                pushBoundaryPassed: pushBoundaryPassed)
        }
    }

    private func landing(_ over: (inout LandingBuilder) -> Void = { _ in }) -> SessionLandingView {
        var b = LandingBuilder(at: at, attempt: attempt())
        over(&b)
        return b.build()
    }

    private struct LandingBuilder {
        let at: (Int, Int, Int) -> String
        var sessionId = "landing-1"
        var projectId = "project-1"
        var subject = "TASK"
        var taskId: String? = "task-1"
        var promotionId: String? = nil
        var episode = 1
        var settledAt: String? = nil
        var settledAs: String? = nil
        var checks: [LandingCheckResult] = []
        var currentAttempt: SessionLandingAttempt?
        var timeline: SessionLandingTimeline? = SessionLandingTimeline()

        init(at: @escaping (Int, Int, Int) -> String, attempt: SessionLandingAttempt) {
            self.at = at
            currentAttempt = attempt
        }

        func build() -> SessionLandingView {
            SessionLandingView(
                sessionId: sessionId, projectId: projectId, subject: subject, taskId: taskId,
                promotionId: promotionId, episode: episode, openedAt: at(14, 50, 0),
                settledAt: settledAt, settledAs: settledAs, phase: "CHECK", round: 1,
                checks: checks, liveness: "LIVE", currentAttempt: currentAttempt,
                timeline: timeline)
        }
    }

    private func entry(_ over: [String: Any] = [:]) -> IntegrationTimelineEntry {
        IntegrationTimelineEntry(
            id: over["id"] as? String ?? "e1", seq: 1,
            kind: over["kind"] as? String ?? "CLAIMED",
            at: over["at"] as? String ?? step,
            claim: over["claim"] as? Int ?? 1,
            phase: over["phase"] as? String,
            data: over["data"] as? [String: JSONValue],
            text: over["text"] as? String ?? "Claimed by runner wikova · claim 1")
    }

    private func section(_ entries: [IntegrationTimelineEntry],
                         jobId: String = "job-1", state: String = "RUNNING") -> IntegrationTimelineSection {
        IntegrationTimelineSection(title: "Generation 1", jobId: jobId, kind: "LAND_TASK",
                                   generation: 1, state: state, entries: entries)
    }

    private func timeline(_ sections: [IntegrationTimelineSection]) -> SessionLandingTimeline {
        SessionLandingTimeline(sections: sections, facts: [], truncated: false)
    }

    private func promotion(_ over: [String: Any] = [:]) -> ProjectPromotionView {
        ProjectPromotionView(
            promotionId: "promo-1", state: .merged,
            sourceRef: "refs/heads/project/p1", sourceSha: String(repeating: "a", count: 40),
            upstreamRef: "refs/heads/main", commitsAhead: 2, filesChanged: 3,
            taskIds: ["task-1", "task-2"],
            tasks: [PromotionTask(taskId: "task-1", title: "Ledger migration order"),
                    PromotionTask(taskId: "task-2", title: "Payout retry budget")],
            checks: [], conflicts: [],
            landsAs: "MERGE_COMMIT",
            merged: ProjectPromotionView.Merged(sha: "8ed0ea7" + String(repeating: "0", count: 33),
                                                at: at(9, 51), automatic: true, revert: nil),
            landsTreeSha: "5e5bfca" + String(repeating: "0", count: 33))
    }

    // MARK: - the renderer is chosen by the detail's sessionKind

    func testTheRendererIsChosenByTheDetailsSessionKind() {
        XCTAssertTrue(SessionDetail(id: "s", sessionKind: "LANDING").isLanding)
        XCTAssertFalse(SessionDetail(id: "s", sessionKind: "CONVERSATION").isLanding)
        XCTAssertFalse(SessionDetail(id: "s").isLanding)
        XCTAssertTrue(Session(id: "s", title: nil, status: .succeeded, agentId: nil,
                              assignedRunnerId: nil, pendingApprovals: nil, branch: nil,
                              updatedAt: nil, sessionKind: "LANDING").isLanding)
    }

    // MARK: - §2.7a: the polling cadence

    func testThePollingCadenceIsFourSecondsRunningFifteenQueuedAndNothingSettled() {
        XCTAssertEqual(LandingPageCopy.refetchInterval(landing()), 4)
        var queued = attempt { $0.state = "QUEUED"; $0.phase = nil; $0.claim = 0 }
        var idle = landing()
        idle = SessionLandingView(sessionId: idle.sessionId, projectId: idle.projectId,
                                  subject: idle.subject, currentAttempt: queued)
        XCTAssertEqual(LandingPageCopy.refetchInterval(idle), 15)
        XCTAssertEqual(LandingPageCopy.refetchInterval(landing { $0.currentAttempt = nil }), 15)
        XCTAssertNil(LandingPageCopy.refetchInterval(landing {
            $0.settledAt = at(9, 51); $0.settledAs = "LANDED"
        }))
        XCTAssertNil(LandingPageCopy.refetchInterval(nil))
    }

    // MARK: - the status card

    func testTheLiveHeadAndV6RowsForEachJobKind() {
        // §7.2 V6: the M is the kind's own most rounds per claim — three for a task's landing, none
        // for the two kinds with one round — whatever the check's count (3 here) says.
        for (kind, word, round) in [("LAND_TASK", "Landing", "round 1 of 3"),
                                    ("CHECK_PROMOTION", "Merge check", "round 1"),
                                    ("LAND_PROMOTION", "Merge to main", "round 1")] {
            let view = landing { $0.currentAttempt = attempt { $0.kind = kind } }
            let card = LandingPageCopy.attemptCard(view, now: now, updatedAt: now)!
            XCTAssertEqual(card.word, word)
            XCTAssertEqual(card.state, "checking")
            XCTAssertEqual(card.right, "1m 50s of 60m")
            XCTAssertEqual(card.detail,
                           "checking · output 6s ago · claim 1 · \(round) · updated just now")
            XCTAssertEqual(card.budget, "Merge check 1m 50s of 60m")
            XCTAssertEqual(card.live, "Output 6s ago · Updated just now")
            XCTAssertTrue(card.running)
        }
    }

    func testATaskLandingIsOfThreeWhateverItsChecksCountAndWithNoCheck() {
        func detail(_ over: @escaping (inout AttemptBuilder) -> Void) -> String {
            LandingPageCopy.attemptCard(landing { $0.currentAttempt = attempt(over) },
                                        now: now, updatedAt: now)!.detail
        }
        let step = self.step
        XCTAssertEqual(detail {
            $0.round = 2
            $0.check = LandingAttemptCheck(name: "TASK_ACCEPTANCE", index: 1, count: 1,
                                           budgetSeconds: 3_600, startedAt: step)
        }, "checking · output 6s ago · claim 1 · round 2 of 3 · updated just now")
        XCTAssertEqual(detail { $0.phase = "REBASE"; $0.check = nil },
                       "rebasing · output 6s ago · claim 1 · round 1 of 3 · updated just now")
        // A merge with no check in flight still names no M.
        XCTAssertEqual(detail { $0.kind = "LAND_PROMOTION"; $0.phase = "PUSH"; $0.check = nil },
                       "pushing · output 6s ago · claim 1 · round 1 · updated just now")
    }

    func testQuietSaysNoOutputWithinItsBudget() {
        let view = landing {
            $0.currentAttempt = attempt { $0.liveness = "QUIET"; $0.outputMovedAt = at(14, 44, 30) }
        }
        let card = LandingPageCopy.attemptCard(view, now: now, updatedAt: now)!
        XCTAssertEqual(card.detail,
                       "checking · no output for 14m · within its 60m budget · claim 1 · round 1 of 3 · updated just now")
        XCTAssertEqual(card.live, "No output for 14m · within its 60m budget · Updated just now")
        XCTAssertTrue(card.running)
    }

    func testSilentFreezesClockAtTheRunnersLastWord() {
        let view = landing {
            $0.currentAttempt = attempt {
                $0.liveness = "SILENT"
                $0.heartbeatAt = at(14, 54, 30)
                $0.startedAt = at(14, 53, 30)
                $0.check = LandingAttemptCheck(name: "MERGE_CHECK", index: 1, count: 3,
                                               budgetSeconds: 3_600, startedAt: at(14, 49, 30))
            }
        }
        let card = LandingPageCopy.attemptCard(view, now: now, updatedAt: now)!
        XCTAssertEqual(card.detail, "checking · no word from runner wikova for 4m · claim 1 · round 1 of 3")
        XCTAssertEqual(card.live, "No word from runner wikova for 4m")
        XCTAssertEqual(card.right, "5m 0s of 60m")
    }

    func testLegacySaysReportsOnlyBetweenSteps() {
        let view = landing {
            $0.currentAttempt = attempt {
                $0.liveness = "LEGACY"
                $0.heartbeatAt = at(14, 46, 30)
                $0.progressProtocol = nil
            }
        }
        let card = LandingPageCopy.attemptCard(view, now: now, updatedAt: now)!
        XCTAssertEqual(card.detail, "checking · reports only between steps · claim 1 · round 1 of 3 · updated 12m ago")
        XCTAssertEqual(card.live, "Reports only between steps · Updated 12m ago")
    }

    func testLeaseExpiredDrawsTheServersOwnTimedOutHead() {
        let view = landing {
            $0.currentAttempt = attempt {
                $0.liveness = "LEASE_EXPIRED"; $0.timedOut = true; $0.heartbeatAt = at(14, 35, 30)
            }
        }
        let card = LandingPageCopy.attemptCard(view, now: now, updatedAt: now)!
        XCTAssertTrue(card.timedOut)
        XCTAssertEqual(card.right, "Timed out")
        XCTAssertFalse(card.rightIsClock)
        XCTAssertEqual(card.detail, "No report for 23m · limit 10m")
        XCTAssertFalse(card.running)
    }

    func testTheTakeoverNamesTheFirstStartTheTimelineStillCarries() {
        let twoClaims = timeline([section([
            entry(["id": "c1", "kind": "CLAIMED", "at": at(17, 3), "claim": 1]),
            entry(["id": "c2", "kind": "TAKEN_OVER", "at": at(17, 31), "claim": 2]),
        ])])
        let takeoverNow = date(17, 36, 30)
        let view = landing {
            $0.timeline = twoClaims
            $0.currentAttempt = attempt {
                $0.claim = 2; $0.startedAt = at(17, 31); $0.heartbeatAt = at(17, 36)
            }
        }
        let card = LandingPageCopy.attemptCard(view, now: takeoverNow, updatedAt: takeoverNow)!
        let first = ProjectPage.landingClockTime(date(17, 3))
        let taken = ProjectPage.landingClockTime(date(17, 31))
        XCTAssertTrue(card.detail.contains("Taken over \(taken) · first started \(first)"),
                      card.detail)
    }

    func testUpdateUnavailableFreezesTheClockAndOpensNothing() {
        let card = LandingPageCopy.attemptCard(landing(), now: now,
                                               updatedAt: now.addingTimeInterval(-91))!
        XCTAssertEqual(card.state, LandingPageCopy.updateUnavailable)
        XCTAssertEqual(card.detail, LandingPageCopy.updateUnavailable)
        XCTAssertFalse(card.running)
        XCTAssertEqual(card.live, "Updated 1m ago")
        let failed = LandingPageCopy.attemptCard(landing(), now: now, updatedAt: now, failed: true)!
        XCTAssertEqual(failed.detail, LandingPageCopy.updateUnavailable)
        XCTAssertEqual(LandingPageCopy.gates(landing(), now: now, updatedAt: nil, failed: true),
                       .none)
    }

    func testAStopAskedForAndNotAnsweredSaysCancelling() {
        let asked = timeline([section([
            entry(["id": "c", "kind": "CLAIMED", "claim": 1]),
            entry(["id": "s", "kind": "STOP_REQUESTED", "claim": 1, "text": "Stop requested · claim 1"]),
        ])])
        let view = landing { $0.timeline = asked }
        XCTAssertTrue(LandingPageCopy.cancelling(view))
        XCTAssertEqual(LandingPageCopy.attemptCard(view, now: now, updatedAt: now)!.state, "Cancelling")
        XCTAssertFalse(LandingPageCopy.gates(view, now: now, updatedAt: now).stop)
        // The ask belongs to the claim it names: a takeover starts clean.
        let takenOver = landing {
            $0.timeline = asked
            $0.currentAttempt = attempt { $0.claim = 2 }
        }
        XCTAssertFalse(LandingPageCopy.cancelling(takenOver))
        XCTAssertTrue(LandingPageCopy.gates(takenOver, now: now, updatedAt: now).stop)
    }

    // MARK: - J12: what a timed-out attempt can say about the push

    func testAV2ClaimWithNoPushReportProvesNothingWasPushed() {
        let timed = attempt {
            $0.liveness = "LEASE_EXPIRED"; $0.timedOut = true; $0.phase = "REBASE"
        }
        let view = landing { $0.currentAttempt = timed }
        XCTAssertEqual(LandingPageCopy.pushSentence(view, attempt: timed),
                       LandingPageCopy.nothingPushedSentence)
    }

    func testALegacyClaimMayHaveBeenPushed() {
        let legacy = attempt {
            $0.liveness = "LEASE_EXPIRED"; $0.timedOut = true; $0.phase = "REBASE"
            $0.progressProtocol = nil
        }
        XCTAssertEqual(LandingPageCopy.pushSentence(landing { $0.currentAttempt = legacy },
                                                    attempt: legacy),
                       LandingPageCopy.mayHavePushedSentence)
    }

    func testAReportThatNamedThePushSaysSoWithItsTime() {
        let pushed = attempt {
            $0.liveness = "LEASE_EXPIRED"; $0.timedOut = true; $0.phase = "PUSH"
        }
        let view = landing {
            $0.currentAttempt = pushed
            $0.timeline = timeline([section([
                entry(["id": "p", "kind": "STEP", "phase": "PUSH", "at": at(15, 42)]),
            ])])
        }
        let clock = ProjectPage.landingClockTime(date(15, 42))
        XCTAssertEqual(LandingPageCopy.pushSentence(view, attempt: pushed),
                       LandingPageCopy.mayHavePushedAt(clock))
    }

    func testAMergeCheckWritesNoPushSentenceAtAll() {
        let check = attempt {
            $0.kind = "CHECK_PROMOTION"; $0.phase = "CHECK"
            $0.liveness = "LEASE_EXPIRED"; $0.timedOut = true
        }
        let view = landing { $0.subject = "PROMOTION"; $0.currentAttempt = check }
        XCTAssertNil(LandingPageCopy.pushSentence(view, attempt: check))
        XCTAssertTrue(LandingPageCopy.timeoutLine(view, attempt: check).contains("stopped at checking"))
    }

    func testTheSectionEndsWithTheRunnersSilenceAsTheBandWordsIt() {
        let timed = attempt {
            $0.liveness = "LEASE_EXPIRED"; $0.timedOut = true; $0.heartbeatAt = at(14, 35, 30)
        }
        let band = LandingPageCopy.noReportBand(landing { $0.currentAttempt = timed })
        XCTAssertEqual(band?.text,
                       "No report from wikova since \(ProjectPage.landingClockTime(date(14, 35, 30)))")
        XCTAssertNil(LandingPageCopy.noReportBand(landing()))
    }

    func testTheTimeoutLineNamesWhoTookItWhereItStoppedAndTheClaim() {
        let timed = attempt {
            $0.liveness = "LEASE_EXPIRED"; $0.timedOut = true; $0.phase = "REBASE"
        }
        let view = landing { $0.currentAttempt = timed }
        XCTAssertEqual(
            LandingPageCopy.timeoutLine(view, attempt: timed),
            "Runner wikova took it at \(ProjectPage.landingClockTime(date(14, 56, 40))) · stopped at rebasing · claim 1 · round 1 of 3")
        // The M is the kind's, not the check's: a task's landing with one check is still "of 3", and a
        // merge into main, which has one round per claim, names none.
        let step = self.step
        let one = attempt {
            $0.liveness = "LEASE_EXPIRED"; $0.timedOut = true; $0.phase = "REBASE"
            $0.check = LandingAttemptCheck(name: "TASK_ACCEPTANCE", index: 1, count: 1,
                                           budgetSeconds: 3_600, startedAt: step)
        }
        XCTAssertTrue(LandingPageCopy.timeoutLine(landing { $0.currentAttempt = one }, attempt: one)
            .hasSuffix(" · claim 1 · round 1 of 3"))
        let merge = attempt {
            $0.kind = "LAND_PROMOTION"; $0.liveness = "LEASE_EXPIRED"; $0.timedOut = true; $0.phase = "PUSH"
        }
        XCTAssertEqual(
            LandingPageCopy.timeoutLine(landing { $0.subject = "PROMOTION"; $0.currentAttempt = merge }, attempt: merge),
            "Runner wikova took it at \(ProjectPage.landingClockTime(date(14, 56, 40))) · stopped at pushing · claim 1 · round 1")
    }

    // MARK: - the owner doors (LS6)

    func testARunningTaskLandingOffersStopAndNothingElse() {
        XCTAssertEqual(LandingPageCopy.gates(landing(), now: now, updatedAt: now),
                       LandingGates(stop: true))
    }

    func testPastThePushBoundaryStopDisappearsOnTheServersFactAlone() {
        XCTAssertFalse(LandingPageCopy.gates(
            landing { $0.currentAttempt = attempt { $0.pushBoundaryPassed = true } },
            now: now, updatedAt: now).stop)
        XCTAssertTrue(LandingPageCopy.gates(
            landing { $0.currentAttempt = attempt { $0.phase = "PUSH" } },
            now: now, updatedAt: now).stop)
    }

    func testAMergeRoundOffersCancelBeforeThePush() {
        let merge = attempt { $0.kind = "LAND_PROMOTION"; $0.phase = "CHECK" }
        let view = landing { $0.subject = "PROMOTION"; $0.promotionId = "promo-1"; $0.currentAttempt = merge }
        XCTAssertEqual(LandingPageCopy.gates(view, now: now, updatedAt: now),
                       LandingGates(cancel: true))
    }

    func testALeaseExpiredLandTaskOffersOnlyAbandonAndTheServersRetry() {
        let timed = attempt {
            $0.liveness = "LEASE_EXPIRED"; $0.timedOut = true; $0.retryable = true
        }
        XCTAssertEqual(LandingPageCopy.gates(landing { $0.currentAttempt = timed },
                                             now: now, updatedAt: now),
                       LandingGates(abandon: true, retry: true))
    }

    func testALeaseExpiredCheckOffersAbandonAndRerunTheCheck() {
        let timed = attempt {
            $0.kind = "CHECK_PROMOTION"; $0.liveness = "LEASE_EXPIRED"; $0.timedOut = true
        }
        let view = landing { $0.subject = "PROMOTION"; $0.promotionId = "promo-1"; $0.currentAttempt = timed }
        XCTAssertEqual(LandingPageCopy.gates(view, now: now, updatedAt: now),
                       LandingGates(abandon: true, recheck: true))
    }

    func testALeaseExpiredMergeHasNoRetryAndNoCancelOnlyAbandon() {
        let timed = attempt {
            $0.kind = "LAND_PROMOTION"; $0.liveness = "LEASE_EXPIRED"; $0.timedOut = true
        }
        let view = landing { $0.subject = "PROMOTION"; $0.promotionId = "promo-1"; $0.currentAttempt = timed }
        XCTAssertEqual(LandingPageCopy.gates(view, now: now, updatedAt: now),
                       LandingGates(abandon: true))
    }

    func testOpensNothingWhenTheDeviceCannotReadOrOnceSettled() {
        XCTAssertEqual(LandingPageCopy.gates(landing(), now: now,
                                             updatedAt: now.addingTimeInterval(-90.001)), .none)
        XCTAssertEqual(LandingPageCopy.gates(landing(), now: now, updatedAt: now, failed: true), .none)
        XCTAssertEqual(LandingPageCopy.gates(landing {
            $0.settledAt = at(9, 51); $0.settledAs = "LANDED"
        }, now: now, updatedAt: now), .none)
    }

    // MARK: - the ⋯ menu

    private func menu(_ view: SessionLandingView) -> [LandingMenuItem] {
        let gates = LandingPageCopy.gates(view, now: now, updatedAt: now)
        let nothingPushed: Bool
        if let attempt = view.currentAttempt {
            nothingPushed = attempt.kind == "CHECK_PROMOTION"
                || (attempt.timedOut
                    && LandingPageCopy.pushSentence(view, attempt: attempt)
                        == LandingPageCopy.nothingPushedSentence)
        } else {
            nothingPushed = false
        }
        return LandingPageCopy.menuItems(view, gates: gates, hasCoordinator: true,
                                         hasReview: true, nothingPushed: nothingPushed)
    }

    func testARunningTaskLandingsMenuHasTheFourWaysInAndStopLanding() {
        let items = menu(landing())
        XCTAssertEqual(items.map(\.action), [.openTask, .openSourceSession, .openCoordinator, .stop])
        let stop = items.first { $0.action == .stop }!
        XCTAssertEqual(stop.sub, "Before the push only · nothing pushed yet")
        XCTAssertTrue(stop.danger)
    }

    func testAMergeRoundsMenuHasReviewCardAndCancelAndNoStopLanding() {
        let merge = landing {
            $0.subject = "PROMOTION"; $0.promotionId = "promo-1"
            $0.currentAttempt = attempt { $0.kind = "LAND_PROMOTION"; $0.phase = "CHECK" }
        }
        let actions = menu(merge).map(\.action)
        XCTAssertTrue(actions.contains(.reviewCard))
        XCTAssertTrue(actions.contains(.cancel))
        XCTAssertFalse(actions.contains(.stop))
    }

    func testALeaseExpiredTaskLandingGivesAbandonAndRetryAndNeverCopyLink() {
        let timed = landing {
            $0.currentAttempt = attempt {
                $0.liveness = "LEASE_EXPIRED"; $0.timedOut = true; $0.retryable = true
            }
        }
        let items = menu(timed)
        let actions = items.map(\.action)
        XCTAssertTrue(actions.contains(.abandon))
        XCTAssertTrue(actions.contains(.retry))
        XCTAssertFalse(actions.contains(.stop))
        XCTAssertEqual(items.first { $0.action == .abandon }?.sub,
                       "Ends this attempt · nothing was pushed")
        XCTAssertFalse(items.map(\.label).contains("Copy Link"))
    }

    func testALeaseExpiredCheckGivesRerunTheCheckAndAbandon() {
        let timed = landing {
            $0.subject = "PROMOTION"; $0.promotionId = "promo-1"
            $0.currentAttempt = attempt {
                $0.kind = "CHECK_PROMOTION"; $0.liveness = "LEASE_EXPIRED"; $0.timedOut = true
            }
        }
        let items = menu(timed)
        let actions = items.map(\.action)
        XCTAssertTrue(actions.contains(.rerunTheCheck))
        XCTAssertTrue(actions.contains(.abandon))
        XCTAssertFalse(actions.contains(.retry))
        // A check never pushes: its Abandon ends an attempt that provably never reached main.
        XCTAssertEqual(items.first { $0.action == .abandon }?.sub,
                       "Ends this attempt · nothing was pushed")
    }

    // MARK: - the header and the read-only footer

    func testTheHeaderTitlesALinkedLandingWithItsServerTitleAndAPreRowOneFromTheView() {
        XCTAssertEqual(LandingPageCopy.headerTitle(landing(), rowTitle: "Land · Ledger migration order"),
                       "Land · Ledger migration order")
        XCTAssertEqual(LandingPageCopy.headerTitle(landing(), rowTitle: nil,
                                                   taskTitle: "Ledger migration order"),
                       "Land · Ledger migration order")
        let round = landing {
            $0.subject = "PROMOTION"; $0.taskId = nil; $0.promotionId = "p"; $0.episode = 7
        }
        let title = LandingPageCopy.headerTitle(round, rowTitle: nil)
        XCTAssertTrue(title.hasPrefix("Merge project "), title)
        XCTAssertTrue(title.hasSuffix(" → main · #7"), title)
    }

    func testTheHeaderNamesTheRunnerWhileItRunsAndTheSettlementOnceItHasSettled() {
        XCTAssertEqual(LandingPageCopy.headerSub(landing()), "Run by Orbit · runner wikova")
        XCTAssertEqual(LandingPageCopy.headerSub(landing {
            $0.settledAt = at(9, 51); $0.settledAs = "LANDED"
        }), "Run by Orbit · settled \(ProjectPage.landingClockTime(date(9, 51)))")
    }

    func testTheFooterPointsATaskSegmentAtTheCoordinatorARoundAtItsCardAndASettledOneAtNothing() {
        let task = LandingPageCopy.footer(landing(), onPass: nil)
        XCTAssertEqual(task.line, "Orbit runs this landing — nothing to type here.")
        XCTAssertEqual(task.detail, "Decisions: the coordinator")
        XCTAssertEqual(task.link, .coordinator)

        let round = landing { $0.subject = "PROMOTION" }
        XCTAssertEqual(LandingPageCopy.footer(round, onPass: "MERGE").detail,
                       "A clean pass merges on its own")
        XCTAssertEqual(LandingPageCopy.footer(round, onPass: "ASK").detail,
                       "Merging is decided on the merge card")
        let bare = LandingPageCopy.footer(round, onPass: nil)
        XCTAssertEqual(bare.detail, "Merging is decided on the merge card")
        XCTAssertEqual(bare.link, .reviewCard)

        let settled = LandingPageCopy.footer(landing {
            $0.subject = "PROMOTION"; $0.episode = 9
            $0.settledAt = at(9, 51); $0.settledAs = "MERGED"
        }, onPass: nil)
        XCTAssertEqual(settled.line, "This landing is complete — nothing to type here.")
        XCTAssertNil(settled.link)
        XCTAssertEqual(settled.next, "The next merge into main opens a new landing (#10).")
    }

    // MARK: - the settled round is the outcome

    func testTheSettledRoundDrawsTheMergedHeadTheTasksTheCheckAndTheTestedTree() {
        let outcome = LandingPageCopy.outcomeCard(
            landing {
                $0.subject = "PROMOTION"; $0.taskId = nil; $0.promotionId = "promo-1"
                $0.settledAt = at(9, 51); $0.settledAs = "MERGED"
                $0.checks = [LandingCheckResult(name: "MERGE_CHECK", exitCode: 0,
                                                expectedExitCode: 0, timedOut: false,
                                                durationMs: 17 * 60_000 + 41_000)]
            },
            promotion: promotion())!
        XCTAssertEqual(outcome.title, "Merged into main")
        XCTAssertEqual(outcome.right, ProjectPage.landingClockTime(date(9, 51)))
        XCTAssertEqual(outcome.detail, "8ed0ea7 · 2 tasks · automatically")
        XCTAssertEqual(outcome.tasksHeading, "Now on main · 2 tasks")
        XCTAssertEqual(outcome.tasks, ["Ledger migration order", "Payout retry budget"])
        XCTAssertEqual(outcome.checkLine, "✓ Passed on the combined tree · 17m 41s")
        XCTAssertEqual(outcome.treeLine, "Landed exactly the tested tree 5e5bfca · as a merge commit")
    }

    func testATaskSegmentLandsOnItsOwnBranchWord() {
        let outcome = LandingPageCopy.outcomeCard(landing {
            $0.settledAt = at(11, 7); $0.settledAs = "LANDED"
        }, promotion: nil)!
        XCTAssertEqual(outcome.title, "Landed")
        XCTAssertEqual(outcome.detail, "Landed on project/p1")
    }

    func testDurationIsSpelledInMinutesAndSecondsAtEveryLength() {
        XCTAssertEqual(LandingPageCopy.duration(ms: 17 * 60_000 + 41_000), "17m 41s")
        XCTAssertEqual(LandingPageCopy.duration(ms: 3_600_000 + 5 * 60_000), "1h 05m")
    }

    /// A section's state after its title: what stopped it, in the timeline's own words.
    func testASectionsStateIsSaidAfterItsTitle() {
        XCTAssertEqual(LandingPageCopy.sectionState("CHECK_FAILED"), "not landed · CHECK_FAILED")
        XCTAssertEqual(LandingPageCopy.sectionState("CONFLICT"), "not landed · CONFLICT")
        XCTAssertEqual(LandingPageCopy.sectionState("ERROR"), "stopped · ERROR")
        XCTAssertEqual(LandingPageCopy.sectionState("CANCELLED"), "stopped")
        // A successful section says it in its own lines; the settled round wears no suffix.
        XCTAssertNil(LandingPageCopy.sectionState("RUNNING"))
        XCTAssertNil(LandingPageCopy.sectionState("MERGED"))
    }

    /// The check label both the card's budget and the timeline's live row wear.
    func testTheCheckLabelNamesTheTwoChecks() {
        XCTAssertEqual(LandingPageCopy.checkLabel("MERGE_CHECK"), "Merge check")
        XCTAssertEqual(LandingPageCopy.checkLabel("TASK_ACCEPTANCE"), "Task acceptance")
        XCTAssertEqual(LandingPageCopy.checkLabel(nil), "Task acceptance")
    }

    // MARK: - the terminal card

    func testAFailedCheckIsNamedWithItsExitAndDuration() {
        let view = landing {
            $0.currentAttempt = attempt { $0.state = "CHECK_FAILED" }
            $0.checks = [LandingCheckResult(name: "TASK_ACCEPTANCE", exitCode: 1,
                                            expectedExitCode: 0, timedOut: false,
                                            durationMs: 17 * 60_000 + 41_000)]
        }
        let card = LandingPageCopy.attemptCard(view, now: now, updatedAt: now)!
        XCTAssertEqual(card.state, "checks failed · exit 1 after 17m 41s")
        XCTAssertEqual(card.right, "Not landed")
        XCTAssertEqual(card.failure,
                       "Task acceptance exited 1 (expected 0) on the combined tree · nothing was pushed")
        XCTAssertFalse(card.running)
    }

    func testAnOfflinePlaceholderFreezesTheClockAndOpensNothing() throws {
        let inFlight = ProjectIntegrationInFlight(
            taskTitle: "Ledger migration order", state: "RUNNING", startedAt: at(14, 56, 40),
            kind: "LAND_TASK", phase: "CHECK", heartbeatAt: at(14, 58, 30), jobId: "job-1",
            taskId: "task-1", runner: "wikova", claim: 1, round: 1,
            check: ProjectIntegrationCheck(name: "MERGE_CHECK", index: 1, count: 3,
                                           budgetSeconds: 3_600, startedAt: step),
            liveness: "LIVE")
        let view = try XCTUnwrap(LandingPageCopy.offlinePlaceholder(
            sessionId: "landing-1", projectId: "project-1", inFlight: inFlight))
        XCTAssertEqual(view.sessionId, "landing-1")
        XCTAssertEqual(view.currentAttempt?.jobId, "job-1")
        let card = try XCTUnwrap(LandingPageCopy.attemptCard(
            view, now: now, updatedAt: nil, failed: true))
        XCTAssertEqual(card.state, "Update unavailable")
        XCTAssertEqual(card.detail, "Update unavailable")
        XCTAssertFalse(card.running)
        XCTAssertFalse(card.timedOut)
        XCTAssertEqual(LandingPageCopy.gates(view, now: now, updatedAt: nil, failed: true), .none)
        XCTAssertNil(LandingPageCopy.offlinePlaceholder(sessionId: "s", projectId: nil,
                                                         inFlight: nil))
    }

    func testAConflictAndAnErrorSayWhatStoppedThem() {
        let conflict = LandingPageCopy.attemptCard(
            landing { $0.currentAttempt = attempt { $0.state = "CONFLICT" } },
            now: now, updatedAt: now)!
        XCTAssertEqual(conflict.state, "Could not merge · conflict")
        let error = LandingPageCopy.attemptCard(
            landing { $0.currentAttempt = attempt { $0.state = "ERROR" } },
            now: now, updatedAt: now)!
        XCTAssertEqual(error.state, "Stopped with an error")
        XCTAssertEqual(error.failure, "Stopped with an error · nothing was pushed")
    }

    // MARK: - the timeline's ✓ reads the line's fields, not its sentence

    private func finished(_ data: [String: JSONValue]?,
                          text: String = "Merge check passed · 17m 02s") -> IntegrationTimelineEntry {
        var over: [String: Any] = ["kind": "CHECK_FINISHED", "phase": "CHECK", "text": text]
        if let data { over["data"] = data }
        return entry(over)
    }

    private func result(_ state: String?, _ text: String,
                        kind: String = "RESULT") -> IntegrationTimelineEntry {
        var over: [String: Any] = ["kind": kind, "text": text]
        if let state { over["data"] = ["state": JSONValue.string(state)] }
        return entry(over)
    }

    private func exitData(_ code: JSONValue, expected: Int = 0,
                          timedOut: Bool = false) -> [String: JSONValue] {
        ["exitCode": code, "expectedExitCode": .int(expected), "timedOut": .bool(timedOut)]
    }

    func testACheckPassedWhenItExitedWithTheCodeItExpectedAndDidNotTimeOut() {
        XCTAssertTrue(finished(exitData(.int(0))).checkPassed)
        XCTAssertTrue(finished(exitData(.int(3), expected: 3)).checkPassed)
        XCTAssertFalse(finished(exitData(.int(1))).checkPassed)
        XCTAssertFalse(finished(exitData(.int(0), timedOut: true)).checkPassed)
        // No exit code is not a pass, and neither is a line with no fields at all.
        XCTAssertFalse(finished(exitData(.null)).checkPassed)
        XCTAssertFalse(finished(nil).checkPassed)
        XCTAssertFalse(finished([:]).checkPassed)
    }

    func testTheWordingChangedTheCheckmarkDidNot() {
        let green = finished(exitData(.int(0)), text: "Merge check green · 17m 02s")
        XCTAssertTrue(green.checkPassed)
        XCTAssertTrue(green.succeeded(in: "LAND_TASK"))
        let saysPassed = finished(exitData(.int(1)), text: "Merge check passed · 3m 52s")
        XCTAssertFalse(saysPassed.checkPassed)
        XCTAssertFalse(saysPassed.succeeded(in: "LAND_TASK"))
        XCTAssertTrue(result("LANDED", "Put on main · 8ed0ea7").succeeded(in: "LAND_TASK"))
        XCTAssertTrue(result("ALREADY_LANDED", "Was on main · 8ed0ea7").succeeded(in: "LAND_TASK"))
        XCTAssertTrue(result("NOTHING_TO_LAND", "No commits to push").succeeded(in: "LAND_TASK"))
        XCTAssertTrue(result("NOTHING_TO_LAND", "Nothing to push · the branch carried no commits",
                             kind: "RESULT_FALLBACK").succeeded(in: "LAND_TASK"))
    }

    func testEveryOtherResultIsACrossWhateverABranchNameInItSays() {
        XCTAssertFalse(result("READY", "Ready to merge into fix/passed-x").succeeded(in: "LAND_TASK"))
        XCTAssertFalse(result("CONFLICT", "Could not sync main into fix/passed-x · merge conflict")
            .succeeded(in: "LAND_TASK"))
        XCTAssertFalse(result("CHECK_FAILED", "Check failed · nothing was pushed").succeeded(in: "LAND_TASK"))
        XCTAssertFalse(result("ERROR", "Stopped with an error · PUSH_FAILED").succeeded(in: "LAND_TASK"))
        XCTAssertFalse(result("CANCELLED", "Stopped · not landed").succeeded(in: "LAND_TASK"))
        XCTAssertFalse(result("SUPERSEDED", "Superseded · a newer attempt asks the same question")
            .succeeded(in: "LAND_TASK"))
        XCTAssertFalse(result(nil, "Landed on main · 8ed0ea7").succeeded(in: "LAND_TASK"))
        XCTAssertFalse(result(nil, "Landed on main · 8ed0ea7", kind: "RESULT_FALLBACK").succeeded(in: "LAND_TASK"))
    }

    /// The section's job kind decides beside the line's state, never the sentence: a merge check
    /// that ends READY passed, and a merge to main that answers READY handed the candidate back to
    /// be checked again (M-T12, J-T13). Web: `landingSession.test.ts`, the same cases.
    func testAMergeCheckThatEndsReadyPassedAndAMergeThatAnswersReadyDidNot() {
        XCTAssertTrue(result("READY", "Ready to merge into main").succeeded(in: "CHECK_PROMOTION"))
        XCTAssertTrue(result("READY", "Ready to merge into main", kind: "RESULT_FALLBACK")
            .succeeded(in: "CHECK_PROMOTION"))
        XCTAssertTrue(result("READY", "Checked · the merge is yours to make").succeeded(in: "CHECK_PROMOTION"))
        XCTAssertFalse(result("READY", "Ready to merge into main").succeeded(in: "LAND_PROMOTION"))
        XCTAssertFalse(result("READY", "Ready to merge into main").succeeded(in: "LAND_TASK"))
        XCTAssertTrue(result("ALREADY_LANDED", "Already on main · 8ed0ea7").succeeded(in: "CHECK_PROMOTION"))
        XCTAssertFalse(result("CHECK_FAILED", "Check failed · nothing was pushed").succeeded(in: "CHECK_PROMOTION"))
        XCTAssertFalse(result("CONFLICT", "Could not merge · conflict").succeeded(in: "CHECK_PROMOTION"))
        XCTAssertFalse(result(nil, "Ready to merge into main").succeeded(in: "CHECK_PROMOTION"))
    }

    func testNoOtherKindOfLineIsACheckOrAResult() {
        XCTAssertFalse(entry(["kind": "RESULT", "data": exitData(.int(0))]).checkPassed)
        XCTAssertFalse(entry(["kind": "CLAIMED", "data": ["state": JSONValue.string("LANDED")],
                              "text": "Landed on main"]).succeeded(in: "LAND_TASK"))
        XCTAssertFalse(entry(["kind": "CLAIMED", "data": ["state": JSONValue.string("READY")],
                              "text": "Ready"]).succeeded(in: "CHECK_PROMOTION"))
    }
}
