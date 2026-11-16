package io.orbitd.android.core.promptoptimizer

import io.orbitd.android.core.auth.AccountKey
import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Prompt optimizer (docs/prompt-optimizer-design.md, board docs/mocks/prompt-optimizer), OrbitKit's PromptOptimizerTests case for
 * case: the wire shapes of @orbit/shared prompt-optimizer.ts, the composer's button rule, Use / Undo, and when a send carries
 * `skipTranslation`. */
class PromptOptimizerTest {
    private fun decode(json: String) = PromptOptimization.decode(Wire.json.parseToJsonElement(json))

    /** The board's frame 4 answer, with Translation on: English, a gloss, and every context kind. */
    private val boardAnswer = """
    {"segments":[{"text":"After signing in, users land on the wrong page. ","added":false},
                 {"text":"The redirect target is meant to come from the `returnTo` query parameter.","added":true}],
     "text":"After signing in, users land on the wrong page. The redirect target is meant to come from the `returnTo` query parameter.",
     "language":"en",
     "gloss":"登录后用户落在错误的页面。",
     "contextUsed":[{"kind":"TURNS","count":6},{"kind":"RECAP"},{"kind":"PROJECT","title":"Auth cleanup"},
                    {"kind":"WIKI","count":2},{"kind":"WORKSPACE","name":"orbit"}]}
    """

    // Decoding

    @Test fun decodesEveryContextKindAndTheGloss() {
        val o = decode(boardAnswer)
        assertEquals(2, o.segments.size)
        assertFalse(o.segments[0].added)
        assertTrue(o.segments[1].added)
        assertEquals(o.segments.joinToString("") { it.text }, o.text)
        assertEquals("en", o.language)
        assertEquals("en", o.promptLanguage)
        assertTrue(o.isInAgentLanguage)
        assertEquals("登录后用户落在错误的页面。", o.gloss)
        assertEquals(listOf(PromptOptimizationContext.Turns(6), PromptOptimizationContext.Recap, PromptOptimizationContext.Project("Auth cleanup"),
            PromptOptimizationContext.Wiki(2), PromptOptimizationContext.Workspace("orbit")), o.contextUsed)
        assertEquals(listOf("this session's last 6 turns", "session recap", "project \"Auth cleanup\" goal", "2 wiki entries", "workspace \"orbit\""),
            o.chips)
    }

    @Test fun decodesAnAnswerWithoutAGlossInTheDraftsOwnLanguage() {
        val o = decode("""{"segments":[{"text":"修复登录跳转","added":false}],"text":"修复登录跳转","language":"zh-Hans","contextUsed":[]}""")
        assertNull(o.gloss)
        assertEquals("zh-Hans", o.promptLanguage)
        assertFalse(o.isInAgentLanguage)
        assertTrue(o.chips.isEmpty())
    }

    @Test fun anEmptyGlossIsNoGlossAndAMissingTextIsTheSegmentsJoined() {
        val o = decode("""{"segments":[{"text":"a ","added":false},{"text":"b","added":true}],"language":"en","gloss":""}""")
        assertNull(o.gloss)
        assertEquals("a b", o.text)
        assertTrue(o.contextUsed.isEmpty())
        // A missing `added` is not added; a missing language is English.
        val bare = decode("""{"segments":[{"text":"x"}]}""")
        assertFalse(bare.segments.single().added)
        assertEquals("en", bare.language)
    }

    @Test fun singularChipsAndAnUnknownKindDecodeWithoutFailingTheAnswer() {
        val o = decode("""{"segments":[{"text":"x","added":false}],"text":"x","language":"en",
            "contextUsed":[{"kind":"TURNS","count":1},{"kind":"WIKI","count":1},{"kind":"FILES","count":3},{"nokind":true},"junk"]}""")
        assertEquals(listOf(PromptOptimizationContext.Turns(1), PromptOptimizationContext.Wiki(1), PromptOptimizationContext.Unknown("FILES")),
            o.contextUsed)
        assertEquals(listOf("this session's last turn", "1 wiki entry"), o.chips)
        // An unreadable contextUsed is none, not a failure.
        assertTrue(decode("""{"segments":[],"contextUsed":"nope"}""").contextUsed.isEmpty())
    }

    @Test fun anAnswerWithoutSegmentsIsAFailure() {
        try { decode("""{"text":"x","language":"en"}"""); fail("decoded an answer without segments") } catch (_: IllegalStateException) { }
    }

    @Test fun theRequestBodyLeavesOutWhatItDoesNotName() {
        val body = PromptOptimizationRequest("fix it", sessionId = "S1").toJson()
        assertEquals(buildJsonObject { put("draft", "fix it"); put("sessionId", "S1") }, body)
        val draft = PromptOptimizationRequest("x", workspaceId = "W1", projectId = "P1").toJson()
        assertEquals(setOf("draft", "workspaceId", "projectId"), draft.keys)
    }

    /** Answers [answer] for every request, and keeps what was asked. */
    private class Door(val answer: (ApiRequest) -> Pair<Int, String>) : OrbitApi {
        val sent = mutableListOf<ApiRequest>()
        override suspend fun request(handle: SessionHandle, request: ApiRequest): ApiResponse {
            sent += request
            val (status, body) = answer(request)
            return ApiResponse(status, body.encodeToByteArray()).requireSuccess()
        }
    }
    private val handle = SessionHandle(AccountKey("https://orbit.example/", "u"))

    @Test fun theCallPostsTheDraftAndWaitsLongerThanTheDefault() = runTest {
        val door = Door { 200 to boardAnswer }
        val o = door.optimizePrompt(handle, PromptOptimizationRequest("fix the login redirect bug", sessionId = "S1"))
        val sent = door.sent.single()
        assertEquals(HttpMethod.POST, sent.method)
        assertEquals(listOf("prompt-optimizations"), sent.path)
        assertEquals(buildJsonObject { put("draft", "fix the login redirect bug"); put("sessionId", "S1") },
            Wire.json.parseToJsonElement(sent.body!!.decodeToString()).jsonObject)
        // DeepSeek has 20 s on the server; OkHttp's default read wait is 10 s.
        assertEquals(PromptOptimizer.READ_TIMEOUT_SECONDS, sent.readTimeoutSeconds)
        assertTrue(PromptOptimizer.READ_TIMEOUT_SECONDS > 20)
        assertEquals(5, o.chips.size)
    }

    @Test fun aRefusalThrows() = runTest {
        for ((status, body) in listOf(422 to """{"code":"PROMPT_OPTIMIZATION_FAILED","reason":"TIMEOUT"}""", 409 to """{"code":"PROMPT_OPTIMIZER_OFF"}""")) {
            try { Door { status to body }.optimizePrompt(handle, PromptOptimizationRequest("x")); fail("$status did not throw") }
            catch (e: ApiError) { assertEquals(status, e.status) }
        }
    }

    // Account switch

    private fun user(prefs: String, available: Boolean?): JsonObject = Wire.json.parseToJsonElement(
        """{"id":"u","email":"a@b.c","preferences":$prefs${available?.let { ",\"promptOptimizerAvailable\":$it" } ?: ""}}""").jsonObject

    @Test fun theSwitchIsOnUnlessExactlyFalseAndTheServerCan() {
        assertTrue("absent is on", PromptOptimizer.isOn(user("{}", true)))
        assertFalse(PromptOptimizer.isOn(user("""{"promptOptimizer":false}""", true)))
        assertTrue("a stray value reads as absent", PromptOptimizer.isOn(user("""{"promptOptimizer":"false"}""", true)))
        assertFalse("absent, but no server key", PromptOptimizer.isOn(user("{}", false)))
        assertTrue(PromptOptimizer.isOn(user("""{"promptOptimizer":true}""", true)))
        assertFalse(PromptOptimizer.isOn(user("""{"promptOptimizer":true}""", false)))
        assertFalse("a payload that does not say", PromptOptimizer.isOn(user("""{"promptOptimizer":true}""", null)))
        assertFalse(PromptOptimizer.isOn(null))
    }

    @Test fun onlyAMeThatSaysSoIsUnavailable() {
        assertTrue(PromptOptimizer.unavailable(user("{}", false)))
        assertFalse(PromptOptimizer.unavailable(user("{}", true)))
        assertFalse("a login payload", PromptOptimizer.unavailable(user("{}", null)))
    }

    // The button (frame 2)

    @Test fun theButtonShowsForAWordedDraftWithTheSwitchOn() {
        assertTrue(PromptOptimizer.showsButton(true, "fix the login redirect bug"))
        assertTrue("a command with words after it is a draft", PromptOptimizer.showsButton(true, "/review the auth module"))
        assertFalse("switch off", PromptOptimizer.showsButton(false, "fix the login redirect bug"))
    }

    @Test fun theButtonHidesForAnEmptyBoxAShellCommandAndABareSlashCommand() {
        assertFalse(PromptOptimizer.showsButton(true, ""))
        assertFalse(PromptOptimizer.showsButton(true, "  \n "))
        assertFalse("shell mode", PromptOptimizer.showsButton(true, "!ls -la"))
        assertFalse(PromptOptimizer.showsButton(true, " !git status"))
        assertFalse("only a /command", PromptOptimizer.showsButton(true, "/compact"))
        assertFalse(PromptOptimizer.showsButton(true, "/compact  "))
    }

    // The card's text

    @Test fun runsTintAdditionsAndSetCodeSpansApart() {
        val runs = PromptOptimizer.runs(listOf(PromptOptimizationSegment("Fix it. ", false), PromptOptimizationSegment("Read `returnTo` first.", true),
            PromptOptimizationSegment("odd ` tick", false)))
        assertEquals(listOf(PromptOptimizer.Run("Fix it. ", false, false), PromptOptimizer.Run("Read ", true, false),
            PromptOptimizer.Run("returnTo", true, true), PromptOptimizer.Run(" first.", true, false), PromptOptimizer.Run("odd ` tick", false, false)), runs)
    }

    @Test fun showInNamesTheLanguageWithoutItsParenthesis() {
        assertEquals("Show in Chinese", PromptOptimizerCopy.showIn("zh-Hans"))
        assertEquals("Show in Japanese", PromptOptimizerCopy.showIn("ja"))
    }

    @Test fun backFromTheGlossNamesThePromptsLanguageNotEnglish() {
        assertEquals("Show in English", PromptOptimizerCopy.showPrompt("en"))
        assertEquals("Show in Japanese", PromptOptimizerCopy.showPrompt("ja"))
        assertEquals("Show original", PromptOptimizerCopy.showPrompt(null))
        assertNull(decode("""{"segments":[{"text":"x","added":false}],"language":"xx-unknown","gloss":"y"}""").promptLanguage)
    }

    // Use and Undo (frames 4–5)

    private fun suggested(json: String = boardAnswer, draft: String = "fix the login redirect bug"): PromptOptimizerState {
        val out = PromptOptimizerState().start(draft)
        assertTrue(out.isOptimizing)
        return out.succeeded(decode(json))
    }

    @Test fun theSuggestionLeavesTheBoxAloneUntilUse() {
        val state = suggested()
        assertTrue(state.suggestion != null)
        assertFalse(state.isOptimizing)
        assertFalse(state.offersUndo("fix the login redirect bug"))
        assertFalse(state.skipTranslation("fix the login redirect bug"))
        val dismissed = state.dismiss()
        assertNull("× / back: the card goes, the draft stays", dismissed.suggestion)
        assertSame("nothing to use once dismissed", dismissed, dismissed.use("fix the login redirect bug"))
    }

    @Test fun useReplacesTheDraftAndUndoPutsItBack() {
        val draft = "fix the login redirect bug"
        val before = suggested()
        val inserted = before.suggestion!!.text
        val used = before.use(draft)
        assertTrue(inserted.startsWith("After signing in"))
        assertEquals(inserted, used.inserted)
        assertNull("the card goes on Use", used.suggestion)
        assertTrue(used.offersUndo(inserted))
        assertEquals(draft, used.undoDraft)
        val undone = used.undo(inserted)
        assertFalse(undone.offersUndo(draft))
        assertSame("Undo once", undone, undone.undo(draft))
        assertFalse("the owner's own words are translated as usual", undone.skipTranslation(draft))
    }

    @Test fun undoIsNotOfferedOnceTheTextWasEditedOrTheToastWent() {
        val used = suggested().use("draft")
        val inserted = used.inserted!!
        assertFalse(used.offersUndo("$inserted please"))
        assertSame(used, used.undo("$inserted please"))
        val forgot = used.forgetUndo()
        assertFalse(forgot.offersUndo(inserted))
        assertTrue("the toast going does not edit the text", forgot.skipTranslation(inserted))
    }

    @Test fun basedOnAnEarlierDraftWhenTheBoxChangedWhileOptimizing() {
        val state = suggested(draft = "fix it")
        assertFalse(state.basedOnEarlierDraft("fix it"))
        assertTrue(state.basedOnEarlierDraft("fix it now"))
    }

    @Test fun aFailureKeepsTheDraftAndCancelDropsThePress() {
        val failed = PromptOptimizerState().start("x").failedNow()
        assertTrue(failed.failed)
        assertNull(failed.suggestion)
        assertFalse(failed.dismiss().failed)
        val cancelled = PromptOptimizerState().start("x").cancel()
        assertEquals(PromptOptimizerState.Phase.Idle, cancelled.phase)
        assertNull("an answer after a cancel is dropped",
            cancelled.succeeded(PromptOptimization(listOf(PromptOptimizationSegment("late", false)), "en")).suggestion)
        assertFalse("a failure after a cancel is dropped", cancelled.failedNow().failed)
    }

    @Test fun theGlossToggleFlipsAndANewSuggestionStartsOnThePrompt() {
        val flipped = suggested().toggleGloss()
        assertTrue(flipped.showingGloss)
        assertFalse(flipped.dismiss().showingGloss)
        assertFalse(flipped.start("again").showingGloss)
    }

    // skipTranslation (D2)

    @Test fun skipTranslationOnlyForUneditedOptimizedAgentLanguageText() {
        val used = suggested().use("draft")
        val inserted = used.inserted!!
        assertTrue(used.skipTranslation(inserted))
        assertTrue("the send trims as Send does", used.skipTranslation(inserted + "\n"))
        assertFalse("edited: translated as usual", used.skipTranslation("$inserted Also check iOS."))
        assertFalse(used.skipTranslation("something else"))
        assertFalse("spent by the send", used.sent().skipTranslation(inserted))
    }

    @Test fun skipTranslationForAChosenAgentLanguageNotOnlyEnglish() {
        val used = suggested("""{"segments":[{"text":"ログインのリダイレクトを直して","added":false}],"language":"ja","gloss":"修复登录跳转","contextUsed":[]}""").use("draft")
        assertTrue(used.skipTranslation(used.inserted!!))
        assertFalse(used.skipTranslation(used.inserted + "!"))
    }

    @Test fun noSkipForAPromptInTheDraftsOwnLanguage() {
        val used = suggested("""{"segments":[{"text":"修复登录跳转","added":false}],"text":"修复登录跳转","language":"zh-Hans","contextUsed":[]}""").use("draft")
        assertFalse(used.skipTranslation(used.inserted!!))
    }

    @Test fun theSendBodiesCarrySkipTranslationOnlyWhenSet() {
        val body = buildJsonObject { put("clientTurnId", "c"); put("content", "t") }
        assertSame(body, PromptOptimizer.withSkipTranslation(body, false))
        val skipped = PromptOptimizer.withSkipTranslation(body, true)
        assertEquals(JsonPrimitive(true), skipped["skipTranslation"])
        assertEquals("t", (skipped["content"] as JsonPrimitive).content)
    }
}
