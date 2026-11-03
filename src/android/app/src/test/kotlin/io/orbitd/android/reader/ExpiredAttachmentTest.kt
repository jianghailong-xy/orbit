package io.orbitd.android.reader

import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.EvidenceFiles
import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.text.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * What a reply's file leaves behind once its bytes have gone (docs/orbit-files-design.md §2.8): a read answers 410, and the conversation
 * draws the grey tile an evidence card draws, in the card's words. Only that answer: anything else that goes wrong with a read may come
 * back, and stays what it has always been. The web's `Transcript.expiredAttachment.test.tsx`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class ExpiredAttachmentTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private val server = FakeReaderServer()
    private val id = "01a0cca7-8609-70ed-a0e2-d4b55b832b60"
    private val at = "2026-09-14T12:00:00.000Z"
    private val onThatDay get() = EvidenceFiles.expiryDate(at)!!
    private val gone = """{"statusCode":410,"error":"Gone","message":"this file expired on 2026-09-14 and its bytes have been deleted","expiredAt":"$at"}"""
    private val older = """{"statusCode":410,"error":"Gone","message":"this file expired on 2026-09-14 and its bytes have been deleted"}"""

    private fun answering(status: Int, body: String) { server.respond = { ApiResponse(status, body.encodeToByteArray()) } }
    private fun reads() = server.calls.filter { it.path.firstOrNull() == "attachments" }

    private fun show(markdown: String) {
        val handle = runBlocking { server.signIn() }
        val resources = ReaderResources(server.auth, handle, sessionId = "s1")
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme {
            CompositionLocalProvider(LocalReaderResources provides resources) {
                MarkdownText(markdown, open = rememberReaderLinkHandler(resources) {})
            }
        } } }
    }
    private fun await(condition: () -> Boolean) = compose.waitUntil(30_000) { condition() }
    private fun exists(matcher: SemanticsMatcher) = compose.onAllNodes(matcher, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun aPictureDrawsTheTileWithItsDateAndOffersNothingElse() {
        answering(410, gone)
        show("![menu-open.png](orbit-attachment:$id)")
        await { exists(hasTestTag("attachment-expired")) }
        assertTrue(exists(hasText("${EvidenceFiles.expired}\n$onThatDay")))
        assertFalse("no retry", exists(hasText("Image unavailable · Retry")))
        assertFalse("nothing to open", exists(hasText("Open image")))
        assertTrue("the name it had stays", exists(hasText("menu-open.png")))
        assertEquals("a file that went does not come back by asking again", 1, reads().size)
    }

    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun aServerThatDoesNotSayWhenHasNoDate() {
        answering(410, older)
        show("![menu-open.png](orbit-attachment:$id)")
        await { exists(hasTestTag("attachment-expired")) }
        assertTrue(exists(hasText(EvidenceFiles.expired)))
    }

    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun anyOtherFailureStaysWhatItWas() {
        for (status in listOf(404, 500, 503)) {
            answering(status, """{"message":"no"}""")
            show("![menu-open.png](orbit-attachment:$id)")
            await { exists(hasText("Image unavailable · Retry")) }
            assertFalse("$status", exists(hasTestTag("attachment-expired")))
            assertTrue("$status", exists(hasText("Open image")))
        }
    }

    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun aPictureWhoseBytesRemainIsDrawn() {
        server.respond = { ApiResponse(200, FakeReaderServer.png) }
        show("![menu-open.png](orbit-attachment:$id)")
        await { exists(hasContentDescription("menu-open.png")) }
        assertFalse(exists(hasTestTag("attachment-expired")))
    }

    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun aFileRowSaysSoAndOpensNothing() {
        answering(410, gone)
        show("[menu-open.png](orbit-attachment:$id \"menu-open.png\")")
        await { exists(hasTestTag("attachment-expired-file")) }
        assertTrue(exists(hasText("${EvidenceFiles.expired} $onThatDay")))
        assertFalse(exists(hasText("Preview file")))
        compose.onNodeWithTag("attachment-expired-file", useUnmergedTree = true).assertHasNoClickAction()
    }

    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun aFileRowStaysARowOnAnyOtherFailure() {
        answering(404, """{"message":"attachment not found"}""")
        show("[menu-open.png](orbit-attachment:$id \"menu-open.png\")")
        await { exists(hasText("Preview file")) }
        assertFalse(exists(hasTestTag("attachment-expired-file")))
    }

    /** A link to a document reads nothing until it is pressed, and then the dialog says so, with nothing to retry or hand on. */
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun aDocumentOpenedFromItsLinkSaysSoInsteadOfOfferingARetry() {
        answering(410, gone)
        show("[report.html](orbit-attachment:$id \"report.html\")")
        await { exists(hasText("report.html")) }
        assertEquals(0, reads().size)
        compose.onNode(hasText("report.html"), useUnmergedTree = true).performClick()
        await { exists(hasTestTag("attachment-expired")) }
        assertTrue(exists(hasText("${EvidenceFiles.expired}\n$onThatDay")))
        assertFalse(exists(hasText("Retry")))
        assertFalse(exists(hasText("Download")))
        assertFalse(exists(hasText("Share")))
    }

    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun aDocumentStaysRetryableOnAnyOtherFailure() {
        answering(500, """{"message":"no"}""")
        show("[report.html](orbit-attachment:$id \"report.html\")")
        await { exists(hasText("report.html")) }
        compose.onNode(hasText("report.html"), useUnmergedTree = true).performClick()
        await { exists(hasText("Retry")) }
        assertFalse(exists(hasTestTag("attachment-expired")))
    }
}
