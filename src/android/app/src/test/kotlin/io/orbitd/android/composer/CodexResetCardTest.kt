package io.orbitd.android.composer

import androidx.compose.ui.test.*
import io.orbitd.android.core.net.ApiResponse
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

/** The Codex reset-credit card (iOS CodexResetCreditCard, the baseline the audit found missing) in the Plan usage sheet of a session
 * on the runner's own Codex sign-in — and, A07-9 (iOS c3a2e1463), not there at all for an account with no credit left. */
class CodexResetCardTest : ComposerShellTest() {
    private val fingerprint = "cxa1_0123456789abcdef0123456789abcdef"
    private fun codexRunner(available: Int, capabilities: String = "\"codex-rate-limit-reset-v1\"") {
        val fetched = Instant.now().minusSeconds(120).toString()
        ComposerShell.runner = ComposerShell.obj("""{"id":"${ComposerShell.RUNNER}","name":"Fixture runner","online":true,"status":"ONLINE",
            "capabilities":[$capabilities],"heartbeatLeaseOwner":"7c9e6679-7425-40de-944b-e07fc1f90ae7","heartbeatDraining":false,
            "engines":[{"engine":"codex","installed":true,"auth":"yes"}],
            "modelCatalog":{"codex":[{"value":"gpt-6","label":"GPT-6"}]},
            "planUsage":{"codex":{"provider":"codex","primary":{"utilization":23,"windowDurationMins":300},
              "rateLimitReset":{"protocolVersion":1,"support":"SUPPORTED","accountFingerprint":"$fingerprint",
                "rateLimitResetCredits":{"availableCount":$available,"credits":[
                  {"id":"c1","resetType":"weekly","status":"available","grantedAt":"2026-10-01T00:00:00Z","expiresAt":"2026-12-24T09:30:00Z"},
                  {"id":"c2","resetType":"weekly","status":"available","grantedAt":"2026-10-02T00:00:00Z","expiresAt":"2027-01-05T09:30:00Z"}]},
                "fetchedAt":"$fetched","generation":"3f2b8c1e-9d4a-4b7e-8c2f-1a2b3c4d5e6f","sequence":3}}}}""")
        ComposerShell.session = mapOf("provider" to JsonPrimitive("codex"), "model" to JsonPrimitive("gpt-6"))
    }
    private fun openUsage() {
        val usage = hasText("Context: 0 tokens · Usage") and hasClickAction()
        await { has(usage) }
        compose.onNode(usage).performClick()
        awaitText("Primary: 23%")
    }

    @Test fun theRunnersOwnCodexSignInOffersItsResetCreditsAndSpendsOneOnlyOnceConfirmed() {
        codexRunner(available = 2)
        ComposerShell.answers["GET runners/${ComposerShell.RUNNER}/codex-rate-limit-reset"] = { ApiResponse(200, """{"active":null,"latest":null}""".encodeToByteArray()) }
        ComposerShell.answers["POST runners/${ComposerShell.RUNNER}/codex-rate-limit-reset"] = { ApiResponse(200, """{"replayed":false,"operation":{"id":"op1",
            "runnerId":"${ComposerShell.RUNNER}","clientRequestId":"x","accountFingerprint":"$fingerprint","status":"PENDING","consumeState":"PENDING",
            "refreshState":"PENDING","createdAt":"2026-10-09T00:00:00Z","updatedAt":"2026-10-09T00:00:00Z"}}""".encodeToByteArray()) }
        signIn(); openSession(); openUsage()
        awaitText("Reset credit")
        assertTrue(shows("2 available"))
        assertTrue(shows("Next expires Dec 24, 9:30 AM") || shows("Next expires Dec 24, 5:30 PM") || has(hasText("Next expires", substring = true)))
        assertTrue(shows("Updated 2 min ago"))
        val use = hasText("Use reset credit") and hasClickAction() and isEnabled()
        await { has(use) }
        compose.onNode(use).performScrollTo().performClick()
        awaitText("This consumes 1 earned credit and resets eligible Codex usage windows. This action can't be undone. Your conversations and context aren't affected.")
        assertTrue("nothing is spent before it is confirmed", ComposerShell.calls.none { it.startsWith("POST runners/${ComposerShell.RUNNER}/codex-rate-limit-reset") })
        compose.onNode(hasText("Use reset") and hasClickAction()).performClick()
        await { ComposerShell.body("POST runners/${ComposerShell.RUNNER}/codex-rate-limit-reset") != null }
        val sent = ComposerShell.body("POST runners/${ComposerShell.RUNNER}/codex-rate-limit-reset")!!
        assertEquals(fingerprint, sent["accountFingerprint"]?.jsonPrimitive?.content)
        assertNotNull(sent["clientRequestId"]?.jsonPrimitive?.content)
        awaitText("Waiting for the runner…")
    }

    @Test fun anAccountWithNoCreditLeftShowsOnlyItsWindows() {
        codexRunner(available = 0)
        signIn(); openSession(); openUsage()
        assertFalse("A07-9: no reset section at all", shows("Reset credit"))
        assertFalse(shows("Use reset credit"))
    }

    @Test fun aRunnerThatCannotSpendOneSaysWhyAndOffersNothingToPress() {
        codexRunner(available = 1, capabilities = "")
        signIn(); openSession(); openUsage()
        awaitText("Reset credit")
        assertTrue(shows("1 available"))
        awaitText("Update this runner to use reset credits.")
        assertTrue(has(hasText("Use reset credit") and hasClickAction() and isNotEnabled()))
    }
}
