package io.orbitd.android.reader

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.directory.DirectoryApi
import io.orbitd.android.ui.OrbitTheme
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog
import java.io.File
import java.time.Instant

/**
 * PROBE ONLY (task 34hJZMKsulMrCDCAtPOIU, probe branch; not merged): the merge recovery review in the repair loop's states, light
 * and dark, as PNGs beside the board (docs/mocks/merge-recovery-repair-loop-ios.html). ①–⑤ are the board's demo data, ⑥ the real
 * case, "failed" the repair row's sixth state, and "unfinished-failed" an unfinished repair whose session failed. Written to $C3_SHOTS, else src/android/build/evidence/c3-merge-recovery.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w393dp-h852dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MergeRecoveryShotsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val id = "01a0cca7-8609-70ed-a0e2-d4b55b832b60"
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val now = Instant.now()
    @After fun close() { scope.cancel() }

    private fun ago(seconds: Long) = now.minusSeconds(seconds).toString()
    private fun json(text: String) = Wire.json.parseToJsonElement(text)
    private fun pad(prefix: String) = prefix + "0".repeat(40 - prefix.length)
    private fun commit(sha: String, subject: String, author: String, secondsAgo: Long, merge: Boolean = false) = buildJsonObject {
        put("sha", pad(sha)); put("subject", subject); put("author", author); put("date", ago(secondsAgo)); if (merge) put("merge", true) }
    private val local = JsonArray(listOf(commit("749188d8", "feat(suggestions): server-written next-message guess for non-Claude engines", "coordinator", 3 * 3600),
        commit("8a954110", "feat(composer): “Double-tap to use” stays, the learned flag goes", "coordinator", 4 * 3600)))
    private fun remote(n: Int) = JsonArray((1..n).map { commit("c0ffee0$it", "fix: follow-up on origin/main #$it", "orbit-develop", 600L * it) })
    private val files = listOf("src/macos/OrbitApp/Sources/OrbitApp/AgentsModel.swift", "src/macos/OrbitKit/Tests/OrbitKitTests/SessionListSwitchWiringTests.swift")

    private fun recovery(code: String, checkedSecondsAgo: Long, vararg fields: Pair<String, JsonElement>) = JsonObject(mapOf(
        "code" to JsonPrimitive(code), "targetBranch" to JsonPrimitive("main"), "previewId" to JsonPrimitive("5971aa"),
        "sourceSha" to JsonPrimitive(pad("0032a5e1")), "localSha" to JsonPrimitive(pad("749188d8")), "remoteSha" to JsonPrimitive(pad("c0ffee01")),
        "repairBranch" to JsonPrimitive("orbit/recovery/5971aa"), "repairWorktree" to JsonPrimitive("/root/.orbit/worktrees/recovery-5971aa"),
        "phase" to JsonPrimitive("SOURCE_REPLAY"), "conflicts" to JsonArray(files.map(::JsonPrimitive)), "localCommits" to local, "remoteCommits" to remote(1),
        "checkedAt" to JsonPrimitive(ago(checkedSecondsAgo)), "patch" to JsonPrimitive("")) + fields)

    private fun repair(runState: String, vararg fields: Pair<String, JsonElement>) = JsonObject(mapOf("id" to JsonPrimitive("34e2K7Cj2YG2CbwFip9QH"),
        "title" to JsonPrimitive("解决 main 分支合并恢复"), "runState" to JsonPrimitive(runState), "lastTurnAt" to JsonPrimitive(ago(120)),
        "finishedAt" to JsonNull, "lastAssistantText" to JsonNull, "error" to JsonNull) + fields)

    private fun detail(recovery: JsonObject, repair: JsonObject?, vararg fields: Pair<String, JsonElement>) = JsonObject(mapOf(
        "id" to JsonPrimitive(id), "status" to JsonPrimitive("AWAITING_INPUT"), "isolationStatus" to JsonPrimitive("worktree"),
        "branch" to JsonPrimitive("orbit/ios-workspace-switch-session-list-workspace-d0afa0"), "mergeRecoverySupported" to JsonPrimitive(true),
        "mergeStatus" to JsonPrimitive("conflict"), "mergeRecoveryAction" to JsonPrimitive("preview"), "mergeRepairTurnEndedAt" to JsonNull,
        "mergeError" to JsonPrimitive("CONFLICT (content): Merge conflict in src/macos/OrbitApp/Sources/OrbitApp/AgentsModel.swift"),
        "mergeRecovery" to recovery, "mergeRepairSession" to (repair ?: JsonNull)) + fields)

    @Test fun theRepairLoopsStatesLightAndDark() {
        val server = FakeReaderServer().apply { respond = { ApiResponse(200, "{}".encodeToByteArray()) } }
        val model = WorktreeModel(DirectoryApi(server.auth, runBlocking { server.signIn() }), id, scope)
        val conflict = recovery("CONFLICT", 14 * 60)
        val ready = recovery("READY", 8, "candidateSha" to JsonPrimitive(pad("5e6f7a8b")), "candidateTreeSha" to JsonPrimitive(pad("7ee")),
            "conflicts" to JsonArray(emptyList()), "check" to json("""{"status":"passed","command":"npm test"}"""), "addsMergeCommit" to JsonPrimitive(true),
            "pushCommits" to JsonArray(listOf(local[0], local[1], commit("5e6f7a8b", "Merge origin/main into main", "Orbit Runner", 8, merge = true),
                commit("9f2c1a7e", "Switch workspaces without stale session-list callbacks", "coordinator", 2 * 3600))),
            "patch" to JsonPrimitive("diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new"))
        val states = linkedMapOf(
            "1-running" to detail(conflict, repair("RUNNING")),
            "2-checking" to detail(conflict, repair("AWAITING_INPUT"), "mergeStatus" to JsonPrimitive("pending")),
            "3-ready" to detail(ready, repair("AWAITING_INPUT"), "mergeStatus" to JsonPrimitive("error"), "mergeError" to JsonNull),
            "4-conflict-left" to detail(recovery("CONFLICT", 8, "previewId" to JsonPrimitive("e81d4f"), "phase" to JsonPrimitive("TARGET_SYNC"),
                "conflicts" to JsonArray(listOf(JsonPrimitive(files[0]))), "remoteCommits" to remote(4)), repair("AWAITING_INPUT")),
            "5-needs-reply" to detail(recovery("REPAIR_IN_PROGRESS", 8, "previewId" to JsonPrimitive("77b0c1"),
                "conflicts" to JsonArray(listOf(JsonPrimitive(files[1])))), repair("AWAITING_INPUT", "lastAssistantText" to JsonPrimitive("Keep the target's version?")),
                "mergeStatus" to JsonPrimitive("error"), "mergeError" to JsonPrimitive("finish and commit the repair before checking again")),
            "6-already-landed" to detail(recovery("ALREADY_LANDED", 8, "previewId" to JsonPrimitive("1c0ffee"), "repairBranch" to JsonNull,
                "repairWorktree" to JsonNull, "phase" to JsonNull, "conflicts" to JsonNull,
                "landedCommits" to json("""[{"sha":"${pad("bba5d7b3")}","subject":"Explicit self in the session-list currency closure","author":"coordinator",
                    "date":"2026-10-11T18:34:12+08:00","sourceSha":"${pad("0032a5e1")}"},{"sha":"${pad("99cd5459")}",
                    "subject":"Update AgentsModel.swift, SessionListSwitchWiringTests.swift","author":"coordinator","date":"2026-10-11T17:36:20+08:00",
                    "sourceSha":"${pad("e4b9d0e1")}"}]""")), repair("AWAITING_INPUT"), "mergeStatus" to JsonPrimitive("error"),
                "mergeError" to JsonPrimitive("every commit of this session is already on origin/main — nothing is left to merge")),
            "7-failed" to detail(conflict, repair("FAILED", "error" to JsonPrimitive("The model provider rejected the request"))),
            "8-unfinished-failed" to detail(recovery("REPAIR_IN_PROGRESS", 8, "previewId" to JsonPrimitive("77b0c1"),
                "conflicts" to JsonArray(listOf(JsonPrimitive(files[1])))), repair("FAILED", "error" to JsonPrimitive("The model provider rejected the request")),
                "mergeStatus" to JsonPrimitive("error"), "mergeError" to JsonPrimitive("finish and commit the repair before checking again")),
        )
        val out = File(System.getenv("C3_SHOTS") ?: generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .first { File(it, "src/android/settings.gradle.kts").isFile }.resolve("src/android/build/evidence/c3-merge-recovery").path).also { it.mkdirs() }
        for ((name, d) in states) for (dark in listOf(false, true)) {
            val r = MergeRecovery.of(d["mergeRecovery"]!!.jsonObject)!!
            compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = dark) { MergeRecoveryReview(model, d, r, turnActive = false, open = {}) {} } } }
            compose.waitForIdle()
            val view = ShadowDialog.getLatestDialog().window!!.decorView
            val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            view.draw(Canvas(bitmap))
            File(out, "$name-${if (dark) "dark" else "light"}.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
        assertEquals(states.size * 2, out.listFiles { f -> f.name.endsWith(".png") }!!.size)
    }
}
