package io.orbitd.android.composer

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import io.orbitd.android.core.net.ApiResponse
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * A Cursor CLI session and a new one on the session page, over the controlled server (the owner's board, iOS 1, 5 and 6; web P7a): the
 * Engine list's row, the model menu — Auto and its note, a model's Context and Speed carried in its value, Default greyed with why — the
 * Provider menu of a session that has talked, the context reading that isn't there, the tray's note and the composer's placeholder while
 * a turn runs, and the usage-limit card that names the account, quotes Cursor and offers a new session on another account.
 */
class CursorSessionShellTest : ComposerShellTest() {
    private val opus = """{"value":"claude-opus-5-5","label":"Claude Opus 5.5","reasoningLevels":["low","medium","high"],"defaultReasoningLevel":"medium",
        "parameters":[{"id":"context","label":"Context","category":"model_config","default":"300k","values":[{"value":"300k","label":"300K"},{"value":"1m","label":"1M"}]},
          {"id":"fast","label":"Fast","category":"model_config","default":"false","values":[{"value":"false","label":"Off"},{"value":"true","label":"Fast"}]}]}"""

    /** The fixture runner with Cursor CLI ready: Default on the Free plan and Team on Pro, a third of its month used. */
    private fun cursorRunner(capabilities: String = "\"provider:cursor\",\"cursor-account-login/v1\"", accounts: Boolean = true) {
        val signIns = if (accounts) ""","accounts":[{"id":"default","auth":"yes","home":"/root/.orbit/cursor/default"},
            {"id":"5c2e91a0","name":"Team","auth":"yes","home":"/root/.orbit/cursor-accounts/5c2e91a0"}]""" else ""
        ComposerShell.runner = ComposerShell.obj("""{"id":"${ComposerShell.RUNNER}","name":"hpc","displayName":"hpc","online":true,"status":"ONLINE",
            "version":"0.1.262","capabilities":[$capabilities],
            "engines":[{"engine":"claude","installed":true,"auth":"yes"},{"engine":"cursor","installed":true,"version":"2026.10.14-941492e","auth":"yes"$signIns}],
            "modelCatalog":{"claude":[{"value":"claude-opus-5-5","label":"Opus 5.5"}],"cursor":[{"value":"default","label":"Auto"},$opus]},
            "planUsage":{"cursor":{"provider":"cursor","account":"default","planName":"Free",
              "includedUsage":{"startsAt":"2026-09-24T16:32:26.082Z","resetsAt":"2099-10-24T12:00:00.000Z","limitReachedAt":"2099-10-01T00:00:00.000Z"},
              "accounts":{"5c2e91a0":{"provider":"cursor","account":"5c2e91a0","planName":"Pro",
                "includedUsage":{"period":"monthly","startsAt":"2026-10-03T00:00:00Z","resetsAt":"2099-11-03T00:00:00Z","percentUsed":34}}}}}}""")
    }
    private val cursorKey = """[{"slug":"cursor-api","label":"Cursor","runtime":"cursor","presetSlug":"cursor-api","engines":["cursor"],"modelsFromRuntime":true,"models":[]}]"""
    private fun onCursor(model: String = "default", vararg more: Pair<String, JsonElement>) {
        ComposerShell.session = mapOf("engine" to JsonPrimitive("cursor"), "provider" to JsonPrimitive("cursor"), "model" to JsonPrimitive(model),
            "permissionMode" to JsonPrimitive("acceptEdits")) + more
    }
    private fun inDialog(text: String) = hasText(text, substring = true) and hasAnyAncestor(isDialog())
    private fun press(tag: String) { compose.onNode(hasTestTag(tag) and hasAnyAncestor(isDialog())).performScrollTo().performClick() }

    /** iOS 1 ①: Cursor CLI is the Engine list's last row, on Auto, once the runner knows it. */
    @Test fun theEngineListOffersCursorCliOnAutoOnceTheRunnerKnowsIt() {
        cursorRunner()
        signIn(); openDraft()
        compose.onNodeWithTag("new-session-engine").performClick()
        await { has(hasTestTag("engine:cursor")) }
        assertTrue(has(hasTestTag("engine:cursor") and hasAnyDescendant(hasText("Cursor CLI")) and hasAnyDescendant(hasText("Auto")), unmerged = true))
        val rows = compose.onAllNodes(hasTestTag("engine-choices")).onFirst().onChildren().fetchSemanticsNodes()
            .mapNotNull { it.config.getOrNull(SemanticsProperties.TestTag) }.filter { it.startsWith("engine:") }
        assertEquals("engine:cursor", rows.last())
        // Picked, it lands on its own sign-in, on Auto.
        compose.onNodeWithTag("engine:cursor").performClick()
        await { ComposerShell.calls.any { it == "GET workspaces/${ComposerShell.WORKSPACE}" } }
        await { has(hasContentDescription("Model Auto, effort Default")) }
    }

    @Test fun theEngineListLeavesCursorCliOutWhileNoRunnerKnowsIt() {
        signIn(); openDraft()
        compose.onNodeWithTag("new-session-engine").performClick()
        await { has(hasTestTag("engine:claude")) }
        assertFalse(has(hasTestTag("engine:cursor")))
    }

    /** iOS 5 ①②③ and iOS 6 ①: on Auto, its note and no Effort; a model's Effort, Context and Speed, each a choice carried in the
     * session's model value; Default listed greyed, with why, and Don't Ask with what it doesn't hold back. */
    @Test fun theModelMenuIsAutoThenTheCatalogueWithEachModelsOwnParameters() {
        cursorRunner(); onCursor()
        signIn(); openSession()
        await { has(hasContentDescription("Model Auto, effort Default")) }
        openModelMenu()
        await { has(inDialog("Auto picks a model for each request.")) }
        assertTrue(has(hasTestTag("composer-engine-title") and hasText("Cursor CLI")))
        assertFalse("Auto has no effort to set", has(inDialog("Effort")))
        assertFalse(has(hasTestTag("composer-cursor-context:1m")))
        // The modes: Default greyed with the shared note; the five it keeps.
        val default = hasTestTag("composer-mode:default")
        await { has(default) }
        compose.onNode(default).assertIsNotEnabled()
        assertTrue(has(inDialog("Unsupported on Cursor CLI; session configuration is rejected")))
        assertTrue(has(inDialog("Partly enforced, edits inside the workspace still run")))
        for (mode in listOf("acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions")) compose.onNode(hasTestTag("composer-mode:$mode")).assertIsEnabled()
        // A model with parameters: its efforts, and the context and speed it takes.
        compose.onNode(inDialog("Claude Opus 5.5") and hasClickAction()).performScrollTo().performClick()
        await { ComposerShell.body("PATCH sessions/${ComposerShell.SESSION}/config") != null }
        assertEquals("claude-opus-5-5", ComposerShell.body("PATCH sessions/${ComposerShell.SESSION}/config")!!["model"]?.jsonPrimitive?.content)
    }

    @Test fun aModelsContextAndSpeedTravelInItsValue() {
        cursorRunner(); onCursor("claude-opus-5-5[fast=true]", "effort" to JsonPrimitive("high"))
        signIn(); openSession(); openModelMenu()
        await { has(hasTestTag("composer-cursor-context:1m")) }
        assertTrue(has(inDialog("✓ 300K")))
        assertTrue(has(inDialog("✓ Fast")))
        assertTrue(has(inDialog("Standard")))
        press("composer-cursor-context:1m")
        await { ComposerShell.body("PATCH sessions/${ComposerShell.SESSION}/config") != null }
        assertEquals(buildJsonObject { put("model", "claude-opus-5-5[context=1m,fast=true]") }, ComposerShell.body("PATCH sessions/${ComposerShell.SESSION}/config"))
        // The chip names the model, its effort and what the session set (the board's "Opus 5.5 High · 1M · Fast"): here, Fast.
        await { has(hasTestTag("composer-model") and hasText("Claude Opus 5.5 High · Fast")) }
    }

    /** iOS 6 ④⑤ (D5, P6b): a session that has talked, on a runner that can't carry its conversation, lists its other accounts and
     * keys greyed, with why; one that hasn't talked moves between them. */
    @Test fun aSessionThatHasTalkedListsItsOtherAccountsAndKeysGreyed() {
        cursorRunner(); ComposerShell.providers = cursorKey
        onCursor("default", "numTurns" to JsonPrimitive(2), "runtimeSessionId" to JsonPrimitive("0b4c11e2"))
        signIn(); openSession(); openModelMenu()
        await { has(hasTestTag("composer-provider-move-blocked")) }
        compose.onNode(hasTestTag("composer-provider-move-blocked"))
            .assertTextEquals("Cursor CLI can’t carry a conversation to another account or key yet. Start a new session to use one of these.")
        compose.onNode(hasTestTag("composer-provider:cursor-api") and hasAnyAncestor(isDialog())).assertIsNotEnabled()
        compose.onNode(inDialog("Team") and hasClickAction()).assertIsNotEnabled()
        compose.onNode(inDialog("Automatic") and hasClickAction()).assertIsNotEnabled()
    }

    @Test fun aSessionThatHasNotTalkedMovesToAnotherAccount() {
        cursorRunner(); ComposerShell.providers = cursorKey
        onCursor("default", "numTurns" to JsonPrimitive(0))
        signIn(); openSession(); openModelMenu()
        await { has(inDialog("Team") and hasClickAction() and isEnabled()) }
        assertFalse(has(hasTestTag("composer-provider-move-blocked")))
        compose.onNode(hasTestTag("composer-provider:cursor-api") and hasAnyAncestor(isDialog())).assertIsEnabled()
        // Team's month, a reading; Default's Free plan spent.
        assertTrue(has(inDialog("Monthly 34%")))
        compose.onNode(inDialog("Team") and hasClickAction()).performScrollTo().performClick()
        await { ComposerShell.body("PATCH sessions/${ComposerShell.SESSION}/account") != null }
        assertEquals(buildJsonObject { put("account", "5c2e91a0") }, ComposerShell.body("PATCH sessions/${ComposerShell.SESSION}/account"))
    }

    /** iOS 5 ⑦: Cursor CLI reports no context use, so there is no reading — never 0. */
    @Test fun theContextReadingIsUnavailable() {
        cursorRunner(); onCursor()
        ComposerShell.events = listOf(ComposerShell.obj("""{"type":"user","seq":1,"payload":{"text":"Fix the flaky export test"}}"""),
            ComposerShell.obj("""{"type":"assistant","seq":2,"payload":{"text":"Done."},"contextTokens":0}"""))
        signIn(); openSession()
        await { has(hasText("Context: Unavailable · Usage")) }
        compose.onNode(hasText("Context: Unavailable · Usage") and hasClickAction()).performClick()
        await { has(hasTestTag("composer-context-unavailable")) }
        assertTrue(has(inDialog("Cursor CLI doesn’t report how much of the window a session has used, so there is no reading to show.")))
        assertFalse(has(inDialog("tokens")))
        // The model by the chip's words, never its raw value (iOS 5 ④: Model, Auto).
        assertTrue(has(hasText("Auto") and hasAnyAncestor(isDialog())))
        assertFalse(has(inDialog("cursor · ")))
    }

    /** iOS 5 ⑤⑥: while a turn runs, a message waits for the next one, and the tray and the box say why. */
    @Test fun aRunningTurnsTrayAndBoxSayWhyAMessageWaits() {
        cursorRunner()
        ComposerShell.session = ComposerShell.fields("""{"status":"RUNNING","runState":"RUNNING","engine":"cursor","provider":"cursor","model":"default"}""")
        ComposerShell.events = listOf(ComposerShell.obj("""{"type":"user","seq":1,"turnId":"t-0","ts":"2026-10-16T09:40:00.000Z","payload":{"text":"Run the whole suite"}}"""))
        ComposerShell.answers["GET sessions/${ComposerShell.SESSION}/turns"] = { ApiResponse(200, """[{"turnId":"01a0cca7-8609-70ed-a0e2-d4b55b832b82",
            "kind":"message","placement":"queued","content":"Also add a line about the fix","attachments":[],"createdAt":"2026-10-16T09:42:00.000Z"}]""".encodeToByteArray()) }
        signIn(); openSession()
        await { has(hasTestTag("pending-tray-note")) }
        compose.onNodeWithTag("pending-tray-note")
            .assertTextEquals("Cursor CLI can’t take a message mid-turn — sending one would stop the turn. These go in order once it ends.")
        assertTrue(has(hasText("Reply — it goes to Cursor CLI when this turn ends…"), unmerged = true))
        assertFalse("no Steer on an engine that takes none mid-turn", has(hasTestTag("pending-tray-steer")))
    }

    /** iOS 5 ⑧: the usage-limit card names the account and its plan, quotes Cursor, and — the conversation can't move yet (D5) — offers
     * a new session on an account with room. */
    @Test fun theUsageLimitCardNamesTheAccountAndOffersANewSessionOnAnother() {
        cursorRunner(); onCursor("default", "numTurns" to JsonPrimitive(1), "retryAttempts" to JsonPrimitive(1),
            "assignedRunner" to ComposerShell.obj("""{"id":"${ComposerShell.RUNNER}","name":"hpc"}"""))
        ComposerShell.events = listOf(ComposerShell.obj("""{"type":"user","seq":1,"payload":{"text":"Add a regression test for the midnight case too."}}"""),
            buildJsonObject { put("type", "assistant"); put("seq", 2)
                putJsonObject("payload") { put("text", "You've hit your usage limit on Cursor. Cursor said: \"Upgrade your plan to continue.\"") } })
        signIn(); openSession()
        // Its plan and its reset are the runner's, read as the card appears.
        awaitText("Cursor answered “Upgrade your plan to continue”: Default’s Free plan has no requests left until Oct 24.")
        assertTrue(shows("Usage limit reached"))
        assertTrue(has(hasText("The quota for Default (Cursor CLI) on “hpc” is used up.", substring = true)))
        assertTrue(shows("This conversation can’t move to Team yet — "))
        compose.onNodeWithTag("auto-retry-cursor-elsewhere").assertTextEquals("start a new session on Team.").performScrollTo().performClick()
        // A new session in the workspace, on Cursor CLI and Team.
        await { has(hasTestTag("new-session-engine") and hasText("Cursor CLI ⌄")) }
        compose.onNodeWithTag("composer-input").performTextInput("Pick it up on Team")
        compose.onNodeWithTag("composer-send").performClick()
        await { ComposerShell.body("POST sessions") != null }
        val created = ComposerShell.body("POST sessions")!!
        assertEquals("cursor", created["engine"]?.jsonPrimitive?.content)
        assertEquals("cursor", created["provider"]?.jsonPrimitive?.content)
        assertEquals("5c2e91a0", created["cursorAccount"]?.jsonPrimitive?.content)
    }
}
