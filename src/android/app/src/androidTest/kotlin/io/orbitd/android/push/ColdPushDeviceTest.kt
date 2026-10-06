package io.orbitd.android.push

import android.accessibilityservice.AccessibilityService
import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Process
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.BuildConfig
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.navigation.ObjectId
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Host owns ui.lock and the persistent push-cold-fixture.py server/reverse. Run prepare, force-stop
 * the target, then restoreAndApprove with PushTestRunner. No launcher Activity is created by this
 * rule: the restored process's first Activity receives the saved notification route as ACTION_VIEW.
 * This is controlled cold auth/navigation evidence, not FCM or a surviving tray tap after force-stop. */
@RunWith(AndroidJUnit4::class)
class ColdPushDeviceTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val server get() = InstrumentationRegistry.getArguments().getString("a10_server") ?: "http://127.0.0.1:18770"
    private val output get() = File(app.filesDir, "a10-push").apply { mkdirs() }
    private val sessionId = "34ZaIKKTQq8IdW0pn90xH"
    private var scenario: ActivityScenario<MainActivity>? = null
    private var launchIntent: Intent? = null
    private var clearSession = false

    @After fun close() {
        try { if (clearSession) runBlocking { app.push.beforeSignOut(); app.session.logout() } }
        finally { restoreMonitorIntent(); scenario?.close() }
    }

    @Test fun prepare() {
        requireTestApplication()
        launch(Intent(app, MainActivity::class.java))
        resetAndLogin()
        background()
        val data = alert()
        runBlocking { app.push.receive(data) }
        compose.waitUntil(10_000) { app.push.notifications.active().size == 1 }
        val stats = http("/__stats")
        val push = stats.getValue("push").jsonObject
        val binding = app.push.registration.activeBinding()!!
        assertEquals(1, push.getValue("registerCount").jsonPrimitive.int)
        val prepared = buildJsonObject {
            put("pid", Process.myPid()); put("sha", BuildConfig.SOURCE_SHA); put("dirty", BuildConfig.SOURCE_DIRTY)
            put("registrationKey", binding.registrationKey); put("installationId", push.getValue("installationId"))
            put("link", PushMessage.parse(data)!!.link!!)
            put("message", buildJsonObject { data.forEach { (key, value) -> put(key, value) } })
        }
        File(output, "cold-seed.json").writeText(prepared.toString())
        File(output, "cold-seed-stats.json").writeText(stats.toString())
        capture("cold-seed")
        reportPid()
        // Intentionally retain real encrypted credentials, binding and event history for the next process.
    }

    @Test fun restoreAndApprove() {
        requireTestApplication()
        clearSession = true
        val seed = Wire.json.parseToJsonElement(File(output, "cold-seed.json").readText()).jsonObject
        assertNotEquals("The host must terminate the seed process", seed.getValue("pid").jsonPrimitive.int, Process.myPid())
        assertEquals(BuildConfig.SOURCE_SHA, seed.getValue("sha").jsonPrimitive.content)
        val link = seed.getValue("link").jsonPrimitive.content
        launch(Intent(Intent.ACTION_VIEW, Uri.parse(link), app, MainActivity::class.java))
        compose.waitUntil(15_000) { app.session.state.value is AuthState.SignedIn && app.push.registration.activeBinding() != null }
        awaitCard()
        assertTrue(ObjectId.same(sessionId, app.realtime.state.value.session?.id))
        assertEquals(seed.getValue("registrationKey").jsonPrimitive.content, app.push.registration.activeBinding()!!.registrationKey)
        val restored = http("/__stats").getValue("push").jsonObject
        assertEquals(seed.getValue("installationId"), restored["installationId"])
        assertEquals("Process restoration must not unnecessarily rotate the binding", 1, restored.getValue("registerCount").jsonPrimitive.int)
        val data = seed.getValue("message").jsonObject.mapValues { it.value.jsonPrimitive.content }
        assertTrue("Retry event history must survive process death", app.push.notifications.hasSeen(PushMessage.parse(data)!!))
        capture("cold-actionable-card")
        compose.onNodeWithTag("approval:a1:ALLOW").performScrollTo().assertIsEnabled().performClick()
        compose.waitUntil(10_000) { http("/__stats")["pending"]?.jsonPrimitive?.boolean == false }
        awaitText("Allowed · recorded by the server")
        val after = http("/__stats")
        val decision = after.getValue("journal").jsonArray.single().jsonObject
        assertEquals("POST", decision.getValue("method").jsonPrimitive.content)
        assertEquals("/api/sessions/$sessionId/approvals/a1/decision", decision.getValue("path").jsonPrimitive.content)
        assertEquals(buildJsonObject { put("behavior", "allow") }, decision["body"])
        assertEquals("ALLOWED", after.getValue("final").jsonObject.getValue("status").jsonPrimitive.content)
        File(output, "cold-restore-stats.json").writeText(after.toString())
        File(output, "cold-restore-result.txt").writeText("PASS\npid=${Process.myPid()}\nsha=${BuildConfig.SOURCE_SHA}\n" +
            "New process; first Activity ACTION_VIEW; encrypted auth and unchanged binding/event history restored; real card and HTTP approval. Controlled fixture, not FCM/cold tray delivery.\n")
        capture("cold-approval-recorded")
        reportPid()
    }

    /** Select separately after host pm revoke POST_NOTIFICATIONS; revocation inside a live
     * instrumentation process would terminate that process. Requires API 33 or newer. */
    @Test fun runtimePermissionDeniedStillAllowsApproval() {
        requireTestApplication()
        clearSession = true
        assertTrue("Select this method only on Android 13+", Build.VERSION.SDK_INT >= 33)
        assertEquals(PackageManager.PERMISSION_DENIED, app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS))
        launch(Intent(app, MainActivity::class.java))
        resetAndLogin()
        scenario!!.onActivity { it.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("orbit-session:$sessionId"), app, MainActivity::class.java)) }
        awaitCard()
        restoreMonitorIntent()
        background()
        assertFalse(app.push.notifications.allowed())
        runBlocking { app.push.receive(alert()) }
        assertTrue(app.push.notifications.active().isEmpty())
        scenario!!.moveToState(Lifecycle.State.RESUMED)
        awaitCard()
        compose.onNodeWithTag("approval:a1:ALLOW").performScrollTo().performClick()
        compose.waitUntil(10_000) { http("/__stats")["pending"]?.jsonPrimitive?.boolean == false }
        awaitText("Allowed · recorded by the server")
        File(output, "runtime-denied-stats.json").writeText(http("/__stats").toString())
        File(output, "runtime-denied-result.txt").writeText("PASS\npid=${Process.myPid()}\npermission=POST_NOTIFICATIONS DENIED\n" +
            "No background notification; authenticated real SessionReader approval still succeeds over controlled HTTP.\n")
        capture("runtime-denied-business-success")
        reportPid()
    }

    private fun resetAndLogin() {
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        runBlocking { app.push.beforeSignOut(); app.session.logout() }
        http("/__push_reset", "{}")
        compose.waitUntil(10_000) { app.session.state.value is AuthState.SignedOut }
        compose.onNodeWithText("Instance address").performTextReplacement(server)
        compose.onNodeWithText("Email").performTextReplacement("a10@example.test")
        compose.onNodeWithText("Password").performTextReplacement("controlled-password")
        compose.onAllNodesWithText("Sign in")[1].performScrollTo().performClick()
        compose.waitUntil(15_000) { app.session.state.value is AuthState.SignedIn && app.push.registration.activeBinding() != null && app.realtime.state.value.directoryFresh }
    }
    private fun requireTestApplication() { check(app is PushTestApplication) { "Use PushTestRunner" } }
    private fun launch(intent: Intent) { launchIntent = Intent(intent); scenario = ActivityScenario.launch(intent) }
    private fun background() {
        restoreMonitorIntent()
        assertTrue(instrument.uiAutomation.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME))
        compose.waitUntil(10_000) { scenario?.state == Lifecycle.State.CREATED }
        instrument.waitForIdleSync()
    }
    private fun restoreMonitorIntent() {
        val original = launchIntent ?: return
        if (scenario?.state != Lifecycle.State.DESTROYED) scenario?.onActivity { it.intent = Intent(original) }
    }
    private fun awaitCard() = compose.waitUntil(15_000) { compose.onAllNodes(hasTestTag("approval:a1:ALLOW") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
    private fun awaitText(text: String) = compose.waitUntil(15_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    private fun alert() = mapOf("version" to "1", "type" to "alert", "registrationKey" to app.push.registration.activeBinding()!!.registrationKey,
        "eventId" to UUID.randomUUID().toString(), "notificationKey" to "approval-${ObjectId.canonical(sessionId)!!}", "sentAt" to "2026-10-05T00:00:00Z",
        "payload" to buildJsonObject { put("kind", "approval"); put("category", "ORBIT_APPROVAL"); put("sessionID", ObjectId.canonical(sessionId)!!)
            put("threadId", ObjectId.canonical(sessionId)!!)
            put("title", "A10 cold approval"); put("body", "Controlled pending approval for cold navigation.") }.toString())
    private fun http(path: String, body: String? = null): JsonObject = (URL(server + path).openConnection() as HttpURLConnection).run {
        connectTimeout = 5000; readTimeout = 5000
        if (body != null) { requestMethod = "POST"; doOutput = true; outputStream.use { it.write(body.encodeToByteArray()) } }
        try { check(responseCode == 200); Wire.json.parseToJsonElement(inputStream.bufferedReader().use { it.readText() }).jsonObject }
        finally { disconnect() }
    }
    private fun capture(name: String) {
        instrument.uiAutomation.takeScreenshot()?.let { image -> File(output, "$name.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }; image.recycle() }
    }
    private fun reportPid() = instrument.sendStatus(0, Bundle().apply { putString("a10_pid", Process.myPid().toString()) })
}
