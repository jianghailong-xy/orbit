package io.orbitd.android.update

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** One GitHub release as the list API returns it, reduced to what selection reads. */
@Serializable
internal data class GitHubRelease(
    @SerialName("tag_name") val tag: String = "",
    val draft: Boolean = false,
    val assets: List<GitHubAsset> = emptyList(),
)

@Serializable
internal data class GitHubAsset(
    val name: String = "",
    @SerialName("browser_download_url") val url: String = "",
    val size: Long = 0,
)

/** android-update.json, written by android-release.yml beside the APK of every android-v* release. */
@Serializable
data class UpdateManifest(
    val schemaVersion: Int,
    val applicationId: String,
    val versionName: String,
    val versionCode: Long,
    val minSdk: Int,
    val apkName: String,
    val apkUrl: String,
    val apkSize: Long,
    val sha256: String,
    val certSha256: String,
    val sourceSha: String = "",
    val publishedAt: String = "",
    val notes: String = "",
)

@Serializable
data class AppRelease(val tag: String, val manifest: UpdateManifest)

/** What this installation is: the release a manifest must strictly improve on. */
internal data class Installed(val applicationId: String, val versionCode: Long, val sdk: Int, val signers: Set<String>)

internal object UpdateCatalog {
    const val TAG_PREFIX = "android-v"
    const val MANIFEST = "android-update.json"
    const val MAX_APK_BYTES = 200L * 1024 * 1024
    // The repository's macOS releases share the list; never read releases/latest, which can be one of them.
    const val CANDIDATE_LIMIT = 10
    private val sha256 = Regex("[0-9a-f]{64}")
    val json = Json { ignoreUnknownKeys = true }

    /** Published android-v* releases with a manifest, in GitHub's newest-first order. Drafts never count. */
    fun candidates(releases: List<GitHubRelease>): List<Pair<GitHubRelease, GitHubAsset>> = releases.asSequence()
        .filter { !it.draft && it.tag.startsWith(TAG_PREFIX) }
        .mapNotNull { release -> release.assets.firstOrNull { it.name == MANIFEST }?.let { release to it } }
        .take(CANDIDATE_LIMIT).toList()

    /** Null when [manifest] is an installable update for [installed]; otherwise the first failed rule. */
    fun rejection(release: GitHubRelease, manifest: UpdateManifest, installed: Installed): String? = when {
        manifest.schemaVersion != 1 -> "schema"
        release.tag != TAG_PREFIX + manifest.versionName -> "tag"
        manifest.applicationId != installed.applicationId -> "applicationId"
        installed.signers != setOf(digest(manifest.certSha256)) -> "certificate"
        manifest.minSdk > installed.sdk -> "minSdk"
        manifest.versionCode <= installed.versionCode -> "versionCode"
        !digest(manifest.sha256).matches(sha256) -> "sha256"
        manifest.apkSize !in 1..MAX_APK_BYTES -> "size"
        release.assets.none { it.name == manifest.apkName && it.url == manifest.apkUrl && it.size == manifest.apkSize } -> "asset"
        else -> null
    }

    /** Normalizes apksigner/keytool fingerprints ("AB:CD…") to lowercase hex. */
    fun digest(value: String) = value.replace(":", "").lowercase()

    /** GitHub reports an exhausted limit as 403/429; retry-after or x-ratelimit-reset says when to try again. */
    fun rateLimitedUntil(code: Int, header: (String) -> String?, now: Long): Long? {
        if (code != 403 && code != 429) return null
        header("retry-after")?.trim()?.toLongOrNull()?.let { return now + it * 1000 }
        val exhausted = header("x-ratelimit-remaining")?.trim() == "0"
        if (exhausted) header("x-ratelimit-reset")?.trim()?.toLongOrNull()?.let { return maxOf(now, it * 1000) }
        return if (exhausted || code == 429) now + 60 * 60 * 1000 else null
    }
}
