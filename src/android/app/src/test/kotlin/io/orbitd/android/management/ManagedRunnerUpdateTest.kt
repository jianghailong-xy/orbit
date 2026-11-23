package io.orbitd.android.management

import io.orbitd.android.composer.ManagedBuild
import io.orbitd.android.composer.ManagedBusy
import io.orbitd.android.composer.ManagedBusyTurn
import io.orbitd.android.composer.ManagedPendingUpdate
import io.orbitd.android.composer.ManagedRunner
import io.orbitd.android.composer.ManagedRunnerRunningBuild
import io.orbitd.android.composer.ManagedRunnerUpdateLogic
import io.orbitd.android.composer.ManagedUpdate
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.JsonObject
import java.time.Instant
import java.time.ZoneOffset
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ManagedRunnerUpdateTest {
    private fun <T : Any> req(value: T?): T { org.junit.Assert.assertNotNull(value); return value!! }
    private val utc = ZoneOffset.UTC
    private val running = ManagedBuild("95884b1aaaa", "2026-11-16T10:00:00Z")
    private val current = ManagedBuild("1a2b3c4dddd", "2026-11-22T10:00:00Z")
    private val now = 1_795_000_000_000L

    private fun status(update: ManagedUpdate?, state: String = "READY") = ManagedRunner.Status(
        1, true, 3, state, "RUNNING", "runner-1", true, null, null, "claude", "claude", false, false, false, update)

    @After fun reset() { ManagedRunnerRunningBuild.build = null }

    @Test fun available_owner_card_has_update_now() {
        val card = req(ManagedRunnerUpdateLogic.card(status(ManagedUpdate(running, current, "available")), zone = utc))
        assertEquals("available", card.phase)
        assertEquals("The Nov 22 build is available", card.title)
        assertEquals("Available", card.tag)
        assertEquals("It moves the next time this runner is idle. Update Now restarts it on the new build now — usually under a minute. Your files, sign-ins and sessions stay.", card.body)
        assertTrue(card.canUpdateNow)
        assertTrue(ManagedRunnerUpdateLogic.showsDot(status(ManagedUpdate(running, current, "available"))))
    }

    @Test fun non_owner_sees_the_card_without_the_button() {
        val card = req(ManagedRunnerUpdateLogic.card(status(ManagedUpdate(running, current, "available")), isOwner = false, zone = utc))
        assertEquals("available", card.phase)
        assertFalse(card.canUpdateNow)
    }

    @Test fun current_runner_has_no_card_and_no_dot() {
        assertNull(ManagedRunnerUpdateLogic.card(status(null), zone = utc))
        assertFalse(ManagedRunnerUpdateLogic.showsDot(status(null)))
    }

    @Test fun busy_confirmation_names_turns_and_jobs() {
        val busy = ManagedBusy(listOf(ManagedBusyTurn("s1", "Fix login redirect", "2026-11-22T09:42:00Z"), ManagedBusyTurn("s2", null, null)), 2)
        val at = Instant.parse("2026-11-22T10:00:00Z").toEpochMilli()
        val c = ManagedRunnerUpdateLogic.confirmation(busy, current, at, utc)
        assertEquals("Update Orbit Cloud now?", c.title)
        assertEquals("It stops these turns and restarts on the Nov 22 build — usually under a minute. Each one then continues where it stopped, with a note that the update interrupted it.", c.body)
        assertEquals(listOf("Fix login redirect · running 18 min", "Untitled session"), c.turns)
        assertEquals("2 background jobs in these sessions stop, and so do the services they started. Waiting work starts once it is back.", c.jobsNote)
        assertEquals("Interrupt 2 Turns and Update", c.confirm)
    }

    @Test fun busy_answer_is_read_from_the_409_body_only() {
        val body = """{"code":"MANAGED_RUNNER_BUSY","turns":[{"sessionId":"s1","title":"T","startedAt":"2026-11-22T09:42:00Z"}],"backgroundJobs":1}"""
        val busy = req(ManagedRunnerUpdateLogic.busy(ApiError.parse(409, body.encodeToByteArray())))
        assertEquals(1, busy.turns.size)
        assertEquals(1, busy.backgroundJobs)
        assertNull(ManagedRunnerUpdateLogic.busy(ApiError.parse(409, """{"code":"MANAGED_RUNNER_CURRENT"}""".encodeToByteArray())))
        assertNull(ManagedRunnerUpdateLogic.busy(ApiError.parse(500, body.encodeToByteArray())))
    }

    @Test fun restarting_card_says_interrupted_turns_and_has_no_button() {
        val s = status(ManagedUpdate(running, current, "updating"))
        val card = req(ManagedRunnerUpdateLogic.card(s, pendingTurns = 2, zone = utc))
        assertEquals("Restarting on the Nov 22 build…", card.title)
        assertEquals("Restarting", card.tag)
        assertEquals("2 interrupted turns continue once it is back. Usually under a minute.", card.body)
        assertFalse(card.canUpdateNow)
        assertFalse(ManagedRunnerUpdateLogic.showsDot(s))
    }

    @Test fun restarting_comes_from_the_server_alone_never_from_a_press_remembered() {
        // An Update Now noted with one interrupted turn, which the server did not take (or which ended unwatched): the
        // status says available, so the card is Available with its button, not Restarting (production, 2026-11-23).
        val card = req(ManagedRunnerUpdateLogic.card(status(ManagedUpdate(running, current, "available")), pendingTurns = 1, zone = utc))
        assertEquals("available", card.phase)
        assertTrue(card.canUpdateNow)
        assertFalse(card.body.contains("interrupted"))
    }

    @Test fun updated_card_follows_a_finished_restart_for_a_day() {
        val before = status(ManagedUpdate(running, current, "updating"))
        val after = status(null)
        val pending = ManagedPendingUpdate(now - 34_000, 2, current)
        val updated = req(ManagedRunnerUpdateLogic.observe(before, after, null, pending, now))
        val card = req(ManagedRunnerUpdateLogic.card(after, updated, nowMs = now, zone = utc))
        assertEquals("Updated to the Nov 22 build", card.title)
        assertEquals("Updated", card.tag)
        assertEquals("Took 34 s. 2 interrupted turns resumed.", card.body)
        assertFalse(card.canUpdateNow)
        assertNull(ManagedRunnerUpdateLogic.card(after, updated, nowMs = now + 25 * 3_600_000L, zone = utc))
        assertNull(ManagedRunnerUpdateLogic.observe(before, status(ManagedUpdate(running, current, "available")), updated, pending, now))
    }

    @Test fun version_line_names_the_build() {
        assertEquals("Build 95884b1 · Nov 16", ManagedRunnerUpdateLogic.buildLine(running, utc))
        assertEquals("Build 95884b1", ManagedRunnerUpdateLogic.buildLine(ManagedBuild("95884b1aaaa"), utc))
        val runner = Wire.json.parseToJsonElement("""{"id":"r","version":"managed-95884b1"}""") as JsonObject
        ManagedRunnerRunningBuild.build = running
        assertTrue(RunnerPage.versionLine("managed-95884b1", managed = true)!!.startsWith("Build 95884b1"))
        assertTrue(RunnerPage.versionValue(runner, null, managed = true)!!.startsWith("Build 95884b1"))
        ManagedRunnerRunningBuild.build = null
        assertEquals("Kept up to date by Orbit", RunnerPage.versionLine("managed-95884b1", managed = true))
        assertEquals("Kept up to date by Orbit", RunnerPage.versionLine(null, managed = true))
    }

    @Test fun release_versions_name_the_card_the_confirmation_and_the_version_line() {
        val from = ManagedBuild("", null, "0.1.261-beta.82")
        val to = ManagedBuild("1a2b3c4dddd", "2026-11-22T10:00:00Z", "0.1.261-beta.83")
        val available = ManagedRunnerUpdateLogic.card(status(ManagedUpdate(from, to, "available")), zone = utc)!!
        assertEquals("0.1.261-beta.83 is available", available.title)
        val restarting = ManagedRunnerUpdateLogic.card(status(ManagedUpdate(from, to, "updating")), zone = utc)!!
        assertEquals("Restarting on 0.1.261-beta.83…", restarting.title)
        val updated = ManagedRunnerUpdateLogic.card(status(null), updated = io.orbitd.android.composer.ManagedUpdated(to, now), nowMs = now, zone = utc)!!
        assertEquals("Updated to 0.1.261-beta.83", updated.title)
        val c = ManagedRunnerUpdateLogic.confirmation(ManagedBusy(emptyList(), 0), to, now, utc)
        assertTrue(c.body.contains("restarts on 0.1.261-beta.83"))
        assertEquals("v0.1.261-beta.82", RunnerPage.versionLine("0.1.261-beta.82", managed = true))
    }

    @Test fun an_update_without_a_version_keeps_the_build_wording() {
        val card = ManagedRunnerUpdateLogic.card(status(ManagedUpdate(running, current, "available")), zone = utc)!!
        assertEquals("The Nov 22 build is available", card.title)
        ManagedRunnerRunningBuild.build = running
        assertTrue(RunnerPage.versionLine("managed-95884b1aaaa", managed = true)!!.startsWith("Build 95884b1"))
    }
}
