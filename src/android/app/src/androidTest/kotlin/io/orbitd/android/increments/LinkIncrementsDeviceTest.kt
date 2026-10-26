package io.orbitd.android.increments

import android.app.Instrumentation
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.orbitd.android.MainActivity
import io.orbitd.android.navigation.ObjectId
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Deep links and the session list on a device (A01 DL-1, DL-6, DL-7's web link; A05-10, A05-11), over the test's own fixture: the
 * links are delivered as Android delivers them — an implicit VIEW intent that the manifest resolves, or a link tapped in a transcript —
 * and the session list is read from the fixture while it holds a reply back, or with the server's recap on its rows.
 */
@RunWith(AndroidJUnit4::class)
class LinkIncrementsDeviceTest : IncrementDeviceTest() {
    private val reading = "34A15cLinkReading00001"
    /** The shared orbit-link fixture's legacy session (src/shared/src/orbit-link.fixture.json, DL-6). */
    private val legacy = "34TYUP5wb87XfuYCInJRY"
    private val legacyUuid = "01a0cc01-771c-767d-846b-8fddfa669490"
    private val listed = "34A15cLinkListed000001"
    override val ids get() = listOf(workspace, runner, reading, legacy, listed)

    @Volatile private var readingEvents: List<String> = emptyList()
    @Volatile private var listedTitle = "Release notes"
    @Volatile private var recap: String? = null
    @Volatile private var preferences = "{}"
    /** While set, the next `GET sessions?view=open` is held until the latch opens, answering what it read when it arrived. */
    @Volatile private var hold: CountDownLatch? = null

    override fun userJson() = """{"id":"u1","email":"a15c@example.test","name":"A15c fixture","preferences":$preferences}"""
    private fun row(id: String, title: String, extra: String = "") = """{"id":"$id","title":${quote(title)},"status":"AWAITING_INPUT",
        "runState":"AWAITING_INPUT","lifecycleState":"OPEN","agent":{"id":"$workspace","name":"Alpha"},"agentId":"$workspace","workspaceId":"$workspace",
        "createdAt":"${ago(600)}","lastTurnAt":"${ago(5)}","pendingApprovals":0,"tags":[],"capabilities":{"canComplete":true,"canRestore":false}$extra}"""
    private fun listedRow(title: String) = row(listed, title, ""","lastAssistantText":"Committed the row change."""" +
        (recap?.let { ""","recapText":${quote(it)},"recapAt":"${ago(2)}"""" } ?: ""))
    override fun sessions(view: String, project: String?) =
        if (view == "open") "[${row(reading, "Reading links")},${listedRow(listedTitle)}]" else "[]"

    override fun answer(req: Req): MockResponse? {
        if (req.path == "sessions" && req.method == "GET" && req.q("view") == "open" && req.q("projectId") == null) {
            val latch = hold
            if (latch != null) {
                hold = null
                val captured = listedTitle
                note("held a session list read that saw “$captured”")
                latch.await(20, TimeUnit.SECONDS)
                return json("[${row(reading, "Reading links")},${listedRow(captured)}]")
            }
        }
        return when {
            req.path == "sessions/$reading" && req.method == "GET" -> json(row(reading, "Reading links"))
            req.path == "sessions/$reading/events/page" -> json(page(readingEvents))
            req.path == "sessions/$legacy" && req.method == "GET" -> json(row(legacy, "The legacy link's session"))
            req.path == "sessions/$legacy/events/page" -> json(page(listOf(event(1, "assistant", """{"text":"Opened from a legacy link."}"""))))
            req.path == "users/me/preferences" && req.method == "PATCH" -> {
                preferences = JsonObject(Json.parseToJsonElement(preferences).jsonObject + Json.parseToJsonElement(req.body).jsonObject).toString()
                json(userJson())
            }
            else -> null
        }
    }

    private fun onWorkspacesHome() = exists(hasTestTag("workspace:$workspace")) && !exists(hasTestTag("directory-list"))
    /** A link another app sends, as Android hands it to the running app: the manifest resolves it ([resolves]) and the singleTop
     * MainActivity receives it in onNewIntent ([open]). Delivered to the test's own Activity, so the run keeps one Activity. */
    private fun deliver(link: String) = open(link)
    private fun resolves(link: String) = app.packageManager.queryIntentActivities(
        Intent(Intent.ACTION_VIEW, Uri.parse(link)).addCategory(Intent.CATEGORY_BROWSABLE).setPackage(app.packageName), 0)
        .any { it.activityInfo.name == MainActivity::class.java.name }

    /** DL-1: `orbit://active`, from another app, opens the workspaces home — before sign-in it waits for it, and over a workspace it
     * is pushed with Back to return. */
    @Test fun orbitActiveOpensTheWorkspacesHome() = journey {
        verify("the manifest resolves orbit://active to the app", resolves("orbit://active"))
        deliver("orbit://active")
        signIn()
        await("signed in, the link lands on the workspaces home") { onWorkspacesHome() }
        capture("01-home-after-sign-in")
        compose.onNodeWithTag("workspace:$workspace").performClick()
        awaitTag("directory-list")
        capture("02-in-a-workspace")
        deliver("orbit://active")
        await("the workspaces home is opened over the workspace") { onWorkspacesHome() }
        capture("03-home-over-the-workspace")
        back()
        await("Back returns to the workspace") { exists(hasTestTag("directory-list")) }
        capture("04-back-to-the-workspace")
    }

    /** DL-1, its other half: a bare `orbit://` delivered to the app opens the workspaces home, as iOS's DeepLink does
     * (`case "active", ""`). From another app no filter takes it: the `orbit` filter names its hosts so `orbit://auth/google` is not
     * offered to MainActivity as well (the D1 merge's choice), which is recorded here, not asserted. */
    @Test fun aBareOrbitLinkOpensTheWorkspacesHome() = journey {
        signIn()
        awaitTag("workspace:$workspace")
        compose.onNodeWithTag("workspace:$workspace").performClick()
        awaitTag("directory-list")
        note("orbit:// resolves to the app from another app: ${resolves("orbit://")} (the manifest's orbit filter names hosts: active, session, task, list, runner, watch)")
        deliver("orbit://")
        val home = runCatching { compose.waitUntil(10_000) { onWorkspacesHome() }; true }.getOrDefault(false)
        capture("01-after-a-bare-link")
        verify("a bare orbit:// delivered to the app opens the workspaces home", home)
    }

    /** DL-6: the pre-1.0 web links to a session — /workspaces/<w>/sessions/<s> and /agents/<a>/sessions/<s> — tapped in a transcript,
     * open that session in the app, and Back returns. */
    @Test fun legacySessionUrlsOpenTheSession() = journey {
        val workspaces = server.url("/workspaces/orbit/sessions/$legacy").toString()
        val agents = server.url("/agents/orbit/sessions/$legacy").toString()
        readingEvents = listOf(event(1, "user", """{"text":"Where did the old link go?"}"""),
            event(2, "assistant", """{"text":${quote("The workspace link: $workspaces")}}"""),
            event(3, "assistant", """{"text":${quote("The agent link: $agents")}}"""))
        signIn()
        for ((seq, url) in listOf(2 to workspaces, 3 to agents)) {
            open("orbit-session:$reading")
            await("the reading session") { ObjectId.same(app.realtime.state.value.session?.id, reading) && exists(hasTestTag("event:$seq"), unmerged = true) }
            compose.onNode(hasText(url, substring = true) and hasAnyAncestor(hasTestTag("event:$seq")), useUnmergedTree = true).performFirstLinkClick()
            await("$url opens its session") { ObjectId.same(app.realtime.state.value.session?.id, legacyUuid) }
            awaitText("Opened from a legacy link.")
            capture("0$seq-opened-${if (seq == 2) "workspaces" else "agents"}-link")
            back()
            await("Back returns to the reading session") { ObjectId.same(app.realtime.state.value.session?.id, reading) }
        }
        verify("the session was read by its id", calls.any { it == "GET sessions/$legacy" })
    }

    /** DL-7: a wiki page's web address tapped in a transcript stays a web link — it goes to the browser, not into the app. */
    @Test fun aWikiWebLinkStaysAWebLink() = journey {
        val wiki = server.url("/wiki/orbit/e/34UDFnrgM4q5oGQloG3uq").toString()
        readingEvents = listOf(event(1, "user", """{"text":"Where is the principle?"}"""),
            event(2, "assistant", """{"text":${quote("It is here: $wiki")}}"""))
        val filter = IntentFilter(Intent.ACTION_VIEW).apply {
            addDataScheme("http"); addDataScheme("https"); addCategory(Intent.CATEGORY_BROWSABLE); addCategory(Intent.CATEGORY_DEFAULT)
        }
        val browser = Instrumentation.ActivityMonitor(filter, null, true)
        instrumentation.addMonitor(browser)
        try {
            signIn()
            open("orbit-session:$reading")
            await("the reading session") { exists(hasTestTag("event:2"), unmerged = true) }
            compose.onNode(hasText(wiki, substring = true) and hasAnyAncestor(hasTestTag("event:2")), useUnmergedTree = true).performFirstLinkClick()
            await("the link is handed to the browser") { browser.hits >= 1 }
            verify("the app stays on the session (no wiki page, no other session)", ObjectId.same(app.realtime.state.value.session?.id, reading))
            verify("the app opened no wiki entry for it", calls.none { it.startsWith("GET wiki/entries") } && !exists(hasTestTag("wiki-entry")))
            capture("01-web-link-handed-to-the-browser")
        } finally { instrumentation.removeMonitor(browser) }
    }

    /** A05-10: a list reply that left before a newer read was asked for never overwrites it; switching views sends nothing. */
    @Test fun aLateListReplyNeverOverwritesANewerOne() = journey {
        val seen = CopyOnWriteArrayList<String>()
        val watcher = CoroutineScope(Dispatchers.Default)
        watcher.launch { app.realtime.state.collect { s ->
            s.directory?.sessions?.get("open")?.firstOrNull { ObjectId.same(it["id"]?.jsonPrimitive?.content, listed) }
                ?.get("title")?.jsonPrimitive?.content?.let { if (seen.lastOrNull() != it) seen += it }
        } }
        try {
            signIn()
            compose.onNodeWithTag("workspace:$workspace").performClick()
            await("the list") { exists(hasText("Release notes")) }
            val latch = CountDownLatch(1)
            listedTitle = "Stale title"
            hold = latch
            val mark = calls.size
            app.realtime.refreshDirectory()
            await("the first read is out and held") { hold == null }
            await("its other views are read") { calls.drop(mark).any { it == "GET sessions?view=completed" } && calls.drop(mark).any { it == "GET sessions?view=trash" } }
            val before = calls.drop(mark).count { it.startsWith("GET sessions") }
            // A view switch reads nothing: one directory read holds all three views.
            compose.onAllNodes(hasText("Completed") and hasClickAction()).onFirst().performClick(); settle()
            compose.onAllNodes(hasText("Open") and hasClickAction()).onFirst().performClick(); settle()
            verify("switching views read nothing", calls.drop(mark).count { it.startsWith("GET sessions") } == before)
            capture("01-read-held")
            listedTitle = "Fresh title"
            app.realtime.refreshDirectory()
            pause(500)
            latch.countDown()
            await("the newer read is drawn") { exists(hasText("Fresh title")) }
            pause(1_500)
            verify("the held reply was never published (${seen.joinToString(" → ")})", "Stale title" !in seen)
            verify("and never drawn", !exists(hasText("Stale title")))
            val reads = calls.drop(mark).count { it == "GET sessions?view=open" }
            verify("two reads went out, the held one and the newer ($reads)", reads >= 2)
            capture("02-newer-read-drawn")
        } finally { watcher.cancel() }
    }

    /** A05-11: the server's recap is the session row's line, and the Session recaps switch, kept on the server, turns it off. */
    @Test fun theServersRecapIsTheRowsLineAndTheSwitchTurnsItOff() = journey {
        recap = "Moved the recap onto the session list row; the three states are covered by tests."
        preferences = """{"recaps":true}"""
        signIn()
        compose.onNodeWithTag("workspace:$workspace").performClick()
        await("the row's line is the recap") { exists(hasText(recap!!)) }
        verify("not the last reply", !exists(hasText("Committed the row change.")))
        verify("and no recap label", !exists(hasText("Recap ·", substring = true)))
        capture("01-recap-line")
        compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
        compose.onNode(hasText("Settings") and hasClickAction()).performClick()
        val toggle = hasText("Session recaps") and isToggleable()
        await("the Session recaps switch") { compose.onAllNodes(toggle and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(toggle).performScrollTo().assertIsOn()
        compose.onNode(toggle).performClick()
        await("the switch is written off") { bodies.any { it.first == "PATCH users/me/preferences" && it.second.replace(" ", "") == """{"recaps":false}""" } }
        await("and reads back off") { runCatching { compose.onNode(toggle).assertIsOff() }.isSuccess }
        capture("02-switch-off")
        back()
        await("back on the list") { exists(hasTestTag("directory-list")) || exists(hasTestTag("workspace:$workspace")) }
        if (!exists(hasTestTag("directory-list"))) compose.onNodeWithTag("workspace:$workspace").performClick()
        await("the row's line is the last reply again") { exists(hasText("Committed the row change.")) }
        verify("the recap is gone from the row", !exists(hasText(recap!!)))
        capture("03-last-reply-line")
    }

    private fun pause(ms: Long) = android.os.SystemClock.sleep(ms)
}
