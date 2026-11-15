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
 * "Show both languages" in an Android conversation (docs/mocks/session-translation/02-bilingual.png, frames 2–5), in the production shell
 * over [ComposerShell]: on, the owner's message and a short reply show their language on top and the English under a dashed divider,
 * their feet lose the flip ("Sent to the agent in English", "Translated"); a long reply's English collapses to "Show English · N lines",
 * which opens it in place. Off — the account's default — the conversation is exactly today's. The NATIVE frames go under
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
            ComposerShell.obj("""{"type":"turn_end","seq":4,"turnId":"t-1","payload":{"subtype":"success"}}"""))
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

    @Test fun onBothLanguagesAreDrawnAndALongRepliesEnglishOpensInPlace() {
        conversation(bilingual = true)
        signIn(); openSession()
        await { has(text(askedZh) and row(1), unmerged = true) }
        // The owner's message: what they wrote, the English the agent got under it, and the foot that says so (mark C).
        assertTrue(has(text("does nothing in Safari") and english(1), unmerged = true))
        assertTrue(has(text(TranslationCopy.sentToAgentLabel(), substring = false) and row(1), unmerged = true))
        assertFalse(has(hasTestTag("translation-action:${TranslationCopy.SHOW_ORIGINAL}"), unmerged = true))
        // A short reply: its English in full, "Translated" alone (mark D).
        assertTrue(has(text("我先看一下") and row(2), unmerged = true))
        // Its inline code is drawn as code: the backticks go.
        assertTrue(has(text("Let me look at how the login page calls signInWithPopup.") and english(2), unmerged = true))
        assertFalse(has(text("`signInWithPopup`") and english(2), unmerged = true))
        assertTrue(has(text(TranslationCopy.TRANSLATED, substring = false) and row(2), unmerged = true))
        // A long reply: collapsed to its preview with "Show English · 10 lines" (frame 3); its code block is not repeated.
        compose.onNode(hasTestTag("event:3"), useUnmergedTree = true).performScrollTo()
        assertTrue(has(hasTestTag("translation-english-collapsed") and row(3), unmerged = true))
        val more = hasTestTag("translation-action:${TranslationCopy.showEnglishLabel(10)}") and row(3)
        assertTrue(has(more, unmerged = true))
        assertFalse(has(text("loadGoogleScript(); }") and english(3), unmerged = true))
        shot("8-bilingual-on-long-collapsed")
        compose.onNode(more, useUnmergedTree = true).performClick()
        await { has(hasTestTag("translation-english-text") and row(3), unmerged = true) }
        assertFalse(has(more, unmerged = true))
        assertTrue(has(text("Want me to open a pull request?") and english(3), unmerged = true))
        shot("9-bilingual-on-long-expanded")
    }

    @Test fun theBlockNamesTheLanguageAgentsWorkIn() {
        conversation(bilingual = true, agentLanguage = "ja")
        signIn(); openSession()
        await { has(text(askedZh) and row(1), unmerged = true) }
        assertTrue(has(text("Sent to the agent in Japanese", substring = false) and row(1), unmerged = true))
        compose.onNode(hasTestTag("event:3"), useUnmergedTree = true).performScrollTo()
        assertTrue(has(hasTestTag("translation-action:Show Japanese · 10 lines") and row(3), unmerged = true))
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
