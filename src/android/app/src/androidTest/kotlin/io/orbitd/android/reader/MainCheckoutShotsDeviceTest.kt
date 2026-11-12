package io.orbitd.android.reader

import android.graphics.Bitmap
import android.os.SystemClock
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.MainActivity
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.ui.OrbitTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.serialization.json.*
import org.junit.Rule
import org.junit.Test
import java.io.File

/**
 * Emulator frames of the main checkout pieces (boards 01–04) drawn from the contract fixture's shapes: the card above the bar, the
 * review sheet with a file's diff open, a success line and a refusal line, and the turn-on isolation dialog. Saved into the app's
 * files under `main-checkout-shots/`, taken out with `run-as`.
 */
class MainCheckoutShotsDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private fun json(text: String) = Wire.json.parseToJsonElement(text)

    private val fp = "mc1:62325fb4a1c0d3e5f6a7b8c9d0e1f2a3b4c5d6e7:27a2714bb42c00aee96da70da7154696ed3f0e90e9fa66183614c6e8fdc54ba8"
    private val repo = json("""{"root":"/root/orbit","branch":"main","state":"dirty","head":"62325fb4a1c0d3e5f6a7b8c9d0e1f2a3b4c5d6e7",
        "upstream":"origin/main","ahead":0,"behind":0,"fileCount":3,"truncated":false,"fingerprint":"$fp"}""").jsonObject
    private val files = """[{"path":"src/api/client.ts","status":"M","contentHash":"a","additions":12,"deletions":3},
        {"path":"src/api/retry.test.ts","status":"A","contentHash":"b","untracked":true,"additions":58,"deletions":0},
        {"path":"src/api/retry.ts","status":"A","contentHash":"c","untracked":true,"additions":41,"deletions":0}]"""
    private val patch = "diff --git a/src/api/client.ts b/src/api/client.ts\n--- a/src/api/client.ts\n+++ b/src/api/client.ts\n" +
        "@@ -18,9 +18,18 @@ export async function request(path, init) {\n   const url = new URL(path, base);\n" +
        "-  for (let i = 0; i < 5; i++) {\n-    const res = await fetch(url, init);\n-    if (res.status !== 429) return res;\n" +
        "+  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {\n+    const res = await fetch(url, init);\n" +
        "+    if (res.status !== 429) return res;\n+    await sleep(backoff(attempt, res.headers.get('retry-after')));\n   }\n" +
        "   throw new RateLimitError(url);\n"
    private val view = json("""{"snapshot":{"root":"/root/orbit","branch":"main","head":"62325fb4a1c0d3e5f6a7b8c9d0e1f2a3b4c5d6e7","state":"dirty",
        "upstream":"origin/main","ahead":0,"behind":0,"files":$files,"fileCount":3,"truncated":false,"fingerprint":"$fp",
        "checkedAt":"${java.time.Instant.now().minusSeconds(12)}"},
        "actionsSupported":true,"managedBranch":null,"inFlight":null}""").jsonObject
    private val sessions = json("""[{"id":"sess-1","title":"Fix retry backoff","isolationStatus":"worktree","branch":"orbit/fix-retry-backoff","runStatus":"AWAITING_INPUT"},
        {"id":"sess-2","title":"Bump eslint to 9","isolationStatus":"worktree","branch":"orbit/bump-eslint","runStatus":"COMPLETED"},
        {"id":"sess-3","title":"Migrate settings table","isolationStatus":"worktree","branch":"orbit/settings-v2","runStatus":"RUNNING"}]""")

    private inner class Fake : MainCheckoutTransport {
        override suspend fun get(path: List<String>, query: List<Pair<String, String>>): JsonElement = when {
            path == listOf("sessions") -> sessions
            path.lastOrNull() == "main-checkout" && query.isNotEmpty() -> buildJsonObject {
                put("snapshot", view["snapshot"]!!)
                putJsonArray("diffs") { add(buildJsonObject { put("path", query.first().second); put("binary", false); put("patch", patch) }) }
            }
            path.lastOrNull() == "main-checkout" -> view
            else -> buildJsonObject { put("id", "ws-1"); put("mainCheckoutActions", true); put("repoHealth", repo) }
        }
        override suspend fun send(path: List<String>, method: HttpMethod, body: JsonObject?): JsonElement? = null
    }

    private fun model() = MainCheckoutModel(Fake(), "sess-1", CoroutineScope(SupervisorJob() + Dispatchers.Main)).also {
        it.bind("ws-1"); it.adoptWorkspace(buildJsonObject { put("id", "ws-1"); put("mainCheckoutActions", true); put("repoHealth", repo) })
    }

    private val notice get() = MainCheckout.changedNotice(json("""{"noticeKind":"main-checkout-changed","notice":"","root":"/root/orbit",
        "branch":"main","files":$files,"fileCount":3,"truncated":false,"fingerprint":"$fp"}""").jsonObject)!!

    private fun result(text: String) = MainCheckout.result(json(text).jsonObject)!!

    private fun show(content: @Composable (MainCheckoutModel) -> Unit) {
        val model = model()
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme { Surface(Modifier.fillMaxSize()) {
            CompositionLocalProvider(LocalMainCheckout provides model) { content(model) }
        } } } }
        compose.waitForIdle()
    }

    @Test fun shots() {
        // Board 01: the card at the end of a turn, the bar under it.
        show { model ->
            Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Added exponential backoff with jitter to the client and a test for the 429 path.")
                MainCheckoutCard(notice, "event:3")
                Spacer(Modifier.height(12.dp))
                MainCheckoutBar(model, "ws-1", isolated = true)
            }
        }
        capture("01-card-and-bar")
        compose.onNodeWithText("⋯").performClick()
        capture("01b-card-more-menu")

        // Board 02: the review sheet, a file's diff open.
        show { model ->
            Column(Modifier.padding(16.dp)) { MainCheckoutBar(model, "ws-1", isolated = true) }
            MainCheckoutSheets(model, isolated = true, sessionBranch = "orbit/fix-retry-backoff", sessionTitle = "Fix retry backoff")
        }
        compose.onNodeWithText("Review").performClick()
        compose.waitUntil(10_000) { runCatching { compose.onNodeWithText("src/api/client.ts").assertExists(); true }.getOrDefault(false) }
        compose.onNodeWithText("src/api/client.ts").performClick()
        compose.waitUntil(10_000) { runCatching { compose.onNodeWithTag("main-checkout-diff").assertExists(); true }.getOrDefault(false) }
        capture("02-review-sheet")
        compose.onNodeWithText("Move to a worktree ▾").performClick()
        capture("02b-move-target-picker")

        // Board 03: a success and a refusal, as lines in the conversation.
        show {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                MainCheckoutResultRow(result("""{"requestId":"r1","kind":"commit","root":"/root/orbit","status":"done","branch":"main","fileCount":3,
                    "head":"8d41e0c5a1b2","subject":"Add retry backoff","upstream":"origin/main","finishedAt":"2026-11-12T08:00:00.000Z"}"""))
                MainCheckoutResultRow(result("""{"requestId":"r2","kind":"push","root":"/root/orbit","status":"done","branch":"main",
                    "upstream":"origin/main","remoteBefore":"62325fb4a1c0","remoteAfter":"8d41e0c5a1b2","finishedAt":"2026-11-12T08:00:00.000Z"}"""))
                HorizontalDivider()
                MainCheckoutResultRow(result("""{"requestId":"r3","kind":"move","root":"/root/orbit","status":"refused","code":"FINGERPRINT_STALE",
                    "branch":"main","paths":["src/api/retry.ts"],"finishedAt":"2026-11-12T08:00:00.000Z"}"""))
                MainCheckoutResultRow(result("""{"requestId":"r4","kind":"push","root":"/root/orbit","status":"refused","code":"PUSH_REJECTED",
                    "branch":"main","upstream":"origin/main","ahead":1,"behind":2,"finishedAt":"2026-11-12T08:00:00.000Z"}"""))
                MainCheckoutResultRow(result("""{"requestId":"r5","kind":"push","root":"/root/orbit","status":"waiting","code":"RUNNER_OFFLINE",
                    "runnerName":"orbit-hpc","minutes":3,"finishedAt":"2026-11-12T08:00:00.000Z"}"""))
            }
        }
        capture("03-result-lines")

        // Board 04: turning isolation on over a dirty main checkout.
        show {
            Text("Worktree isolation", Modifier.padding(16.dp))
            WorktreeIsolationDialog(MainCheckout.turnOnDialog(repo)!!, review = {}, cleanUp = {}, confirm = {}, cancel = {})
        }
        capture("04-isolation-on-dirty")
        show {
            WorktreeIsolationDialog(MainCheckout.turnOffDialog("/root/orbit", 2)!!, review = {}, cleanUp = {}, confirm = {}, cancel = {})
        }
        capture("04b-isolation-off")
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        SystemClock.sleep(1_200)
        var bitmap: Bitmap? = null
        repeat(5) { if (bitmap == null) { bitmap = instrumentation.uiAutomation.takeScreenshot(); if (bitmap == null) SystemClock.sleep(1_000) } }
        val shot = bitmap ?: error("no screenshot for $name")
        val directory = File(compose.activity.filesDir, "main-checkout-shots").also { it.mkdirs() }
        File(directory, "$name.png").outputStream().use { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }
        shot.recycle()
    }
}
