package io.orbitd.android.directory

import android.graphics.Bitmap
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.util.Base64
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.BuildConfig
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.auth.chooseServer
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.navigation.ObjectId
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A05d on the isolated Orbit stack (A11's: an apiserver built from a main SHA, its own PostgreSQL, the repo's Go runner with a
 * stand-in engine), signed in through the product's own screen as the stack's owner. The seeded main project's row in its
 * workspace's list and its sessions page are compared with what the stack's API answers to the same account: its members (Open
 * and Completed, read by project), its coordinator, and its progress from `GET /projects/sidebar`. No fixture; the reads are kept
 * beside the screenshots. Arguments as RealStackDeviceTest's (scripts/tasks-projects-stack-args.py), run through
 * scripts/tasks-projects-stack-device-test.sh with A11_TEST naming this class.
 */
@RunWith(AndroidJUnit4::class)
class ProjectSessionsRealStackDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val output get() = File(app.filesDir, "a11-tasks-projects").also { it.mkdirs() }
    private fun arg(key: String) = String(Base64.decode(requireNotNull(InstrumentationRegistry.getArguments().getString(key)) { "missing argument $key" }, Base64.DEFAULT))
    private val seed by lazy { Wire.json.parseToJsonElement(arg("a11Seed")).jsonObject }
    private val server by lazy { seed.text("server")!! }
    private val reads = mutableListOf<String>()
    private fun <T> record(what: String, value: T): T { reads += "$what => $value"; return value }

    private var token: String? = null
    private fun http(method: String, path: String, body: String?, bearer: String?): Pair<Int, String> =
        (URL("$server/api$path").openConnection() as HttpURLConnection).run {
            connectTimeout = 10_000; readTimeout = 30_000; requestMethod = method
            bearer?.let { setRequestProperty("Authorization", "Bearer $it") }
            if (body != null) { doOutput = true; setRequestProperty("Content-Type", "application/json"); outputStream.use { it.write(body.toByteArray()) } }
            try { responseCode to ((if (responseCode < 400) inputStream else errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()) }
            finally { disconnect() }
        }
    private fun get(path: String): JsonElement {
        val bearer = token ?: run {
            val (status, text) = http("POST", "/auth/login", buildJsonObject { put("email", arg("ownerEmail")); put("password", arg("ownerPassword")) }.toString(), null)
            assertTrue("API sign-in: HTTP $status", status in 200..299)
            Wire.json.parseToJsonElement(text).jsonObject.text("accessToken")!!.also { token = it }
        }
        val (status, text) = http("GET", path, null, bearer)
        assertTrue("GET $path: HTTP $status ${text.take(300)}", status in 200..299)
        return Wire.json.parseToJsonElement(text)
    }

    @Test fun theProjectSessionsPageIsTheServersProject() {
        try {
            signIn()
            val project = seed.obj("projects")!!.obj("main")!!
            val id = project.text("id")!!
            val workspace = seed.obj("workspace")!!
            // What the server says, as the same account.
            fun rows(view: String) = get("/sessions?view=$view&projectId=$id").jsonArray.map { it.jsonObject }
            val members = (rows("open") + rows("completed"))
                .filter { ObjectId.same(it.obj("projectMembership")?.text("projectId"), id) && it.text("lifecycleState") != "TRASH" }.distinctBy { it.text("id") }
            record("GET /sessions?projectId (open + completed), members", members.map { "${it.text("title")} ${it.obj("projectMembership")?.text("role")} ${it.text("lifecycleState")} ${it.text("runState")}" })
            assertTrue("the seeded project has sessions", members.isNotEmpty())
            val coordinator = members.firstOrNull { it.obj("projectMembership")?.text("role") == "COORDINATOR" }
            val sidebar = get("/projects/sidebar").jsonArray.map { it.jsonObject }.first { ObjectId.same(it.text("id"), id) }
            val counts = sidebar.obj("taskCounts")
            record("GET /projects/sidebar row", "title=${sidebar.text("title")} status=${sidebar.text("status")} taskCounts=$counts startedAt=${sidebar["startedAt"]}")
            val local = get("/sessions?view=open").jsonArray.map { it.jsonObject }
                .filter { ObjectId.same(it.obj("projectMembership")?.text("projectId"), id) && ObjectId.same(it.obj("agent")?.text("id") ?: it.text("agentId"), workspace.text("id")) }
            record("GET /sessions?view=open, the project's members in ${workspace.text("name")}", local.map { it.text("title") })

            // The workspace's list: the project's members as one row, saying its progress.
            drawer(workspace.text("name")!!)
            val row = SemanticsMatcher("the project's row") { node ->
                node.config.getOrNull(SemanticsProperties.TestTag)?.let { it.startsWith("project-row:") && ObjectId.same(it.removePrefix("project-row:"), id) } == true
            }
            // A list of many projects and sessions: scrolled until the row is composed.
            scrollTo("directory-list", row)
            // A member is the row, not a row of its own: no options of its own outside the project's row (whose ⋯ may say the same
            // words — a coordinator is often titled as its project).
            local.forEach { member -> assertTrue("${member.text("title")} is the row, not a row of its own",
                compose.onAllNodes(hasContentDescription("Options for ${member.text("title")}") and !hasAnyAncestor(row)).fetchSemanticsNodes().isEmpty()) }
            if (counts != null) compose.waitUntil(30_000) {
                compose.onAllNodes(hasText("${counts.number("done")}/${counts.number("total")}") and hasAnyAncestor(hasTestTag("project-progress-chip")), true)
                    .fetchSemanticsNodes().isNotEmpty()
            }
            // The row's own line: what the server's coordinator row says it waits on, in its oldest owner item's words when it
            // names one (SessionLine's waiting word, over every other line the row could say).
            val line = compose.onAllNodes(hasTestTag("project-row-line") and hasAnyAncestor(row), true).fetchSemanticsNodes().single()
                .config.getOrNull(SemanticsProperties.Text)?.joinToString()
            record("the list's project row says", line)
            if (coordinator != null && (coordinator.number("pendingApprovals") ?: 0) > 0 && coordinator.text("waitingKind") == "OWNER_ITEM") {
                val oldest = io.orbitd.android.cards.NeedsYouLogic.oldestItemWord(io.orbitd.android.cards.NeedsYouLogic.ownerItems(coordinator.objects("ownerItems")))
                record("the coordinator's oldest owner item", oldest)
                assertEquals(oldest, line)
            }
            capture("a05d-stack-list")

            // Its sessions page: the server's members, its coordinator first, and its progress.
            compose.onNode(row).performClick()
            compose.waitUntil(30_000) { compose.onAllNodes(hasText("Project · ${members.size} sessions")).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithContentDescription("Back").assertExists()
            if (coordinator != null) compose.onNodeWithText("Coordinator").assertExists()
            members.forEach { member ->
                val title = member.text("title")?.takeIf { it.isNotBlank() } ?: "Untitled session"
                compose.onNodeWithTag("project-sessions-list").performScrollToNode(hasText(title) and hasClickAction())
            }
            compose.onNodeWithTag("project-sessions-list").performScrollToIndex(0)
            val progress = compose.onAllNodesWithTag("project-sessions-progress-line").fetchSemanticsNodes().firstOrNull()?.config?.getOrNull(SemanticsProperties.Text)?.joinToString()
            record("the page's progress line", progress)
            if (counts != null) {
                val started = sidebar["startedAt"].let { it != null && it !is JsonNull }
                if (started) assertTrue(progress.orEmpty(), progress.orEmpty().startsWith("${counts.number("done")}/${counts.number("total")} done · "))
                else assertEquals("Not started · ${counts.number("total")} ${if (counts.number("total") == 1) "task" else "tasks"}", progress)
            }
            capture("a05d-stack-page")
            compose.onNodeWithContentDescription("Back").performClick()
            compose.waitUntil(30_000) { compose.onAllNodes(row).fetchSemanticsNodes().isNotEmpty() }
            capture("a05d-stack-back")
            File(output, "a05d-stack-result.txt").writeText("PASS\n")
        } catch (failure: Throwable) {
            reads += "FAILED: $failure"
            runCatching { capture("a05d-stack-failed") }
            throw failure
        } finally {
            File(output, "a05d-stack-readback.txt").writeText(reads.joinToString("\n"))
            runBlocking { app.session.logout() }
        }
    }

    /** Signs in through the product's sign-in screen, as the stack's owner. */
    private fun signIn() {
        instrument.sendStatus(0, Bundle().apply { putString("a11_pid", Process.myPid().toString()) })
        File(output, "a05d-identity.txt").writeText("sha=${BuildConfig.SOURCE_SHA}\ndirty=${BuildConfig.SOURCE_DIRTY}\nserver=$server\n" +
            "scope=isolated Orbit stack (server trees of ${seed.text("sourceSha")}), test account ${arg("ownerEmail")}; not production\n")
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        if (app.session.state.value is AuthState.SignedIn) runBlocking { app.session.logout() }
        compose.waitUntil(30_000) { compose.onAllNodesWithText("Welcome back").fetchSemanticsNodes().isNotEmpty() }
        compose.chooseServer(server)
        compose.onNodeWithText("Email").performTextReplacement(arg("ownerEmail"))
        compose.onNodeWithText("Password").performTextReplacement(arg("ownerPassword"))
        compose.onNodeWithText("Sign In").performScrollTo().performClick()
        compose.waitUntil(30_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
        record("signed in", (app.session.state.value as AuthState.SignedIn).handle.account.let { "${it.userId} at ${it.server}" })
    }
    /** The drawer's row for [entry] — the row itself, not a word on the page under the drawer. */
    private fun drawer(entry: String) {
        compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
        val row = hasText(entry) and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)
        compose.waitUntil(30_000) { compose.onAllNodes(row).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(row).performClick()
    }
    /** Scrolls the lazy list [list] until a node matching [matcher] is composed, as the list loads. */
    private fun scrollTo(list: String, matcher: SemanticsMatcher, timeout: Long = 30_000) {
        val deadline = SystemClock.uptimeMillis() + timeout
        while (true) {
            try { compose.onNodeWithTag(list).performScrollToNode(matcher); return }
            catch (missing: AssertionError) { if (SystemClock.uptimeMillis() > deadline) throw missing; SystemClock.sleep(300); compose.waitForIdle() }
        }
    }
    private fun capture(name: String) {
        compose.waitForIdle(); SystemClock.sleep(700)
        instrument.uiAutomation.takeScreenshot().let { bitmap ->
            File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }
}
