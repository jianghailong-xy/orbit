package io.orbitd.android.reader

import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.directory.DirectoryApi
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

/**
 * The worktree bar and its merge operation over a controlled `/api` (iOS WorktreeBar/WorktreeModel): what each
 * git state offers, the requests each press sends, the runner's answers as the bar then says them, a
 * coordinator's integration line (A06-8) and a binary file's current bytes (A06-7).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class WorktreeBarTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val id = "01a0cca7-8609-70ed-a0e2-d4b55b832b60"
    private val server = FakeReaderServer()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    @Volatile private var detail: JsonObject = session()
    private val opened = mutableListOf<String>()
    private lateinit var model: WorktreeModel

    @After fun close() { scope.cancel() }

    private fun session(vararg fields: Pair<String, JsonElement>) = JsonObject(mapOf(
        "id" to JsonPrimitive(id), "status" to JsonPrimitive("AWAITING_INPUT"), "isolationStatus" to JsonPrimitive("worktree"),
        "branch" to JsonPrimitive("orbit/a06c-worktree-85cfd1"), "worktreeDirty" to JsonPrimitive(false),
        "mergeTargets" to JsonArray(listOf(JsonPrimitive("main"), JsonPrimitive("develop"))),
        "changedFiles" to Wire.json.parseToJsonElement("""[{"path":"src/reader/Bar.kt","additions":12,"deletions":3,"status":"M"},
            {"path":"docs/shot.png","additions":-1,"deletions":-1,"status":"A"},{"path":"dist/app.zip","additions":-1,"deletions":-1,"status":"A"},
            {"path":"old/logo.png","additions":-1,"deletions":-1,"status":"D"}]"""),
    ) + fields)

    private fun show() {
        server.respond = { api -> answer(api) }
        val handle = runBlocking { server.signIn() }
        model = WorktreeModel(DirectoryApi(server.auth, handle), id, scope)
        runBlocking { model.loadDetail() }
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme { WorktreeBar(model) { opened += it } } } }
        compose.waitForIdle()
    }

    private fun answer(api: ApiRequest): ApiResponse {
        val path = api.path
        val ok = { body: String -> ApiResponse(200, body.encodeToByteArray()) }
        return when {
            path == listOf("sessions", id) -> ok(detail.toString())
            path == listOf("sessions", id, "merge") -> { detail = JsonObject(detail + ("mergeStatus" to JsonPrimitive("pending"))); ok("{}") }
            path == listOf("sessions", id, "commit") -> { detail = JsonObject(detail + ("commitStatus" to JsonPrimitive("pending"))); ok("{}") }
            path == listOf("sessions", id, "diff") -> ok("""{"patches":[{"path":"src/reader/Bar.kt","patch":"diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old line\n+new line"}]}""")
            path == listOf("sessions", id, "worktree-file") -> when (api.query.toMap()["path"]) {
                "docs/shot.png" -> ApiResponse(200, FakeReaderServer.png)
                "dist/app.zip" -> ApiResponse(200, byteArrayOf(0x50, 0x4b, 0x03, 0x04, 1, 2, 3))
                else -> ApiResponse(404, """{"message":"Not found"}""".encodeToByteArray())
            }
            else -> ok("{}")
        }
    }

    private fun body(api: ApiRequest) = Wire.json.parseToJsonElement(api.body?.decodeToString() ?: "{}").jsonObject
    private fun sent(vararg path: String) = server.calls.filter { it.path == path.toList() && it.method == HttpMethod.POST }
    private fun settle(next: JsonObject) { detail = next; runBlocking { model.loadDetail() }; compose.waitForIdle() }

    @Test fun aCleanTreeMergesToTheTargetThePersonPickedAndTheBarFollowsTheRunnersAnswer() {
        show()
        // A clean tree ready to merge reads as committed (iOS statView).
        compose.onNodeWithText("+12 −3 · 4 files · committed", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("orbit/a06c-worktree-85cfd1", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("Merge to main").assertIsDisplayed()
        compose.onNodeWithContentDescription("Choose a branch to merge into").performClick()
        compose.onNodeWithText("develop").performClick()
        compose.onNodeWithText("Merge to develop").performClick()
        compose.waitUntil(5_000) { sent("sessions", id, "merge").isNotEmpty() }
        assertEquals("develop", body(sent("sessions", id, "merge").single()).string("targetBranch"))
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Merging…").fetchSemanticsNodes().isNotEmpty() }
        settle(JsonObject(detail + ("mergeStatus" to JsonPrimitive("merged")) + ("mergeTarget" to JsonPrimitive("develop"))))
        compose.onNodeWithText("✓ Merged → develop").assertIsDisplayed()
        compose.onNodeWithText("Merged into develop").assertIsDisplayed()
    }

    /** On a phone the branch and its summary share what Merge leaves (iOS's HStack): both truncate, neither vanishes. */
    @Test @Config(qualifiers = "w360dp-h640dp") @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun onAPhoneTheBranchAndItsSummaryShareTheRow() {
        show()
        compose.onNodeWithText("Merge to main").assertIsDisplayed()
        listOf("orbit/a06c-worktree-85cfd1", "+12 −3 · 4 files · committed").forEach { text ->
            compose.onNodeWithText(text, useUnmergedTree = true).assertIsDisplayed()
        }
    }

    @Test fun aConflictIsHandedToTheSessionAndAnErrorRetries() {
        detail = session("mergeStatus" to JsonPrimitive("conflict"), "mergeError" to JsonPrimitive("CONFLICT (content): src/reader/Bar.kt"),
            "mergeTarget" to JsonPrimitive("main"))
        show()
        compose.onNodeWithText("Merge conflict — aborted, working tree left clean.\nCONFLICT (content): src/reader/Bar.kt").assertIsDisplayed()
        compose.onNodeWithText("Resolve in session").performClick()
        compose.waitUntil(5_000) { sent("sessions", id, "resume").isNotEmpty() }
        val resume = body(sent("sessions", id, "resume").single())
        assertEquals("message", resume.string("kind"))
        assertTrue(resume.string("content")!!.startsWith("Rebase this branch onto the latest main and resolve any conflicts."))
        assertFalse(resume.string("clientTurnId").isNullOrEmpty())
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Resuming the session to resolve the conflict…").fetchSemanticsNodes().isNotEmpty() }
        settle(session("mergeStatus" to JsonPrimitive("error"), "mergeError" to JsonPrimitive("target has uncommitted changes")))
        compose.onNodeWithText("target has uncommitted changes").assertIsDisplayed()
        compose.onNodeWithText("Retry merge to main").assertIsDisplayed()
    }

    @Test fun aDirtyLiveTreeCommitsAndAFailedCommitSaysWhy() {
        detail = session("worktreeDirty" to JsonPrimitive(true))
        show()
        compose.onNodeWithText("Commit").performClick()
        compose.waitUntil(5_000) { sent("sessions", id, "commit").isNotEmpty() }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Committing…").fetchSemanticsNodes().isNotEmpty() }
        settle(session("worktreeDirty" to JsonPrimitive(true), "commitStatus" to JsonPrimitive("error"),
            "commitError" to JsonPrimitive("fatal: Unable to create '.git/index.lock': File exists.")))
        compose.onNodeWithText("⊗ Couldn't commit — git is busy in this worktree").assertIsDisplayed()
        compose.onNodeWithText("Couldn't commit").assertIsDisplayed()
        compose.onNodeWithText("Show git output ▸").performClick()
        compose.onNodeWithText("fatal: Unable to create '.git/index.lock': File exists.").assertIsDisplayed()
        compose.onNodeWithText("Retry commit").assertIsDisplayed()
    }

    @Test fun aWorktreeOnAnotherBranchAdoptsItAndAMidTurnTreeHoldsMerge() {
        detail = session("worktreeBranch" to JsonPrimitive("feature/login"))
        show()
        compose.onNodeWithText("⚠ On feature/login").assertIsDisplayed()
        compose.onNodeWithText("Adopt").performClick()
        compose.waitUntil(5_000) { sent("sessions", id, "adopt-branch").isNotEmpty() }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Now tracking this worktree's branch").fetchSemanticsNodes().isNotEmpty() }
        settle(session("status" to JsonPrimitive("RUNNING")))
        compose.onNodeWithText("Merge to main").assertDoesNotExist()
        settle(session("isolationStatus" to JsonPrimitive("shared-nogit")))
        compose.onNodeWithText("⚠ Shared workDir — not isolated").assertIsDisplayed()
    }

    /** A06-8: the coordinator's bar names the project's integration line and merges where the server resolved. */
    @Test fun aCoordinatorsBarNamesItsProjectsLine() {
        detail = session("projectMembership" to buildJsonObject { put("projectId", "p"); put("role", "COORDINATOR") },
            "projectIntegrationRef" to JsonPrimitive("project/34ZZn8fmemArxvl2CsCFp"), "mergeTarget" to JsonPrimitive("project/34ZZn8fmemArxvl2CsCFp"))
        show()
        compose.onNodeWithText("project/34ZZn8fmemArxvl2CsCFp", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("Merge to project/34ZZn8fmemArxvl2CsCFp").assertIsDisplayed()
    }

    /** A06-7: the changed files open to a text file's diff, a binary file's current bytes, and why one can't be read. */
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun theChangedFilesOpenToDiffsAndBinaryFiles() {
        show()
        compose.onNodeWithText("+12 −3 · 4 files", substring = true).performClick()
        compose.onNodeWithText("Worktree changes").assertIsDisplayed()
        compose.onAllNodesWithText("binary").assertCountEquals(3)
        compose.onNodeWithText("Bar.kt", substring = true, useUnmergedTree = true).performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("+new line", substring = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("‹ Worktree changes").performClick()
        compose.onNodeWithText("shot.png", substring = true, useUnmergedTree = true).performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Scroll to explore").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("2 × 2").assertIsDisplayed()
        compose.onNodeWithText("⤢ Full screen").performClick()
        compose.onNodeWithText("Close image").performClick()
        compose.onNodeWithText("‹ Worktree changes").performClick()
        compose.onNodeWithText("app.zip", substring = true, useUnmergedTree = true).performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("No preview available").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("This file can’t be previewed here.\nSave it to Files or open it in another app.").assertIsDisplayed()
        compose.onNodeWithText("⤓ Save to Files").assertIsDisplayed()
        compose.onNodeWithText("Share…").assertIsDisplayed()
        compose.onNodeWithText("‹ Worktree changes").performClick()
        compose.onNodeWithText("logo.png", substring = true, useUnmergedTree = true).performClick()
        compose.onNodeWithText("File deleted").assertIsDisplayed()
        compose.onNodeWithText("↻ Retry").assertDoesNotExist()
        assertEquals(listOf("docs/shot.png", "dist/app.zip"), server.calls.filter { it.path.lastOrNull() == "worktree-file" }.map { it.query.toMap()["path"] })
    }
}
