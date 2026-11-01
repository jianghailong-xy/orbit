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
 * app's assets, drawing in the web's diagram look, line for line the iOS and Mac app's, in the app's theme — what that WebView
 * may reach, and the figure it sits in on a document's page: named Diagram, 120 dp high while it draws, then at the size the page
 * reports, centred or scrolling sideways, and the source as code when it does not draw. Robolectric runs no JavaScript: the page's
 * report is played on its bridge. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class WikiDiagramTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    /** The web's case (WikiDocPage.test.tsx): a flowchart as the server writes it out again. */
    private val source = "flowchart LR\n  n1[\"Turn stored\"]\n  n2[\"Delivered\"]\n  n1 --> n2"
    private val bundled get() = wikiShared("src/android/app/src/main/assets/${WikiDiagramPage.ASSET}")

    // MARK: the page

    @Test fun theDiagramIsDrawnLineForLineAsTheWebAndTheAppleAppsDrawIt() {
        // The drawing is the iOS and Mac app's (WikiDiagramPage.draw), between the same two marks.
        val swift = wikiShared("src/macos/OrbitApp/Sources/OrbitApp/Views/WikiDiagram.swift").readText()
        val start = "// wiki diagram drawing: from here"
        val end = "// wiki diagram drawing: to here"
        assertTrue(WikiDiagramPage.DRAW.startsWith(start) && WikiDiagramPage.DRAW.endsWith(end))
        assertEquals(swift.substring(swift.indexOf(start), swift.indexOf(end) + end.length).lines().map { it.trim() },
            WikiDiagramPage.DRAW.lines().map { it.trim() })
        // Its look is the web's (docs/mocks/wiki-diagram-look), line by line: the colours, Mermaid's options, the finish, the turn.
        val web = wikiShared("src/web/src/components/WikiDiagram.tsx").readText()
        listOf(
            """light: { fill: '#ffffff', border: '#d5d8dd', text: '#1f2329', label: '#646a73', line: '#9aa0a8', group: 'rgba(0, 0, 0, 0.035)', groupBorder: 'rgba(0, 0, 0, 0.06)' },""",
            """dark: { fill: 'rgba(255, 255, 255, 0.07)', border: 'rgba(255, 255, 255, 0.18)', text: '#c9ced5', label: '#a7adb6', line: '#6e737b', group: 'rgba(255, 255, 255, 0.035)', groupBorder: 'rgba(255, 255, 255, 0.06)' },""",
            "startOnLoad: false, securityLevel: 'strict', look: 'classic', theme: 'base', fontFamily,",
            "themeVariables: { darkMode: dark, fontSize: '13px', primaryColor: c.fill, mainBkg: c.fill, primaryBorderColor: c.border, nodeBorder: c.border,",
            "primaryTextColor: c.text, nodeTextColor: c.text, textColor: c.text, lineColor: c.line, clusterBkg: c.group, clusterBorder: c.groupBorder, titleColor: c.label },",
            "flowchart: { useMaxWidth: false, curve: 'basis', nodeSpacing: 28, rankSpacing: 34, padding: 10, wrappingWidth: 200, minNodeWidth: 0, diagramPadding: 4 },",
            "'.node rect { rx: 6px; ry: 6px; } .cluster rect { rx: 8px; ry: 8px; } .cluster-label span { font-size: 12px; font-weight: 600; }'",
            "' .edgeLabel, .edgeLabel p, .labelBkg { background-color: transparent; font-size: 12px; color: ' + c.label + '; } .edgeLabel rect { fill: none; } .flowchart-link { stroke-width: 1.2px; }'",
            "title.setAttribute('transform', 'translate(' + (Number(box.getAttribute('x')) + 10) + ', ' + (at[1] + 4) + ')');",
            "if (width > 0 && height > 0) holes.push([x - 3, y - 1, width + 6, height + 2]);",
            "if (outer && inner) hole(outer[0] + inner[0], outer[1] + inner[1], label.querySelector('foreignObject'));",
            "if (title && at) hole(at[0], at[1], title.querySelector('foreignObject'));",
            "for (const links of childrenOf(root, 'edgePaths')) links.setAttribute('mask', 'url(#' + id + ')');",
            """/^flowchart LR\n/u.test(source) ? source.replace(/^flowchart LR/u, 'flowchart TB') : null;""",
        ).forEach {
            assertTrue("WikiDiagram.tsx no longer says $it", web.contains(it))
            assertTrue("the drawing no longer says $it", WikiDiagramPage.DRAW.contains(it))
        }
        // Its page font is the page's, as the web's is.
        assertTrue(web.contains("getComputedStyle(document.body).fontFamily") && WikiDiagramPage.DRAW.contains("getComputedStyle(document.body).fontFamily"))
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
        assertTrue("the page draws with the drawing", page.contains("async function draw(source, dark, room) {\n${WikiDiagramPage.DRAW}\n}\n"))
        assertTrue(page.contains("size = await draw(${WikiDiagramPage.script(JsonPrimitive(source))}, false, drawnFor);"))
        assertTrue(WikiDiagramPage.html(source, dark = true).contains("size = await draw(${WikiDiagramPage.script(JsonPrimitive(source))}, true, drawnFor);"))
        assertEquals(source, rendered(page))
        assertTrue(page.contains("font-family: ${WikiDiagramPage.FONT};"))
        assertTrue("a wide drawing scrolls sideways in the page, a narrow one is centred",
            page.contains("#figure { overflow-x: auto; overflow-y: hidden; touch-action: pan-x; } #figure > svg { display: block; margin: 0 auto; }"))
        assertTrue("the room it draws for is the WebView's width", page.contains("drawnFor = document.documentElement.clientWidth;"))
        assertTrue("what it drew, or 0 x 0, is the page's report", page.contains("${WikiDiagramPage.BRIDGE}.size(size[0], size[1]);"))
        assertTrue("and again for each new width the WebView takes",
            page.contains("addEventListener('resize', () => { if (document.documentElement.clientWidth !== drawnFor) report(); });"))
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

    /** The source the page hands its drawing, read back from its script literal. */
    private fun rendered(page: String): String =
        Json.parseToJsonElement(requireNotNull(Regex("""size = await draw\(("(?:[^"\\]|\\.)*")""").find(page)).groupValues[1]).jsonPrimitive.content

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
