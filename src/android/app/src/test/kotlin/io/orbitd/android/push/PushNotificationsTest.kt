package io.orbitd.android.push

import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import io.orbitd.android.MainActivity
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitLinks
import io.orbitd.android.navigation.OrbitNavigation
import java.io.File
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** Android framework behavior under Robolectric, not FCM delivery or physical-device evidence. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = Application::class)
class PushNotificationsTest {
    private val app get() = RuntimeEnvironment.getApplication()
    private val manager get() = app.getSystemService(NotificationManager::class.java)
    private lateinit var notifications: PushNotifications

    @Before fun reset() {
        notifications = PushNotifications(app)
        notifications.clear()
        shadowOf(manager).setNotificationsEnabled(true)
    }

    @Test fun channelsAndImmutableViewIntentUseExistingAuthenticationNavigation() {
        assertEquals(setOf(PushNotifications.NEEDS_YOU, PushNotifications.SESSIONS, PushNotifications.UPDATES),
            manager.notificationChannels.map { it.id }.toSet())
        val data = data()
        val message = PushMessage.parse(data)!!
        assertTrue(notifications.show(message, data))
        val notification = manager.activeNotifications.single().notification
        assertEquals(PushNotifications.NEEDS_YOU, notification.channelId)
        assertEquals(Notification.VISIBILITY_PRIVATE, notification.visibility)
        assertTrue(notification.flags and Notification.FLAG_ONLY_ALERT_ONCE != 0)
        assertTrue(notification.actions.isNullOrEmpty())
        val pending = shadowOf(notification.contentIntent)
        assertTrue(pending.isImmutable)
        val intent = pending.savedIntent
        assertEquals(Intent.ACTION_VIEW, intent.action)
        assertEquals(MainActivity::class.java.name, intent.component!!.className)
        val route = OrbitLinks.parse(intent.dataString!!)!!
        assertEquals(Destination.SESSION, route.destination)
        // The real pending-intent URI is preserved by the existing saved navigation model.
        val waiting = OrbitNavigation().receive(route)
        val restored = Wire.json.decodeFromString<OrbitNavigation>(Wire.json.encodeToString(waiting))
        assertEquals(route, restored.pending)
        assertEquals(route, restored.bindAccount("account-A").current)
        assertNull(restored.bindAccount("account-A").bindAccount(null).pending)
    }

    @Test fun replacementDedupSurvivesProcessRecreationButNewApprovalEdgeCanAlertAfterClear() {
        val firstData = data()
        val first = PushMessage.parse(firstData)!!
        assertFalse(notifications.hasSeen(first))
        assertTrue(notifications.show(first, firstData))
        notifications.remember(first)
        val cold = PushNotifications(app)
        assertTrue(cold.hasSeen(first))
        assertEquals(first, cold.active().single())
        val nextData = data() + ("eventId" to "40000000-0000-4000-8000-000000000004")
        val next = PushMessage.parse(nextData)!!
        assertFalse(cold.hasSeen(next))
        assertTrue(cold.show(next, nextData))
        assertEquals(1, manager.activeNotifications.size)
        assertEquals(next, cold.active().single())
        cold.cancel(next)
        assertTrue(cold.active().isEmpty())
        val newEdgeData = data() + ("eventId" to "40000000-0000-4000-8000-000000000005")
        val newEdge = PushMessage.parse(newEdgeData)!!
        assertFalse(cold.hasSeen(newEdge))
        assertTrue(cold.show(newEdge, newEdgeData))
        assertEquals(newEdge, cold.active().single())
    }

    @Test fun cancellingApprovalKeepsFinishedNoticeAndLogoutClearRetiresHistoryWithoutOtherNotifications() {
        val approvalData = data()
        val approval = PushMessage.parse(approvalData)!!
        val finishedData = changedKind("finished") + ("notificationKey" to "finished-session")
        val finished = PushMessage.parse(finishedData)!!
        notifications.show(approval, approvalData); notifications.remember(approval)
        notifications.show(finished, finishedData)
        notifications.cancel(approval)
        assertEquals(listOf(finished), notifications.active())
        manager.notify("unrelated", 3, Notification.Builder(app, PushNotifications.UPDATES).setContentTitle("Other").build())
        notifications.clear()
        assertTrue(notifications.active().isEmpty())
        assertFalse(PushNotifications(app).hasSeen(approval))
        assertEquals("unrelated", manager.activeNotifications.single().tag)
    }

    @Test fun deniedNotificationsOrUnavailableChannelDoNotPostAndDoNotThrow() {
        val data = data()
        val message = PushMessage.parse(data)!!
        shadowOf(manager).setNotificationsEnabled(false)
        assertFalse(notifications.allowed())
        assertFalse(notifications.show(message, data))
        shadowOf(manager).setNotificationsEnabled(true)
        manager.createNotificationChannel(NotificationChannel(PushNotifications.NEEDS_YOU, "Needs your reply", NotificationManager.IMPORTANCE_NONE))
        assertFalse(notifications.allowed(PushNotifications.NEEDS_YOU))
        assertFalse(notifications.show(message, data))
        manager.deleteNotificationChannel(PushNotifications.NEEDS_YOU)
        assertFalse(notifications.allowed(PushNotifications.NEEDS_YOU))
        assertFalse(notifications.show(message, data))
        assertTrue(manager.activeNotifications.isEmpty())
    }

    @Test fun headlessAgentMessageOpensOrbitWithoutInventingADestination() {
        val data = changedKind("agent-message", removeSession = true)
        val message = PushMessage.parse(data)!!
        assertTrue(notifications.show(message, data))
        val notification = manager.activeNotifications.single().notification
        val pending = shadowOf(notification.contentIntent)
        assertTrue(pending.isImmutable)
        assertEquals(Intent.ACTION_MAIN, pending.savedIntent.action)
        assertNull(pending.savedIntent.data)
        assertEquals(MainActivity::class.java.name, pending.savedIntent.component!!.className)
        assertEquals(PushNotifications.UPDATES, notification.channelId)
    }

    @Test fun needsYouChannelPopsUpLikeTheIosBannerWhileOthersStayDefault() {
        assertEquals("orbit.needs-you.alert", PushNotifications.NEEDS_YOU)
        assertEquals(NotificationManager.IMPORTANCE_HIGH, manager.getNotificationChannel(PushNotifications.NEEDS_YOU).importance)
        assertEquals(NotificationManager.IMPORTANCE_DEFAULT, manager.getNotificationChannel(PushNotifications.SESSIONS).importance)
        assertEquals(NotificationManager.IMPORTANCE_DEFAULT, manager.getNotificationChannel(PushNotifications.UPDATES).importance)
        assertNull(manager.getNotificationChannel("orbit.needs-you"))
    }

    @Test fun upgradeReplacesTheUntouchedDefaultNeedsYouChannel() {
        // 482b132e8 created orbit.needs-you at DEFAULT, and Android never raises an existing channel.
        manager.deleteNotificationChannel(PushNotifications.NEEDS_YOU)
        manager.createNotificationChannel(NotificationChannel("orbit.needs-you", "Needs your reply", NotificationManager.IMPORTANCE_DEFAULT))
        val upgraded = PushNotifications(app)
        assertNull(manager.getNotificationChannel("orbit.needs-you"))
        assertEquals(NotificationManager.IMPORTANCE_HIGH, manager.getNotificationChannel("orbit.needs-you.alert").importance)
        val data = data()
        assertTrue(upgraded.show(PushMessage.parse(data)!!, data))
        assertEquals("orbit.needs-you.alert", manager.activeNotifications.single().notification.channelId)
    }

    @Test fun upgradeKeepsANeedsYouChannelWhoseImportanceTheUserChanged() {
        manager.deleteNotificationChannel(PushNotifications.NEEDS_YOU)
        val chosen = NotificationChannel("orbit.needs-you", "Needs your reply", NotificationManager.IMPORTANCE_LOW)
        // What Android records when the user changes the importance in its settings (hidden API).
        NotificationChannel::class.java.getMethod("lockFields", Int::class.javaPrimitiveType).invoke(chosen, 0x4)
        manager.createNotificationChannel(chosen)
        val upgraded = PushNotifications(app)
        assertEquals(NotificationManager.IMPORTANCE_LOW, manager.getNotificationChannel("orbit.needs-you").importance)
        assertNull(manager.getNotificationChannel("orbit.needs-you.alert"))
        val data = data()
        assertTrue(upgraded.show(PushMessage.parse(data)!!, data))
        assertEquals("orbit.needs-you", manager.activeNotifications.single().notification.channelId)
    }

    @Test fun silentPostJoinsAGroupThatOnlyItsAbsentSummaryMayAlert() {
        val data = data()
        assertTrue(notifications.show(PushMessage.parse(data)!!, data, silent = true))
        val silent = manager.activeNotifications.single().notification
        assertEquals(PushNotifications.SILENT_GROUP, silent.group)
        assertEquals(Notification.GROUP_ALERT_SUMMARY, silent.groupAlertBehavior)
        notifications.clear()
        assertTrue(notifications.show(PushMessage.parse(data)!!, data))
        assertNull(manager.activeNotifications.single().notification.group)
    }

    private fun changedKind(kind: String, removeSession: Boolean = false): Map<String, String> {
        val data = data()
        val payload = Wire.json.parseToJsonElement(data.getValue("payload")).jsonObject
        return data + ("payload" to JsonObject(payload.filterKeys { !removeSession || it != "sessionID" } + ("kind" to JsonPrimitive(kind))).toString())
    }

    private fun data(): Map<String, String> {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/shared/src/android-push.fixture.json").isFile }
        return Wire.json.parseToJsonElement(File(root, "src/shared/src/android-push.fixture.json").readText())
            .jsonObject["samples"]!!.jsonArray[0].jsonObject["data"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content }
    }
}
