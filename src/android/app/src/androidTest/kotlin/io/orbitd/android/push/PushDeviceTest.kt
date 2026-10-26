package io.orbitd.android.push

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Activity
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.provider.Settings
import android.service.notification.StatusBarNotification
import android.view.InputDevice
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkInfo
import androidx.work.WorkManager
import io.orbitd.android.BuildConfig
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.auth.chooseServer
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.navigation.ObjectId
import java.io.File
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestName
import org.junit.runner.RunWith

/** Controlled HTTP + the real Application/Activity/notification tray. This does not send via FCM.
 * Run using PushTestRunner under the host's exclusive device lock on a dedicated debug install. */
@RunWith(AndroidJUnit4::class)
class PushDeviceTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val name = TestName()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val manager get() = app.getSystemService(NotificationManager::class.java)
    private val evidence get() = File(app.filesDir, "a10-push").apply { mkdirs() }
    private lateinit var fixture: PushHttpFixture
    private var appNotificationsOff = false
    private val queuedWork = mutableListOf<String>()
    private val activities = CopyOnWriteArrayList<MainActivity>()
    private val startedActivities = CopyOnWriteArrayList<MainActivity>()
    @Volatile private var currentActivity: MainActivity? = null
    @Volatile private var resumedActivity: MainActivity? = null
    // ActivityScenario keys its monitor by the launch Intent. Notification identifiers and
    // ACTION_VIEW legitimately change that Intent, so observe actual instances without filtering.
    private val lifecycle = object : Application.ActivityLifecycleCallbacks {
        override fun onActivityCreated(activity: Activity, state: Bundle?) {
            if (activity is MainActivity) { activities.addIfAbsent(activity); currentActivity = activity }
        }
        override fun onActivityStarted(activity: Activity) {
            if (activity is MainActivity) { startedActivities.addIfAbsent(activity); currentActivity = activity }
        }
        override fun onActivityResumed(activity: Activity) {
            if (activity is MainActivity) { resumedActivity = activity; currentActivity = activity }
        }
        override fun onActivityPaused(activity: Activity) { if (resumedActivity === activity) resumedActivity = null }
        override fun onActivityStopped(activity: Activity) { if (activity is MainActivity) startedActivities.remove(activity) }
        override fun onActivityDestroyed(activity: Activity) {
            if (activity !is MainActivity) return
            activities.remove(activity); startedActivities.remove(activity)
            if (currentActivity === activity) currentActivity = activities.lastOrNull()
            if (resumedActivity === activity) resumedActivity = null
        }
        override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit
    }

    @Before fun prepare() {
        check(app is PushTestApplication) { "Run with io.orbitd.android.push.PushTestRunner" }
        instrument.runOnMainSync { app.registerActivityLifecycleCallbacks(lifecycle) }
        instrument.startActivitySync(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        awaitCondition { resumedActivity != null }
        instrument.sendStatus(0, Bundle().apply { putString("a10_pid", Process.myPid().toString()) })
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        runBlocking { app.push.beforeSignOut(); app.session.logout() }
        fixture = PushHttpFixture(instrument.context.assets.open("push/interaction-cards.fixture.json").bufferedReader().use { it.readText() })
        fixture.server.start()
        File(evidence, "${name.methodName}-identity.txt").writeText(
            "sha=${BuildConfig.SOURCE_SHA}\ndirty=${BuildConfig.SOURCE_DIRTY}\napi=${Build.VERSION.SDK_INT}\n" +
                "build=${Build.DISPLAY}\npid=${Process.myPid()}\ntransport=controlled HTTP and token source; no FCM\n")
    }

    @After fun finish() {
        try {
            queuedWork.forEach { WorkManager.getInstance(app).cancelUniqueWork(it).result.get(5, TimeUnit.SECONDS) }
            if (appNotificationsOff) setAppNotificationsInSettings(true)
            // Recreate a deliberately removed channel; this does not override user-changed importance.
            PushNotifications(app)
            if (::fixture.isInitialized) {
                File(evidence, "${name.methodName}-journal.json").writeText(fixture.journal().toString())
                capture("${name.methodName}-final")
                runBlocking { app.push.beforeSignOut(); app.session.logout() }
                fixture.server.shutdown()
            }
        } finally {
            try {
                instrument.runOnMainSync { activities.toList().forEach { it.finish() } }
                awaitCondition { activities.isEmpty() }
            } finally { instrument.runOnMainSync { app.unregisterActivityLifecycleCallbacks(lifecycle) } }
        }
    }

    @Test fun backgroundTrayTapUsesRealReaderAndApprovalEndpoint() {
        login()
        background()
        val message = alert()
        deliver(message)
        awaitNotifications(1)
        val first = manager.activeNotifications.single { it.tag?.startsWith("orbit:") == true }
        assertEquals("A10 approval", first.notification.extras.getString(Notification.EXTRA_TITLE))
        assertTrue(first.notification.flags and Notification.FLAG_ONLY_ALERT_ONCE != 0)
        deliver(message)
        assertEquals(first.postTime, manager.activeNotifications.single { it.tag == first.tag }.postTime)
        deliver(alert()) // A new event for the same semantic reminder replaces one tray entry.
        awaitNotifications(1)
        tapTrayNotification()
        awaitCard()
        assertTrue(ObjectId.same(fixture.sessionId, app.realtime.state.value.session?.id))
        capture("tray-tap-actionable")
        compose.onNodeWithTag("approval:a1:ALLOW").performScrollTo().performClick()
        compose.waitUntil(10_000) { fixture.decisions.size == 1 && !fixture.pending }
        awaitText("Allowed · recorded by the server")
        assertEquals(buildJsonObject { put("behavior", "allow") }, fixture.decisions.single())
        assertTrue(fixture.requests.filter { it.path?.startsWith("/api/sessions/") == true }
            .all { it.getHeader("Authorization") == "Bearer ${fixture.accessToken}" })
        pass()
    }

    /** A11h (A11-9's push, iOS 6b4bef713 `Notifications.intent` → `openProjectSessions(_:inColumn: false)`): the tray tap of a merge into
     * main waiting on the owner delivers `orbit://project/<id>` and opens the project's sessions page as its root — the session showing
     * before goes and the drawer's button leads — with the merge card to press, not the coordinator conversation the payload names. */
    @Test fun mergeTrayTapOpensProjectSessionsPageAsRoot() {
        fixture.project = true; fixture.pending = false
        login(); openSession()
        compose.waitUntil(10_000) { compose.onAllNodesWithContentDescription("Back").fetchSemanticsNodes().isNotEmpty() }
        background()
        deliver(envelope("alert", buildJsonObject {
            put("title", "A11h merge"); put("body", "Merge 1 task into main?"); put("category", "ORBIT_OWNER_ITEM")
            put("kind", "approve-merge-to-main"); put("sessionID", fixture.sessionId); put("projectID", fixture.projectId)
            put("openItemID", fixture.itemId); put("threadId", fixture.projectId)
        }, key = "owner-item-${fixture.itemId}"))
        awaitNotifications(1)
        tapTrayNotification("A11h merge")
        awaitCondition { resumedActivity?.intent?.dataString == "orbit://project/${fixture.projectId}" }
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("project-merge-card:asking").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("project-sessions").assertExists()
        compose.onNodeWithContentDescription("Back").assertDoesNotExist()
        compose.onNodeWithContentDescription("Open navigation").assertExists()
        assertNull("the coordinator conversation is not what opened", app.realtime.state.value.session)
        capture("merge-tray-root")
        pass()
    }

    @Test fun foregroundDedupAndOtherEndResolutionClearTrayAndRealCard() {
        login(); openSession(); awaitCard()
        val foregroundEvent = alert()
        deliver(foregroundEvent)
        assertTrue(app.push.notifications.hasSeen(PushMessage.parse(foregroundEvent)!!))
        awaitNotifications(0)
        background(); deliver(foregroundEvent); awaitNotifications(0)
        deliver(alert()); awaitNotifications(1)
        fixture.pending = false // Authoritative fixture transition by the other end, not push state.
        deliver(sync())
        awaitNotifications(0)
        foreground()
        compose.waitUntil(10_000) { app.realtime.state.value.session?.fresh == true && app.realtime.state.value.session?.snapshot?.approvals?.isEmpty() == true }
        compose.onNodeWithTag("approval:a1:ALLOW").assertDoesNotExist()
        capture("sync-cleared-card")

        fixture.pending = true
        compose.runOnIdle { app.realtime.refreshSession(); app.realtime.refreshDirectory() }
        awaitCard()
        background(); deliver(alert()); awaitNotifications(1)
        fixture.pending = false
        foreground() // No sync: the production foreground REST fallback must do both updates.
        awaitNotifications(0)
        compose.waitUntil(10_000) { app.realtime.state.value.session?.snapshot?.approvals?.isEmpty() == true }
        compose.onNodeWithTag("approval:a1:ALLOW").assertDoesNotExist()
        assertTrue(fixture.decisions.isEmpty())
        capture("resume-cleared-card")
        pass()
    }

    @Test fun pendingNotificationIntentSurvivesSignOutAndActivityRecreation() {
        login(); background(); val oldMessage = alert(); deliver(oldMessage); awaitNotifications(1)
        val pending = manager.activeNotifications.single { it.tag?.startsWith("orbit:") == true }.notification.contentIntent
        runBlocking { app.push.beforeSignOut(); app.session.logout() }
        awaitNotifications(0)
        foreground()
        // Captured system PendingIntent models a tap already dispatched when authentication expires.
        pending.send()
        awaitCondition { resumedActivity?.intent?.action == Intent.ACTION_VIEW }
        awaitText("Welcome back")
        val previous = currentActivity!!
        instrument.runOnMainSync { previous.recreate() }
        awaitCondition { resumedActivity != null && resumedActivity !== previous && previous !in activities }
        login()
        awaitCard()
        assertTrue(ObjectId.same(fixture.sessionId, app.realtime.state.value.session?.id))
        assertFalse(app.push.registration.accepts(oldMessage.getValue("registrationKey")))
        background(); deliver(oldMessage); awaitNotifications(0)
        foreground(); awaitCard()
        capture("pending-intent-after-auth")
        pass()
    }

    @Test fun missingForbiddenOfflineAndStaleReminderUseAuthority() {
        login(); background()
        for (failure in listOf(403, 404, 503)) {
            fixture.sessionFailure = failure
            deliver(alert()); awaitNotifications(0)
        }
        fixture.sessionFailure = 0; fixture.pending = false
        deliver(alert()); awaitNotifications(0)
        fixture.pending = true
        deliver(alert()); awaitNotifications(1)
        fixture.sessionFailure = 403 // Access changed after the notification was displayed.
        tapTrayNotification()
        awaitText("Session unavailable")
        awaitText("You don't have permission to access this item.")
        compose.onNodeWithTag("approval:a1:ALLOW").assertDoesNotExist()
        assertTrue(fixture.decisions.isEmpty())
        capture("tap-authoritative-forbidden")
        pass()
    }

    @Test fun notificationDenialAndUnavailableChannelDoNotBreakApprovalFlow() {
        login(); openSession(); awaitCard()
        assertTrue("Host must grant notification permission for the default journey", app.push.notifications.allowed())
        if (Build.VERSION.SDK_INT < 33) {
            // API 29–32 have no runtime permission: a person turns the app's notifications off in
            // Android's notification settings (the legacy app-op does not). On 13+ that switch is the
            // POST_NOTIFICATIONS grant, refused in its own process by ColdPushDeviceTest.permissionPrompt.
            setAppNotificationsInSettings(false)
            background(); deliver(alert()); awaitNotifications(0)
            setAppNotificationsInSettings(true)
        } else background()
        manager.deleteNotificationChannel(PushNotifications.NEEDS_YOU)
        assertFalse(app.push.notifications.allowed(PushNotifications.NEEDS_YOU))
        deliver(alert()); awaitNotifications(0)
        PushNotifications(app)
        foreground(); awaitCard()
        compose.onNodeWithTag("approval:a1:ALLOW").performScrollTo().performClick()
        compose.waitUntil(10_000) { fixture.decisions.size == 1 && !fixture.pending }
        awaitText("Allowed · recorded by the server")
        capture("denied-channel-business-success")
        pass()
    }

    @Test fun accountSwitchClearsOldGenerationAndRetainsInstallation() {
        login(); background()
        val old = alert(); deliver(old); awaitNotifications(1)
        val first = fixture.registrations.last()
        foreground()
        compose.onNodeWithContentDescription("Open navigation").performClick()
        compose.onNodeWithText("Settings").performScrollTo().performClick()
        // A13's Settings asks "Sign out?" first, as iOS does.
        compose.onNodeWithText("Sign out").performScrollTo().performClick()
        compose.onNode(hasText("Sign out") and hasAnyAncestor(isDialog())).performClick()
        compose.waitUntil(10_000) { app.session.state.value is AuthState.SignedOut }
        awaitNotifications(0)
        login("second@example.test")
        val current = fixture.registrations.last()
        assertEquals(first["installationId"], current["installationId"])
        assertNotEquals(old.getValue("registrationKey"), app.push.registration.activeBinding()!!.registrationKey)
        assertEquals("second", app.push.registration.activeBinding()!!.accountId)
        background(); deliver(old); awaitNotifications(0)
        deliver(alert()); awaitNotifications(1)
        assertEquals(1, fixture.unregisterCount)
        capture("second-account-new-generation")
        pass()
    }

    @Test fun foregroundNoticeOpensUnfocusedRealSessionAndDeduplicates() {
        login()
        assertNull(app.realtime.state.value.session)
        val message = alert()
        deliver(message)
        compose.waitUntil(10_000) { app.push.notice.value?.eventId == message.getValue("eventId") }
        compose.onNodeWithTag("notification-notice").assertIsDisplayed()
        awaitNotifications(1)
        assertSilent(orbitEntries().single())
        capture("foreground-notice")
        compose.onNode(hasText("Open") and hasAnyAncestor(hasTestTag("notification-notice"))).performClick()
        awaitCard()
        assertTrue(ObjectId.same(fixture.sessionId, app.realtime.state.value.session?.id))
        compose.waitUntil(10_000) { app.push.notice.value == null }
        deliver(message)
        assertNull(app.push.notice.value)
        compose.onNodeWithTag("notification-notice").assertDoesNotExist()
        compose.onNodeWithTag("approval:a1:ALLOW").assertIsEnabled()
        capture("foreground-notice-actionable")
        pass()
    }

    /** iOS lists every foreground alert in Notification Center; here it stays in the tray without sound
     * or heads-up. Only the focused session's own approval stays out, because its card is on screen. */
    @Test fun foregroundAlertsStayInTheTraySilentlyExceptTheFocusedApproval() {
        login()
        assertNull(app.realtime.state.value.session)
        val agentMessage = UUID.randomUUID().toString()
        deliver(envelope("alert", buildJsonObject {
            put("title", "A10 agent message"); put("body", "An agent wrote without naming a session."); put("kind", "agent-message")
        }, key = agentMessage))
        awaitNotifications(1)
        assertSilent(orbitEntries().single())
        val approval = alert()
        deliver(approval)
        compose.waitUntil(10_000) { app.push.notice.value?.eventId == approval.getValue("eventId") }
        awaitNotifications(2)
        orbitEntries().forEach(::assertSilent)
        background() // Leaving the app keeps both reminders in the tray.
        awaitNotifications(2)
        foreground()
        compose.onNode(hasText("Open") and hasAnyAncestor(hasTestTag("notification-notice"))).performClick()
        awaitCard()
        instrument.runOnMainSync { manager.cancelAll() }
        awaitNotifications(0)
        deliver(alert()) // A new event for the approval whose card is on screen.
        SystemClock.sleep(1_000)
        awaitNotifications(0)
        assertNull(app.push.notice.value)
        File(evidence, "foreground-tray-result.txt").writeText("agentMessageKey=$agentMessage\n" +
            "Foreground agent message and unfocused approval stayed in the tray silently (group ${PushNotifications.SILENT_GROUP}, " +
            "GROUP_ALERT_SUMMARY) and after Home; the focused session's approval was not added.\n")
        pass()
    }

    @Test fun backgroundWorkerRetriesAuthorityAndRejectsOldAccountBinding() {
        login(); background()
        fixture.sessionFailure = 503
        val message = alert()
        val work = enqueue(message)
        awaitCondition(30_000) { workInfo(work)?.let { it.state == WorkInfo.State.ENQUEUED && it.runAttemptCount >= 1 } == true }
        assertTrue(fixture.requests.any { it.requestUrl?.encodedPath == "/api/sessions/${fixture.sessionId}" })
        awaitNotifications(0)
        val failedAttempts = workInfo(work)!!.runAttemptCount
        fixture.sessionFailure = 0
        awaitCondition(45_000) { workInfo(work)?.state == WorkInfo.State.SUCCEEDED }
        awaitNotifications(1)
        assertTrue(workInfo(work)!!.runAttemptCount > failedAttempts)
        capture("worker-recovered-background-notification")

        fixture.sessionFailure = 503
        val oldMessage = alert()
        val oldWork = enqueue(oldMessage)
        awaitCondition(30_000) { workInfo(oldWork)?.let { it.state == WorkInfo.State.ENQUEUED && it.runAttemptCount >= 1 } == true }
        foreground()
        runBlocking { app.push.beforeSignOut(); app.session.logout() }
        login("second@example.test")
        fixture.sessionFailure = 0
        background()
        awaitCondition(45_000) { workInfo(oldWork)?.state == WorkInfo.State.SUCCEEDED }
        awaitNotifications(0)
        assertFalse(app.push.registration.accepts(oldMessage.getValue("registrationKey")))
        File(evidence, "worker-attempts.txt").writeText("successfulAttempts=${workInfo(work)!!.runAttemptCount}\n" +
            "oldBindingAttempts=${workInfo(oldWork)!!.runAttemptCount}\noldBindingFinishedWithoutNotification=true\n")
        pass()
    }

    private fun login(email: String = "first@example.test") {
        compose.waitUntil(10_000) { app.session.state.value is AuthState.SignedOut }
        compose.chooseServer(fixture.server.url("/").toString())
        compose.onNodeWithText("Email").performTextReplacement(email)
        compose.onNodeWithText("Password").performTextReplacement("controlled-password")
        compose.onNodeWithText("Sign In").performScrollTo().performClick()
        compose.waitUntil(15_000) { app.session.state.value is AuthState.SignedIn && app.push.registration.activeBinding() != null && app.realtime.state.value.directoryFresh }
    }
    private fun openSession() {
        instrument.runOnMainSync { currentActivity!!.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("orbit-session:${fixture.sessionId}"), app, MainActivity::class.java)) }
        compose.waitUntil(10_000) { ObjectId.same(fixture.sessionId, app.realtime.state.value.session?.id) }
    }
    /** Actions are disabled while a refresh this module requested is in flight; wait for the fresh card. */
    private fun awaitCard() {
        val enabled = hasTestTag("approval:a1:ALLOW") and isEnabled()
        compose.waitUntil(15_000) { compose.onAllNodes(enabled).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("approval:a1:ALLOW").performScrollTo()
        compose.waitUntil(15_000) { compose.onAllNodes(enabled).fetchSemanticsNodes().isNotEmpty() }
    }
    private fun awaitText(text: String) = compose.waitUntil(15_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    private fun background() {
        assertTrue(instrument.uiAutomation.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME))
        awaitCondition { resumedActivity == null && startedActivities.isEmpty() }
        instrument.waitForIdleSync()
    }
    private fun foreground() {
        instrument.runOnMainSync { app.startActivity(Intent(Intent.ACTION_MAIN, null, app, MainActivity::class.java)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)) }
        awaitCondition { resumedActivity != null }
        instrument.waitForIdleSync()
    }
    private fun enqueue(data: Map<String, String>): String {
        val key = "orbit-push:${data.getValue("registrationKey")}:${data.getValue("eventId")}"
        queuedWork += key
        PushWorker.enqueue(app, data, true)
        return key
    }
    private fun workInfo(key: String): WorkInfo? = WorkManager.getInstance(app).getWorkInfosForUniqueWork(key).get(5, TimeUnit.SECONDS).singleOrNull()
    private fun deliver(data: Map<String, String>) = runBlocking { app.push.receive(data) }
    private fun alert(): Map<String, String> = envelope("alert", buildJsonObject {
        put("title", "A10 approval"); put("body", "Read the current controlled session before deciding.")
        put("category", "ORBIT_APPROVAL"); put("kind", "approval"); put("sessionID", fixture.sessionId)
        put("threadId", fixture.sessionId)
    })
    private fun sync() = envelope("sync", buildJsonObject { put("badge", 0); put("clearSessions", JsonArray(listOf(JsonPrimitive(fixture.sessionId)))) })
    private fun envelope(type: String, payload: JsonObject, key: String? = null) = mapOf("version" to "1", "type" to type,
        "registrationKey" to app.push.registration.activeBinding()!!.registrationKey, "eventId" to UUID.randomUUID().toString(),
        "notificationKey" to (key ?: if (type == "sync") "badge-sync" else "approval-${fixture.sessionId}"),
        "sentAt" to "2026-10-05T00:00:00Z", "payload" to payload.toString())
    private fun orbitEntries() = manager.activeNotifications.filter { it.tag?.startsWith("orbit:") == true }
    private fun awaitNotifications(count: Int) = awaitCondition { orbitEntries().size == count }
    private fun assertSilent(entry: StatusBarNotification) {
        assertEquals(PushNotifications.SILENT_GROUP, entry.notification.group)
        assertEquals(Notification.GROUP_ALERT_SUMMARY, entry.notification.groupAlertBehavior)
    }
    private fun awaitCondition(timeoutMillis: Long = 15_000, check: () -> Boolean) {
        val until = SystemClock.elapsedRealtime() + timeoutMillis
        while (!check()) {
            if (SystemClock.elapsedRealtime() >= until) {
                capture("${name.methodName}-timeout")
                dumpHierarchy("${name.methodName}-timeout")
                fail("Timed out waiting for Android notification state")
            }
            SystemClock.sleep(100)
        }
    }
    private fun tapTrayNotification(title: String = "A10 approval") {
        val service = instrument.uiAutomation.serviceInfo
        service.flags = service.flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        instrument.uiAutomation.serviceInfo = service
        assertTrue(instrument.uiAutomation.performGlobalAction(AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS))
        instrument.uiAutomation.waitForIdle(1_000, 10_000)
        var target: Rect? = null
        var stableSince = SystemClock.elapsedRealtime()
        fun findTitle(node: AccessibilityNodeInfo?, depth: Int): Rect? {
            if (node == null || depth > 30) return null
            if (node.isVisibleToUser && node.text?.toString() == title) {
                val bounds = Rect()
                node.getBoundsInScreen(bounds)
                if (!bounds.isEmpty && bounds.centerX() >= 0 && bounds.centerY() >= 0) return bounds
            }
            for (index in 0 until node.childCount) findTitle(node.getChild(index), depth + 1)?.let { return it }
            return null
        }
        awaitCondition {
            val roots = instrument.uiAutomation.windows.mapNotNull { it.root } + listOfNotNull(instrument.uiAutomation.rootInActiveWindow)
            val current = roots.firstNotNullOfOrNull { findTitle(it, 0) }
            if (current != target) { target = current; stableSince = SystemClock.elapsedRealtime() }
            target != null && SystemClock.elapsedRealtime() - stableSince >= 750
        }
        capture("${name.methodName}-tray")
        val bounds = target!!
        val downTime = SystemClock.uptimeMillis()
        fun touch(action: Int): Boolean {
            val event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action,
                bounds.exactCenterX(), bounds.exactCenterY(), 0).apply { source = InputDevice.SOURCE_TOUCHSCREEN }
            return try { instrument.uiAutomation.injectInputEvent(event, true) } finally { event.recycle() }
        }
        // SystemUI on some emulator builds exposes the title but rejects accessibility ACTION_CLICK.
        // Use one real touch at the currently visible title, never a direct PendingIntent invocation.
        val down = touch(MotionEvent.ACTION_DOWN)
        SystemClock.sleep(60)
        val up = touch(MotionEvent.ACTION_UP)
        File(evidence, "${name.methodName}-tray-touch.txt").writeText("titleBounds=$bounds\ndown=$down\nup=$up\n")
        assertTrue("Notification title touch must enter the system input stream", down && up)
        awaitCondition { resumedActivity?.intent?.action == Intent.ACTION_VIEW }
    }
    private fun tapAt(bounds: Rect) {
        val downTime = SystemClock.uptimeMillis()
        fun touch(action: Int): Boolean {
            val event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action,
                bounds.exactCenterX(), bounds.exactCenterY(), 0).apply { source = InputDevice.SOURCE_TOUCHSCREEN }
            return try { instrument.uiAutomation.injectInputEvent(event, true) } finally { event.recycle() }
        }
        assertTrue(touch(MotionEvent.ACTION_DOWN))
        SystemClock.sleep(60)
        assertTrue(touch(MotionEvent.ACTION_UP))
    }
    private fun dumpHierarchy(label: String) {
        val text = StringBuilder()
        fun visit(node: AccessibilityNodeInfo?, depth: Int) {
            if (node == null || depth > 30) return
            val bounds = Rect().also(node::getBoundsInScreen)
            text.append(" ".repeat(depth)).append(node.className).append(" text=").append(node.text)
                .append(" description=").append(node.contentDescription).append(" clickable=").append(node.isClickable)
                .append(" visible=").append(node.isVisibleToUser).append(" bounds=").append(bounds).append('\n')
            for (index in 0 until node.childCount) visit(node.getChild(index), depth + 1)
        }
        val roots = instrument.uiAutomation.windows.mapNotNull { it.root } + listOfNotNull(instrument.uiAutomation.rootInActiveWindow)
        roots.forEach { visit(it, 0) }
        File(evidence, "$label-hierarchy.txt").writeText(text.toString())
    }
    /** The app-level switch in Android's notification settings (API 29–32), operated as a person does. */
    private fun setAppNotificationsInSettings(enabled: Boolean) {
        instrument.runOnMainSync {
            app.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, app.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        val service = instrument.uiAutomation.serviceInfo
        service.flags = service.flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        instrument.uiAutomation.serviceInfo = service
        fun find(node: AccessibilityNodeInfo?, depth: Int): AccessibilityNodeInfo? {
            if (node == null || depth > 40) return null
            if (node.isVisibleToUser && node.isCheckable && node.packageName == "com.android.settings") return node
            for (index in 0 until node.childCount) find(node.getChild(index), depth + 1)?.let { return it }
            return null
        }
        var master: AccessibilityNodeInfo? = null
        // The first switch on the page is the app's own; the channel switches follow it.
        awaitCondition { master = (instrument.uiAutomation.windows.mapNotNull { it.root } + listOfNotNull(instrument.uiAutomation.rootInActiveWindow))
            .firstNotNullOfOrNull { find(it, 0) }; master != null }
        // Android 10's switch bar takes the click, not the switch node: tap it as a finger does.
        if (master!!.isChecked != enabled) tapAt(Rect().also(master!!::getBoundsInScreen))
        awaitCondition { manager.areNotificationsEnabled() == enabled }
        appNotificationsOff = !enabled
        capture("${name.methodName}-settings-${if (enabled) "on" else "off"}")
        assertTrue(instrument.uiAutomation.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK))
        instrument.waitForIdleSync()
    }
    private fun capture(label: String) {
        SystemClock.sleep(1_000) // The emulator's software renderer presents frames after the UI state settles.
        instrument.uiAutomation.takeScreenshot()?.let { bitmap ->
            File(evidence, "$label.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
    }
    private fun pass() { File(evidence, "${name.methodName}-result.txt").writeText("PASS\nControlled token/HTTP, real Android notification and product UI. No real FCM or cold-process claim.\n") }
}

/** Keeps the fixed shared a1 approval unchanged; unrelated project/task standing is omitted here. */
private class PushHttpFixture(corpus: String) {
    private val snapshot = Wire.json.parseToJsonElement(corpus).jsonObject.getValue("snapshot").jsonObject
    val sessionId = ObjectId.canonical(snapshot.getValue("detail").jsonObject.getValue("id").jsonPrimitive.content)!!
    val server = MockWebServer()
    val requests = CopyOnWriteArrayList<RecordedRequest>()
    val decisions = CopyOnWriteArrayList<JsonObject>()
    val registrations = CopyOnWriteArrayList<JsonObject>()
    val accessToken get() = listOf("a10", "controlled", "access", account).joinToString("-")
    @Volatile var pending = true
    @Volatile var sessionFailure = 0
    /** A11h: the session coordinates a project, and a merge into main ([itemId]) waits on the owner there. */
    @Volatile var project = false
    val projectId = "019a11a9-0000-7000-8000-000000000003"
    val itemId = "019a11a9-0000-7000-8000-000000000004"
    @Volatile var unregisterCount = 0
    @Volatile private var account = "first"
    private val registrationLock = Any()
    private var registered: JsonObject? = null
    private var registeredAccount: String? = null
    private var registrationKey: String? = null
    private val uuid = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
    private val workspace = "01a0cca7-8609-70ed-a0e2-d4b55b832b61"

    init { server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            requests += request
            val path = request.requestUrl!!.encodedPath
            fun json(value: JsonElement = buildJsonObject {}): MockResponse = MockResponse().setHeader("Content-Type", "application/json").setBody(value.toString())
            if (path == "/api/auth/login") {
                val email = Wire.json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject.getValue("email").jsonPrimitive.content
                account = if (email.startsWith("second")) "second" else "first"
                return json(buildJsonObject {
                    put("accessToken", accessToken); put("refreshToken", listOf("a10", "controlled", "refresh", account).joinToString("-"))
                    put("user", buildJsonObject { put("id", account); put("name", account); put("email", email) })
                })
            }
            if (path == "/api/auth/logout") return json()
            if (request.getHeader("Authorization") != "Bearer $accessToken") return MockResponse().setResponseCode(401).setBody("{}")
            if (path in setOf("/api/push/register", "/api/push/unregister")) {
                if (request.method != "POST") return MockResponse().setResponseCode(405).setBody("{}")
                val body = runCatching { Wire.json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject }.getOrNull()
                    ?: return MockResponse().setResponseCode(400).setBody("{}")
                fun string(key: String) = (body[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
                val token = string("token")
                if (string("platform") != "android" || token == null || token.length !in 1..4096) {
                    return MockResponse().setResponseCode(400).setBody("{}")
                }
                if (path == "/api/push/register") {
                    val installation = string("installationId")
                    if (body.keys.any { it !in setOf("platform", "token", "bundleId", "environment", "installationId") } ||
                        string("bundleId") != "io.orbitd.android.debug" ||
                        (body["environment"] != null && body["environment"] != JsonNull && string("environment") != "production") ||
                        installation == null || !uuid.matches(installation) || UUID.fromString(installation).version() != 4 ||
                        UUID.fromString(installation).variant() != 2) {
                        return MockResponse().setResponseCode(400).setBody("{}")
                    }
                    synchronized(registrationLock) {
                        registrations += body
                        registered = body; registeredAccount = account; registrationKey = UUID.randomUUID().toString()
                        return json(buildJsonObject { put("ok", true); put("registrationKey", registrationKey) })
                    }
                }
                val key = string("registrationKey")
                if (body.keys.any { it !in setOf("platform", "token", "registrationKey") } || key == null || !uuid.matches(key)) {
                    return MockResponse().setResponseCode(400).setBody("{}")
                }
                synchronized(registrationLock) {
                    unregisterCount++
                    // Same owner + platform + token + generation; a valid but stale logout is a no-op.
                    if (registeredAccount == account && registered?.get("token") == body["token"] && key == registrationKey) {
                        registered = null; registeredAccount = null; registrationKey = null
                    }
                    return json(buildJsonObject { put("ok", true) })
                }
            }
            if (path.contains("/sessions/") && sessionFailure != 0) return MockResponse().setResponseCode(sessionFailure).setBody("{}")
            if (path.endsWith("/approvals/a1/decision")) {
                val body = Wire.json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                decisions += body; pending = false
                return json(buildJsonObject { put("id", "a1"); put("status", "ALLOWED") })
            }
            return when {
                path == "/api/users/me" -> json(buildJsonObject { put("id", account); put("preferences", buildJsonObject {}) })
                path == "/api/workspaces" -> json(JsonArray(listOf(buildJsonObject { put("id", workspace); put("name", "A10 controlled workspace"); put("enabled", true) })))
                path == "/api/sessions" -> json(JsonArray(if (request.requestUrl!!.queryParameter("view") == "open") listOf(detail()) else emptyList()))
                path.matches(Regex("/api/sessions/[^/]+")) -> json(detail())
                path.endsWith("/approvals") -> json(JsonArray(if (pending) snapshot.getValue("approvals").jsonArray.filter { it.jsonObject["id"]?.jsonPrimitive?.content == "a1" } else emptyList()))
                path.endsWith("/events/page") -> json(buildJsonObject {
                    put("events", JsonArray(listOf(buildJsonObject { put("seq", 1); put("type", "assistant"); put("payload", buildJsonObject { put("text", "A10 controlled session; approve only after reading the current card.") }) })))
                    put("hasMore", false); put("after", JsonNull)
                })
                path == "/api/tasks/evidence-decisions/pending" -> json(buildJsonObject { put("count", 0); put("pending", JsonArray(emptyList())) })
                project && path == "/api/projects/$projectId" -> json(projectRow())
                project && path in setOf("/api/projects", "/api/projects/sidebar") -> json(JsonArray(listOf(projectRow())))
                project && path == "/api/projects/$projectId/open-items" -> json(buildJsonObject {
                    put("needsYou", JsonArray(listOf(buildJsonObject { put("itemId", itemId); put("assignee", "OWNER"); put("kind", "PROMOTION_APPROVAL") })))
                    put("withCoordinator", JsonArray(emptyList()))
                })
                project && path == "/api/projects/$projectId/integration" -> json(buildJsonObject { put("line", "PROJECT_BRANCH"); put("ref", "project/a11h") })
                project && path == "/api/projects/$projectId/promotions/current" -> json(Wire.json.parseToJsonElement("""{"promotionId":"pr-a11h",
                    "state":"READY","sourceRef":"refs/heads/project/a11h","sourceSha":"5e5bfca23aa1","upstreamRef":"refs/heads/main","commitsAhead":3,
                    "filesChanged":4,"taskIds":["t1"],"tasks":[{"taskId":"t1","title":"A11h push routing"}],"checks":[{"name":"MERGE_CHECK",
                    "command":"gradlew test","expectedExitCode":0,"exitCode":0,"timedOut":false,"durationMs":372000}],"conflicts":[],
                    "landsAs":"MERGE_COMMIT","askedAt":"2026-10-26T00:00:00Z","merged":null}"""))
                // Held open like the server's streams: a body that ends makes the client reconnect and
                // re-read the session in a loop, which keeps the card's actions flickering.
                path.endsWith("/events") -> MockResponse().setHeader("Content-Type", "text/event-stream")
                    .setBody(": controlled\n\n" + ": keepalive\n\n".repeat(3_600)).throttleBody(13, 1, TimeUnit.SECONDS)
                else -> json(JsonArray(emptyList()))
            }
        }
    } }
    private fun detail() = JsonObject(snapshot.getValue("detail").jsonObject.toMutableMap().apply {
        remove("projectId"); remove("taskId")
        put("title", JsonPrimitive("A10 notification session")); put("workspaceId", JsonPrimitive(workspace))
        put("pendingApprovals", JsonPrimitive(if (pending) 1 else 0)); put("ownerItems", JsonArray(emptyList()))
        if (project) {
            put("projectMembership", buildJsonObject {
                put("projectId", projectId); put("projectTitle", "A11h merge project"); put("projectStatus", "OPEN"); put("role", "COORDINATOR")
            })
            put("ownerItems", JsonArray(listOf(buildJsonObject {
                put("itemId", itemId); put("kind", "PROMOTION_APPROVAL"); put("title", "Merge 1 task into main?"); put("since", "2026-10-26T00:00:00Z")
            })))
        }
    })
    private fun projectRow() = buildJsonObject {
        put("id", projectId); put("title", "A11h merge project"); put("status", "OPEN"); put("coordinatorSessionId", sessionId)
        put("createdAt", "2026-10-20T00:00:00Z"); put("startedAt", "2026-10-20T00:00:00Z")
        put("taskCounts", buildJsonObject { put("done", 1); put("failed", 0); put("total", 2) })
    }
    fun journal() = buildJsonObject {
        put("pending", pending); put("sessionFailure", sessionFailure); put("decisions", JsonArray(decisions))
        put("requests", JsonArray(requests.map { request -> buildJsonObject {
            put("method", request.method); put("path", request.path)
            put("authenticated", request.getHeader("Authorization")?.startsWith("Bearer " + listOf("a10", "controlled", "access").joinToString("-")) == true)
        } }))
        put("registrations", JsonArray(registrations.map { JsonObject(it - "token") }))
        put("unregisterCount", unregisterCount)
        synchronized(registrationLock) {
            put("activeRegistration", registered?.let { JsonObject((it - "token") + mapOf(
                "account" to JsonPrimitive(registeredAccount), "registrationKey" to JsonPrimitive(registrationKey))) } ?: JsonNull)
        }
    }
}
