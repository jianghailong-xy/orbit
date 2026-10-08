package io.orbitd.android.update

import android.app.Activity
import android.app.Application
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.core.content.edit
import io.orbitd.android.BuildConfig
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.ResponseBody

sealed interface UpdateState {
    data object Disabled : UpdateState
    data object Idle : UpdateState
    data object Checking : UpdateState
    data object Current : UpdateState
    data class Available(val release: AppRelease) : UpdateState
    data class Downloading(val release: AppRelease, val received: Long) : UpdateState
    data class Verifying(val release: AppRelease) : UpdateState
    data class PermissionRequired(val release: AppRelease) : UpdateState
    data class Installing(val release: AppRelease) : UpdateState
    data class Failed(val reason: UpdateFailure, val release: AppRelease? = null, val retryAt: Long? = null) : UpdateState
}

enum class UpdateFailure { OFFLINE, RATE_LIMITED, CHECK_FAILED, DOWNLOAD_FAILED, CHECKSUM, SIGNATURE, INSTALL_CANCELLED, INSTALL_FAILED }

/** The package facts the updater trusts: who signed this installation and what a downloaded archive is. */
interface PackageInspector {
    fun installedSigners(): Set<String>
    fun archive(apk: File): ArchiveIdentity?
    fun canRequestInstalls(): Boolean
}

data class ArchiveIdentity(val packageName: String, val versionCode: Long, val signers: Set<String>)

fun interface ApkInstaller { fun install(apk: File) }

data class UpdateConfig(
    val enabled: Boolean,
    val releasesUrl: String,
    val applicationId: String,
    val versionCode: Long,
    val sdk: Int,
    val userAgent: String,
    val interval: Long = 6 * 60 * 60 * 1000L,
) {
    companion object {
        /** Debug builds (.debug) never look for release updates. */
        fun forBuild() = UpdateConfig(
            enabled = !BuildConfig.DEBUG,
            releasesUrl = "${BuildConfig.UPDATE_API}/repos/${BuildConfig.UPDATE_REPOSITORY}/releases?per_page=${UpdateCatalog.PAGE_SIZE}",
            applicationId = BuildConfig.APPLICATION_ID,
            versionCode = BuildConfig.VERSION_CODE.toLong(),
            sdk = Build.VERSION.SDK_INT,
            userAgent = "Orbit-Android/${BuildConfig.VERSION_NAME}",
        )
    }
}

/**
 * Looks for a newer v* GitHub release carrying this exact package and signer, downloads it into
 * app-private storage, checks its SHA-256 and signing certificate, then hands it to PackageInstaller.
 * Automatic checks run when the app starts or returns to the foreground, at most once per interval,
 * and fail silently; only a manual check reports why it could not finish. Nothing here touches the
 * account, session or business state.
 */
class AppUpdater(
    private val app: Application,
    private val scope: CoroutineScope,
    private val config: UpdateConfig,
    private val inspector: PackageInspector = AndroidPackageInspector(app),
    private val installer: ApkInstaller = SessionInstaller(app),
    private val client: OkHttpClient = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS).build(),
    private val clock: () -> Long = System::currentTimeMillis,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) : Application.ActivityLifecycleCallbacks {
    private val prefs = app.getSharedPreferences("orbit.updates", Context.MODE_PRIVATE)
    private val directory = File(app.noBackupFilesDir, "updates")
    private val mutableState = MutableStateFlow<UpdateState>(if (config.enabled) UpdateState.Idle else UpdateState.Disabled)
    val state = mutableState.asStateFlow()
    private val mutablePrompt = MutableStateFlow<AppRelease?>(null)
    /** A release found by an automatic check that the user has not set aside yet. */
    val prompt = mutablePrompt.asStateFlow()
    private val mutableConfirmation = MutableStateFlow<Intent?>(null)
    /** PackageInstaller's confirmation screen, for whichever Activity is visible to start. */
    val confirmation = mutableConfirmation.asStateFlow()
    private val checking = Mutex()
    private var started = 0
    private var background = true
    @Volatile private var verified: Pair<AppRelease, File>? = null

    fun start() {
        app.registerActivityLifecycleCallbacks(this)
        if (!config.enabled) return
        // An update the user started and verified survives process death (for example while allowing
        // unknown apps in Settings): offer it again; installing reuses the file after re-checking it.
        val pending = prefs.getString(PENDING, null)?.let { runCatching { UpdateCatalog.json.decodeFromString<AppRelease>(it) }.getOrNull() }
        if (pending != null && pending.manifest.versionCode > config.versionCode && apkFile(pending).isFile) {
            mutableState.value = UpdateState.Available(pending)
            mutablePrompt.value = pending
        } else {
            prefs.edit { remove(PENDING) }
        }
        scope.launch(io) { removeStaleDownloads() }
    }

    /** Automatic check: skipped when disabled, busy, rate limited, or within [UpdateConfig.interval] of the last one. */
    fun checkAutomatically(): Boolean {
        val now = clock()
        if (!config.enabled || busy() || now < prefs.getLong(LIMITED_UNTIL, 0)) return false
        // A clock set back before the last check allows a new one rather than waiting out the gap.
        if (prefs.getLong(LAST_AUTOMATIC, Long.MIN_VALUE) in (now - config.interval + 1)..now) return false
        prefs.edit { putLong(LAST_AUTOMATIC, now) }
        scope.launch { check(manual = false) }
        return true
    }

    fun checkNow() {
        if (!config.enabled || busy()) return
        val until = prefs.getLong(LIMITED_UNTIL, 0)
        if (clock() < until) mutableState.value = UpdateState.Failed(UpdateFailure.RATE_LIMITED, retryAt = until)
        else scope.launch { check(manual = true) }
    }

    /** Downloads and verifies [release] (reusing an already verified file), then installs it. */
    fun install(release: AppRelease) {
        if (!config.enabled || busy() && state.value !is UpdateState.PermissionRequired) return
        val ready = verified?.takeIf { it.first == release && it.second.isFile }
        if (ready != null) proceed(release, ready.second) else {
            mutableState.value = UpdateState.Downloading(release, 0)
            scope.launch { download(release) }
        }
    }

    fun dismissPrompt() {
        val release = mutablePrompt.value ?: return
        prefs.edit { putLong(DISMISSED, release.manifest.versionCode).remove(PENDING) }
        mutablePrompt.value = null
        if (state.value is UpdateState.PermissionRequired) mutableState.value = UpdateState.Available(release)
    }

    fun confirmationShown() { mutableConfirmation.value = null }

    internal fun onInstallStatus(status: Int, confirm: Intent?) {
        val release = when (val current = state.value) {
            is UpdateState.Installing -> current.release
            is UpdateState.Failed -> current.release
            else -> null
        }
        when {
            status == PackageInstaller.STATUS_PENDING_USER_ACTION && confirm != null -> {
                mutableConfirmation.value = confirm
                return
            }
            status == PackageInstaller.STATUS_SUCCESS -> { mutablePrompt.value = null; mutableState.value = UpdateState.Current }
            status == PackageInstaller.STATUS_FAILURE_ABORTED ->
                mutableState.value = UpdateState.Failed(UpdateFailure.INSTALL_CANCELLED, release)
            else -> mutableState.value = UpdateState.Failed(UpdateFailure.INSTALL_FAILED, release)
        }
        prefs.edit { remove(PENDING) }
    }

    private fun busy() = when (state.value) {
        is UpdateState.Checking, is UpdateState.Downloading, is UpdateState.Verifying,
        is UpdateState.PermissionRequired, is UpdateState.Installing -> true
        else -> false
    }

    private suspend fun check(manual: Boolean) {
        if (!checking.tryLock()) return
        try {
            val before = state.value
            if (manual) mutableState.value = UpdateState.Checking
            val outcome = try {
                withContext(io) { newest() }
            } catch (e: CancellationException) {
                throw e
            } catch (e: IOException) {
                Outcome.Failed(UpdateFailure.OFFLINE)
            } catch (e: Exception) {
                Outcome.Failed(UpdateFailure.CHECK_FAILED)
            }
            when (outcome) {
                is Outcome.Found -> {
                    mutableState.value = UpdateState.Available(outcome.release)
                    if (!manual && outcome.release.manifest.versionCode > prefs.getLong(DISMISSED, 0)) mutablePrompt.value = outcome.release
                }
                Outcome.Current -> mutableState.value = UpdateState.Current
                is Outcome.Limited -> {
                    prefs.edit { putLong(LIMITED_UNTIL, outcome.until) }
                    mutableState.value = if (manual) UpdateState.Failed(UpdateFailure.RATE_LIMITED, retryAt = outcome.until) else before
                }
                is Outcome.Failed -> mutableState.value = if (manual) UpdateState.Failed(outcome.reason) else before
            }
        } finally {
            checking.unlock()
        }
    }

    private fun newest(): Outcome {
        val request = Request.Builder().url(config.releasesUrl).header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28").header("User-Agent", config.userAgent).build()
        val releases = client.newCall(request).execute().use { response ->
            UpdateCatalog.rateLimitedUntil(response.code, { response.header(it) }, clock())?.let { return Outcome.Limited(it) }
            if (!response.isSuccessful) return Outcome.Failed(UpdateFailure.CHECK_FAILED)
            UpdateCatalog.json.decodeFromString<List<GitHubRelease>>(response.body!!.limited(LIST_LIMIT))
        }
        val installed = Installed(config.applicationId, config.versionCode, config.sdk, inspector.installedSigners())
        var unread: UpdateFailure? = null
        val updates = UpdateCatalog.candidates(releases).mapNotNull { (release, asset) ->
            val manifest = try {
                manifest(asset)
            } catch (e: IOException) {
                unread = unread ?: UpdateFailure.OFFLINE
                null
            } catch (e: ManifestUnavailable) {
                unread = unread ?: UpdateFailure.CHECK_FAILED
                null
            } catch (e: IllegalArgumentException) {
                null // Not a manifest this app understands; never an update.
            }
            manifest?.takeIf { UpdateCatalog.rejection(release, it, installed) == null }?.let { AppRelease(release.tag, it) }
        }
        val newest = updates.maxByOrNull { it.manifest.versionCode }
        return when {
            newest != null -> Outcome.Found(newest)
            unread != null -> Outcome.Failed(unread!!)
            else -> Outcome.Current
        }
    }

    private fun manifest(asset: GitHubAsset): UpdateManifest? {
        if (asset.size !in 1..MANIFEST_LIMIT) return null
        val request = Request.Builder().url(asset.url).header("User-Agent", config.userAgent).build()
        return client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw ManifestUnavailable(response.code)
            UpdateCatalog.json.decodeFromString<UpdateManifest>(response.body!!.limited(MANIFEST_LIMIT))
        }
    }

    private suspend fun download(release: AppRelease) {
        val manifest = release.manifest
        val apk = apkFile(release)
        val failure = try {
            withContext(io) { fetch(release, apk) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: IOException) {
            UpdateFailure.DOWNLOAD_FAILED
        }
        if (failure != null) {
            mutableState.value = UpdateState.Failed(failure, release)
            return
        }
        mutableState.value = UpdateState.Verifying(release)
        val signed = withContext(io) {
            val archive = runCatching { inspector.archive(apk) }.getOrNull()
            val installed = inspector.installedSigners()
            archive != null && archive.packageName == config.applicationId && archive.versionCode == manifest.versionCode &&
                archive.signers == installed && installed == setOf(UpdateCatalog.digest(manifest.certSha256))
        }
        if (!signed) {
            apk.delete()
            mutableState.value = UpdateState.Failed(UpdateFailure.SIGNATURE, release)
            return
        }
        verified = release to apk
        prefs.edit { putString(PENDING, UpdateCatalog.json.encodeToString(release)) }
        proceed(release, apk)
    }

    /** Streams into a .part file while hashing; only a download matching the published SHA-256 is kept. */
    private fun fetch(release: AppRelease, apk: File): UpdateFailure? {
        val manifest = release.manifest
        val expected = UpdateCatalog.digest(manifest.sha256)
        directory.mkdirs()
        if (apk.isFile && sha256(apk) == expected) return null
        val part = File(directory, apk.name + ".part")
        part.delete()
        apk.delete()
        val digest = MessageDigest.getInstance("SHA-256")
        val request = Request.Builder().url(manifest.apkUrl).header("User-Agent", config.userAgent).build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) return UpdateFailure.DOWNLOAD_FAILED
            var received = 0L
            var reported = 0L
            response.body!!.byteStream().use { input ->
                part.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        received += read
                        if (received > manifest.apkSize) break
                        digest.update(buffer, 0, read)
                        output.write(buffer, 0, read)
                        if (received - reported >= PROGRESS_STEP) {
                            reported = received
                            mutableState.value = UpdateState.Downloading(release, received)
                        }
                    }
                    output.fd.sync()
                }
            }
        }
        if (hex(digest.digest()) != expected) {
            part.delete()
            return UpdateFailure.CHECKSUM
        }
        if (!part.renameTo(apk)) throw IOException("Could not keep the verified download")
        return null
    }

    private fun proceed(release: AppRelease, apk: File) {
        if (!inspector.canRequestInstalls()) {
            mutableState.value = UpdateState.PermissionRequired(release)
            return
        }
        mutableState.value = UpdateState.Installing(release)
        scope.launch(io) {
            try {
                installer.install(apk)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                mutableState.value = UpdateState.Failed(UpdateFailure.INSTALL_FAILED, release)
            }
        }
    }

    private fun apkFile(release: AppRelease) = File(directory, "orbit-${release.manifest.versionCode}.apk")

    private fun removeStaleDownloads() {
        directory.listFiles()?.forEach { file ->
            val code = Regex("orbit-(\\d+)\\.apk").matchEntire(file.name)?.groupValues?.get(1)?.toLongOrNull()
            if (code == null || code <= config.versionCode) file.delete()
        }
    }

    override fun onActivityStarted(activity: Activity) {
        started++
        if (started != 1 || !background) return
        background = false
        // Returning from "Install unknown apps" with the permission granted continues the same update.
        val waiting = state.value as? UpdateState.PermissionRequired
        val ready = verified?.takeIf { it.first == waiting?.release && it.second.isFile }
        if (waiting != null && ready != null && inspector.canRequestInstalls()) proceed(waiting.release, ready.second)
        checkAutomatically()
    }

    override fun onActivityStopped(activity: Activity) {
        started--
        if (started == 0 && !activity.isChangingConfigurations) background = true
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
    override fun onActivityResumed(activity: Activity) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) = Unit

    private class ManifestUnavailable(code: Int) : Exception("Manifest HTTP $code")

    private sealed interface Outcome {
        data class Found(val release: AppRelease) : Outcome
        data object Current : Outcome
        data class Limited(val until: Long) : Outcome
        data class Failed(val reason: UpdateFailure) : Outcome
    }

    private companion object {
        const val LAST_AUTOMATIC = "lastAutomaticCheck"
        const val LIMITED_UNTIL = "rateLimitedUntil"
        const val DISMISSED = "dismissedVersionCode"
        const val PENDING = "pendingRelease"
        const val LIST_LIMIT = 8L * 1024 * 1024
        const val MANIFEST_LIMIT = 64L * 1024
        const val PROGRESS_STEP = 256L * 1024
    }
}

private fun ResponseBody.limited(limit: Long): String {
    val source = source()
    if (source.request(limit + 1)) throw IOException("Response exceeds $limit bytes")
    return source.readUtf8()
}

private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            digest.update(buffer, 0, read)
        }
    }
    return hex(digest.digest())
}

internal class AndroidPackageInspector(private val context: Context) : PackageInspector {
    @Suppress("DEPRECATION")
    override fun installedSigners(): Set<String> =
        context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES).signers()

    @Suppress("DEPRECATION")
    override fun archive(apk: File): ArchiveIdentity? {
        val packages = context.packageManager
        // Some releases leave signingInfo empty for archives; GET_SIGNATURES still reports the signer there.
        val info = packages.getPackageArchiveInfo(apk.path, PackageManager.GET_SIGNING_CERTIFICATES)?.takeIf { it.signingInfo != null }
            ?: packages.getPackageArchiveInfo(apk.path, PackageManager.GET_SIGNATURES) ?: return null
        return ArchiveIdentity(info.packageName, info.longVersionCode, info.signers())
    }

    override fun canRequestInstalls() = context.packageManager.canRequestPackageInstalls()

    @Suppress("DEPRECATION")
    private fun PackageInfo.signers(): Set<String> = (signingInfo?.apkContentsSigners ?: signatures ?: emptyArray())
        .map { hex(MessageDigest.getInstance("SHA-256").digest(it.toByteArray())) }.toSet()
}

/** Writes the verified APK into a PackageInstaller session; the result arrives at [UpdateInstallReceiver]. */
internal class SessionInstaller(private val context: Context) : ApkInstaller {
    override fun install(apk: File) {
        val packages = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            setSize(apk.length())
            setInstallReason(PackageManager.INSTALL_REASON_USER)
        }
        val id = packages.createSession(params)
        try {
            packages.openSession(id).use { session ->
                apk.inputStream().use { input ->
                    session.openWrite("base.apk", 0, apk.length()).use { output ->
                        input.copyTo(output)
                        session.fsync(output)
                    }
                }
                // PackageInstaller adds its status extras, so the explicit broadcast must be mutable.
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                val status = Intent(context, UpdateInstallReceiver::class.java).setPackage(context.packageName)
                session.commit(PendingIntent.getBroadcast(context, id, status, flags).intentSender)
            }
        } catch (e: Exception) {
            packages.abandonSession(id)
            throw e
        }
    }
}
