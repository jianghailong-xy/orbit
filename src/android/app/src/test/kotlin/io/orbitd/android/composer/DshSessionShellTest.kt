package io.orbitd.android.composer

import androidx.compose.ui.test.*
import io.orbitd.android.core.net.ApiResponse
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.robolectric.Shadows.shadowOf

/**
 * A07-5 (iOS e789ce3dc, 7ca6ab87e, 13720e241, cef6c8e0d) in a DeepSeek Harness session, over the controlled server: its approval
 * cards are Allow and Deny alone; a failure is a repair card — the key on the web and the message again, the CLI's install, a newer
 * runner — in the transcript and above the composer while the session is queued; a `!` command stays in the composer with why; and
 * the model chip says the runtime picks while no model is reported. The session's engine is the server's `engine`, and — from a
 * server that doesn't say it — the runtime of the account's key the session runs on.
 */
class DshSessionShellTest : ComposerShellTest() {
    private val approval = """[{"id":"dsh-ap1","toolName":"Bash","input":{"command":"git status"},"status":"PENDING","createdAt":"2026-10-09T01:00:00.000Z"}]"""
    private val harnessKey = """[{"slug":"harness-key","label":"DeepSeek Harness","runtime":"dsh","presetSlug":"deepseek-harness","models":[]}]"""

    /** A session on DeepSeek Harness as the server says it: a DeepSeek key, the `dsh` engine. */
    private fun onHarness(vararg fields: Pair<String, String>) {
        ComposerShell.session = mapOf("provider" to JsonPrimitive("deepseek"), "engine" to JsonPrimitive("dsh"),
            "model" to JsonPrimitive("[\"deepseek\", \"deepseek-v4-pro\"]")) + fields.associate { (k, v) -> k to JsonPrimitive(v) }
    }
    private fun failure(message: String) {
        ComposerShell.events = listOf(ComposerShell.obj("""{"type":"user","seq":1,"payload":{"text":"Fix the flaky test"}}"""),
            buildJsonObject { put("type", "error"); put("seq", 2); putJsonObject("payload") { put("message", message) } })
    }
    private fun harnessRunner(health: String) {
        ComposerShell.runner = ComposerShell.obj("""{"id":"${ComposerShell.RUNNER}","name":"Fixture runner","online":true,"status":"ONLINE",
            "version":"0.1.230","capabilities":["provider:dsh"],"engines":[{"engine":"claude","installed":true,"auth":"yes"},$health]}""")
    }
    private fun approvals() { ComposerShell.answers["GET sessions/${ComposerShell.SESSION}/approvals"] = { ApiResponse(200, approval.encodeToByteArray()) } }
    private val allow = hasTestTag("approval:dsh-ap1:ALLOW")
    private val deny = hasTestTag("approval:dsh-ap1:DENY")
    private val remember = hasText("Allow & remember", substring = true)

    @Test fun aHarnessSessionsApprovalIsAllowAndDenyAlone() {
        onHarness(); approvals()
        signIn(); openSession()
        await { has(allow) && has(deny) }
        assertFalse("no Allow & remember on Harness", has(remember))
        compose.onNode(allow).performScrollTo().performClick()
        await { ComposerShell.body("POST sessions/${ComposerShell.SESSION}/approvals/dsh-ap1/decision") != null }
        val decision = ComposerShell.body("POST sessions/${ComposerShell.SESSION}/approvals/dsh-ap1/decision")!!
        assertEquals("allow", decision["behavior"]?.jsonPrimitive?.content)
        assertNull("no rule rides along", decision["rememberRules"])
    }

    @Test fun aServerThatDoesntSayTheEngineIsReadThroughTheSessionsKey() {
        ComposerShell.providers = harnessKey
        ComposerShell.session = mapOf("provider" to JsonPrimitive("harness-key"), "model" to JsonPrimitive(""))
        approvals()
        signIn(); openSession()
        await { has(allow) && ComposerShell.calls.contains("GET providers") }
        await { !has(remember) }
        assertTrue(has(deny))
    }

    @Test fun anotherEnginesApprovalKeepsAllowAndRemember() {
        ComposerShell.session = mapOf("engine" to JsonPrimitive("claude"))
        approvals()
        signIn(); openSession()
        await { has(allow) && has(remember) }
    }

    @Test fun aKeyDeepSeekRejectedIsACardThatOpensTheKeyAndSendsTheMessageAgain() {
        onHarness()
        ComposerShell.answers["GET providers/mine"] = { ApiResponse(200, """[{"id":"key-ds-1","slug":"deepseek","label":"DeepSeek","runtime":"claude",
            "presetSlug":"deepseek","engines":["claude","opencode","dsh"]}]""".encodeToByteArray()) }
        failure("dsh session/prompt (-32603): Internal error: turn failed: Authentication Fails, Your api key: ****0000 is invalid " +
            "(request_id: 64d2f58d-15e2-4744-aafd-d463abb21741) ")
        signIn(); openSession()
        awaitText("DeepSeek rejected this API key")
        assertTrue(shows("Update the key in Infrastructure, then send your message again. Connecting a key does not check it — the first request does."))
        assertFalse("the card stands in for the runner's line", has(hasText("Authentication Fails", substring = true)))
        compose.onNode(hasText("Update the API key") and hasClickAction()).performScrollTo().performClick()
        await { shadowOf(compose.activity).peekNextStartedActivity() != null }
        assertEquals("https://a07c.test/providers/key-ds-1", shadowOf(compose.activity).nextStartedActivity.dataString)
        val retry = hasText("Retry — re-send my last message") and hasClickAction() and isEnabled()
        await { has(retry) }
        compose.onNode(retry).performScrollTo().performClick()
        await { ComposerShell.calls.contains("POST sessions/${ComposerShell.SESSION}/retry-message") }
    }

    /** Every DeepSeek key runs Harness (contract §2.1), so another one is not this session's: the way to a key is Infrastructure's API
     * keys, where one is connected or turned back on (web `onEditDshKey`) — no longer the retired `deepseek-harness` form. */
    @Test fun aSessionWithNoKeyIsSentToConnectOne() {
        onHarness()
        ComposerShell.answers["GET providers/mine"] = { ApiResponse(200, """[{"id":"key-ds-2","slug":"deepseek-2","label":"DeepSeek 2","runtime":"claude",
            "presetSlug":"deepseek","engines":["claude","opencode","dsh"]}]""".encodeToByteArray()) }
        failure("DSH_CREDENTIAL_MISSING: configure a DeepSeek Harness API key")
        signIn(); openSession()
        awaitText("DeepSeek Harness needs an API key")
        assertTrue(shows("This session has no DeepSeek Harness key to run on. Add or re-enable the key in Infrastructure, then send your message again."))
        compose.onNode(hasText("Update the API key") and hasClickAction()).performScrollTo().performClick()
        await { shadowOf(compose.activity).peekNextStartedActivity() != null }
        assertEquals("https://a07c.test/infrastructure#keys", shadowOf(compose.activity).nextStartedActivity.dataString)
    }

    @Test fun aMissingHarnessIsACardThatInstallsItAndSaysSoWhileItRuns() {
        onHarness()
        harnessRunner("""{"engine":"dsh","installed":false,"auth":"unknown","dsh":{"versionCompatible":true}}""")
        failure("DSH_NOT_INSTALLED: DeepSeek Harness 0.2.0-rc.2 is not installed on this runner")
        ComposerShell.answers["POST runners/${ComposerShell.RUNNER}/install"] = {
            ComposerShell.runner = JsonObject(ComposerShell.runner + ("install" to ComposerShell.obj("""{"status":"installing","engine":"dsh","mode":"install"}""")))
            ApiResponse(200, """{"status":"pending","engine":"dsh","mode":"install"}""".encodeToByteArray())
        }
        signIn(); openSession()
        awaitText("DeepSeek Harness isn't installed on “Fixture runner”")
        assertTrue(shows("Install it from Infrastructure, then send your message again."))
        val install = hasText("Install") and hasClickAction() and isEnabled()
        await { has(install) }
        compose.onNode(install).performScrollTo().performClick()
        await { ComposerShell.body("POST runners/${ComposerShell.RUNNER}/install") != null }
        assertEquals(buildJsonObject { put("engine", "dsh") }, ComposerShell.body("POST runners/${ComposerShell.RUNNER}/install"))
        awaitText("Installing DeepSeek Harness…")
    }

    @Test fun aSessionQueuedBehindTheHarnessGateSaysWhatItWaitsForAboveTheComposer() {
        onHarness("status" to "PENDING", "runState" to "PENDING", "runStatus" to "PENDING",
            "error" to "DeepSeek Harness requires a newer Orbit runner with dsh support; update this runner first")
        signIn(); open("orbit-session:${ComposerShell.SESSION}")
        awaitText("Waiting for a newer runner")
        assertTrue(shows("This runner predates DeepSeek Harness. It updates itself when no session is running on it."))
        assertTrue("its own card, not the run-start card", !shows("This run never started"))
    }

    @Test fun anotherEnginesSessionKeepsItsLine() {
        ComposerShell.session = mapOf("engine" to JsonPrimitive("claude"))
        failure("DSH_CREDENTIAL_MISSING: configure a DeepSeek Harness API key")
        signIn(); openSession()
        awaitText("DSH_CREDENTIAL_MISSING: configure a DeepSeek Harness API key")
        assertFalse(shows("DeepSeek Harness needs an API key"))
    }

    @Test fun aShellCommandOnHarnessStaysInTheComposerWithWhy() {
        onHarness()
        signIn(); openSession()
        compose.onNodeWithTag("composer-input").performTextInput("!ls -la")
        compose.onNodeWithTag("composer-send").performClick()
        awaitText("DeepSeek Harness sessions don't run ! shell commands — ask the agent to run it instead.")
        assertTrue("the command stays where it was typed", has(hasTestTag("composer-input") and hasText("!ls -la")))
        assertFalse(ComposerShell.calls.any { it.startsWith("POST sessions/${ComposerShell.SESSION}/turns") })
        // The + menu's Shell command says the same, and puts no ! in the box.
        compose.onNodeWithTag("composer-input").performTextReplacement("")
        compose.onNodeWithText("Dismiss error").performClick()
        compose.onNode(hasText("+") and hasClickAction()).performClick()
        compose.onNode(hasText("Shell command") and hasClickAction()).performClick()
        awaitText("DeepSeek Harness sessions don't run ! shell commands — ask the agent to run it instead.")
        assertFalse(has(hasTestTag("composer-input") and hasText("!")))
    }

    /** A new session whose workspace last ran Harness is a Harness draft until a pick says otherwise (contract §3.4): its `!` command
     * stays in the composer too, no session is created for it, and its chip says the runtime picks. */
    @Test fun aDraftOnHarnessKeepsItsShellCommandToo() {
        ComposerShell.providers = """[{"slug":"deepseek","label":"DeepSeek","runtime":"claude","presetSlug":"deepseek","engines":["claude","opencode","dsh"],"models":[]}]"""
        ComposerShell.workspace = mapOf("provider" to JsonPrimitive("deepseek"), "lastProvider" to JsonPrimitive("deepseek"),
            "lastEngine" to JsonPrimitive("dsh"), "model" to JsonPrimitive(""))
        signIn(); openDraft()
        await { has(hasContentDescription("Model Picked by DeepSeek Harness, effort Default")) }
        compose.onNodeWithTag("composer-input").performTextInput("!ls -la")
        compose.onNodeWithTag("composer-send").performClick()
        awaitText("DeepSeek Harness sessions don't run ! shell commands — ask the agent to run it instead.")
        assertTrue("the command stays where it was typed", has(hasTestTag("composer-input") and hasText("!ls -la")))
        assertFalse(ComposerShell.calls.contains("POST sessions"))
    }

    @Test fun aShellCommandOnAnotherEngineGoesOut() {
        signIn(); openSession()
        compose.onNodeWithTag("composer-input").performTextInput("!ls -la")
        compose.onNodeWithTag("composer-send").performClick()
        await { ComposerShell.body("POST sessions/${ComposerShell.SESSION}/turns") != null }
        assertEquals("shell", ComposerShell.body("POST sessions/${ComposerShell.SESSION}/turns")!!["kind"]?.jsonPrimitive?.content)
    }

    @Test fun theChipSaysHarnessPicksWhileNoModelIsReported() {
        onHarness("model" to "")
        signIn(); openSession()
        await { has(hasContentDescription("Model Picked by DeepSeek Harness, effort Default")) }
        assertTrue(shows("Picked by DeepSeek Harness"))
    }

    @Test fun anotherEnginesChipKeepsTheRuntimeDefault() {
        ComposerShell.session = mapOf("model" to JsonPrimitive(""))
        signIn(); openSession()
        await { has(hasContentDescription("Model Runtime default, effort Default")) }
    }
}
