package io.orbitd.android.composer

import androidx.compose.ui.test.*
import io.orbitd.android.core.net.ApiResponse
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * The composer's Stop on the session page, over the controlled server (A07-20; iOS 593920cea and f4e1b0efa): with nothing typed, Send is
 * Stop wherever there is something to stop — a background process or a sub-agent still at work under a parked turn, a turn the engine
 * started for itself, a running turn — and a disabled Send on an idle session. The press asks for the session's background work to end
 * with the turn. The tray's Steer and Send's Queue for next turn are still a running turn's alone.
 */
class StopShellTest : ComposerShellTest() {
    private val interrupt = "POST sessions/${ComposerShell.SESSION}/interrupt"
    private val turns = "POST sessions/${ComposerShell.SESSION}/turns"
    private val button = hasTestTag("composer-send")
    private var seq = 0

    /** The session's detail takes [fields] over the parked fixture's, and the server says so down its stream. */
    private fun becomes(fields: String) {
        ComposerShell.session = ComposerShell.fields(fields)
        ComposerShell.push("""{"type":"status","seq":${++seq},"payload":{}}""")
    }

    @Test fun stopIsOfferedWhereverThereIsSomethingToStopAndItsPressEndsTheBackgroundWork() {
        signIn(); openSession()
        await { has(button and hasText("Send")) }
        compose.onNode(button).assertIsNotEnabled()
        // Parked, with a dev server the turn left running: Stop, and its press asks for that to end too.
        becomes("""{"runningBgShells":["bg-1"]}""")
        await { has(button and hasText("Stop") and isEnabled()) }
        compose.onNode(button).performClick()
        await { ComposerShell.body(interrupt) != null }
        assertEquals(buildJsonObject { put("stopBackgroundWork", true) }, ComposerShell.body(interrupt))
        for (fields in listOf("""{"runningSubagents":["agent-1"]}""", """{"engineTurnActive":true}""", """{"status":"RUNNING","runState":"RUNNING"}""")) {
            becomes(fields)
            await { has(button and hasText("Stop") and isEnabled()) }
        }
        // Nothing left running: Send again, with nothing to send.
        becomes("""{"runningBgShells":[]}""")
        await { has(button and hasText("Send")) }
        compose.onNode(button).assertIsNotEnabled()
        assertEquals(1, ComposerShell.bodies.count { it.first == interrupt })
    }

    /** A turn the engine started for itself is Stop's, but no message goes into it: a queued one offers no Steer, and a typed one no Queue
     * for next turn — until the session runs a turn. */
    @Test fun steerAndQueueForNextTurnStillWaitForARunningTurn() {
        ComposerShell.session = ComposerShell.fields("""{"engineTurnActive":true}""")
        ComposerShell.answers["GET sessions/${ComposerShell.SESSION}/turns"] = { ApiResponse(200, """[{"turnId":"01a0cca7-8609-70ed-a0e2-d4b55b832b84",
            "kind":"message","placement":"queued","content":"and update the changelog","attachments":[],"createdAt":"2026-10-16T09:42:00.000Z"}]""".encodeToByteArray()) }
        signIn(); openSession()
        await { has(hasText("and update the changelog") and hasAnyAncestor(hasTestTag("pending-tray"))) }
        await { has(button and hasText("Stop") and isEnabled()) }
        assertFalse(has(hasTestTag("pending-tray-steer")))
        compose.onNodeWithTag("composer-input").performTextInput("and tag the release")
        await { has(button and hasText("Send") and isEnabled()) }
        // Held, Send is only Send: the message goes as any send does, and nothing offered to queue it for the next turn.
        compose.onNode(button).performTouchInput { longClick() }
        await { ComposerShell.body(turns) != null }
        assertFalse(has(hasTestTag("composer-queue-next-turn")))
        assertNull(ComposerShell.body(turns)!!["intent"])
        await { has(button and hasText("Stop")) }
        // The session runs a turn: both are offered.
        becomes("""{"status":"RUNNING","runState":"RUNNING"}""")
        await { has(hasTestTag("pending-tray-steer")) }
        compose.onNodeWithTag("composer-input").performTextInput("and write the notes")
        await { has(button and hasText("Send") and isEnabled()) }
        compose.onNode(button).performTouchInput { longClick() }
        await { has(hasTestTag("composer-queue-next-turn")) }
    }
}
