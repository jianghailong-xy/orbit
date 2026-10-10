package io.orbitd.android.composer

import androidx.compose.ui.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

/** The auto-retry card (iOS AutoRetryCard, the baseline the audit found missing; ceaf27657 for A07-12): a spent quota or a provider
 * that could not answer is a card in the transcript — when it goes out again by itself, a switch for that, and the press that takes
 * over — and a limit that landed on a turn nobody sent continues instead of re-sending. */
class AutoRetryCardTest : ComposerShellTest() {
    private val quota = "You've hit your session limit · resets 6:20pm (Europe/Berlin)"
    private fun failed(retryAt: Instant?, attempts: Int, vararg events: String) {
        ComposerShell.session = buildMap {
            put("retryAttempts", JsonPrimitive(attempts))
            retryAt?.let { put("retryAt", JsonPrimitive(it.toString())) }
            put("assignedRunner", ComposerShell.obj("""{"id":"${ComposerShell.RUNNER}","name":"wikova"}"""))
        }
        ComposerShell.events = events.map(ComposerShell::obj)
    }
    private fun user(seq: Int, text: String) = """{"type":"user","seq":$seq,"payload":{"text":"$text"}}"""
    private fun assistant(seq: Int, text: String) = buildJsonObject {
        put("type", "assistant"); put("seq", seq); putJsonObject("payload") { put("text", text) } }.toString()
    private fun button(text: String) = hasText(text) and hasClickAction() and isEnabled()

    @Test fun anArmedQuotaIsAQuietCountdownWithASwitchToTurnItOff() {
        failed(Instant.now().plusSeconds(11 * 60), 0, user(1, "Ship it"), assistant(2, quota))
        signIn(); openSession()
        awaitText("5-hour limit reached")
        awaitText("The 5-hour quota for claude on “wikova” is used up.")
        assertTrue(shows("Auto-retry when the quota resets"))
        assertTrue(shows("Runs on the server — you don't have to stay here."))
        assertTrue(shows("The quota hasn’t reset yet — this will likely fail again."))
        assertTrue(has(button("Retry now anyway")))
        assertFalse("the bubble it would re-send is the line right above", shows("Will re-send:"))
        compose.onNodeWithTag("auto-retry-switch").performScrollTo().performClick()
        await { ComposerShell.calls.any { it == "DELETE sessions/${ComposerShell.SESSION}/auto-retry" } }
    }

    @Test fun aProviderErrorThatGaveUpQuotesWhatItWouldResendAndRetriesThroughTheDoor() {
        failed(null, 3, user(1, "Run the migration"), assistant(2, "Starting."),
            assistant(3, "API Error: 529 {\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}"))
        signIn(); openSession()
        awaitText("Auto-retry gave up")
        assertTrue(shows("Tried 3 times — the API is still failing. Over to you."))
        assertTrue("which error it was, verbatim", shows("API Error: 529 {\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}"))
        assertTrue(shows("Will re-send:") && shows("Run the migration"))
        compose.onNode(button("Retry now")).performScrollTo().performClick()
        await { ComposerShell.calls.any { it == "POST sessions/${ComposerShell.SESSION}/retry-message" } }
        assertEquals("nothing picked in the composer: the re-send goes where the session is", JsonObject(emptyMap()),
            ComposerShell.body("POST sessions/${ComposerShell.SESSION}/retry-message"))
    }

    /** A07-12: nothing of anybody's to re-send — the server says so — so every verb on the card is Continue, and the press sends the
     * platform's own sentence as the composer sends anything: outbox first, one clientTurnId. */
    @Test fun aLimitOnATurnNobodySentContinuesInsteadOfResending() {
        ComposerShell.retryMessage = """{"text":"","nothingToResend":true}"""
        failed(null, 1, assistant(5, quota))
        signIn(); openSession()
        awaitText("The 5-hour quota for claude on “wikova” is used up. Nothing to re-send — the limit landed on a turn that wasn’t yours.")
        assertTrue(shows("Continue when the quota resets"))
        assertTrue(shows("Off — nothing will continue until you do."))
        assertTrue(shows("Sends “Continue where you left off.”"))
        compose.onNode(button("Continue")).performScrollTo().performClick()
        await { ComposerShell.body("POST sessions/${ComposerShell.SESSION}/turns") != null }
        val sent = ComposerShell.body("POST sessions/${ComposerShell.SESSION}/turns")!!
        assertEquals("Continue where you left off.", sent["content"]?.jsonPrimitive?.content)
        assertNotNull("sent under a key of its own, which a replay reuses", sent["clientTurnId"]?.jsonPrimitive?.content)
    }

    /** iOS testStaleCardIsHistoryNotAnAlarm: the session went on after the failure — a message came after it — so the card is
     * history: no countdown, no switch, no press, even while the session has a retry armed for something later. */
    @Test fun aCardTheSessionMovedPastIsHistory() {
        failed(Instant.now().plusSeconds(600), 1, user(1, "First"), assistant(2, quota), user(3, "Second"))
        signIn(); openSession()
        val stale = hasTestTag("auto-retry-card") and hasAnyDescendant(hasText("5-hour limit reached"))
        await { has(stale) }
        val pressable = compose.onAllNodes(hasAnyAncestor(stale) and hasClickAction()).fetchSemanticsNodes().map { it.config }
        assertTrue("the card the session moved past offers nothing: $pressable", pressable.isEmpty())
        assertFalse(has(hasAnyAncestor(stale) and hasText("Auto-retry when the quota resets")))
        assertFalse(has(hasAnyAncestor(stale) and hasText("Resets", substring = true)))
    }
}
