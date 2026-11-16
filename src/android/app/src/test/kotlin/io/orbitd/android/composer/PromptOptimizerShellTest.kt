package io.orbitd.android.composer

import androidx.compose.ui.test.*
import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.core.promptoptimizer.PromptOptimizer
import io.orbitd.android.core.promptoptimizer.PromptOptimizerCopy
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The account and the answers the prompt optimizer's composer tests run against (board docs/mocks/prompt-optimizer, frames 2–6). */
internal object PromptOptimizerFixture {
    const val DRAFT = "fix the login redirect bug, it goes to the wrong page after sign in"
    const val PROMPT = "After signing in, users land on the wrong page instead of the page they started from. " +
        "The redirect target is meant to come from the returnTo query parameter (the session's last turn touched src/web/src/auth/LoginPage.tsx).\n\n" +
        "1. Reproduce: open a protected page signed out, sign in, and note where you land.\n" +
        "2. Find where the post-login redirect is chosen and make it return to the original page.\n" +
        "3. Keep the existing rule: an external returnTo URL is refused."
    /** The prompt in the owner's language (Chinese, the default), as iOS's frame 4b reads it. */
    const val GLOSS = "登录后，用户落在了错误的页面，而不是他们开始时所在的页面。重定向目标应当来自 `returnTo` 查询参数（本会话上一轮改过 `src/web/src/auth/LoginPage.tsx`）。\n\n" +
        "1. 复现：未登录时打开一个受保护页面，登录，记下落在哪里。\n2. 找到登录后重定向的选择位置并修复，使其回到原页面。\n3. 保留现有规则：外部的 `returnTo` URL 会被拒绝。"

    /** `users/me`: the switch [on] (null: never set, which reads on), the server able to ([available]), and Translation on (the owner's
     * language the default). */
    fun me(on: Boolean? = null, available: Boolean = true) = buildJsonObject {
        put("id", "u1"); put("email", "owner@a07c.test"); put("name", "Owner")
        putJsonObject("preferences") { on?.let { put("promptOptimizer", it) }; put("translationEnabled", true) }
        put("promptOptimizerAvailable", available); put("translationAvailable", true)
    }.toString()

    /** The board's frame 4 answer: written in the agent language (English) with a gloss, its middle drawn from context. */
    fun answer(gloss: Boolean = true, language: String = "en") = buildJsonObject {
        putJsonArray("segments") {
            add(buildJsonObject { put("text", "After signing in, users land on the wrong page instead of the page they started from. "); put("added", false) })
            add(buildJsonObject { put("text", "The redirect target is meant to come from the `returnTo` query parameter (the session's last turn touched `src/web/src/auth/LoginPage.tsx`)."); put("added", true) })
            add(buildJsonObject { put("text", "\n\n1. Reproduce: open a protected page signed out, sign in, and note where you land.\n" +
                "2. Find where the post-login redirect is chosen and make it return to the original page.\n" +
                "3. Keep the existing rule: an external `returnTo` URL is refused."); put("added", false) })
        }
        put("text", PROMPT.replace("returnTo query", "`returnTo` query").replace("src/web/src/auth/LoginPage.tsx", "`src/web/src/auth/LoginPage.tsx`")
            .replace("external returnTo", "external `returnTo`"))
        put("language", language)
        if (gloss) put("gloss", GLOSS)
        putJsonArray("contextUsed") {
            add(buildJsonObject { put("kind", "TURNS"); put("count", 6) }); add(buildJsonObject { put("kind", "RECAP") })
            add(buildJsonObject { put("kind", "PROJECT"); put("title", "Auth cleanup") }); add(buildJsonObject { put("kind", "WIKI"); put("count", 2) })
            add(buildJsonObject { put("kind", "SOMETHING_NEW") })
        }
    }.toString()

    /** The answer's `text`: the agent-language prompt. */
    val prompt: String get() = Json.parseToJsonElement(answer()).jsonObject["text"]!!.jsonPrimitive.content

    /** What the box holds after Use with Translation on (D2): the owner-language gloss. */
    val inserted: String get() = GLOSS

    fun install(on: Boolean? = null, available: Boolean = true, respond: () -> ApiResponse = { ApiResponse(200, answer().encodeToByteArray()) }) {
        ComposerShell.answers["GET users/me"] = { ApiResponse(200, me(on, available).encodeToByteArray()) }
        ComposerShell.answers["POST prompt-optimizations"] = respond
    }

    const val CALL = "POST prompt-optimizations"
}

/**
 * Android's prompt optimizer in the composer over the controlled server, as iOS draws it on a phone (docs/prompt-optimizer-design.md,
 * board frames 2–6; OrbitKit PromptOptimizerTests): ✦'s fixed slot and disabled state, the busy press that cancels, the suggestion sheet that
 * leaves the box alone until Use, Undo, × and the failure line, and `optimizedTranslation` only on a send of the unedited gloss.
 */
class PromptOptimizerShellTest : ComposerShellTest() {
    private val button = hasTestTag("composer-optimize")
    private val input get() = compose.onNodeWithTag("composer-input")
    private val turns = "POST sessions/${ComposerShell.SESSION}/turns"

    private fun type(text: String) { input.performTextClearance(); if (text.isNotEmpty()) input.performTextInput(text) }
    private fun boxText(): String = input.fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.EditableText].text
    private fun optimizeCalls() = ComposerShell.bodies.filter { it.first == PromptOptimizerFixture.CALL }

    private fun suggestion() {
        type(PromptOptimizerFixture.DRAFT)
        await { has(button) }
        compose.onNode(button).performClick()
        await { has(hasTestTag("composer-optimization-card")) }
    }

    @Test fun theButtonIsAlwaysDrawnAndDisabledForAnEmptyBoxAShellCommandAndABareSlashCommand() {
        PromptOptimizerFixture.install()
        signIn(); openSession()
        await { has(button) }
        assertTrue("an empty box: drawn, disabled", has(button and isNotEnabled()))
        type("fix the login redirect bug"); await { has(button and isEnabled() and hasContentDescription(PromptOptimizerCopy.OPTIMIZE)) }
        type("!ls -la"); await { has(button and isNotEnabled()) }
        type("/compact"); await { has(button and isNotEnabled()) }
        type("/review the auth module"); await { has(button and isEnabled()) }
        type("  "); await { has(button and isNotEnabled()) }
    }

    @Test fun theSlotIsTheSameIdleAndBusySoNoToolbarControlMoves() {
        val gate = CompletableDeferred<Unit>()
        PromptOptimizerFixture.install()
        ComposerShell.gates[PromptOptimizerFixture.CALL] = gate
        signIn(); openSession()
        await { has(button) }
        fun bounds(m: SemanticsMatcher) = compose.onNode(m).fetchSemanticsNode().boundsInRoot
        val send = hasTestTag("composer-send")
        val empty = bounds(button)
        type(PromptOptimizerFixture.DRAFT)
        await { has(button and isEnabled()) }
        val idle = bounds(button)
        val sendIdle = bounds(send)
        assertEquals("typing the first words moves nothing", empty, idle)
        assertEquals(PromptOptimizer.BUTTON_SIDE_DP.toFloat(), with(compose.density) { idle.width.toDp().value }, 0.5f)
        compose.onNode(button).performClick()
        await { has(button and hasContentDescription(PromptOptimizerCopy.OPTIMIZING)) }
        assertEquals("busy, the spinner takes the same slot", idle, bounds(button))
        assertEquals("and Send does not move", sendIdle, bounds(send))
        gate.complete(Unit)
    }

    private fun neverDrawn(on: Boolean?, available: Boolean) {
        PromptOptimizerFixture.install(on, available)
        signIn(); openSession()
        await { ComposerShell.calls.contains("GET users/me") }
        type("fix the login redirect bug")
        await { has(hasTestTag("composer-send") and hasText("Send") and isEnabled()) }
        compose.waitForIdle()
        assertFalse(has(button))
    }

    @Test fun theButtonIsNeverDrawnWithTheSwitchOff() = neverDrawn(on = false, available = true)

    @Test fun theButtonIsNeverDrawnOnAServerWithoutAKey() = neverDrawn(on = null, available = false)

    @Test fun aPressSendsTheSessionsDraftAndPressingTheBusyButtonCancels() {
        val gate = CompletableDeferred<Unit>()
        PromptOptimizerFixture.install()
        ComposerShell.gates[PromptOptimizerFixture.CALL] = gate
        signIn(); openSession()
        type(PromptOptimizerFixture.DRAFT)
        await { has(button) }
        compose.onNode(button).performClick()
        await { has(button and hasContentDescription(PromptOptimizerCopy.OPTIMIZING)) }
        // The session's own id (either form is a public id to the server), and no workspace: the session supplies it.
        val asked = ComposerShell.body(PromptOptimizerFixture.CALL)!!
        assertEquals(setOf("draft", "sessionId"), asked.keys)
        assertEquals(PromptOptimizerFixture.DRAFT, asked["draft"]!!.jsonPrimitive.content)
        assertTrue(ObjectId.same(asked["sessionId"]!!.jsonPrimitive.content, ComposerShell.SESSION))
        // Busy, the box stays editable and the press cancels: the late answer is dropped.
        compose.onNode(button).performClick()
        await { has(button and hasContentDescription(PromptOptimizerCopy.OPTIMIZE)) }
        gate.complete(Unit)
        compose.waitForIdle()
        assertFalse(has(hasTestTag("composer-optimization-card")))
        assertEquals(PromptOptimizerFixture.DRAFT, boxText())
    }

    @Test fun theSheetLeavesTheBoxAloneUntilUseAndUndoPutsTheDraftBack() {
        PromptOptimizerFixture.install()
        signIn(); openSession()
        suggestion()
        // Frame 4: the card's words, its chips (an unknown kind drawn as nothing) and the gloss's toggle; the box untouched.
        await { shows(PromptOptimizerCopy.CARD_TITLE) }
        // D2: it opens in the owner's language, and says what the agent gets.
        assertTrue(has(hasTestTag("composer-optimization-text") and hasText(PromptOptimizerFixture.GLOSS)))
        compose.onNodeWithTag("composer-optimization-agent-note").assertTextEquals("The agent receives the English version.")
        assertEquals(listOf("this session's last 6 turns", "session recap", "project \"Auth cleanup\" goal", "2 wiki entries"),
            compose.onAllNodesWithTag("composer-optimization-chip").fetchSemanticsNodes().map {
                it.config[androidx.compose.ui.semantics.SemanticsProperties.Text].joinToString("") { t -> t.text } })
        assertTrue(shows(PromptOptimizerCopy.USED))
        // However long the words, the toggle and the actions stay on screen (they scroll; these do not).
        for (tag in listOf("composer-optimization-gloss", "composer-optimization-use", "composer-optimization-edit", "composer-optimization-retry"))
            compose.onNodeWithTag(tag).assertIsDisplayed()
        assertEquals(PromptOptimizerFixture.DRAFT, boxText())
        // The prompt in its own language — named, not assumed — then back to the gloss.
        compose.onNodeWithTag("composer-optimization-gloss").assertTextEquals("Show in English").performClick()
        await { has(hasTestTag("composer-optimization-text") and hasText("After signing in", substring = true)) }
        compose.onNodeWithTag("composer-optimization-gloss").assertTextEquals("Show in Chinese").performClick()
        await { has(hasTestTag("composer-optimization-text") and hasText(PromptOptimizerFixture.GLOSS)) }
        assertEquals(PromptOptimizerFixture.DRAFT, boxText())
        // Use: the box takes the gloss, the sheet goes, and Undo is offered (frame 5).
        compose.onNodeWithTag("composer-optimization-use").performClick()
        await { !has(hasTestTag("composer-optimization-card")) }
        assertEquals(PromptOptimizerFixture.inserted, boxText())
        await { has(hasTestTag("composer-optimization-undo-toast")) }
        assertTrue(shows(PromptOptimizerCopy.REPLACED))
        compose.onNodeWithTag("composer-optimization-undo").performClick()
        await { boxText() == PromptOptimizerFixture.DRAFT }
        await { !has(hasTestTag("composer-optimization-undo-toast")) }
        // Nothing was sent by any of it.
        assertNull(ComposerShell.body(turns))
    }

    @Test fun undoGoesOnceTheBoxIsEdited() {
        PromptOptimizerFixture.install()
        signIn(); openSession()
        suggestion()
        compose.onNodeWithTag("composer-optimization-use").performClick()
        await { has(hasTestTag("composer-optimization-undo-toast")) }
        input.performTextInput(" Also check iOS.")
        await { !has(hasTestTag("composer-optimization-undo-toast")) }
    }

    @Test fun dismissKeepsTheDraftAndEditThenUseFillsTheBox() {
        PromptOptimizerFixture.install()
        signIn(); openSession()
        suggestion()
        compose.onNodeWithTag("composer-optimization-dismiss").performClick()
        await { !has(hasTestTag("composer-optimization-card")) }
        assertEquals(PromptOptimizerFixture.DRAFT, boxText())
        assertFalse(has(hasTestTag("composer-optimization-undo-toast")))
        // Try again from the card asks again; Edit, then use fills the box as Use does.
        compose.onNode(button).performClick()
        await { has(hasTestTag("composer-optimization-card")) }
        compose.onNodeWithTag("composer-optimization-retry").performClick()
        await { optimizeCalls().size == 3 }
        await { has(hasTestTag("composer-optimization-card")) }
        compose.onNodeWithTag("composer-optimization-edit").performClick()
        await { boxText() == PromptOptimizerFixture.inserted }
        assertFalse(has(hasTestTag("composer-optimization-card")))
    }

    @Test fun aFailureLeavesTheDraftAndTryAgainAsksAgain() {
        var fail = true
        PromptOptimizerFixture.install {
            if (fail) ApiResponse(422, """{"code":"PROMPT_OPTIMIZATION_FAILED","reason":"TIMEOUT"}""".encodeToByteArray())
            else ApiResponse(200, PromptOptimizerFixture.answer().encodeToByteArray())
        }
        signIn(); openSession()
        type(PromptOptimizerFixture.DRAFT)
        await { has(button) }
        compose.onNode(button).performClick()
        await { has(hasTestTag("composer-optimization-failed")) }
        assertTrue(shows(PromptOptimizerCopy.FAILED))
        assertTrue(shows(PromptOptimizerCopy.TRY_AGAIN))
        assertEquals("Couldn't optimize this draft.", PromptOptimizerCopy.FAILED)
        assertEquals(PromptOptimizerFixture.DRAFT, boxText())
        assertFalse(has(hasTestTag("composer-optimization-card")))
        fail = false
        compose.onNodeWithTag("composer-optimization-failed-retry").performClick()
        await { has(hasTestTag("composer-optimization-card")) }
        assertFalse(has(hasTestTag("composer-optimization-failed")))
        // Dismissed, the failure line goes too.
        compose.onNodeWithTag("composer-optimization-dismiss").performClick()
        fail = true
        compose.onNode(button).performClick()
        await { has(hasTestTag("composer-optimization-failed")) }
        compose.onNode(hasContentDescription(PromptOptimizerCopy.DISMISS) and hasAnyAncestor(hasTestTag("composer-optimization-failed"))).performClick()
        await { !has(hasTestTag("composer-optimization-failed")) }
        assertEquals(PromptOptimizerFixture.DRAFT, boxText())
    }

    @Test fun aTurnOfTheUneditedGlossCarriesTheOptimizedPrompt() {
        PromptOptimizerFixture.install()
        signIn(); openSession()
        suggestion()
        compose.onNodeWithTag("composer-optimization-use").performClick()
        await { boxText() == PromptOptimizerFixture.inserted }
        compose.onNodeWithTag("composer-send").performClick()
        await { ComposerShell.body(turns) != null }
        assertEquals(JsonPrimitive(PromptOptimizerFixture.prompt), ComposerShell.body(turns)!!["optimizedTranslation"])
        assertNull(ComposerShell.body(turns)!!["skipTranslation"])
        assertEquals(PromptOptimizerFixture.inserted.trim(), ComposerShell.body(turns)!!["content"]!!.jsonPrimitive.content)
        // Spent: the same words typed again are the owner's, and translated.
        await { boxText().isEmpty() }
        type(PromptOptimizerFixture.inserted)
        compose.onNodeWithTag("composer-send").performClick()
        await { ComposerShell.bodies.count { it.first == turns } == 2 }
        assertNull(ComposerShell.body(turns)!!["optimizedTranslation"])
    }

    @Test fun anEditedOptimizedTextIsTranslatedAsUsual() {
        PromptOptimizerFixture.install()
        signIn(); openSession()
        suggestion()
        compose.onNodeWithTag("composer-optimization-use").performClick()
        await { boxText() == PromptOptimizerFixture.inserted }
        input.performTextInput(" Also check iOS.")
        compose.onNodeWithTag("composer-send").performClick()
        await { ComposerShell.body(turns) != null }
        assertNull(ComposerShell.body(turns)!!["optimizedTranslation"])
    }

    @Test fun aPromptInTheDraftsOwnLanguageIsNeverSkipped() {
        PromptOptimizerFixture.install { ApiResponse(200, PromptOptimizerFixture.answer(gloss = false, language = "zh-Hans").encodeToByteArray()) }
        signIn(); openSession()
        suggestion()
        assertFalse("no gloss, no toggle", has(hasTestTag("composer-optimization-gloss")))
        assertFalse("no gloss, no note", has(hasTestTag("composer-optimization-agent-note")))
        compose.onNodeWithTag("composer-optimization-use").performClick()
        await { boxText() == PromptOptimizerFixture.prompt }
        compose.onNodeWithTag("composer-send").performClick()
        await { ComposerShell.body(turns) != null }
        assertNull(ComposerShell.body(turns)!!["optimizedTranslation"])
        assertNull(ComposerShell.body(turns)!!["skipTranslation"])
    }

    @Test fun aReviveCarriesTheFlag() {
        ComposerShell.session = ComposerShell.fields("""{"status":"ENDED","runState":"ENDED","capabilities":{"canSend":false,"canResume":true}}""")
        PromptOptimizerFixture.install()
        signIn(); openSession()
        suggestion()
        compose.onNodeWithTag("composer-optimization-use").performClick()
        await { boxText() == PromptOptimizerFixture.inserted }
        compose.onNodeWithTag("composer-send").performClick()
        val resume = "POST sessions/${ComposerShell.SESSION}/resume"
        await { ComposerShell.body(resume) != null }
        assertEquals(JsonPrimitive(PromptOptimizerFixture.prompt), ComposerShell.body(resume)!!["optimizedTranslation"])
    }

    @Test fun aNewSessionNamesItsWorkspaceAndItsOpeningMessageCarriesTheFlag() {
        PromptOptimizerFixture.install()
        signIn(); openDraft()
        suggestion()
        val asked = ComposerShell.body(PromptOptimizerFixture.CALL)!!
        assertEquals(setOf("draft", "workspaceId"), asked.keys)
        assertTrue(ObjectId.same(asked["workspaceId"]!!.jsonPrimitive.content, ComposerShell.WORKSPACE))
        compose.onNodeWithTag("composer-optimization-use").performClick()
        await { boxText() == PromptOptimizerFixture.inserted }
        compose.onNodeWithTag("composer-send").performClick()
        await { ComposerShell.body("POST sessions") != null }
        assertEquals(JsonPrimitive(PromptOptimizerFixture.prompt), ComposerShell.body("POST sessions")!!["optimizedTranslation"])
        assertEquals(PromptOptimizerFixture.inserted.trim(), ComposerShell.body("POST sessions")!!["prompt"]!!.jsonPrimitive.content)
    }
}
