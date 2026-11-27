package io.orbitd.android.composer

import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import io.orbitd.android.core.net.ApiResponse
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.*
import org.junit.Test

/**
 * A message sent into a session, on the session page over the controlled server (board
 * docs/mocks/composer-sending-bubble/04-native-parity.html; owner decisions of 2026-11-27): it waits in the conversation as a dimmed
 * bubble reading `Sending…`, becomes the ordinary bubble once taken, and — refused — reads `⚠ Not sent · Retry · Put back in the
 * composer` with the server's reason printed under it. No strip above the box says any of it.
 */
class SendingBubbleShellTest : ComposerShellTest() {
    private val turns = "POST sessions/${ComposerShell.SESSION}/turns"
    private val words = "Ship the quarterly report"
    private val sending = hasTestTag("pending-send:sending")
    private val notSent = hasTestTag("pending-send:not-sent")
    private val sent = hasTestTag("pending-send:sent")
    private val inList = hasAnyAncestor(hasTestTag("transcript-list"))

    private fun input() = compose.onNodeWithTag("composer-input").fetchSemanticsNode().config.getOrNull(SemanticsProperties.EditableText)?.text
    private fun refuse() { ComposerShell.answers[turns] = { ApiResponse(409, """{"statusCode":409,"message":"the session has ended"}""".encodeToByteArray()) } }
    private fun copies() = compose.onAllNodes(hasText(words) and inList, useUnmergedTree = true).fetchSemanticsNodes().size
    private fun sendWords() {
        ComposerShell.events = listOf(ComposerShell.obj("""{"type":"user","seq":1,"turnId":"t-0","payload":{"text":"Fix the sign-up test"}}"""),
            ComposerShell.obj("""{"type":"assistant","seq":2,"turnId":"t-0","payload":{"text":"Done — the sign-up test now waits on the cookie too."}}"""))
        signIn(); openSession()
        await { has(hasText("Done — the sign-up test now waits on the cookie too.")) }
        compose.onNodeWithTag("composer-input").performTextInput(words)
        await { input() == words && has(hasTestTag("composer-send") and isEnabled()) }
        compose.onNodeWithTag("composer-send").performClick()
    }
    private fun clientTurnIds() = ComposerShell.bodies.filter { it.first == turns }.map { ComposerShell.obj(it.second)["clientTurnId"].toString() }

    @Test fun aMessageWaitsAsSendingThenBecomesTheOrdinaryBubble() {
        val held = CompletableDeferred<Unit>(); ComposerShell.gates[turns] = held
        sendWords()
        await { has(sending and inList) }
        assertTrue(has(hasText(PendingSendCopy.SENDING) and hasAnyAncestor(sending)))
        assertEquals("the words left the box at the press", "", input())
        assertTrue("Send is a plain disabled arrow", has(hasTestTag("composer-send") and isNotEnabled()))
        assertFalse("no spinner in Send", has(hasAnyAncestor(hasTestTag("composer-send")) and hasProgressBarRangeInfo(ProgressBarRangeInfo.Indeterminate), unmerged = true))
        assertFalse("no strip above the box", shows("Delivery unconfirmed: $words") || shows("Retry saved send"))
        assertFalse("nothing to press while it is out", has(hasText(PendingSendCopy.RETRY) and hasAnyAncestor(sending)))
        held.complete(Unit)
        await { !has(sending) }
        // Taken (the fixture answers PENDING, and no queue listing yet): the ordinary bubble at full strength, nothing in its foot.
        await { has(sent and inList) }
        assertFalse(has(notSent))
        assertEquals(1, copies())
        // The echo lands: it replaces the local row, never stands beside it.
        ComposerShell.push("""{"type":"user","seq":3,"turnId":"turn-1","payload":{"text":"$words"}}""")
        await { has(hasTestTag("event:3")) && !has(sent) }
        compose.waitForIdle()
        assertEquals("drawn once", 1, copies())
    }

    @Test fun aRefusalReadsNotSentWithItsReasonAndRetrySendsTheSameKey() {
        refuse(); sendWords()
        await { has(notSent and inList) }
        assertTrue(has(hasText("⚠ ${PendingSendCopy.NOT_SENT}") and hasAnyAncestor(notSent)))
        assertTrue(has(hasText(PendingSendCopy.RETRY) and hasAnyAncestor(notSent)))
        assertTrue(has(hasText(PendingSendCopy.PUT_BACK) and hasAnyAncestor(notSent)))
        assertTrue("the reason, printed: a touch screen has no hover", has(hasText("the session has ended") and hasAnyAncestor(notSent)))
        assertEquals("nothing is put back by itself", "", input())
        assertFalse("said on the bubble, not above the box", has(hasText("Dismiss error")))
        ComposerShell.answers.remove(turns)
        compose.onNode(hasTestTag("pending-send:retry") and hasAnyAncestor(notSent)).performClick()
        await { !has(notSent) && !has(sending) }
        val keys = clientTurnIds()
        assertEquals(2, keys.size)
        assertEquals("Retry reuses the saved clientTurnId", keys[0], keys[1])
    }

    @Test fun putBackReturnsTheWordsToTheBoxAndTheBubbleGoes() {
        refuse(); sendWords()
        await { has(notSent and inList) }
        compose.onNodeWithTag("composer-input").performTextInput("and the notes")
        await { input() == "and the notes" }
        compose.onNode(hasTestTag("pending-send:put-back") and hasAnyAncestor(notSent)).performClick()
        await { input() == "and the notes\n\n$words" }
        await { !has(notSent) }
        assertEquals("nothing more is sent", 1, ComposerShell.bodies.count { it.first == turns })
    }

    @Test fun theEchoOfAMessageTheServerTookReplacesItsNotSentBubble() {
        refuse(); sendWords()
        await { has(notSent and inList) }
        // It did reach the server after all: its echo replaces the bubble, and Retry is no longer offered.
        ComposerShell.push("""{"type":"user","seq":3,"turnId":"turn-1","payload":{"text":"$words"}}""")
        await { has(hasTestTag("event:3")) && !has(notSent) }
        compose.waitForIdle()
        assertEquals("drawn once", 1, copies())
        val model = app().composer(signedInHandle(), ComposerShell.SESSION)
        await { model.state.value.draft.pending == null }
    }

    private fun signedInHandle() = (app().session.state.value as io.orbitd.android.core.auth.AuthState.SignedIn).handle
}
