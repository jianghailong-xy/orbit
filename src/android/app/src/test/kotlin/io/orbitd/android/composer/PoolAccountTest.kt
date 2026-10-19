package io.orbitd.android.composer

import androidx.compose.ui.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** A07-7 (iOS f929ab1e4, a0a76a760): a session on a pool of one's own ChatGPT accounts names the account it runs on — the one its
 * detail records (`poolCodexLogin`), even when the pool's oldest is spent and there is no "next" — with that account's own quota,
 * and the Plan usage sheet says whose quota it is when the pool holds more than one. */
class PoolAccountTest : ComposerShellTest() {
    private fun loginPool() {
        ComposerShell.pools = """[{"id":"34A07cCodexLoginPool01","slug":"codex-pool","label":"Codex pool","engine":"codex","logins":[
            {"email":"first@example.test","fingerprint":"…AB12","plan":"plus","state":"ACTIVE",
             "usage":{"provider":"codex","primary":{"utilization":100,"windowDurationMins":300,"resetsAt":"2099-01-01T00:00:00Z"}}},
            {"email":"second@example.test","fingerprint":"…CD34","plan":"pro","state":"ACTIVE",
             "usage":{"provider":"codex","primary":{"utilization":41,"windowDurationMins":300}}}]}]"""
        ComposerShell.session = mapOf("provider" to JsonPrimitive("codex-pool"), "model" to JsonPrimitive("gpt-6"),
            "poolCodexLogin" to ComposerShell.obj("""{"email":"second@example.test","fingerprint":"…CD34","plan":"pro","state":"ACTIVE"}"""))
    }

    @Test fun aLoginPoolSessionNamesTheAccountItRunsOnAndItsQuota() {
        loginPool()
        signIn(); openSession()
        await { has(hasTestTag("composer-pool-account")) }
        compose.onNodeWithTag("composer-pool-account").assertTextEquals("second@example.test")
            .assertContentDescriptionEquals("Codex pool is running this session on second@example.test")
        compose.onNode(hasText("Context: 0 tokens · Usage") and hasClickAction()).performClick()
        awaitText("Primary: 41%")
        assertTrue("the sheet names whose quota it is", has(hasText("Account") and hasAnyAncestor(isDialog())) &&
            has(hasText("second@example.test") and hasAnyAncestor(isDialog())))
    }

    @Test fun anAccountThePoolNoLongerHoldsIsNotGuessed() {
        loginPool()
        ComposerShell.session = ComposerShell.session + ("poolCodexLogin" to ComposerShell.obj("""{"email":"gone@example.test","fingerprint":"…EF56"}"""))
        signIn(); openSession()
        await { ComposerShell.calls.any { it == "GET providers/pools" } }
        compose.onNode(hasText("Context: 0 tokens · Usage") and hasClickAction()).performClick()
        awaitText("No quota reported for this account.")
        assertFalse(has(hasTestTag("composer-pool-account")))
    }
}
