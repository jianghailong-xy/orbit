package io.orbitd.android.translation

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.ui.test.*
import io.orbitd.android.composer.ComposerShell
import io.orbitd.android.composer.ComposerShellTest
import io.orbitd.android.core.net.ApiResponse
import java.io.File
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Test
import org.robolectric.annotation.GraphicsMode

/**
 * "Show both languages" in an Android conversation (docs/mocks/session-translation/02-bilingual.png, 03-interleaved.png), in the
 * production shell over [ComposerShell]: on, the owner's message shows their language on top and the English under a dashed divider; a
 * reply whose blocks pair with its translation's is drawn block by block, each original right under it and never collapsed; one that does
 * not pair is drawn whole as before, its long English collapsing to "Show English · N lines", which opens it in place. The feet lose the
 * flip ("Sent to the agent in English", "Translated"). Off — the account's default — the conversation is exactly today's. The NATIVE frames go under
 * `src/android/build/evidence/session-translation-android/` beside their semantics.
 */
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TranslationBilingualTest : ComposerShellTest() {
    private val askedZh = "登录页在 Safari 上点 Google 登录没反应，帮我查一下原因并修好"
    private val askedEn = "The Google sign-in button on the login page does nothing in Safari. Find out why and fix it."
    private val shortEn = "Let me look at how the login page calls `signInWithPopup`."
    private val shortZh = "我先看一下登录页里 Google 登录按钮的处理逻辑。"
    private val longEn = listOf(
        "Done. The popup now opens synchronously on click:",
        "1. The script preloads on page load in a useEffect;",
        "2. The click handler no longer awaits before signInWithPopup;",
        "```ts",
        "useEffect(() => { void loadGoogleScript(); }, []);",
        "```",
        "3. A new LoginPage.safari.test.tsx covers this case.",
        "All tests pass.",
        "The fix is on the branch.",
        "Safari keeps blocking popups that are opened after an await.",
        "Chrome and Firefox were never affected.",
        "Want me to open a pull request?",
    ).joinToString("\n")
    private val longZh = "改好了。现在弹窗在点击时同步打开：\n1. 脚本在页面加载时用 useEffect 预先加载；\n2. 点击处理不再 await，直接调用 signInWithPopup；\n3. 新增 LoginPage.safari.test.tsx 覆盖这个场景，全部测试通过。"
    // The same reply translated as one paragraph: its blocks do not pair, so it is drawn whole (frame 4).
    private val mergedZh = "改好了。现在弹窗在点击时同步打开，测试全部通过。"

    private fun conversation(bilingual: Boolean?, agentLanguage: String? = null) {
        val both = (if (bilingual == null) "" else ""","translationBilingual":$bilingual""") +
            (if (agentLanguage == null) "" else ""","translationAgentLanguage":"$agentLanguage"""")
        ComposerShell.answers["GET users/me"] = { ApiResponse(200, """{"id":"u1","email":"owner@a07c.test","name":"Owner",
            "preferences":{"translationEnabled":true,"translationLanguage":"zh-Hans"$both},"translationAvailable":true}""".encodeToByteArray()) }
        fun reply(seq: Int, en: String, zh: String) = ComposerShell.obj(
            """{"type":"assistant","seq":$seq,"turnId":"t-1","payload":{"text":${JsonPrimitive(en)},"translation":{"lang":"zh-Hans","text":${JsonPrimitive(zh)}}}}""")
        ComposerShell.events = listOf(
            ComposerShell.obj("""{"type":"user","seq":1,"turnId":"t-1","ts":"2026-11-12T01:00:00Z","payload":{"text":"$askedEn",
                "translation":{"state":"DONE","from":"zh-Hans","original":"$askedZh"}}}"""),
            reply(2, shortEn, shortZh),
            reply(3, longEn, longZh),
            reply(4, longEn, mergedZh),
            ComposerShell.obj("""{"type":"turn_end","seq":5,"turnId":"t-1","payload":{"subtype":"success"}}"""))
    }

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/session-translation-android").also { it.mkdirs() }
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        File(output, "$name-semantics.txt").writeText(compose.onRoot(useUnmergedTree = true).printToString())
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    private fun row(seq: Int) = hasAnyAncestor(hasTestTag("event:$seq"))
    private fun text(t: String, substring: Boolean = true) = hasText(t, substring = substring)
    private fun english(seq: Int) = hasAnyAncestor(hasTestTag("translation-english")) and row(seq)
    private fun original(seq: Int) = hasTestTag("translation-original") and row(seq)
    /** Brings a row into the list: with the long reply drawn block by block, the list opens on its last rows and an earlier one is
     *  not composed until it is scrolled to. */
    private fun scrollTo(seq: Int) {
        await { (1..4).any { has(hasTestTag("event:$it"), unmerged = true) } }
        compose.onNode(hasTestTag("transcript-list"), useUnmergedTree = true).performScrollToNode(hasTestTag("event:$seq"))
    }

    @Test fun onBothLanguagesAreDrawnBlockByBlockAndAnUnpairedRepliesEnglishOpensInPlace() {
        conversation(bilingual = true)
        signIn(); openSession()
        scrollTo(1)
        await { has(text(askedZh) and row(1), unmerged = true) }
        // The owner's message: what they wrote, the English the agent got under it, and the foot that says so (mark C).
        assertTrue(has(text("does nothing in Safari") and english(1), unmerged = true))
        assertTrue(has(text(TranslationCopy.sentToAgentLabel(), substring = false) and row(1), unmerged = true))
        assertFalse(has(hasTestTag("translation-action:${TranslationCopy.SHOW_ORIGINAL}"), unmerged = true))
        // A short reply: its original right under it, no divider, "Translated" alone (mark D).
        scrollTo(2)
        assertTrue(has(text("我先看一下") and row(2), unmerged = true))
        assertTrue(has(hasTestTag("translation-interleaved") and row(2), unmerged = true))
        assertFalse(has(english(2), unmerged = true))
        // Its inline code is drawn as code: the backticks go.
        assertTrue(has(text("Let me look at how the login page calls signInWithPopup.") and original(2), unmerged = true))
        assertFalse(has(text("`signInWithPopup`") and original(2), unmerged = true))
        assertTrue(has(text(TranslationCopy.TRANSLATED, substring = false) and row(2), unmerged = true))
        // A long reply that pairs: each item with its original under it, never collapsed; its code block is drawn once, translated.
        scrollTo(3)
        assertTrue(has(text("The script preloads on page load in a useEffect;") and original(3), unmerged = true))
        assertTrue(has(text("A new LoginPage.safari.test.tsx covers this case.") and original(3), unmerged = true))
        assertFalse(has(hasTestTag("translation-english-collapsed") and row(3), unmerged = true))
        assertFalse(has(hasTestTag("translation-action:${TranslationCopy.showEnglishLabel(10)}") and row(3), unmerged = true))
        shot("8-bilingual-on-interleaved")
        // A long reply that does not pair: drawn whole, collapsed to its preview with "Show English · 10 lines" (frame 3).
        scrollTo(4)
        assertTrue(has(hasTestTag("translation-english-collapsed") and row(4), unmerged = true))
        assertFalse(has(original(4), unmerged = true))
        val more = hasTestTag("translation-action:${TranslationCopy.showEnglishLabel(10)}") and row(4)
        assertTrue(has(more, unmerged = true))
        assertFalse(has(text("loadGoogleScript(); }") and english(4), unmerged = true))
        shot("9-bilingual-on-unpaired-collapsed")
        compose.onNode(more, useUnmergedTree = true).performClick()
        await { has(hasTestTag("translation-english-text") and row(4), unmerged = true) }
        assertFalse(has(more, unmerged = true))
        assertTrue(has(text("Want me to open a pull request?") and english(4), unmerged = true))
        shot("9-bilingual-on-unpaired-expanded")
    }

    /** "Hide original" (docs/mocks/translation-hide-original): one message's original goes, its own language stays, "Show both" brings it back. */
    @Test fun hideOriginalLeavesOneMessageInYourLanguage() {
        conversation(bilingual = true)
        signIn(); openSession()
        scrollTo(1)
        await { has(text(askedZh) and row(1), unmerged = true) }
        val hide1 = hasTestTag("translation-action:${TranslationCopy.HIDE_ORIGINAL}") and row(1)
        compose.onNode(hide1, useUnmergedTree = true).performClick()
        await { !has(english(1), unmerged = true) }
        assertTrue(has(text(askedZh) and row(1), unmerged = true))
        val both1 = hasTestTag("translation-action:${TranslationCopy.SHOW_BOTH}") and row(1)
        assertTrue(has(both1, unmerged = true))
        compose.onNode(both1, useUnmergedTree = true).performClick()
        await { has(text("does nothing in Safari") and english(1), unmerged = true) }
        // A reply drawn block by block: hidden, it is its translation alone; the others keep both.
        scrollTo(2)
        compose.onNode(hasTestTag("translation-action:${TranslationCopy.HIDE_ORIGINAL}") and row(2), useUnmergedTree = true).performClick()
        await { !has(original(2), unmerged = true) }
        assertTrue(has(text("我先看一下") and row(2), unmerged = true))
        assertTrue(has(hasTestTag("translation-action:${TranslationCopy.SHOW_BOTH}") and row(2), unmerged = true))
        scrollTo(3)
        assertTrue(has(original(3), unmerged = true))
    }

    @Test fun theBlockNamesTheLanguageAgentsWorkIn() {
        conversation(bilingual = true, agentLanguage = "ja")
        signIn(); openSession()
        scrollTo(1)
        await { has(text(askedZh) and row(1), unmerged = true) }
        assertTrue(has(text("Sent to the agent in Japanese", substring = false) and row(1), unmerged = true))
        scrollTo(4)
        assertTrue(has(hasTestTag("translation-action:Show Japanese · 10 lines") and row(4), unmerged = true))
        assertFalse(has(text("Show English"), unmerged = true))
    }

    @Test fun offIsTodaysConversation() {
        conversation(bilingual = null)
        signIn(); openSession()
        await { has(text(askedZh) and row(1), unmerged = true) }
        assertFalse(has(hasTestTag("translation-english"), unmerged = true))
        assertFalse(has(text("does nothing in Safari"), unmerged = true))
        assertTrue(has(hasTestTag("translation-action:${TranslationCopy.SHOW_ORIGINAL}") and row(1), unmerged = true))
        assertTrue(has(hasTestTag("translation-action:${TranslationCopy.SHOW_ORIGINAL}") and row(2), unmerged = true))
        assertFalse(has(text(TranslationCopy.SENT_TO_AGENT), unmerged = true))
        shot("10-bilingual-off")
    }

    @Test fun explicitlyOffIsTodaysConversationToo() {
        conversation(bilingual = false)
        signIn(); openSession()
        await { has(text(askedZh) and row(1), unmerged = true) }
        assertFalse(has(hasTestTag("translation-english"), unmerged = true))
        assertTrue(has(hasTestTag("translation-action:${TranslationCopy.SHOW_ORIGINAL}") and row(2), unmerged = true))
    }
}
