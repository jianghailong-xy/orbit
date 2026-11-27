package io.orbitd.android.reader

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.ui.test.*
import io.orbitd.android.composer.ComposerShell
import io.orbitd.android.composer.ComposerShellApplication
import io.orbitd.android.composer.ComposerShellTest
import java.io.File
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The session page's messages as iOS draws them (`UserBubbleView`, `AssistantBubbleView`, `StepsRowView`, `scrollToBottomButton`):
 * the reader's words in a tinted bubble on the trailing side with copy and time under it, a reply with no heading, a steps line at
 * the label size, and the jump to the latest as a disc over the list. PNGs under app/build/evidence/chat-ios-parity (not committed).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ComposerShellApplication::class, qualifiers = "w393dp-h852dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatIosParityShotsTest : ComposerShellTest() {
    private val now = Instant.now().toString()
    private fun event(seq: Long, type: String, payload: String) = ComposerShell.obj("""{"type":"$type","seq":$seq,"ts":"$now","payload":$payload}""")
    private fun said(seq: Long, type: String, text: String) = event(seq, type, buildJsonObject { put("text", text) }.toString())
    private fun bash(seq: Long, command: String) = listOf(
        event(seq, "tool_use", buildJsonObject { put("id", "t$seq"); put("name", "Bash"); putJsonObject("input") { put("command", command) } }.toString()),
        event(seq + 1, "tool_result", """{"toolUseId":"t$seq","content":"ok"}"""))

    @Test fun aConversationAsIosDrawsIt() {
        ComposerShell.events = listOf(said(1, "user", "Rebase this branch onto main, then run the landing check."),
            event(2, "thinking", """{"text":"Look at the branch first.","thinkingMs":1200}""")) +
            bash(3, "git status") + bash(5, "git rebase origin/main") + bash(7, "ls src/android") +
            said(9, "assistant", "This branch has no commits of its own, so rebasing onto main is a fast-forward. I'll do that, then look at " +
                "what the landing check runs today.") +
            said(10, "user", "Also check `/mnt/tmp` has room for the build.") +
            bash(11, "df -h /mnt/tmp") +
            said(13, "assistant", "`/mnt/tmp` is on a different filesystem, so the hard links failed. I'll remove that scratch checkout " +
                "and recreate it next to the worktrees.") +
            // Enough after it that the conversation is taller than the phone, so it can be scrolled away from its tail.
            (14L..19L).map { said(it, if (it % 2 == 0L) "user" else "assistant", if (it % 2 == 0L) "Carry on." else "Done, that part is through.") }
        signIn(); openSession()
        compose.waitUntil(20_000) { compose.onAllNodes(hasTestTag("event:19")).fetchSemanticsNodes().isNotEmpty() }
        assertTrue("a reply has no heading", compose.onAllNodes(hasText("Assistant"), useUnmergedTree = true).fetchSemanticsNodes().isEmpty())
        assertTrue("the reader's words carry their copy", compose.onAllNodes(hasContentDescription("Copy message")).fetchSemanticsNodes().size >= 2)
        shot("01-at-rest")
        compose.onNodeWithTag("transcript-list").performTouchInput { swipeDown() }
        compose.waitUntil(10_000) { compose.onAllNodes(hasContentDescription("Jump to latest")).fetchSemanticsNodes().isNotEmpty() }
        shot("02-scrolled-up")
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888).also { view.draw(Canvas(it)) }
        val pixels = IntArray(bitmap.width * bitmap.height).also { bitmap.getPixels(it, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height) }
        assertTrue("$name: the shot is blank", pixels.any { it != 0 })
        val file = File(System.getProperty("user.dir"), "build/evidence/chat-ios-parity/$name.png").also { it.parentFile?.mkdirs() }
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        println("shot $name ${bitmap.width}×${bitmap.height} -> $file")
    }
}
