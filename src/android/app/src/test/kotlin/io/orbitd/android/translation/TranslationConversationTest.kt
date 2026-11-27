package io.orbitd.android.translation

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.unit.dp
import io.orbitd.android.composer.ComposerShell
import io.orbitd.android.composer.ComposerShellTest
import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.toast.OrbitToasts
import java.io.File
import org.junit.Assert.*
import org.junit.Test
import org.robolectric.annotation.GraphicsMode

/**
 * Settings › Translation in an Android conversation (docs/mocks/session-translation/01-board.png, frames 4–6 and 10), in the production
 * shell over [ComposerShell]: the owner's message shown as they wrote it and the agent's reply in their language, each with its own
 * Show original; the composer's "<Language> → <Agent language>" tag ("Chinese → English", or "Chinese → Japanese"); a message held while it is translated and one that failed, with Retry and
 * Send as written; a reply streaming, one waiting for its translation, one whose translation failed with Retry, and the live
 * translation landing. The NATIVE frames go under `src/android/build/evidence/session-translation-android/` beside their semantics.
 */
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TranslationConversationTest : ComposerShellTest() {
    private val s = ComposerShell.SESSION
    private val askedZh = "登录页在 Safari 上点 Google 登录没反应，帮我查一下原因并修好"
    private val askedEn = "The Google sign-in button on the login page does nothing in Safari. Find out why and fix it."
    private val replyEn = "Found it: Safari blocks popups that aren't opened directly by a click. The button calls `signInWithPopup` only after " +
        "`await loadGoogleScript()`, which no longer counts as a user gesture.\n\nFix: load the script on page load and open the popup synchronously on click. Want me to make the change?"
    private val replyZh = "原因找到了：Safari 会拦截不是由点击直接触发的弹窗。按钮在 `await loadGoogleScript()` 之后才调用 `signInWithPopup`，这时已经不算用户手势了。\n\n修法：页面加载时预先加载脚本，点击时同步打开弹窗。要我直接改吗？"

    private fun translatedConversation() {
        ComposerShell.answers["GET users/me"] = { ApiResponse(200, """{"id":"u1","email":"owner@a07c.test","name":"Owner",
            "preferences":{"translationEnabled":true,"translationLanguage":"zh-Hans"},"translationAvailable":true}""".encodeToByteArray()) }
        ComposerShell.events = listOf(
            ComposerShell.obj("""{"type":"user","seq":1,"turnId":"t-1","ts":"2026-11-12T01:00:00Z","payload":{"text":"$askedEn",
                "translation":{"state":"DONE","from":"zh-Hans","original":"$askedZh"}}}"""),
            ComposerShell.obj(buildString {
                append("""{"type":"assistant","seq":2,"turnId":"t-1","payload":{"text":""")
                append(kotlinx.serialization.json.JsonPrimitive(replyEn)); append(""","translation":{"lang":"zh-Hans","text":""")
                append(kotlinx.serialization.json.JsonPrimitive(replyZh)); append("}}}")
            }),
            ComposerShell.obj("""{"type":"turn_end","seq":3,"turnId":"t-1","payload":{"subtype":"success"}}"""))
    }

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/session-translation-android").also { it.mkdirs() }
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        File(output, "$name-semantics.txt").writeText(compose.onRoot(useUnmergedTree = true).printToString())
        val view = compose.activity.window.decorView
        assertTrue("$name: never laid out", view.width > 0 && view.height > 0)
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        val pixels = IntArray(bitmap.width * bitmap.height).also { bitmap.getPixels(it, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height) }
        assertTrue("$name: the shot is blank", pixels.any { it != 0 })
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        println("shot $name ${bitmap.width}×${bitmap.height} -> ${File(output, "$name.png")}")
        bitmap.recycle()
    }

    private fun row(seq: Int) = hasAnyAncestor(hasTestTag("event:$seq"))
    private fun text(t: String, substring: Boolean = true) = hasText(t, substring = substring)
    private fun action(label: String, seq: Int) = hasTestTag("translation-action:$label") and row(seq)

    @Test fun aTranslatedConversationShowsTheOwnersLanguageAndEachMessageFlipsToTheEnglish() {
        translatedConversation()
        signIn(); openSession()
        // Frame 4: what the owner wrote, and the reply in their language; the English is a press away on each.
        await { has(text(askedZh) and row(1), unmerged = true) }
        assertTrue(has(text("原因找到了") and row(2), unmerged = true))
        assertFalse("the English is not drawn", has(text("does nothing in Safari"), unmerged = true))
        assertFalse(has(text("Safari blocks popups"), unmerged = true))
        assertFalse("the owner's message has the press alone", has(text(TranslationCopy.TRANSLATED, substring = false) and row(1), unmerged = true))
        assertTrue(has(action(TranslationCopy.SHOW_ORIGINAL, 1), unmerged = true))
        assertTrue(has(action(TranslationCopy.SHOW_ORIGINAL, 2), unmerged = true))
        // Frame 10's composer: the tag says which way the words go.
        assertTrue(has(hasTestTag("composer-translation-tag") and hasText("Chinese → English"), unmerged = true))
        shot("1-conversation-translated")
        // Like the placeholder, the tag gives way once the owner types, and comes back when the box is empty.
        compose.onNodeWithTag("composer-input").performTextInput("hi")
        await { !has(hasTestTag("composer-translation-tag"), unmerged = true) }
        compose.onNodeWithTag("composer-input").performTextClearance()
        await { has(hasTestTag("composer-translation-tag"), unmerged = true) }

        // Frame 10: the reply flipped to the English the agent wrote — "Original · Show translation" — and only that one.
        compose.onNode(action(TranslationCopy.SHOW_ORIGINAL, 2), useUnmergedTree = true).performClick()
        await { has(text("Safari blocks popups") and row(2), unmerged = true) }
        assertFalse(has(text("原因找到了"), unmerged = true))
        assertTrue(has(text(TranslationCopy.ORIGINAL, substring = false) and row(2), unmerged = true))
        assertTrue(has(action(TranslationCopy.SHOW_TRANSLATION, 2), unmerged = true))
        assertTrue("the message keeps its own side", has(text(askedZh) and row(1), unmerged = true))
        shot("2-reply-show-original")

        // The owner's message flips to what reached the agent.
        compose.onNode(action(TranslationCopy.SHOW_ORIGINAL, 1), useUnmergedTree = true).performClick()
        await { has(text("does nothing in Safari") and row(1), unmerged = true) }
        assertTrue(has(action(TranslationCopy.SHOW_TRANSLATION, 1), unmerged = true))
        // And back.
        compose.onNode(action(TranslationCopy.SHOW_TRANSLATION, 2), useUnmergedTree = true).performClick()
        await { has(text("原因找到了") and row(2), unmerged = true) }
        compose.onNode(action(TranslationCopy.SHOW_TRANSLATION, 1), useUnmergedTree = true).performClick()
        await { has(text(askedZh) and row(1), unmerged = true) }
    }

    /** Translation D2: scrolled back off the tail, the bar's capsule quotes what the owner wrote, as the bubble does — not the English. */
    @Test fun theStickyQuestionQuotesTheOwnersOwnWords() {
        translatedConversation()
        ComposerShell.events = ComposerShell.events.take(1) + (2..16).map { seq ->
            ComposerShell.obj(buildString {
                append("""{"type":"assistant","seq":$seq,"turnId":"t-1","payload":{"text":""")
                append(kotlinx.serialization.json.JsonPrimitive(replyEn)); append(""","translation":{"lang":"zh-Hans","text":""")
                append(kotlinx.serialization.json.JsonPrimitive(replyZh)); append("}}}")
            })
        } + ComposerShell.obj("""{"type":"turn_end","seq":17,"turnId":"t-1","payload":{"subtype":"success"}}""")
        signIn(); openSession()
        await { has(hasTestTag("event:16")) && has(hasTestTag("app-bar")) }
        compose.waitForIdle()
        compose.onNodeWithTag("transcript-list").performTouchInput {
            down(center); repeat(10) { moveBy(androidx.compose.ui.geometry.Offset(0f, 30f)) }; advanceEventTime(200); up()
        }
        val capsule = hasAnyAncestor(hasTestTag("question-capsule"))
        await { has(text(askedZh) and capsule, unmerged = true) }
        assertFalse("not the English the engine received", has(text("does nothing in Safari") and capsule, unmerged = true))
        shot("3-sticky-question")
    }

    @Test fun heldMessagesWaitingRepliesAndFailuresSayWhereTheyAreAndOfferTheWayOut() {
        translatedConversation()
        signIn(); openSession()
        await { has(text(askedZh) and row(1), unmerged = true) }

        // Frame 6 (G, J): one message being translated and one whose translation failed, held off the engine.
        ComposerShell.answers["GET sessions/$s/turns"] = { ApiResponse(200, """[
            {"turnId":"t-g","kind":"message","placement":"queued","content":"好的，改吧，顺便加个测试","attachments":[],"createdAt":"2026-11-12T01:05:00Z",
             "translation":{"state":"TRANSLATING","from":"zh-Hans","original":"好的，改吧，顺便加个测试"}},
            {"turnId":"t-j","kind":"message","placement":"queued","content":"再跑一遍全部测试","attachments":[],"createdAt":"2026-11-12T01:06:00Z",
             "translation":{"state":"FAILED","from":"zh-Hans","original":"再跑一遍全部测试"}}]""".encodeToByteArray()) }
        ComposerShell.push("""{"type":"queued_turns_changed","seq":0,"payload":{}}""")
        await { has(text(TranslationCopy.TRANSLATING) and hasAnyAncestor(hasTestTag("queued:t-g")), unmerged = true) }
        assertTrue(has(text("好的，改吧，顺便加个测试") and hasAnyAncestor(hasTestTag("queued:t-g")), unmerged = true))
        assertFalse("held for translation: in the conversation, not the tray", has(text("好的，改吧") and hasAnyAncestor(hasTestTag("pending-tray")), unmerged = true))
        val failed = hasAnyAncestor(hasTestTag("queued:t-j"))
        assertTrue(has(text(TranslationCopy.SEND_FAILED) and failed, unmerged = true))

        // Frame 6 (H, I): a reply waiting for its translation in a translated turn, and one whose translation failed.
        ComposerShell.push("""{"type":"user","seq":4,"turnId":"t-2","payload":{"text":"OK, change it and add a test",
            "translation":{"state":"DONE","from":"zh-Hans","original":"好的，改吧"}}}""")
        ComposerShell.push("""{"type":"assistant","seq":5,"turnId":"t-2","payload":{"text":"Done. The popup now opens synchronously on click."}}""")
        await { has(text(TranslationCopy.REPLY_PENDING) and row(5), unmerged = true) }
        ComposerShell.push("""{"type":"translation","seq":0,"payload":{"of":5,"lang":"zh-Hans","failed":true}}""")
        await { has(text(TranslationCopy.REPLY_FAILED) and row(5), unmerged = true) }
        assertTrue("the English is what there is", has(text("The popup now opens synchronously") and row(5), unmerged = true))
        // The streaming reply: the English greyed with its chip.
        ComposerShell.push("""{"type":"text_delta","seq":0,"turnId":"t-2","payload":{"delta":"I'll move the script load into a useEffect on mount and call"}}""")
        // Row 5 now says it failed, so the one chip on screen is the streaming reply's.
        await { has(text("useEffect on mount"), unmerged = true) && has(text(TranslationCopy.REPLY_PENDING), unmerged = true) }
        compose.onNodeWithTag("transcript-list").performScrollToNode(hasTestTag("queued:t-j"))
        shot("3-held-failed-and-streaming")

        // The ways out, each its own door.
        compose.onNode(hasTestTag("translation-action:${TranslationCopy.RETRY}") and failed, useUnmergedTree = true).performClick()
        await { ComposerShell.calls.contains("POST sessions/$s/turns/t-j/translation/retry") }
        compose.waitForIdle()
        await {
            if (!ComposerShell.calls.contains("POST sessions/$s/turns/t-j/translation/send-as-written"))
                compose.onNode(hasTestTag("translation-action:${TranslationCopy.SEND_AS_WRITTEN}") and failed, useUnmergedTree = true).performClick()
            ComposerShell.calls.contains("POST sessions/$s/turns/t-j/translation/send-as-written")
        }
        compose.onNodeWithTag("transcript-list").performScrollToNode(hasTestTag("event:5"))
        await {
            if (!ComposerShell.calls.contains("POST sessions/$s/events/5/translation/retry"))
                compose.onNode(action(TranslationCopy.RETRY, 5), useUnmergedTree = true).performClick()
            ComposerShell.calls.contains("POST sessions/$s/events/5/translation/retry")
        }

        // The retried translation lands live and replaces the English.
        ComposerShell.push("""{"type":"translation","seq":0,"payload":{"of":5,"lang":"zh-Hans","text":"改好了。现在点击时同步打开弹窗。"}}""")
        await { has(text("改好了") and row(5), unmerged = true) }
        assertFalse(has(text(TranslationCopy.REPLY_FAILED) and row(5), unmerged = true))
        assertTrue(has(action(TranslationCopy.SHOW_ORIGINAL, 5), unmerged = true))
    }

    /** Failure policy B (docs/ux/translation-failure-policy.html, frames 4B and 6): a held message says why it was not sent; while the
     *  server skips a failing translator the composer tag says messages will wait, until the instant passes (no read, no event) or the
     *  account event `translation.status_changed` brings a new answer. */
    @Test fun aHeldMessageSaysWhyAndTheTagWarnsWhileTranslationIsUnavailable() {
        translatedConversation()
        fun me(until: String?) = ApiResponse(200, """{"id":"u1","email":"owner@a07c.test","name":"Owner",
            "preferences":{"translationEnabled":true,"translationLanguage":"zh-Hans"},"translationAvailable":true,
            "translationUnavailableUntil":${until?.let { "\"$it\"" } ?: "null"}}""".encodeToByteArray())
        val soon = java.time.Instant.now().plusSeconds(4).toString()
        ComposerShell.answers["GET users/me"] = { me(soon) }
        val tag = hasTestTag("composer-translation-tag")
        signIn(); openSession()
        await { has(tag and hasText("Chinese → English · unavailable, messages will wait"), unmerged = true) }

        // 4B: the reason's sentence, then Retry and Send as written.
        ComposerShell.answers["GET sessions/$s/turns"] = { ApiResponse(200, """[
            {"turnId":"t-j","kind":"message","placement":"queued","content":"再跑一遍全部测试","attachments":[],"createdAt":"2026-11-12T01:06:00Z",
             "translation":{"state":"FAILED","from":"zh-Hans","original":"再跑一遍全部测试","failureReason":"UNAVAILABLE"}}]""".encodeToByteArray()) }
        ComposerShell.push("""{"type":"queued_turns_changed","seq":0,"payload":{}}""")
        val held = hasAnyAncestor(hasTestTag("queued:t-j"))
        await { has(text("Translation is unavailable right now, so it wasn't sent", substring = false) and held, unmerged = true) }
        assertFalse(has(text(TranslationCopy.SEND_FAILED) and held, unmerged = true))
        assertTrue(has(hasTestTag("translation-action:${TranslationCopy.RETRY}") and held, unmerged = true))
        assertTrue(has(hasTestTag("translation-action:${TranslationCopy.SEND_AS_WRITTEN}") and held, unmerged = true))
        compose.onNodeWithTag("transcript-list").performScrollToNode(hasTestTag("queued:t-j"))
        shot("10-held-unavailable-and-composer-tag")

        // The instant passes with no event: the ordinary tag again, drawn here without reading the account.
        val reads = ComposerShell.calls.count { it == "GET users/me" }
        await { has(tag and hasText("Chinese → English", substring = false), unmerged = true) }
        assertEquals("the expiry is local", reads, ComposerShell.calls.count { it == "GET users/me" })

        // The breaker opens again: the account event reads `users/me`, and the tag warns.
        ComposerShell.answers["GET users/me"] = { me(java.time.Instant.now().plusSeconds(60).toString()) }
        ComposerShell.pushControl("""{"type":"translation.status_changed","data":{}}""")
        await { has(tag and hasText("Chinese → English · unavailable, messages will wait"), unmerged = true) }
        // And closes: the next event clears it.
        ComposerShell.answers["GET users/me"] = { me(null) }
        ComposerShell.pushControl("""{"type":"translation.status_changed","data":{}}""")
        await { has(tag and hasText("Chinese → English", substring = false), unmerged = true) }
    }

    /** On a narrow phone the reason's sentence (4B) wraps, under what the owner wrote, and Retry and Send as written keep their width. */
    @Test @org.robolectric.annotation.Config(qualifiers = "w320dp-h700dp")
    fun aWrappedReasonLaysOutUnderTheMessageOnANarrowPhone() {
        translatedConversation()
        val wrote = "再跑一遍全部测试"
        ComposerShell.answers["GET sessions/$s/turns"] = { ApiResponse(200, """[
            {"turnId":"t-j","kind":"message","placement":"queued","content":"$wrote","attachments":[],"createdAt":"2026-11-12T01:06:00Z",
             "translation":{"state":"FAILED","from":"zh-Hans","original":"$wrote","failureReason":"TIMEOUT"}}]""".encodeToByteArray()) }
        signIn(); openSession()
        val held = hasAnyAncestor(hasTestTag("queued:t-j"))
        val sentence = "The translator didn't answer in time, so it wasn't sent"
        await { has(text(sentence, substring = false) and held, unmerged = true) }
        compose.onNodeWithTag("transcript-list").performScrollToNode(hasTestTag("queued:t-j"))
        compose.waitForIdle()
        fun bounds(m: SemanticsMatcher) = compose.onNode(m and held, useUnmergedTree = true).getUnclippedBoundsInRoot()
        val message = bounds(text(wrote))
        val line = bounds(text(sentence, substring = false))
        val retry = bounds(hasTestTag("translation-action:${TranslationCopy.RETRY}"))
        val asWritten = bounds(hasTestTag("translation-action:${TranslationCopy.SEND_AS_WRITTEN}"))
        val cancel = bounds(hasTestTag("translation-action:${TranslationCopy.CANCEL}"))
        val foot = bounds(hasTestTag("translation-foot"))
        assertTrue("the foot is under the message: $message / $foot", foot.top >= message.bottom)
        assertTrue("the sentence wraps at 320dp: ${line.bottom - line.top}", (line.bottom - line.top) > (retry.bottom - retry.top))
        assertTrue("the sentence stays in the foot: $line / $foot", line.bottom <= foot.bottom && line.top >= foot.top)
        assertTrue("Retry keeps its width: $retry", retry.right - retry.left > 20.dp)
        assertTrue("Send as written keeps its width: $asWritten", asWritten.right - asWritten.left > 60.dp)
        assertTrue("Send as written is on screen: $asWritten", asWritten.right <= 320.dp)
        assertTrue("Cancel keeps its width: $cancel", cancel.right - cancel.left > 20.dp)
        assertTrue("Cancel is on screen: $cancel", cancel.right <= 320.dp)
        shot("11-held-timeout-wrapped-320dp")
    }

    private fun heldFailed(extra: String = "") {
        ComposerShell.answers["GET sessions/$s/turns"] = { ApiResponse(200, """[
            {"turnId":"t-j","kind":"message","placement":"queued","content":"再跑一遍全部测试","createdAt":"2026-11-12T01:06:00Z",
             "attachments":[{"id":"att-1","mimeType":"text/plain","name":"notes.txt"}]$extra,
             "translation":{"state":"FAILED","from":"zh-Hans","original":"再跑一遍全部测试"}}]""".encodeToByteArray()) }
    }
    private val heldCancel = hasTestTag("translation-action:${TranslationCopy.CANCEL}") and hasAnyAncestor(hasTestTag("queued:t-j"))
    private fun box() = compose.onNodeWithTag("composer-input").fetchSemanticsNode().config.getOrNull(SemanticsProperties.EditableText)?.text
    private fun pressCancel() {
        await { has(heldCancel, unmerged = true) }
        compose.onNodeWithTag("transcript-list").performScrollToNode(hasTestTag("queued:t-j"))
        compose.onNode(heldCancel, useUnmergedTree = true).performClick()
    }

    /** Cancel (web 11ae4822b0): the held turn is withdrawn, and what the owner wrote goes back into the composer with its file —
     *  read before the DELETE, which drops it with the turn, and uploaded again. */
    @Test fun cancelWithdrawsAFailedMessageAndPutsItBackInTheComposer() {
        translatedConversation()
        heldFailed()
        ComposerShell.attachments = mapOf("att-1" to "notes".encodeToByteArray())
        ComposerShell.answers["DELETE sessions/$s/turns/t-j"] = {
            ComposerShell.answers["GET sessions/$s/turns"] = { ApiResponse(200, "[]".encodeToByteArray()) }
            ApiResponse(200, """{"ok":true}""".encodeToByteArray())
        }
        ComposerShell.answers["POST attachments"] = { ApiResponse(200, """{"id":"att-2"}""".encodeToByteArray()) }
        signIn(); openSession()
        pressCancel()
        await { box() == "再跑一遍全部测试" && ComposerShell.calls.any { it.startsWith("POST attachments") } }
        await { has(hasText("notes.txt", substring = true), unmerged = true) }
        assertFalse(has(hasTestTag("queued:t-j")))
        val calls = ComposerShell.calls.toList()
        assertTrue("the file is read before the turn goes", calls.indexOf("GET attachments/att-1") in 0 until calls.indexOf("DELETE sessions/$s/turns/t-j"))
    }

    @Test fun aRefusedCancelSaysSoAndKeepsTheMessage() {
        translatedConversation()
        heldFailed()
        ComposerShell.attachments = mapOf("att-1" to "notes".encodeToByteArray())
        ComposerShell.answers["DELETE sessions/$s/turns/t-j"] = { ApiResponse(409, """{"message":"message already started or not found"}""".encodeToByteArray()) }
        signIn(); openSession()
        OrbitToasts.clear()
        pressCancel()
        await { OrbitToasts.feed.value.front?.message == "Couldn't cancel the message" }
        await { has(heldCancel, unmerged = true) }
        assertEquals("", box())
    }

    @Test fun aFailedOpeningPromptHasNoCancel() {
        translatedConversation()
        heldFailed(""","opening":true""")
        signIn(); openSession()
        val held = hasAnyAncestor(hasTestTag("queued:t-j"))
        await { has(hasTestTag("translation-action:${TranslationCopy.SEND_AS_WRITTEN}") and held, unmerged = true) }
        assertFalse(has(heldCancel, unmerged = true))
    }

    /** docs/mocks/prompt-suggestion-room (option B): the engine's guess takes the box's line, so the tag gives way while one is on
     *  offer, and only its "unavailable" warning stays beside the guess. */
    @Test fun aSuggestionTakesTheTagsPlaceUnlessTheTagWarns() {
        translatedConversation()
        fun me(until: String?) = ApiResponse(200, """{"id":"u1","email":"owner@a07c.test","name":"Owner",
            "preferences":{"translationEnabled":true,"translationLanguage":"zh-Hans","promptSuggestions":true},"translationAvailable":true,
            "translationUnavailableUntil":${until?.let { "\"$it\"" } ?: "null"}}""".encodeToByteArray())
        ComposerShell.answers["GET users/me"] = { me(null) }
        ComposerShell.events = ComposerShell.events +
            ComposerShell.obj("""{"type":"prompt_suggestion","seq":4,"turnId":"t-1","payload":{"text":"再跑一遍全部测试","source":"engine"}}""")
        signIn(); openSession()
        val tag = hasTestTag("composer-translation-tag")
        await { has(hasTestTag("composer-suggestion-hint"), unmerged = true) }
        assertFalse("the guess has the line", has(tag, unmerged = true))
        shot("12-suggestion-without-tag")

        val later = java.time.Instant.now().plusSeconds(600).toString()
        ComposerShell.answers["GET users/me"] = { me(later) }
        ComposerShell.pushControl("""{"type":"translation.status_changed","data":{}}""")
        await { has(tag and hasText("Chinese → English · unavailable, messages will wait"), unmerged = true) }
        assertTrue("the guess stays beside the warning", has(hasTestTag("composer-suggestion-hint"), unmerged = true))
    }

    @Test fun theComposerTagNamesANonEnglishAgentLanguage() {
        translatedConversation()
        ComposerShell.answers["GET users/me"] = { ApiResponse(200, """{"id":"u1","email":"owner@a07c.test","name":"Owner",
            "preferences":{"translationEnabled":true,"translationLanguage":"zh-Hans","translationAgentLanguage":"ja"},
            "translationAvailable":true}""".encodeToByteArray()) }
        signIn(); openSession()
        await { has(hasTestTag("composer-translation-tag"), unmerged = true) }
        assertTrue(has(hasTestTag("composer-translation-tag") and hasText("Chinese → Japanese"), unmerged = true))
        assertFalse(has(hasText("Chinese → English"), unmerged = true))
        shot("9-composer-tag-japanese")
    }

    @Test fun withTranslationOffNothingIsTaggedOrGreyed() {
        ComposerShell.events = listOf(
            ComposerShell.obj("""{"type":"user","seq":1,"turnId":"t-1","payload":{"text":"Fix the login"}}"""),
            ComposerShell.obj("""{"type":"assistant","seq":2,"turnId":"t-1","payload":{"text":"On it."}}"""))
        signIn(); openSession()
        await { has(text("On it.") and row(2), unmerged = true) }
        assertFalse(has(hasTestTag("composer-translation-tag"), unmerged = true))
        assertFalse(has(hasTestTag("translation-foot"), unmerged = true))
        ComposerShell.push("""{"type":"text_delta","seq":0,"turnId":"t-1","payload":{"delta":"Looking"}}""")
        await { has(text("Looking"), unmerged = true) }
        assertFalse(has(hasTestTag("translation-chip"), unmerged = true))
    }
}
