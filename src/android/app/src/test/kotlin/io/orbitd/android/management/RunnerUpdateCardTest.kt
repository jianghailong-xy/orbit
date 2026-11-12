package io.orbitd.android.management

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.time.Instant
import java.time.ZoneId

/**
 * The runner page's Update card (docs/runner-update-drain-design.md §4, board 4), one per phase the runner reports — OrbitKit
 * RunnerUpdateCardTests at this end. The reports are src/shared/src/runner-self-update.fixture.json's, which the Go runner writes
 * field for field. Missing file is a failure.
 */
class RunnerUpdateCardTest {
    private val utc = ZoneId.of("UTC")

    private val fixture: Map<String, JsonObject> by lazy {
        var dir: File? = File("").absoluteFile
        repeat(8) {
            val candidate = File(dir, "src/shared/src/runner-self-update.fixture.json")
            if (candidate.isFile) return@lazy Json.parseToJsonElement(candidate.readText()).jsonObject["cases"]!!.jsonArray
                .associate { it.jsonObject["name"]!!.jsonPrimitive.content to it.jsonObject["report"]!!.jsonObject }
            dir = dir?.parentFile
        }
        fail("runner-self-update.fixture.json not found above ${File("").absolutePath}"); emptyMap()
    }

    /** A runner on 0.1.253 reporting the fixture's [name] case, edited first. */
    private fun runner(name: String, edit: MutableMap<String, JsonElement>.() -> Unit = {}): JsonObject = buildJsonObject {
        put("id", "0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e31"); put("name", "studio-mac"); put("version", "0.1.253")
        put("online", true); put("runsAsRoot", false)
        put("selfUpdate", JsonObject(fixture.getValue(name).toMutableMap().apply(edit)))
    }

    private fun ms(iso: String) = Instant.parse(iso).toEpochMilli()

    @Test fun availableIsQuietAndSaysWhenItInstalls() {
        val r = runner("available")
        assertEquals(RunnerPage.UpdateCard("available", false, "0.1.254 is available", "Available",
            "It installs when no turn is running. If turns keep running for an hour, it stops taking new work so they can finish."),
            RunnerPage.updateCard(r, ms("2023-11-14T22:33:20Z"), utc))
        assertEquals("0.1.253 · 0.1.254 installs when no turn is running", RunnerPage.versionValue(r, "0.1.254"))
    }

    @Test fun drainingCountsTheTurnsAndTheTimeAndAboutSaysUpdatingTo() {
        val r = runner("draining") { put("turnsInFlight", JsonPrimitive(2)); put("turnsAtDrain", JsonPrimitive(8)) }
        // 38 min after the drain began (23:13:20Z).
        assertEquals(RunnerPage.UpdateCard("draining", true, "Updating to 0.1.254", "Not taking new work",
            "0.1.254 has been waiting since 22:13. After an hour it stopped taking new work so the turns in flight can finish; " +
                "then it installs and restarts.",
            progressLabel = "Waiting for 2 of 8 turns · 38 min", progress = 0.75f),
            RunnerPage.updateCard(r, ms("2023-11-14T23:51:20Z"), utc))
        assertEquals("0.1.253 · updating to 0.1.254", RunnerPage.versionValue(r, "0.1.254"))
    }

    @Test fun drainingFromARunnerThatDidNotCountTheTurnsAtTheStart() {
        val r = runner("draining") { remove("availableSince"); remove("turnsAtDrain") }
        val card = RunnerPage.updateCard(r, ms("2023-11-15T01:05:20Z"), utc)!!
        assertEquals(RunnerCopy.UPDATE_DRAINING_BODY_NO_SINCE, card.body)
        assertEquals("Waiting for 1 turn · 1 h 52 min", card.progressLabel)
        assertEquals(0f, card.progress)
    }

    @Test fun restartingIsAmberWithNoBar() {
        val r = runner("restarting")
        assertEquals(RunnerPage.UpdateCard("restarting", true, "Restarting into 0.1.254…", "Restarting", "Usually under a minute."),
            RunnerPage.updateCard(r, ms("2023-11-15T00:00:00Z"), utc))
        assertEquals("0.1.253 · updating to 0.1.254", RunnerPage.versionValue(r, "0.1.254"))
    }

    @Test fun postponedSaysUntilWhenAndWhatHappensThen() {
        assertEquals(RunnerPage.UpdateCard("postponed", false, "0.1.254 postponed until 02:00", "Postponed",
            "Taking work as usual. At 02:00 it waits for the turns in flight again, for up to an hour."),
            RunnerPage.updateCard(runner("postponed"), ms("2023-11-14T23:00:00Z"), utc))
    }

    @Test fun anOldRunnerHasNoCardAndKeepsTodaysWording() {
        val r = runner("oldRunner")
        assertNull(RunnerPage.updateCard(r, System.currentTimeMillis(), utc))
        assertEquals("0.1.253 · 0.1.254 installs when no turn is running", RunnerPage.versionValue(r, "0.1.254"))
        assertNull(RunnerPage.updateCard(runner("oldRunner") { put("phase", JsonPrimitive("installing")); put("targetVersion", JsonPrimitive("0.1.254")) },
            System.currentTimeMillis(), utc))
    }

    /** The same words as OrbitKit's RunnerPageCopy, which RunnerPageCopyParityTests holds to the web's. */
    @Test fun theWordsAreOrbitKits() {
        var dir: File? = File("").absoluteFile
        var swift: String? = null
        repeat(8) {
            val candidate = File(dir, "src/macos/OrbitKit/Sources/OrbitKit/App/RunnerPageCopy.swift")
            if (swift == null && candidate.isFile) swift = candidate.readText()
            dir = dir?.parentFile
        }
        val flat = swift!!.replace(Regex("\"\\s*\\+\\s*\""), "").replace(Regex("\\s+"), " ")
        for (words in listOf(RunnerCopy.UPDATE_TAG_AVAILABLE, RunnerCopy.UPDATE_TAG_DRAINING, RunnerCopy.UPDATE_TAG_RESTARTING,
            RunnerCopy.UPDATE_TAG_POSTPONED, RunnerCopy.UPDATE_AVAILABLE_BODY, RunnerCopy.UPDATE_DRAINING_BODY_NO_SINCE,
            RunnerCopy.UPDATE_RESTARTING_BODY)) {
            assertTrue("RunnerPageCopy.swift does not say \"$words\"", flat.contains("\"$words\""))
        }
        assertTrue(flat.contains("Taking work as usual. At \\(until) it waits for the turns in flight again, for up to an hour."))
        assertTrue(flat.contains("has been waiting since \\(since). After an hour it stopped taking new work so the turns in flight can finish; then it installs and restarts."))
    }

    /** The runner page draws the card above Needs Attention. */
    @Test fun theRunnerPageDrawsTheCard() {
        var dir: File? = File("").absoluteFile
        var screens = ""
        repeat(8) {
            val candidate = File(dir, "src/android/app/src/main/kotlin/io/orbitd/android/management/RunnerScreens.kt")
            if (screens.isEmpty() && candidate.isFile) screens = candidate.readText()
            dir = dir?.parentFile
        }
        assertTrue(screens.contains("RunnerPage.updateCard(runner, now)?.let { UpdateCardView(it) }"))
    }
}
