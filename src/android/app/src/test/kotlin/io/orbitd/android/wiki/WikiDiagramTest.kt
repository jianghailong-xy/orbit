package io.orbitd.android.wiki

import android.net.Uri
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebView
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.webkit.WebViewAssetLoader
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.ui.OrbitTheme
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** A section's diagram (contract `docs.diagram`) on a phone: the page its WebView loads — the Mermaid the web pins, from the
 * app's assets, with the web's settings in the app's theme — what that WebView may reach, and the figure it sits in on a
 * document's page: named Diagram, 120 dp high while it draws, then at the size the page reports, centred or scrolling sideways,
 * and the source as code when it does not draw. Robolectric runs no JavaScript: the page's report is played on its bridge. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class WikiDiagramTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    /** The web's case (WikiDocPage.test.tsx): a flowchart as the server writes it out again. */
    private val source = "flowchart LR\n  n1[\"Turn stored\"]\n  n2[\"Delivered\"]\n  n1 --> n2"
    private val bundled get() = wikiShared("src/android/app/src/main/assets/${WikiDiagramPage.ASSET}")

    // MARK: the page

    @Test fun mermaidIsSetUpAsTheWebSetsItUpInTheAppsTheme() {
        assertEquals(Json.parseToJsonElement("""{"startOnLoad":false,"securityLevel":"strict","theme":"neutral","fontFamily":"sans-serif",
            "flowchart":{"useMaxWidth":false}}"""), WikiDiagramPage.options(dark = false))
        assertEquals(JsonPrimitive("dark"), WikiDiagramPage.options(dark = true)["theme"])
        // The web's settings, which these follow; its page font is the page's, as this page's is.
        val web = wikiShared("src/web/src/components/WikiDiagram.tsx").readText()
        listOf("startOnLoad: false", "securityLevel: 'strict'", "theme: theme === 'dark' ? 'dark' : 'neutral'",
            "fontFamily: getComputedStyle(document.body).fontFamily", "flowchart: { useMaxWidth: false }", "draw.render(id, source)")
            .forEach { assertTrue("WikiDiagram.tsx no longer says $it", web.contains(it)) }
        // The figure's name is the web's.
        assertEquals("Diagram", WikiDocCopy.diagram)
        assertTrue(wikiShared("src/web/src/lib/wikiDocs.ts").readText().contains("export const WIKI_DOC_DIAGRAM = '${WikiDocCopy.diagram}';"))
    }

    @Test fun theBundledMermaidIsTheOneTheWebsLockfilePins() {
        val pinned = requireNotNull(wikiJson("package-lock.json").obj("packages").obj("node_modules/mermaid").str("version"))
        assertTrue(wikiJson("src/web/package.json").obj("dependencies").containsKey("mermaid"))
        val text = bundled.readText()
        assertTrue("the bundled Mermaid is not $pinned, the version the web's lockfile pins", text.contains("{version:\"$pinned\"}"))
        // The single-file browser build, which defines the global the page calls.
        assertTrue(text.trimEnd().endsWith("globalThis[\"mermaid\"] = globalThis.__esbuild_esm_mermaid_nm[\"mermaid\"].default;"))
        // The app ships that file, byte for byte.
        assertArrayEquals(bundled.readBytes(), compose.activity.assets.open(WikiDiagramPage.ASSET).use { it.readBytes() })
    }

    @Test fun thePageDrawsTheSourceWithMermaidFromTheAppAndNothingElse() {
        val page = WikiDiagramPage.html(source, dark = false)
        assertEquals("https://" + WebViewAssetLoader.DEFAULT_DOMAIN, WikiDiagramPage.ORIGIN)
        assertEquals(listOf(WikiDiagramPage.SCRIPT), Regex("""<script src="([^"]*)"></script>""").findAll(page).map { it.groupValues[1] }.toList())
        assertEquals("the page addresses nothing but the app's script", listOf(WikiDiagramPage.SCRIPT),
            Regex("""[a-z]+://[^\s"'<>)]*""").findAll(page).map { it.value }.toList())
        assertTrue(page.contains("mermaid.initialize(${WikiDiagramPage.options(dark = false)});"))
        assertTrue(WikiDiagramPage.html(source, dark = true).contains("mermaid.initialize(${WikiDiagramPage.options(dark = true)});"))
        assertEquals(source, rendered(page))
        assertTrue(page.contains("font-family: ${WikiDiagramPage.FONT};"))
        assertTrue("a wide drawing scrolls sideways in the page, a narrow one is centred",
            page.contains("#diagram { overflow-x: auto; overflow-y: hidden; touch-action: pan-x; } #diagram > svg { display: block; margin: 0 auto; }"))
        assertTrue("what it drew, or 0 x 0, is the page's one report", page.contains("${WikiDiagramPage.BRIDGE}.size(width, height);"))
    }

    @Test fun noSourceCanBreakOutOfItsScript() {
        val han = String(charArrayOf(Char(0x4F1A), Char(0x8BDD)))
        val hostile = """flowchart TB
            |  n1["</script><script>${WikiDiagramPage.BRIDGE}.size(1, 1)</script><!--"]
            |  n2["a & b \ " ' ${'$'}{x}"]
            |  n1 --> n2
            |""".trimMargin() + Char(0x2028) + Char(0x2029) + han
        val page = WikiDiagramPage.html(hostile, dark = false)
        assertEquals(hostile, rendered(page))
        assertEquals("only the page's own two scripts close", 2, Regex("</script", RegexOption.IGNORE_CASE).findAll(page).count())
        assertEquals("only the page's own two scripts open", 2, Regex("<script", RegexOption.IGNORE_CASE).findAll(page).count())
        assertTrue("the page is ASCII", page.all { it == '\n' || it.code in 0x20..0x7e })
    }

    @Test fun aSidewaysDragOverAWideDiagramIsTheDiagrams() {
        // Across a diagram wider than its WebView, either way: the diagram's, which its page scrolls.
        assertTrue(WikiDiagramPage.ownsDrag(-30f, 4f, wide = true))
        assertTrue(WikiDiagramPage.ownsDrag(30f, -4f, wide = true))
        // Over one that fits, or more up than across, the drag goes on to the list and the drawer, as over any block.
        assertFalse(WikiDiagramPage.ownsDrag(-30f, 4f, wide = false))
        assertFalse(WikiDiagramPage.ownsDrag(-10f, 30f, wide = true))
        assertFalse(WikiDiagramPage.ownsDrag(0f, 0f, wide = true))
    }

    // MARK: the WebView

    @Test fun theWebViewRunsThePageAndReachesNothingElse() {
        val reports = mutableListOf<Pair<Int, Int>>()
        val view = WikiDiagramPage.view(compose.activity, source, dark = false) { width, height -> reports += width to height }
        assertTrue(view.settings.javaScriptEnabled)
        assertTrue(view.settings.blockNetworkLoads)
        assertFalse(view.settings.allowFileAccess)
        assertFalse(view.settings.allowContentAccess)
        val shadow = shadowOf(view)
        val loaded = shadow.lastLoadDataWithBaseURL
        assertEquals("${WikiDiagramPage.ORIGIN}/", loaded.baseUrl)
        assertEquals(WikiDiagramPage.html(source, dark = false), loaded.data)
        assertEquals("text/html", loaded.mimeType)

        // One bridge, and on it one method: the size of what was drawn, heard on the main thread.
        assertEquals(listOf("size"), WikiDiagramPage.Bridge::class.java.methods.filter { it.isAnnotationPresent(JavascriptInterface::class.java) }.map { it.name })
        val bridge = shadow.getJavascriptInterface(WikiDiagramPage.BRIDGE) as WikiDiagramPage.Bridge
        bridge.size(320, 180)
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(listOf(320 to 180), reports)

        // The page's own text loads as the WebView hands it over; the script comes from the app's assets; anything else, from
        // anywhere, is refused.
        val client = shadow.webViewClient
        assertNull(client.shouldInterceptRequest(view, request("data:text/html;charset=utf-8;base64,PGI+eDwvYj4=", mainFrame = true)))
        val script = requireNotNull(client.shouldInterceptRequest(view, request(WikiDiagramPage.SCRIPT)))
        assertEquals("text/javascript", script.mimeType)
        assertArrayEquals(bundled.readBytes(), script.data.use { it.readBytes() })
        listOf("https://example.com/mermaid.min.js", "http://appassets.androidplatform.net/${WikiDiagramPage.ASSET}",
            "${WikiDiagramPage.ORIGIN}/mermaid/LICENSE", "${WikiDiagramPage.ORIGIN}/assets/${WikiDiagramPage.ASSET}",
            "file:///android_asset/${WikiDiagramPage.ASSET}", "content://io.orbitd.android.debug.files/x").forEach { url ->
            val answer = requireNotNull(client.shouldInterceptRequest(view, request(url)))
            assertEquals(url, 403, answer.statusCode)
            assertEquals(url, 0, answer.data.use { it.readBytes() }.size)
        }
        // It never leaves its page.
        listOf("https://example.com/", "${WikiDiagramPage.ORIGIN}/", "intent://x#Intent;end").forEach { assertTrue(it, client.shouldOverrideUrlLoading(view, request(it))) }
        // A page that does not load reads as a diagram that did not draw; a refused request of the page's does not.
        client.onReceivedHttpError(view, request(WikiDiagramPage.SCRIPT), WikiDiagramPage.refused())
        assertEquals(listOf(320 to 180), reports)
        client.onReceivedHttpError(view, request("${WikiDiagramPage.ORIGIN}/", mainFrame = true), WikiDiagramPage.refused())
        assertEquals(listOf(320 to 180, 0 to 0), reports)
        // Nor does a renderer that is gone, and the app lives on.
        assertTrue(client.onRenderProcessGone(view, object : RenderProcessGoneDetail() {
            override fun didCrash() = true
            override fun rendererPriorityAtExit() = 0
        }))
        assertEquals(listOf(320 to 180, 0 to 0, 0 to 0), reports)
        view.destroy()
    }

    // MARK: on a document's page

    @Test fun aSectionsDiagramIsDrawnWhereItStandsAsHighAsItsDrawing() {
        val (doc, tag) = docWithDiagram()
        show { WikiDocPage(doc, null, null) }
        val list = compose.onNodeWithTag("wiki-doc-list")
        list.performScrollToNode(hasTestTag(tag))
        val figure = compose.onNodeWithTag(tag)
        figure.assertContentDescriptionEquals(WikiDocCopy.diagram)
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Image))
        // While Mermaid draws, the figure stands 120 dp high, as the web's does; the WebView spans it inside its 12 dp padding.
        figure.assertHeightIsEqualTo(120.dp)
        val inside = figure.getUnclippedBoundsInRoot().let { it.right - it.left } - 24.dp
        drawing(tag).assertWidthIsEqualTo(inside).assertHeightIsEqualTo(96.dp)
        val view = webViews().single()
        assertEquals(WikiDiagramPage.html(source, dark = false), shadowOf(view).lastLoadDataWithBaseURL.data)

        // Drawn wider than the column: as high as the drawing, still across the column — its page scrolls it sideways.
        bridge(view).size(1200, 180)
        compose.waitForIdle()
        figure.assertHeightIsEqualTo(204.dp)
        drawing(tag).assertWidthIsEqualTo(inside).assertHeightIsEqualTo(180.dp)
        // Narrower: the same, its page centring it.
        bridge(view).size(200, 100)
        compose.waitForIdle()
        figure.assertHeightIsEqualTo(124.dp)
        drawing(tag).assertWidthIsEqualTo(inside).assertHeightIsEqualTo(100.dp)

        // Scrolled away its WebView goes; back again, the figure keeps the drawn height while the page draws once more.
        list.performScrollToNode(hasTestTag("wiki-doc-footnote:47"))
        compose.waitForIdle()
        assertTrue(shadowOf(view).wasDestroyCalled())
        assertTrue(webViews().isEmpty())
        list.performScrollToNode(hasTestTag(tag))
        compose.onNodeWithTag(tag).assertHeightIsEqualTo(124.dp)
        drawing(tag).assertHeightIsEqualTo(100.dp)
        assertEquals(WikiDiagramPage.html(source, dark = false), shadowOf(webViews().single()).lastLoadDataWithBaseURL.data)
    }

    @Test fun theDiagramIsDrawnInTheAppsThemeAndFollowsIt() {
        val (doc, tag) = docWithDiagram()
        var dark by mutableStateOf(true)
        compose.activityRule.scenario.onActivity { it.setContent { OrbitTheme(darkTheme = dark) { WikiDocPage(doc, null, null) } } }
        compose.waitForIdle()
        compose.onNodeWithTag("wiki-doc-list").performScrollToNode(hasTestTag(tag))
        val first = webViews().single()
        assertEquals(WikiDiagramPage.html(source, dark = true), shadowOf(first).lastLoadDataWithBaseURL.data)
        bridge(first).size(300, 150)
        compose.waitForIdle()
        // The app turns light: the diagram is drawn again in the light theme, keeping its size meanwhile.
        dark = false
        compose.waitForIdle()
        assertTrue(shadowOf(first).wasDestroyCalled())
        val second = webViews().single()
        assertEquals(WikiDiagramPage.html(source, dark = false), shadowOf(second).lastLoadDataWithBaseURL.data)
        compose.onNodeWithTag(tag).assertHeightIsEqualTo(174.dp)
    }

    @Test fun aDiagramThatDoesNotDrawShowsItsSourceAsCode() {
        val (doc, tag) = docWithDiagram()
        show { WikiDocPage(doc, null, null) }
        compose.onNodeWithTag("wiki-doc-list").performScrollToNode(hasTestTag(tag))
        val view = webViews().single()
        bridge(view).size(0, 0)
        compose.waitForIdle()
        val code = compose.onNode(hasText(source) and hasAnyAncestor(hasTestTag(tag)))
        code.assertIsDisplayed()
        val layout = mutableListOf<TextLayoutResult>()
        code.fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action?.invoke(layout)
        assertEquals("the source is set as code is", FontFamily.Monospace, layout.single().layoutInput.style.fontFamily)
        assertTrue(compose.onAllNodesWithContentDescription(WikiDocCopy.diagram).fetchSemanticsNodes().isEmpty())
        assertTrue(shadowOf(view).wasDestroyCalled())
        assertTrue(webViews().isEmpty())
    }

    // MARK: helpers

    private fun show(content: @androidx.compose.runtime.Composable () -> Unit) {
        compose.activityRule.scenario.onActivity { it.setContent { OrbitTheme(darkTheme = false) { content() } } }
        compose.waitForIdle()
    }

    /** The fixture document with the web case's diagram second among the blocks of its first written section with more than
     * one, and the diagram block's tag. */
    private fun docWithDiagram(): Pair<WikiDoc, String> {
        val read = wikiDocsFixture().obj("docs").obj("doc").obj("read")
        val sections = read.arr("sections").objects
        val at = sections.indexOfFirst { it["written"] == JsonPrimitive(true) && it.arr("blocks").size > 1 }
        val section = sections[at]
        val diagram = buildJsonObject { put("kind", "diagram"); put("text", source); putJsonArray("sentences") {} }
        val blocks = JsonArray(section.arr("blocks").toMutableList().apply { add(1, diagram) })
        val doc = JsonObject(read + ("sections" to JsonArray(sections.toMutableList<JsonElement>().apply { set(at, JsonObject(section + ("blocks" to blocks))) })))
        return doc.decodeAs(WikiDoc.serializer()) to "wiki-doc-block:${section.str("key")}.1"
    }

    /** The source the page hands Mermaid, read back from its script literal. */
    private fun rendered(page: String): String =
        Json.parseToJsonElement(page.substringAfter("mermaid.render('wk-diagram', ").substringBefore(");\n")).jsonPrimitive.content

    private fun bridge(view: WebView) = shadowOf(view).getJavascriptInterface(WikiDiagramPage.BRIDGE) as WikiDiagramPage.Bridge

    /** The WebView's node inside the figure tagged [tag]: the size Compose gives it (Robolectric's WebView measures nothing). */
    private fun drawing(tag: String) = compose.onNode(hasTestTag(WikiDiagramPage.VIEW_TAG) and hasAnyAncestor(hasTestTag(tag)))

    private fun webViews(): List<WebView> {
        val found = mutableListOf<WebView>()
        fun walk(view: View) {
            if (view is WebView) found += view else if (view is ViewGroup) (0 until view.childCount).forEach { walk(view.getChildAt(it)) }
        }
        walk(compose.activity.window.decorView)
        return found
    }

    private fun request(url: String, mainFrame: Boolean = false) = object : WebResourceRequest {
        override fun getUrl(): Uri = Uri.parse(url)
        override fun isForMainFrame() = mainFrame
        override fun isRedirect() = false
        override fun hasGesture() = false
        override fun getMethod() = "GET"
        override fun getRequestHeaders() = emptyMap<String, String>()
    }
}
