package io.orbitd.android.cards

import io.orbitd.android.core.cards.flag
import io.orbitd.android.core.cards.number
import io.orbitd.android.core.cards.obj
import io.orbitd.android.core.cards.objects
import io.orbitd.android.core.cards.text
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.watch.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * A08-6 (iOS 516ac3389): one Tasks card — watched tasks carry an eye instead of a second card. The merge is held to the shared
 * `session-created-tasks.fixture.json` card cases both other clients are proved against; the split between the Watching card and the
 * Tasks card is OrbitKit's SessionTaskCardTests, case for case.
 */
class SessionTaskCardTest {
    private val corpus: JsonObject by lazy {
        val file = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .map { File(it, "src/shared/src/session-created-tasks.fixture.json") }.first { it.isFile }
        Wire.json.parseToJsonElement(file.readText()).jsonObject
    }

    @Test fun theWordsAreTheFixturesWords() {
        val copy = corpus.obj("copy")!!
        assertEquals(copy.text("title"), SessionTaskCard.title)
        assertEquals(copy.text("elsewhere"), SessionTaskCard.elsewhere)
        assertEquals(copy.text("replacesPrefix"), SessionTaskCard.replacesPrefix)
        assertTrue(corpus.flag("singleNamesTheTask"))
    }

    /** The card's count sentence, held to the fixture's sentences (it was the rail's "Tasks created here" line before A08-6). */
    @Test fun theCountSentenceIsTheFixturesSentence() {
        corpus.objects("countLine").forEach { row ->
            val parts = WatchCountCopy.parts(row.number("running") ?: 0, row.number("failed") ?: 0, row.number("done") ?: 0, row.number("total") ?: 0)
            assertEquals(row.text("text"), parts.joinToString(WatchCountCopy.SEPARATOR) { it.text })
        }
    }

    @Test fun everyCardCaseIsTheCardThisClientDraws() {
        val cases = corpus.objects("card")
        assertTrue(cases.size >= 8)
        cases.forEach { case ->
            val name = case.text("name")!!
            // The fixture names a replaced task by its id; the server sends it named (`replaces: {id, title}`), as iOS's test maps it.
            val created = (case["created"] as? JsonObject)?.let { created ->
                JsonObject(created + ("items" to JsonArray(created.objects("items").map { item ->
                    item.text("replaces")?.let { id -> JsonObject(item + ("replaces" to buildJsonObject { put("id", id); put("title", "Task $id") })) } ?: item
                })))
            }
            val watched = case.objects("watched").map {
                SessionWatchedTask(it.text("id")!!, it.text("title").orEmpty(),
                    it.text("status")?.let { status -> WatchTargetStatus(status, it.flag("running"), it.flag("queued")) }, it.flag("stale"))
            }
            val card = SessionTaskCard.of(created, watched)
            val expected = case["card"] as? JsonObject
            if (expected == null) { assertNull(name, card); return@forEach }
            assertNotNull(name, card)
            assertEquals(name, expected.objects("rows").map { listOf(it.text("id"), it.flag("watched"), it.flag("stale"), it.flag("elsewhere")) },
                card!!.rows.map { listOf(it.id, it.watched, it.stale, it.elsewhere) })
            val counts = expected.obj("counts")!!
            assertEquals(name, listOf(counts.number("running"), counts.number("failed"), counts.number("done"), counts.number("total")),
                listOf(card.running, card.failed, card.done, card.total))
            assertEquals(name, expected.number("watching"), card.watching)
            assertEquals(name, expected.flag("stale"), card.stale)
        }
    }

    // The split between the two cards (OrbitKit SessionTaskCardTests).

    private val f = WatchFixture
    private fun summary(vararg watches: Watch) = requireNotNull(WatchSessionSummary.of("S1", watches.toList()))

    @Test fun aWaitOnTasksLeavesTheWatchingCardToWaitsOnSessions() {
        val tasks = f.watch(id = "W1", targets = f.tasks(2))
        val sessions = f.watch(id = "W2", predicate = f.all("SESSION_TURN_SETTLED"), targets = listOf(f.target("S9", kind = "SESSION")))
        assertNull("only tasks: no Watching card", summary(tasks).beyondTasks)
        assertEquals(listOf("W2"), summary(tasks, sessions).beyondTasks?.watches?.map { it.id })
        val mixed = f.watch(id = "W3", targets = listOf(f.target("T1"), f.target("S9", kind = "SESSION")))
        assertEquals(listOf("W3"), summary(mixed).beyondTasks?.watches?.map { it.id })
    }

    @Test fun everyLiveTaskTargetIsWatchedNamedAndStaleWithItsWatch() {
        val fresh = f.watch(id = "W1", targets = listOf(f.target("T1"), f.target("T2", state = "GONE"), f.target("S9", kind = "SESSION")))
        val unchecked = f.watch(id = "W2", targets = listOf(f.target("T3")), lastEvaluatedAt = f.ago(12 * 60))
        val watched = summary(fresh, unchecked).watchedTasks(f.now) { if (it.targetResourceId == "T1") "First" else null }
        assertEquals("a deleted target and a session are not task rows", listOf("T1", "T3"), watched.map { it.id })
        assertEquals(listOf("First", "Task T3"), watched.map { it.title })
        assertEquals(listOf(false, true), watched.map { it.stale })
    }

    @Test fun theTasksCardSaysWhenATaskOnlyWaitGoesUnchecked() {
        val unchecked = f.watch(id = "W1", targets = listOf(f.target("T1")), lastEvaluatedAt = f.ago(12 * 60))
        val sessions = f.watch(id = "W2", predicate = f.all("SESSION_TURN_SETTLED"), targets = listOf(f.target("S9", kind = "SESSION")),
            lastEvaluatedAt = f.ago(12 * 60))
        assertEquals(listOf("Not checked for 12m — the resume may be late."), summary(unchecked, sessions).taskStaleLines(f.now))
        assertEquals(emptyList<String>(), summary(f.watch(id = "W3", targets = listOf(f.target("T1")))).taskStaleLines(f.now))
    }

    @Test fun oneTaskIsNamedAndTheEyeCountsTheWatchedRows() {
        val created = buildJsonObject {
            put("total", 1); put("running", 1); put("failed", 0); put("done", 0)
            putJsonArray("items") { addJsonObject {
                put("id", "T1"); put("title", "Only"); put("status", "OPEN"); put("running", true); put("queued", false); put("createdAt", "2026-09-14T09:00:00Z")
            } }
        }
        val card = requireNotNull(SessionTaskCard.of(created, listOf(SessionWatchedTask("T1", "Only", null, false))))
        assertEquals("T1", card.single?.id)
        assertEquals(true, card.single?.watched)
        assertEquals("the created row's own pill, not the watch's reading", WatchTaskPill(WatchTaskPill.Kind.RUNNING, "Running"), card.single?.pill)
        assertEquals(1, card.watching)
        assertNull("nothing created or watched: no card", SessionTaskCard.of(null, emptyList()))
    }
}
