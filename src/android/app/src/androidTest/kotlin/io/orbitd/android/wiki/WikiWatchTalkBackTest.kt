package io.orbitd.android.wiki

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.UiAutomation
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Rect
import android.net.Uri
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.os.Process
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.ui.OrbitTheme
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.BuildConfig
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.core.protocol.Wire
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.roundToInt

/**
 * The Wiki and Watch pages with TalkBack itself on the emulator, over the loopback fixture (scripts/wiki-watch-fixture.py).
 * Run by `A12_TALKBACK=1 A12_TEST=io.orbitd.android.wiki.WikiWatchTalkBackTest scripts/wiki-watch-device-test.sh`, which
 * turns TalkBack on for the run, makes [TalkBackSpeechRecorder] the speech engine, passes the emulator console's port and
 * token, and puts every setting back after.
 *
 * On each page: what TalkBack can reach on screen and the words it has for each; TalkBack's swipe-right order from the
 * page's first item, with what it stops on and what it spoke; the page's main controls, each focused by a touch on it
 * (explore by touch); and a control activated by TalkBack's double tap, whose effect is checked — a page or a sheet opens,
 * a request reaches the fixture's journal, a control changes state. A stop without words, or a symbol read on its own
 * ("•", "›", "✓", "—"), fails the page; a symbol inside words is noted. Fingers come from the emulator's touchscreen (its
 * console): TalkBack never sees events injected by UiAutomation or `input`. Every UiAutomation call keeps accessibility
 * services on: the default one switches TalkBack off while it is connected. Each journey signs in before its Activity
 * starts and signs out after it closed, as [WikiWatchDeviceTest]'s do. Controlled HTTP only.
 */
@RunWith(AndroidJUnit4::class)
class WikiWatchTalkBackTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val output get() = File(app.filesDir, "a12-wiki-watch").also { it.mkdirs() }
    private val server = "http://127.0.0.1:18770"
    private val report = StringBuilder()
    private val problems = linkedSetOf<String>()
    private val notes = linkedSetOf<String>()
    private var recorded = false

    // MARK: the pages

    /** The home from its link, Activity from the bar and Review from Activity's banner, each by double tap: Accept, by double
     * tap, records one decision. */
    @Test fun homeAndReview() = journey("home", { "orbit://wiki/${it.string("space")}" }) {
        awaitTag("wiki-home-line")
        page("home", steps = 30)
        touch("home", "wiki-bar-contents", "Contents")
        touch("home", "wiki-bar-activity", "Activity")
        touch("home", "wiki-bar-settings", "Settings")
        touch("home", "wiki-space-picker", "The codebase this wiki describes")
        touch("home", "wiki-search", null)
        activate("home", "wiki-bar-activity", "Activity")
        awaitTag("wiki-status-line")
        log("double tap on Activity -> Activity opened")
        page("activity", steps = 30)
        activate("activity", "wiki-review-banner", "proposals to review")
        awaitTag("wiki-review-page")
        log("double tap on the banner -> Review opened")
        page("review", steps = 30)
        touch("review", "wiki-review-next", "Next")
        touch("review", "wiki-review-reject", "Reject")
        val since = activate("review", "wiki-review-accept", "Accept")
        compose.waitUntil(15_000) { requests("POST", "/decide").isNotEmpty() }
        val decision = requests("POST", "/decide").single().getValue("body").jsonObject.getValue("decisions").jsonArray.single().jsonObject
        assertEquals("accept", decision.string("action"))
        readBack("review", "double tap on Accept -> one POST …/decide {action: accept}", since)
    }

    /** Wiki settings from the home's gear by double tap: a review mode and the spot-check switch, each by double tap, are
     * written, and TalkBack reads the switch's new state. */
    @Test fun settings() = journey("settings", { "orbit://wiki/${it.string("space")}" }) {
        awaitTag("wiki-home-line")
        activate("home", "wiki-bar-settings", "Settings")
        awaitTag("wiki-settings-page")
        log("double tap on Settings -> Wiki settings opened")
        page("settings", steps = 25)
        touch("settings", "wiki-settings-mode:manual", "Manual")
        touch("settings", "wiki-settings-set-up", "Set up")
        var since = activate("settings", "wiki-settings-mode:automatic", "Automatic")
        compose.waitUntil(15_000) { spaceSettings().string("reviewMode") == "automatic" }
        readBack("settings", "double tap on Automatic -> PATCH reviewMode=automatic", since)
        compose.waitUntil(15_000) { compose.onAllNodes(hasTestTag("wiki-settings-spot-checks") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        since = activate("settings", "wiki-settings-spot-checks", "Spot-check Automatic")
        compose.waitUntil(15_000) { spaceSettings()["automaticSpotChecks"]?.jsonPrimitive?.boolean == true }
        assertEquals(listOf(setOf("reviewMode"), setOf("automaticSpotChecks")),
            requests("PATCH", "/api/wiki/spaces/${http("/__ids").string("space")}").map { it.getValue("body").jsonObject.keys })
        readBack("settings", "double tap on Spot-check Automatic -> PATCH automaticSpotChecks=true", since)
        // TalkBack's focus stays on the switch, which now reads as on.
        val until = SystemClock.uptimeMillis() + 5_000
        while (focused()?.let(::checked) != true && SystemClock.uptimeMillis() < until) SystemClock.sleep(250)
        focused().let { if (it?.let(::checked) != true) problem("settings: after its double tap the switch does not read as on", it?.let(::describe) ?: "no focus") }
    }

    /** An entry from its link: Confirm, by double tap, is the owner's answer — one POST, and the entry is confirmed. */
    @Test fun entry() = journey("entry", { "orbit-wiki:${it.string("entry")}" }) { ids ->
        awaitTag("wiki-entry-title")
        page("entry", steps = 30)
        touch("entry", "wiki-entry-edit", "Edit")
        touch("entry", "wiki-entry-more", "More actions")
        touch("entry", "wiki-entry-reject", "Reject")
        val since = activate("entry", "wiki-entry-confirm", "Confirm")
        compose.waitUntil(15_000) { http("/__stats").getValue("entry").jsonObject.string("trust") == "confirmed" }
        assertEquals(1, requests("POST", "/api/wiki/entries/${ids.string("entry")}/confirm").size)
        readBack("entry", "double tap on Confirm -> one POST …/confirm; the entry is confirmed", since)
    }

    /** Contents by double tap, the confirmed plan's document by double tap; a footnote's row opens its sheet, whose button
     * opens the session at the quoted record. */
    @Test fun documentAndFootnote() = journey("doc", { "orbit://wiki/${it.string("space")}" }) { ids ->
        awaitTag("wiki-home-line")
        activate("home", "wiki-bar-contents", "Contents")
        awaitTag("wiki-contents-sheet")
        log("double tap on Contents -> the Contents sheet opened")
        page("contents", steps = 15, fromTop = true)
        activate("contents", "wiki-contents-doc:session-runtime", "会话运行模型与长连接")
        awaitTag("wiki-doc-list")
        log("double tap on the document's row -> the document opened")
        page("doc", steps = 40)
        touch("doc", "wiki-doc-crumb", "Wiki")
        touch("doc", "wiki-doc-next-marked", "Next marked")
        touch("doc", "wiki-doc-scope-toggle", "Written for")
        touch("doc", "wiki-doc-footnote:1", "1.")
        activate("doc", "wiki-doc-footnote:30", "30.")
        awaitTag("wiki-doc-footnote-sheet")
        log("double tap on footnote 30 -> its sheet opened")
        page("footnote", steps = 15, fromTop = true)
        val since = activate("footnote", "wiki-doc-source-open", "Open at this turn")
        compose.waitUntil(20_000) { app.realtime.state.value.session?.id == ids.string("session") }
        compose.waitUntil(20_000) { journal().any { it.string("path").contains("/events/page") && it.string("path").contains("around=") } }
        readBack("footnote", "double tap on Open at this turn -> the session opened at the quoted record (GET …/events/page?around=…)", since)
        back()
        awaitTag("wiki-doc-list")
    }

    /** Contents by double tap, then the plan, its draft waiting: Confirm plan, by double tap, confirms it once. */
    @Test fun plan() = journey("plan", { "orbit://wiki/${it.string("space")}" }) {
        http("/__control", """{"draft":"v2"}""")
        awaitTag("wiki-home-line")
        activate("home", "wiki-bar-contents", "Contents")
        awaitTag("wiki-contents-sheet")
        activate("contents", "wiki-contents-plan", "Plan")
        awaitTag("wiki-plan-confirm")
        log("double tap on Plan -> the plan opened, draft v2 waiting")
        page("plan", steps = 30)
        touch("plan", "wiki-plan-version-menu", "v2")
        touch("plan", "wiki-plan-redraft", "Redraft")
        val since = activate("plan", "wiki-plan-confirm", "Confirm plan")
        compose.waitUntil(15_000) { requests("POST", "/plan/versions/2/confirm").size == 1 }
        readBack("plan", "double tap on Confirm plan -> one POST …/plan/versions/2/confirm", since)
    }

    /** A watch from its link: Pause, by double tap, is written and the record then offers Resume; Back lands on
     * Following, whose row opens the record again by double tap. */
    @Test fun watchAndFollowing() = journey("watch", { "orbit://watch/${it.string("watch")}" }) { ids ->
        val watch = ids.string("watch")
        awaitTag("watch-detail:$watch")
        page("watch", steps = 25)
        touch("watch", "watch:$watch:WATCH_CANCEL", "Stop")
        val since = activate("watch", "watch:$watch:WATCH_PAUSE", "Pause")
        compose.waitUntil(15_000) { http("/__stats").getValue("watch").jsonObject.string("state") == "PAUSED" }
        awaitTag("watch:$watch:WATCH_RESUME")
        readBack("watch", "double tap on Pause -> POST /api/watches/…/pause; the record offers Resume", since)
        back()
        awaitTag("following-list")
        page("following", steps = 15)
        activate("following", "following-row:$watch", null)
        awaitTag("watch-detail:$watch")
        log("double tap on the watch's row -> its record opened")
    }

    /** A session's wait on a task, which since A08-6 is a row of its Tasks card (a wait on tasks alone draws no Watching strip):
     * the card's line, by double tap, opens its rows; the task's row, by double tap, opens the task's page over the session. The
     * rest of the session page is not this check's: only the card is judged. */
    @Test fun sessionTasksCard() = journey("tasks-card", { "orbit-session:${it.string("session")}" }) { ids ->
        awaitTag("session-tasks")
        page("tasks-card", steps = 6, from = "session-tasks:line", within = "session-tasks")
        activate("tasks-card", "session-tasks:line", "Tasks")
        awaitTag("session-tasks:list")
        log("double tap on the Tasks line -> its rows opened")
        page("tasks-card-open", steps = 6, from = "session-tasks:line", within = "session-tasks")
        val since = activate("tasks-card-open", "created-task:${ids.string("task")}", "A12 watched task")
        compose.waitUntil(15_000) { journal().any { it.string("method") == "GET" && it.string("path").startsWith("/api/tasks/${ids.string("task")}") } }
        readBack("tasks-card-open", "double tap on the task's row -> the task's page opened over the session (GET /api/tasks/…)", since)
        back()
        awaitTag("session-tasks")
    }

    // MARK: the lazy-list control

    /**
     * Control for the open finding that TalkBack's swipes stop at the last row on screen of the entry and document pages:
     * the app's content replaced by lists of 40 rows — bare, under Scaffold + TopAppBar as MainActivity has it, inside a
     * PullToRefreshBox as the Wiki pages have it, with the rows grouped in card items, and after one item taller than the
     * screen. On each: TalkBack's focus on row 0, then up to 25 swipes right; the rows it reached and the list's first
     * visible row before and after. Recorded in talkback-control.txt, not asserted.
     */
    @Test fun lazyListControl() {
        report.setLength(0); problems.clear(); notes.clear(); recorded = false
        instrument.sendStatus(0, Bundle().apply { putString("a12_pid", Process.myPid().toString()) })
        try {
            ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use { scenario ->
                try {
                    talkBackIsOn()
                    listOf("plain", "scaffold", "pull-to-refresh", "cards", "tall-item").forEach { variant ->
                        val state = LazyListState()
                        scenario.onActivity { it.setContent { OrbitTheme { ControlList(variant, state) } } }
                        compose.waitForIdle(); SystemClock.sleep(1_000)
                        val before = state.firstVisibleItemIndex
                        val stops = traverse("control-$variant", 25, rectOf("control-row:0"), null, false)
                        val rows = stops.mapNotNull { Regex("Row (\\d+)").find(it)?.groupValues?.get(1)?.toInt() }
                        log("CONTROL $variant: rows reached ${rows.distinct()}, furthest row ${rows.maxOrNull()}; " +
                            "first visible row before ${before}, after ${state.firstVisibleItemIndex}")
                    }
                } catch (error: Throwable) {
                    File(output, "talkback-control-failure.txt").writeText(error.stackTraceToString())
                    runCatching { capture("talkback-control-failed") }
                    throw error
                } finally { File(output, "talkback-control.txt").writeText(report.toString()) }
            }
        } finally { console?.close(); console = null }
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    private fun ControlList(variant: String, state: LazyListState) {
        val row = @Composable { i: Int -> Text("Row $i", Modifier.fillMaxWidth().padding(16.dp).testTag("control-row:$i")) }
        when (variant) {
            "plain" -> LazyColumn(Modifier.fillMaxSize(), state) { items(40) { row(it) } }
            "scaffold" -> ControlScaffold { padding -> LazyColumn(Modifier.padding(padding).fillMaxSize(), state) { items(40) { row(it) } } }
            "pull-to-refresh" -> ControlScaffold { padding ->
                PullToRefreshBox(isRefreshing = false, onRefresh = {}, modifier = Modifier.padding(padding).fillMaxSize()) {
                    LazyColumn(Modifier.fillMaxSize(), state) { items(40) { row(it) } }
                }
            }
            // Five rows to an item, as the entry page's cards hold their rows.
            "cards" -> ControlScaffold { padding -> LazyColumn(Modifier.padding(padding).fillMaxSize(), state) {
                items(8) { card -> Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) { repeat(5) { row(card * 5 + it) } } }
            } }
            // Row 1 is taller than the screen, as the document's first paragraph is.
            else -> ControlScaffold { padding -> LazyColumn(Modifier.padding(padding).fillMaxSize(), state) {
                item { row(0) }
                item { Text("Row 1 " + "with words that go on and on ".repeat(120), Modifier.fillMaxWidth().padding(16.dp)) }
                items(38) { row(it + 2) }
            } }
        }
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    private fun ControlScaffold(content: @Composable (PaddingValues) -> Unit) {
        Scaffold(topBar = {
            TopAppBar(title = { Text("Control") }, navigationIcon = { IconButton(onClick = {}) { Icon(painterResource(R.drawable.ic_back), "Back") } },
                actions = { IconButton(onClick = {}) { Icon(painterResource(R.drawable.ic_menu), "Open navigation") } })
        }) { padding -> content(padding) }
    }

    // MARK: the fixture

    private fun http(path: String, body: String? = null): JsonObject = (URL(server + path).openConnection() as HttpURLConnection).run {
        connectTimeout = 5_000; readTimeout = 5_000
        if (body != null) { requestMethod = "POST"; doOutput = true; outputStream.use { it.write(body.toByteArray()) } }
        try { check(responseCode == 200); Wire.json.parseToJsonElement(inputStream.bufferedReader().use { it.readText() }).jsonObject }
        finally { disconnect() }
    }
    private fun JsonObject.string(key: String) = getValue(key).jsonPrimitive.content
    private fun journal(): List<JsonObject> = http("/__stats").getValue("journal").jsonArray.map { it.jsonObject }
    private fun requests(method: String, suffix: String) = journal().filter { it.string("method") == method && it.string("path").substringBefore('?').endsWith(suffix) }
    private fun spaceSettings() = http("/__stats").getValue("space").jsonObject.getValue("settings").jsonObject
    private fun awaitTag(tag: String, timeout: Long = 20_000) {
        compose.waitUntil(timeout) { compose.onAllNodes(hasTestTag(tag)).fetchSemanticsNodes().isNotEmpty() }
    }
    private fun launch(raw: String) = Intent(Intent.ACTION_VIEW, Uri.parse(raw), app, MainActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)

    /** A cold start from [target]'s link with TalkBack on, then [block]. The report, the problems and the journal are kept
     * whatever happens; the problems fail the journey once its Activity is gone. */
    private fun journey(name: String, target: (JsonObject) -> String, block: (JsonObject) -> Unit) {
        http("/__control", """{"reset":true}""")
        val ids = http("/__ids")
        instrument.sendStatus(0, Bundle().apply { putString("a12_pid", Process.myPid().toString()) })
        File(output, "talkback-$name-identity.txt").writeText("sha=${BuildConfig.SOURCE_SHA}\ndirty=${BuildConfig.SOURCE_DIRTY}\nfixture=loopback-18770\n" +
            "link=${target(ids)}\nlogin=before-launch\nscreen_reader=TalkBack\n")
        report.setLength(0); problems.clear(); notes.clear(); recorded = false
        runBlocking { app.session.restore(); app.session.logout() }
        assertTrue(app.session.state.value is AuthState.SignedOut)
        runBlocking { app.session.login(ServerAddress.parse(server, true), "a12@example.test", "a12-fixture-password") }
        try {
            ActivityScenario.launch<MainActivity>(launch(target(ids))).use {
                try {
                    compose.waitUntil(20_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
                    talkBackIsOn()
                    block(ids)
                    if (!recorded) notes += "speech: no utterance was recorded (the speech engine is not the recorder); the words are the nodes'"
                } catch (error: Throwable) {
                    // Written down first: a crash while the scenario closes would otherwise lose what failed.
                    File(output, "talkback-$name-failure.txt").writeText(error.stackTraceToString())
                    Log.e("A12", "TalkBack journey $name failed", error)
                    runCatching { capture("talkback-$name-failed") }
                    throw error
                } finally {
                    File(output, "talkback-$name.txt").writeText(report.toString())
                    File(output, "talkback-$name-problems.txt").writeText(problems.joinToString("\n"))
                    File(output, "talkback-$name-notes.txt").writeText(notes.joinToString("\n"))
                }
            }
        } finally {
            console?.close(); console = null
            File(output, "talkback-$name-journal.json").writeText(http("/__stats").toString())
            runBlocking { app.session.logout() }
        }
        assertTrue("TalkBack problems on $name: $problems", problems.isEmpty())
        File(output, "talkback-$name-result.txt").writeText("PASS · TalkBack on the emulator, controlled HTTP only\n")
    }

    /** TalkBack running (the device script turned it on), and the app's window in front of anything it opened. */
    private fun talkBackIsOn() {
        val manager = app.getSystemService(AccessibilityManager::class.java)
        automation
        val until = SystemClock.uptimeMillis() + 30_000
        while (!manager.isTouchExplorationEnabled && SystemClock.uptimeMillis() < until) SystemClock.sleep(250)
        val services = manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK).map { it.id }
        log("talkback touch_exploration=${manager.isTouchExplorationEnabled} services=$services " +
            "speech_engine=${shell("settings get secure tts_default_synth").trim()}")
        assertTrue("TalkBack must be running: run the device script with A12_TALKBACK=1 ($services)", manager.isTouchExplorationEnabled)
        val front = SystemClock.uptimeMillis() + 10_000
        while (automation.rootInActiveWindow?.packageName?.toString() != app.packageName && SystemClock.uptimeMillis() < front) SystemClock.sleep(250)
        val active = automation.rootInActiveWindow?.packageName?.toString()
        if (active != app.packageName) { capture("talkback-covered"); fail("$active is over the app") }
    }

    // MARK: TalkBack on a page

    /** One page: what TalkBack can reach on screen, then its swipe-right order from [from] (a tag), else from the page's
     * first item. [within] (a tag) limits what is judged to that part of the screen. */
    private fun page(page: String, steps: Int, from: String? = null, within: String? = null, fromTop: Boolean = false) {
        compose.waitForIdle(); SystemClock.sleep(800)
        audit(page, within?.let(::rectOf))
        traverse(page, steps, from?.let(::place), within, fromTop)
    }

    /** Every node on the app's top window that TalkBack can reach, with the words it has for it. */
    private fun audit(page: String, within: Rect?) {
        val root = appRoot() ?: run { problem("$page: no window of the app to read", ""); return }
        val window = bounds(root)
        report.appendLine("## $page — what TalkBack can reach on screen")
        fun walk(node: AccessibilityNodeInfo, depth: Int, labelled: Boolean) {
            if (!node.isVisibleToUser) return
            val at = bounds(node)
            val press = node.isClickable || node.isCheckable
            val said = if (press) spoken(node) else words(node).joinToString(" | ")
            val shown = press || said.isNotEmpty()
            if (shown) report.appendLine("  ".repeat(depth + 1) + "${kind(node)} \"$said\"" + flags(node))
            if (within == null || Rect.intersects(within, at)) {
                // A row the window's edge cuts keeps its words below the edge, out of the tree until TalkBack scrolls to it.
                val cut = at.bottom >= window.bottom || at.top <= window.top
                if (press && said.isEmpty() && !cut) problem("$page: TalkBack has no words for a ${kind(node)}", "at $at")
                // A label on an ancestor is what TalkBack reads instead of the words under it.
                if (!labelled) own(node).filter(::bare).forEach { problem("$page: TalkBack reads \"$it\" on its own", "${kind(node)} at $at") }
                // A heading whose words sit on its children: TalkBack stops on each child, and never says "heading".
                if (node.isHeading && said.isEmpty() && !press && !node.isScreenReaderFocusable) problem("$page: TalkBack never announces the heading " +
                    "\"${nodes(node).drop(1).flatMap(::words).joinToString(" ")}\"", "its words are its children's, read one by one")
            }
            val label = !node.contentDescription.isNullOrBlank()
            // Indented under what was listed above it, not by the layout's nesting.
            for (i in 0 until node.childCount) node.getChild(i)?.let { walk(it, if (shown) depth + 1 else depth, labelled || label) }
        }
        walk(root, 0, false)
    }

    /** TalkBack's own order: a finger on [start] (else the window's first item), then swipe right after swipe right, with
     * what it stops on, what it has for each and what it spoke. */
    private fun traverse(page: String, steps: Int, start: Rect?, within: String?, fromTop: Boolean): List<String> {
        val root = appRoot() ?: return emptyList()
        val window = bounds(root)
        val candidates = nodes(root).filter { it.isVisibleToUser && (it.isClickable || words(it).isNotEmpty()) && bounds(it) != window }
        // A sheet from its top (its handle), a page from its first item in the tree.
        val first = start ?: (if (fromTop) candidates.minByOrNull { bounds(it).top } else candidates.firstOrNull())
            ?.let(::bounds) ?: run { problem("$page: nothing on screen for TalkBack", ""); return emptyList() }
        report.appendLine("## $page — TalkBack, swipe right after swipe right (\"said\" is what the speech engine was given)")
        var since = System.currentTimeMillis()
        tap(first.exactCenterX(), first.exactCenterY())
        var node = settle(first)
        var said = heard(since)
        report.appendLine("  0 ${node?.let(::describe) ?: "(no focus)"} (touched)${line(said)}")
        node?.let { judge(page, it, within, said) }
        val stops = listOfNotNull(node?.let(::spoken)).toMutableList()
        capture("talkback-$page")
        val seen = mutableListOf(node?.let(::key))
        var unmoved = 0
        for (step in 1..steps) {
            since = System.currentTimeMillis()
            swipeRight()
            SystemClock.sleep(900)
            node = moved(seen.last())
            said = heard(since)
            if (node == null || node.packageName?.toString() != app.packageName) {
                report.appendLine("  (TalkBack's focus left the app: ${node?.packageName})${line(said)}"); break
            }
            val key = key(node)
            // One swipe TalkBack let go by is not the end: the end is two in a row that leave its focus where it was.
            if (key == seen.last()) {
                if (++unmoved < 2) { report.appendLine("  (the focus stayed; swiped again)${line(said)}"); continue }
                report.appendLine("  (the last item: the focus stays)${line(said)}"); break
            }
            unmoved = 0
            if (key in seen) { report.appendLine("  (back to an earlier item: ${describe(node)})${line(said)}"); break }
            seen += key; stops += spoken(node)
            report.appendLine("  $step ${describe(node)}${line(said)}")
            judge(page, node, within, said)
            if (step == steps) report.appendLine("  (stopped after $steps swipes)")
        }
        if (within == null && seen.size < 3) problem("$page: TalkBack's swipes reached ${seen.size} item(s)", "")
        return stops
    }

    /** What a stop says, judged: a press needs words, and no part of them — as the node has them, or as TalkBack [said]
     * them — may be a symbol alone. */
    private fun judge(page: String, node: AccessibilityNodeInfo, within: String?, said: List<String>) {
        if (within != null && !Rect.intersects(rectOf(within), bounds(node))) return
        val parts = spokenParts(node)
        if ((node.isClickable || node.isCheckable) && parts.isEmpty()) problem("$page: TalkBack has no words for a ${kind(node)}", "at ${bounds(node)}")
        (parts + said).filter(::bare).forEach { problem("$page: TalkBack reads \"$it\" on its own", describe(node)) }
        // A label or a state repeating the words under it: TalkBack says them twice.
        (twice(parts) + twice(said.filter { it in parts })).forEach { problem("$page: TalkBack reads \"$it\" twice", describe(node)) }
        parts.forEach { part -> symbols(part).takeIf { it.isNotEmpty() }?.let { notes += "$page: \"$part\" carries ${it.joinToString(" ")}" } }
    }

    /** TalkBack's focus put on [tag] by a touch on it (explore by touch); it must land there, with [words] in what it reads. */
    private fun touch(page: String, tag: String, words: String?): Pair<AccessibilityNodeInfo, Rect>? {
        val at = place(tag)
        val since = System.currentTimeMillis()
        tap(at.exactCenterX(), at.exactCenterY())
        var focus = settle(at)
        // Now and then TalkBack lets a touch go by (it said nothing and its focus stayed): touched again, as a person would.
        if (!landed(focus, at)) {
            report.appendLine("touch $tag: TalkBack's focus stayed on ${focus?.let(::describe) ?: "nothing"}; touched again")
            tap(at.exactCenterX(), at.exactCenterY())
            focus = settle(at)
        }
        val spoken = focus?.let(::spoken).orEmpty()
        val said = heard(since)
        report.appendLine("touch $tag -> ${focus?.let(::describe) ?: "(no focus)"}${line(said)}")
        if (focus == null || !landed(focus, at)) { problem("$page: a touch on $tag does not put TalkBack's focus on it", "focus on \"$spoken\""); return null }
        if (words != null && !spoken.contains(words, ignoreCase = true)) problem("$page: TalkBack reads $tag without \"$words\"", "it reads \"$spoken\"")
        judge(page, focus, null, said)
        return focus to at
    }

    /** [tag] focused by a touch and photographed with TalkBack's box, then TalkBack's double tap; the caller checks what it
     * did. Returns when the double tap was, for what TalkBack said after it. */
    private fun activate(page: String, tag: String, words: String?): Long {
        val (_, at) = touch(page, tag, words) ?: throw AssertionError("$page: TalkBack's focus is not on $tag, so a double tap would press something else")
        capture("talkback-$page-" + tag.replace(Regex("[^A-Za-z0-9]+"), "-").take(48))
        val since = System.currentTimeMillis()
        doubleTap(at.exactCenterX(), at.exactCenterY())
        report.appendLine("double tap $tag")
        return since
    }

    /** What TalkBack's focus is on after a double tap's effect, and what it said since [since]. */
    private fun readBack(page: String, what: String, since: Long) {
        compose.waitForIdle(); SystemClock.sleep(1_000)
        val said = heard(since)
        report.appendLine("$what; TalkBack's focus now: ${focused()?.let(::describe) ?: "(none)"}${line(said)}")
        said.filter(::bare).forEach { problem("$page: TalkBack reads \"$it\" on its own", "after a double tap") }
    }

    /** [tag] on screen, in the middle of its list when it is in one (scrolled there by its semantics, as a finger would
     * scroll — near the bottom the system's gesture bar takes the touch), and where it is on the screen. */
    private fun place(tag: String): Rect {
        if (compose.onAllNodes(hasTestTag(tag)).fetchSemanticsNodes().isEmpty()) {
            val lists = compose.onAllNodes(hasScrollToNodeAction())
            lists.fetchSemanticsNodes().indices.reversed().firstOrNull { runCatching { lists[it].performScrollToNode(hasTestTag(tag)) }.isSuccess }
        }
        awaitTag(tag)
        val node = compose.onAllNodes(hasTestTag(tag)).onFirst()
        runCatching { node.performScrollTo() }
        val scrollers = compose.onAllNodes(hasScrollAction() and hasAnyDescendant(hasTestTag(tag)))
        val count = scrollers.fetchSemanticsNodes().size
        if (count > 0) runCatching {
            val list = scrollers[count - 1]
            val middle = list.fetchSemanticsNode().boundsInRoot.center.y
            list.performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, node.fetchSemanticsNode().boundsInRoot.center.y - middle) }
        }
        compose.waitForIdle(); SystemClock.sleep(500)
        return rectOf(tag)
    }

    private fun rectOf(tag: String): Rect = compose.onAllNodes(hasTestTag(tag)).onFirst().fetchSemanticsNode().let { node ->
        val at = node.positionOnScreen
        Rect(at.x.roundToInt(), at.y.roundToInt(), (at.x + node.size.width).roundToInt(), (at.y + node.size.height).roundToInt())
    }

    private fun log(line: String) { report.appendLine(line) }
    private fun problem(what: String, where: String) { problems += what; report.appendLine("PROBLEM $what${if (where.isEmpty()) "" else " — $where"}") }
    private fun back() { instrument.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK); compose.waitForIdle() }

    // MARK: what TalkBack has for a node

    private fun words(node: AccessibilityNodeInfo) = listOfNotNull(node.contentDescription, node.text, node.stateDescription)
        .map { it.toString().trim() }.filter { it.isNotEmpty() }
    /** What TalkBack reads on a node it stops on, part by part: its label in place of its text when it has one, its state,
     * then the words of the children it does not stop on itself (Compose keeps a row's words on its children; a child
     * that merges its own, as selectable text does, is a stop of its own). */
    private fun spokenParts(node: AccessibilityNodeInfo): List<String> {
        val label = node.contentDescription?.toString()?.trim().orEmpty()
        val own = listOf(label.ifEmpty { node.text?.toString()?.trim().orEmpty() }, node.stateDescription?.toString()?.trim().orEmpty())
        val children = if (label.isNotEmpty()) emptyList()
            else (0 until node.childCount).mapNotNull(node::getChild)
                .filterNot { it.isClickable || it.isCheckable || it.isScreenReaderFocusable }.flatMap(::spokenParts)
        return (own + children).filter { it.isNotEmpty() }
    }
    private fun spoken(node: AccessibilityNodeInfo) = spokenParts(node).joinToString(", ")
    /** What TalkBack reads of a node itself: its label in place of its text, and its state. */
    private fun own(node: AccessibilityNodeInfo) = listOf((node.contentDescription?.takeIf { it.isNotBlank() } ?: node.text)?.toString()?.trim().orEmpty(),
        node.stateDescription?.toString()?.trim().orEmpty()).filter { it.isNotEmpty() }
    private fun twice(parts: List<String>) = parts.filter { part -> part.any(Char::isLetter) }.groupingBy { it.lowercase() }.eachCount()
        .filterValues { it > 1 }.keys
    /** A part TalkBack says as a symbol's name ("bullet", "single right-pointing angle quotation mark"). */
    private fun bare(part: String) = part.none(Char::isLetterOrDigit)
    /** The symbols inside words that a voice may name aloud: arrows, ticks, triangles, bullets, emoji. */
    private fun symbols(part: String): List<String> = part.codePoints().toArray().filter { cp ->
        val type = Character.getType(cp)
        type == Character.OTHER_SYMBOL.toInt() || type == Character.MATH_SYMBOL.toInt() || cp == '›'.code || cp == '•'.code
    }.distinct().map { String(Character.toChars(it)) }
    private fun kind(node: AccessibilityNodeInfo) = node.className?.toString()?.substringAfterLast('.') ?: "node"
    /** API 36 deprecates the boolean for a tri-state the older devices this runs on do not have. */
    @Suppress("DEPRECATION") private fun checked(node: AccessibilityNodeInfo) = node.isChecked
    private fun flags(node: AccessibilityNodeInfo) = listOfNotNull("heading".takeIf { node.isHeading },
        "double tap to activate".takeIf { node.isClickable }, (if (checked(node)) "checked" else "not checked").takeIf { node.isCheckable },
        "disabled".takeIf { !node.isEnabled }).joinToString("") { " · $it" }
    private fun describe(node: AccessibilityNodeInfo) = "${kind(node)} \"${spoken(node)}\"${flags(node)}"
    /** A stop as the swipes tell one from the next: what it is, what it says and where (two counts reading "1" are two). */
    private fun key(node: AccessibilityNodeInfo) = "${kind(node)} ${spoken(node)} ${bounds(node)}"
    private fun bounds(node: AccessibilityNodeInfo) = Rect().also(node::getBoundsInScreen)
    private fun nodes(root: AccessibilityNodeInfo): Sequence<AccessibilityNodeInfo> =
        sequenceOf(root) + (0 until root.childCount).asSequence().mapNotNull(root::getChild).flatMap(::nodes)
    private fun landed(focus: AccessibilityNodeInfo?, at: Rect) =
        focus != null && focus.packageName?.toString() == app.packageName && bounds(focus).let { it.contains(at.centerX(), at.centerY()) && at.contains(it.centerX(), it.centerY()) }

    /** What TalkBack gave the speech engine since [since], utterance by utterance (the recorder's lines). An item's hint
     * can come after the next gesture, and is then listed with the next item. */
    private fun heard(since: Long): List<String> {
        val time = "${since / 1000}.${(since % 1000).toString().padStart(3, '0')}"
        val said = shell("logcat -d -v raw -s ${TalkBackSpeechRecorder.TAG}:I -T $time").lines().map(String::trim)
            .filter { it.isNotEmpty() && !it.startsWith("--------- beginning of") }
        if (said.isNotEmpty()) recorded = true
        return said
    }
    private fun line(said: List<String>) = if (said.isEmpty()) "" else "\n      said: " + said.joinToString(" | ") { "“$it”" }

    // MARK: TalkBack's side of the device

    /** The UiAutomation every call here uses: the default one would switch TalkBack off while it is connected. */
    private val automation: UiAutomation get() = instrument.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES).also {
        val info = it.serviceInfo
        if (info.flags and AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS == 0)
            it.serviceInfo = info.apply { flags = flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS }
    }
    /** The app's top window (a sheet or a dialog over the page, else the page), read afresh: a page that changed under a
     * cached tree would be read as it was. */
    private fun appRoot(): AccessibilityNodeInfo? {
        automation.clearCache()
        return automation.windows.mapNotNull { it.root }.firstOrNull { it.packageName?.toString() == app.packageName } ?: automation.rootInActiveWindow
    }
    /** Where TalkBack's focus is, in whichever window. */
    private fun focused(): AccessibilityNodeInfo? { automation.clearCache(); return automation.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY) }
    /** TalkBack's focus once it reached [at]: it moves a moment after a touch ends (it first waits for a second tap). */
    private fun settle(at: Rect): AccessibilityNodeInfo? {
        val until = SystemClock.uptimeMillis() + 3_000
        var focus = focused()
        while (!landed(focus, at) && SystemClock.uptimeMillis() < until) { SystemClock.sleep(200); focus = focused() }
        return focus
    }
    /** TalkBack's focus once it left [from] — a list may scroll first — or where it stayed. */
    private fun moved(from: String?): AccessibilityNodeInfo? {
        val until = SystemClock.uptimeMillis() + 2_000
        var node = focused()
        while (node != null && key(node) == from && SystemClock.uptimeMillis() < until) { SystemClock.sleep(200); node = focused() }
        return node
    }
    private fun shell(command: String): String = automation.executeShellCommand(command).let { fd ->
        ParcelFileDescriptor.AutoCloseInputStream(fd).bufferedReader().use { it.readText() }
    }
    private fun capture(name: String) {
        // Let the frame on screen catch up with the tree just read; a sheet or a dialog is a second root.
        compose.waitForIdle(); SystemClock.sleep(500)
        val roots = compose.onAllNodes(isRoot())
        File(output, "$name-semantics.txt").writeText((0 until roots.fetchSemanticsNodes().size).joinToString("\n\n") { roots[it].printToString() })
        // A starved device can answer null: asked again, and a capture still without one says so beside its tree.
        val bitmap = (1..3).firstNotNullOfOrNull { attempt -> automation.takeScreenshot() ?: null.also { SystemClock.sleep(1_000L * attempt) } }
        if (bitmap == null) { File(output, "$name-screenshot-missing.txt").writeText("takeScreenshot returned null 3 times\n"); return }
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
    }

    /**
     * Fingers from the emulator's console: `event mouse <x> <y> 0 <buttons>` is the emulated touchscreen itself (from inside
     * the emulator the host's loopback is 10.0.2.2), so TalkBack takes them as a finger's. The device script passes the
     * console's port and token for this check only; the token is never written anywhere.
     */
    private class Console(port: Int, token: String) {
        private val socket = java.net.Socket("10.0.2.2", port).apply { soTimeout = 5_000; tcpNoDelay = true }
        private val reader = socket.getInputStream().bufferedReader()
        private val writer = socket.getOutputStream().bufferedWriter()
        init { answer(); send("auth $token") }
        fun send(command: String) { writer.write("$command\n"); writer.flush(); answer() }
        private fun answer() {
            while (true) {
                val line = reader.readLine() ?: error("the emulator console closed")
                if (line.startsWith("OK")) return
                if (line.startsWith("KO")) error("the emulator console refused: $line")
            }
        }
        fun close() { runCatching { writer.write("quit\n"); writer.flush() }; runCatching { socket.close() } }
    }
    private var console: Console? = null
    private fun finger(x: Int, y: Int, down: Boolean) {
        val open = console ?: InstrumentationRegistry.getArguments().let { args ->
            Console(args.getString("a12ConsolePort")?.toIntOrNull() ?: error("TalkBack takes touches from the screen only: the device script passes a12ConsolePort"),
                args.getString("a12ConsoleToken") ?: error("the device script passes a12ConsoleToken"))
        }.also { console = it }
        open.send("event mouse $x $y 0 ${if (down) 1 else 0}")
    }
    /** One finger on [x], [y] (explore by touch): TalkBack's focus goes to what is there, which it reads. */
    private fun tap(x: Float, y: Float) { finger(x.roundToInt(), y.roundToInt(), true); SystemClock.sleep(40); finger(x.roundToInt(), y.roundToInt(), false) }
    /** Two taps inside the double-tap timeout: TalkBack activates the item its focus is on. */
    private fun doubleTap(x: Float, y: Float) { tap(x, y); SystemClock.sleep(80); tap(x, y); SystemClock.sleep(600) }
    /** One quick finger across the middle of the screen: TalkBack's "next item". */
    private fun swipeRight() {
        val metrics = app.resources.displayMetrics
        val y = metrics.heightPixels / 2; val from = metrics.widthPixels / 5; val to = metrics.widthPixels * 4 / 5
        finger(from, y, true)
        for (i in 1..10) { SystemClock.sleep(15); finger(from + (to - from) * i / 10, y, true) }
        finger(to, y, false)
    }
}
