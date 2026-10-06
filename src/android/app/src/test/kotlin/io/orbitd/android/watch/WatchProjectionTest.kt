package io.orbitd.android.watch

import io.orbitd.android.core.cards.*
import io.orbitd.android.navigation.*
import java.io.File
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class WatchProjectionTest {
    private fun fixture(): JsonObject {
        val file = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .map { File(it, "src/shared/src/watch-strip.fixture.json") }.first { it.exists() }
        return Json.parseToJsonElement(file.readText()).jsonObject
    }
    private fun target(row: JsonObject) = buildJsonObject {
        put("targetResourceId", row.text("id") ?: "target")
        put("targetKind", row.text("kind") ?: "TASK")
        put("state", row.text("state") ?: "OBSERVED")
        row["title"]?.let { put("targetTitle", it) }; row["status"]?.let { put("targetStatus", it) }
    }
    @Test fun everySharedSessionRowKeepsThresholdDistinctTargetsAndPausedIdentity() {
        fixture().objects("rows").forEach { sample ->
            val watches = sample.objects("watches").mapIndexed { index, row -> WatchRecord(JsonObject(row + mapOf(
                "id" to JsonPrimitive("$index"), "targets" to JsonArray(row.objects("targets").map(::target))))) }
            assertEquals(sample.text("case"), sample.text("word"), WatchProjection.summaryWord(watches))
            assertEquals(sample.text("case"), sample.text("line"), WatchProjection.rowLine(watches))
            // The frozen WatchingCardStack header always says Watching, even when the list row says paused.
            assertTrue(WatchProjection.stripLine(watches).startsWith("Watching "))
        }
    }
    @Test fun allSharedCountsAndSessionWordsAndStalenessMatch() {
        val fixture = fixture()
        fixture.objects("counts").forEach { sample ->
            assertEquals(sample.text("case"), sample.text("line"), WatchProjection.countLine(sample.objects("targets").map(::target)))
        }
        fixture.obj("sessionWords")!!.forEach { (state, expected) ->
            val target = buildJsonObject { put("targetKind", "SESSION"); putJsonObject("targetStatus") { put("status", state) } }
            assertEquals(state, expected.jsonPrimitive.content, WatchProjection.standing(target))
        }
        val now = Instant.parse(fixture.text("now"))
        fixture.objects("stale").forEach { sample ->
            assertEquals(sample.text("case"), sample.text("line"), WatchProjection.staleLine(WatchRecord(sample), now))
        }
    }
    @Test fun goneAndUnknownTargetsDoNotNavigateAndUnknownPredicateDoesNotInventThreshold() {
        val task = target(buildJsonObject { put("id", "T1"); put("kind", "TASK") })
        assertEquals(OrbitRoute(Destination.TASK, "T1", origin = Origin.LINK), WatchProjection.targetRoute(task))
        assertNull(WatchProjection.targetRoute(JsonObject(task + ("state" to JsonPrimitive("GONE")))))
        assertNull(WatchProjection.targetRoute(JsonObject(task + ("targetKind" to JsonPrimitive("FUTURE")))))
        val watch = WatchRecord(buildJsonObject {
            put("id", "w"); put("state", "ACTIVE"); putJsonObject("predicate") { put("kind", "AT_LEAST"); put("count", 1) }
            put("targets", JsonArray(listOf(task, JsonObject(task + ("targetResourceId" to JsonPrimitive("T2"))))))
        })
        assertEquals("A condition this version of Orbit can't show", WatchProjection.condition(watch.predicate, 2))
        assertEquals("Watching 2 tasks · 0/2 done", WatchProjection.rowLine(listOf(watch)))
    }
    @Test fun statesUseExistingCardDoorsAndQuietWithdrawalsStayInHistory() {
        val raw = buildJsonObject { put("id", "w"); put("state", "ACTIVE") }
        assertEquals(listOf(CardVerb.WATCH_PAUSE, CardVerb.WATCH_CANCEL), WatchRecord(raw).card.actions)
        assertEquals(listOf(CardVerb.WATCH_RESUME, CardVerb.WATCH_CANCEL), WatchRecord(JsonObject(raw + ("state" to JsonPrimitive("PAUSED")))).card.actions)
        listOf("MATCHED", "EXPIRED", "CANCELLED", "REVOKED", "UNRESOLVABLE", "FUTURE").forEach {
            assertTrue(WatchRecord(JsonObject(raw + ("state" to JsonPrimitive(it)))).card.actions.isEmpty())
        }
        val delivery = buildJsonObject { put("state", "DEAD_LETTER"); put("lastError", "WAKE_WITHDRAWN: owner withdrew") }
        val watch = WatchRecord(buildJsonObject {
            put("id", "w"); put("state", "MATCHED"); putJsonArray("matches") { add(buildJsonObject { put("deliveries", JsonArray(listOf(delivery))) }) }
        })
        assertEquals("Wake withdrawn", WatchProjection.delivery(delivery))
        assertEquals("History", WatchProjection.group(watch, Instant.now()))
        assertTrue(WatchProjection.deliveryNeedsAttention(JsonObject(delivery + ("lastError" to JsonPrimitive("PERMISSION_REVOKED: revoked")))))
        assertTrue(WatchProjection.deliveryNeedsAttention(JsonObject(delivery + ("lastError" to JsonPrimitive("WAKE_WITHDRAWN_FUTURE: not quiet")))))
    }
    @Test fun unknownStatesRemainReadableAndExpiredNotifyWatchNeedsAttention() {
        val unknown = WatchRecord(buildJsonObject { put("id", "w"); put("state", "NEW_SERVER_STATE"); put("action", "FUTURE") })
        assertEquals("Unknown state", WatchProjection.headline(unknown))
        assertEquals("An action this version of Orbit can't show", WatchProjection.action(unknown))
        val expired = WatchRecord(buildJsonObject { put("id", "w"); put("state", "EXPIRED"); put("action", "NOTIFY_USER") })
        assertEquals("Needs attention", WatchProjection.group(expired, Instant.now()))
    }
    @Test fun canonicalObserverIdentityFiltersOutNotifyAndEndedWatches() {
        fun watch(state: String, action: String) = WatchRecord(buildJsonObject {
            put("id", "w"); put("state", state); put("action", action); put("observerSessionId", "1")
        })
        val active = watch("ACTIVE", "RESUME_SESSION")
        val paused = watch("PAUSED", "RESUME_SESSION")
        assertEquals(listOf(active, paused), WatchProjection.observing(ObjectId.canonical("1")!!,
            listOf(active, paused, watch("ACTIVE", "NOTIFY_USER"), watch("MATCHED", "RESUME_SESSION"))))
    }
    @Test fun progressCountsThePredicateKindAndAnyThresholdRatherThanAllTargets() {
        val tasks = listOf("OBSERVED", "SATISFIED", "GONE").mapIndexed { index, state ->
            target(buildJsonObject { put("id", "T$index"); put("kind", "TASK"); put("state", state) })
        }
        val session = target(buildJsonObject { put("id", "S"); put("kind", "SESSION"); put("state", "OBSERVED") })
        val watch = WatchRecord(buildJsonObject {
            put("id", "w"); put("state", "ACTIVE"); put("targets", JsonArray(tasks + session))
            putJsonObject("predicate") { put("kind", "ANY"); put("over", "ALL_TARGETS"); put("leaf", "TASK_TERMINAL") }
        })
        assertEquals("1 finished · 1 gone", WatchProjection.progress(watch))
        assertEquals("Watching any 1 of 2 targets · 0/3 done", WatchProjection.rowLine(listOf(watch)))
        assertEquals("Any task finishes", WatchProjection.condition(watch.predicate, 3))
        assertEquals("The task finishes", WatchProjection.condition(watch.predicate, 1))
    }
}
