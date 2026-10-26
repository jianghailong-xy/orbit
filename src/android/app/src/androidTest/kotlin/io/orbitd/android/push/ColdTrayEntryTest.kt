package io.orbitd.android.push

import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.navigation.ObjectId
import java.io.File
import java.util.UUID
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Host-only step of the cold tray tap: `am instrument --no-restart` attaches to the production process
 * the launcher started (its debug build has no Firebase configuration, so nothing else posts), posts one
 * entry through the production builder and leaves it. The host then kills this process and taps the
 * entry, so SystemUI starts a new, uninstrumented process. Not FCM delivery. */
@RunWith(AndroidJUnit4::class)
class ColdTrayEntryTest {
    @Test fun postForColdTap() {
        val app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as OrbitApplication
        assertFalse("Must attach to the launcher-started production process", app is PushTestApplication)
        assertTrue(app.session.state.value is AuthState.SignedIn)
        val session = ObjectId.canonical("34ZaIKKTQq8IdW0pn90xH")!!
        val data = mapOf("version" to "1", "type" to "alert", "registrationKey" to UUID.randomUUID().toString(),
            "eventId" to UUID.randomUUID().toString(), "notificationKey" to "approval-$session", "sentAt" to "2026-10-07T00:00:00Z",
            "payload" to buildJsonObject { put("kind", "approval"); put("category", "ORBIT_APPROVAL"); put("sessionID", session)
                put("threadId", session); put("title", "A10 tray approval"); put("body", "Controlled pending approval for a cold tray tap.") }.toString())
        val notifications = PushNotifications(app)
        val message = PushMessage.parse(data)!!
        assertTrue(notifications.show(message, data))
        // The notification service posts asynchronously; the entry must appear and stay.
        val until = SystemClock.elapsedRealtime() + 10_000
        while (notifications.active() != listOf(message) && SystemClock.elapsedRealtime() < until) SystemClock.sleep(100)
        SystemClock.sleep(1_000)
        assertEquals(listOf(message), notifications.active())
        File(app.filesDir, "a10-push").apply { mkdirs() }.resolve("tray-seed.txt")
            .writeText("pid=${Process.myPid()}\nlink=${message.link}\napplication=${app.javaClass.name}\n")
        InstrumentationRegistry.getInstrumentation().sendStatus(0, Bundle().apply { putString("a10_pid", Process.myPid().toString()) })
    }
}
