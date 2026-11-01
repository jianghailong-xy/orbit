package io.orbitd.android.wiki

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.AssetManager
import android.view.MotionEvent
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream
import kotlin.math.abs
import kotlinx.serialization.json.*

// A section's diagram (contract `docs.diagram`), drawn the way the web's `WikiDiagram.tsx` draws it: the Mermaid flowchart the
// server wrote out again, rendered strict by the Mermaid that src/web's lockfile pins — bundled as an asset, never fetched — in
// the app's light or dark theme, at its own size, centred, and scrolling sideways when wider than the column rather than
// shrinking its words. A diagram that does not draw shows its source as code. Mermaid runs in a WebView as wide as the column
// and as high as the drawing, whose page scrolls a wide one sideways, as the web's figure does; it loads that one file and
// nothing else, never leaves its page, and has one way back: the size of what it drew.

/** The page a diagram's WebView loads and what it may reach, as plain values the JVM tests read. */
internal object WikiDiagramPage {
    /** The page's origin, WebViewAssetLoader's own domain: the bundled script loads as an ordinary https resource. */
    const val ORIGIN = "https://appassets.androidplatform.net"
    /** Mermaid's single-file browser build (`node_modules/mermaid/dist/mermaid.min.js`) under the app's assets. */
    const val ASSET = "mermaid/mermaid.min.js"
    const val SCRIPT = "$ORIGIN/$ASSET"
    /** The one name the page calls back on: [Bridge]. */
    const val BRIDGE = "orbitDiagram"
    /** The page's font, which Mermaid measures and draws its labels in: the system sans-serif the app's text is set in. */
    const val FONT = "sans-serif"
    /** The tag of the WebView's node inside a figure. */
    const val VIEW_TAG = "wiki-diagram-view"

    /** What the page reported: the drawn diagram's size in CSS pixels, which at the page's viewport are dp; 0 × 0 when
     * Mermaid could not draw it. */
    data class Report(val width: Int, val height: Int) {
        val drawn: Boolean get() = width > 0 && height > 0
    }

    val reportSaver = Saver<Report?, IntArray>(save = { it?.let { report -> intArrayOf(report.width, report.height) } },
        restore = { Report(it[0], it[1]) })

    /** Mermaid's settings: the web's, in the app's theme. */
    fun options(dark: Boolean): JsonObject = buildJsonObject {
        put("startOnLoad", false)
        put("securityLevel", "strict")
        put("theme", if (dark) "dark" else "neutral")
        put("fontFamily", FONT)
        putJsonObject("flowchart") { put("useMaxWidth", false) }
    }

    /** JSON as a script literal: ASCII only, `<`, `>` and `&` escaped too, so no text can close the script it sits in. */
    fun script(value: JsonElement): String = buildString {
        value.toString().forEach { c ->
            if (c == '<' || c == '>' || c == '&' || c.code > 0x7e) append("\\u").append(c.code.toString(16).padStart(4, '0')) else append(c)
        }
    }

    /** The page: Mermaid, from the app's assets, draws [source] into it — centred, or scrolling sideways when wider than the
     * page — and reports the size of what it drew. */
    fun html(source: String, dark: Boolean): String = """
        |<!doctype html>
        |<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        |<style>html, body { margin: 0; background: transparent; font-family: $FONT; user-select: none; -webkit-touch-callout: none; }
        |#diagram { overflow-x: auto; overflow-y: hidden; touch-action: pan-x; } #diagram > svg { display: block; margin: 0 auto; }</style>
        |</head><body><div id="diagram"></div>
        |<script src="$SCRIPT"></script>
        |<script>
        |(async () => {
        |  let width = 0, height = 0;
        |  try {
        |    mermaid.initialize(${script(options(dark))});
        |    const { svg } = await mermaid.render('wk-diagram', ${script(JsonPrimitive(source))});
        |    const figure = document.getElementById('diagram');
        |    figure.innerHTML = svg;
        |    const drawn = figure.firstElementChild.getBoundingClientRect();
        |    width = Math.ceil(drawn.width);
        |    height = Math.ceil(drawn.height);
        |  } catch (e) {
        |    // Not drawn: 0 x 0, and the app shows the source.
        |  }
        |  $BRIDGE.size(width, height);
        |})();
        |</script>
        |</body></html>
        |""".trimMargin()

    /** Whether a drag that has moved ([dx], [dy]) since it went down is the diagram's own: sideways, over a diagram wider than
     * its WebView ([wide]), which its page scrolls. Any other drag goes on to the list and the drawer, as over any block. */
    fun ownsDrag(dx: Float, dy: Float, wide: Boolean): Boolean = wide && abs(dx) > abs(dy)

    /** What the page may load: [ASSET], at [SCRIPT]. */
    fun loader(assets: AssetManager): WebViewAssetLoader = WebViewAssetLoader.Builder()
        .addPathHandler("/", WebViewAssetLoader.PathHandler { path ->
            if (path == ASSET) WebResourceResponse("text/javascript", "utf-8", assets.open(ASSET)) else null
        })
        .build()

    /** The answer to anything else the page asks for: nothing — no network, no file. */
    fun refused() = WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    /** Answers the page's requests from [loader] alone, keeps it on its page, and says so — [failed] — when the page cannot
     * load or its renderer is gone. */
    class Client(private val loader: WebViewAssetLoader, private val failed: () -> Unit) : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            // A data: URL is the page itself, as loadDataWithBaseURL hands it over: its own text, nothing fetched to read it.
            if (request.url.scheme == "data") null else loader.shouldInterceptRequest(request.url) ?: refused()
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) = failedIf(request)
        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) = failedIf(request)
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            failed()
            return true
        }
        /** The page itself did not load: what it would have drawn is shown as its source, never as an error page. */
        private fun failedIf(request: WebResourceRequest) {
            if (request.isForMainFrame) failed()
        }
    }

    /** The page's one way back: the size of what it drew. */
    class Bridge(private val report: (Int, Int) -> Unit) {
        @JavascriptInterface fun size(width: Int, height: Int) = report(width, height)
    }

    /** One diagram's WebView: JavaScript on, network and file access off, [html] loaded; [report] hears on the main thread
     * what it drew, and 0 × 0 when the page cannot load or its renderer is gone. */
    @SuppressLint("SetJavaScriptEnabled")
    fun view(context: Context, source: String, dark: Boolean, report: (Int, Int) -> Unit): WebView = DiagramWebView(context).apply {
        settings.javaScriptEnabled = true
        settings.blockNetworkLoads = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        setBackgroundColor(android.graphics.Color.TRANSPARENT)
        isVerticalScrollBarEnabled = false
        isHorizontalScrollBarEnabled = false
        overScrollMode = View.OVER_SCROLL_NEVER
        isFocusable = false
        // TalkBack reads the figure's name; the labels inside are not read one by one.
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        webViewClient = Client(loader(context.assets)) { report(0, 0) }
        addJavascriptInterface(Bridge { width, height ->
            context.mainExecutor.execute {
                wide = width * resources.displayMetrics.density > this.width + 0.5f
                report(width, height)
            }
        }, BRIDGE)
        loadDataWithBaseURL("$ORIGIN/", html(source, dark), "text/html", "utf-8", null)
    }
}

/** A diagram's WebView, which keeps the sideways drags its page scrolls: Compose hands a View each move before the gestures
 * around it see it, and asking them not to intercept is how the View keeps it — otherwise the navigation drawer takes the drag
 * once it passes the touch slop. */
@SuppressLint("ViewConstructor", "ClickableViewAccessibility")
private class DiagramWebView(context: Context) : WebView(context) {
    /** Whether what the page drew is wider than this view, so that its page scrolls it sideways. */
    var wide = false
    private var downX = 0f
    private var downY = 0f

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> { downX = event.x; downY = event.y }
            MotionEvent.ACTION_MOVE -> if (WikiDiagramPage.ownsDrag(event.x - downX, event.y - downY, wide))
                parent?.requestDisallowInterceptTouchEvent(true)
        }
        return super.onTouchEvent(event)
    }
}

/** A section's diagram: 120 dp high while Mermaid draws it, then as high as the drawing, across the column — centred in it, or
 * scrolling sideways inside its page when wider; its source as code when it does not draw. TalkBack names it as the web names
 * its figure. */
@Composable
internal fun WikiDiagram(source: String, tag: String) {
    val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f
    var report by rememberSaveable(source, stateSaver = WikiDiagramPage.reportSaver) { mutableStateOf<WikiDiagramPage.Report?>(null) }
    val inset = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)
        .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.05f), RoundedCornerShape(8.dp))
    val shown = report
    if (shown != null && !shown.drawn) {
        // As a code block shows its code.
        Box(inset.horizontalScroll(rememberScrollState()).testTag(tag)) {
            Text(source, Modifier.padding(10.dp), style = WikiType.mono, softWrap = false)
        }
    } else {
        Box(inset.semantics { contentDescription = WikiDocCopy.diagram; role = Role.Image }.testTag(tag).padding(12.dp)) {
            key(source, dark) {
                AndroidView(factory = { context -> WikiDiagramPage.view(context, source, dark) { w, h -> report = WikiDiagramPage.Report(w, h) } },
                    modifier = Modifier.testTag(WikiDiagramPage.VIEW_TAG).fillMaxWidth().height(shown?.height?.dp ?: 96.dp),
                    onRelease = { it.destroy() })
            }
        }
    }
}
