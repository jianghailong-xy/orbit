package io.orbitd.android.directory

import android.graphics.Bitmap
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.util.Base64
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.protocol.Wire
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** A05b on the isolated Orbit stack (scripts/a11-stack, run with main's server), signed in through the product's own
 * screen. GET /workspaces sends `position: null` for a workspace nobody has dragged; the drawer and the Workspaces page
 * list every workspace in iOS's order (AgentListLogic.ordered: the server's order, runner-less ones last) and the
 * directory never reads as unreadable. Run by tasks-projects-stack-device-test.sh with A11_TEST naming this class;
 * arguments (base64): a11Seed (its `server`), ownerEmail, ownerPassword. Captures go where that script collects them. */
@RunWith(AndroidJUnit4::class)
class DirectoryRealStackDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val output get() = File(app.filesDir, "a11-tasks-projects").also { it.mkdirs() }
    private fun arg(key: String) = String(Base64.decode(requireNotNull(InstrumentationRegistry.getArguments().getString(key)) { "missing argument $key" }, Base64.DEFAULT))
    private val server by lazy { Wire.json.parseToJsonElement(arg("a11Seed")).jsonObject.getValue("server").jsonPrimitive.content }
    private val reads = mutableListOf<String>()

    private fun http(method: String, path: String, body: String?, bearer: String?): String =
        (URL("$server/api$path").openConnection() as HttpURLConnection).run {
            connectTimeout = 10_000; readTimeout = 30_000; requestMethod = method
            bearer?.let { setRequestProperty("Authorization", "Bearer $it") }
            if (body != null) { doOutput = true; setRequestProperty("Content-Type", "application/json"); outputStream.use { it.write(body.toByteArray()) } }
            try { check(responseCode in 200..299) { "$method $path: HTTP $responseCode" }; inputStream.bufferedReader().use { it.readText() } }
            finally { disconnect() }
        }
    /** GET /workspaces as the signed-in account, in the order the server sends it. */
    private fun serverWorkspaces(): List<JsonObject> {
        val login = buildJsonObject { put("email", arg("ownerEmail")); put("password", arg("ownerPassword")) }.toString()
        val token = Wire.json.parseToJsonElement(http("POST", "/auth/login", login, null)).jsonObject.getValue("accessToken").jsonPrimitive.content
        return Wire.json.parseToJsonElement(http("GET", "/workspaces", null, token)).jsonArray.map { it.jsonObject }
    }
    private fun JsonObject.text(key: String) = (get(key) as? JsonPrimitive)?.contentOrNull
    /** The installed app's own build identity. `BuildConfig.X` in this file would be the test APK's compile-time copy. */
    private fun appBuild(field: String) = Class.forName("io.orbitd.android.BuildConfig", true, app.javaClass.classLoader).getField(field).get(null)

    private fun awaitText(text: String) { compose.waitUntil(30_000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() } }
    private fun top(matcher: SemanticsMatcher) = compose.onNode(matcher).fetchSemanticsNode().boundsInRoot.top
    private fun capture(name: String) {
        compose.waitForIdle(); SystemClock.sleep(700)
        instrument.uiAutomation.takeScreenshot().let { bitmap ->
            File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }
    private fun assertReadable() {
        compose.onAllNodesWithText("Couldn't load workspaces").assertCountEquals(0)
        compose.onAllNodesWithText("unreadable directory", substring = true).assertCountEquals(0)
    }

    @Test fun drawerListsAWorkspaceNobodyReorderedInIosOrder() {
        instrument.sendStatus(0, Bundle().apply { putString("a11_pid", Process.myPid().toString()) })
        try {
            reads += "app sha=${appBuild("SOURCE_SHA")} dirty=${appBuild("SOURCE_DIRTY")} server=$server"
            val answer = serverWorkspaces()
            answer.forEach { reads += "GET /workspaces: ${it.text("name")} position=${it["position"]} runnerId=${it.text("runnerId")} createdAt=${it.text("createdAt")}" }
            assertTrue("the stack has a workspace nobody has reordered", answer.any { it["position"] is JsonNull })
            val ios = (answer.filter { it.text("runnerId") != null } + answer.filter { it.text("runnerId") == null }).map { it.text("id")!! to it.text("name")!! }
            reads += "iOS order: ${ios.joinToString { it.second }}"

            compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
            if (app.session.state.value is AuthState.SignedIn) runBlocking { app.session.logout() }
            awaitText("Instance address")
            compose.onNodeWithText("Instance address").performTextReplacement(server)
            compose.onNodeWithText("Email").performTextReplacement(arg("ownerEmail"))
            compose.onNodeWithText("Password").performTextReplacement(arg("ownerPassword"))
            compose.onAllNodesWithText("Sign in")[1].performScrollTo().performClick()
            compose.waitUntil(30_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }

            // The Workspaces page: one row per workspace, top to bottom in iOS's order.
            ios.forEach { (id, _) -> compose.waitUntil(30_000) { compose.onAllNodesWithTag("workspace:$id").fetchSemanticsNodes().isNotEmpty() } }
            assertReadable()
            val home = ios.map { (id, _) -> top(hasTestTag("workspace:$id")) }
            reads += "Workspaces page tops: $home"
            assertEquals("Workspaces page order", home.sorted(), home)
            capture("a05b-workspaces")

            // The drawer, over that page: its rows are the nodes with the name and without the page row's tag.
            compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
            val rows = ios.map { (id, name) -> hasText(name) and !hasTestTag("workspace:$id") }
            rows.forEach { row -> compose.waitUntil(30_000) { compose.onAllNodes(row).fetchSemanticsNodes().isNotEmpty() } }
            assertReadable()
            val drawer = rows.map { top(it) }
            reads += "drawer tops: $drawer"
            assertEquals("drawer order", drawer.sorted(), drawer)
            capture("a05b-drawer")
        } catch (failure: Throwable) {
            capture("a05b-failed"); reads += "FAILED: $failure"; throw failure
        } finally {
            File(output, "a05b-readback.txt").writeText(reads.joinToString("\n"))
            runBlocking { app.session.logout() }
        }
    }
}
