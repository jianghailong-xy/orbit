package io.orbitd.android.composer

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.AndroidComposeTestRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.test.ext.junit.rules.ActivityScenarioRule
import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertTrue
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/** The GitHub routes as a test answers them, with what was asked. */
internal class FakeGithub(
    var view: GithubIntegration,
    var repos: List<GithubRepository> = REPOS,
    var branches: List<String> = listOf("main", "dev", "release/1.4"),
    var failList: String? = null,
    var failStart: String? = null,
    var failRetry: String? = null,
) : GithubSource {
    val calls = CopyOnWriteArrayList<String>()
    override suspend fun integration(): GithubIntegration { calls += "integration"; return view }
    override suspend fun repositories(query: String): List<GithubRepository> {
        calls += "repos?q=$query"
        failList?.let { throw IllegalStateException(it) }
        return repos.filter { query.isEmpty() || it.fullName.contains(query, ignoreCase = true) }
    }
    override suspend fun branches(repoId: Long): GithubBranches { calls += "branches $repoId"; return GithubBranches("main", branches) }
    override suspend fun start(returnTo: String): String {
        calls += "start $returnTo"
        failStart?.let { throw IllegalStateException(it) }
        return "https://github.com/login/oauth/authorize?client_id=fixture"
    }
    override suspend fun disconnect(): GithubIntegration {
        calls += "disconnect"
        view = GithubIntegration(available = true, connected = false)
        return view
    }
    override suspend fun retryClone(workspaceId: String) {
        calls += "retry $workspaceId"
        failRetry?.let { throw IllegalStateException(it) }
    }

    companion object {
        const val NOW = "2026-11-16T12:00:00Z"
        private fun ago(minutes: Long) = java.time.Instant.now().minusSeconds(minutes * 60).toString()
        val REPOS = listOf(
            GithubRepository(101, "orbit-labs/orbit-web", true, "main", 9, ago(12)),
            GithubRepository(102, "orbit-labs/orbit-api", true, "main", 9, ago(3 * 60)),
            GithubRepository(103, "ada/dotfiles", false, "master", 7, ago(30 * 60)),
            GithubRepository(104, "orbit-labs/design", false, "main", 9, "2026-10-02T08:00:00Z"),
            GithubRepository(105, "ada/notes", true, "main", 7, "2026-09-20T08:00:00Z"),
            GithubRepository(106, "orbit-labs/runner", false, "main", 9, "2026-09-01T08:00:00Z"),
            GithubRepository(107, "orbit-labs/docs", false, "main", 9, "2026-08-01T08:00:00Z"),
            GithubRepository(108, "orbit-labs/infra", true, "main", 9, "2026-07-01T08:00:00Z"),
            GithubRepository(109, "orbit-labs/website", false, "main", 9, "2026-06-01T08:00:00Z"),
            GithubRepository(110, "ada/old-site", false, "gh-pages", 7, "2025-03-01T08:00:00Z"),
        )
        val INSTALLATIONS = listOf(
            GithubInstallation(7, "ada", "User", "selected", 3),
            GithubInstallation(9, "orbit-labs", "Organization", "all", 11),
        )
        fun connected() = GithubIntegration(
            available = true, connected = true, login = "ada", connectedAt = "2026-11-03T10:00:00Z",
            installations = INSTALLATIONS, installUrl = "https://github.com/apps/orbit-fixture/installations/new", workspaceCount = 2,
            workspaces = listOf(
                GithubWorkspace("w1", "orbit-web", "orbit@austin", "orbit-labs/orbit-web", "READY", "github-app"),
                GithubWorkspace("w2", "dotfiles", "ci-box", "ada/dotfiles", "READY", "machine"),
                GithubWorkspace("w3", "orbit-api", "orbit@austin", "orbit-labs/orbit-api", "CLONING", null),
            ),
        )
    }
}

internal fun ghJson(raw: String): JsonObject = Wire.json.parseToJsonElement(raw).jsonObject

/** A machine that clones: it declares clone-workdir/v1 and has a Repos Folder. */
internal fun cloningRunner(clones: Boolean = true) = ghJson("""{"id":"r1","name":"austin-mac","displayName":"orbit@austin","online":true,
    "lastHeartbeatAt":"2026-11-16T11:59:50Z","reposRoot":"/Users/austin/orbit-repos",
    "capabilities":["dir-probe/v1","create-workdir/v1"${if (clones) ",\"clone-workdir/v1\"" else ""}]}""")

/** Where the screenshots go: outside the repository, for the reviewer (ORBIT_SHOTS_DIR), or the build's evidence folder. */
internal val shotsDir: File by lazy {
    val named = System.getenv("ORBIT_SHOTS_DIR")?.takeIf { it.isNotBlank() }?.let(::File)
    (named ?: File(generateSequence(File(System.getProperty("user.dir")!!)) { it.parentFile }.first { File(it, "src/android").isDirectory },
        "src/android/build/evidence/github-workspaces-android")).also { it.mkdirs() }
}

/** The activity's window and any dialog over it, drawn into one PNG. */
internal fun AndroidComposeTestRule<ActivityScenarioRule<ComponentActivity>, ComponentActivity>.ghShot(name: String) {
    waitForIdle()
    val decor = activity.window.decorView
    val global = Class.forName("android.view.WindowManagerGlobal")
    val manager = global.getMethod("getInstance").invoke(null)
    val views = (global.getDeclaredField("mViews").apply { isAccessible = true }.get(manager) as List<*>).filterIsInstance<View>()
    val windows = listOf(decor) + views.filter { it !== decor && it.isAttachedToWindow && it.isShown && it.width > 0 }
    val bitmap = Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    windows.forEach { view ->
        val at = (view.layoutParams as? WindowManager.LayoutParams)?.takeIf { view !== decor }
        canvas.save()
        at?.let { canvas.translate(((decor.width - view.width) / 2).toFloat(), ((decor.height - view.height) / 2).toFloat()) }
        view.draw(canvas)
        canvas.restore()
    }
    val pixels = IntArray(bitmap.width * bitmap.height).also { bitmap.getPixels(it, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height) }
    assertTrue("$name is blank", pixels.distinct().size > 2)
    val file = File(shotsDir, "$name.png")
    file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    println("shot $name -> $file")
    bitmap.recycle()
}

internal fun AndroidComposeTestRule<ActivityScenarioRule<ComponentActivity>, ComponentActivity>.ghAwait(text: String) =
    waitUntil(30_000) { onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
