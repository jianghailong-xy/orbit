package io.orbitd.android.composer

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.directory.DirectorySession
import io.orbitd.android.directory.SessionHeader
import io.orbitd.android.directory.SessionLine
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * A session held by its runner's update as the server sends it: `src/shared/src/runner-update-held-session.fixture.json`, the
 * apiserver's own replies captured by turn-complete-draining.pg.spec.ts case 7 (the file web and OrbitKit test against) — a turn ended
 * on the draining runner with a follow-up queued and a dev server still up. Only the ids are rewritten to the controlled server's.
 * Held to: it reads queued behind the update (board 5 of docs/mocks/runner-update-drain), never Running, and Stop asks for the
 * background work too — the request case 7 shows the server accepting.
 */
class RunnerUpdateHeldShellTest : ComposerShellTest() {
    private val fixture: JsonObject = run {
        val file = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .map { File(it, "src/shared/src/runner-update-held-session.fixture.json") }.firstOrNull { it.isFile }
            ?: error("runner-update-held-session.fixture.json was not found above ${System.getProperty("user.dir")}")
        val text = file.readText()
        val captured = Wire.json.parseToJsonElement(text).jsonObject
        fun id(key: String) = captured.getValue(key).jsonObject.getValue("id").jsonPrimitive.content
        Wire.json.parseToJsonElement(text.replace(id("listRow"), ComposerShell.SESSION).replace(id("workspace"), ComposerShell.WORKSPACE)
            .replace(id("runner"), ComposerShell.RUNNER)).jsonObject
    }
    private val listRow get() = fixture.getValue("listRow").jsonObject
    private val detail get() = fixture.getValue("detail").jsonObject
    private val interrupt = "POST sessions/${ComposerShell.SESSION}/interrupt"

    /** The server's replies; [queue] false answers an empty queue, so the page has no message to put the account under. */
    private fun serve(events: List<JsonObject> = emptyList(), queue: Boolean = true) {
        fun ok(body: JsonElement): () -> ApiResponse = { ApiResponse(200, body.toString().encodeToByteArray()) }
        ComposerShell.workspace = fixture.getValue("workspace").jsonObject
        ComposerShell.runner = fixture.getValue("runner").jsonObject
        ComposerShell.events = events
        ComposerShell.answers["GET sessions"] = ok(JsonArray(listOf(listRow)))
        ComposerShell.answers["GET sessions/${ComposerShell.SESSION}"] = ok(detail)
        ComposerShell.answers["GET sessions/${ComposerShell.SESSION}/turns"] = ok(if (queue) fixture.getValue("queuedTurns") else JsonArray(emptyList()))
    }

    private fun text(tag: String) = compose.onNodeWithTag(tag, useUnmergedTree = true).fetchSemanticsNode()
        .config[SemanticsProperties.Text].joinToString("") { it.text }

    @Test fun theListRowAndStateWordReadTheUpdateNeverRunning() {
        assertEquals("runner_updating", listRow.getValue("queuedReason").jsonPrimitive.content)
        assertEquals("HOLD", listRow.getValue("waitingOn").jsonPrimitive.content)
        val row = Wire.json.decodeFromJsonElement<DirectorySession>(listRow)
        assertEquals(SessionLine("Runner updating", SessionLine.Tone.WARNING), SessionLine.make(row, live = true, machine = "studio-mac"))
        assertEquals("Runner updating", SessionHeader.statusWord(row))
        // The detail carries no gate of its own, and still does not read as running.
        val alone = Wire.json.decodeFromJsonElement<DirectorySession>(detail)
        assertEquals("On hold", SessionHeader.statusWord(alone))
        assertTrue("a queued session with background work offers Stop", hasSomethingToStop(detail))
    }

    /** Board 5's phone: the session's row with nothing in the conversation to show. */
    @Test fun theRowDrawsTheQueuedBlockWithItsTurnsAndActions() {
        serve(queue = false); signIn(); openSession()
        await { has(hasTestTag("runner-updating"), unmerged = true) && shows("Update Now…") }
        assertEquals("Runner updating", text("runner-updating:title"))
        assertEquals("studio-mac is updating to 0.1.254. It starts no new work until 2 turns finish: Backfill missing shard rows " +
            "and Why are 11-08 metrics zero. This session starts right after.", text("runner-updating:description"))
        assertTrue(text("runner-updating:waited").startsWith("Waiting "))
        assertTrue(shows("Later…"))
        assertFalse(shows("Running"))
    }

    @Test fun theQueuedMessageSaysRunnerUpdatingAndStopEndsTheBackgroundWork() {
        serve(listOf(ComposerShell.obj("""{"type":"user","seq":1,"turnId":"t-1","payload":{"text":"Why is the send stuck?"}}"""),
            ComposerShell.obj("""{"type":"turn_end","seq":2,"turnId":"t-1","payload":{"subtype":"success"}}""")))
        signIn(); openSession()
        await { has(hasTestTag("runner-updating-foot"), unmerged = true) }
        assertEquals("runner updating", text("runner-updating-foot:reason"))
        assertFalse(shows("Running"))
        val button = hasTestTag("composer-send")
        await { has(button and hasContentDescription("Stop") and isEnabled()) }
        compose.onNode(button).performClick()
        await { ComposerShell.body(interrupt) != null }
        assertEquals(buildJsonObject { put("stopBackgroundWork", true) }, ComposerShell.body(interrupt))
        // The tag opens the update's account, with the same two actions as the block.
        compose.onNodeWithTag("runner-updating-foot:reason", useUnmergedTree = true).performClick()
        await { has(hasTestTag("runner-updating-pop"), unmerged = true) && shows("Update Now…") }
        assertTrue(text("runner-updating-pop:text").startsWith(
            "studio-mac starts no new turns until 2 turns finish, then updates to 0.1.254. This message is sent right after."))
        assertTrue(shows("Later…"))
    }
}
