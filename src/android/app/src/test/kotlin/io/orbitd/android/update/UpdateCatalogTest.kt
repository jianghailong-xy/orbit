package io.orbitd.android.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UpdateCatalogTest {
    private val signer = "1535cc478f09a4209585518569428c9a0f12bd14add7309fba3547609ca82310"
    private val installed = Installed("io.orbitd.android", 5, 29, setOf(signer))

    private fun manifest(name: String = "0.2.0", code: Long = 6) = UpdateManifest(
        schemaVersion = 1, tag = "v$name", applicationId = "io.orbitd.android", versionName = name, versionCode = code, minSdk = 29,
        apkName = "orbit-android-$name.apk", apkUrl = "https://github.com/o/r/releases/download/v$name/orbit-android-$name.apk",
        apkSize = 1234, sha256 = "AB".repeat(32), certSha256 = signer.chunked(2).joinToString(":") { it.uppercase() },
    )

    private fun release(m: UpdateManifest, tag: String = "v${m.versionName}", draft: Boolean = false) = GitHubRelease(tag, draft,
        listOf(GitHubAsset(m.apkName, m.apkUrl, m.apkSize), GitHubAsset("android-update.json", "https://github.com/o/r/m.json", 300)))

    @Test fun acceptsOnlyAStrictlyNewerReleaseOfThisPackageAndSigner() {
        val m = manifest()
        assertNull(UpdateCatalog.rejection(release(m), m, installed))
        assertEquals("versionCode", UpdateCatalog.rejection(release(manifest(code = 5)), manifest(code = 5), installed))
        assertEquals("applicationId", UpdateCatalog.rejection(release(m), m.copy(applicationId = "io.orbitd.android.debug"), installed))
        assertEquals("certificate", UpdateCatalog.rejection(release(m), m.copy(certSha256 = "00".repeat(32)), installed))
        assertEquals("certificate", UpdateCatalog.rejection(release(m), m, installed.copy(signers = setOf(signer, "11".repeat(32)))))
        assertEquals("minSdk", UpdateCatalog.rejection(release(m), m.copy(minSdk = 30), installed))
        // The release is the one the manifest names, and both are v + versionName.
        assertEquals("tag", UpdateCatalog.rejection(release(m, tag = "v0.2.1"), m, installed))
        assertEquals("tag", UpdateCatalog.rejection(release(m), m.copy(tag = "v0.2.1"), installed))
        assertEquals("tag", UpdateCatalog.rejection(release(m, tag = "android-v0.2.0"), m.copy(tag = "android-v0.2.0"), installed))
        assertEquals("schema", UpdateCatalog.rejection(release(m), m.copy(schemaVersion = 2), installed))
        assertEquals("sha256", UpdateCatalog.rejection(release(m), m.copy(sha256 = "xyz"), installed))
        assertEquals("size", UpdateCatalog.rejection(release(m), m.copy(apkSize = 0), installed))
        // The manifest may only point at an APK asset of its own release, with the published size.
        assertEquals("asset", UpdateCatalog.rejection(release(m), m.copy(apkUrl = "https://example.test/orbit.apk"), installed))
        assertEquals("asset", UpdateCatalog.rejection(release(m.copy(apkSize = 99)), m, installed))
    }

    @Test fun candidatesAreVTaggedReleasesWithAManifestAndNeverDrafts() {
        val android = release(manifest())
        val releases = listOf(
            // A v* release the Android jobs did not publish to (macOS-only, as every release before them).
            GitHubRelease("v1.4.0", false, listOf(GitHubAsset("Orbit-v1.4.0-arm64.dmg", "https://x/o.dmg", 1))),
            android.copy(tag = "v0.3.0", draft = true),
            // The retired android-v* scheme is no source of updates, manifest or not.
            android.copy(tag = "android-v0.3.0"),
            GitHubRelease("v0.2.5", false, listOf(GitHubAsset("orbit-android-0.2.5.apk", "https://x/orbit.apk", 1))),
            android,
        )
        assertEquals(listOf("v0.2.0"), UpdateCatalog.candidates(releases).map { it.first.tag })
        assertEquals(UpdateCatalog.CANDIDATE_LIMIT, UpdateCatalog.candidates(List(20) { android }).size)
    }

    @Test fun aPreReleaseFromTheListApiIsACandidate() {
        // GitHub's list shape, trimmed: every v* release so far is a pre-release, and fields the app ignores abound.
        val list = """[{"tag_name":"v0.1.2-beta.196","draft":false,"prerelease":true,"immutable":false,"assets":[
            {"name":"Orbit-v0.1.2-beta.196-arm64.dmg","browser_download_url":"https://x/o.dmg","size":15379638,"digest":"sha256:00"},
            {"name":"android-update.json","browser_download_url":"https://x/m.json","size":900,"state":"uploaded"}]},
            {"tag_name":"v0.1.2-beta.195","draft":true,"prerelease":true,"assets":[
            {"name":"android-update.json","browser_download_url":"https://x/d.json","size":900}]}]"""
        val releases = UpdateCatalog.json.decodeFromString<List<GitHubRelease>>(list)
        assertEquals(listOf("v0.1.2-beta.196" to "https://x/m.json"),
            UpdateCatalog.candidates(releases).map { (release, asset) -> release.tag to asset.url })
    }

    @Test fun rateLimitsFollowGitHubHeaders() {
        val now = 1_000_000L
        fun headers(vararg pairs: Pair<String, String>): (String) -> String? = { name -> pairs.toMap()[name] }
        assertEquals(now + 30_000, UpdateCatalog.rateLimitedUntil(429, headers("retry-after" to "30"), now))
        assertEquals(5_000_000L, UpdateCatalog.rateLimitedUntil(403,
            headers("x-ratelimit-remaining" to "0", "x-ratelimit-reset" to "5000"), now))
        assertEquals(now + 3_600_000, UpdateCatalog.rateLimitedUntil(403, headers("x-ratelimit-remaining" to "0"), now))
        assertNull("A 403 that is not a rate limit is an ordinary failure", UpdateCatalog.rateLimitedUntil(403, headers(), now))
        assertNull(UpdateCatalog.rateLimitedUntil(500, headers("retry-after" to "30"), now))
        assertEquals(signer, UpdateCatalog.digest(signer.chunked(2).joinToString(":") { it.uppercase() }))
    }
}
