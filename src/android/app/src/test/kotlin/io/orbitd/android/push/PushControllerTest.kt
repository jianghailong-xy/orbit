package io.orbitd.android.push

import android.app.Activity
import android.app.Application
import android.app.NotificationManager
import androidx.test.core.app.ApplicationProvider
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RealtimeStore
import java.io.File
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = Application::class)
class PushControllerTest {
    private val app get() = ApplicationProvider.getApplicationContext<Application>()
    private lateinit var fixture: Fixture
    @Before fun setup() { File(app.noBackupFilesDir, "push").deleteRecursively(); fixture = Fixture() }
    @After fun cleanup() { fixture.close() }

    @Test fun retriesReplaceOnceAndNewApprovalAfterClearStillAppears() = runBlocking {
        fixture.signIn()
        val first = fixture.data()
        assertTrue(fixture.push.receive(first))
        assertEquals(1, fixture.active().size)
        val reads = fixture.requests.count { it.path == listOf("sessions", sid, "approvals") }
        fixture.push.receive(first)
        assertEquals(reads, fixture.requests.count { it.path == listOf("sessions", sid, "approvals") })
        fixture.push.receive(fixture.data())
        assertEquals(1, fixture.active().size)
        fixture.pending = false
        val sync = fixture.sync()
        assertTrue(fixture.push.receive(sync))
        val afterSync = fixture.requests.size
        assertTrue(fixture.push.receive(sync))
        assertEquals(afterSync, fixture.requests.size)
        assertTrue(fixture.active().isEmpty())
        fixture.pending = true
        fixture.push.receive(fixture.data())
        assertEquals(1, fixture.active().size)
    }

    @Test fun syncRechecksAuthorityAndDoesNotEraseUnrelatedFinishedOrANewerApproval() = runBlocking {
        fixture.signIn()
        fixture.push.receive(fixture.data())
        fixture.push.receive(fixture.data(kind = "finished", sessionId = settled))
        fixture.push.receive(fixture.sync()) // stale clearSessions delta, but server still needs this owner.
        assertEquals(2, fixture.active().size)
        fixture.pending = false
        fixture.push.receive(fixture.sync())
        assertEquals(listOf("finished"), fixture.active().map { it.payload.kind })
    }

    @Test fun offlineIsRetryableAndCannotCreateOrResolveAnActionableNotification() = runBlocking {
        fixture.signIn()
        fixture.push.receive(fixture.data())
        fixture.unavailable = true
        assertFalse(fixture.push.receive(fixture.data()))
        assertFalse(fixture.push.receive(fixture.sync()))
        assertEquals(1, fixture.active().size)
        fixture.unavailable = false
        fixture.denied = true
        fixture.push.receive(fixture.sync())
        assertTrue(fixture.active().isEmpty())
    }

    @Test fun foregroundUsesOneNoticeAndAuthorityClearsIt() = runBlocking {
        fixture.signIn()
        fixture.push.onActivityStarted(Activity())
        val first = fixture.data()
        fixture.push.receive(first)
        assertEquals(sid, fixture.push.notice.value?.payload?.sessionId)
        assertTrue(fixture.active().isEmpty())
        fixture.push.dismissNotice()
        fixture.push.receive(first)
        assertNull(fixture.push.notice.value)
        fixture.push.receive(fixture.data())
        fixture.pending = false
        fixture.push.receive(fixture.sync())
        assertNull(fixture.push.notice.value)
    }

    @Test fun coldControllerAdoptsPersistedBindingBeforeCheckingMessage() = runBlocking {
        fixture.signIn()
        val data = fixture.data()
        val registrations = fixture.requests.count { it.path == listOf("push", "register") }
        fixture.restart()
        assertNull(fixture.push.registration.activeBinding())
        assertTrue(fixture.push.receive(data))
        assertEquals(1, fixture.active().size)
        assertEquals(registrations, fixture.requests.count { it.path == listOf("push", "register") })
    }

    @Test fun logoutClearsLocalStateAndOldBindingCannotTargetNextLogin() = runBlocking {
        fixture.signIn()
        val old = fixture.data()
        fixture.push.receive(old)
        fixture.push.beforeSignOut()
        assertTrue(fixture.active().isEmpty())
        fixture.session.logout()
        fixture.signIn()
        fixture.push.receive(old)
        assertTrue(fixture.active().isEmpty())
        fixture.push.receive(fixture.data())
        assertEquals(1, fixture.active().size)
        assertTrue(fixture.requests.any { it.path == listOf("push", "unregister") })
    }

    @Test fun disabledBuildRejectsAPersistedBindingAndBackgroundWorkExpires() = runBlocking {
        fixture.signIn()
        val data = fixture.data()
        fixture.available = false
        fixture.push.receive(data)
        assertTrue(fixture.active().isEmpty())
        assertTrue(PushWorker.expired(1, 300_002))
        assertTrue(PushWorker.expired(5_000, 4_999))
        assertTrue(PushWorker.expired(0, 1))
        assertFalse(PushWorker.expired(10_000, 10_001))
    }

    private inner class Fixture {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val credentials = object : CredentialStore {
            var value: StoredSession? = null
            override suspend fun load() = value
            override suspend fun save(session: StoredSession) { value = session }
            override suspend fun clear() { value = null }
        }
        val requests = CopyOnWriteArrayList<ApiRequest>()
        var pending = true
        var unavailable = false
        var denied = false
        var available = true
        val source = object : PushTokenSource {
            override val available get() = this@Fixture.available
            override fun requestToken(receive: (String) -> Unit) = Unit
        }
        var session = makeSession()
        var realtime = RealtimeStore(session, scope)
        var push = PushController(app, session, realtime, scope, source)
        suspend fun signIn() {
            session.login(ServerAddress.parse("https://fixture.example"), "fixture@example.test", "password")
            push.registration.updateToken(listOf("controlled", "push", "token").joinToString("-"))
            check(push.registration.activeBinding() != null)
        }
        fun restart() {
            realtime.close()
            session = makeSession(); realtime = RealtimeStore(session, scope)
            push = PushController(app, session, realtime, scope, source)
        }
        fun active() = push.notifications.active()
        fun close() { push.notifications.clear(); realtime.close(); scope.cancel() }
        fun data(kind: String = "approval", sessionId: String = sid): Map<String, String> = envelope("alert", buildJsonObject {
            put("kind", kind); put("title", "Controlled approval"); put("body", "Needs your reply · Bash"); put("sessionID", sessionId)
        }, "$kind-$sessionId")
        fun sync() = envelope("sync", buildJsonObject { put("badge", 0); put("clearSessions", JsonArray(listOf(JsonPrimitive(sid)))) }, "badge-sync")
        private fun envelope(type: String, payload: JsonObject, key: String) = mapOf("version" to "1", "type" to type,
            "registrationKey" to push.registration.activeBinding()!!.registrationKey, "eventId" to UUID.randomUUID().toString(),
            "notificationKey" to key, "sentAt" to "2026-10-04T00:00:00.000Z", "payload" to payload.toString())
        private fun makeSession() = AuthSession(HttpTransport { request ->
            val path = request.api.path
            requests.add(request.api)
            val body = when {
                path == listOf("auth", "login") -> """{"accessToken":"test-access","refreshToken":"test-refresh","user":{"id":"u1","email":"fixture@example.test","name":"Fixture"}}"""
                path == listOf("push", "register") -> """{"ok":true,"registrationKey":"${UUID.randomUUID()}"}"""
                path.firstOrNull() in setOf("push", "auth") -> "{}"
                unavailable -> return@HttpTransport ApiResponse(503, "{}".encodeToByteArray())
                denied -> return@HttpTransport ApiResponse(403, "{}".encodeToByteArray())
                path == listOf("sessions") -> if (pending) """[{"id":"$sid","status":"RUNNING","lifecycleState":"OPEN","pendingApprovals":1}]""" else "[]"
                path == listOf("sessions", sid, "approvals") -> if (pending) """[{"id":"1","status":"PENDING"}]""" else "[]"
                path == listOf("sessions", sid) -> """{"id":"$sid","status":"RUNNING","lifecycleState":"OPEN"}"""
                path == listOf("sessions", settled) -> """{"id":"$settled","status":"SUCCEEDED","lifecycleState":"OPEN"}"""
                else -> "[]"
            }
            ApiResponse(200, body.encodeToByteArray())
        }, credentials, object : InstanceStore {
            override suspend fun load(): String? = null
            override suspend fun save(server: String) = Unit
        }, object : SessionDataStore {
            override suspend fun read(account: AccountKey, kind: DataKind, key: String): ByteArray? = null
            override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) = Unit
            override suspend fun clearAll() = Unit
        }, "test")
    }
    companion object {
        private const val sid = "019a0000-0000-7000-8000-000000000002"
        private const val settled = "019a0000-0000-7000-8000-000000000003"
    }
}
