package io.orbitd.android.composer

import androidx.compose.ui.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** A07-10 (iOS 9ee358083): each engine's accounts are a section of the Provider list, Automatic first with what it does —
 * "Switches to soonest reset", said aloud as "Automatic: starts on the <engine> account whose quota resets soonest, and switches
 * when it hits its limit" — then every account with its own quota. */
class AutomaticAccountTest : ComposerShellTest() {
    private fun twoAccountRunner(capabilities: String = "") {
        ComposerShell.runner = ComposerShell.obj("""{"id":"${ComposerShell.RUNNER}","name":"Fixture runner","online":true,"status":"ONLINE",
            "capabilities":[$capabilities],
            "engines":[{"engine":"claude","installed":true,"auth":"yes","accounts":[{"id":"default","auth":"yes"},{"id":"c0ffee01","name":"Work","auth":"yes"}]},
              {"engine":"codex","installed":true,"auth":"yes","accounts":[{"id":"default","auth":"yes"},{"id":"1a2b3c4d","name":"Second account","auth":"yes"},
                {"id":"deadbeef","name":"Expired account","auth":"no"}]}],
            "planUsage":{"codex":{"provider":"codex","primary":{"utilization":23,"windowDurationMins":300},
              "accounts":{"1a2b3c4d":{"provider":"codex","primary":{"utilization":95,"windowDurationMins":300}}}}},
            "modelCatalog":{"claude":[{"value":"claude-opus-5-5","label":"Opus 5.5"}],"codex":[{"value":"gpt-6","label":"GPT-6"}]}}""")
    }

    private fun providerRows() = section("Provider", until = setOf("Close")).filterNot { "Antigravity" in it }

    @Test fun aNewSessionListsEachEnginesAccountsUnderItAutomaticFirst() {
        twoAccountRunner()
        signIn(); openDraft(); openModelMenu()
        assertEquals(listOf("Claude", "Automatic\nSwitches to soonest reset", "Default", "Work",
            "Codex", "Automatic\nSwitches to soonest reset", "Default\n5h 23%", "Second account\n5h 95%",
            "Expired account\nNot signed in, sign in →", "Kimi"), providerRows())
        compose.onNodeWithContentDescription("Automatic: starts on the Codex account whose quota resets soonest, and switches when it hits its limit")
            .assertExists()
        compose.onNodeWithContentDescription("Automatic: starts on the Claude account whose quota resets soonest, and switches when it hits its limit")
            .assertExists()
        // An account under another engine starts the new session there, on that account.
        compose.onNode(hasText("Second account") and hasClickAction() and hasAnyAncestor(isDialog())).performScrollTo().performClick()
        compose.onNode(hasText("Close") and hasAnyAncestor(isDialog())).performClick()
        compose.onNodeWithTag("composer-input").performTextInput("Start on the second account")
        compose.onNodeWithTag("composer-send").performClick()
        await { ComposerShell.body("POST sessions") != null }
        val created = ComposerShell.body("POST sessions")!!
        assertEquals("codex", created["provider"]?.jsonPrimitive?.content)
        assertEquals("1a2b3c4d", created["codexAccount"]?.jsonPrimitive?.content)
    }

    @Test fun aSessionMovesBetweenItsEnginesAccountsWhereTheRunnerCarriesIt() {
        twoAccountRunner(capabilities = "\"codex-account-move/v1\"")
        ComposerShell.session = mapOf("provider" to JsonPrimitive("codex"), "model" to JsonPrimitive("gpt-6"))
        signIn(); openSession(); openModelMenu()
        assertEquals(listOf("Codex", "Automatic\nSwitches to soonest reset", "Default\n5h 23%", "Second account\n5h 95%",
            "Expired account\nNot signed in, sign in →"), providerRows())
        compose.onNode(hasText("Automatic") and hasClickAction() and hasAnyAncestor(isDialog())).performScrollTo().performClick()
        await { ComposerShell.body("PATCH sessions/${ComposerShell.SESSION}/account") != null }
        assertEquals(buildJsonObject { put("account", "automatic") }, ComposerShell.body("PATCH sessions/${ComposerShell.SESSION}/account"))
    }

    @Test fun withoutTheRunnersMoveASessionsEngineIsOneRow() {
        twoAccountRunner()
        ComposerShell.session = mapOf("provider" to JsonPrimitive("codex"), "model" to JsonPrimitive("gpt-6"))
        signIn(); openSession(); openModelMenu()
        assertEquals(listOf("✓ Codex"), providerRows())
        assertFalse(shows("Switches to soonest reset"))
    }
}
