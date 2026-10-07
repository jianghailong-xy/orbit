package io.orbitd.android.update

import android.app.Activity
import android.app.Application
import android.content.Intent
import android.content.pm.PackageInstaller
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** A fake GitHub: the releases list API plus release-download URLs for manifests and APKs. */
internal class GitHubFixture(val server: MockWebServer) {
    val releases = mutableListOf<String>()
    val files = ConcurrentHashMap<String, ByteArray>()
    val hits = ConcurrentHashMap<String, AtomicInteger>()
    @Volatile var list: (() -> MockResponse)? = null
    val listUrl get() = server.url("/repos/o/r/releases?per_page=100").toString()

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                hits.getOrPut(path) { AtomicInteger() }.incrementAndGet()
                if (path == "/repos/o/r/releases") return list?.invoke()
                    ?: MockResponse().setBody(releases.joinToString(",", "[", "]"))
                return files[path]?.let { MockResponse().setBody(Buffer().write(it)) } ?: MockResponse().setResponseCode(404)
            }
        }
    }

    fun count(path: String) = hits[path]?.get() ?: 0

    /** Publishes an android-v* release with its APK and android-update.json, as android-release.yml does. */
    fun publish(name: String, code: Long, apk: ByteArray, cert: String, applicationId: String = "io.orbitd.android",
                draft: Boolean = false, sha: String = sha256(apk)): UpdateManifest {
        val tag = "android-v$name"
        val apkName = "orbit-android-$name.apk"
        val apkUrl = server.url("/download/$tag/$apkName").toString()
        val manifest = UpdateManifest(1, applicationId, name, code, 29, apkName, apkUrl, apk.size.toLong(), sha, cert,
            sourceSha = "0".repeat(40), publishedAt = "2026-10-07T00:00:00Z", notes = "Notes for $name")
        val manifestBytes = Json.encodeToString(manifest).encodeToByteArray()
        files["/download/$tag/$apkName"] = apk
        files["/download/$tag/android-update.json"] = manifestBytes
        releases += """{"tag_name":"$tag","draft":$draft,"prerelease":true,"assets":[
            {"name":"$apkName","browser_download_url":"$apkUrl","size":${apk.size}},
            {"name":"$apkName.sha256","browser_download_url":"${apkUrl}.sha256","size":80},
            {"name":"android-update.json","browser_download_url":"${server.url("/download/$tag/android-update.json")}","size":${manifestBytes.size}}]}"""
        return manifest
    }

    companion object {
        fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }
}

internal class FakeInspector(var signers: Set<String>) : PackageInspector {
    var archive: (File) -> ArchiveIdentity? = { null }
    var canInstall = true
    override fun installedSigners() = signers
    override fun archive(apk: File) = archive.invoke(apk)
    override fun canRequestInstalls() = canInstall
}

class Rotating : Activity() {
    override fun isChangingConfigurations() = true
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = Application::class)
class AppUpdaterTest {
    private val server = MockWebServer()
    private val github = GitHubFixture(server)
    private val signer = "1535cc478f09a4209585518569428c9a0f12bd14add7309fba3547609ca82310"
    private val inspector = FakeInspector(setOf(signer))
    private val installed = mutableListOf<File>()
    private var now = 1_800_000_000_000L
    private val app: Application get() = RuntimeEnvironment.getApplication()
    private val hour = 60 * 60 * 1000L

    @Before fun start() { server.start() }
    @After fun stop() { server.shutdown() }

    private fun updater(enabled: Boolean = true) = AppUpdater(app, CoroutineScope(Dispatchers.Unconfined),
        UpdateConfig(enabled, github.listUrl, "io.orbitd.android", 5, 29, "Orbit-Android/test"),
        inspector, { installed += it }, OkHttpClient(), { now }, Dispatchers.Unconfined)

    private fun foreground(updater: AppUpdater) {
        val activity = Robolectric.buildActivity(Activity::class.java).get()
        updater.onActivityStarted(activity)
        updater.onActivityStopped(activity)
    }

    private fun apk(seed: Int) = ByteArray(300_000) { (it * 31 + seed).toByte() }

    private fun acceptArchive(code: Long) {
        inspector.archive = { ArchiveIdentity("io.orbitd.android", code, setOf(signer)) }
    }

    @Test fun picksTheHighestCompatibleAndroidReleaseAndPromptsOnce() {
        github.releases += """{"tag_name":"v1.9.0","draft":false,"assets":[{"name":"Orbit.dmg","browser_download_url":"x","size":1}]}"""
        github.publish("0.9.0", 9, apk(1), signer, draft = true)
        github.publish("0.8.0", 8, apk(2), signer, applicationId = "io.orbitd.android.upgradetest")
        github.publish("0.7.0", 7, apk(3), "00".repeat(32))
        github.publish("0.6.0", 6, apk(4), signer.uppercase())
        github.publish("0.4.0", 4, apk(5), signer)
        val updater = updater()

        foreground(updater)

        val found = (updater.state.value as UpdateState.Available).release
        assertEquals(6L, found.manifest.versionCode)
        assertEquals("android-v0.6.0", found.tag)
        assertSame(found, updater.prompt.value)
        assertEquals("Draft releases are never read", 0, github.count("/download/android-v0.9.0/android-update.json"))
        updater.dismissPrompt()
        assertNull(updater.prompt.value)

        now += 7 * hour
        foreground(updater)
        assertNull("A dismissed version is not prompted again", updater.prompt.value)
        github.publish("0.6.1", 10, apk(6), signer)
        now += 7 * hour
        foreground(updater)
        assertEquals(10L, updater.prompt.value!!.manifest.versionCode)
    }

    @Test fun automaticChecksRunOnStartAndForegroundAtMostEverySixHours() {
        val updater = updater()
        foreground(updater)
        assertEquals(1, github.count("/repos/o/r/releases"))
        assertEquals(UpdateState.Current, updater.state.value)

        now += 5 * hour
        val activity = Robolectric.buildActivity(Activity::class.java).get()
        updater.onActivityStarted(activity)
        assertEquals("Within six hours nothing is requested", 1, github.count("/repos/o/r/releases"))
        // Rotation stops the old instance for a configuration change: not a return to the foreground.
        updater.onActivityStopped(Robolectric.buildActivity(Rotating::class.java).get())
        now += hour
        updater.onActivityStarted(activity)
        assertEquals(1, github.count("/repos/o/r/releases"))

        updater.onActivityStopped(activity)
        foreground(updater)
        assertEquals(2, github.count("/repos/o/r/releases"))

        now -= 24 * hour // A clock moved back does not postpone checks for a day.
        foreground(updater)
        assertEquals(3, github.count("/repos/o/r/releases"))

        updater.checkNow()
        assertEquals("Manual checks are not throttled", 4, github.count("/repos/o/r/releases"))
    }

    @Test fun rateLimitsAndOutagesAreQuietForAutomaticChecks() {
        val reset = (now + 2 * hour) / 1000
        github.list = { MockResponse().setResponseCode(403).addHeader("x-ratelimit-remaining", "0").addHeader("x-ratelimit-reset", reset) }
        val updater = updater()

        foreground(updater)
        assertEquals(UpdateState.Idle, updater.state.value)
        assertNull(updater.prompt.value)

        updater.checkNow()
        val limited = updater.state.value as UpdateState.Failed
        assertEquals(UpdateFailure.RATE_LIMITED, limited.reason)
        assertEquals(reset * 1000, limited.retryAt)
        assertEquals("Waiting for the reset sends nothing", 1, github.count("/repos/o/r/releases"))

        now = reset * 1000 + 1
        github.list = { MockResponse().setResponseCode(502) }
        updater.checkNow()
        assertEquals(UpdateFailure.CHECK_FAILED, (updater.state.value as UpdateState.Failed).reason)

        server.shutdown()
        now += 7 * hour
        foreground(updater)
        assertEquals("An automatic check while offline changes nothing", UpdateFailure.CHECK_FAILED,
            (updater.state.value as UpdateState.Failed).reason)
        updater.checkNow()
        assertEquals(UpdateFailure.OFFLINE, (updater.state.value as UpdateState.Failed).reason)
    }

    @Test fun debugBuildsNeverAskGitHub() {
        github.publish("0.6.0", 6, apk(1), signer)
        val updater = updater(enabled = false)
        foreground(updater)
        updater.checkNow()
        assertEquals(UpdateState.Disabled, updater.state.value)
        assertEquals(0, server.requestCount)
    }

    @Test fun verifiedDownloadIsHandedToPackageInstaller() {
        val bytes = apk(7)
        github.publish("0.6.0", 6, bytes, signer)
        acceptArchive(6)
        val updater = updater()
        updater.checkNow()
        val release = (updater.state.value as UpdateState.Available).release

        updater.install(release)

        assertEquals(UpdateState.Installing(release), updater.state.value)
        val file = installed.single()
        assertEquals(File(app.noBackupFilesDir, "updates/orbit-6.apk"), file)
        assertTrue(file.readBytes().contentEquals(bytes))
        assertFalse(File(file.path + ".part").exists())

        val confirm = Intent("android.content.pm.action.CONFIRM_INSTALL")
        updater.onInstallStatus(PackageInstaller.STATUS_PENDING_USER_ACTION, confirm)
        assertSame(confirm, updater.confirmation.value)
        updater.confirmationShown()
        updater.onInstallStatus(PackageInstaller.STATUS_FAILURE_ABORTED, null)
        assertEquals(UpdateState.Failed(UpdateFailure.INSTALL_CANCELLED, release), updater.state.value)

        updater.install(release) // Try again reuses the verified file.
        assertEquals(1, github.count("/download/android-v0.6.0/orbit-android-0.6.0.apk"))
        assertEquals(2, installed.size)
    }

    @Test fun checksumMismatchDeletesTheDownload() {
        github.publish("0.6.0", 6, apk(8), signer, sha = "ab".repeat(32))
        acceptArchive(6)
        val updater = updater()
        updater.checkNow()
        val release = (updater.state.value as UpdateState.Available).release
        updater.install(release)
        assertEquals(UpdateState.Failed(UpdateFailure.CHECKSUM, release), updater.state.value)
        assertTrue(installed.isEmpty())
        assertTrue(File(app.noBackupFilesDir, "updates").listFiles().orEmpty().isEmpty())
    }

    @Test fun anApkSignedWithAnotherCertificateIsRejected() {
        github.publish("0.6.0", 6, apk(9), signer)
        inspector.archive = { ArchiveIdentity("io.orbitd.android", 6, setOf("00".repeat(32))) }
        val updater = updater()
        updater.checkNow()
        val release = (updater.state.value as UpdateState.Available).release
        updater.install(release)
        assertEquals(UpdateState.Failed(UpdateFailure.SIGNATURE, release), updater.state.value)
        assertTrue(installed.isEmpty())
        assertFalse(File(app.noBackupFilesDir, "updates/orbit-6.apk").exists())

        inspector.archive = { ArchiveIdentity("io.orbitd.android", 7, setOf(signer)) }
        updater.install(release)
        assertEquals("The archive must be the version the manifest names", UpdateState.Failed(UpdateFailure.SIGNATURE, release), updater.state.value)
    }

    @Test fun installPermissionIsRequestedAndTheUpdateResumesOnReturn() {
        github.publish("0.6.0", 6, apk(10), signer)
        acceptArchive(6)
        inspector.canInstall = false
        val updater = updater()
        foreground(updater)
        val release = updater.prompt.value!!

        updater.install(release)
        assertEquals(UpdateState.PermissionRequired(release), updater.state.value)
        assertTrue(installed.isEmpty())

        foreground(updater) // Back from Settings without allowing it: still waiting.
        assertEquals(UpdateState.PermissionRequired(release), updater.state.value)
        inspector.canInstall = true
        foreground(updater)
        assertEquals(UpdateState.Installing(release), updater.state.value)
        assertEquals(1, installed.size)
    }

    @Test fun downloadsOfOlderVersionsAreRemovedOnStart() {
        val dir = File(app.noBackupFilesDir, "updates").apply { mkdirs() }
        listOf("orbit-4.apk", "orbit-5.apk", "orbit-6.apk", "orbit-6.apk.part", "other").forEach { File(dir, it).writeText("x") }
        updater().start()
        assertEquals(listOf("orbit-6.apk"), dir.list()!!.sorted())
    }
}
