package io.orbitd.android.schedule

import io.orbitd.android.core.schedule.ScheduleCard
import io.orbitd.android.core.schedule.ScheduleChangeRecord
import io.orbitd.android.core.schedule.ScheduleRule
import io.orbitd.android.core.schedule.ScheduleRunView
import io.orbitd.android.core.schedule.ScheduleView
import io.orbitd.android.core.schedule.SessionScheduleCardsResponse
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitLinks
import io.orbitd.android.push.PushMessage
import java.util.UUID
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test

/**
 * The Android side of scheduled tasks beyond the shared rules (which `:core`'s schedule tests hold to the contract): the `schedule`
 * push (apiserver `notifySchedule`) is read and opens the run's session or the schedule, `orbit://schedule/<id>` lands on the
 * Scheduled page, a conversation's cards and change lines go where they happened, and the drawer counts only what needs the owner.
 */
class ScheduleAppTest {
    private val schedule = "01a0d6a9-d763-70e1-b4cf-8793e971b600"
    private val session = "01a0d6a9-d763-70e1-b4cf-8793e971b601"
    private val request = "01a0d6a9-d763-70e1-b4cf-8793e971b602"

    private fun push(payload: JsonObjectBuilder.() -> Unit): Map<String, String> = mapOf(
        "version" to "1", "type" to "alert", "registrationKey" to "10000000-0000-4000-8000-000000000001",
        "eventId" to UUID.randomUUID().toString(), "notificationKey" to "schedule-failed-$schedule", "sentAt" to "2026-11-14T02:41:00.000Z",
        "payload" to buildJsonObject {
            put("title", "Nightly pg spec sweep failed 3 runs in a row"); put("body", "The last run ended without a report. It keeps running until you pause it.")
            put("kind", "schedule"); put("scheduleKind", "SCHEDULE_FAILED"); put("threadId", "schedule-$schedule")
            put("scheduleID", ObjectId.toPublic(schedule))
            payload()
        }.toString())

    @Test fun aSchedulePushNamingARunSessionOpensThatSession() {
        val message = PushMessage.parse(push { put("sessionID", session); put("ownerRequestID", request) })
        assertNotNull("the schedule kind is not dropped", message)
        assertEquals(schedule, message!!.payload.scheduleId)
        assertEquals(request, message.payload.ownerRequestId)
        assertEquals("orbit-session:$session", message.link)
    }

    @Test fun aSchedulePushNamingNoSessionOpensTheScheduleOnTheScheduledPage() {
        val message = PushMessage.parse(push { })!!
        assertEquals("orbit://schedule/$schedule", message.link)
        val route = OrbitLinks.parse(message.link!!)!!
        assertEquals(Destination.SCHEDULED, route.destination)
        assertEquals(schedule, route.id)
    }

    @Test fun aSchedulePushWithoutItsScheduleIsRefused() {
        val data = push { }.toMutableMap()
        data["payload"] = data.getValue("payload").replace(Regex(",\"scheduleID\":\"[^\"]+\""), "")
        assertNull(PushMessage.parse(data))
    }

    @Test fun aScheduleLinkInEitherSpellingLandsOnTheScheduledPage() {
        assertEquals(schedule, OrbitLinks.parse("orbit://schedule/${ObjectId.toPublic(schedule)}")?.id)
        assertEquals(Destination.SCHEDULED, OrbitLinks.parse("orbit://schedule/$schedule")?.destination)
        assertNull(OrbitLinks.parse("orbit://schedule/not-an-id"))
    }

    private fun view(id: String, state: String = "ACTIVE", failures: Int = 0) = ScheduleView(id = id, title = id, rule = ScheduleRule.Daily("02:00"),
        timezone = "UTC", workspaceId = "w", state = state, consecutiveFailures = failures)

    @Test fun theDrawerCountsFailingAndHeldSchedulesOnly() {
        val state = ScheduledStore.State(schedules = listOf(view("a", failures = 3), view("b", state = "HELD"), view("c"),
            view("d", state = "PAUSED"), view("e", state = "PAUSED", failures = 2)))
        assertEquals(2, state.needsYouCount)
    }

    @Test fun aConversationsCardsAndChangesGoWhereTheyHappenedAndARunGetsItsStripAndReport() {
        val card = ScheduleCard(id = "c1", kind = "CREATE", createdAt = "2026-11-14T10:00:30.000Z")
        val record = ScheduleChangeRecord(scheduleId = schedule, title = "Codex stable check", revision = 2, changedBy = "SESSION",
            before = buildJsonObject { put("title", "Codex check") }, after = buildJsonObject { put("title", "Codex stable check") },
            createdAt = "2026-11-14T10:05:00.000Z")
        val run = ScheduleRunView(id = "r1", scheduleId = schedule, plannedAt = "2026-11-14T09:59:00.000Z", state = "CHANGED",
            startedAt = "2026-11-14T10:00:00.000Z", endedAt = "2026-11-14T10:09:00.000Z")
        val state = ScheduledStore.State(
            sessions = mapOf(ScheduledStore.key(session) to SessionScheduleCardsResponse(cards = listOf(card), records = listOf(record))),
            runs = mapOf(ScheduledStore.key(session) to ScheduledStore.RunContext(view(schedule), run, null)))
        val inserts = ScheduleInsert.of(state, ObjectId.toPublic(session))
        assertEquals(listOf("schedule-run-strip-r1", "schedule-card-c1", "schedule-record-$schedule@2", "schedule-run-report-r1"), inserts.map { it.key })
        val rows = listOf("2026-11-14T10:00:00.000Z", "2026-11-14T10:01:00.000Z", null, "2026-11-14T10:08:00.000Z")
        val placed = ScheduleInsert.place(rows, inserts)
        assertEquals(listOf("schedule-run-strip-r1"), placed[-1]?.map { it.key })
        assertEquals(listOf("schedule-card-c1"), placed[0]?.map { it.key })
        assertEquals(listOf("schedule-record-$schedule@2"), placed[1]?.map { it.key })
        assertEquals(listOf("schedule-run-report-r1"), placed[3]?.map { it.key })
    }

    @Test fun aRunStillGoingHasNoReportYet() {
        val run = ScheduleRunView(id = "r2", scheduleId = schedule, plannedAt = "2026-11-14T09:59:00.000Z", state = "RUNNING")
        val state = ScheduledStore.State(runs = mapOf(ScheduledStore.key(session) to ScheduledStore.RunContext(view(schedule), run, null)))
        assertEquals(listOf("schedule-run-strip-r2"), ScheduleInsert.of(state, session).map { it.key })
    }

    @Test fun theTimelineListsOnlyTheFilteredWorkspaceAndItsDrafts() {
        val a = view("a").copy(workspaceId = "w1", nextDueAt = "2026-11-14T12:00:00.000Z")
        val b = view("b").copy(workspaceId = "w2", nextDueAt = "2026-11-14T13:00:00.000Z")
        val state = ScheduledStore.State(schedules = listOf(a, b), listRuns = emptyList(), workspaceFilter = "w1")
        assertEquals(listOf("a"), state.shownSchedules.map { it.id })
        val groups = state.timeline(java.time.Instant.parse("2026-11-14T08:00:00Z"), "UTC")
        assertEquals(listOf("schedule-a"), groups.flatMap { it.items }.map { it.id })
    }
}
