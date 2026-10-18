package io.orbitd.android.composer

import io.orbitd.android.composer.CursorRuntime.RunnerState
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * What only Cursor CLI has, read the way the runner and the server read it (web `lib/cursorRuntime.ts` and its spec, whose cases these
 * are): whether a runner can start it and what fixes it when not, whether a session has a conversation another account would have to
 * continue (P6b, D5), Auto, and the words the board puts beside each.
 */
class CursorRuntimeTest {
    private fun obj(json: String) = Json.parseToJsonElement(json).jsonObject
    private fun runner(capabilities: String = "\"provider:cursor\"", cursor: String? = null) =
        obj("""{"id":"r","capabilities":[$capabilities],"engines":[${cursor ?: ""}]}""")
    private val pinned = """{"engine":"cursor","installed":true,"version":"2026.10.14-941492e","auth":"yes"}"""

    @Test fun aRunnerThatDeclaresOrReportsCursorCliKnowsIt() {
        assertFalse(CursorRuntime.knows(null))
        assertFalse(CursorRuntime.knows(runner(capabilities = "")))
        assertTrue(CursorRuntime.knows(runner()))
        assertTrue(CursorRuntime.knows(runner(capabilities = "", cursor = """{"engine":"cursor","installed":false}""")))
    }

    /** The board's order of what is most fundamental: a runner that predates Cursor CLI, a platform the pinned build was never measured
     * on, a build other than the pinned one, none at all. */
    @Test fun aRunnerStateIsItsMostFundamentalReason() {
        assertEquals(RunnerState.READY, CursorRuntime.state(runner()))
        assertEquals(RunnerState.READY, CursorRuntime.state(runner(cursor = pinned)))
        assertEquals(RunnerState.UPDATE_RUNNER, CursorRuntime.state(runner(capabilities = "")))
        // The pinned build ready and still no declaration: no session driver for it, which an update brings.
        assertEquals(RunnerState.UPDATE_RUNNER, CursorRuntime.state(runner(capabilities = "", cursor = pinned)))
        assertEquals(RunnerState.UNSUPPORTED_PLATFORM, CursorRuntime.state(runner(capabilities = "", cursor = """{"engine":"cursor","installed":false,
            "installationError":"CURSOR_PLATFORM_UNSUPPORTED: Orbit runs Cursor CLI 2026.10.14-941492e only on linux/amd64 runners; this runner is darwin/arm64"}""")))
        assertEquals(RunnerState.UNSUPPORTED_VERSION, CursorRuntime.state(runner(cursor = """{"engine":"cursor","installed":true,"version":"2026.10.16-e3cb207",
            "installationError":"CURSOR_VERSION_INCOMPATIBLE: Cursor CLI 2026.10.16-e3cb207 is installed, and Orbit runs exactly 2026.10.14-941492e"}""")))
        assertEquals(RunnerState.NOT_INSTALLED, CursorRuntime.state(runner(cursor = """{"engine":"cursor","installed":false,
            "installationError":"CURSOR_NOT_INSTALLED: Cursor CLI 2026.10.14-941492e is not installed in Orbit's version directory"}""")))
        assertEquals(listOf(null, "Update runner", "Not supported here", "Unsupported version", "Not installed"), RunnerState.entries.map { it.label })
        assertEquals(listOf(RunnerState.UPDATE_RUNNER, RunnerState.UNSUPPORTED_PLATFORM, RunnerState.UNSUPPORTED_VERSION),
            RunnerState.entries.filter { it.blocksRow })
    }

    @Test fun eachBlockingStateSaysWhatFixesIt() {
        assertEquals("This runner predates Cursor CLI. It updates itself when no session is running on it.",
            CursorRuntime.hint(RunnerState.UPDATE_RUNNER, null))
        assertEquals("Orbit runs Cursor CLI 2026.10.14-941492e. Reinstall puts that version back on this runner; sessions here can’t start until then.",
            CursorRuntime.hint(RunnerState.UNSUPPORTED_VERSION, null))
        // A platform it doesn't run on is the runner's own sentence, which names both platforms.
        assertEquals("Orbit runs Cursor CLI 2026.10.14-941492e only on linux/amd64 runners; this runner is darwin/arm64.", CursorRuntime.hint(
            RunnerState.UNSUPPORTED_PLATFORM, obj("""{"installationError":"CURSOR_PLATFORM_UNSUPPORTED: Orbit runs Cursor CLI 2026.10.14-941492e only on linux/amd64 runners; this runner is darwin/arm64"}""")))
        assertEquals("Orbit doesn’t run Cursor CLI on this runner’s platform yet.", CursorRuntime.hint(RunnerState.UNSUPPORTED_PLATFORM, null))
        // Not installed has none: its row offers the install itself.
        assertNull(CursorRuntime.hint(RunnerState.NOT_INSTALLED, null))
        assertNull(CursorRuntime.hint(RunnerState.READY, null))
    }

    /** The server's own question before it moves a session (P6b): a turn settled, Cursor's conversation opened, or a turn running now. */
    @Test fun aSessionHasTalkedOnceATurnSettledItsConversationOpenedOrATurnRuns() {
        assertFalse(CursorRuntime.conversationStarted(null))
        assertFalse(CursorRuntime.conversationStarted(obj("""{"status":"AWAITING_INPUT","numTurns":0}""")))
        assertFalse(CursorRuntime.conversationStarted(obj("""{"status":"PENDING"}""")))
        assertTrue(CursorRuntime.conversationStarted(obj("""{"status":"AWAITING_INPUT","numTurns":2}""")))
        assertTrue(CursorRuntime.conversationStarted(obj("""{"status":"PENDING","runtimeSessionId":"0b4c…"}""")))
        assertTrue(CursorRuntime.conversationStarted(obj("""{"status":"RUNNING"}""")))
        assertTrue(CursorRuntime.conversationStarted(obj("""{"status":"AWAITING_INPUT","engineTurnActive":true}""")))
        assertFalse(CursorRuntime.conversationStarted(obj("""{"status":"AWAITING_INPUT","engineTurnActive":false}""")))
    }

    /** A talked session moves only where its runner can carry it (D5); a draft, or a session that has not talked, moves anywhere; no other
     * engine is held by this. */
    @Test fun aTalkedSessionMovesOnlyWhereItsRunnerCarriesIt() {
        val talked = obj("""{"status":"AWAITING_INPUT","numTurns":1}""")
        val fresh = obj("""{"status":"AWAITING_INPUT","numTurns":0}""")
        val carries = runner(capabilities = "\"provider:cursor\",\"cursor-account-move/v1\"")
        assertTrue(CursorRuntime.moveBlocked("cursor", talked, runner(), draft = false))
        assertFalse(CursorRuntime.moveBlocked("cursor", talked, carries, draft = false))
        assertFalse(CursorRuntime.moveBlocked("cursor", fresh, runner(), draft = false))
        assertFalse(CursorRuntime.moveBlocked("cursor", talked, runner(), draft = true))
        assertFalse(CursorRuntime.moveBlocked("claude", talked, runner(), draft = false))
        assertEquals("Cursor CLI can’t carry a conversation to another account or key yet. Start a new session to use one of these.",
            CursorRuntime.MOVE_BLOCKED_NOTE)
    }

    @Test fun autoIsItsCatalogueDefaultOrNoModelNamed() {
        assertTrue(CursorRuntime.onAuto("cursor", null))
        assertTrue(CursorRuntime.onAuto("cursor", ""))
        assertTrue(CursorRuntime.onAuto("cursor", "default"))
        assertFalse(CursorRuntime.onAuto("cursor", "claude-opus-5-5"))
        assertFalse(CursorRuntime.onAuto("claude", ""))
        assertEquals("Auto picks a model for each request. Cursor doesn’t report which one it used, and Auto has no effort or context to set.",
            CursorRuntime.AUTO_NOTE)
    }

    /** Default is refused and Don't Ask is enforced only in part: the shared permissionSemantics' shortNotes, as the board's subtitles
     * capitalise them. A mode that can't run falls back to Accept Edits on Cursor CLI, to Default elsewhere. */
    @Test fun theModesSayWhatTheyDoOnCursorCli() {
        assertEquals("Unsupported on Cursor CLI; session configuration is rejected", CursorRuntime.modeNote("default"))
        assertEquals("Partly enforced, edits inside the workspace still run", CursorRuntime.modeNote("dontAsk"))
        for (mode in listOf("acceptEdits", "plan", "auto", "bypassPermissions")) assertNull(mode, CursorRuntime.modeNote(mode))
        assertEquals("acceptEdits", CursorRuntime.fallbackMode("cursor"))
        assertEquals("default", CursorRuntime.fallbackMode("dsh"))
    }

    @Test fun theTrayThePlaceholderAndTheContextSayWhyAsTheBoardDoes() {
        assertEquals("Cursor CLI can’t take a message mid-turn — sending one would stop the turn. These go in order once it ends.", CursorRuntime.QUEUE_NOTE)
        assertEquals("Reply — it goes to Cursor CLI when this turn ends…", CursorRuntime.RUNNING_PLACEHOLDER)
        assertEquals("Cursor CLI doesn’t report how much of the window a session has used, so there is no reading to show.", CursorRuntime.CONTEXT_UNAVAILABLE)
        assertEquals("/providers/new/cursor-api", CursorRuntime.CONNECT_PATH)
    }
}
