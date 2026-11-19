package io.orbitd.android.push

import android.app.AlarmManager
import android.app.NotificationManager
import android.content.Intent
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.cards.OwnerRequestSnoozes
import io.orbitd.android.core.cards.OwnerRequests
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitLinks
import io.orbitd.android.navigation.OrbitNavigation
import java.time.Instant
import java.util.UUID
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * An owner request's push (apiserver `notifyOwnerRequest`): its payload read, its channel, its two actions — the kind's own, opening
 * `orbit://owner-request/<id>` on the inbox with the card's input focused, and Later, which puts it off for an hour on this device and
 * brings the notification back then. Neither ends the request; a SECRET has no inline reply.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
class OwnerRequestPushTest {
    private val app get() = RuntimeEnvironment.getApplication() as OrbitApplication
    private val manager get() = app.getSystemService(NotificationManager::class.java)
    private val session = "01a0d6a9-d763-70e1-b4cf-8793e971b500"
    private val request = "01a0d6a9-d763-70e1-b4cf-8793e971b501"

    @Before fun reset() {
        app.push.notifications.clear()
        shadowOf(manager).setNotificationsEnabled(true)
        OwnerRequestSnoozes.reset(app)
    }

    private fun data(kind: String = "SECRET", payload: JsonObjectBuilder.() -> Unit = {}): Map<String, String> = mapOf(
        "version" to "1", "type" to "alert", "registrationKey" to "10000000-0000-4000-8000-000000000001",
        "eventId" to UUID.randomUUID().toString(), "notificationKey" to "owner-request-$request", "sentAt" to "2026-11-10T00:00:00.000Z",
        "payload" to buildJsonObject {
            put("title", "Key needed"); put("body", "Staging Stripe key"); put("kind", "owner-request")
            put("category", "ORBIT_OWNER_REQUEST_$kind"); put("threadId", "owner-request-$session")
            put("sessionID", ObjectId.toPublic(session)); put("ownerRequestID", ObjectId.toPublic(request)); put("ownerRequestKind", kind)
            payload()
        }.toString())

    @Test fun anOwnerRequestPayloadIsReadAndNeedsBothItsSessionAndItsRequest() {
        val message = PushMessage.parse(data())!!
        assertEquals("owner-request", message.payload.kind)
        assertEquals(session, message.payload.sessionId)
        assertEquals(request, message.payload.ownerRequestId)
        assertEquals("SECRET", message.payload.ownerRequestKind)
        assertEquals("ORBIT_OWNER_REQUEST_SECRET", message.payload.category)
        // The tap on the notification itself opens the session that asked, as it always did.
        assertEquals("orbit-session:$session", message.link)
        assertEquals("orbit://owner-request/$request", message.payload.ownerRequestLink)
        assertEquals(PushNotifications.NEEDS_YOU, app.push.notifications.channel(message))
        fun without(key: String) = data().let { it + ("payload" to JsonObject(Json.parseToJsonElement(it.getValue("payload")).jsonObject - key).toString()) }
        assertNull("no request, no notification", PushMessage.parse(without("ownerRequestID")))
        assertNull("no session, no notification", PushMessage.parse(without("sessionID")))
        assertNull("an id that is not one", PushMessage.parse(data { put("ownerRequestID", "not an id!") }))
    }

    @Test fun theKindsActionOpensTheInboxOnTheCardAndLaterIsTheSecond() {
        mapOf("SECRET" to "Provide key", "DECISION" to "Answer", "MANUAL_STEP" to "Mark done", "CONFIRM" to "Review").forEach { (kind, label) ->
            app.push.notifications.clear()
            val data = data(kind)
            assertTrue(app.push.notifications.show(PushMessage.parse(data)!!, data))
            val notification = manager.activeNotifications.single().notification
            assertEquals(PushNotifications.NEEDS_YOU, notification.channelId)
            assertEquals(listOf(label, OwnerRequests.later), notification.actions.map { it.title.toString() })
            assertTrue("no inline reply: a key is typed only into its card", notification.actions.all { it.remoteInputs.isNullOrEmpty() })
            val primary = shadowOf(notification.actions[0].actionIntent)
            assertTrue(primary.isActivity && primary.isImmutable)
            val intent = primary.savedIntent
            assertEquals(Intent.ACTION_VIEW, intent.action)
            assertEquals(MainActivity::class.java.name, intent.component!!.className)
            assertEquals("orbit://owner-request/$request", intent.dataString)
            val route = OrbitLinks.parse(intent.dataString!!)!!
            assertEquals(Destination.WAITING_ON_YOU, route.destination)
            assertEquals(request, route.id)
            assertEquals(route, OrbitNavigation().bindAccount("account-A").receive(route).current)
            // The body's tap is still the session's.
            assertEquals("orbit-session:$session", shadowOf(notification.contentIntent).savedIntent.dataString)
            val later = shadowOf(notification.actions[1].actionIntent)
            assertTrue(later.isBroadcast && later.isImmutable)
            assertEquals(OwnerRequestLaterReceiver.LATER, later.savedIntent.action)
            assertEquals(OwnerRequestLaterReceiver::class.java.name, later.savedIntent.component!!.className)
        }
    }

    @Test fun laterPutsTheRequestOffForAnHourAndBringsTheNotificationBackThen() {
        val data = data("MANUAL_STEP")
        app.push.notifications.show(PushMessage.parse(data)!!, data)
        val later = shadowOf(manager.activeNotifications.single().notification.actions[1].actionIntent).savedIntent
        val before = System.currentTimeMillis()
        OwnerRequestLaterReceiver().onReceive(app, later)
        val snoozes = OwnerRequestSnoozes.of(app)
        val until = snoozes.until(request)
        assertTrue("an hour from the press: $until", until in before + 3_600_000..System.currentTimeMillis() + 3_600_000)
        // Out of the count, the notification gone, and nothing sent: the request is not ended.
        val pending = io.orbitd.android.core.cards.OwnerRequest(id = ObjectId.toPublic(request), kind = "MANUAL_STEP", state = "PENDING", title = "t",
            createdAt = Instant.now().toString())
        assertEquals(0, OwnerRequests.waitingCount(listOf(pending), snoozes.state.value, Instant.now()))
        assertTrue(manager.activeNotifications.isEmpty())
        val alarm = shadowOf(app.getSystemService(AlarmManager::class.java)).scheduledAlarms.single()
        assertEquals(until, alarm.triggerAtTime)
        val repost = shadowOf(alarm.operation).savedIntent
        assertEquals(OwnerRequestLaterReceiver.REPOST, repost.action)
        // An alarm that comes while the request is still put off (it was put off again since) brings nothing back.
        OwnerRequestLaterReceiver().onReceive(app, repost)
        assertTrue(manager.activeNotifications.isEmpty())
        assertEquals(until, snoozes.until(request))
    }
}
