package io.orbitd.android.directory

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.directory.SessionLine.Tone
import java.time.Instant
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Somebody outside Orbit — a connected Feishu group's member (docs/feishu-bot-design.md §8.2) — as the session row names them:
 * `From Feishu · <name>: …`, never "You". OrbitKit's `ExternalSenderTests` and the web's `externalSender` cases, case for case;
 * ExternalSenderCopyParityTest holds the words to both. */
class ExternalSenderTest {
    private val now = Instant.parse("2026-11-08T10:00:00Z")
    private val ask = "Can you also check why the export **failed last night**?"
    private fun feishu(name: String? = "Li Lei"): JsonElement = buildJsonObject { put("source", "FEISHU"); put("name", name) }
    private fun guest(name: String? = "Alice Chen"): JsonElement = buildJsonObject { put("source", "ORBIT_GUEST"); put("name", name) }

    private fun session(status: String, lastAssistantText: String? = null, lastToolUse: String? = null, lastUserText: String? = ask,
        lastUserFrom: SessionMessageFrom? = null, lastUserFromOrbit: JsonElement? = null, lastUserFromExternal: JsonElement? = feishu(),
        pendingApprovals: Int = 0) =
        DirectorySession("s", "t", status = status, lastAssistantText = lastAssistantText, lastToolUse = lastToolUse,
            lastUserText = lastUserText, lastUserFrom = lastUserFrom, lastUserFromOrbit = lastUserFromOrbit,
            lastUserFromExternal = lastUserFromExternal, pendingApprovals = pendingApprovals)
    private fun line(s: DirectorySession, live: Boolean = true) = SessionLine.make(s, live, now = now)

    @Test fun readsAFeishuSenderAndNothingElse() {
        assertEquals(ExternalMessageFrom("Li Lei"), ExternalSender.parse(feishu()))
        assertEquals("a name is trimmed", ExternalMessageFrom("Li Lei"), ExternalSender.parse(feishu("  Li Lei \n")))
        assertEquals("a blank name is none", ExternalMessageFrom(null), ExternalSender.parse(feishu(" ")))
        assertEquals(ExternalMessageFrom(null), ExternalSender.parse(feishu(null)))
        assertEquals(ExternalMessageFrom(null), ExternalSender.parse(buildJsonObject { put("source", "FEISHU") }))
        assertEquals("a name that is no string is none", ExternalMessageFrom(null),
            ExternalSender.parse(buildJsonObject { put("source", "FEISHU"); put("name", 7) }))
        assertNull("a source this build does not know", ExternalSender.parse(buildJsonObject { put("source", "SLACK"); put("name", "x") }))
        assertNull(ExternalSender.parse(buildJsonObject { put("name", "Li Lei") }))
        assertNull(ExternalSender.parse(JsonNull))
        assertNull(ExternalSender.parse(JsonPrimitive("FEISHU")))
        assertNull(ExternalSender.parse(null))
    }

    /** A guest the owner invited (docs/session-guests-design.md §3) is an Orbit account, which always has a name: one without it is no
     * guest this build can name (OrbitKit `testReadsAGuestOnlyWithTheirName`). */
    @Test fun readsAGuestOnlyWithTheirName() {
        assertEquals(ExternalMessageFrom("Alice Chen", "ORBIT_GUEST"), ExternalSender.parse(guest(" Alice Chen ")))
        assertNull(ExternalSender.parse(guest(null)))
        assertNull(ExternalSender.parse(guest("  ")))
        assertNull(ExternalSender.parse(buildJsonObject { put("source", "ORBIT_GUEST") }))
        assertNull(ExternalSender.parse(buildJsonObject { put("source", "ORBIT_GUEST"); put("name", 7) }))
    }

    @Test fun theGuestsLabelIsFromAndTheirName() {
        assertEquals("From Alice Chen", ExternalSender.label(ExternalMessageFrom("Alice Chen", "ORBIT_GUEST")))
    }

    @Test fun theRowNamesAGuestInsteadOfYou() {
        val named = SessionLine("From Alice Chen: Can you also check why the export failed last night?", Tone.PREVIEW)
        assertEquals(named, line(session("RUNNING", "previous reply", lastUserFromExternal = guest())))
        assertEquals(named, line(session("AWAITING_INPUT", "previous reply", lastUserFromExternal = guest())))
        assertEquals(named, line(session("FAILED", lastUserFromExternal = guest()), live = false))
        fun row(extra: String) = Wire.json.decodeFromString(DirectorySession.serializer(), """{"id":"s1","status":"RUNNING","lastUserText":"Fix the build"$extra}""")
        assertEquals("From Alice Chen: Fix the build", line(row(""","lastUserFromExternal":{"source":"ORBIT_GUEST","name":"Alice Chen"}""")).text)
        assertEquals("nameless, it reads as the turn always has", "You: Fix the build",
            line(row(""","lastUserFromExternal":{"source":"ORBIT_GUEST","name":null}""")).text)
    }

    @Test fun labelsTheSenderWithItsNameOrFeishuAlone() {
        assertEquals("From Feishu · Li Lei", ExternalSender.label(ExternalMessageFrom("Li Lei")))
        assertEquals("From Feishu", ExternalSender.label(ExternalMessageFrom(null)))
    }

    @Test fun theRowNamesTheSenderWhileTheTurnRunsAfterItStoppedAndInTrash() {
        val named = SessionLine("From Feishu · Li Lei: Can you also check why the export failed last night?", Tone.PREVIEW)
        assertEquals(named, line(session("RUNNING", "previous reply")))
        assertEquals(named, line(session("AWAITING_INPUT", "previous reply")))
        assertEquals(named, line(session("INTERRUPTED")))
        assertEquals(named, line(session("FAILED"), live = false))
        assertEquals(SessionLine("From Feishu: Please rerun the export for October.", Tone.PREVIEW),
            line(session("RUNNING", lastUserText = "Please rerun the export for October.", lastUserFromExternal = feishu(null))))
    }

    /** One message has one sender; the row asks Orbit first, then somebody outside Orbit, then another session — the Swift's order. */
    @Test fun orbitThenTheOutsiderThenAnotherSession() {
        val orbit = buildJsonObject { put("coordinatorDelivery", JsonNull) }
        assertEquals("Orbit: Can you also check why the export failed last night?", line(session("RUNNING", lastUserFromOrbit = orbit)).text)
        assertEquals("From Feishu · Li Lei: Can you also check why the export failed last night?",
            line(session("RUNNING", lastUserFrom = SessionMessageFrom("s2", "Build"))).text)
        assertEquals("You: Can you also check why the export failed last night?",
            line(session("RUNNING", lastUserFromExternal = buildJsonObject { put("source", "SLACK") })).text)
    }

    @Test fun changesNothingAboveTheMessageAndASenderWithNoMessageMakesNoLine() {
        assertEquals(SessionLine("Running Bash…", Tone.RUNNING), line(session("RUNNING", lastToolUse = "Bash")))
        assertEquals(SessionLine("Waiting for approval", Tone.APPROVAL), line(session("AWAITING_INPUT", pendingApprovals = 1)))
        assertEquals(SessionLine("On it.", Tone.PREVIEW), line(session("AWAITING_INPUT", "On it.", lastUserText = null)))
    }

    /** A row's `lastUserFromExternal`: an object of a known source names the sender; null, a missing key (an older server) and a source
     * this build does not know are no sender, and the list still decodes. */
    @Test fun decodesTheSenderFromARow() {
        fun row(extra: String) = Wire.json.decodeFromString(DirectorySession.serializer(), """{"id":"s1","status":"RUNNING","lastUserText":"Done"$extra}""")
        assertEquals("From Feishu · Li Lei: Done", line(row(""","lastUserFromExternal":{"source":"FEISHU","name":"Li Lei"}""")).text)
        assertEquals("From Feishu: Done", line(row(""","lastUserFromExternal":{"source":"FEISHU","name":null}""")).text)
        assertEquals("You: Done", line(row(""","lastUserFromExternal":null""")).text)
        assertEquals("You: Done", line(row("")).text)
        assertEquals("You: Done", line(row(""","lastUserFromExternal":{"source":"TEAMS","name":"x"}""")).text)
        assertEquals("You: Done", line(row(""","lastUserFromExternal":"FEISHU"""")).text)
    }
}
