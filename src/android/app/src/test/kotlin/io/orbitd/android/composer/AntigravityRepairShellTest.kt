package io.orbitd.android.composer

import androidx.compose.ui.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** A07-4 with A13-3's composer part (iOS d2737d665, b173e3a28, cd8e8a41a): an Antigravity session's failure is a repair card —
 * the CLI's install, a Google sign-in or a Gemini key, a runner update — in the transcript, and above the composer while the session
 * is queued behind the runner; the Provider list says why Antigravity can't run here and opens its engine page. */
class AntigravityRepairShellTest : ComposerShellTest() {
    private fun runner(state: String, health: String) {
        ComposerShell.runner = ComposerShell.obj("""{"id":"${ComposerShell.RUNNER}","name":"Fixture runner","online":true,"status":"ONLINE",
            "version":"0.1.200","capabilities":[],"engines":[{"engine":"claude","installed":true,"auth":"yes"},$health],"antigravity":$state,
            "modelCatalog":{"antigravity":[{"value":"gemini-3-pro","label":"Gemini 3 Pro"}]}}""")
    }
    private fun failure(message: String) {
        ComposerShell.session = mapOf("provider" to JsonPrimitive("antigravity"), "model" to JsonPrimitive("gemini-3-pro"))
        ComposerShell.events = listOf(ComposerShell.obj("""{"type":"user","seq":1,"payload":{"text":"Fix the flaky test"}}"""),
            buildJsonObject { put("type", "error"); put("seq", 2); putJsonObject("payload") { put("message", message) } })
    }

    @Test fun aMissingCliIsACardThatInstallsItAndSaysSoWhileItRuns() {
        runner("""{"supported":true,"installed":false,"version":null,"envKeyAvailable":true,"authSource":"env_key","googleLogin":"available"}""",
            """{"engine":"antigravity","installed":false}""")
        failure("Antigravity CLI (\"agy\") not found on this runner's PATH — run `orbit doctor` on the runner to install it and sign in.")
        ComposerShell.answers["POST runners/${ComposerShell.RUNNER}/install"] = {
            ComposerShell.runner = JsonObject(ComposerShell.runner + ("install" to ComposerShell.obj("""{"status":"installing","engine":"antigravity","mode":"install"}""")))
            io.orbitd.android.core.net.ApiResponse(200, """{"status":"pending","engine":"antigravity","mode":"install"}""".encodeToByteArray())
        }
        signIn(); openSession()
        awaitText("Antigravity CLI isn't installed on Fixture runner")
        assertTrue(shows("Install it from Providers, then send your message again."))
        val install = hasText("Install") and hasClickAction() and isEnabled()
        await { has(install) }
        compose.onNode(install).performScrollTo().performClick()
        await { ComposerShell.body("POST runners/${ComposerShell.RUNNER}/install") != null }
        assertEquals(buildJsonObject { put("engine", "antigravity") }, ComposerShell.body("POST runners/${ComposerShell.RUNNER}/install"))
        awaitText("Installing Antigravity CLI…")
        assertTrue(has(hasText("Open in Providers") and hasClickAction()))
    }

    @Test fun aMissingCredentialOffersGoogleSignInAGeminiKeyAndTheSwitchToOne() {
        runner("""{"supported":true,"installed":true,"version":"1.2.16","envKeyAvailable":false,"authSource":null,"googleLogin":"available"}""",
            """{"engine":"antigravity","installed":true,"auth":"no"}""")
        ComposerShell.providers = """[{"slug":"gemini","label":"Gemini","runtime":"antigravity","presetSlug":"gemini",
            "models":[{"value":"gemini-3-pro","label":"Gemini 3 Pro"}]}]"""
        failure("Failed to authenticate: Antigravity runs on an API key (GEMINI_API_KEY), and neither this session nor the runner has one.")
        signIn(); openSession()
        awaitText("Antigravity needs authentication")
        assertTrue(shows("Sign in with Google on this runner, or connect a Gemini API key in Providers."))
        await { has(hasText("Sign in with Google") and hasClickAction()) }
        assertTrue(has(hasText("Connect Gemini") and hasClickAction()))
        val switch = hasText("Switch to Gemini") and hasClickAction() and isEnabled()
        await { has(switch) }
        compose.onNode(switch).performScrollTo().performClick()
        await { ComposerShell.body("PATCH sessions/${ComposerShell.SESSION}/config") != null }
        assertEquals(buildJsonObject { put("provider", "gemini"); put("model", "gemini-3-pro"); put("effort", "") },
            ComposerShell.body("PATCH sessions/${ComposerShell.SESSION}/config"))
    }

    @Test fun aSessionQueuedBehindTheRunnersGateSaysWhatItWaitsForAboveTheComposer() {
        runner("""{"supported":false,"installed":null,"version":null,"envKeyAvailable":false,"authSource":null,"googleLogin":"needs_update"}""",
            """{"engine":"antigravity","installed":false}""")
        ComposerShell.session = mapOf("provider" to JsonPrimitive("antigravity"), "status" to JsonPrimitive("PENDING"),
            "runState" to JsonPrimitive("PENDING"), "runStatus" to JsonPrimitive("PENDING"),
            "error" to JsonPrimitive("Antigravity requires a newer Orbit runner; update this runner first"))
        signIn(); open("orbit-session:${ComposerShell.SESSION}")
        awaitText("Waiting for a newer runner")
        // Named once the card has read the runner.
        awaitText("Fixture runner runs Orbit runner 0.1.200; Antigravity needs 0.1.209 or newer. The runner updates itself when no " +
            "session is running on it, and this session starts then.")
        assertTrue(has(hasText("Open in Providers") and hasClickAction()))
    }

    @Test fun theProviderListSaysWhyAntigravityCannotRunAndOpensItsEnginePage() {
        runner("""{"supported":false,"installed":null,"version":null,"envKeyAvailable":false,"authSource":"google","googleLogin":"needs_update"}""",
            """{"engine":"antigravity","installed":true,"auth":"yes","authSource":"google"}""")
        signIn(); openDraft(); openModelMenu()
        val row = hasText("Antigravity — Update runner →") and hasClickAction() and isEnabled() and hasAnyAncestor(isDialog())
        assertTrue(has(row))
        compose.onNode(row).performScrollTo().performClick()
        await { !has(isDialog()) && has(hasText("Antigravity")) }
    }
}
