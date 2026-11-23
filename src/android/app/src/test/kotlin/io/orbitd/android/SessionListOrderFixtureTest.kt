package io.orbitd.android

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.directory.*
import java.io.File
import java.time.Instant
import java.time.ZoneId
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The Open list's sections and order, held to `contracts/session-list-order.fixtures.json` (the file web and OrbitKit test against). */
class SessionListOrderFixtureTest {
    private val fixture: JsonObject = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
        .map { File(it, "contracts/session-list-order.fixtures.json") }.firstOrNull { it.isFile }
        ?.let { Wire.json.parseToJsonElement(it.readText()).jsonObject }
        ?: error("contracts/session-list-order.fixtures.json was not found above ${System.getProperty("user.dir")}")
    private val now = Instant.parse(fixture.getValue("now").jsonPrimitive.content)
    private val zone = ZoneId.of(fixture.getValue("timeZone").jsonPrimitive.content)

    private fun rows(): List<DirectorySession> = fixture.getValue("sessions").jsonArray.map { Wire.json.decodeFromJsonElement<DirectorySession>(it) }
    /** The Open list's input: a completed or trashed row is not in it. */
    private fun open(rows: List<DirectorySession>) = rows.filter { it.completedAt == null && it.deletedAt == null }
    private fun groups(rows: List<DirectorySession>) = directoryGroups(open(rows), SessionView.OPEN, Grouping.RECENCY, now, zone)
    private fun shape(groups: List<SessionGroup>) = groups.map { it.title to it.sessions.map { s -> s.id } }

    @Test fun sectionsAndOrderMatchTheSharedFixture() {
        val expected = fixture.getValue("expected").jsonArray.map { e ->
            e.jsonObject.getValue("section").jsonPrimitive.content to e.jsonObject.getValue("ids").jsonArray.map { it.jsonPrimitive.content } }
        assertEquals(expected, shape(groups(rows())))
        assertEquals(fixture.getValue("sectionTitles").jsonArray.map { it.jsonPrimitive.content }.take(3), groups(rows()).map { it.title }.take(3))
    }

    @Test fun activityOnlyUpdatesLeaveTheOrderUnchanged() {
        val before = shape(groups(rows()))
        // Streaming, a CI poll and a reconnect move lastTurnAt (and a preview) on every row; listedAt stays where it was.
        val busier = rows().mapIndexed { i, s -> s.copy(lastTurnAt = "2026-11-20T11:5${i % 10}:00.000Z", lastAssistantText = "step $i") }
        assertEquals(before, shape(groups(busier)))
        assertEquals(before, shape(groups(busier.reversed())))
    }

    @Test fun anOwnerMeaningfulChangeMovesTheRow() {
        val moved = rows().map { if (it.id == "work-ci") it.copy(status = "AWAITING_INPUT", pendingApprovals = 1, listedAt = "2026-11-20T11:00:00.000Z") else it }
        assertEquals(listOf("work-ci", "needs-question", "needs-blocked", "needs-failed"),
            groups(moved).first { it.title == "Needs you" }.sessions.map { it.id })
    }
}
