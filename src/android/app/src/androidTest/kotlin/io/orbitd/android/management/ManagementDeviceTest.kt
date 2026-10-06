package io.orbitd.android.management

import android.graphics.Bitmap
import android.view.KeyEvent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.ServerAddress
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Product navigation over controlled HTTP. No real deployed role or cross-platform claim. */
@RunWith(AndroidJUnit4::class)
class ManagementDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val calls = CopyOnWriteArrayList<String>()
    @Volatile private var role = "MEMBER"
    @Volatile private var name = "A13 fixture"
    @Volatile private var forbidden = false
    @Volatile private var resources = false
    @Volatile private var runnerOnline = false
    @Volatile private var workspaceName = "Fixture workspace"
    @Volatile private var sharingActive = true
    @Volatile private var shareTools = false
    private val workspaceId = "34Tcl0kralZrY8opuLJU4"
    private val runnerId = "34TcwNgAIo6tGUiIKjqnQ"

    @Test fun settingsProfileRecreationRoleRevocationAndAdminUseRealRoutes() {
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue("Dedicated signed-out debug installation required", app.session.state.value is AuthState.SignedOut)
        MockWebServer().use { server ->
            server.dispatcher = dispatcher()
            try {
                signIn(server)
                settings()
                compose.onNodeWithText("Admin", useUnmergedTree = true).assertDoesNotExist()
                click("Edit profile")
                await("Save profile")
                compose.onNode(hasText("Name") and hasSetTextAction()).performScrollTo().performTextReplacement("Updated fixture")
                click("Save profile")
                compose.waitUntil(10_000) { name == "Updated fixture" }
                compose.activityRule.scenario.recreate()
                await("Save profile")
                compose.onNodeWithText("Updated fixture").assertExists()
                capture("profile-recreated")
                forbidden = true
                click("Refresh")
                compose.waitUntil(10_000) { compose.onAllNodesWithText("Save profile").fetchSemanticsNodes().isEmpty() }
                capture("permission-revoked")
                forbidden = false
                click("Refresh")
                await("Save profile")
                back()
                click("Shared links")
                await("Fixture shared session")
                click("Access & included content")
                await("Tool calls and output")
                compose.onNodeWithContentDescription("Tool calls and output").performScrollTo().performClick()
                compose.waitUntil(10_000) { shareTools }
                capture("share-permissions")
                click("Only you · turn off link")
                compose.onNode(hasText("Turn off") and hasClickAction()).performClick()
                compose.waitUntil(10_000) { !sharingActive }
                back()
                await("Nothing is shared right now. Share a session, task or project from its Share entry.")
                capture("shared-links")
                back()
                click("Notifications")
                await("When a session finishes")
                compose.onNodeWithText("Push is unavailable in this build. You can still check sessions and decisions in Orbit.").assertExists()
                compose.onNodeWithText("Notifications are on. Manage categories in Android settings.").assertDoesNotExist()
                capture("notification-preferences")
                back()
                role = "ADMIN"
                runBlocking { app.session.logout() }
                compose.waitUntil(10_000) { app.session.state.value is AuthState.SignedOut }
                signIn(server)
                settings()
                click("Admin")
                await("Create user")
                capture("admin-users")
                assertTrue(calls.contains("GET /api/admin/users"))
                role = "MEMBER"
                click("Refresh")
                compose.waitUntil(10_000) { compose.onAllNodesWithText("Create user").fetchSemanticsNodes().isEmpty() }
                capture("admin-demoted")
                assertEquals(1, calls.count { it == "PATCH /api/users/me" })
                assertTrue(calls.none { it.startsWith("DELETE /api/admin") })
            } finally {
                forbidden = false
                runBlocking { app.session.logout() }
                File(app.filesDir, "a13-management").apply { mkdirs() }.resolve("requests.txt").writeText(calls.joinToString("\n"))
            }
        }
    }

    @Test fun workspaceConfigurationRunnerOfflineRecoveryAndCanonicalDeepLink() {
        resources = true
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue(app.session.state.value is AuthState.SignedOut)
        MockWebServer().use { server ->
            server.dispatcher = dispatcher()
            try {
                signIn(server)
                compose.onNodeWithTag("workspace:$workspaceId").performClick()
                compose.onNodeWithContentDescription("Workspace settings").performClick()
                await("Save workspace")
                compose.onNodeWithText("Workspace name").performScrollTo().performTextReplacement("Configured workspace")
                click("Save workspace")
                compose.waitUntil(10_000) { workspaceName == "Configured workspace" }
                click("Manage Runner: Controlled remote")
                await("Update engines now")
                compose.onNode(hasText("Update engines now") and hasClickAction()).performScrollTo().assertIsNotEnabled()
                capture("runner-offline")
                runnerOnline = true
                click("Refresh")
                compose.waitUntil(10_000) { compose.onAllNodes(hasText("Refresh model lists") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
                click("Refresh model lists")
                compose.waitUntil(10_000) { calls.any { it == "POST /api/runners/$runnerId/refresh-models" } }
                capture("runner-recovered")
                compose.activityRule.scenario.onActivity { activity ->
                    val original = activity.intent
                    MainActivity::class.java.getDeclaredMethod("onNewIntent", android.content.Intent::class.java).apply { isAccessible = true }
                        .invoke(activity, android.content.Intent(android.content.Intent.ACTION_VIEW,
                            android.net.Uri.parse("orbit://runner/$runnerId")).setClass(activity, MainActivity::class.java))
                    activity.intent = original
                }
                compose.waitUntil(10_000) { calls.contains("GET /api/runners/${io.orbitd.android.navigation.ObjectId.canonical(runnerId)}/login") }
                await("Save Runner settings")
                compose.onNode(hasText("Save Runner settings") and hasClickAction()).assertExists()
                capture("runner-deep-link")
                assertTrue(calls.contains("PATCH /api/workspaces/$workspaceId"))
            } finally {
                runBlocking { app.session.logout() }
                File(app.filesDir, "a13-management").apply { mkdirs() }.resolve("runner-requests.txt").writeText(calls.joinToString("\n"))
            }
        }
    }

    private fun signIn(server: MockWebServer) {
        runBlocking { app.session.login(ServerAddress.parse(server.url("/").toString(), true), "a13@example.test", "controlled-fixture") }
        compose.waitUntil(15_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
    }
    private fun settings() {
        compose.onNodeWithContentDescription("Open navigation").performClick()
        click("Settings")
        await("Edit profile")
    }
    private fun await(text: String) {
        compose.waitUntil(10_000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }
    }
    private fun click(text: String) {
        val node = compose.onNode(hasText(text) and hasClickAction())
        node.performScrollTo().performClick()
    }
    private fun back() { instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK); compose.waitForIdle() }
    private fun capture(label: String) {
        instrumentation.waitForIdleSync()
        val dir = File(app.filesDir, "a13-management").apply { mkdirs() }
        instrumentation.uiAutomation.takeScreenshot().let { bitmap ->
            File(dir, "$label.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }
    private fun user() = """{"id":"fixture-user","name":"$name","email":"a13@example.test","role":"$role","preferences":{"theme":"system","defaultPermissionMode":"auto","notifySessionFinished":false,"notifyAgentMessage":true}}"""
    private fun dispatcher() = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.requestUrl!!.encodedPath
            calls += "${request.method} $path"
            if (path !in listOf("/api/auth/login", "/api/auth/logout")) assertEquals("Bearer fixture-access", request.getHeader("Authorization"))
            if (path == "/api/users/me" && forbidden) return MockResponse().setResponseCode(403).setBody("{}")
            val body = when (path) {
                "/api/auth/login" -> """{"accessToken":"fixture-access","refreshToken":"fixture-refresh","user":${user()}}"""
                "/api/users/me" -> {
                    if (request.method == "PATCH") name = Json.parseToJsonElement(request.body.readUtf8()).jsonObject["name"]!!.jsonPrimitive.content
                    user()
                }
                "/api/admin/users" -> if (role == "ADMIN") "[${user()}]" else return MockResponse().setResponseCode(403).setBody("{}")
                "/api/share-links" -> """{"links":[${shareLink()}]}"""
                "/api/sessions/share-session/share" -> {
                    if (request.method == "PUT") shareTools = Json.parseToJsonElement(request.body.readUtf8()).jsonObject["include"]!!.jsonObject["toolOutput"]!!.jsonPrimitive.boolean
                    if (request.method == "DELETE") sharingActive = false
                    """{"link":${if (sharingActive) shareLink() else "null"},"counts":{"messages":2,"toolCalls":1}}"""
                }
                "/api/workspaces" -> if (resources) "[${workspace()}]" else "[]"
                "/api/workspaces/$workspaceId" -> {
                    if (request.method == "PATCH") workspaceName = Json.parseToJsonElement(request.body.readUtf8()).jsonObject["name"]!!.jsonPrimitive.content
                    workspace()
                }
                "/api/workspaces/$workspaceId/permission-rules" -> "[]"
                "/api/runners" -> if (resources) "[${runner()}]" else "[]"
                "/api/events" -> return MockResponse().setHeader("Content-Type", "text/event-stream")
                    .setChunkedBody(": connected\n\n".repeat(120), 13).throttleBody(13, 1, TimeUnit.SECONDS)
                "/api/auth/logout" -> "{}"
                else -> if (path.endsWith("/login") || path.endsWith("/refresh-models")) "{}" else "[]"
            }
            return MockResponse().setHeader("Content-Type", "application/json").setBody(body)
        }
    }
    private fun workspace() = """{"id":"$workspaceId","name":"$workspaceName","runnerId":"$runnerId","enabled":true,"workDir":"/tmp/fixture","modelRouting":false,"env":{}}"""
    private fun runner() = """{"id":"$runnerId","name":"Controlled remote","displayName":"Controlled remote","online":$runnerOnline,"lastHeartbeatAt":"${java.time.Instant.now()}","maxConcurrent":4,"activeSessions":0,"engines":[],"capabilities":[],"status":"${if (runnerOnline) "ONLINE" else "OFFLINE"}"}"""
    private fun shareLink() = """{"id":"share-link","token":"fixture-public-token","kind":"SESSION","state":"${if (sharingActive) "ACTIVE" else "ENDED"}","root":{"id":"share-session","title":"Fixture shared session"},"include":{"toolOutput":$shareTools},"viewCount":0}"""
}
