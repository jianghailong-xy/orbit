package io.orbitd.android.core.protocol

import io.orbitd.android.core.cards.ModeCapsule
import io.orbitd.android.core.cards.ModeCapsule.Gap
import io.orbitd.android.core.cards.PermissionModeDisplay
import java.time.Instant
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

/**
 * The mode facts as a real apiserver on PostgreSQL answered them (resources/wire/permission-mode, written through the server's
 * own claim, config and runner-event doors and read back over HTTP): what Android decodes from each, and the board's words for each.
 */
class PermissionModesWireTest {
    private fun fixture(name: String) = Wire.json.parseToJsonElement(
        javaClass.getResourceAsStream("/wire/permission-mode/$name.json")!!.use { it.readBytes() }.decodeToString())
    private fun session(name: String) = fixture("session-$name").jsonObject

    /** The control for a captured session, read at [now] — by default the moment of its newest change, as a client reads it then. */
    private fun capsule(detail: JsonObject, noAutoModel: String? = null, runsAsRoot: Boolean = false,
        now: Instant = Instant.parse(PermissionModes.changes(detail).last().at).plusSeconds(5)) =
        PermissionModeDisplay.capsule(PermissionModes.intent(detail)!!, PermissionModes.actual(detail), PermissionModes.reported(detail),
            beforeStart = false, latest = PermissionModes.changes(detail).lastOrNull(), noAutoModel = noAutoModel, runsAsRoot = runsAsRoot,
            scheduledOnClaude = false, now = now)

    @Test fun everyCapturedSessionDecodesItsIntentTheModeRunningAndItsChanges() {
        val expected = mapOf(
            "running-auto" to Triple("auto", "auto", listOf("CLAIM")),
            "correcting" to Triple("auto", "default", listOf("CLAIM", "ENGINE_REPORT")),
            "corrected" to Triple("auto", "auto", listOf("CLAIM", "ENGINE_REPORT", "RUNNER_CORRECTION")),
            "no-auto-model" to Triple("auto", "default", listOf("CLAIM", "OWNER_PICK")),
            "root-runner" to Triple("bypassPermissions", "auto", listOf("CLAIM")),
            "pick-on-its-way" to Triple("plan", "auto", listOf("CLAIM")),
            "every-cause" to Triple("auto", "default", listOf("CLAIM", "ENGINE_REPORT", "RUNNER_CORRECTION", "OWNER_PICK", "OWNER_PICK",
                "OWNER_PICK", "RESPAWN", "RUNNER_CORRECTION", "ORBIT_CHANGE", "OWNER_PICK", "OWNER_PICK")),
        )
        for ((name, want) in expected) {
            val detail = session(name)
            assertTrue(name, PermissionModes.reported(detail))
            assertEquals(name, want.first, PermissionModes.intent(detail))
            assertEquals(name, want.second, PermissionModes.actual(detail))
            val changes = PermissionModes.changes(detail)
            assertEquals(name, want.third, changes.map { it.cause })
            // Every entry the server sent was read: none left out as unreadable.
            assertEquals(name, (detail["permissionModeChanges"] as JsonArray).size, changes.size)
            assertNull(name, changes.first().fromMode)
            assertEquals(name, changes.last().toMode, PermissionModes.actual(detail))
            assertNotNull(name, PermissionModes.actualAt(detail)?.let(Instant::parse))
            assertTrue(name, changes.all { runCatching { Instant.parse(it.at) }.isSuccess })
            // A claimed, live session: the facts the control decides "before a start" by.
            assertEquals(name, false, SessionFacts.released(detail))
            assertEquals(name, "RUNNING", SessionFacts.phase(detail))
        }
        // Who made each change, as the server records it: the app for the owner's, "orbit" for Orbit's own.
        assertEquals(listOf(null, null, null, "web", "ios", "android", null, null, "orbit", "android", "android"),
            PermissionModes.changes(session("every-cause")).map { it.client })
    }

    @Test fun theOpenListsRowsCarryTheModeRunningAndNoHistory() {
        val rows = fixture("sessions-open").let { it as? JsonArray ?: it.jsonObject["sessions"]!!.jsonArray }.map { it.jsonObject }
        assertEquals(6, rows.size)
        for (row in rows) {
            assertTrue(PermissionModes.reported(row))
            assertNotNull(PermissionModes.intent(row)); assertNotNull(PermissionModes.actual(row)); assertNotNull(PermissionModes.actualAt(row))
            assertTrue(PermissionModes.changes(row).isEmpty())
        }
        assertEquals(setOf("auto" to "auto", "auto" to "default", "bypassPermissions" to "auto", "plan" to "auto"),
            rows.map { PermissionModes.intent(it) to PermissionModes.actual(it) }.toSet())
    }

    /** ① and ② (A1) from the server's own payloads. */
    @Test fun theBoardsControlForEachCapturedSession() {
        assertEquals(ModeCapsule("Auto"), capsule(session("running-auto")))
        assertEquals(ModeCapsule("Auto"), capsule(session("corrected")))
        // Claude's report, read while the runner switches it back, and a minute on (the same session as "corrected", read earlier).
        val correcting = session("correcting")
        assertEquals(ModeCapsule("Default → Auto", Gap.CORRECTING, ModeCapsule.Head("Running in Default.",
            "Claude started below the Auto you asked for; the runner is switching it to Auto now.")), capsule(correcting))
        val reported = Instant.parse(PermissionModes.changes(correcting).last().at)
        assertEquals(Gap.STANDING, capsule(correcting, now = reported.plusSeconds(61)).gap)
        assertEquals(ModeCapsule("Default", Gap.STANDING, ModeCapsule.Head("Running in Default.",
            "You asked for Auto, but Haiku 4.5 has no Auto. Pick a model with Auto to get it back.")),
            capsule(session("no-auto-model"), noAutoModel = "Haiku 4.5"))
        assertEquals(ModeCapsule("Auto", Gap.STANDING, ModeCapsule.Head("Running in Auto.", "You asked for Bypass, which can’t run on a root runner.")),
            capsule(session("root-runner"), runsAsRoot = true))
        assertEquals(ModeCapsule("Auto", Gap.STANDING, ModeCapsule.Head("Running in Auto.", "You asked for Plan.")), capsule(session("pick-on-its-way")))
    }

    /** ③ (B1): the transcript's lines for the session that went through every cause, and the root runner's claim. */
    @Test fun theBoardsLinesFromTheCapturedChanges() {
        val every = session("every-cause")
        val lines = PermissionModeDisplay.lines(PermissionModes.changes(every), PermissionModes.intent(every), PermissionModes.actual(every),
            noAutoModel = "Haiku 4.5", runsAsRoot = false, scheduledOnClaude = false)
        assertEquals(listOf(
            "Started in Auto",
            "Mode set back to Auto by the runner — Claude had started in Default",
            "Mode set to Plan by you, on the web",
            "Mode set to Accept Edits by you, on iOS",
            "Mode set to Auto by you, on Android",
            "Mode set back to Auto by the runner — Claude had restarted in Default",
            "Mode set to Default by Orbit",
            "Mode set to Auto by you, on Android",
            "Mode now Default — you picked Haiku 4.5, which has no Auto",
        ), lines.map { it.text })
        assertEquals(listOf(false, false, false, false, false, false, false, false, true), lines.map { it.gap })
        val root = session("root-runner")
        val claim = PermissionModeDisplay.lines(PermissionModes.changes(root), PermissionModes.intent(root), PermissionModes.actual(root),
            noAutoModel = null, runsAsRoot = true, scheduledOnClaude = false).single()
        assertEquals("Started in Auto, not Bypass — Bypass can’t run on a root runner", claim.text)
        assertTrue(claim.gap)
    }

    /** The runner the composer's catalogue is read from: Haiku 4.5's row withholds Auto, and the root runner says it runs as root. */
    @Test fun theCapturedRunnersSayWhichModelsHaveAutoAndWhichRunsAsRoot() {
        val runners = fixture("runners").let { it as? JsonArray ?: it.jsonObject["runners"]!!.jsonArray }.map { it.jsonObject }
        val byName = runners.associateBy { (it["name"] as kotlinx.serialization.json.JsonPrimitive).content }
        assertEquals("true", byName.getValue("root-runner")["runsAsRoot"].toString())
        assertEquals("false", byName.getValue("workstation-gpu")["runsAsRoot"].toString())
        val catalog = byName.getValue("workstation-gpu")["modelCatalog"]!!.jsonObject["claude"]!!.jsonArray.map { it.jsonObject }
        val modes = catalog.associate { it["value"].toString().trim('"') to it["permissionModes"]!!.jsonArray.map { m -> m.toString().trim('"') } }
        assertTrue("auto" in modes.getValue("claude-opus-5-5"))
        assertFalse("auto" in modes.getValue("claude-haiku-4-5"))
    }
}
