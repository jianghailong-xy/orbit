package io.orbitd.android.core.cards

import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * A turn a watch queued, as its line says it (A08-14; OrbitKit `WatchWakeCard`, `WatchWakeTests`): the title, the target it names and
 * how it came out, the failures that stay in view, the fold's words, and the queue's own line — read off the projection of the server's
 * message, the same one the transcript draws.
 */
class WatchWakeCardTest {
    private fun target(kind: String, id: String, status: String? = null) = buildJsonObject {
        put("kind", kind); put("id", id); put("state", "SATISFIED"); status?.let { putJsonObject("observed") { put("status", it) } }
    }
    private fun text(watchId: String = "0199a8f0-1111-7aaa-8bbb-0000deadbeef", head: String = "matched at generation 2: ALL TASK_DONE 1/1",
        targets: List<JsonObject> = emptyList()) =
        "Orbit Watch $watchId $head\nThis turn was queued by the watch, not typed by a person.\n```json\n" +
            buildJsonObject { put("watchId", watchId); put("changedTargets", JsonArray(targets)) } + "\n```"
    private fun wake(head: String = "matched at generation 2: ALL TASK_DONE 1/1", targets: List<JsonObject> = emptyList()) =
        transcriptCards(RunEvent("user", 7, buildJsonObject { put("text", text(head = head, targets = targets)) })).single { it.key == "record:7:watch" }.source

    @Test fun oneTargetIsNamedAndClosesOnItsStatus() {
        val done = wake(targets = listOf(target("TASK", "0199a8f0-2222-7aaa-8bbb-00000000c0de", "DONE")))
        assertEquals("Watch triggered", WatchWakeCard.title(done.text("state")))
        assertEquals("by the last eight of its id where nothing names it", "Task 0000c0de", WatchWakeCard.lineName(done))
        assertEquals("Land the redirect fix", WatchWakeCard.lineName(done, "Land the redirect fix"))
        assertEquals("DONE", WatchWakeCard.lineStatus(done))
        assertFalse(WatchWakeCard.isFailed(done))
        assertEquals("1 of 1 done", WatchWakeCard.why(done))
        assertEquals("Queued by a watch, not typed by you · generation 2", WatchWakeCard.meta(done))
        assertEquals("Task Land the redirect fix is now DONE", WatchWakeCard.changedLine(WatchWakeCard.targets(done).single(), "Land the redirect fix"))
        assertTrue("the fold shows exactly what the agent received", done.text("text")!!.startsWith("Orbit Watch 0199a8f0-1111-7aaa-8bbb-0000deadbeef matched"))
        assertTrue(WatchWakeCard.failures(done).first.isEmpty())
    }

    @Test fun aFailedTargetTurnsTheLineRedAndStaysInViewAmongSeveral() {
        val mixed = wake(head = "matched at generation 1: ALL TASK_TERMINAL 3/3", targets = listOf(target("TASK", "a-00000001", "DONE"),
            target("TASK", "b-00000002", "FAILED"), target("TASK", "c-00000003", "DONE")))
        assertTrue(WatchWakeCard.isFailed(mixed))
        assertEquals("3 tasks", WatchWakeCard.lineName(mixed))
        assertEquals("1 of 3 failed", WatchWakeCard.lineStatus(mixed))
        val (failures, more) = WatchWakeCard.failures(mixed)
        assertEquals(listOf("b-00000002"), failures.map { it.text("id") }); assertEquals(0, more)
        assertTrue(WatchWakeCard.targetFailed(failures.single())); assertFalse(WatchWakeCard.targetFailed(WatchWakeCard.targets(mixed).first()))
        assertEquals("3 of 3 finished", WatchWakeCard.why(mixed))
        // A lone failed target is the line itself; nothing more stays out of the fold.
        val lone = wake(targets = listOf(target("SESSION", "s-12345678", "FAILED")))
        assertEquals("FAILED", WatchWakeCard.lineStatus(lone)); assertTrue(WatchWakeCard.isFailed(lone))
        assertTrue(WatchWakeCard.failures(lone).first.isEmpty())
        assertEquals("Session 12345678", WatchWakeCard.lineName(lone))
        // Kinds counted in the strip's nouns, several of them generically; nothing moved is no name.
        assertEquals("2 sessions", WatchWakeCard.lineName(wake(targets = listOf(target("SESSION", "x"), target("SESSION", "y")))))
        assertEquals("2 targets", WatchWakeCard.lineName(wake(targets = listOf(target("SESSION", "x"), target("TASK", "y")))))
        assertNull(WatchWakeCard.lineName(wake())); assertNull(WatchWakeCard.lineStatus(wake()))
        val many = wake(targets = (1..7).map { target("TASK", "t-0000000$it", if (it % 2 == 0) "FAILED" else "DONE") })
        assertEquals(5, WatchWakeCard.changes(many).first.size); assertEquals(2, WatchWakeCard.changes(many).second)
        assertEquals("+2 more", WatchWakeCard.moreTargets(2))
    }

    @Test fun theThreeEndsSayTheyWillNotWakeThisSessionAgain() {
        val expired = wake(head = "EXPIRED at 2026-10-09T00:00:00Z without its condition ever holding.")
        assertEquals("Watch expired", WatchWakeCard.title(expired.text("state")))
        assertEquals("Its deadline passed before its condition held. It will not wake this session again.", WatchWakeCard.why(expired))
        assertEquals("Queued by a watch, not typed by you", WatchWakeCard.meta(expired))
        val revoked = wake(head = "ended REVOKED: lost access")
        assertEquals("Watch stopped: access lost", WatchWakeCard.title(revoked.text("state")))
        assertEquals("This account can no longer read one of its targets, so it reports nothing about them.", WatchWakeCard.why(revoked))
        val gone = wake(head = "ended UNRESOLVABLE: every target deleted")
        assertEquals("Watch stopped: every target is gone", WatchWakeCard.title(gone.text("state")))
        assertEquals("Every target it watched was deleted, so its condition can never be decided.", WatchWakeCard.why(gone))
        assertEquals("1 of 2 finished their turn · 1 of 1 failed", WatchWakeCard.describeReason("ALL SESSION_TURN_SETTLED 1/2 AND ANY TASK_FAILED 1/1"))
        assertEquals("ALL SOMETHING_NEW 1/2", WatchWakeCard.describeReason("ALL SOMETHING_NEW 1/2"))
    }

    @Test fun everyWordIsOrbitKits() {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit/App/WatchWake.swift").isFile }
        val swift = File(root, "src/macos/OrbitKit/Sources/OrbitKit/App/WatchWake.swift").readText()
        listOf(WatchWakeCard.details, WatchWakeCard.undelivered, WatchWakeCard.viewWatch, WatchWakeCard.rawSummary, WatchWakeQueue.status,
            WatchWakeQueue.withdraw, WatchWakeQueue.consequence, WatchWakeQueue.confirmTitle, WatchWakeQueue.keep, "Watch triggered", "Watch expired",
            "Watch stopped: access lost", "Watch stopped: every target is gone", "Queued by a watch, not typed by you", "Its condition held.",
        ).forEach { assertTrue("WatchWake.swift no longer says \"$it\"", swift.contains("\"$it\"")) }
        assertTrue(swift.contains("public static let shownChanges = ${WatchWakeCard.shownChanges}"))
        assertTrue(swift.contains("\"\\(failed.count) of \\(changed.count) failed\""))
        assertTrue(swift.contains("\"\\(noun(target)) \\(shown) is now \\(status)\""))
    }
}
