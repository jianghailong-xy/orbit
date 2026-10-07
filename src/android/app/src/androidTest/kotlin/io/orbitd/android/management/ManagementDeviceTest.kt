package io.orbitd.android.management

import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.view.KeyEvent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import java.io.File
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The A13 pages driven through the real product shell over controlled HTTP on the emulator: MEMBER and ADMIN,
 * a remote Runner going from offline to online, its deep link, the workspace form, providers, sharing and
 * notifications. No deployed account, real Runner, FCM or iOS result is claimed by this test.
 */
@RunWith(AndroidJUnit4::class)
class ManagementDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val calls = CopyOnWriteArrayList<String>()
    @Volatile private var role = "MEMBER"
    @Volatile private var secondRole = "MEMBER"
    @Volatile private var name = "A13 fixture"
    @Volatile private var theme = "system"
    @Volatile private var permission = "auto"
    @Volatile private var forbidden = false
    @Volatile private var runnerOnline = false
    @Volatile private var workspaceName = "Fixture workspace"
    @Volatile private var sharingActive = true
    @Volatile private var shareTools = false
    @Volatile private var bearerOnPublicManifest: String? = "unread"
    private val workspaceId = "34Tcl0kralZrY8opuLJU4"
    private val runnerId = "34TcwNgAIo6tGUiIKjqnQ"
    private val sessionId = "34TcwNgAIo6tGUiIKjqnS"
    private val now get() = Instant.now()

    @Test fun settingsProfileSharingNotificationsAndRolesUseTheRealRoutes() {
        start()
        MockWebServer().use { server ->
            server.dispatcher = dispatcher()
            val fontScale = shell("settings get system font_scale").trim().ifEmpty { "1.0" }
            try {
                signIn(server)
                settings()
                assertTrue(compose.onAllNodes(hasText("Admin") and hasClickAction()).fetchSemanticsNodes().isEmpty())
                await("0 of 1 online"); await("1 active")
                capture("settings-home")
                // Default permission and Appearance are menus on their rows; each write is one preference key.
                click(hasText("Default permission") and hasClickAction()); click(hasText("Plan") and hasClickAction(), scroll = false)
                compose.waitUntil(10_000) { permission == "plan" }
                click(hasText("Appearance") and hasClickAction()); click(hasText("Dark") and hasClickAction(), scroll = false)
                compose.waitUntil(10_000) { theme == "dark" }
                await("Dark")
                capture("settings-home-dark")
                click(hasText("Appearance") and hasClickAction()); click(hasText("System") and hasClickAction(), scroll = false)
                compose.waitUntil(10_000) { theme == "system" }
                // The header opens the profile card; Save writes the name and comes back.
                compose.onNodeWithContentDescription("Edit profile").performScrollTo().performClick()
                await("Save profile")
                compose.onNode(hasSetTextAction() and hasText("Name")).performTextReplacement("Updated fixture")
                capture("edit-profile")
                click(hasText("Save profile") and hasClickAction())
                compose.waitUntil(10_000) { name == "Updated fixture" }
                await("Default permission")
                click(hasText("Change password") and hasClickAction())
                await("At least 6 characters")
                capture("change-password")
                back()
                click(hasText("Notifications") and hasClickAction())
                await("When a session finishes")
                compose.onNodeWithText("Push is unavailable in this build. You can still check sessions and decisions in Orbit.").assertExists()
                compose.onNodeWithText("Notifications are on. Manage categories in Android settings.").assertDoesNotExist()
                capture("notifications")
                back()
                click(hasText("Shared links") and hasClickAction())
                await("Fixture shared session")
                capture("shared-links")
                click(hasText("Turn off") and hasClickAction())
                compose.onNode(hasText("Turn off") and hasAnyAncestor(isDialog())).performClick()
                compose.waitUntil(10_000) { !sharingActive }
                await("Nothing is shared right now. Share a session from its ⋯ menu.")
                back()
                // A live role or account revocation clears what was shown; a later read recovers it.
                forbidden = true
                compose.activityRule.scenario.recreate()
                await("Refresh")
                capture("permission-revoked")
                forbidden = false
                click(hasText("Refresh") and hasClickAction())
                await("Updated fixture")
                click(hasText("Sign out") and hasClickAction())
                await("Sign out of ${server.url("/").host}:${server.port}?")
                capture("sign-out-confirm")
                compose.onNode(hasText("Sign out") and hasAnyAncestor(isDialog())).performClick()
                compose.waitUntil(10_000) { app.session.state.value is AuthState.SignedOut }
                // The same account as ADMIN sees Admin; a demotion elsewhere takes it away on the next read.
                role = "ADMIN"
                signIn(server)
                settings()
                click(hasText("Admin") and hasClickAction())
                await("New user")
                capture("admin-users")
                click(hasText("Second user") and hasClickAction())
                await("Delete user")
                capture("admin-user")
                click(hasText("Admin") and hasClickAction(), scroll = false)
                compose.waitUntil(10_000) { secondRole == "ADMIN" }
                role = "MEMBER"
                compose.activityRule.scenario.recreate()
                await("Administrator access is required.")
                capture("admin-demoted")
                back(); back()
                await("Default permission")
                shell("settings put system font_scale 2.0")
                compose.activityRule.scenario.recreate()
                await("Default permission")
                capture("settings-home-font200")
                assertEquals(1, calls.count { it == "PATCH /api/users/me" })
                assertTrue(calls.contains("PATCH /api/admin/users/u2/role"))
                assertTrue(calls.contains("POST /api/share-links/turn-off"))
                assertTrue(calls.none { it.startsWith("DELETE /api/admin") || it.startsWith("POST /api/auth/change-password") })
            } finally {
                shell("settings put system font_scale $fontScale")
                forbidden = false
                runBlocking { app.session.logout() }
                File(app.filesDir, "a13-management").apply { mkdirs() }.resolve("settings-requests.txt").writeText(calls.joinToString("\n"))
            }
        }
    }

    @Test fun workspaceRunnerProvidersAndSessionShareUseTheRealRoutes() {
        start()
        MockWebServer().use { server ->
            server.dispatcher = dispatcher()
            try {
                signIn(server)
                compose.onNodeWithTag("workspace:$workspaceId").performClick()
                await("Fixture session")
                // The session's own Share is the one share panel.
                compose.onNodeWithContentDescription("Options for Fixture session").performClick()
                click(hasText("Share…") and hasClickAction())
                await("Tool calls and output")
                capture("session-share")
                click(hasText("Tool calls and output") and isToggleable())
                compose.waitUntil(10_000) { shareTools }
                compose.onNode(hasText("Close") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
                // The workspace list's gear opens the form; Done writes only what changed.
                compose.onNodeWithContentDescription("Workspace settings").performClick()
                await("Smart model selection for tasks")
                compose.onNode(hasSetTextAction() and hasText("Name")).performTextReplacement("Configured workspace")
                capture("workspace-settings")
                click(hasText("Done") and hasClickAction(), scroll = false)
                compose.waitUntil(10_000) { workspaceName == "Configured workspace" }
                settings()
                click(hasText("Runners") and hasClickAction())
                await("Controlled remote")
                capture("runners-list")
                click(hasText("Controlled remote") and hasClickAction())
                await("Max Concurrent")
                compose.onAllNodes(hasText("Refresh Model Lists")).assertCountEquals(0)
                capture("runner-offline")
                runnerOnline = true
                compose.activityRule.scenario.recreate()
                await("Refresh Model Lists")
                await("Can’t update itself")
                capture("runner-online")
                click(hasText("Refresh Model Lists") and hasClickAction())
                compose.waitUntil(10_000) { calls.contains("POST /api/runners/$runnerId/refresh-models") }
                click(hasText("Claude Code") and hasClickAction())
                await("Add Account")
                capture("runner-engine")
                back(); back(); back()
                compose.activityRule.scenario.onActivity { activity ->
                    val original = activity.intent
                    MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                        .invoke(activity, Intent(Intent.ACTION_VIEW, Uri.parse("orbit://runner/${ObjectId.canonical(runnerId)}")).setClass(activity, MainActivity::class.java))
                    activity.intent = original
                }
                await("Rotate Token…")
                capture("runner-deep-link")
                back()
                await("Providers")
                click(hasText("Providers") and hasClickAction())
                await("Team Codex")
                capture("providers")
                click(hasText("Team Codex") and hasClickAction())
                await("Who can use it")
                capture("codex-pool")
                assertTrue(calls.contains("PATCH /api/workspaces/$workspaceId"))
                assertTrue(calls.contains("PUT /api/sessions/$sessionId/share"))
                assertNull("The release manifest must be read without the account's bearer", bearerOnPublicManifest)
            } finally {
                runBlocking { app.session.logout() }
                File(app.filesDir, "a13-management").apply { mkdirs() }.resolve("runner-requests.txt").writeText(calls.joinToString("\n"))
            }
        }
    }

    private fun start() {
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue("Dedicated signed-out debug installation required", app.session.state.value is AuthState.SignedOut)
    }
    private fun signIn(server: MockWebServer) {
        runBlocking { app.session.login(ServerAddress.parse(server.url("/").toString(), true), "a13@example.test", "controlled-fixture") }
        compose.waitUntil(15_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
    }
    private fun settings() {
        compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
        click(hasText("Settings") and hasClickAction())
        await("Default permission")
    }
    private fun await(text: String) {
        compose.waitUntil(15_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    }
    private fun click(matcher: SemanticsMatcher, scroll: Boolean = true) {
        compose.waitUntil(10_000) { compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
        val node = compose.onAllNodes(matcher).onFirst()
        if (scroll) try { node.performScrollTo() } catch (_: AssertionError) { }
        node.performClick()
        compose.waitForIdle()
    }
    private fun back() { instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK); compose.waitForIdle() }
    private fun shell(command: String): String = instrumentation.uiAutomation.executeShellCommand(command).let { fd ->
        android.os.ParcelFileDescriptor.AutoCloseInputStream(fd).bufferedReader().readText()
    }
    private fun capture(label: String) {
        compose.waitForIdle(); instrumentation.waitForIdleSync()
        // Semantics can be current a frame before the display is: let the frame reach the screen.
        android.os.SystemClock.sleep(700)
        val dir = File(app.filesDir, "a13-management").apply { mkdirs() }
        instrumentation.uiAutomation.takeScreenshot().let { bitmap ->
            File(dir, "$label.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }

    private fun user() = """{"id":"fixture-user","name":"$name","email":"a13@example.test","role":"$role","avatarUpdatedAt":null,"preferences":{"theme":"$theme","defaultPermissionMode":"$permission","notifySessionFinished":false,"notifyAgentMessage":true}}"""
    private fun heartbeat() = if (runnerOnline) now.toString() else now.minusSeconds(5 * 3600).toString()
    private fun runner() = """{"id":"$runnerId","name":"controlled-remote","displayName":"Controlled remote","hostname":"ci-runner-01","version":"0.1.199",
        "online":$runnerOnline,"status":"${if (runnerOnline) "ONLINE" else "OFFLINE"}","lastHeartbeatAt":"${heartbeat()}","maxConcurrent":4,"activeSessions":1,
        "runsAsRoot":false,"minFreeDiskMb":null,"reposRoot":"/home/ci/orbit-repos","enrolledAt":"2026-09-01T10:00:00Z","capabilities":["claude-account-remove/v1"],
        "engines":[{"engine":"claude","installed":true,"version":"2.1.284 (Claude Code)","auth":"yes","update":{"status":"checked","at":"${now.minusSeconds(360)}","okAt":"${now.minusSeconds(360)}","latest":"2.1.284"},
          "accounts":[{"id":"default","home":"/home/ci/.claude","auth":"yes"},{"id":"1fda3f43","home":"/home/ci/.orbit/claude-accounts/1fda3f43","auth":"no","name":"Work"}]},
          {"engine":"codex","installed":true,"version":"codex-cli 0.158.0","auth":"yes"},{"engine":"kimi","installed":false}],
        "planUsage":{"claude":{"fiveHour":{"utilization":42,"resetsAt":"${now.plusSeconds(7200)}"},"sevenDay":{"utilization":91,"resetsAt":"${now.plusSeconds(3 * 86400)}"}}},"install":null}"""
    private fun workspace() = """{"id":"$workspaceId","name":"$workspaceName","runnerId":"$runnerId","enabled":true,"workDir":"/home/ci/fixture","lastProvider":"claude",
        "effort":"","modelRouting":false,"env":{"NODE_ENV":"test"},"workDirFreeBytes":"5368709120","workDirTotalBytes":"107374182400",
        "repoHealth":{"root":"/home/ci/fixture","state":"rebase","branch":"feature/x"},"position":0,"createdAt":"2026-09-01T10:00:00Z"}"""
    private fun session() = """{"id":"$sessionId","title":"Fixture session","status":"SUCCEEDED","lifecycleState":"OPEN","workspaceId":"$workspaceId","agentId":"$workspaceId",
        "createdAt":"${now.minusSeconds(600)}","lastTurnAt":"${now.minusSeconds(300)}","pendingApprovals":0}"""
    private fun shareLink(id: String, title: String, kind: String = "SESSION") = """{"id":"$id","token":"fixture-public-token","kind":"$kind","state":"${if (sharingActive) "ACTIVE" else "ENDED"}",
        "stateReason":${if (sharingActive) "null" else "\"TURNED_OFF\""},"revokedAt":${if (sharingActive) "null" else "\"$now\""},
        "root":{"id":"$sessionId","title":"$title","lifecycleState":"OPEN"},"include":{"toolOutput":$shareTools},"viewCount":3,"lastViewedAt":"${now.minusSeconds(4000)}"}"""
    private fun login() = """{"state":"ACTIVE","email":"me@example.test","plan":"plus","fingerprint":"…AB12","userId":"fixture-user","next":true,
        "usage":{"provider":"codex","primary":{"utilization":36,"windowDurationMins":300,"resetsAt":"${now.plusSeconds(5000)}"},"secondary":{"utilization":58,"windowDurationMins":10080,"resetsAt":"${now.plusSeconds(400000)}"}}}"""
    private fun access() = """{"id":"P1","slug":"team-codex","label":"Team Codex","engine":"codex","shared":false,"logins":[${login()}],"membersCanAdd":false,
        "membersCanAddAccounts":false,"ownKeyFirst":false,"viewerRole":"ADMIN","window":{"start":"2026-10-01T00:00:00Z","end":"2026-11-01T00:00:00Z"},
        "people":[{"userId":"fixture-user","name":"$name","role":"ADMIN","creator":true,"you":true,"keys":1,"sessions":3,"usage":{"inputTokens":0,"outputTokens":0,"costUsd":4.2}},
          {"userId":"u2","name":"Second user","role":"MEMBER","creator":false,"you":false,"keys":0,"sessions":1,"usage":{"inputTokens":0,"outputTokens":0,"costUsd":1.1}}],
        "keys":[{"id":"K1","label":"Team key","fingerprint":"sk-…9XYZ","state":"ACTIVE","enabled":true,"shareCap":50,"contributor":{"userId":"fixture-user","name":"$name","you":true},
          "usage":{"inputTokens":0,"outputTokens":0,"costUsd":4.2,"othersCostUsd":1.1},"running":false,"next":false}]}"""
    private fun pools() = """[{"id":"P1","slug":"team-codex","label":"Team Codex","engine":"codex","logins":[${login()}]},
        {"id":"P2","slug":"claude-pool","label":"Claude pool","engine":"claude","members":[{"id":"m1","slug":"anthropic-a","label":"Anthropic A","state":"AVAILABLE","next":true,"enabled":true,
          "planUsage":{"fiveHour":{"utilization":20}}},{"id":"m2","slug":"anthropic-b","label":"Anthropic B","state":"SPENT","next":false,"enabled":true,"resetsAt":"${now.plusSeconds(3600)}"}]}]"""
    private fun admins() = """[{"id":"fixture-user","email":"a13@example.test","name":"$name","role":"$role","createdAt":"2026-09-01T00:00:00Z"},
        {"id":"u2","email":"second@example.test","name":"Second user","role":"$secondRole","createdAt":"2026-09-02T00:00:00Z"}]"""

    private fun dispatcher() = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.requestUrl!!.encodedPath
            calls += "${request.method} $path"
            if (path == "/dl/version.json") {
                bearerOnPublicManifest = request.getHeader("Authorization")
                return MockResponse().setHeader("Content-Type", "application/json").setBody("""{"version":"0.1.200"}""")
            }
            if (path !in listOf("/api/auth/login", "/api/auth/logout")) assertEquals("Bearer fixture-access", request.getHeader("Authorization"))
            if (path == "/api/users/me" && forbidden) return MockResponse().setResponseCode(403).setBody("{}")
            fun bodyOf() = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
            val body = when (path) {
                "/api/auth/login" -> """{"accessToken":"fixture-access","refreshToken":"fixture-refresh","user":${user()}}"""
                "/api/auth/logout" -> "{}"
                "/api/users/me" -> { if (request.method == "PATCH") name = bodyOf()["name"]!!.jsonPrimitive.content; user() }
                "/api/users/me/preferences" -> {
                    val patch = bodyOf()
                    patch["theme"]?.let { theme = it.jsonPrimitive.content }
                    patch["defaultPermissionMode"]?.let { permission = it.jsonPrimitive.content }
                    user()
                }
                "/api/admin/users" -> if (role == "ADMIN") admins() else return MockResponse().setResponseCode(403).setBody("""{"message":"Admin role required"}""")
                "/api/admin/users/u2/role" -> { secondRole = bodyOf()["role"]!!.jsonPrimitive.content; admins() }
                "/api/share-links" -> """{"links":[${shareLink("share-link", "Fixture shared session")}]}"""
                "/api/share-links/turn-off" -> { sharingActive = false; """{"count":1}""" }
                "/api/sessions/$sessionId/share" -> {
                    if (request.method == "PUT") bodyOf()["include"]?.jsonObject?.get("toolOutput")?.let { shareTools = it.jsonPrimitive.boolean; sharingActive = true }
                    if (request.method == "DELETE") sharingActive = false
                    if (request.method == "PUT") shareLink("session-link", "Fixture session")
                    else """{"link":${if (sharingActive) shareLink("session-link", "Fixture session") else "null"},"counts":{"messages":12,"toolCalls":5}}"""
                }
                "/api/workspaces" -> "[${workspace()}]"
                "/api/workspaces/$workspaceId" -> { if (request.method == "PATCH") workspaceName = bodyOf()["name"]!!.jsonPrimitive.content; workspace() }
                "/api/runners" -> "[${runner()}]"
                "/api/runners/$runnerId/login" -> """{"status":null,"engine":null,"userCode":null,"url":null,"message":null,"account":null}"""
                "/api/sessions" -> if (request.requestUrl!!.queryParameter("view") == "open") "[${session()}]" else "[]"
                "/api/sessions/counts" -> """[{"workspaceId":"$workspaceId","active":1,"running":1,"jobs":0,"needsYou":0}]"""
                "/api/providers" -> """[{"slug":"openai-work","label":"OpenAI (work)","defaultModel":"gpt-5"}]"""
                "/api/providers/pools" -> pools()
                "/api/providers/shared-pools" -> "[]"
                "/api/providers/shared-pools/P1" -> access()
                "/api/events" -> return MockResponse().setHeader("Content-Type", "text/event-stream")
                    .setChunkedBody(": connected\n\n".repeat(120), 13).throttleBody(13, 1, TimeUnit.SECONDS)
                else -> if (request.method == "GET") "[]" else "{}"
            }
            return MockResponse().setHeader("Content-Type", "application/json").setBody(body)
        }
    }
}
