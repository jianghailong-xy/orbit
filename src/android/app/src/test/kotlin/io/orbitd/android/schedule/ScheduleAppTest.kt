package io.orbitd.android.schedule

import io.orbitd.android.core.schedule.ScheduleCard
import io.orbitd.android.core.schedule.ScheduleChangeOpening
import io.orbitd.android.core.schedule.ScheduleChangeRecord
import io.orbitd.android.core.schedule.ScheduleRule
import io.orbitd.android.core.schedule.ScheduleRunView
import io.orbitd.android.core.schedule.ScheduleView
import io.orbitd.android.core.schedule.SessionScheduleCardsResponse
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitLinks
import io.orbitd.android.push.PushMessage
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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

    /** A sample of the shared fixture (src/shared/src/android-push.fixture.json), the FCM data push.service.spec pins to what
     * `PushService.notifySchedule` really sends: a server change turns this red. */
    private fun sample(name: String): Map<String, String> {
        val root = generateSequence(java.io.File(System.getProperty("user.dir"))) { it.parentFile }
            .first { java.io.File(it, "src/shared/src/android-push.fixture.json").isFile }
        val fixture = Json.parseToJsonElement(java.io.File(root, "src/shared/src/android-push.fixture.json").readText()).jsonObject
        return fixture["samples"]!!.jsonArray.map { it.jsonObject }.single { it["name"]!!.jsonPrimitive.content == name }["data"]!!
            .jsonObject.mapValues { it.value.jsonPrimitive.content }
    }

    @Test fun theServersFailurePushOpensTheRunsSessionOnTheNeedsYouChannel() {
        val message = PushMessage.parse(sample("schedule-failed")) ?: throw AssertionError("the server's schedule push is dropped")
        assertEquals("schedule", message.payload.kind)
        assertEquals("019a0000-0000-7000-8000-000000000010", message.payload.scheduleId)
        assertEquals("019a0000-0000-7000-8000-000000000013", message.payload.ownerRequestId)
        assertEquals("Nightly pg spec sweep failed 3 runs in a row", message.payload.title)
        assertEquals("orbit-session:019a0000-0000-7000-8000-000000000012", message.link)
    }

    @Test fun theServersHoldPushOpensTheScheduleOnTheScheduledPage() {
        val message = PushMessage.parse(sample("schedule-held")) ?: throw AssertionError("the server's schedule push is dropped")
        assertNull(message.payload.sessionId)
        assertEquals("orbit://schedule/019a0000-0000-7000-8000-000000000010", message.link)
        val route = OrbitLinks.parse(message.link!!)!!
        assertEquals(Destination.SCHEDULED, route.destination)
        assertEquals("019a0000-0000-7000-8000-000000000010", route.id)
    }

    @Test fun aSchedulePushWithoutItsScheduleIsRefused() {
        val data = sample("schedule-held")
        val payload = Json.parseToJsonElement(data.getValue("payload")).jsonObject - "scheduleID"
        assertNull(PushMessage.parse(data + ("payload" to JsonObject(payload).toString())))
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

    @Test fun theDrawerLeavesOutAFailingScheduleWhoseRunIsUnderWay() {
        val run = ScheduleRunView(id = "r-a", scheduleId = "a", plannedAt = "2026-11-19T02:00:00.000Z", state = "RUNNING")
        val schedules = listOf(view("a", failures = 3), view("b", state = "HELD"))
        assertEquals(1, ScheduledStore.State(schedules = schedules, listRuns = listOf(run)).needsYouCount)
        assertEquals("the run ended failing: counted again", 2,
            ScheduledStore.State(schedules = schedules, listRuns = listOf(run.copy(state = "FAILED"))).needsYouCount)
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

    @Test fun aChangeConversationOpensWithOrbitsOpeningAheadOfEveryRow() {
        // A change conversation (§8.2): the schedule-cards read's `change` leads the transcript, before the person's
        // first words, with no moment of its own; cards and records still go where they happened.
        val opening = ScheduleChangeOpening(scheduleId = schedule, title = "Codex stable check", revision = 3, does = "Checks",
            `when` = "Every day at 09:00", runsIn = "apiserver", may = "Check only", costs = "Up to 7 runs a week")
        val card = ScheduleCard(id = "c1", kind = "UPDATE", createdAt = "2026-11-14T10:05:00.000Z")
        val state = ScheduledStore.State(sessions = mapOf(ScheduledStore.key(session) to
            SessionScheduleCardsResponse(cards = listOf(card), records = emptyList(), change = opening)))
        val inserts = ScheduleInsert.of(state, ObjectId.toPublic(session))
        assertEquals(listOf("schedule-change-opening-$schedule", "schedule-card-c1"), inserts.map { it.key })
        val placed = ScheduleInsert.place(listOf("2026-11-14T10:00:00.000Z"), inserts)
        assertEquals(listOf("schedule-change-opening-$schedule"), placed[-1]?.map { it.key })
        assertEquals(listOf("schedule-card-c1"), placed[0]?.map { it.key })
        // An ordinary conversation reads no change, and draws none.
        assertEquals(emptyList<ScheduleInsert>(),
            ScheduleInsert.of(ScheduledStore.State(sessions = mapOf(ScheduledStore.key(session) to
                SessionScheduleCardsResponse(cards = emptyList(), records = emptyList()))), session))
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
