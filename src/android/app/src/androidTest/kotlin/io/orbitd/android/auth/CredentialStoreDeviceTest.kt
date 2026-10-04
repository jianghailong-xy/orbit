package io.orbitd.android.auth

import android.content.Context
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.security.keystore.KeyInfo
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.core.auth.*
import io.orbitd.android.BuildConfig
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.LoginResponse
import io.orbitd.android.core.protocol.User
import io.orbitd.android.storage.*
import java.io.File
import java.security.KeyStore
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.Before
import org.junit.runner.RunWith

internal fun fixtureTokens(version: Int = 0) = LoginResponse("a03-device-access-$version", "a03-device-refresh-$version",
    User("a03-fixture-user", "a03@example.test", "A03 fixture"))
internal val fixtureServer = ServerAddress.parse("https://a03.example.test/prefix")
internal fun reportDeviceProcess() = InstrumentationRegistry.getInstrumentation().sendStatus(0, Bundle().apply {
    putString("a03_pid", Process.myPid().toString())
    putString("a03_source", BuildConfig.SOURCE_SHA)
    putString("a03_source_dirty", BuildConfig.SOURCE_DIRTY.toString())
})

@RunWith(AndroidJUnit4::class)
class CredentialStoreDeviceTest {
    private val context get() = ApplicationProvider.getApplicationContext<Context>()
    @Before fun recordProcess() { reportDeviceProcess() }

    @Test fun encryptedRoundTripRotationRandomIvAndKeyDeletion() = runBlocking {
        val store = AndroidCredentialStore(context, "device-test")
        store.clear()
        try {
            val saved = StoredSession(fixtureServer.value, fixtureTokens())
            store.save(saved)
            assertTrue(AndroidCredentialStore(context, "device-test").load() == saved)
            val path = File(context.noBackupFilesDir, "orbit/device-test.bin")
            val first = path.readBytes()
            assertFalse(first.decodeToString().contains("a03-device-access"))
            assertFalse(first.decodeToString().contains("a03-device-refresh"))
            store.save(saved)
            assertFalse("GCM must use a new random IV", first.contentEquals(path.readBytes()))
            val rotated = saved.copy(credentials = fixtureTokens(1))
            store.save(rotated)
            assertTrue(AndroidCredentialStore(context, "device-test").load() == rotated)
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            val alias = "${context.packageName}.orbit.device-test.v1"
            val key = ks.getKey(alias, null) as SecretKey
            assertNull("Keystore key must not be exportable", key.encoded)
            val info = SecretKeyFactory.getInstance(key.algorithm, "AndroidKeyStore").getKeySpec(key, KeyInfo::class.java) as KeyInfo
            @Suppress("DEPRECATION")
            val security = if (Build.VERSION.SDK_INT >= 31) "level=${info.securityLevel}" else "insideSecureHardware=${info.isInsideSecureHardware}"
            InstrumentationRegistry.getInstrumentation().sendStatus(0, Bundle().apply { putString("a03_key_security", security) })
            store.clear()
            assertNull(store.load())
            assertFalse(path.exists())
            assertFalse(ks.containsAlias(alias))
        } finally { store.clear() }
    }

    @Test fun tamperingAndKeyLossFailClosedAndPurgeData() = runBlocking {
        val store = AndroidCredentialStore(context, "device-test")
        val data = AndroidSessionDataStore(context, "device-data")
        val instances = AndroidInstanceStore(context, "device-instance")
        for (lostKey in listOf(false, true)) {
            store.clear()
            store.save(StoredSession(fixtureServer.value, fixtureTokens()))
            instances.save(fixtureServer.value)
            data.write(AccountKey(fixtureServer.value, "a03-fixture-user"), DataKind.DRAFT, "s1", byteArrayOf(1))
            if (lostKey) KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry("${context.packageName}.orbit.device-test.v1")
            else {
                val path = File(context.noBackupFilesDir, "orbit/device-test.bin")
                val bytes = path.readBytes()
                bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte()
                path.writeBytes(bytes)
            }
            val session = AuthSession(HttpTransport { error("No network during failed restore") }, store, instances, data, "test")
            session.restore()
            assertEquals(SignOutReason.STORAGE, (session.state.value as AuthState.SignedOut).reason)
            assertNull(store.load())
            assertNull(data.read(AccountKey(fixtureServer.value, "a03-fixture-user"), DataKind.DRAFT, "s1"))
        }
    }

    @Test fun filesAreIsolatedByServerPortPathAndAccountAndAllAreDeleted() = runBlocking {
        val data = AndroidSessionDataStore(context, "device-data")
        data.clearAll()
        val accounts = listOf(AccountKey("https://example.test/a/", "u1"), AccountKey("https://example.test/a/", "u2"),
            AccountKey("https://example.test:8443/a/", "u1"), AccountKey("https://example.test/b/", "u1"))
        for ((index, account) in accounts.withIndex()) for (kind in DataKind.entries) {
            data.write(account, kind, "../../same-id", byteArrayOf(index.toByte()))
        }
        for ((index, account) in accounts.withIndex()) for (kind in DataKind.entries) {
            assertArrayEquals(byteArrayOf(index.toByte()), data.read(account, kind, "../../same-id"))
        }
        data.clearAll()
        for (account in accounts) assertNull(data.read(account, DataKind.DRAFT, "../../same-id"))
    }
}
