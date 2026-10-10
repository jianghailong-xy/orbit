package io.orbitd.android.projects

import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.SystemClock
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
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
import io.orbitd.android.navigation.ObjectId
import java.io.File
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A project's main branch on a device (project 34cjQN5ynG6eIH5A0neeu; docs/mocks/project-main-branch/02-ios.png, Android's a–f), over
 * the test's own controlled HTTP fixture — not a deployment. Five projects in acme/payments-api, whose coordination workspace
 * reported develop, master and release/2.4: the coordinator's request suggesting master (frames 1, 3, 5, 12–15), a second project
 * opening on the owner's last choice (6, 7), one with no repository (edge e), How it runs writing a pick at once (8, 9), and one
 * locked by integration (10, 11). Every frame leaves a screenshot in files/main-branch/<theme>; every write is checked against what
 * the fixture received.
 */
@RunWith(AndroidJUnit4::class)
class MainBranchDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val theme = InstrumentationRegistry.getArguments().getString("main_branch_theme") ?: "light"
    private val evidence get() = File(app.filesDir, "main-branch/$theme").also { it.mkdirs() }
    private val writes = CopyOnWriteArrayList<Pair<String, JsonObject>>()
    private val calls = CopyOnWriteArrayList<String>()
    private val workspace = "34MainBranchWorkspace1"
    private val asked = "34MainBranchProject001"; private val second = "34MainBranchProject002"; private val bare = "34MainBranchProject003"
    private val running = "34MainBranchProject004"; private val locked = "34MainBranchProject005"
    private val projects = listOf(asked, second, bare, running, locked)
    private val titles = mapOf(asked to "Order service on the new payment gateway", second to "Refunds on the new payment gateway",
        bare to "Docs site refresh", running to "Checkout retries and idempotency", locked to "Payments ledger export")
    /** How it runs' main branch for [running], as the fixture's PATCH leaves it. */
    @Volatile private var runningBranch = "master"

    @Test fun theMainBranchRowOnEveryPathTheOwnerMeetsIt() {
        instrumentation.sendStatus(0, android.os.Bundle().apply { putString("main_branch_pid", android.os.Process.myPid().toString()) })
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue("Requires a dedicated signed-out debug installation", app.session.state.value is AuthState.SignedOut)
        evidence.listFiles()?.forEach { it.delete() }
        File(evidence, "identity.txt").writeText("sha=${BuildConfig.SOURCE_SHA}\ndirty=${BuildConfig.SOURCE_DIRTY}\ntheme=$theme\n" +
            "scope=controlled HTTP fixture (MockWebServer in this test); not a deployed account\n")
        MockWebServer().use { server ->
            server.dispatcher = fixture()
            try {
                compose.chooseServer(server.url("/").toString())
                compose.onNodeWithText("Email").performTextReplacement("main-branch@example.test")
                compose.onNodeWithText("Password").performTextReplacement("main-branch-fixture-password")
                compose.onNodeWithText("Sign In").performScrollTo().performClick()
                compose.waitUntil(20_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }

                // ① The coordinator's request, from the project's sessions page: Main branch under Tasks land on, on what it suggests.
                openDrawer(); await { exists(drawerRow(titles.getValue(asked))) }
                compose.onNode(drawerRow(titles.getValue(asked))).performClick(); settle()
                await { exists(hasTestTag("project-sessions-review-start")) }
                compose.onNodeWithTag("project-sessions-review-start").performClick()
                await { exists(hasTestTag("project-start-request-main-branch")) }
                compose.onNodeWithTag("project-start-request-main-branch").performScrollTo().assertTextEquals("master")
                compose.onNodeWithTag("project-start-request-automatic-says", useUnmergedTree = true)
                    .assertTextEquals(RunSettings.automaticSays(true, "PROJECT_BRANCH", true, "master"))
                compose.onNodeWithTag("project-start-request-at-most").performScrollTo()
                capture("01-start-card-main-branch")
                // ③ The picker: the reported branches, the value ticked, what the choice decides under them.
                tap("project-start-request-main-branch"); await { exists(hasTestTag("project-start-request-main-branch-picker")) }
                compose.onNodeWithTag("project-start-request-main-branch-picker-head", useUnmergedTree = true).assertTextEquals("Branches in payments-api")
                compose.onNodeWithTag("project-start-request-main-branch-picker:master").assertTextContains("✓")
                capture("03-picker")
                tap("project-start-request-main-branch-picker-cancel"); awaitGone("project-start-request-main-branch-picker")
                // ⑫ Tasks land on's menu names the branch; ⑬–⑮ Automatic off, and the merge check opened.
                tap("project-start-request-line"); await { exists(hasTestTag("project-start-request-line:MAIN")) }
                compose.onNode(hasText("Directly into master") and hasAnyAncestor(hasTestTag("project-start-request-line:MAIN")), useUnmergedTree = true).assertExists()
                capture("12-line-menu")
                tap("project-start-request-line:PROJECT_BRANCH"); settle()
                tap("project-start-request-automatic")
                tap("project-start-request-merge-check")
                compose.onNodeWithTag("project-start-request-automatic-says", useUnmergedTree = true)
                    .assertTextEquals("You decide when each task is done and when the branch goes into master.")
                compose.onNodeWithTag("project-start-request-comes-to-you").performScrollTo()
                assertTrue(exists(hasText("Merging the branch into master") and hasAnyAncestor(hasTestTag("project-start-request-comes-to-you")), unmerged = true))
                capture("13-automatic-off")
                compose.onNodeWithText(RunSettings.mergeCheckHint("master")).performScrollTo()
                capture("15-merge-check-open")
                tap("project-start-request-automatic"); tap("project-start-request-merge-check")
                // ⑤ A branch the runner never reported, typed and used.
                tap("project-start-request-main-branch"); await { exists(hasTestTag("project-start-request-main-branch-picker-field")) }
                compose.onNodeWithTag("project-start-request-main-branch-picker-field").performTextInput("release/3.0")
                await { exists(hasTestTag("project-start-request-main-branch-picker-use")) }
                compose.onNodeWithTag("project-start-request-main-branch-picker-use").assertTextEquals("Use “release/3.0”")
                capture("05-typed")
                tap("project-start-request-main-branch-picker-use"); awaitGone("project-start-request-main-branch-picker")
                compose.onNodeWithTag("project-start-request-main-branch").performScrollTo().assertTextEquals("release/3.0")
                compose.onNodeWithTag("project-start-request-confirm").performScrollTo().performClick()
                await { writes.any { it.first == "POST /api/projects/$asked/start" } }
                writes.last { it.first == "POST /api/projects/$asked/start" }.second.let { body ->
                    assertEquals("refs/heads/release/3.0", body["upstreamRef"]?.jsonPrimitive?.content)
                    assertEquals("item-1", body["requestId"]?.jsonPrimitive?.content)
                }
                awaitGone("project-start-request-sheet")

                // ② The second project in the repository: nobody asked, and it opens on the owner's last choice, saying so.
                open("orbit-project:$second"); awaitScrollTo("project-detail", hasTestTag("project-start-own"))
                tap("project-start-own"); await { exists(hasTestTag("project-start-main-branch")) }
                compose.onNodeWithTag("project-start-main-branch").performScrollTo().assertTextEquals("master")
                compose.onNodeWithTag("project-start-main-branch-last", useUnmergedTree = true).assertTextEquals("Your last choice for acme/payments-api")
                compose.onNodeWithTag("project-start-at-most").performScrollTo()
                capture("06-second-project-last-choice")
                tap("project-start-main-branch"); await { exists(hasTestTag("project-start-main-branch-picker")) }
                compose.onNodeWithTag("project-start-main-branch-picker:master").assertTextContains("last chosen").assertTextContains("✓")
                capture("07-picker-last-chosen")
                tap("project-start-main-branch-picker-cancel"); awaitGone("project-start-main-branch-picker")
                compose.onNodeWithTag("project-start-confirm").performScrollTo().performClick()
                await { writes.any { it.first == "POST /api/projects/$second/start" } }
                assertEquals("refs/heads/master", writes.last { it.first == "POST /api/projects/$second/start" }.second["upstreamRef"]?.jsonPrimitive?.content)
                awaitGone("project-start-sheet")

                // Edge e: a project with no repository has no row, and its start names no main branch.
                open("orbit-project:$bare"); awaitScrollTo("project-detail", hasTestTag("project-start-own"))
                tap("project-start-own"); await { exists(hasTestTag("project-start-line")) }
                compose.onNodeWithTag("project-start-merge-check").performScrollTo()
                assertFalse(exists(hasTestTag("project-start-main-branch")))
                assertFalse(exists(hasText(RunSettings.mainBranch)))
                capture("edge-e-no-repository")
                compose.onNodeWithTag("project-start-confirm").performScrollTo().performClick()
                await { writes.any { it.first == "POST /api/projects/$bare/start" } }
                assertNull(writes.last { it.first == "POST /api/projects/$bare/start" }.second["upstreamRef"])
                awaitGone("project-start-sheet")

                // ③ How it runs on a started project: Main branch under the line, picked and written at once.
                open("orbit-project:$running"); awaitScrollTo("project-detail", hasTestTag("project-main-branch"))
                compose.onNodeWithTag("project-main-branch").assertTextEquals("master")
                compose.onNodeWithText("${RunSettings.mainBranchHint} ${RunSettings.mainBranchRemembers("acme/payments-api")}").performScrollTo()
                capture("08-how-it-runs")
                awaitScrollTo("project-detail", hasText(RunSettings.automaticHint("PROJECT_BRANCH", "master")))
                capture("09-how-it-runs-automatic")
                awaitScrollTo("project-detail", hasTestTag("project-main-branch"))
                tap("project-main-branch"); await { exists(hasTestTag("project-main-branch-picker")) }
                capture("08b-how-it-runs-picker")
                tap("project-main-branch-picker:develop")
                await { writes.any { it.first == "PATCH /api/projects/$running/integration" } }
                assertEquals(buildJsonObject { put("upstreamRef", "refs/heads/develop") }, writes.last { it.first == "PATCH /api/projects/$running/integration" }.second)
                await { compose.onAllNodes(hasTestTag("project-main-branch") and hasText("develop")).fetchSemanticsNodes().isNotEmpty() }
                capture("08c-how-it-runs-develop")

                // ⑩ ⑪ A project that started integrating: the row under the title names its main branch, and How it runs is locked.
                open("orbit-project:$locked"); await { exists(hasTestTag("project-integration-facts")) }
                compose.onNodeWithTag("project-integration-facts").assertTextContains("ahead of master at last measurement", substring = true)
                capture("11-integration-row")
                awaitScrollTo("project-detail", hasTestTag("project-main-branch-locked"))
                assertTrue(exists(hasText("🔒 master") and hasAnyAncestor(hasTestTag("project-main-branch-locked")), unmerged = true))
                assertFalse(exists(hasTestTag("project-main-branch")))
                capture("10-locked")
                File(evidence, "result.txt").writeText("PASS\n")
            } catch (failure: Throwable) {
                File(evidence, "failure.txt").writeText(failure.stackTraceToString())
                runCatching { capture("failure") }
                throw failure
            } finally {
                runBlocking { app.session.logout() }
                File(evidence, "requests.txt").writeText(calls.joinToString("\n"))
                File(evidence, "writes.txt").writeText(writes.joinToString("\n") { "${it.first} ${it.second}" })
            }
        }
    }

    // MARK: the fixture

    private fun ago(minutes: Long) = Instant.now().minusSeconds(minutes * 60).toString()
    private val branches = """{"names":["develop","master","release/2.4"],"workspaceName":"payments-api","reportedAt":"${ago(30)}"}"""
    private fun lastChoice(branch: String) = """{"branch":"$branch","repository":"acme/payments-api","chosenAt":"${ago(2 * 24 * 60)}"}"""
    private fun started(project: String) = project == running || project == locked

    private fun integration(project: String): String = when (project) {
        asked -> view(null, null, null, repository = "\"acme/payments-api\"", branches = branches)
        second -> view(null, null, lastChoice("master"), repository = "\"acme/payments-api\"", branches = branches)
        bare -> view(null, null, null, repository = "null", branches = "null")
        running -> view("\"PROJECT_BRANCH\"", "\"$runningBranch\"", lastChoice(runningBranch), repository = "\"acme/payments-api\"", branches = branches,
            ref = "\"project/$running\"", chosenAt = "\"${ago(2 * 24 * 60)}\"")
        else -> view("\"PROJECT_BRANCH\"", "\"master\"", lastChoice("master"), repository = "\"acme/payments-api\"", branches = branches,
            ref = "\"project/$locked\"", chosenAt = "\"${ago(5 * 24 * 60)}\"", lockedAt = ago(3 * 24 * 60))
    }
    private fun view(line: String?, upstream: String?, last: String?, repository: String, branches: String, ref: String = "null", chosenAt: String = "null",
        lockedAt: String? = null) = """{"line":${line ?: "null"},"lineAbsentReason":${if (line == null) "\"NOT_DECIDED\"" else "null"},"ref":$ref,
        "upstreamRef":${upstream ?: "null"},"upstreamChosenAt":$chosenAt,"lastMainBranch":${last ?: "null"},"source":${if (line == null) "null" else "\"EXPLICIT\""},
        "locked":${lockedAt != null},"startedAt":${lockedAt?.let { "\"$it\"" } ?: "null"},"mergeCheckCommand":${if (line == null) "null" else "\"make test\""},
        "mergeCheckCommandAbsentReason":${if (line == null) "\"NOT_CONFIGURED\"" else "null"},"mergeCheckTimeoutSeconds":null,"escalationSeconds":7200,
        "repository":$repository,"branches":$branches,"commitsAheadOfUpstream":${if (lockedAt != null) 3 else "null"},
        "commitsAheadOfUpstreamAbsentReason":${if (lockedAt != null) "null" else "\"NO_LANDING_YET\""},
        "lastUpstreamSyncAt":${if (lockedAt != null) "\"${ago(120)}\"" else "null"},"lastUpstreamSyncAbsentReason":${if (lockedAt != null) "null" else "\"NEVER_SYNCED\""},
        "integratingCount":0,"queuedCount":0,"mergeCheckOnTip":"${if (lockedAt != null) "PASSING" else "UNKNOWN"}","inFlight":null}"""

    private fun criteria(project: String) = when (project) {
        asked -> listOf("Payments settle through the new gateway in staging and production.", "Refund and chargeback flows reconcile against the old gateway's ledger.",
            "Rolling back to the old gateway takes one config change.")
        second -> listOf("Refunds go through the new gateway.", "A failed refund is retried once, then reported.")
        else -> listOf("The work is done and checked.")
    }.mapIndexed { at, text -> """{"id":"$project-c${at + 1}","key":"$project-k${at + 1}","ordinal":${at + 1},"text":"$text","satisfied":${started(project)},
        "landing":${if (started(project)) "\"LANDED\"" else "null"},"unmet":[]}""" }.joinToString(",", "[", "]")

    private fun document(project: String) = """{"id":"$project","title":"${titles.getValue(project)}","status":"OPEN","goal":"Move the order service's payments onto the new gateway.",
        "createdAt":"${ago(3 * 24 * 60)}","_count":{"tasks":4},"startedAt":${if (started(project)) "\"${ago(3 * 24 * 60)}\"" else "null"},
        "coordinatorSessionId":"34MainBranchSessionC01","coordinatorEnabled":true,"configRevision":"7","maxConcurrentTasks":2,"exceptionEscalationSeconds":7200,
        "pausedAt":null,"integration":${if (started(project)) """{"line":"PROJECT_BRANCH","ref":"project/$project","upstreamRef":"${if (project == running) runningBranch else "master"}",
        "escalationSeconds":7200}""" else """{"line":null,"upstreamRef":null,"escalationSeconds":7200}"""},"acceptanceCriteriaItems":${criteria(project)}}"""

    private fun graph(project: String): String {
        val tasks = listOf("G1 · Payment client for the new gateway", "G2 · Webhooks and signatures", "G3 · Switch the order flow", "G4 · Cut-over rehearsal")
        val marks = tasks.mapIndexed { at, title -> """{"kind":"TASK","id":"$project-t${at + 1}","taskId":"$project-t${at + 1}","title":"$title",
            "status":"OPEN","completionCriterion":"${if (at == 3) "OWNER_CONFIRMED" else "EVIDENCE_JUDGMENT"}","autoRunWhenReady":true}""" }
        val edges = listOf(1 to 2, 1 to 3, 3 to 4).map { (from, to) -> """{"sourceMarkId":"$project-t$from","targetMarkId":"$project-t$to"}""" }
        return """{"marks":${marks.joinToString(",", "[", "]")},"edges":${edges.joinToString(",", "[", "]")},"taskCount":4,"folded":false,"truncated":false}"""
    }

    private fun openItems(project: String) = if (project != asked) """{"needsYou":[],"withCoordinator":[]}""" else """{"needsYou":[],"withCoordinator":[],
        "startRequest":{"itemId":"item-1","kind":"START_REQUEST","title":"Start this project?","assignee":"OWNER","waitingSince":"${ago(56)}","actions":[],
        "startRequest":{"settings":{"line":"PROJECT_BRANCH","projectBranchName":"refs/heads/project/$asked","automatic":true,"maxConcurrentTasks":2,
        "mergeCheckCommand":"make test","upstreamRef":"refs/heads/master"},"why":"The repository's main branch is master (origin/HEAD), so the project branch is cut from master and merges back into it.",
        "criteriaDigest":"seal-$project","planDigest":"plan-1","repository":"acme/payments-api","warnings":[]}}}"""

    private fun sidebar() = projects.joinToString(",", "[", "]") { project -> """{"id":"$project","title":"${titles.getValue(project)}","status":"OPEN",
        "createdAt":"${ago(3 * 24 * 60)}","buckets":{},"taskCounts":{"done":0,"failed":0,"total":4},"attention":{},
        "startedAt":${if (started(project)) "\"${ago(3 * 24 * 60)}\"" else "null"},"mainBranch":${if (project == bare) "null" else "\"master\""}}""" }

    private fun fixture() = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.requestUrl!!.encodedPath
            calls += "${request.method} ${request.path}"
            if (path == "/api/auth/methods") return MockResponse().setResponseCode(404)
            if (path !in listOf("/api/auth/login", "/api/auth/logout")) assertEquals("Bearer main-branch-fixture-access", request.getHeader("Authorization"))
            val parts = path.removePrefix("/api/").split('/').map { part -> (projects + workspace).firstOrNull { ObjectId.same(it, part) } ?: part }
            if (request.method != "GET" && path !in listOf("/api/auth/login", "/api/auth/logout")) {
                val body = request.body.readUtf8().takeIf { it.isNotBlank() }?.let { Json.parseToJsonElement(it).jsonObject } ?: JsonObject(emptyMap())
                writes += "${request.method} /api/${parts.joinToString("/")}" to body
                if (parts == listOf("projects", running, "integration")) body["upstreamRef"]?.jsonPrimitive?.content?.let { runningBranch = it.removePrefix("refs/heads/") }
                val answer = if (parts.size == 3 && parts[2] == "integration") integration(parts[1]) else "{}"
                return MockResponse().setHeader("Content-Type", "application/json").setBody(answer)
            }
            val body = when {
                path == "/api/auth/login" -> """{"accessToken":"main-branch-fixture-access","refreshToken":"main-branch-fixture-refresh","user":{"id":"u1","email":"main-branch@example.test","name":"Main branch fixture"}}"""
                path == "/api/users/me" -> """{"id":"u1","email":"main-branch@example.test","name":"Main branch fixture"}"""
                path == "/api/workspaces" -> """[{"id":"$workspace","name":"payments-api","runnerId":"r1","enabled":true,"position":0,"createdAt":"2026-10-01T01:00:00.000Z"}]"""
                path == "/api/runners" -> """[{"id":"r1","name":"Fixture runner","online":true}]"""
                path == "/api/events" -> return heartbeatStream()
                parts[0] == "sessions" && parts.last() == "events" -> return heartbeatStream()
                path == "/api/projects/sidebar" || path == "/api/projects" -> sidebar()
                parts[0] == "projects" && parts.size >= 2 && parts[1] in projects -> {
                    val project = parts[1]
                    when (parts.drop(2).joinToString("/")) {
                        "" -> document(project)
                        "integration" -> integration(project)
                        "open-items" -> openItems(project)
                        "acceptance/confirmation" -> """{"state":"UNCONFIRMED","confirmed":false,"currentVersion":{"digest":"seal-$project","material":[]}}"""
                        "dependency-graph" -> graph(project)
                        "panorama" -> """{"buckets":{"running":1,"ready":0,"blocked":1,"done":2,"integrating":0,"onIntegrationLine":${if (started(project)) 1 else 0},
                            "onUpstream":${if (started(project)) 1 else 0},"doneNotIntegrated":0,"awaitingVerification":0,"failed":0,"cancelled":0},"shape":{"taskCount":4,"edgeCount":3}}"""
                        "tasks/page" -> """{"items":[],"nextCursor":null}"""
                        "promotions/current" -> return MockResponse().setResponseCode(200)
                        "promotions/merged", "handoffs" -> "[]"
                        "coordinator/status" -> """{"projectId":"$project","readAt":"${ago(0)}","state":"NEVER_OPENED","coordination":null}"""
                        else -> "{}"
                    }
                }
                parts[0] == "wiki" -> return MockResponse().setResponseCode(404).setHeader("Content-Type", "application/json")
                    .setBody("""{"code":"WIKI_DISABLED","message":"The wiki is off."}""")
                path.endsWith("/logout") -> "{}"
                request.method == "GET" -> "[]"
                else -> "{}"
            }
            return MockResponse().setHeader("Content-Type", "application/json").setBody(body)
        }
    }

    // A finite response reconnects and re-reads the lists while the journey looks at them: hold it open.
    private fun heartbeatStream() = MockResponse().setHeader("Content-Type", "text/event-stream")
        .setChunkedBody(": connected\n\n".repeat(240), 13)
        .throttleBody(13, 1, java.util.concurrent.TimeUnit.SECONDS)

    // MARK: driving the app

    private fun drawerRow(text: String) = hasText(text) and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)
    private fun exists(matcher: SemanticsMatcher, unmerged: Boolean = false) = compose.onAllNodes(matcher, unmerged).fetchSemanticsNodes().isNotEmpty()
    private fun await(condition: () -> Boolean) = compose.waitUntil(30_000, condition)
    private fun awaitGone(tag: String) = await { !exists(hasTestTag(tag)) }
    private fun openDrawer() { compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick(); settle() }
    /** Scrolls a list to a row that arrives with a later read. */
    private fun awaitScrollTo(list: String, matcher: SemanticsMatcher) {
        val deadline = SystemClock.uptimeMillis() + 30_000
        while (true) {
            try { compose.onNode(hasTestTag(list) and hasScrollAction()).performScrollToNode(matcher); return }
            catch (missing: AssertionError) { if (SystemClock.uptimeMillis() > deadline) throw missing; SystemClock.sleep(250); compose.waitForIdle() }
        }
    }
    /** Taps a node once it is there and enabled, through its click action: a dialog still settling refuses injected touches. */
    private fun tap(tag: String) {
        await { exists(hasTestTag(tag)) }
        await { compose.onNodeWithTag(tag).fetchSemanticsNode().config.getOrNull(SemanticsProperties.Disabled) == null }
        compose.onNodeWithTag(tag).performSemanticsAction(SemanticsActions.OnClick)
        settle()
    }
    /** A warm link delivered to the running activity, as the other journeys open theirs. */
    private fun open(uri: String) = compose.activityRule.scenario.onActivity { activity ->
        val original = activity.intent
        MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
            .invoke(activity, Intent(Intent.ACTION_VIEW, Uri.parse(uri)).setClass(activity, MainActivity::class.java))
        activity.intent = original
    }
    private fun settle() {
        compose.waitForIdle()
        instrumentation.waitForIdleSync()
        instrumentation.uiAutomation.waitForIdle(300, 5_000)
    }
    private fun capture(name: String) {
        settle()
        SystemClock.sleep(700) // dialog windows fade in outside Compose's idling
        var bitmap: Bitmap? = null
        repeat(3) { if (bitmap == null) bitmap = instrumentation.uiAutomation.takeScreenshot() ?: run { SystemClock.sleep(500); null } }
        val shot = bitmap ?: run { File(evidence, "$name.missing").writeText("takeScreenshot returned null 3 times\n"); return }
        File(evidence, "$name.png").outputStream().use { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }
        shot.recycle()
    }
}
