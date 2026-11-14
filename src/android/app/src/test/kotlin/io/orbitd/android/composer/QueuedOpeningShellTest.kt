package io.orbitd.android.composer

import androidx.compose.ui.test.*
import io.orbitd.android.core.net.ApiResponse
import org.junit.Assert.*
import org.junit.Test

/**
 * A session no runner has claimed yet opens on its first message, not on an empty page. `GET …/turns?view=active` lists the opening
 * prompt as the accepted head, marked `opening`, under the id its turn will have, until the runner's echo of it lands (apiserver session-create-attachments-alone.pg.spec.ts). The conversation draws it from that row while
 * the session is Queued, and when the claimed turn's events arrive the message is there once. Web parity:
 * WorkspaceView.queuedOpening.test.tsx; OrbitKit QueuedOpeningTurnTests.
 */
class QueuedOpeningShellTest : ComposerShellTest() {
    private val openingId = "0195c0de-0000-7000-8000-0000000000a1"
    private val words = "Fix: Codex update failed on orbit@austin. Read the install log and fix it."
    private val opening = """{"turnId":"$openingId","kind":"message","placement":"accepted","content":"$words",
        "attachments":[],"createdAt":"2026-11-14T09:30:00.000Z","opening":true}"""
    private val drawn = hasTestTag("accepted:$openingId")

    /** Created, and no runner has claimed it: no events yet, the opening listed. */
    private fun queued() {
        ComposerShell.session = ComposerShell.fields("""{"title":"Fix: Codex update failed on orbit@austin","status":"PENDING",
            "runStatus":"PENDING","runState":"QUEUED","lastTurnAt":null}""")
        ComposerShell.events = emptyList()
        ComposerShell.answers["GET sessions/${ComposerShell.SESSION}/turns"] = { ApiResponse(200, "[$opening]".encodeToByteArray()) }
    }

    private fun copies() = compose.onAllNodes(hasText(words) and hasAnyAncestor(hasTestTag("transcript-list")), useUnmergedTree = true)
        .fetchSemanticsNodes().size

    @Test fun anUnclaimedSessionShowsItsFirstMessage() {
        queued()
        signIn(); openSession()
        await { has(drawn) }
        assertTrue("the person's own message", has(hasText(words) and hasAnyAncestor(drawn)))
        assertTrue(has(hasText("You") and hasAnyAncestor(drawn)))
        assertFalse("the opening is no follow-up to withdraw", has(hasText("Cancel")))
        assertEquals(1, copies())
    }

    @Test fun onceTheClaimedTurnsEventsArriveTheFirstMessageIsThereOnce() {
        queued()
        signIn(); openSession()
        await { has(drawn) }

        // A runner claims it and echoes the opening; the active view no longer lists it once the echo is stored.
        ComposerShell.answers["GET sessions/${ComposerShell.SESSION}/turns"] = { ApiResponse(200, "[]".encodeToByteArray()) }
        ComposerShell.push("""{"type":"system","seq":1,"turnId":"$openingId","payload":{"subtype":"init"}}""")
        ComposerShell.push("""{"type":"user","seq":2,"turnId":"$openingId","payload":{"text":"$words"}}""")
        ComposerShell.push("""{"type":"assistant","seq":3,"turnId":"$openingId","payload":{"text":"Reading the install log."}}""")
        await { !has(drawn) }
        await { has(hasTestTag("event:2")) }
        compose.waitForIdle()
        assertEquals("drawn once", 1, copies())
    }
}
