import Foundation
import XCTest
@testable import OrbitKit

/// The card, the Following rows and the session header all read a watch through `WatchProjection`:
/// who is watched, for what, how fresh the reading is, and what happens when the condition holds.
final class WatchProjectionTests: XCTestCase {
    private typealias F = WatchFixture
    private let now = WatchFixture.now

    // MARK: progress

    func testProgressCountsMetAgainstTheTargetsStillInTheSet() {
        let watch = F.watch(targets: F.tasks(7, met: 3) + [F.target("G", state: "GONE")])
        let progress = WatchProgress(watch.targets)
        XCTAssertEqual([progress.met, progress.live, progress.gone], [3, 7, 1])
        // A deleted target leaves the set and is never counted as met (contract §4).
        XCTAssertEqual(WatchProjection.progress(for: watch), "3 of 7 finished · 1 gone")
    }

    func testProgressUsesTheConditionsOwnVerbOrMetForSeveralLeaves() {
        // The four targets this ANY covers are not its denominator: one settles it, so the line counts
        // the verb's totals only (the thresholds below).
        XCTAssertEqual(WatchProjection.progress(for: F.watch(predicate: F.any("TASK_FAILED"),
                                                             targets: F.tasks(4, met: 1))), "1 failed")
        XCTAssertEqual(WatchProjection.progress(for: F.watch(predicate: F.all("TASK_DONE"),
                                                             targets: F.tasks(2, met: 2))), "2 of 2 done")
        let sessions = [F.target("S2", kind: "SESSION", state: "SATISFIED"), F.target("S3", kind: "SESSION")]
        XCTAssertEqual(WatchProjection.progress(for: F.watch(predicate: F.all("SESSION_TURN_SETTLED"),
                                                             targets: sessions)), "1 of 2 finished their turn")
        // "All of these finish, or any one fails" names two leaves for one set of targets, and is
        // what `task_await` sends by default — so it was the commonest wait on screen and read as
        // the vaguest. A failed task has finished, so it counts in the same verb as one leaf would.
        let orAnyFails: [String: Any] = ["kind": "ANY_OF",
                                         "operands": [F.all("TASK_TERMINAL"), F.any("TASK_FAILED")]]
        XCTAssertEqual(WatchProjection.progress(for: F.watch(predicate: orAnyFails, targets: F.tasks(7, met: 3))),
                       "3 of 7 finished")
        // Two leaves that genuinely say different things still count in the neutral word: a session
        // satisfied by needing attention has not finished its turn.
        let settledOrAsking: [String: Any] = ["kind": "ANY_OF",
                                              "operands": [F.all("SESSION_TURN_SETTLED"),
                                                           F.any("SESSION_NEEDS_ATTENTION")]]
        let watched = [F.target("S2", kind: "SESSION", state: "SATISFIED"), F.target("S3", kind: "SESSION")]
        XCTAssertEqual(WatchProjection.progress(for: F.watch(predicate: settledOrAsking, targets: watched)),
                       "1 of 2 met")
    }

    /// The denominator is the threshold the condition sets, not the targets it covers: an ANY watch is
    /// done after one target, so the four it reads are not what it is waiting for, and the count is left
    /// off entirely when one is all it takes (web's `describeProgress`).
    func testProgressTakesItsDenominatorFromTheConditionsThreshold() {
        // (a) ANY over four tasks, none met: one target settles it, so there is no "of 4" to show.
        let any = F.watch(predicate: F.any("TASK_TERMINAL"), targets: F.tasks(4))
        XCTAssertFalse(WatchProjection.progress(for: any).contains("of 4"),
                       WatchProjection.progress(for: any))
        XCTAssertEqual(WatchProjection.progress(for: any), "0 finished")

        // (b) ALL: every target it reads is what it is waiting for.
        XCTAssertEqual(WatchProjection.progress(for: F.watch(predicate: F.all("TASK_TERMINAL"),
                                                             targets: F.tasks(4, met: 2))),
                       "2 of 4 finished")

        // (c) A composite names no one leaf to read a threshold from, so it asks for the whole set — the
        // reading progress had before it looked at the predicate — and reading it never throws.
        for kind in ["ANY_OF", "ALL_OF"] {
            let composite: [String: Any] = ["kind": kind,
                                            "operands": [F.all("TASK_TERMINAL"), F.any("TASK_FAILED")]]
            let text = WatchProjection.progress(for: F.watch(predicate: composite, targets: F.tasks(4, met: 2)))
            XCTAssertTrue(text.contains("of 4"), text)
        }

        // Zero targets keep the count they had — 0 is not a threshold of one to leave off.
        XCTAssertEqual(WatchProjection.progress(for: F.watch(targets: [])), "0 of 0 finished")
    }

    /// A quorum is a shape this build cannot read, and that is a fact about the model rather than a gap
    /// in this reading of it: `WatchPredicate.version` is 1, its cases are `.all/.any/.allOf/.anyOf/
    /// .unknown`, and `AT_LEAST` is predicateVersion 2's — so it decodes to `.unknown("AT_LEAST")`, which
    /// carries the kind alone and **no count**. There is no threshold to read out of it even in principle,
    /// so the whole set is the only denominator there is, and a client that one day reads v2 has to widen
    /// the model first. Web, which reads v2, prints the quorum's own count for the same watch instead.
    func testAQuorumThisBuildCannotReadFallsBackToTheWholeSet() throws {
        let quorum: [String: Any] = ["kind": "AT_LEAST", "count": 2, "over": "ALL_TARGETS",
                                     "leaf": "TASK_TERMINAL"]
        let data = try JSONSerialization.data(withJSONObject: quorum)
        XCTAssertEqual(try JSONDecoder().decode(WatchPredicate.self, from: data), .unknown("AT_LEAST"))

        let watch = F.watch(predicate: quorum, targets: F.tasks(4, met: 1))
        XCTAssertEqual(watch.predicate, .unknown("AT_LEAST"))
        XCTAssertEqual(WatchProjection.progress(for: watch), "1 of 4 met")
    }

    // MARK: headline

    func testHeadlineSaysWatchingWhileActiveAndNamesEveryEnd() {
        let cases: [(String, String)] = [
            ("ACTIVE", "Watching 7 targets"),
            ("PAUSED", "Paused · 7 targets"),
            ("MATCHED", "Matched"),
            ("EXPIRED", "Expired"),
            ("CANCELLED", "Stopped"),
            ("REVOKED", "Access revoked"),
            ("UNRESOLVABLE", "Every target is gone"),
            ("SNOOZED", "Unknown state"),
        ]
        for (state, expected) in cases {
            XCTAssertEqual(WatchProjection.headline(for: F.watch(state: state, targets: F.tasks(7))), expected, state)
        }
        XCTAssertEqual(WatchProjection.headline(for: F.watch(targets: F.tasks(1))), "Watching 1 target")
    }

    /// A watch is not a process, and nothing it says may borrow that tray's vocabulary (contract §9.2).
    func testNoWatchCopyReadsAsABackgroundProcess() {
        for state in ["ACTIVE", "PAUSED", "MATCHED", "EXPIRED", "CANCELLED", "REVOKED", "UNRESOLVABLE"] {
            let watch = F.watch(state: state, targets: F.tasks(3, met: 1))
            let copy = [WatchProjection.headline(for: watch), WatchProjection.progress(for: watch),
                        WatchProjection.lastEvaluated(for: watch, now: now)].joined(separator: " ")
            XCTAssertFalse(copy.lowercased().contains("background"), copy)
            XCTAssertFalse(copy.lowercased().contains("process"), copy)
        }
    }

    // MARK: condition

    func testConditionReadsAsASentence() {
        XCTAssertEqual(WatchProjection.condition(.all(.taskTerminal), targetCount: 7), "All tasks finish")
        XCTAssertEqual(WatchProjection.condition(.any(.taskFailed), targetCount: 7), "Any task fails")
        XCTAssertEqual(WatchProjection.condition(.anyOf([.all(.taskTerminal), .any(.taskFailed)]), targetCount: 7),
                       "All tasks finish, or any task fails")
        XCTAssertEqual(WatchProjection.condition(.allOf([.all(.sessionTurnSettled), .any(.sessionNeedsAttention)]),
                                                 targetCount: 3),
                       "All sessions finish their turn and any session needs attention")
        XCTAssertEqual(WatchProjection.condition(.all(.sessionRunTerminal), targetCount: 2), "All sessions end their run")
        XCTAssertEqual(WatchProjection.condition(.all(.sessionLifecycleTerminal), targetCount: 2),
                       "All sessions are completed or trashed")
        XCTAssertEqual(WatchProjection.condition(.all(.taskDone), targetCount: 2), "All tasks are done")
    }

    func testConditionOverOneTargetNamesIt() {
        XCTAssertEqual(WatchProjection.condition(.all(.taskDone), targetCount: 1), "The task is done")
        XCTAssertEqual(WatchProjection.condition(.any(.sessionNeedsAttention), targetCount: 1),
                       "The session needs attention")
    }

    func testAConditionThisBuildCantReadSaysSo() {
        XCTAssertEqual(WatchProjection.condition(.unknown("NONE_OF"), targetCount: 2),
                       "A condition this version of Orbit can't show")
        XCTAssertEqual(WatchProjection.condition(.all(.unknown), targetCount: 2),
                       "A condition this version of Orbit can't show")
    }

    // MARK: action, freshness, deadline

    func testActionNamesWhatHappensOnAMatch() {
        XCTAssertEqual(WatchProjection.action(for: F.watch(action: "NOTIFY_USER", observer: nil), observerTitle: nil),
                       "Notify you")
        XCTAssertEqual(WatchProjection.action(for: F.watch(), observerTitle: "Coordinator: release"),
                       "Resume Coordinator: release")
        XCTAssertEqual(WatchProjection.action(for: F.watch(), observerTitle: nil), "Resume the waiting session")
    }

    /// The watch's own last look, never a turn's timestamp.
    func testLastEvaluatedReadsTheEvaluatorsLook() {
        XCTAssertEqual(WatchProjection.lastEvaluated(for: F.watch(lastEvaluatedAt: F.ago(20)), now: now),
                       "Last evaluated just now")
        XCTAssertEqual(WatchProjection.lastEvaluated(for: F.watch(lastEvaluatedAt: F.ago(240)), now: now),
                       "Last evaluated 4m ago")
        XCTAssertEqual(WatchProjection.lastEvaluated(for: F.watch(lastEvaluatedAt: nil), now: now),
                       "Not evaluated yet")
    }

    func testFreshnessFlagsAnActiveWatchNobodyHasLookedAtInThreeMinutes() {
        XCTAssertEqual(WatchFreshness.of(F.watch(lastEvaluatedAt: F.ago(60)), now: now), .fresh)
        XCTAssertEqual(WatchFreshness.of(F.watch(lastEvaluatedAt: F.ago(181)), now: now), .stale)
        XCTAssertEqual(WatchFreshness.of(F.watch(lastEvaluatedAt: nil, createdAt: F.ago(30)), now: now), .pending)
        XCTAssertEqual(WatchFreshness.of(F.watch(lastEvaluatedAt: nil, createdAt: F.ago(600)), now: now), .stale)
        // Paused and ended watches aren't evaluated by design, however old their last look.
        XCTAssertEqual(WatchFreshness.of(F.watch(state: "PAUSED", lastEvaluatedAt: F.ago(9_000)), now: now), .idle)
        XCTAssertEqual(WatchFreshness.of(F.watch(state: "MATCHED", lastEvaluatedAt: F.ago(9_000)), now: now), .idle)
    }

    /// The browser's `formatSpan`, value for value: the smaller unit is said while the larger one is
    /// still small, so 3h20m and 3h59m are not both "3h". `WatchWakeCopyParityTests` holds this to
    /// the browser's own declaration; these are the values that reading comes to.
    func testASpanSaysItsSmallerUnitWhileTheLargerOneIsStillSmall() {
        XCTAssertEqual(WatchProjection.duration(3 * 3_600 + 20 * 60), "3h 20m")
        XCTAssertEqual(WatchProjection.duration(2 * 86_400 + 4 * 3_600), "2d 4h")
        XCTAssertEqual(WatchProjection.duration(23 * 3_600), "23h")
        XCTAssertEqual(WatchProjection.duration(12 * 86_400), "12d")
        // Dropped once the larger unit is big enough to stand alone, and when there is no remainder.
        XCTAssertEqual(WatchProjection.duration(6 * 3_600 + 20 * 60), "6h")
        XCTAssertEqual(WatchProjection.duration(3 * 86_400 + 4 * 3_600), "3d")
        XCTAssertEqual(WatchProjection.duration(3_600), "1h")
        XCTAssertEqual(WatchProjection.duration(40), "40s")
        XCTAssertEqual(WatchProjection.duration(12 * 60), "12m")
        // A deadline this second, or one the server's clock puts just behind us, is not "0s".
        XCTAssertEqual(WatchProjection.duration(0.4), "1s")
        XCTAssertEqual(WatchProjection.duration(-5), "1s")
    }

    func testDeadlineCountsDownWhileLiveAndDatesAnExpiry() {
        XCTAssertEqual(WatchProjection.deadline(for: F.watch(expiresAt: F.ago(-(23 * 3_600 + 60))), now: now),
                       "Expires in 23h")
        XCTAssertEqual(WatchProjection.deadline(for: F.watch(expiresAt: F.ago(-(3 * 3_600 + 20 * 60))),
                                                now: now), "Expires in 3h 20m")
        XCTAssertEqual(WatchProjection.deadline(for: F.watch(state: "PAUSED", expiresAt: F.ago(-300)), now: now),
                       "Expires in 5m")
        XCTAssertEqual(WatchProjection.deadline(for: F.watch(expiresAt: F.ago(5)), now: now), "Expiring now")
        XCTAssertEqual(WatchProjection.deadline(for: F.watch(state: "EXPIRED", expiresAt: F.ago(7_200)), now: now),
                       "Expired 2h ago")
        XCTAssertNil(WatchProjection.deadline(for: F.watch(state: "MATCHED"), now: now))
    }

    // MARK: deliveries, attention, sections

    func testDeliveryStatusReadsTheLatestDelivery() {
        func status(_ delivery: [String: Any]) -> String? {
            WatchProjection.deliveryStatus(for: F.watch(state: "MATCHED", matches: [F.match(deliveries: [delivery])]))
        }
        XCTAssertNil(WatchProjection.deliveryStatus(for: F.watch()))
        XCTAssertEqual(status(F.delivery("PENDING")), "Delivering")
        XCTAssertEqual(status(F.delivery("IN_FLIGHT")), "Delivering")
        XCTAssertEqual(status(F.delivery("PENDING", attempts: 3)), "Delivery retrying · 3 of 8 attempts failed")
        XCTAssertEqual(status(F.delivery("DELIVERED")), "Resume queued")
        XCTAssertEqual(status(F.delivery("DELIVERED", action: "NOTIFY_USER")), "Notification sent")
        XCTAssertEqual(status(F.delivery("DEAD_LETTER", lastError: "OBSERVER_SESSION_ENDED: ended")),
                       "Delivery failed: OBSERVER_SESSION_ENDED: ended")
        // An unmatched end's delivery reads the same way.
        let expired = F.watch(state: "EXPIRED", endDeliveries: [F.end("EXPIRY", delivery: F.delivery("DELIVERED"))])
        XCTAssertEqual(WatchProjection.deliveryStatus(for: expired), "Resume queued")
    }

    func testAttentionCollectsEveryReasonAWatchCantGoOnQuietly() {
        XCTAssertEqual(WatchProjection.attention(for: F.watch(), now: now), [])
        let deadLetter = F.watch(state: "MATCHED",
                                 matches: [F.match(deliveries: [F.delivery("DEAD_LETTER", lastError: "boom")])])
        XCTAssertEqual(WatchProjection.attention(for: deadLetter, now: now), [.deliveryFailed("boom")])
        let retrying = F.watch(state: "MATCHED", matches: [F.match(deliveries: [F.delivery("PENDING", attempts: 2)])])
        XCTAssertEqual(WatchProjection.attention(for: retrying, now: now), [.deliveryRetrying(failedAttempts: 2)])
        XCTAssertEqual(WatchProjection.attention(for: F.watch(state: "REVOKED"), now: now), [.revoked])
        XCTAssertEqual(WatchProjection.attention(for: F.watch(state: "UNRESOLVABLE"), now: now), [.unresolvable])
        XCTAssertEqual(WatchProjection.attention(for: F.watch(lastEvaluatedAt: F.ago(600)), now: now), [.stale])
        // An end's dead letter counts as much as a Match's.
        let endFailed = F.watch(state: "REVOKED",
                                endDeliveries: [F.end("REVOKED", delivery: F.delivery("DEAD_LETTER"))])
        XCTAssertEqual(WatchProjection.attention(for: endFailed, now: now), [.deliveryFailed(nil), .revoked])
        XCTAssertEqual(WatchAttention.deliveryFailed(nil).text, "Delivery failed")
    }

    func testSectionsPutAttentionFirstThenLiveThenHistoryInArrivalOrder() {
        let active = F.watch(id: "A1")
        let paused = F.watch(id: "P1", state: "PAUSED")
        let matched = F.watch(id: "H1", state: "MATCHED", matches: [F.match(deliveries: [F.delivery("DELIVERED")])])
        let cancelled = F.watch(id: "H2", state: "CANCELLED")
        let expired = F.watch(id: "H3", state: "EXPIRED")
        let revoked = F.watch(id: "N1", state: "REVOKED")
        let stale = F.watch(id: "N2", lastEvaluatedAt: F.ago(900))
        let sections = WatchProjection.sections([matched, active, revoked, paused, cancelled, stale, expired], now: now)
        XCTAssertEqual(sections.map { $0.group }, [.needsAttention, .active, .history])
        XCTAssertEqual(sections.map { $0.watches.map(\.id) }, [["N1", "N2"], ["A1", "P1"], ["H1", "H2", "H3"]])
        XCTAssertEqual(WatchGroup.allCases.map(\.title), ["Needs attention", "Active", "History"])
        XCTAssertTrue(WatchProjection.sections([], now: now).isEmpty)
    }

    // MARK: index

    func testFindsAWatchByEitherSpellingOfItsId() throws {
        let publicID = PublicID.newToken()
        let uuid = try XCTUnwrap(PublicID.toUUID(publicID))
        let watch = F.watch(id: publicID)
        // A push names the watch by its UUID.
        XCTAssertEqual(WatchIndex.find(uuid, in: [F.watch(id: "other"), watch])?.id, publicID)
        XCTAssertNil(WatchIndex.find(PublicID.newToken(), in: [watch]))
    }

    func testMergeKeepsEachWatchOnceNewestFirst() {
        let old = F.watch(id: "OLD", createdAt: F.ago(9_000))
        let mid = F.watch(id: "MID", state: "PAUSED", createdAt: F.ago(5_000))
        let new = F.watch(id: "NEW", createdAt: F.ago(10))
        XCTAssertEqual(WatchIndex.merge([[new, old], [mid], [new, mid, old]]).map(\.id), ["NEW", "MID", "OLD"])
    }

    func testReplacingSwapsTheOlderCopyInPlaceOrAddsItFirst() {
        let a = F.watch(id: "A")
        let b = F.watch(id: "B")
        XCTAssertEqual(WatchIndex.replacing(F.watch(id: "B", state: "PAUSED"), in: [a, b]).map(\.state),
                       [.active, .paused])
        XCTAssertEqual(WatchIndex.replacing(F.watch(id: "C"), in: [a, b]).map(\.id), ["C", "A", "B"])
    }

    // MARK: failures

    func testFailureMessagesSayWhatTheServerSaid() {
        let refusal = APIError.http(status: 400,
                                    body: #"{"code":"TTL_OUT_OF_RANGE","kind":"REFUSAL","message":"ttlSeconds is between 60 and 2592000"}"#)
        XCTAssertEqual(WatchProjection.failureMessage(refusal, verb: "save"),
                       "Couldn't save the watch — ttlSeconds is between 60 and 2592000.")
        let ended = APIError.http(status: 409, body: #"{"message":"a MATCHED watch cannot be paused","state":"MATCHED"}"#)
        XCTAssertEqual(WatchProjection.failureMessage(ended, verb: "pause"),
                       "Couldn't pause the watch — a MATCHED watch cannot be paused.")
        XCTAssertEqual(WatchProjection.failureMessage(APIError.http(status: 404, body: nil), verb: "stop"),
                       "Couldn't stop the watch — it no longer exists.")
        XCTAssertEqual(WatchProjection.failureMessage(URLError(.notConnectedToInternet), verb: "resume"),
                       "Couldn't resume the watch — the connection dropped.")
    }

    // MARK: history and stopping

    func testHistoryNamesEachDeliveryAndHowAnUnmatchedWatchEnded() {
        func deadLetter(_ lastError: String) -> WatchDelivery {
            F.watch(state: "MATCHED", matches: [F.match(deliveries: [F.delivery("DEAD_LETTER", lastError: lastError)])])
                .matches[0].deliveries[0]
        }
        // A wake taken back before it ran says so; one an interrupt swept off the queue never reached anybody.
        XCTAssertEqual(WatchProjection.deliveryStatus(deadLetter("WAKE_WITHDRAWN: x")), "Wake withdrawn")
        XCTAssertEqual(WatchProjection.deliveryStatus(deadLetter("OBSERVER_TURN_INTERRUPTED: x")),
                       "Delivery failed: OBSERVER_TURN_INTERRUPTED: x")
        XCTAssertEqual(WatchProjection.endTitle(.expiry), "Expired before it matched")
        XCTAssertEqual(WatchProjection.endTitle(.revoked), "Stopped: access to its targets was revoked")
        XCTAssertEqual(WatchProjection.endTitle(.unresolvable), "Stopped: every target was deleted")
    }

    /// Two rows a real apiserver sent: a Match whose queued wake was withdrawn before it ran, and one whose wake was
    /// refused because its observer changed owner. Only the second is somebody's to look at.
    func testAWithdrawnWakeIsHistoryWhileADeadLetterThatFailedStillNeedsAttention() {
        let withdrawn = F.server(F.withdrawnWakeJSON)
        XCTAssertEqual(WatchProjection.attention(for: withdrawn, now: now), [])
        XCTAssertEqual(WatchProjection.group(of: withdrawn, now: now), .history)
        // Still shown, in plain words.
        XCTAssertEqual(WatchProjection.deliveryStatus(for: withdrawn), "Wake withdrawn")

        let revoked = F.server(F.permissionRevokedJSON)
        XCTAssertEqual(WatchProjection.attention(for: revoked, now: now), [.deliveryFailed(
            "PERMISSION_REVOKED: the observer session no longer belongs to the watch's owner, so it was not woken")])
        XCTAssertEqual(WatchProjection.sections([withdrawn, revoked], now: now).map { $0.watches.map(\.id) },
                       [[revoked.id], [withdrawn.id]])
    }

    /// Stop is the one end nobody is told about (contract §3), so the confirmation says so first.
    func testStopWarningSaysWhoWontBeTold() {
        XCTAssertEqual(WatchProjection.stopWarning(for: F.watch()),
                       "The waiting session won't be resumed, and it isn't told the watch stopped.")
        XCTAssertEqual(WatchProjection.stopWarning(for: F.watch(action: "NOTIFY_USER", observer: nil)),
                       "You won't be notified when the condition holds.")
    }
}
