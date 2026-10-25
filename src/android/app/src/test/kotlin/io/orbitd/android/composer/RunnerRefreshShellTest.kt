package io.orbitd.android.composer

import androidx.compose.ui.test.*
import io.orbitd.android.core.net.ApiResponse
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * A07-18 (iOS bc790273c; ConsoleRunnerRefreshWiringTests) over the controlled server: what the session page reads off the runner and
 * the account's keys as it opens — the composer's catalogue behind a pool's account by the quota, the runner and keys a repair card
 * reads — is tried three times before it fails, and is read again while the session streams, so a read that failed as the page opened
 * heals and one made before the phone slept moves on. Here the test's virtual clock also runs the minute's re-read beside the
 * reconnect's; when each comes is RunnerRefreshTest's.
 */
class RunnerRefreshShellTest : ComposerShellTest() {
    private fun pools(email: String) {
        ComposerShell.pools = """[{"id":"34A07cCodexLoginPool01","slug":"codex-pool","label":"Codex pool","engine":"codex","logins":[
            {"email":"first@example.test","fingerprint":"…AB12","plan":"plus","state":"ACTIVE"},
            {"email":"$email","fingerprint":"…CD34","plan":"pro","state":"ACTIVE","usage":{"provider":"codex","primary":{"utilization":41}}}]}]"""
    }
    private fun onPool() {
        pools("second@example.test")
        ComposerShell.session = mapOf("provider" to JsonPrimitive("codex-pool"), "model" to JsonPrimitive("gpt-6"),
            "poolCodexLogin" to ComposerShell.obj("""{"email":"second@example.test","fingerprint":"…CD34","plan":"pro","state":"ACTIVE"}"""))
    }
    private fun reads(call: String) = ComposerShell.calls.count { it == call }
    private val label = hasTestTag("composer-pool-account")

    /** The pool's account is named off the composer's catalogue, read as the page opens: two failed reads are tried again. */
    @Test fun theCataloguesOpeningReadIsTriedThreeTimes() {
        onPool()
        var failures = 2
        ComposerShell.answers["GET providers/pools"] = {
            if (failures-- > 0) ApiResponse(503, """{"message":"unavailable"}""".encodeToByteArray()) else ApiResponse(200, ComposerShell.pools.encodeToByteArray())
        }
        signIn(); openSession()
        await { has(label) }
        compose.onNode(label).assertTextEquals("second@example.test")
        assertEquals(3, reads("GET providers/pools"))
    }

    /** A catalogue whose three tries all failed is not left that way: the next reconnect reads it, and the account is named. */
    @Test fun aReconnectHealsAnOpeningReadThatFailed() {
        onPool()
        var failing = true
        ComposerShell.answers["GET providers/pools"] = {
            if (failing) ApiResponse(503, """{"message":"unavailable"}""".encodeToByteArray()) else ApiResponse(200, ComposerShell.pools.encodeToByteArray())
        }
        signIn(); openSession()
        // The composer's retries wait on the main looper, which only an idle UI runs.
        await { compose.waitForIdle(); reads("GET providers/pools") >= 3 }
        assertFalse(has(label))
        failing = false
        ComposerShell.endStream()
        await { has(label) }
        compose.onNode(label).assertTextEquals("second@example.test")
    }

    private fun window(tokens: Int) {
        ComposerShell.runner = ComposerShell.obj("""{"id":"${ComposerShell.RUNNER}","name":"Fixture runner","online":true,"status":"ONLINE",
            "engines":[{"engine":"claude","installed":true,"auth":"yes"},{"engine":"codex","installed":true,"auth":"yes"}],
            "modelCatalog":{"codex":[{"value":"gpt-6","label":"GPT-6","contextWindow":$tokens}]}}""")
    }

    /** What the page read off the runner is read again on a reconnect: the composer's line says the window the runner reports now. */
    @Test fun aReconnectReadsTheRunnerRowAgain() {
        onPool(); window(272000)
        signIn(); openSession()
        awaitText("Context: 0 / 272000 tokens · Usage")
        val before = reads("GET runners")
        window(400000)
        ComposerShell.endStream()
        awaitText("Context: 0 / 400000 tokens · Usage")
        assertTrue(reads("GET runners") > before)
    }

    private val rejected = "dsh session/prompt (-32603): Internal error: turn failed: Authentication Fails, Your api key: ****0000 is invalid"
    private fun harnessKey(label: String) = """[{"slug":"deepseek","label":"$label","runtime":"claude","presetSlug":"deepseek",
        "engines":["claude","opencode","dsh"]}]"""

    /** The repair card's runner and keys are read as it appears — tried three times — and again on a reconnect: the key it names is
     * the key as the account calls it now (A07-19 (b) names it). */
    @Test fun theRepairCardsReadsAreTriedThreeTimesAndReadAgainOnAReconnect() {
        ComposerShell.session = mapOf("provider" to JsonPrimitive("deepseek"), "engine" to JsonPrimitive("dsh"), "model" to JsonPrimitive("deepseek-v4-pro"))
        ComposerShell.events = listOf(ComposerShell.obj("""{"type":"user","seq":1,"payload":{"text":"Fix the flaky test"}}"""),
            buildJsonObject { put("type", "error"); put("seq", 2); putJsonObject("payload") { put("message", rejected) } })
        ComposerShell.providers = harnessKey("DeepSeek")
        var failures = 2
        ComposerShell.answers["GET providers"] = {
            if (failures-- > 0) ApiResponse(503, """{"message":"unavailable"}""".encodeToByteArray()) else ApiResponse(200, ComposerShell.providers.encodeToByteArray())
        }
        signIn(); openSession()
        awaitText("Update the DeepSeek key “DeepSeek” in Infrastructure, then send your message again.")
        assertEquals(3, reads("GET providers"))
        ComposerShell.providers = harnessKey("DeepSeek main")
        ComposerShell.endStream()
        awaitText("Update the DeepSeek key “DeepSeek main” in Infrastructure, then send your message again.")
    }
}
