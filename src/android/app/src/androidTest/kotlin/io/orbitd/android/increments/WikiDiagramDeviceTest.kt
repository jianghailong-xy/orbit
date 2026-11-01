package io.orbitd.android.increments

import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A wiki document's diagrams (contract `docs.diagram`) on a device, over the test's own fixture: a space whose confirmed plan has one
 * written document whose two sections each draw a diagram as the server writes one out again — one that fits the column, and the
 * server spec's own written-out flowchart (wiki-doc-diagram.spec.ts), wider than it. The real app opens the document from the wiki's
 * home and the real WebView draws both with the bundled Mermaid; each check reads the drawn SVG back from its page, and the
 * screenshots show the page in the account's light and dark theme.
 */
@RunWith(AndroidJUnit4::class)
class WikiDiagramDeviceTest : IncrementDeviceTest() {
    private val space = "34UAq0rbitSpaceOrbit01"
    private val slug = "session-delivery"
    override val ids get() = listOf(workspace, runner, space)
    @Volatile private var theme = "light"
    override fun userJson() = """{"id":"u1","email":"a15c@example.test","name":"A15c fixture","preferences":{"theme":"$theme"}}"""

    private val fits = listOf("flowchart TB", "  n1[\"Turn stored\"]", "  n2([\"Event written\"])", "  n3[(\"Event stream\")]",
        "  n4[\"Shown in the app\"]", "  n1 --> n2", "  n2 -->|\"in order\"| n3", "  n3 -->|\"live, or on return\"| n4").joinToString("\n")
    private val wide = listOf("flowchart LR", "  n1[\"Plan confirmed\"]", "  n2([\"docs_build job\"])", "  n3[(\"wiki-worker\")]",
        "  n4{{\"Repository\"}}", "  n5{\"Model queue\"}", "  subgraph s1[\"The server\"]", "    direction TB", "    n6((\"System model\"))", "  end",
        "  n1 --> n2", "  n2 -->|\"claims\"| n3", "  n3 -->|\"reads\"| n4", "  n3 -.-> n5", "  n5 ==> n6", "  n6 --- n1").joinToString("\n")

    private fun spaceRow() = """{"id":"$space","publicId":"$space","slug":"orbit","title":"Orbit","repoUrlNorm":"github.com/jianghailong-xy/orbit",
        "rootCommitSha":"4db4f9f0a1b2c3d4e5f60718293a4b5c6d7e8f90","pendingOps":0,"planWaiting":0,"workspaceIds":["$workspace"],"docs":null,
        "createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-25T09:00:00.000Z",
        "settings":{"reviewMode":"automatic","automaticSpotChecks":false,"push":true,"autoAcceptReinforce":true,
        "maintenance":{"enabled":false,"workspaceId":"$workspace","provider":null,"dailyRunLimit":4,"lookbackDays":14}}}"""
    private fun directory() = """{"spaceId":"$space","plan":{"version":1,"confirmedAt":"${ago(600)}"},"docs":{"total":1,"written":1},
        "categories":[{"key":"runtime","number":1,"title":"Runtime","question":"How a session runs and reaches the app","forAgents":false,
        "docs":[{"slug":"$slug","number":"1.1","title":"Session delivery","question":"How does a turn the runner stores reach the app?",
        "written":true,"status":"ok","updatedAt":"${ago(30)}","planVersion":1,
        "lead":"A turn the runner stores reaches the app over its session's event stream.",
        "sections":[{"key":"s1","number":1,"title":"Overview","kind":"overview","written":true,"stale":false},
        {"key":"s2","number":2,"title":"How the docs are built","kind":"flow","written":true,"stale":false}]}]}]}"""
    private fun sentence(text: String, note: Int) = """{"text":${quote(text)},"status":"sourced","notes":[$note],"newTokens":[]}"""
    private fun doc() = """{"spaceId":"$space","slug":"$slug","number":"1.1","title":"Session delivery",
        "question":"How does a turn the runner stores reach the app?","audience":["Developers"],"scopeIn":["The session's event stream"],
        "scopeOut":[],"category":{"key":"runtime","number":1,"title":"Runtime"},"length":{"min":2,"max":4},"planVersion":1,"written":true,
        "status":"ok","writtenFromPlanVersion":1,"repoSha":"${"c".repeat(40)}","updatedAt":"${ago(30)}",
        "counts":{"sentences":5,"sourced":5,"transition":0,"unsourced":0,"unverified":0,"withdrawn":0},"unsourcedShare":0,
        "sections":[{"key":"s1","number":1,"title":"Overview","kind":"overview","written":true,"stale":false,"generatedAt":"${ago(30)}","blocks":[
          {"kind":"paragraph","sentences":[${sentence("A turn the runner stores is written as an event, in order, to its session's event stream.", 1)},
            ${sentence("The app shows it from that stream: live while it is connected, or on return when it was away.", 1)}]},
          {"kind":"diagram","text":${quote(fits)},"sentences":[]},
          {"kind":"paragraph","sentences":[${sentence("Nothing is lost while the app is away.", 2)}]}]},
        {"key":"s2","number":2,"title":"How the docs are built","kind":"flow","written":true,"stale":false,"generatedAt":"${ago(30)}","blocks":[
          {"kind":"paragraph","sentences":[${sentence("Once the plan is confirmed, a docs_build job is queued and the wiki-worker claims it.", 2)},
            ${sentence("The wiki-worker reads the Repository and puts its calls in the Model queue, which the System model on the server answers.", 2)}]},
          {"kind":"diagram","text":${quote(wide)},"sentences":[]}]}],
        "footnotes":[{"n":1,"kind":"code","verdict":"verified","checkedBy":"server","quote":"await this.waitForInbox(sessionId)",
          "path":"src/apiserver/src/realtime/realtime.service.ts","sha":"${"c".repeat(40)}","lineStart":120,"lineEnd":134,
          "symbol":"RealtimeService.waitForInbox"},
          {"n":2,"kind":"code","verdict":"verified","checkedBy":"server","quote":"claimDocsBuild(job)","path":"src/apiserver/src/wiki-worker/wiki-docs-build.ts",
          "sha":"${"c".repeat(40)}","lineStart":40,"lineEnd":52,"symbol":"claimDocsBuild"}],
        "entries":[]}"""

    override fun answer(req: Req): MockResponse? {
        if (req.parts[0] != "wiki" && req.path != "link-previews") return null
        return when (req.path) {
            "link-previews" -> json("""{"previews":[]}""")
            "wiki/spaces" -> json("[${spaceRow()}]")
            "wiki/search" -> json("""{"q":"","hits":[]}""")
            "wiki/review" -> json("[]")
            "wiki/spaces/$space" -> json(spaceRow())
            "wiki/spaces/$space/entries" -> json("[]")
            "wiki/spaces/$space/timeline" -> json("""{"items":[]}""")
            "wiki/spaces/$space/health" -> json("""{"spaceId":"$space","entries":9,"maintenance":{"look":"off","enabled":false,"backlog":0},
                "repo":{"look":"ready","pending":0}}""")
            "wiki/spaces/$space/plan" -> json("""{"spaceId":"$space","confirmed":null,"draft":null,"proposals":[],"job":null}""")
            "wiki/spaces/$space/plan/versions" -> json("""{"spaceId":"$space","versions":[]}""")
            "wiki/spaces/$space/docs" -> json(directory())
            "wiki/spaces/$space/docs/$slug" -> json(doc())
            "wiki/spaces/$space/doc-index" -> json("""{"spaceId":"$space","plan":{"version":1},"items":[]}""")
            else -> json("""{"message":"not found"}""", 404)
        }
    }

    @Test fun aDocumentsDiagramsAreDrawnInTheLightTheme() = journey { walk("light") }

    @Test fun aDocumentsDiagramsAreDrawnInTheDarkTheme() = journey { walk("dark") }

    private fun walk(theme: String) {
        this.theme = theme
        signIn()
        compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
        await("the drawer's Wiki row") { exists(hasText("Wiki") and hasClickAction()) }
        compose.onAllNodes(hasText("Wiki") and hasClickAction()).onFirst().performClick()
        await("the wiki home lists the document") { exists(hasTestTag("wiki-home-doc:$slug")) }
        compose.onNodeWithTag("wiki-home-doc:$slug").performClick()
        await("the document's page") { exists(hasTestTag("wiki-doc-title")) }

        // The diagram that fits: drawn by Mermaid in the page, the WebView as high as the drawing, which the page centres.
        compose.onNodeWithTag("wiki-doc-list").performScrollToNode(hasTestTag("wiki-doc-block:s1.1"))
        val one = drawn("wiki-doc-block:s1.1", listOf("Turn stored", "Event written", "Event stream", "Shown in the app", "in order",
            "live, or on return"), theme)
        toTop("wiki-doc-section:s1")
        verify("it fits the column (${one.width} dp in ${inside("wiki-doc-block:s1.1")} dp)", one.width <= inside("wiki-doc-block:s1.1"))
        verify("its page centres it (left ${one.left} of ${one.page} dp)", abs(one.left - (one.page - one.width) / 2f) <= 1f)
        verify("TalkBack names it Diagram", exists(hasTestTag("wiki-doc-block:s1.1") and hasContentDescription("Diagram")))
        verify("it is wholly on screen", whole("wiki-doc-block:s1.1"))
        capture("01-$theme-section-diagram")

        // The server's own written-out flowchart: wider than the column, so its page scrolls it sideways.
        compose.onNodeWithTag("wiki-doc-list").performScrollToNode(hasTestTag("wiki-doc-block:s2.1"))
        val two = drawn("wiki-doc-block:s2.1", listOf("Plan confirmed", "docs_build job", "wiki-worker", "Repository", "Model queue",
            "The server", "System model", "claims", "reads"), theme)
        toTop("wiki-doc-section:s2")
        verify("it is wider than the column (${two.width} dp against ${inside("wiki-doc-block:s2.1")} dp)", two.width > inside("wiki-doc-block:s2.1"))
        verify("it starts at its left edge", two.left == 0)
        verify("it is wholly on screen", whole("wiki-doc-block:s2.1"))
        capture("02-$theme-wide-diagram")
        val wide = bounds("wiki-doc-block:s2.1")
        val middle = (wide.top + wide.bottom) / 2f
        swipe(wide.right - 80f, middle, wide.left + 80f, middle)
        var last = -1
        // The drag is the diagram's: the drawer and the list around it do not take it after the touch slop.
        await("a drag scrolls it sideways, well past the touch slop, and it comes to rest") {
            val now = scrollLeft("wiki-doc-block:s2.1")
            val rest = now > 100 && now == last
            last = now
            if (!rest) android.os.SystemClock.sleep(300)
            rest
        }
        note("scrolled sideways by $last dp of ${two.width - two.page}")
        capture("03-$theme-wide-diagram-scrolled")

        // A drag down over a diagram scrolls the document, as over any block.
        val before = bounds("wiki-doc-block:s2.1").top
        val x = (wide.left + wide.right) / 2f
        swipe(x, before + 100f, x, before + 500f, ms = 1_500)
        verify("a drag down over it scrolls the document (${bounds("wiki-doc-block:s2.1").top} from $before)", bounds("wiki-doc-block:s2.1").top > before)
        verify("the app fetched nothing for it", calls.none { it.contains("mermaid", ignoreCase = true) })
    }

    /** Scrolls the document so the row tagged [tag] stands at the top of the list. */
    private fun toTop(tag: String) {
        val list = compose.onNodeWithTag("wiki-doc-list")
        compose.onNodeWithTag("wiki-doc-list").performScrollToNode(hasTestTag(tag))
        val by = compose.onNodeWithTag(tag).fetchSemanticsNode().boundsInRoot.top - list.fetchSemanticsNode().boundsInRoot.top
        list.performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, by) }
        settle()
    }

    /** A finger's drag through the device's input system, from (x1, y1) to (x2, y2) in screen pixels, over [ms]. */
    private fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, ms: Int = 300) {
        val done = instrumentation.uiAutomation.executeShellCommand("input touchscreen swipe ${x1.toInt()} ${y1.toInt()} ${x2.toInt()} ${y2.toInt()} $ms")
        android.os.ParcelFileDescriptor.AutoCloseInputStream(done).use { it.readBytes() }
        settle()
    }

    /** How far the page of the figure tagged [tag] is scrolled sideways, in dp; -1 when it cannot be read. */
    private fun scrollLeft(tag: String) = webView(tag)?.let(::probe)?.get("scrollLeft")?.jsonPrimitive?.int ?: -1

    /** The figure tagged [tag] stands wholly inside the list: its own extent, not the part the list's clip leaves. */
    private fun whole(tag: String): Boolean {
        val list = compose.onNodeWithTag("wiki-doc-list").fetchSemanticsNode().boundsInRoot
        val figure = compose.onNodeWithTag(tag).fetchSemanticsNode()
        return figure.positionInRoot.y >= list.top && figure.positionInRoot.y + figure.size.height <= list.bottom
    }

    // ---- What the page drew. ----

    /** What a page drew, in dp: its SVG's size, where the SVG's left edge stands in the page, and the page's width. */
    private class Shot(val width: Int, val height: Int, val left: Int, val page: Int)
    private class Located(val left: Int, val top: Int, val right: Int, val bottom: Int)
    private class Box(val left: Float, val top: Float, val right: Float, val bottom: Float) {
        val width get() = right - left
    }

    private fun density() = app.resources.displayMetrics.density

    /** The width a figure gives its WebView, in dp: its own, less its 12 dp padding on either side. */
    private fun inside(tag: String) = bounds(tag).width / density() - 24

    /** A figure's bounds in the window, in px. */
    private fun bounds(tag: String): Box {
        val r = compose.onNodeWithTag(tag).fetchSemanticsNode().boundsInWindow
        return Box(r.left, r.top, r.right, r.bottom)
    }

    /** The WebView inside the figure tagged [tag], where it stands in the window. */
    private fun webView(tag: String): WebView? {
        val box = bounds(tag)
        var found: WebView? = null
        compose.activityRule.scenario.onActivity { activity ->
            fun walk(view: View) {
                if (view is WebView) {
                    val at = IntArray(2).also(view::getLocationInWindow)
                    if (at[1] >= box.top - 1 && at[1] <= box.bottom) found = view
                } else if (view is ViewGroup) (0 until view.childCount).forEach { walk(view.getChildAt(it)) }
            }
            walk(activity.window.decorView)
        }
        return found
    }

    private fun located(tag: String): Located {
        val view = requireNotNull(webView(tag)) { "no WebView in $tag" }
        var at = Located(0, 0, 0, 0)
        compose.activityRule.scenario.onActivity {
            val xy = IntArray(2).also(view::getLocationInWindow)
            at = Located(xy[0], xy[1], xy[0] + view.width, xy[1] + view.height)
        }
        return at
    }

    /** Asks the page in [view] what Mermaid drew: the SVG's size and place, the page's sideways scroll, the labels, the font, the
     * first node's fill and the scripts the page loaded. */
    private fun probe(view: WebView): JsonObject? {
        val latch = CountDownLatch(1)
        var answer: String? = null
        compose.activityRule.scenario.onActivity {
            view.evaluateJavascript("""(() => {
                const svg = document.querySelector('#diagram > svg');
                if (!svg) return null;
                const box = svg.getBoundingClientRect();
                const fills = [...svg.querySelectorAll('.node rect, .node polygon, .node path, .node circle')]
                  .map((e) => getComputedStyle(e).fill).filter((f) => f.startsWith('rgb') && !/,\s*0\)$/.test(f));
                const words = svg.cloneNode(true);
                words.querySelectorAll('style').forEach((e) => e.remove());
                return JSON.stringify({ width: Math.ceil(box.width), height: Math.ceil(box.height), left: Math.round(box.left), page: innerWidth,
                  scrollLeft: Math.round(document.getElementById('diagram').scrollLeft),
                  labels: [...svg.querySelectorAll('.nodeLabel, .edgeLabel, .cluster-label')].map((e) => e.textContent.trim()).filter((t) => t),
                  text: words.textContent.replace(/\s+/g, ' ').trim(),
                  font: getComputedStyle(svg).fontFamily, fill: fills.length ? fills[0] : null,
                  scripts: [...document.scripts].map((s) => s.src).filter((s) => s) });
              })()""") { answer = it; latch.countDown() }
        }
        latch.await(10, TimeUnit.SECONDS)
        val value = answer?.let(Json::parseToJsonElement)
        if (value == null || value is JsonNull) return null
        return Json.parseToJsonElement(value.jsonPrimitive.content).jsonObject
    }

    /** Waits until the figure tagged [tag] holds a drawn SVG and the WebView stands across the figure, as high as the SVG; checks its
     * labels, font, script and theme. */
    private fun drawn(tag: String, labels: List<String>, theme: String): Shot {
        var drawnSvg: JsonObject? = null
        await("$tag is drawn, its WebView as high as the SVG and across the figure", timeoutMs = 60_000) {
            val view = webView(tag) ?: return@await false
            val svg = probe(view) ?: return@await false
            val at = located(tag)
            drawnSvg = svg
            val height = svg["height"]!!.jsonPrimitive.int
            abs((at.right - at.left) / density() - inside(tag)) <= 1f && abs((at.bottom - at.top) / density() - height) <= 1f
        }
        val svg = requireNotNull(drawnSvg)
        note("$tag drew $svg")
        // Each label, as an HTML label's text or as words of the SVG's text.
        val shown = svg["labels"]!!.jsonArray.map { it.jsonPrimitive.content }
        val text = " ${svg["text"]!!.jsonPrimitive.content} "
        val missing = labels.filter { it !in shown && !Regex("(?<![\\w-])" + Regex.escape(it) + "(?![\\w-])").containsMatchIn(text) }
        verify("$tag shows ${labels.joinToString()} (missing: ${missing.joinToString()})", missing.isEmpty())
        verify("$tag is set in the page's font", svg["font"]!!.jsonPrimitive.content.contains("sans-serif"))
        verify("$tag loaded Mermaid from the app's assets alone",
            svg["scripts"]!!.jsonArray.map { it.jsonPrimitive.content } == listOf("https://appassets.androidplatform.net/mermaid/mermaid.min.js"))
        val fill = svg["fill"]?.jsonPrimitive?.contentOrNull.orEmpty()
        val rgb = Regex("""\d+""").findAll(fill).take(3).map { it.value.toInt() }.toList()
        verify("$tag is in the $theme theme (first node $fill)", rgb.size == 3 && (rgb.sum() / 3 < 128) == (theme == "dark"))
        return Shot(svg["width"]!!.jsonPrimitive.int, svg["height"]!!.jsonPrimitive.int, svg["left"]!!.jsonPrimitive.int, svg["page"]!!.jsonPrimitive.int)
    }
}
