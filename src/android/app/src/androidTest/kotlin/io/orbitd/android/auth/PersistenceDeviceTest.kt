package io.orbitd.android.auth

import android.content.Context
import android.os.Bundle
import android.os.Process
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.BuildConfig
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.storage.*
import java.io.File
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Invoked four times by auth-device-test.sh, force-stopping the target between phases. */
@RunWith(AndroidJUnit4::class)
class PersistenceDeviceTest {
    @Test fun processPhase() = runBlocking {
        reportDeviceProcess()
        val context = ApplicationProvider.getApplicationContext<Context>()
        val phase = InstrumentationRegistry.getArguments().getString("a03_phase") ?: error("a03_phase required")
        val store = AndroidCredentialStore(context, "persistence-test")
        val data = AndroidSessionDataStore(context, "persistence-data")
        val instance = AndroidInstanceStore(context, "persistence-instance")
        val pidFile = File(context.noBackupFilesDir, "orbit/persistence-pid")
        if (phase == "seed") {
            store.clear()
            data.clearAll()
        } else {
            assertTrue("previous phase must have run in another process", pidFile.readText().toInt() != Process.myPid())
        }
        val session = AuthSession(HttpTransport { req ->
            when (req.api.path.last()) {
                "login" -> ApiResponse(200, Wire.json.encodeToString(fixtureTokens()).encodeToByteArray())
                "refresh" -> ApiResponse(200, Wire.json.encodeToString(fixtureTokens(1)).encodeToByteArray())
                "me" -> if (req.accessToken == fixtureTokens().accessToken) ApiResponse(401, byteArrayOf()) else ApiResponse(200, "{}".encodeToByteArray())
                else -> ApiResponse(200, "{}".encodeToByteArray())
            }
        }, store, instance, data, BuildConfig.VERSION_NAME)
        session.restore()
        when (phase) {
            "seed" -> {
                val handle = session.login(fixtureServer, "a03@example.test", "a03-device-password")
                session.writeData(handle, DataKind.DRAFT, "s1", "fixture draft".encodeToByteArray())
                session.writeData(handle, DataKind.CACHE, "s1", "fixture cache".encodeToByteArray())
            }
            "rotate" -> {
                val state = session.state.value as AuthState.SignedIn
                assertTrue(store.load()!!.credentials == fixtureTokens())
                assertNotNull(session.readData(state.handle, DataKind.DRAFT, "s1"))
                assertNotNull(session.readData(state.handle, DataKind.CACHE, "s1"))
                session.request(state.handle, ApiRequest(listOf("users", "me")))
                assertTrue(store.load()!!.credentials == fixtureTokens(1))
            }
            "logout" -> {
                val state = session.state.value as AuthState.SignedIn
                assertTrue(store.load()!!.credentials == fixtureTokens(1))
                assertNotNull(session.readData(state.handle, DataKind.DRAFT, "s1"))
                session.logout()
                assertNull(store.load())
            }
            "verify-cleared" -> {
                assertTrue(session.state.value is AuthState.SignedOut)
                assertNull(store.load())
                assertNull(data.read(AccountKey(fixtureServer.value, "a03-fixture-user"), DataKind.DRAFT, "s1"))
                assertNull(data.read(AccountKey(fixtureServer.value, "a03-fixture-user"), DataKind.CACHE, "s1"))
            }
            else -> error("Unknown a03_phase")
        }
        pidFile.writeText(Process.myPid().toString())
        InstrumentationRegistry.getInstrumentation().sendStatus(0, Bundle().apply {
            putString("a03_phase", phase)
            putString("a03_pid", Process.myPid().toString())
            putString("a03_source", BuildConfig.SOURCE_SHA)
        })
    }
}
