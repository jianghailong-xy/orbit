package io.orbitd.android.composer

import androidx.compose.ui.test.*
import org.junit.Assert.*
import org.junit.Test

/** A07-1 (iOS b8d661967): a file attached to a message opens in the app when it is text — its lines counted, a Markdown file
 * readable as rendered (Preview) or as written (Source) — an empty file being an empty text, not an error; any other format keeps
 * the hand-offs to the system. */
class AttachmentPreviewTest : ComposerShellTest() {
    private val notes = "11111111-1111-4111-8111-111111111111"
    private val log = "22222222-2222-4222-8222-222222222222"
    private val archive = "33333333-3333-4333-8333-333333333333"
    private val empty = "44444444-4444-4444-8444-444444444444"
    private fun filesAttached() {
        ComposerShell.attachments = mapOf(notes to "# Release notes\n\nThe fix is in.\n".encodeToByteArray(),
            log to "first line\nsecond line".encodeToByteArray(),
            archive to byteArrayOf(0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00), empty to ByteArray(0))
        ComposerShell.events = listOf(ComposerShell.obj("""{"type":"user","seq":1,"payload":{"text":"Files attached","attachments":[
            {"id":"$notes","name":"notes.md","mime":"text/markdown"},{"id":"$log","name":"build.log","mime":"text/plain"},
            {"id":"$archive","name":"archive.zip","mime":"application/zip"},{"id":"$empty","name":"empty.txt","mime":"text/plain"}]}}"""))
    }
    private fun openFile(name: String) {
        await { has(hasText(name) and hasClickAction()) }
        compose.onNode(hasText(name) and hasClickAction()).performScrollTo().performClick()
        await { has(hasText("Download") and hasClickAction()) }
    }
    private fun closeFile() = compose.onNode(hasText("Close attachment") and hasClickAction()).performClick()

    @Test fun aMarkdownFileReadsRenderedOrAsWritten() {
        filesAttached()
        signIn(); openSession()
        openFile("notes.md")
        awaitText("3 lines")
        assertTrue(has(hasText("Preview") and hasClickAction()) && has(hasText("Source") and hasClickAction()))
        awaitText("Release notes")
        assertFalse("rendered, not written", shows("# Release notes"))
        compose.onNode(hasText("Source") and hasClickAction()).performClick()
        awaitText("# Release notes")
    }

    @Test fun aTextFileReadsAsTextAndAnEmptyOneIsNoError() {
        filesAttached()
        signIn(); openSession()
        openFile("build.log")
        awaitText("2 lines")
        assertTrue(shows("first line") && shows("second line"))
        assertFalse("only Markdown has a preview", has(hasText("Preview") and hasClickAction()))
        closeFile()
        openFile("empty.txt")
        awaitText("0 lines")
        assertFalse(shows("Couldn't open that file. Retry or open it in another app."))
    }

    @Test fun anythingElseKeepsTheHandOffs() {
        filesAttached()
        signIn(); openSession()
        openFile("archive.zip")
        assertTrue(has(hasText("Open") and hasClickAction()) && has(hasText("Share") and hasClickAction()))
        compose.waitForIdle()
        assertFalse("no reader for an archive", has(hasText("lines", substring = true)))
    }
}
