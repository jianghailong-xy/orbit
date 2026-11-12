package io.orbitd.android.translation

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.ui.test.*
import io.orbitd.android.composer.ComposerShell
import io.orbitd.android.composer.ComposerShellTest
import io.orbitd.android.core.net.ApiResponse
import java.io.File
import org.junit.Assert.*
import org.junit.Test
import org.robolectric.annotation.GraphicsMode

/**
 * Settings › Translation in an Android conversation (docs/mocks/session-translation/01-board.png, frames 4–6 and 10), in the production
 * shell over [ComposerShell]: the owner's message shown as they wrote it and the agent's reply in their language, each with its own
 * Show original; the composer's "Chinese → English" tag; a message held while it is translated and one that failed, with Retry and
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
        assertTrue(has(text(TranslationCopy.TRANSLATED, substring = false) and row(1), unmerged = true))
        assertTrue(has(action(TranslationCopy.SHOW_ORIGINAL, 1), unmerged = true))
        assertTrue(has(action(TranslationCopy.SHOW_ORIGINAL, 2), unmerged = true))
        // Frame 10's composer: the tag says which way the words go.
        assertTrue(has(hasTestTag("composer-translation-tag") and hasText("Chinese → English"), unmerged = true))
        shot("1-conversation-translated")

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
        assertTrue(has(text(TranslationCopy.SENT_IN_ENGLISH) and row(1), unmerged = true))
        // And back.
        compose.onNode(action(TranslationCopy.SHOW_TRANSLATION, 2), useUnmergedTree = true).performClick()
        await { has(text("原因找到了") and row(2), unmerged = true) }
        compose.onNode(action(TranslationCopy.SHOW_TRANSLATION, 1), useUnmergedTree = true).performClick()
        await { has(text(askedZh) and row(1), unmerged = true) }
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
