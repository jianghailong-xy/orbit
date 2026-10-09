package io.orbitd.android.projects

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.taskprojects.FeatureWriteUncertain
import io.orbitd.android.tasks.taskError
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

/** Regressions from the coordinator's review of v1 (decision 5dshHuxUn20vj22RYT968k) that a JVM test can hold. */
class ReviewRegressionTest {
    /** A refusal made on this device names itself; it is not a dropped connection. */
    @Test fun aLocalRefusalIsShownInItsOwnWordsNotAsAConnectionError() {
        val refused = IllegalStateException("A run of this task is waiting on its owner; answer it there.")
        assertEquals("A run of this task is waiting on its owner; answer it there.", taskError(refused))
        assertEquals("A run of this task is waiting on its owner; answer it there", failureReason(refused))
    }

    /** One displayed row, one press: an unknown answer holds the row, whatever name the next press is given. */
    @Test fun aProjectRunWhoseAnswerIsUnknownHoldsTheRowAgainstANewlyNamedPress() = runTest {
        var attempts = 0
        val session = AuthSession(HttpTransport { request ->
            when {
                request.api.path == listOf("auth", "login") -> ApiResponse(200,
                    """{"accessToken":"a","refreshToken":"r","user":{"id":"owner","email":"o@example.test","name":"O"}}""".encodeToByteArray())
                request.api.path.lastOrNull() == "execute" -> { attempts++; throw NetworkException() }
                else -> ApiResponse(200, "{}".encodeToByteArray())
            }
        }, object : CredentialStore {
            var saved: StoredSession? = null
            override suspend fun load() = saved
            override suspend fun save(session: StoredSession) { saved = session }
            override suspend fun clear() { saved = null }
        }, object : InstanceStore {
            override suspend fun load(): String? = null
            override suspend fun save(server: String) {}
        }, object : SessionDataStore {
            val data = mutableMapOf<String, ByteArray>()
            override suspend fun read(account: AccountKey, kind: DataKind, key: String) = data[key]
            override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) { data[key] = bytes }
            override suspend fun clearAll() { data.clear() }
        }, "test")
        val handle = session.login(ServerAddress.parse("https://projects.example"), "o@example.test", "pw")
        val api = ProjectApi(session, handle)
        try { api.run("task", "first-press", "task:OPEN:READY"); fail("Expected an unknown result") } catch (_: FeatureWriteUncertain) { }
        assertEquals(4, attempts)
        try { ProjectApi(session, handle).run("task", "second-press", "task:OPEN:READY"); fail("The held row must refuse a second press") }
        catch (_: FeatureWriteUncertain) { }
        assertEquals("nothing more left the device", 4, attempts)
    }
}
