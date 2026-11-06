package io.orbitd.android.landingboard

import android.app.Instrumentation
import android.graphics.Bitmap
import android.os.Process
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.core.realtime.ConnectionState
import io.orbitd.android.navigation.ObjectId
import java.io.File
import java.net.InetAddress
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Frames for docs/mocks/android-cold-start-landing. Sample data only, at the owner's measured sizes (Open 858 rows, Completed
 * 6,242 rows, Trash 59, about 2.9 KB a row). Each test is its own `am instrument` call, so each is a new process over what the last
 * one left on the device: a real cold start, with the real cache and no compose test rule, so that spinners animate.
 * The server is an in-process MockWebServer on a fixed port; [gates] hold the Completed list, the slow one on a phone.
 */
@RunWith(AndroidJUnit4::class)
class LandingBoardShotsTest {
    private val instrumentation: Instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val ui get() = instrumentation.uiAutomation
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val build: String = InstrumentationRegistry.getArguments().getString("build") ?: "today"
    private val proto get() = build == "proto"
    private val out: File by lazy { File(app.filesDir, "landing-board").apply { mkdirs() } }
    private val server = MockWebServer()
    private val calls = CopyOnWriteArrayList<String>()
    private val log = CopyOnWriteArrayList<String>()
    private val started = SystemClock.uptimeMillis()
    private val watcher = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private lateinit var scenario: ActivityScenario<MainActivity>

    private val gates = List(4) { CountDownLatch(1) }
    private val completedReads = AtomicInteger()
    private val readLeft = CountDownLatch(1)
    @Volatile private var edition = "A"
    @Volatile private var failReads = false

    private fun note(line: String) { log += "${SystemClock.uptimeMillis() - started} $line"; android.util.Log.i("LandingBoard", line) }

    // ---- The walks. ----

    /** A device that has never read this account: what a first sign-in, and today's every launch, starts from. */
    @Test fun firstSignIn() = walk("first") {
        launch()
        signIn()
        await("the page says it is loading") { shows("Loading workspaces and sessions") }
        settle(); capture("first-1-loading")
        release(1)
        if (proto) {
            await("the workspace's list") { shows("Polish the pricing page") }
            await("fresh") { state().directoryFresh }
            settle(); capture("first-2-landed")
            assertEquals("one read", 1, completedReads.get())
            tap("Open navigation"); await("the drawer") { shows("Tasks") }
            settle(600); capture("first-3-drawer")
            tap("api-server"); await("api-server's list") { shows("Partition the jobs table") && !shows("Tasks") }
            settle(1500); capture("first-4-list")
            // Long enough for the record and the remembered workspace to reach the disk.
            settle(4000)
        } else {
            await("the name list") { shows("api-server") && state().directory != null }
            settle(); capture("first-2-two-lines")
            assertTrue("the owner's screenshot: loading over saved", shows("Loading workspaces and sessions") && shows("Showing saved sessions"))
            assertEquals("the stream is up", ConnectionState.CONNECTED, state().controlConnection)
            assertFalse("nothing came from the device", state().directoryCached)
            release(2)
            await("fresh") { state().directoryFresh }
            settle(); capture("first-3-names")
            note("completed reads before fresh: ${completedReads.get()}")
            tap("api-server"); await("api-server's list") { shows("Partition the jobs table") }
            settle(1500); capture("first-4-list")
        }
    }

    private fun saved(name: String, variant: String, withStrip: Boolean = false, shots: Int = 10, then: () -> Unit = {}) = walk("saved-$name") {
        edition = "B"
        instrumentation.runOnMainSync { status(variant) }
        val strip = if (withStrip) strip("saved") else null
        launch()
        if (strip != null) { settle(5000); strip.stopAfter(0); strip.stop() }
        await("the saved rows") { shows("Partition the jobs table") }
        assertTrue("the rows came from the device", state().directoryCached)
        assertFalse("nothing has landed", state().directoryFresh)
        then()
        settle(700); capture("saved-$name", shots)
        assertFalse("the read has not failed in this frame", state().directoryError != null)
        strip?.write()
    }
    @Test fun savedBar() = saved("bar", "bar", withStrip = true)
    @Test fun savedLine() = saved("line", "line")
    @Test fun savedSilent() = saved("silent", "silent")
    @Test fun savedTwoLines() = saved("twolines", "today")
    @Test fun savedCompleted() = saved("completed", "bar") { tap("Completed"); await("the Completed view") { shows("Loading completed sessions") } }
    @Test fun savedDrawer() = saved("drawer", "bar", shots = 1) { tap("Open navigation"); await("the drawer") { shows("Tasks") } }

    /** The next launch: what is left on the device, the read on the wire. */
    @Test fun relaunch() = walk("relaunch") {
        edition = "B"
        val strip = strip("relaunch")
        launch()
        if (proto) {
            settle(5000); strip.stopAfter(0); strip.stop()
            await("the saved rows") { shows("Partition the jobs table") }
            assertTrue("the rows came from the device", state().directoryCached)
            settle(800); capture("relaunch-1-saved-bar")
            strip.write()
            release(1)
            await("fresh") { state().directoryFresh }
            await("the server's new row") { shows("Upgrade the Postgres client") }
            settle(800); capture("relaunch-2-fresh")
            assertEquals("one read", 1, completedReads.get())
            tap("Open navigation"); await("the drawer") { shows("Tasks") }
            settle(600); capture("relaunch-3-drawer")
        } else {
            settle(5000); strip.stopAfter(0); strip.stop()
            await("the page says it is loading") { shows("Loading workspaces and sessions") }
            assertFalse("nothing came from the device", state().directoryCached)
            settle(500); capture("relaunch-1-loading")
            strip.write()
            release(1)
            await("the name list") { shows("api-server") && state().directory != null }
            settle(); capture("relaunch-2-two-lines")
            release(2)
            await("fresh") { state().directoryFresh }
            settle(); capture("relaunch-3-names")
            note("completed reads before fresh: ${completedReads.get()}")
        }
    }

    /** Back from the background with the list up: the stream reconnects and the directory is read again behind the rows. */
    @Test fun foreground() = walk("foreground") {
        edition = "B"
        repeat(if (proto) 1 else 2) { i -> release(i + 1) }
        launch()
        if (!proto) { await("the name list") { shows("api-server") && state().directoryFresh }; tap("api-server") }
        await("the list") { shows("Partition the jobs table") && state().directoryFresh }
        settle(1200); capture("foreground-1-before")
        launched()
        scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED)
        await("the background") { state().controlConnection == ConnectionState.STOPPED }
        settle(800)
        scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
        // moveToState parks the Activity under an empty one of the test framework's; the list is back once that has gone.
        // A row near the top: on today's build the two lines push the lower ones off the screen.
        await("the list back on screen") { shows("Add CSV export to the billing report") }
        await("the read behind the rows") { !state().directoryFresh && state().directoryRefreshing }
        settle(500); capture("foreground-2-reading")
        val before = if (proto) 1 else 2
        gates.forEach { it.countDown() }
        await("fresh again") { state().directoryFresh }
        settle(1500)
        note("reads on the launch: $before; reads on the return to the foreground: ${completedReads.get() - before}")
        assertTrue("reads counted", completedReads.get() > before)
    }

    /** No connection at launch. */
    @Test fun offline() = walk("offline") {
        app.realtime.setNetwork(false)
        launch()
        await("no connection") { state().controlConnection == ConnectionState.STOPPED && !state().directoryRefreshing }
        if (proto) await("the saved rows") { shows("Partition the jobs table") }
        else await("the page says so") { shows("Waiting for connection") }
        settle(800); capture("offline")
    }

    /** The server cannot be read, with the saved rows up. */
    @Test fun failed() = walk("failed") {
        failReads = true
        launch()
        await("the error") { shows("Couldn't load workspaces") }
        settle(800); capture("failed")
    }

    /** Cold start with nothing held, for the system's own launch lines (logcat ActivityTaskManager: Displayed / Fully drawn). */
    @Test fun timing() = walk("timing") {
        edition = "B"
        val before = SystemClock.uptimeMillis()
        launch()
        if (proto) await("the saved rows") { shows("Partition the jobs table") }
        else await("the page says it is loading") { shows("Loading workspaces and sessions") }
        note("launch to first look: ${SystemClock.uptimeMillis() - before} ms")
        settle(1500)
        gates.forEach { it.countDown() }
        await("fresh", 60_000) { state().directoryFresh }
        note("launch to fresh: ${SystemClock.uptimeMillis() - before} ms; completed reads ${completedReads.get()}")
    }

    // ---- The app. ----

    private fun walk(name: String, body: () -> Unit) {
        try { body() } catch (failure: Throwable) {
            note("FAILED: $failure"); runCatching { capture("failed-$name") }; throw failure
        } finally {
            failReads = true
            gates.forEach { it.countDown() }
            File(out, "$name-$build-log.txt").writeText(log.joinToString("\n") + "\n")
            File(out, "$name-$build-requests.txt").writeText(calls.joinToString("\n") + "\n")
        }
    }

    @Before fun fixture() {
        fillers
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = try { route(request) } catch (failure: Throwable) {
                note("FIXTURE ${request.path}: $failure"); MockResponse().setResponseCode(500).setBody("""{"message":"fixture failure"}""")
            }
        }
        server.start(InetAddress.getByName("localhost"), PORT)
        note("process started ${started - Process.getStartUptimeMillis()} ms before the test; fixture at ${server.url("/")}")
        watcher.launch {
            app.realtime.state.map { s ->
                val restored = runCatching { s.javaClass.getMethod("getDirectoryRestored").invoke(s) }.getOrNull()
                "state dir=${s.directory != null} restored=$restored cached=${s.directoryCached} fresh=${s.directoryFresh} refreshing=${s.directoryRefreshing} conn=${s.controlConnection} err=${s.directoryError != null}"
            }.distinctUntilChanged().collect { note(it) }
        }
    }
    @After fun stop() {
        runCatching { watcher.cancel() }
        runCatching { launcher?.join(30_000) }
        if (::scenario.isInitialized) runCatching { scenario.close() }
        runCatching { server.shutdown() }
    }

    /** ActivityScenario.launch waits for an idle main looper, which a running spinner does not give it for many seconds: as long as the
     * app gives a read. So it runs beside the walk; [launched] is for the steps that need the scenario itself. */
    private var launcher: Thread? = null
    private fun launch() { launcher = thread(name = "launch") { scenario = ActivityScenario.launch(MainActivity::class.java); note("activity launched") } }
    private fun launched() { launcher?.join() }
    private fun signIn() {
        val deadline = SystemClock.uptimeMillis() + 15_000
        while (app.session.state.value is AuthState.Restoring && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(50)
        assertTrue("a signed-out install", app.session.state.value is AuthState.SignedOut)
        runBlocking { app.session.login(ServerAddress.parse(server.url("/").toString(), true), "owner@example.test", "fixture") }
        note("signed in")
    }
    private fun state() = app.realtime.state.value
    private fun release(read: Int) { note("release read $read"); gates[read - 1].countDown() }
    private fun status(variant: String) {
        val type = Class.forName("io.orbitd.android.directory.LandingProto")
        type.getMethod("setStatus", String::class.java).invoke(type.getField("INSTANCE").get(null), variant)
    }
    private fun settle(ms: Long = 1000) = SystemClock.sleep(ms)

    /** Compose gives accessibility a tree to walk, not a text search. */
    private fun find(text: String): AccessibilityNodeInfo? {
        val root = ui.rootInActiveWindow ?: return null
        val queue = ArrayDeque(listOf(root))
        while (queue.isNotEmpty()) {
            val node = queue.removeFirst()
            if (node.text?.contains(text) == true || node.contentDescription?.contains(text) == true) return node
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::addLast)
        }
        return null
    }
    private fun shows(text: String) = runCatching { find(text) != null }.getOrDefault(false)
    private fun tap(text: String) {
        var node = find(text) ?: error("nothing says \"$text\"")
        while (!node.isClickable) node = node.parent ?: error("\"$text\" cannot be pressed")
        assertTrue("press \"$text\"", node.performAction(AccessibilityNodeInfo.ACTION_CLICK))
        note("pressed $text")
    }
    private fun await(what: String, timeoutMs: Long = 90_000, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (!condition()) {
            if (SystemClock.uptimeMillis() > deadline) error("waited for $what")
            SystemClock.sleep(150)
        }
        note("saw $what")
    }
    private fun shot(): Bitmap? { repeat(8) { ui.takeScreenshot()?.let { return it }; SystemClock.sleep(150) }; return null }
    /** A spinner is drawn at whatever point of its turn the shot falls on: of a few shots, keeps the one where its arc is longest. */
    private fun capture(name: String, shots: Int = 10) {
        val bitmap = (0 until shots).mapNotNull { shot().also { SystemClock.sleep(110) } }.maxByOrNull(::spinnerPixels) ?: error("no screenshot for $name")
        File(out, "$build-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        note("captured $name")
    }

    /** The theme's primary (0xFF8AC6FF, near enough) in the page's top: the labels in that colour hold still, so only the spinner moves the count. */
    private fun spinnerPixels(frame: Bitmap): Int {
        val config = if (frame.config == Bitmap.Config.HARDWARE) frame.copy(Bitmap.Config.ARGB_8888, false) else frame
        val width = config.width; val height = minOf(config.height, 760)
        val pixels = IntArray(width * height); config.getPixels(pixels, 0, width, 0, 0, width, height)
        return pixels.count { p ->
            val r = (p shr 16) and 255; val g = (p shr 8) and 255; val b = p and 255
            b > 200 && g > 150 && r in 100..190
        }
    }

    /** The first moments of a launch, frame by frame as fast as the device gives them, written out afterwards. */
    private inner class Strip(val name: String) {
        @Volatile private var until = Long.MAX_VALUE
        private val frames = mutableListOf<Pair<Long, Bitmap>>()
        private val runner = thread(name = "strip") {
            val zero = SystemClock.uptimeMillis()
            while (SystemClock.uptimeMillis() < until && SystemClock.uptimeMillis() - zero < 20_000) {
                val taken = SystemClock.uptimeMillis()
                ui.takeScreenshot()?.let { frames += (taken - zero) to Bitmap.createScaledBitmap(it, 270, 600, true) }
                SystemClock.sleep(80)
            }
        }
        fun stopAfter(ms: Long) { until = SystemClock.uptimeMillis() + ms }
        fun stop() = runner.join()
        fun write() {
            frames.forEachIndexed { i, (at, bitmap) ->
                File(out, "strip-$build-$name-${"%02d".format(i)}-${at}ms.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            }
            note("strip of ${frames.size} frames")
        }
    }
    private fun strip(name: String) = Strip(name)

    // ---- The fixture. ----

    private fun route(request: RecordedRequest): MockResponse {
        val url = request.requestUrl!!
        if (url.encodedPath == "/api/auth/methods") return MockResponse().setResponseCode(404)
        val path = url.encodedPath.removePrefix("/api/")
        val view = url.queryParameter("view")
        val line = "${request.method} $path" + (view?.let { "?view=$it" } ?: "")
        if (path != "auth/login") { calls += "${SystemClock.uptimeMillis() - started} $line"; note("request $line") }
        return when {
            path == "auth/login" -> json("""{"accessToken":"board-access","refreshToken":"board-refresh","user":$USER}""")
            path == "users/me" -> json(USER)
            path == "events" -> { if (!proto) readLeft.await(1, TimeUnit.SECONDS); stream() }
            path == "workspaces" -> json(WORKSPACES)
            path == "runners" -> json(RUNNERS)
            path == "session-folders" -> json(FOLDERS)
            path == "session-tags" -> json(TAGS)
            path == "sessions" && view == "open" -> json(open(edition))
            path == "sessions" && view == "trash" -> json(fillers.trash)
            path == "sessions" && view == "completed" -> {
                val read = completedReads.incrementAndGet()
                readLeft.countDown()
                note("completed read $read left")
                gates.getOrNull(read - 1)?.await(170, TimeUnit.SECONDS)
                if (failReads) MockResponse().setResponseCode(500).setBody("""{"message":"fixture failure"}""") else json(fillers.completed)
            }
            path.startsWith("wiki") -> MockResponse().setResponseCode(404).setHeader("Content-Type", "application/json")
                .setBody("""{"code":"WIKI_DISABLED","message":"The wiki is off."}""")
            request.method == "GET" -> json("[]")
            else -> json("{}")
        }
    }
    private fun json(body: String) = MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody(body)
    private fun stream(): MockResponse {
        val body = Buffer().writeUtf8(": connected\n\n")
        repeat(4_000) { body.writeUtf8(": keepalive\n\n") }
        return MockResponse().setHeader("Content-Type", "text/event-stream").setHeader("Cache-Control", "no-cache")
            .setBody(body).throttleBody(64, 1, TimeUnit.SECONDS)
    }

    private fun ago(minutes: Long) = Instant.now().minus(minutes, ChronoUnit.MINUTES).truncatedTo(ChronoUnit.SECONDS).toString()
    private fun row(id: String, title: String, workspace: String, state: String, recap: String, minutes: Long, lifecycle: String = "OPEN",
        approvals: Int = 0, jobs: Int = 0, folder: String? = null): String {
        val text = recap.replace("\"", "'")
        return """{"id":"$id","title":"$title","status":"$state","runState":"$state","lifecycleState":"$lifecycle","agentId":"$workspace",""" +
            (folder?.let { """"folderId":"$it",""" } ?: "") +
            """"createdAt":"${ago(minutes + 600)}","lastTurnAt":"${ago(minutes)}","pendingApprovals":$approvals,"runningBgJobCount":$jobs,"tags":[],""" +
            """"recapText":"$text","recapAt":"${ago(minutes)}","lastAssistantText":"$text"}"""
    }

    /** api-server's rows as the device saved them (A), and as the server has them by the next launch (B). */
    private fun landingRows(edition: String): List<String> {
        val b = edition == "B"
        return listOfNotNull(
            if (b) row(id("S", 20), "Upgrade the Postgres client", API, "RUNNING", "Started from your message 2 minutes ago; reading the changelog first.", 2) else null,
            row(id("S", 1), "Fix login redirect after token expiry", API, "AWAITING_INPUT", "Wants your OK to run the migration on staging before changing the redirect.", 8, approvals = 1),
            if (b) row(id("S", 2), "Add CSV export to the billing report", API, "AWAITING_INPUT", "The export is done and its 14 tests pass; ready for your review.", 4)
            else row(id("S", 2), "Add CSV export to the billing report", API, "RUNNING", "Writing the streaming export and its tests.", 31, jobs = 1),
            row(id("S", 3), "Partition the jobs table", API, "RUNNING", "Backfilling old rows in batches of 50,000; about a third done.", 12, jobs = 1),
            row(id("S", 4), "Flaky upload test on CI", API, "AWAITING_INPUT", "Traced the flake to a shared temp dir; the fix is on the branch.", 55),
            row(id("S", 5), "Review dependency updates", API, "AWAITING_INPUT", "Three minor bumps are safe; one needs a code change.", 140),
            row(id("S", 6), "Rate limit the public search endpoint", API, "AWAITING_INPUT", "Limit is in and load-tested at twice normal traffic.", 1500),
            row(id("S", 7), "Clean up unused feature flags", API, "AWAITING_INPUT", "Removed 9 flags; 2 are still read by the mobile client.", 1700),
            row(id("S", 8), "Add request IDs to the access log", API, "AWAITING_INPUT", "IDs now flow through the gateway and the workers.", 4400),
            row(id("S", 9), "Cut the 4.2 release branch", API, "AWAITING_INPUT", "Branch is cut; waiting on the changelog.", 300, folder = FOLDER_ID),
            row(id("S", 10), "Smoke test the staging deploy", API, "AWAITING_INPUT", "All checks passed on staging.", 320, folder = FOLDER_ID),
            row(id("S", 11), "Polish the pricing page", WEB, "AWAITING_INPUT", "New layout is up on the preview link; waiting for your notes.", 15),
            row(id("S", 12), "Fix the dark mode contrast on tables", WEB, "RUNNING", "Going through the table styles one by one.", 6),
            row(id("S", 13), "Add a cookie settings page", WEB, "AWAITING_INPUT", "Page and banner are in; the copy needs a look.", 44),
            row(id("S", 14), "Speed up the landing page", WEB, "AWAITING_INPUT", "Largest paint is down by a third after lazy loading the hero.", 150),
        )
    }
    private fun open(edition: String) = "[" + (landingRows(edition) + fillers.openRows).joinToString(",") + "]"

    private class Fillers(val openRows: List<String>, val completed: String, val trash: String)
    /** Row counts and sizes from the owner's account on 2026-11-02; the text is filler. */
    private val fillers: Fillers by lazy {
        val pad = "Sample session text standing in for a recap and a last reply, about as long as the real previews are. ".repeat(13)
        val others = NAMES.indices.drop(2).map { workspaceId(it) }
        fun rows(count: Int, lifecycle: String, prefix: String, state: (Int) -> String, approvals: (Int) -> Int) = List(count) { i ->
            row(id(prefix, i), "Sample session $i", others[i % others.size], state(i), "$i $pad", 200L + i, lifecycle = lifecycle, approvals = approvals(i))
        }
        Fillers(
            rows(858 - 11, "OPEN", "O", { if (it % 40 == 0) "RUNNING" else "AWAITING_INPUT" }, { if (it % 97 == 0) 1 else 0 }),
            "[" + rows(6242, "COMPLETED", "C", { "SUCCEEDED" }, { 0 }).joinToString(",") + "]",
            "[" + rows(59, "TRASH", "T", { "SUCCEEDED" }, { 0 }).joinToString(",") + "]",
        ).also { note("completed list ${it.completed.length} bytes; open fillers ${it.openRows.sumOf(String::length)} bytes") }
    }

    private companion object {
        const val PORT = 38917
        const val USER = """{"id":"u1","email":"owner@example.test","name":"Sample owner","preferences":{"theme":"dark"}}"""
        const val RUNNER = "34LandRunnerBuildBox1"
        const val FOLDER_ID = "34LandFolderRelease01"
        val NAMES = listOf("web-app", "api-server", "mobile-client", "data-pipeline", "infra", "docs-site", "design-system",
            "ml-training", "billing", "sandbox", "release-tools")
        fun id(prefix: String, n: Int) = "34Land$prefix${n.toString().padStart(9, '0')}"
        fun workspaceId(n: Int) = id("W", n)
        val WEB = workspaceId(0)
        val API = workspaceId(1)
        val WORKSPACES = "[" + NAMES.mapIndexed { i, name ->
            """{"id":"${workspaceId(i)}","name":"$name","runnerId":"$RUNNER","enabled":true,"position":$i,"provider":"claude","model":"claude-opus-5-5","createdAt":"2026-10-01T01:00:00.000Z"}"""
        }.joinToString(",") + "]"
        const val RUNNERS = """[{"id":"$RUNNER","name":"build-box","online":true,"status":"ONLINE","version":"0.1.262","engines":[{"engine":"claude","installed":true,"auth":"yes"}],"modelCatalog":{"claude":[{"value":"claude-opus-5-5","label":"Opus 5.5"}]}}]"""
        val FOLDERS = """[{"id":"$FOLDER_ID","workspaceId":"$API","name":"Release checklist"}]"""
        val TAGS = """[{"id":"${id("G", 1)}","name":"bug","position":0},{"id":"${id("G", 2)}","name":"refactor","position":1},{"id":"${id("G", 3)}","name":"urgent","position":2}]"""
    }
}
