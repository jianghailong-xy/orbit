package io.orbitd.android.watch

import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.NetworkException
import io.orbitd.android.core.protocol.ProtocolException
import io.orbitd.android.navigation.ObjectId
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.ZoneOffset

/** Following rows, a watch's page and the session's strip all read a watch through `WatchProjection` (OrbitKit
 * `WatchProjectionTests`, and the summary half of `SessionWatchingTests`). */
class WatchProjectionTest {
    private val f = WatchFixture
    private val now = WatchFixture.now

    // MARK: progress

    @Test fun progressCountsMetAgainstTheTargetsStillInTheSet() {
        val watch = f.watch(targets = f.tasks(7, met = 3) + f.target("G", state = "GONE"))
        assertEquals(WatchProgress(met = 3, live = 7, gone = 1), WatchProgress.of(watch.targets))
        // A deleted target leaves the set and is never counted as met (contract §4).
        assertEquals("3 of 7 finished · 1 gone", WatchProjection.progress(watch))
    }

    @Test fun progressUsesTheConditionsOwnVerbOrMetForSeveralLeaves() {
        assertEquals("1 failed", WatchProjection.progress(f.watch(predicate = f.any("TASK_FAILED"), targets = f.tasks(4, met = 1))))
        assertEquals("2 of 2 done", WatchProjection.progress(f.watch(predicate = f.all("TASK_DONE"), targets = f.tasks(2, met = 2))))
        val sessions = listOf(f.target("S2", kind = "SESSION", state = "SATISFIED"), f.target("S3", kind = "SESSION"))
        assertEquals("1 of 2 finished their turn", WatchProjection.progress(f.watch(predicate = f.all("SESSION_TURN_SETTLED"), targets = sessions)))
        // "All of these finish, or any one fails": a failed task has finished, so it counts in the same verb.
        val orAnyFails = f.composite("ANY_OF", f.all("TASK_TERMINAL"), f.any("TASK_FAILED"))
        assertEquals("3 of 7 finished", WatchProjection.progress(f.watch(predicate = orAnyFails, targets = f.tasks(7, met = 3))))
        // Two leaves that genuinely say different things still count in the neutral word.
        val settledOrAsking = f.composite("ANY_OF", f.all("SESSION_TURN_SETTLED"), f.any("SESSION_NEEDS_ATTENTION"))
        assertEquals("1 of 2 met", WatchProjection.progress(f.watch(predicate = settledOrAsking, targets = sessions)))
    }

    /** The denominator is the threshold the condition sets, not the targets it covers. */
    @Test fun progressTakesItsDenominatorFromTheConditionsThreshold() {
        val any = f.watch(predicate = f.any("TASK_TERMINAL"), targets = f.tasks(4))
        assertFalse(WatchProjection.progress(any).contains("of 4"))
        assertEquals("0 finished", WatchProjection.progress(any))
        assertEquals("2 of 4 finished", WatchProjection.progress(f.watch(predicate = f.all("TASK_TERMINAL"), targets = f.tasks(4, met = 2))))
        listOf("ANY_OF", "ALL_OF").forEach { kind ->
            val text = WatchProjection.progress(f.watch(predicate = f.composite(kind, f.all("TASK_TERMINAL"), f.any("TASK_FAILED")), targets = f.tasks(4, met = 2)))
            assertTrue(text, text.contains("of 4"))
        }
        // Zero targets keep the count they had — 0 is not a threshold of one to leave off.
        assertEquals("0 of 0 finished", WatchProjection.progress(f.watch(targets = emptyList())))
    }

    /** A quorum is predicateVersion 2's, a term this build cannot read: there is no threshold to read out of it, so
     * the whole set is the only denominator there is. */
    @Test fun aQuorumThisBuildCannotReadFallsBackToTheWholeSet() {
        val quorum = buildJsonObject { put("kind", "AT_LEAST"); put("count", 2); put("over", "ALL_TARGETS"); put("leaf", "TASK_TERMINAL") }
        assertEquals(WatchPredicate.Unknown("AT_LEAST"), WatchPredicate.decode(quorum))
        val watch = f.watch(predicate = quorum, targets = f.tasks(4, met = 1))
        assertEquals(WatchPredicate.Unknown("AT_LEAST"), watch.predicate)
        assertEquals("1 of 4 met", WatchProjection.progress(watch))
    }

    // MARK: headline

    @Test fun headlineSaysWatchingWhileActiveAndNamesEveryEnd() {
        listOf("ACTIVE" to "Watching 7 targets", "PAUSED" to "Paused · 7 targets", "MATCHED" to "Matched", "EXPIRED" to "Expired",
            "CANCELLED" to "Stopped", "REVOKED" to "Access revoked", "UNRESOLVABLE" to "Every target is gone", "SNOOZED" to "Unknown state",
        ).forEach { (state, expected) -> assertEquals(state, expected, WatchProjection.headline(f.watch(state = state, targets = f.tasks(7)))) }
        assertEquals("Watching 1 target", WatchProjection.headline(f.watch(targets = f.tasks(1))))
    }

    /** A watch is not a process, and nothing it says may borrow that tray's vocabulary (contract §9.2). */
    @Test fun noWatchCopyReadsAsABackgroundProcess() {
        listOf("ACTIVE", "PAUSED", "MATCHED", "EXPIRED", "CANCELLED", "REVOKED", "UNRESOLVABLE").forEach { state ->
            val watch = f.watch(state = state, targets = f.tasks(3, met = 1))
            val copy = listOf(WatchProjection.headline(watch), WatchProjection.progress(watch), WatchProjection.lastEvaluated(watch, now)).joinToString(" ")
            assertFalse(copy, copy.lowercase().contains("background"))
            assertFalse(copy, copy.lowercase().contains("process"))
        }
    }

    // MARK: condition

    @Test fun conditionReadsAsASentence() {
        fun all(leaf: WatchLeaf) = WatchPredicate.All(leaf)
        fun any(leaf: WatchLeaf) = WatchPredicate.Any(leaf)
        assertEquals("All tasks finish", WatchProjection.condition(all(WatchLeaf.TASK_TERMINAL), 7))
        assertEquals("Any task fails", WatchProjection.condition(any(WatchLeaf.TASK_FAILED), 7))
        assertEquals("All tasks finish, or any task fails",
            WatchProjection.condition(WatchPredicate.AnyOf(listOf(all(WatchLeaf.TASK_TERMINAL), any(WatchLeaf.TASK_FAILED))), 7))
        assertEquals("All sessions finish their turn and any session needs attention",
            WatchProjection.condition(WatchPredicate.AllOf(listOf(all(WatchLeaf.SESSION_TURN_SETTLED), any(WatchLeaf.SESSION_NEEDS_ATTENTION))), 3))
        assertEquals("All sessions end their run", WatchProjection.condition(all(WatchLeaf.SESSION_RUN_TERMINAL), 2))
        assertEquals("All sessions are completed or trashed", WatchProjection.condition(all(WatchLeaf.SESSION_LIFECYCLE_TERMINAL), 2))
        assertEquals("All tasks are done", WatchProjection.condition(all(WatchLeaf.TASK_DONE), 2))
        // Nested composites say their parts in brackets.
        assertEquals("All tasks finish, or (any task fails and any task is done)", WatchProjection.condition(WatchPredicate.AnyOf(listOf(
            all(WatchLeaf.TASK_TERMINAL), WatchPredicate.AllOf(listOf(any(WatchLeaf.TASK_FAILED), any(WatchLeaf.TASK_DONE))))), 2))
    }

    @Test fun conditionOverOneTargetNamesIt() {
        assertEquals("The task is done", WatchProjection.condition(WatchPredicate.All(WatchLeaf.TASK_DONE), 1))
        assertEquals("The session needs attention", WatchProjection.condition(WatchPredicate.Any(WatchLeaf.SESSION_NEEDS_ATTENTION), 1))
    }

    @Test fun aConditionThisBuildCantReadSaysSo() {
        assertEquals("A condition this version of Orbit can't show", WatchProjection.condition(WatchPredicate.Unknown("NONE_OF"), 2))
        assertEquals("A condition this version of Orbit can't show", WatchProjection.condition(WatchPredicate.All(WatchLeaf.UNKNOWN), 2))
    }

    // MARK: action, freshness, deadline

    @Test fun actionNamesWhatHappensOnAMatch() {
        assertEquals("Notify you", WatchProjection.action(f.watch(action = "NOTIFY_USER", observer = null), null))
        assertEquals("Resume Coordinator: release", WatchProjection.action(f.watch(), "Coordinator: release"))
        assertEquals("Resume the waiting session", WatchProjection.action(f.watch(), null))
        assertEquals("Resume the waiting session", WatchProjection.action(f.watch(), ""))
    }

    /** The watch's own last look, never a turn's timestamp. */
    @Test fun lastEvaluatedReadsTheEvaluatorsLook() {
        assertEquals("Last evaluated just now", WatchProjection.lastEvaluated(f.watch(lastEvaluatedAt = f.ago(20)), now))
        assertEquals("Last evaluated 4m ago", WatchProjection.lastEvaluated(f.watch(lastEvaluatedAt = f.ago(240)), now))
        assertEquals("Not evaluated yet", WatchProjection.lastEvaluated(f.watch(lastEvaluatedAt = null), now))
    }

    @Test fun relativeTimeIsTheTranscriptsWords() {
        assertEquals("just now", WatchTime.format(f.ago(59), now))
        assertEquals("1m ago", WatchTime.format(f.ago(60), now))
        assertEquals("3h ago", WatchTime.format(f.ago(3 * 3_600 + 1_000), now))
        assertEquals("2d ago", WatchTime.format(f.ago(2 * 86_400 + 5), now))
        assertEquals("3w ago", WatchTime.format(f.ago(3 * 604_800), now))
        // Older than four weeks: the day it was, `M/d`.
        assertEquals("8/1", WatchTime.format("2026-08-01T12:00:00Z", now, ZoneOffset.UTC))
        assertNull(WatchTime.format("not a date", now))
        assertEquals(WatchTime.parse("2026-09-14T09:59:00Z"), WatchTime.parse("2026-09-14T09:59:00.000Z"))
    }

    @Test fun freshnessFlagsAnActiveWatchNobodyHasLookedAtInThreeMinutes() {
        assertEquals(WatchFreshness.FRESH, WatchFreshness.of(f.watch(lastEvaluatedAt = f.ago(60)), now))
        assertEquals(WatchFreshness.STALE, WatchFreshness.of(f.watch(lastEvaluatedAt = f.ago(181)), now))
        assertEquals(WatchFreshness.PENDING, WatchFreshness.of(f.watch(lastEvaluatedAt = null, createdAt = f.ago(30)), now))
        assertEquals(WatchFreshness.STALE, WatchFreshness.of(f.watch(lastEvaluatedAt = null, createdAt = f.ago(600)), now))
        // Paused and ended watches aren't evaluated by design, however old their last look.
        assertEquals(WatchFreshness.IDLE, WatchFreshness.of(f.watch(state = "PAUSED", lastEvaluatedAt = f.ago(9_000)), now))
        assertEquals(WatchFreshness.IDLE, WatchFreshness.of(f.watch(state = "MATCHED", lastEvaluatedAt = f.ago(9_000)), now))
    }

    /** The browser's `formatSpan`, value for value. */
    @Test fun aSpanSaysItsSmallerUnitWhileTheLargerOneIsStillSmall() {
        assertEquals("3h 20m", WatchProjection.duration(3 * 3_600.0 + 20 * 60))
        assertEquals("2d 4h", WatchProjection.duration(2 * 86_400.0 + 4 * 3_600))
        assertEquals("23h", WatchProjection.duration(23 * 3_600.0))
        assertEquals("12d", WatchProjection.duration(12 * 86_400.0))
        assertEquals("6h", WatchProjection.duration(6 * 3_600.0 + 20 * 60))
        assertEquals("3d", WatchProjection.duration(3 * 86_400.0 + 4 * 3_600))
        assertEquals("1h", WatchProjection.duration(3_600.0))
        assertEquals("40s", WatchProjection.duration(40.0))
        assertEquals("12m", WatchProjection.duration(12 * 60.0))
        // A deadline this second, or one the server's clock puts just behind us, is not "0s".
        assertEquals("1s", WatchProjection.duration(0.4))
        assertEquals("1s", WatchProjection.duration(-5.0))
    }

    @Test fun deadlineCountsDownWhileLiveAndDatesAnExpiry() {
        assertEquals("Expires in 23h", WatchProjection.deadline(f.watch(expiresAt = f.ago(-(23 * 3_600 + 60))), now))
        assertEquals("Expires in 3h 20m", WatchProjection.deadline(f.watch(expiresAt = f.ago(-(3 * 3_600 + 20 * 60))), now))
        assertEquals("Expires in 5m", WatchProjection.deadline(f.watch(state = "PAUSED", expiresAt = f.ago(-300)), now))
        assertEquals("Expiring now", WatchProjection.deadline(f.watch(expiresAt = f.ago(5)), now))
        assertEquals("Expired 2h ago", WatchProjection.deadline(f.watch(state = "EXPIRED", expiresAt = f.ago(7_200)), now))
        assertNull(WatchProjection.deadline(f.watch(state = "MATCHED"), now))
    }

    // MARK: deliveries, attention, sections

    @Test fun deliveryStatusReadsTheLatestDelivery() {
        fun status(delivery: JsonObject) = WatchProjection.deliveryStatus(f.watch(state = "MATCHED", matches = listOf(f.match(deliveries = listOf(delivery)))))
        assertNull(WatchProjection.deliveryStatus(f.watch()))
        assertEquals("Delivering", status(f.delivery("PENDING")))
        assertEquals("Delivering", status(f.delivery("IN_FLIGHT")))
        assertEquals("Delivery retrying · 3 of 8 attempts failed", status(f.delivery("PENDING", attempts = 3)))
        assertEquals("Resume queued", status(f.delivery("DELIVERED")))
        assertEquals("Notification sent", status(f.delivery("DELIVERED", action = "NOTIFY_USER")))
        assertEquals("Delivery failed: OBSERVER_SESSION_ENDED: ended", status(f.delivery("DEAD_LETTER", lastError = "OBSERVER_SESSION_ENDED: ended")))
        // An unmatched end's delivery reads the same way.
        val expired = f.watch(state = "EXPIRED", endDeliveries = listOf(f.end("EXPIRY", f.delivery("DELIVERED"))))
        assertEquals("Resume queued", WatchProjection.deliveryStatus(expired))
    }

    @Test fun attentionCollectsEveryReasonAWatchCantGoOnQuietly() {
        assertEquals(emptyList<WatchAttention>(), WatchProjection.attention(f.watch(), now))
        val deadLetter = f.watch(state = "MATCHED", matches = listOf(f.match(deliveries = listOf(f.delivery("DEAD_LETTER", lastError = "boom")))))
        assertEquals(listOf(WatchAttention.DeliveryFailed("boom")), WatchProjection.attention(deadLetter, now))
        val retrying = f.watch(state = "MATCHED", matches = listOf(f.match(deliveries = listOf(f.delivery("PENDING", attempts = 2)))))
        assertEquals(listOf(WatchAttention.DeliveryRetrying(2)), WatchProjection.attention(retrying, now))
        assertEquals(listOf(WatchAttention.Revoked), WatchProjection.attention(f.watch(state = "REVOKED"), now))
        assertEquals(listOf(WatchAttention.Unresolvable), WatchProjection.attention(f.watch(state = "UNRESOLVABLE"), now))
        assertEquals(listOf(WatchAttention.Stale), WatchProjection.attention(f.watch(lastEvaluatedAt = f.ago(600)), now))
        // An end's dead letter counts as much as a Match's.
        val endFailed = f.watch(state = "REVOKED", endDeliveries = listOf(f.end("REVOKED", f.delivery("DEAD_LETTER"))))
        assertEquals(listOf(WatchAttention.DeliveryFailed(null), WatchAttention.Revoked), WatchProjection.attention(endFailed, now))
        assertEquals("Delivery failed", WatchAttention.DeliveryFailed(null).text)
        // Nobody waits on a notify watch, so its expiry is delivered to no one: this line is all that says it ran out.
        val ranOut = f.watch(state = "EXPIRED", action = "NOTIFY_USER")
        assertEquals(listOf(WatchAttention.ExpiredUnheard), WatchProjection.attention(ranOut, now))
        assertEquals("Expired before its condition held: no notification was sent", WatchAttention.ExpiredUnheard.text)
        // A resume watch's expiry reaches the session that was waiting, so it is history.
        assertEquals(emptyList<WatchAttention>(), WatchProjection.attention(f.watch(state = "EXPIRED", action = "RESUME_SESSION"), now))
        assertEquals(listOf("Stopped: access to its targets was revoked", "Stopped: every target was deleted", "Not evaluated recently"),
            listOf(WatchAttention.Revoked, WatchAttention.Unresolvable, WatchAttention.Stale).map { it.text })
    }

    /** Every ended watch is filed by the contract's `attention` rule, which `GET /watches?needsAttention=true` picks by. */
    @Test fun everyEndedWatchIsFiledWhereTheContractSaysItBelongs() {
        WatchStateMachine.terminal.forEach { state ->
            WatchAction.values().filter { it != WatchAction.UNKNOWN }.forEach { action ->
                val needed = state in WatchAttentionRule.states || (state == WatchState.EXPIRED && action in WatchAttentionRule.expiredActions)
                assertEquals("$state $action", if (needed) WatchGroup.NEEDS_ATTENTION else WatchGroup.HISTORY,
                    WatchProjection.group(f.watch(state = state.name, action = action.name), now))
            }
        }
    }

    @Test fun sectionsPutAttentionFirstThenLiveThenHistoryInArrivalOrder() {
        val active = f.watch(id = "A1")
        val paused = f.watch(id = "P1", state = "PAUSED")
        val matched = f.watch(id = "H1", state = "MATCHED", matches = listOf(f.match(deliveries = listOf(f.delivery("DELIVERED")))))
        val cancelled = f.watch(id = "H2", state = "CANCELLED")
        val expired = f.watch(id = "H3", state = "EXPIRED")
        val revoked = f.watch(id = "N1", state = "REVOKED")
        val stale = f.watch(id = "N2", lastEvaluatedAt = f.ago(900))
        val sections = WatchProjection.sections(listOf(matched, active, revoked, paused, cancelled, stale, expired), now)
        assertEquals(listOf(WatchGroup.NEEDS_ATTENTION, WatchGroup.ACTIVE, WatchGroup.HISTORY), sections.map { it.group })
        assertEquals(listOf(listOf("N1", "N2"), listOf("A1", "P1"), listOf("H1", "H2", "H3")), sections.map { s -> s.watches.map { it.id } })
        assertEquals(listOf("Needs attention", "Active", "History"), WatchGroup.entries.map { it.title })
        assertTrue(WatchProjection.sections(emptyList(), now).isEmpty())
    }

    // MARK: index

    @Test fun findsAWatchByEitherSpellingOfItsId() {
        val publicId = "34TcwNgAIo6tGUiIKjqnQ"
        val uuid = ObjectId.canonical(publicId)!!
        val watch = f.watch(id = publicId)
        // A push or a deep link names the watch by its UUID.
        assertEquals(publicId, WatchIndex.find(uuid, listOf(f.watch(id = "other"), watch))?.id)
        assertNull(WatchIndex.find("34TcwNgAIo6tGUiIKjqnR", listOf(watch)))
    }

    @Test fun mergeKeepsEachWatchOnceNewestFirst() {
        val old = f.watch(id = "OLD", createdAt = f.ago(9_000))
        val mid = f.watch(id = "MID", state = "PAUSED", createdAt = f.ago(5_000))
        val new = f.watch(id = "NEW", createdAt = f.ago(10))
        assertEquals(listOf("NEW", "MID", "OLD"), WatchIndex.merge(listOf(listOf(new, old), listOf(mid), listOf(new, mid, old))).map { it.id })
    }

    @Test fun replacingSwapsTheOlderCopyInPlaceOrAddsItFirst() {
        val a = f.watch(id = "A")
        val b = f.watch(id = "B")
        assertEquals(listOf(WatchState.ACTIVE, WatchState.PAUSED), WatchIndex.replacing(f.watch(id = "B", state = "PAUSED"), listOf(a, b)).map { it.state })
        assertEquals(listOf("C", "A", "B"), WatchIndex.replacing(f.watch(id = "C"), listOf(a, b)).map { it.id })
    }

    // MARK: failures

    @Test fun failureMessagesSayWhatTheServerSaid() {
        val refusal = ApiError.parse(400, """{"code":"TTL_OUT_OF_RANGE","kind":"REFUSAL","message":"ttlSeconds is between 60 and 2592000"}""".encodeToByteArray())
        assertEquals("Couldn't save the watch — ttlSeconds is between 60 and 2592000.", WatchProjection.failureMessage(refusal, "save"))
        val ended = ApiError.parse(409, """{"message":"a MATCHED watch cannot be paused","state":"MATCHED"}""".encodeToByteArray())
        assertEquals("Couldn't pause the watch — a MATCHED watch cannot be paused.", WatchProjection.failureMessage(ended, "pause"))
        assertEquals("Couldn't stop the watch — it no longer exists.", WatchProjection.failureMessage(ApiError.parse(404, ByteArray(0)), "stop"))
        assertEquals("Couldn't resume the watch — the connection dropped.", WatchProjection.failureMessage(NetworkException(), "resume"))
        assertEquals("Couldn't pause the watch — the server's reply couldn't be read.", WatchProjection.failureMessage(ProtocolException(), "pause"))
        // A body with no sentence of its own: its `error`, else the server's status.
        assertEquals("Couldn't stop the watch — Conflict.",
            WatchProjection.failureMessage(ApiError.parse(409, """{"error":"Conflict"}""".encodeToByteArray()), "stop"))
        assertEquals("Couldn't stop the watch — the server returned 502.", WatchProjection.failureMessage(ApiError.parse(502, "<html>".encodeToByteArray()), "stop"))
        val lines = ApiError.parse(400, """{"message":["first","second"]}""".encodeToByteArray())
        assertEquals("Couldn't pause the watch — first\nsecond.", WatchProjection.failureMessage(lines, "pause"))
    }

    // MARK: history and stopping

    @Test fun historyNamesEachDeliveryAndHowAnUnmatchedWatchEnded() {
        fun deadLetter(lastError: String) = f.watch(state = "MATCHED",
            matches = listOf(f.match(deliveries = listOf(f.delivery("DEAD_LETTER", lastError = lastError))))).matches[0].deliveries[0]
        // A wake taken back before it ran says so; one an interrupt swept off the queue never reached anybody.
        assertEquals("Wake withdrawn", WatchProjection.deliveryStatus(deadLetter("WAKE_WITHDRAWN: x")))
        assertEquals("Delivery failed: OBSERVER_TURN_INTERRUPTED: x", WatchProjection.deliveryStatus(deadLetter("OBSERVER_TURN_INTERRUPTED: x")))
        // A code that merely starts with a quiet one is not quiet.
        assertEquals("Delivery failed: WAKE_WITHDRAWN_FUTURE: x", WatchProjection.deliveryStatus(deadLetter("WAKE_WITHDRAWN_FUTURE: x")))
        assertEquals("Expired before it matched", WatchProjection.endTitle(WatchEndDelivery.Kind.EXPIRY))
        assertEquals("Stopped: access to its targets was revoked", WatchProjection.endTitle(WatchEndDelivery.Kind.REVOKED))
        assertEquals("Stopped: every target was deleted", WatchProjection.endTitle(WatchEndDelivery.Kind.UNRESOLVABLE))
        assertEquals("Ended", WatchProjection.endTitle(WatchEndDelivery.Kind.UNKNOWN))
    }

    /** Two rows a real apiserver sent: only the second is somebody's to look at. */
    @Test fun aWithdrawnWakeIsHistoryWhileADeadLetterThatFailedStillNeedsAttention() {
        val withdrawn = f.server(WatchFixture.WITHDRAWN_WAKE_JSON)
        assertEquals(emptyList<WatchAttention>(), WatchProjection.attention(withdrawn, now))
        assertEquals(WatchGroup.HISTORY, WatchProjection.group(withdrawn, now))
        assertEquals("Wake withdrawn", WatchProjection.deliveryStatus(withdrawn))
        val revoked = f.server(WatchFixture.PERMISSION_REVOKED_JSON)
        assertEquals(listOf(WatchAttention.DeliveryFailed(
            "PERMISSION_REVOKED: the observer session no longer belongs to the watch's owner, so it was not woken")),
            WatchProjection.attention(revoked, now))
        assertEquals(listOf(listOf(revoked.id), listOf(withdrawn.id)), WatchProjection.sections(listOf(withdrawn, revoked), now).map { s -> s.watches.map { it.id } })
    }

    /** Stop is the one end nobody is told about (contract §3), so the confirmation says so first. */
    @Test fun stopWarningSaysWhoWontBeTold() {
        assertEquals("The waiting session won't be resumed, and it isn't told the watch stopped.", WatchProjection.stopWarning(f.watch()))
        assertEquals("You won't be notified when the condition holds.", WatchProjection.stopWarning(f.watch(action = "NOTIFY_USER", observer = null)))
    }

    // MARK: a session as an observer (`SessionWatchingTests`)

    @Test fun onlyLiveResumeWatchesOfThisSessionMakeItsSummaryByEitherSpelling() {
        val session = "34TcwNgAIo6tGUiIKjqnQ"
        val watches = listOf(f.watch(id = "W1", observer = session), f.watch(id = "W2", state = "PAUSED", observer = session),
            f.watch(id = "W3", action = "NOTIFY_USER", observer = session), f.watch(id = "W4", state = "MATCHED", observer = session),
            f.watch(id = "W5", observer = "S9"))
        assertEquals(listOf("W1", "W2"), WatchSessionSummary.of(ObjectId.canonical(session)!!, watches)!!.watches.map { it.id })
        assertNull(WatchSessionSummary.of("S9", listOf(f.watch(id = "W6", state = "CANCELLED", observer = "S9"))))
        val byObserver = WatchIndex.summariesByObserver(watches)
        assertEquals(setOf(watchKey(session), watchKey("S9")), byObserver.keys)
        assertEquals(listOf("W1", "W2"), byObserver.getValue(watchKey(session)).watches.map { it.id })
    }

    @Test fun severalWatchesCountEachTargetOnceAndReportTheStalestLook() {
        val first = f.watch(id = "W1", targets = listOf(f.target("T1"), f.target("T2"), f.target("G", state = "GONE")), lastEvaluatedAt = f.ago(20))
        val second = f.watch(id = "W2", targets = listOf(f.target("T2"), f.target("T3")), lastEvaluatedAt = f.ago(600))
        val watching = WatchSessionSummary.of("S1", listOf(first, second))!!
        assertEquals("Watching 3 targets", watching.word)
        assertEquals("2 watches", watching.progress)
        assertEquals("Last evaluated 10m ago", watching.lastEvaluated(now))
        assertEquals("2 watches paused", WatchSessionSummary.of("S1", listOf(f.watch(id = "W4", state = "PAUSED"), f.watch(id = "W5", state = "PAUSED")))?.word)
        assertNull(WatchSessionSummary.of("S1", listOf(f.watch(id = "W4", state = "PAUSED")))!!.lastEvaluated(now))
    }

    @Test fun theStripsOneLineProjectsTheLoneTargetOrTheCount() {
        // One watch over one target that still exists names it.
        val lone = WatchSessionSummary.of("S1", listOf(f.watch(id = "W1", targets = listOf(f.target("T0")), expiresAt = f.ago(-3 * 3_600))))!!
        assertEquals("T0", lone.lineTarget?.targetResourceId)
        assertEquals(1, lone.lineTargetCount)
        // Several targets: Tasks created here's sentence over where each of them stands.
        val done = f.target("T0", status = f.status("DONE"))
        val running = f.target("T1", status = f.status("OPEN", running = true))
        assertEquals(listOf("1 running", "1/4 done"),
            WatchSessionSummary.of("S1", listOf(f.watch(id = "W1", targets = listOf(done, running, f.target("T2"), f.target("T3")))))!!.lineParts.map { it.text })
        // A deleted target is out of the set, in the single branch too — and out of the count.
        val gone = WatchSessionSummary.of("S1", listOf(f.watch(id = "W1", targets = listOf(f.target("T0"), f.target("G", state = "GONE")))))!!
        assertEquals("T0", gone.lineTarget?.targetResourceId)
        // A lone watch over several targets says what its own condition asks for, in the noun its rows count in.
        val several = WatchSessionSummary.of("S1", listOf(f.watch(id = "W1", targets = f.tasks(4))))!!
        assertNull(several.lineTarget)
        assertEquals("all 4 tasks", several.lineTargetWord)
        assertEquals("any 1 of 4 tasks", WatchSessionSummary.of("S1", listOf(f.watch(id = "W1", predicate = f.any("TASK_TERMINAL"), targets = f.tasks(4))))!!.lineTargetWord)
        // A failed part is the one drawn red.
        val failed = WatchSessionSummary.of("S1", listOf(f.watch(id = "W1", targets = listOf(f.target("T0", status = f.status("FAILED")), f.target("T1")))))!!
        assertEquals(listOf(WatchCountCopy.Part("1 failed", true), WatchCountCopy.Part("0/2 done", false)), failed.lineParts)
    }

    @Test fun aTargetIsNamedByWhatTheClientHoldsElseByKindAndShortId() {
        assertEquals("Fix the login", WatchProjection.targetTitle(WatchTargetKind.TASK, "34TcwNgAIo6tGUiIKjqnQ", "Fix the login"))
        assertEquals("Task 34TcwNgA", WatchProjection.targetTitle(WatchTargetKind.TASK, "34TcwNgAIo6tGUiIKjqnQ", null))
        assertEquals("Session 34TcwNgA", WatchProjection.targetTitle(WatchTargetKind.SESSION, "34TcwNgAIo6tGUiIKjqnQ", ""))
        assertEquals("X1", WatchProjection.targetTitle(WatchTargetKind.UNKNOWN, "X1", null))
        assertEquals(listOf("Waiting", "Met", "Deleted", "Unknown"), WatchTargetState.entries.map(WatchProjection::targetStateWord))
    }

    @Test fun aTargetsStandingIsItsOwnListsPill() {
        assertEquals(WatchTaskPill(WatchTaskPill.Kind.RUNNING, "Running"), WatchProjection.stripPill(f.watch(targets = listOf(f.target("T", status = f.status("OPEN", running = true)))).targets[0]))
        assertEquals(WatchTaskPill(WatchTaskPill.Kind.QUEUED, "Queued"), WatchProjection.stripPill(f.watch(targets = listOf(f.target("T", status = f.status("OPEN", queued = true)))).targets[0]))
        assertEquals(WatchTaskPill(WatchTaskPill.Kind.IN_PROGRESS, "In progress"), WatchProjection.stripPill(f.watch(targets = listOf(f.target("T", status = f.status("IN_PROGRESS")))).targets[0]))
        // A status neither end knows is drawn under its own name rather than under a wrong one.
        assertEquals(WatchTaskPill(WatchTaskPill.Kind.OPEN, "BLOCKED"), WatchProjection.stripPill(f.watch(targets = listOf(f.target("T", status = f.status("BLOCKED")))).targets[0]))
        assertNull("no standing carried, no pill", WatchProjection.stripPill(f.watch(targets = listOf(f.target("T"))).targets[0]))
        val session = f.watch(targets = listOf(f.target("S", kind = "SESSION", status = f.status("RUNNING", running = true)))).targets[0]
        assertNull(WatchProjection.stripPill(session))
        assertEquals(WatchSessionGlyph(null, WatchSessionGlyph.Tone.BRAND, "Running"), WatchProjection.stripGlyph(session))
        assertEquals("Ended", WatchSessionGlyph.of("SOMETHING_NEW").label)
    }

    @Test fun anOpenedStripListsTheLiveTargetsMetFirst() {
        val watch = f.watch(targets = listOf(f.target("A"), f.target("B", state = "SATISFIED"), f.target("C", state = "GONE"), f.target("D"), f.target("E", state = "SATISFIED")))
        assertEquals(listOf("B", "E", "A", "D"), WatchProjection.stripTargets(watch).map { it.targetResourceId })
    }
}
