package io.orbitd.android.release

import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.Bundle
import android.os.Process
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.LoginResponse
import io.orbitd.android.core.protocol.User
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.storage.*
import java.io.File
import java.security.KeyStore
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Two invocations around adb install -r; fixture transport, real app-private stores and Keystore. */
@RunWith(AndroidJUnit4::class)
class UpgradeDeviceTest {
    @Test fun upgradePhase() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val args = InstrumentationRegistry.getArguments()
        val phase = args.getString("a14_phase") ?: error("a14_phase required")
        assertEquals("Dedicated disposable package required", "io.orbitd.android.upgradetest", context.packageName)
        assertEquals(0, context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE)
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        val version = info.versionName!!
        assertEquals(args.getString("a14_expected_version_name"), version)
        assertEquals(args.getString("a14_expected_version_code")!!.toLong(), info.longVersionCode)
        // Reflection reads the installed target, avoiding constants inlined when the test APK was built.
        val build = context.classLoader.loadClass("io.orbitd.android.BuildConfig")
        fun field(name: String) = build.getField(name).get(null)
        assertEquals(version, field("VERSION_NAME"))
        assertEquals(info.longVersionCode, (field("VERSION_CODE") as Int).toLong())
        assertEquals(context.packageName, field("APPLICATION_ID"))
        assertEquals("release", field("BUILD_TYPE"))
        assertEquals(false, field("DEBUG"))
        val source = field("SOURCE_SHA") as String
        assertTrue(source.matches(Regex("[0-9a-f]{40}")))

        val server = ServerAddress.parse("https://a14.example.test/instance-a")
        val tokens = LoginResponse("a14-fixture-access", "a14-fixture-refresh",
            User("a14-user-1", "a14@example.test", "A14 local fixture"))
        val accounts = listOf(AccountKey(server.value, tokens.user.id), AccountKey(server.value, "a14-user-2"),
            AccountKey("https://a14.example.test/instance-b/", tokens.user.id),
            AccountKey("https://a14.example.test:8443/instance-a/", tokens.user.id))
        val credentials = AndroidCredentialStore(context)
        val instances = AndroidInstanceStore(context)
        val data = AndroidSessionDataStore(context)
        val marker = File(context.noBackupFilesDir, "orbit/a14-upgrade-marker")
        // What app-private storage held when this phase began, whether or not a read below fails.
        InstrumentationRegistry.getInstrumentation().sendStatus(0, Bundle().apply { putString("a14_storage_at_start", storageState(context)) })
        var observedVersion: String? = null
        val session = AuthSession(HttpTransport { request ->
            observedVersion = request.clientVersion
            assertEquals(version, request.clientVersion)
            when (request.api.path.last()) {
                "login" -> ApiResponse(200, Wire.json.encodeToString(tokens).encodeToByteArray())
                "me" -> {
                    assertTrue("Restored credential must be used", request.accessToken == tokens.accessToken)
                    ApiResponse(200, Wire.json.encodeToString(tokens.user).encodeToByteArray())
                }
                "logout" -> ApiResponse(200, "{}".encodeToByteArray())
                else -> error("Unexpected fixture request")
            }
        }, credentials, instances, data, version)
        if (phase == "seed") {
            assertFalse("A fresh app installation is required", marker.exists())
            assertNull(credentials.load())
            session.restore()
            val handle = session.login(server, tokens.user.email, "a14-fixture-password")
            assertEquals(accounts.first(), handle.account)
            for ((index, account) in accounts.withIndex()) for (kind in DataKind.entries) {
                data.write(account, kind, "same-id", "$index:$kind".encodeToByteArray())
            }
            marker.writeText("${Process.myPid()}\n${info.longVersionCode}\n$version\n$source\n")
        } else {
            assertEquals("verify", phase)
            assertTrue("Seed must survive the APK replacement", marker.exists())
            val before = marker.readLines()
            assertTrue("Upgrade uses a new process", before[0].toInt() != Process.myPid())
            assertTrue("Upgrade must increase versionCode", before[1].toLong() < info.longVersionCode)
            assertNotEquals("Upgrade must identify a new version", before[2], version)
            // The production Application's own AuthSession reads storage first, as the first launch after an update does,
            // without contacting a real backend. Its log ("OrbitAuth" in this process's logcat) names any failure's classes.
            val applicationSession = (context as OrbitApplication).session
            applicationSession.restore()
            val restored = applicationSession.state.value as? AuthState.SignedIn
                ?: throw AssertionError("Restored ${applicationSession.state.value}; ${storageState(context)}",
                    runCatching { credentials.load() }.exceptionOrNull())
            assertEquals(accounts.first(), restored.handle.account)
            assertEquals(tokens.user, restored.user)
            assertTrue("Encrypted credential must survive", stored(context, "credentials.load") { credentials.load() } == StoredSession(server.value, tokens))
            assertEquals(server.value, stored(context, "instances.load") { instances.load() })
            session.restore()
            val handle = (session.state.value as AuthState.SignedIn).handle
            session.request(handle, ApiRequest(listOf("users", "me")))
        }
        assertEquals(version, observedVersion)
        assertTrue(KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            .containsAlias("${context.packageName}.orbit.credentials.v1"))
        val encrypted = File(context.noBackupFilesDir, "orbit/credentials.bin").readBytes().decodeToString()
        assertFalse(encrypted.contains(tokens.accessToken))
        assertFalse(encrypted.contains(tokens.refreshToken))
        for ((index, account) in accounts.withIndex()) for (kind in DataKind.entries) {
            assertArrayEquals("Account/server namespace survives upgrade", "$index:$kind".encodeToByteArray(),
                stored(context, "data.read $index $kind") { data.read(account, kind, "same-id") })
        }
        assertNull(data.read(AccountKey(server.value, "absent-account"), DataKind.CACHE, "same-id"))
        assertNull(data.read(AccountKey("https://absent.example.test/", tokens.user.id), DataKind.CACHE, "same-id"))
        if (phase == "verify") {
            session.logout()
            assertNull(credentials.load())
            for (account in accounts) for (kind in DataKind.entries) assertNull(data.read(account, kind, "same-id"))
        }
        InstrumentationRegistry.getInstrumentation().sendStatus(0, Bundle().apply {
            putString("a14_phase", phase)
            putString("a14_pid", Process.myPid().toString())
            putString("a14_package", context.packageName)
            putString("a14_version_name", version)
            putString("a14_version_code", info.longVersionCode.toString())
            putString("a14_source", source)
            putString("a14_source_dirty", field("SOURCE_DIRTY").toString())
            putString("a14_client_version", observedVersion)
            putString("a14_transport", "synthetic fixture; wire header is covered separately by HttpTransportTest")
            putString("a14_stores", "default production stores; Keystore credential; 4 isolated account/server namespaces")
            putString("a14_login", if (phase == "seed") "fixture login saved" else "production Application session restored; fixture request authenticated; logout purged")
        })
    }
}

/** Files under app-private orbit/ and this package's Keystore aliases, for a failure message. */
private fun storageState(context: Context): String {
    val root = File(context.noBackupFilesDir, "orbit")
    val files = root.walkTopDown().filter { it.isFile }.map { "${it.relativeTo(root)}(${it.length()})" }.toList()
    val aliases = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.aliases().toList()
        .filter { it.startsWith(context.packageName) }.sorted()
    return "orbit/ files ${files.filterNot { it.startsWith("accounts/") }} + ${files.count { it.startsWith("accounts/") }} under accounts/; keys $aliases"
}

/** A storage read that names itself, and what storage held, when it fails; the SecureStorageException's cause is the original. */
private suspend fun <T> stored(context: Context, step: String, read: suspend () -> T): T = try {
    read()
} catch (error: SecureStorageException) {
    throw AssertionError("$step: ${error.message}; ${storageState(context)}", error)
}
