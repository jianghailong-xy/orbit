package io.orbitd.android.increments

import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.SystemClock
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.navigation.ObjectId
import java.io.File
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.rules.TestName

/**
 * A15c's device journeys for the ledger rows that had only JVM tests: each class signs the production app in to its own controlled
 * HTTP fixture (an in-process MockWebServer on the device's loopback — not a deployment) that answers the server state the row needs,
 * then drives the real Activity and reads what it draws. Every check is logged (PASS/FAIL) in checks.log, every request the app made
 * is kept in requests.txt, and every step leaves a screenshot, under files/a15c/<class>/<test>.
 */
abstract class IncrementDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    @get:Rule val testName = TestName()
    protected val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    protected val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    protected val server = MockWebServer()
    /** Every request after the login, as `METHOD path?query` with the fixture's own spelling of each id. */
    protected val calls = CopyOnWriteArrayList<String>()
    /** Each write's path and body. */
    protected val bodies = CopyOnWriteArrayList<Pair<String, String>>()
    /** Every request with the uptime it arrived at, in milliseconds. */
    protected val timed = CopyOnWriteArrayList<Pair<Long, String>>()
    protected val evidence: File by lazy {
        File(app.filesDir, "a15c/${javaClass.simpleName}/${testName.methodName}").apply { deleteRecursively(); mkdirs() }
    }

    /** One request as the fixture reads it: [path] has no `/api/` prefix and spells each known id as [ids] do. */
    protected class Req(val method: String, val path: String, val query: Map<String, String>, val body: String) {
        val parts: List<String> get() = path.split('/')
        fun q(key: String) = query[key]
        override fun toString() = "$method $path" + if (query.isEmpty()) "" else "?" + query.entries.joinToString("&") { "${it.key}=${it.value}" }
    }

    /** The ids this class's fixture serves, each matched in whichever form (public id or UUID) the app sends it. */
    protected open val ids: List<String> = emptyList()
    /** This class's answers, before the defaults: a response, or null to fall through. */
    protected abstract fun answer(req: Req): MockResponse?
    /** What a session's event stream sends right after it opens (frames as `data: …` blocks), before it falls quiet. */
    protected open fun streamOpening(session: String, sinceSeq: Long): String = ""

    protected val workspace = "34A15cWorkspaceAlpha01"
    protected val runner = "34A15cRunnerFixture001"
    protected open fun workspaceJson() = """{"id":"$workspace","name":"Alpha","runnerId":"$runner","enabled":true,"position":0,
        "provider":"claude","model":"claude-opus-5-5","createdAt":"2026-10-01T01:00:00.000Z"}"""
    protected open fun runnerJson() = """{"id":"$runner","name":"Fixture runner","online":true,"status":"ONLINE","version":"0.1.262",
        "engines":[{"engine":"claude","installed":true,"auth":"yes"}],"modelCatalog":{"claude":[{"value":"claude-opus-5-5","label":"Opus 5.5"}]}}"""
    protected open fun userJson() = """{"id":"u1","email":"a15c@example.test","name":"A15c fixture"}"""
    /** The directory's rows for one view (open, completed, trash), or a project's when [project] is set. */
    protected open fun sessions(view: String, project: String?): String = "[]"

    @Before fun startFixture() {
        compose.waitUntil(15_000) { app.session.state.value !is AuthState.Restoring }
        if (app.session.state.value is AuthState.SignedIn) runBlocking { app.session.logout() }
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = try { route(request) } catch (failure: Throwable) {
                note("FIXTURE ${request.method} ${request.path}: $failure")
                MockResponse().setResponseCode(500).setBody("""{"message":"fixture failure"}""")
            }
        }
        server.start()
        note("fixture at ${server.url("/")}")
    }

    @After fun stopFixture() {
        runCatching { runBlocking { app.session.logout() } }
        runCatching { app.realtime.selectSession(null) }
        File(evidence, "requests.txt").writeText(calls.joinToString("\n") + "\n")
        File(evidence, "bodies.txt").writeText(bodies.joinToString("\n") { "${it.first} ${it.second}" } + "\n")
        File(evidence, "requests-timed.txt").writeText(timed.joinToString("\n") { "${it.first} ${it.second}" } + "\n")
        runCatching { server.shutdown() }
    }

    private fun route(request: RecordedRequest): MockResponse {
        val url = request.requestUrl!!
        val raw = url.encodedPath
        if (raw == "/api/auth/methods") return MockResponse().setResponseCode(404)
        val path = raw.removePrefix("/api/").split('/').joinToString("/") { part -> ids.firstOrNull { ObjectId.same(it, part) } ?: part }
        val query = url.queryParameterNames.associateWith { url.queryParameter(it).orEmpty() }
        val req = Req(request.method ?: "GET", path, query, request.body.readUtf8())
        if (path != "auth/login") {
            calls += req.toString()
            timed += SystemClock.uptimeMillis() to req.toString()
            if (req.method != "GET") bodies += "${req.method} $path" to req.body
        }
        answer(req)?.let { return it }
        if (path == "events") return stream("")
        if (req.parts.size == 3 && req.parts[0] == "sessions" && req.parts[2] == "events" && req.q("sinceSeq") != null)
            return stream(streamOpening(req.parts[1], req.q("sinceSeq")!!.toLong()))
        return when {
            path == "auth/login" -> json("""{"accessToken":"a15c-fixture-access","refreshToken":"a15c-fixture-refresh","user":${userJson()}}""")
            path == "auth/logout" -> json("{}")
            path == "users/me" -> json(userJson())
            path == "workspaces" -> json("[${workspaceJson()}]")
            path == "workspaces/$workspace" -> json(workspaceJson())
            path == "runners" -> json("[${runnerJson()}]")
            path == "runners/$runner" -> json(runnerJson())
            path == "sessions" && req.method == "GET" -> json(sessions(req.q("view") ?: "open", req.q("projectId")))
            path.startsWith("wiki") -> MockResponse().setResponseCode(404).setHeader("Content-Type", "application/json")
                .setBody("""{"code":"WIKI_DISABLED","message":"The wiki is off."}""")
            req.method == "GET" -> json("[]")
            else -> json("{}")
        }
    }

    protected fun json(body: String, code: Int = 200) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)
    protected fun empty200() = MockResponse().setResponseCode(200)

    /** An event stream that sends [opening] at once and then keepalive comments for ten minutes, as a quiet server holds one open:
     * the body is throttled to one period a second, and the first period is the opening whole. */
    protected fun stream(opening: String): MockResponse {
        val first = ": connected\n\n$opening".encodeToByteArray()
        val period = maxOf(first.size, 64).toLong()
        val quiet = ": a15c keepalive\n\n".encodeToByteArray()
        val body = Buffer().write(first)
        repeat(((600 * period + quiet.size - 1) / quiet.size).toInt()) { body.write(quiet) }
        return MockResponse().setHeader("Content-Type", "text/event-stream").setHeader("Cache-Control", "no-cache")
            .setBody(body).throttleBody(period, 1, TimeUnit.SECONDS)
    }

    /** One SSE frame of a run event. */
    protected fun frame(event: String) = "data: $event\n\n"

    // ---- The app. ----

    protected fun signIn() {
        runBlocking { app.session.login(ServerAddress.parse(server.url("/").toString(), true), "a15c@example.test", "a15c-fixture-password") }
        compose.waitUntil(30_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
        note("signed in to the fixture")
    }

    /** A link delivered to the running Activity as Android delivers one (singleTop: onNewIntent); the launch intent is put back. */
    protected fun open(link: String) {
        compose.activityRule.scenario.onActivity {
            val launch = it.intent
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                .invoke(it, Intent(Intent.ACTION_VIEW, Uri.parse(link)).setClass(it, MainActivity::class.java))
            it.intent = launch
        }
        settle()
    }

    /** Drops the app's network and gives it back as the OS callback would (same network identity): both streams stop and reopen, and
     * the session closes its gap over REST `after=` pages before its stream opens again. */
    protected fun reconnect() {
        val identity = app.getSystemService(android.net.ConnectivityManager::class.java)?.activeNetwork?.toString()
        app.realtime.setNetwork(false)
        await("the session's stream to stop") { app.realtime.state.value.session?.connection != io.orbitd.android.core.realtime.ConnectionState.CONNECTED }
        app.realtime.setNetwork(true, identity)
        note("network dropped and given back ($identity)")
    }

    /** Lets go of the focused field and hides the keyboard, as tapping outside it does: the phone's folded chrome comes back. */
    protected fun dropFocus() {
        compose.activityRule.scenario.onActivity { activity ->
            activity.currentFocus?.let { view ->
                activity.getSystemService(android.view.inputmethod.InputMethodManager::class.java)?.hideSoftInputFromWindow(view.windowToken, 0)
                view.clearFocus()
            }
        }
        settle()
    }

    protected fun connected() = app.realtime.state.value.session?.connection == io.orbitd.android.core.realtime.ConnectionState.CONNECTED

    protected fun back() {
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        settle()
    }

    protected fun exists(matcher: SemanticsMatcher, unmerged: Boolean = false) =
        compose.onAllNodes(matcher, useUnmergedTree = unmerged).fetchSemanticsNodes().isNotEmpty()
    protected fun count(matcher: SemanticsMatcher, unmerged: Boolean = false) =
        compose.onAllNodes(matcher, useUnmergedTree = unmerged).fetchSemanticsNodes().size

    /** Waits until [condition] holds, idling the UI on every look; a miss is logged and leaves a screenshot. */
    protected fun await(what: String, timeoutMs: Long = 30_000, condition: () -> Boolean) {
        try { compose.waitUntil(timeoutMs) { condition() } } catch (failure: Throwable) {
            note("FAIL waited for $what"); runCatching { capture("failed-${what.filter(Char::isLetterOrDigit).take(40)}") }; throw failure
        }
        note("PASS $what")
    }
    protected fun awaitTag(tag: String, timeoutMs: Long = 30_000) = await("tag $tag", timeoutMs) { exists(hasTestTag(tag), unmerged = true) }
    protected fun awaitText(text: String, substring: Boolean = false, timeoutMs: Long = 30_000) =
        await("text \"$text\"", timeoutMs) { exists(hasText(text, substring = substring), unmerged = true) }

    /** A check that is logged either way. */
    protected fun verify(what: String, holds: Boolean) {
        note((if (holds) "PASS " else "FAIL ") + what)
        if (!holds) runCatching { capture("failed-${what.filter(Char::isLetterOrDigit).take(40)}") }
        assertTrue(what, holds)
    }

    /** The words a node draws (its text, joined), read from the unmerged tree. */
    protected fun textOf(tag: String): String = compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().firstOrNull()
        ?.config?.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }.orEmpty()

    /** A node tagged [tag], or one inside it, says [text]. */
    protected fun says(tag: String, text: String, substring: Boolean = false) =
        exists((hasTestTag(tag) or hasAnyAncestor(hasTestTag(tag))) and hasText(text, substring = substring), unmerged = true)

    /** Scrolls the transcript to [matcher] as a reader does: a drag first, which stops the reader following its tail (a programmatic
     * scroll alone is pinned back to the tail by the next read). */
    protected fun scrollTranscriptTo(matcher: SemanticsMatcher) {
        compose.onNodeWithTag("transcript-list").performTouchInput { swipeDown() }
        compose.onNodeWithTag("transcript-list").performScrollToNode(matcher)
        settle()
    }

    protected fun settle() {
        compose.waitForIdle()
        instrumentation.waitForIdleSync()
        instrumentation.uiAutomation.waitForIdle(300, 5_000)
    }

    protected fun note(line: String) = File(evidence, "checks.log").appendText("${Instant.now()} $line\n")

    protected fun capture(name: String) {
        settle()
        SystemClock.sleep(700)
        var bitmap: Bitmap? = null
        repeat(3) { if (bitmap == null) bitmap = instrumentation.uiAutomation.takeScreenshot() ?: run { SystemClock.sleep(500); null } }
        val shot = bitmap ?: run { File(evidence, "$name.missing").writeText("takeScreenshot returned null 3 times\n"); return }
        File(evidence, "$name.png").outputStream().use { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }
        shot.recycle()
    }

    /** Runs a journey, keeping its failure and a last screenshot beside the evidence. */
    protected fun journey(body: () -> Unit) {
        instrumentation.sendStatus(0, android.os.Bundle().apply { putString("a15c_pid", android.os.Process.myPid().toString()) })
        try {
            body()
            File(evidence, "result.txt").writeText("PASS\n")
        } catch (failure: Throwable) {
            File(evidence, "failure.txt").writeText(failure.stackTraceToString())
            runCatching { capture("failure") }
            throw failure
        }
    }

    // ---- Shared fixture rows. ----

    protected fun ago(minutes: Long) = Instant.now().minusSeconds(minutes * 60).toString()

    /** One durable run event as the events page and the stream carry it. */
    protected fun event(seq: Int, type: String, payload: String, ts: String = ago(30L - seq.coerceAtMost(29)), turnId: String? = null) =
        """{"seq":$seq,"type":"$type","payload":$payload,"ts":"$ts"${turnId?.let { ",\"turnId\":\"$it\"" } ?: ""}}"""
    protected fun page(events: List<String>) = """{"events":${events.joinToString(",", "[", "]")},"hasMore":false}"""
    protected fun quote(text: String) = kotlinx.serialization.json.JsonPrimitive(text).toString()
}
