package io.orbitd.android.reader

import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.text.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.commonmark.node.Link
import org.commonmark.node.Node
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * A06-3 (iOS 49d2f3003): a Markdown link to an image file is the image file row, opening the shared
 * viewer; the parser keeps the link's title, where an upload's original filename rides
 * (OrbitKit's MarkdownFileRefTests, case for case).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class ImageFileLinkTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val session = "01a0cca7-8609-70ed-a0e2-d4b55b832b60"
    private val shot = "01a0cca7-8609-70ed-a0e2-d4b55b832b6a"
    private val other = "01a0cca7-8609-70ed-a0e2-d4b55b832b6b"

    private fun links(markdown: String): List<Link> {
        val found = mutableListOf<Link>()
        fun walk(node: Node) { if (node is Link) found += node; node.children().forEach(::walk) }
        walk(markdownParser.parse(markdown))
        return found
    }
    private fun refs(markdown: String) = links(markdown).map { link ->
        MarkdownFileRef(link.destination, (link.firstChild as? org.commonmark.node.Text)?.literal.orEmpty(), link.title?.ifEmpty { null })
    }

    @Test fun anUploadKeepsItsFilenameThroughTheParserAndItsLabelForTheReader() {
        val ref = refs("已验证。[查看实际页面截图](orbit-attachment:$shot \"runner-mobile.png\") 完成。").single()
        assertEquals("查看实际页面截图", ref.label)
        assertEquals("runner-mobile.png", ref.fileName)
        assertTrue(ref.isImage)
        assertEquals("手机截图.PNG", refs("[查看实际页面截图](orbit-attachment:$shot '手机截图.PNG')").single().fileName)
        assertEquals("before \"pause\".png", refs("[Screenshot](orbit-attachment:$shot \"before \\\"pause\\\".png\")").single().fileName)
    }

    @Test fun documentsLegacyLinksAndWhatLoadsBeforeATap() {
        assertEquals(listOf("report.pdf", "notes.md"), refs("[preview.png](orbit-attachment:$shot \"report.pdf\") [notes](orbit-attachment:$other \"notes.md\")").map { it.fileName })
        val legacy = refs("[查看截图](/tmp/card.png) [photo.jpg](orbit-attachment:$shot) [查看附件](orbit-attachment:$other)")
        assertEquals(listOf("card.png", "photo.jpg", "查看附件"), legacy.map { it.fileName })
        assertEquals(listOf(true, true, false), legacy.map { it.isImage })
        assertEquals(listOf(true, true, false, false), refs("[截图](orbit-attachment:$shot \"screen.png\") [附件](orbit-attachment:$other) " +
            "[文档](orbit-attachment:$shot \"notes.pdf\") [report.pdf](orbit-attachment:$other)").map { it.shouldLoadImage })
        assertEquals("shot 1.png", MarkdownFileRef.fileNameInPath("/root/.orbit/worktrees/$session/docs/shot%201.png:12"))
    }

    @Test fun onlyAFileTheSessionCanServeAsAnImageLeavesTheProse() {
        val links = links("[site](https://example.com/card.png) [task](orbit-task:$shot) [shot.png](/root/.orbit/worktrees/$session/shots/shot.png) " +
            "[elsewhere.png](/root/.orbit/worktrees/$other/shot.png) [README.md](/root/.orbit/worktrees/$session/README.md) [up](orbit-attachment:$shot \"up.png\")")
        assertEquals(listOf(false, false, true, false, false, true), links.map { MarkdownFileRef.imageFile(it, session) != null })
        val paragraph = markdownParser.parse("See [shot.png](/root/.orbit/worktrees/$session/shots/shot.png).").firstChild
        val chunks = inlineChunks(paragraph) { MarkdownFileRef.imageFile(it, session) != null }
        assertEquals("the stray full stop does not get a line of its own", 2, chunks.size)
        assertTrue(chunks.last().single() is Link)
        assertEquals(listOf("orbit-attachment:$shot"), sessionImages(listOf(RunEvent("assistant", 1,
            buildJsonObject { put("text", "[up](orbit-attachment:$shot \"up.png\") [doc](orbit-attachment:$other \"doc.pdf\")") }))))
    }

    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun theRowShowsThePictureAndOpensTheViewer() {
        val server = FakeReaderServer().apply {
            respond = { api -> if (api.path == listOf("sessions", session, "artifacts")) ApiResponse(200, FakeReaderServer.png) else ApiResponse(404, "{}".encodeToByteArray()) }
        }
        val handle = runBlocking { server.signIn() }
        val opened = mutableListOf<String>()
        val path = "/root/.orbit/worktrees/$session/shots/runner.png"
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme {
            CompositionLocalProvider(LocalReaderResources provides ReaderResources(server.auth, handle, session)) {
                MarkdownText("Saved the page: [runner.png]($path).", open = opened::add)
            }
        } } }
        compose.waitUntil(10_000) { compose.onAllNodesWithText("PNG image · Tap to preview").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Saved the page:", substring = true).assertIsDisplayed()
        val row = compose.onNodeWithContentDescription("runner.png")
        assertEquals("Preview image", row.fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsActions.OnClick].label)
        row.performClick()
        compose.onNodeWithText("Close image").assertIsDisplayed()
        compose.onNodeWithText("Save image").assertIsDisplayed()
        assertTrue("the viewer opened in place, not through the link handler", opened.isEmpty())
        assertTrue(server.calls.any { it.path == listOf("sessions", session, "artifacts") && it.query.toMap()["path"] == path })
    }
}
