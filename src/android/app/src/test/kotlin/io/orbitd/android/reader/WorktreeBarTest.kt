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
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.text.TextLayoutResult
import io.orbitd.android.toast.OrbitToasts
import io.orbitd.android.toast.ToastHost
import org.junit.After
import org.junit.Before
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
 * coordinator's integration line (A06-8), a binary file's current bytes (A06-7), and the notice of a session
 * without a worktree with what its Initialize git… and ✕ change in the workspace.
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
    private val workspaceId = "01a0cca7-8609-70ed-a0e2-d4b55b832b70"
    @Volatile private var workspace: JsonObject = folder()
    /** While set, the server refuses each change to the workspace with these words. */
    @Volatile private var refusing: String? = null

    @After fun close() { scope.cancel() }
    @Before fun quiet() = OrbitToasts.clear()

    private fun session(vararg fields: Pair<String, JsonElement>) = JsonObject(mapOf(
        "id" to JsonPrimitive(id), "status" to JsonPrimitive("AWAITING_INPUT"), "isolationStatus" to JsonPrimitive("worktree"),
        "branch" to JsonPrimitive("orbit/a06c-worktree-85cfd1"), "worktreeDirty" to JsonPrimitive(false),
        "mergeTargets" to JsonArray(listOf(JsonPrimitive("main"), JsonPrimitive("develop"))),
        "changedFiles" to Wire.json.parseToJsonElement("""[{"path":"src/reader/Bar.kt","additions":12,"deletions":3,"status":"M"},
            {"path":"docs/shot.png","additions":-1,"deletions":-1,"status":"A"},{"path":"dist/app.zip","additions":-1,"deletions":-1,"status":"A"},
            {"path":"old/logo.png","additions":-1,"deletions":-1,"status":"D"}]"""),
    ) + fields)

    /** A session that runs directly in its workspace's folder: the runner could give it no worktree. */
    private fun shared() = session("isolationStatus" to JsonPrimitive("shared-nogit"),
        "workspace" to buildJsonObject { put("id", workspaceId); put("name", "notes") })

    /** Its workspace as `GET workspaces/:id` answers: a folder that is not a repository, the notice not yet answered. */
    private fun folder(vararg fields: Pair<String, JsonElement>) = JsonObject(mapOf(
        "id" to JsonPrimitive(workspaceId), "name" to JsonPrimitive("notes"), "workDir" to JsonPrimitive("/Users/alex/notes"),
        "workDirIsGit" to JsonPrimitive(false), "autoInitGit" to JsonPrimitive(false), "enableWorktree" to JsonPrimitive(true),
    ) + fields)

    /** [sending] stands for the composer's message on its way (A06-14). */
    private fun show(sending: State<Boolean> = mutableStateOf(false)) {
        server.respond = { api -> answer(api) }
        val handle = runBlocking { server.signIn() }
        model = WorktreeModel(DirectoryApi(server.auth, handle), id, scope)
        runBlocking { model.loadDetail() }
        // The bar's outcomes are the app's toasts (A05-4): the shell's host draws them, here under the bar so neither covers the other.
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme { Column { WorktreeBar(model, sending.value) { opened += it }; ToastHost({}, {}, {}) } } } }
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
            path == listOf("workspaces", workspaceId) -> {
                val refusal = refusing
                when {
                    api.method != HttpMethod.PATCH -> ok(workspace.toString())
                    refusal != null -> ApiResponse(409, buildJsonObject { put("message", refusal) }.toString().encodeToByteArray())
                    else -> { workspace = JsonObject(workspace + body(api)); ok(workspace.toString()) }
                }
            }
            else -> ok("{}")
        }
    }

    private fun body(api: ApiRequest) = Wire.json.parseToJsonElement(api.body?.decodeToString() ?: "{}").jsonObject
    private fun sent(vararg path: String) = server.calls.filter { it.path == path.toList() && it.method == HttpMethod.POST }
    /** The changes asked of the session's workspace, refused ones included. */
    private fun patches() = server.calls.filter { it.path == listOf("workspaces", workspaceId) && it.method == HttpMethod.PATCH }.map(::body)
    private fun shown(text: String) = compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()
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
        // No worktree, and no workspace known to read or change: the notice only says so.
        compose.onNodeWithText("⚠ This folder isn’t a git repository").assertIsDisplayed()
        compose.onNodeWithText("Initialize git…").assertDoesNotExist()
        compose.onNodeWithText("✕").assertDoesNotExist()
    }

    /**
     * A06-14 (iOS f759d743e): Merge waits for a queued turn, a message on its way and a parked session's running sub-agents —
     * not only for RUNNING — and an ended session holds nothing back, whatever is still on its way.
     */
    @Test fun aSendInFlightAQueuedTurnAndParkedSubagentsHoldMerge() {
        val sending = mutableStateOf(false)
        show(sending)
        compose.onNodeWithText("Merge to main").assertIsDisplayed()
        sending.value = true; compose.waitForIdle()
        compose.onNodeWithText("Merge to main").assertDoesNotExist()
        sending.value = false; compose.waitForIdle()
        compose.onNodeWithText("Merge to main").assertIsDisplayed()
        settle(session("runningSubagents" to JsonArray(listOf(JsonPrimitive("toolu_agent")))))
        compose.onNodeWithText("Merge to main").assertDoesNotExist()
        settle(session("status" to JsonPrimitive("PENDING")))
        compose.onNodeWithText("Merge to main").assertDoesNotExist()
        settle(session("status" to JsonPrimitive("SUCCEEDED"), "runningSubagents" to JsonArray(listOf(JsonPrimitive("toolu_agent")))))
        sending.value = true; compose.waitForIdle()
        compose.onNodeWithText("Merge to main").assertIsDisplayed()
    }

    /** A06-14: the merge recovery's review reads the bar's own gate, so a message on its way holds its steps back too. */
    @Test fun aSendInFlightHoldsTheMergeRecoverySteps() {
        val sending = mutableStateOf(false)
        detail = session("mergeRecoverySupported" to JsonPrimitive(true),
            "mergeRecovery" to buildJsonObject { put("code", "FETCH_FAILED"); put("targetBranch", "main") })
        show(sending)
        compose.onNodeWithText("Could not check the remote").performClick()
        compose.onNode(hasText("Check and repair") and hasClickAction()).assertIsEnabled()
        sending.value = true; compose.waitForIdle()
        compose.onNode(hasText("Check and repair") and hasClickAction()).assertIsNotEnabled()
        sending.value = false; compose.waitForIdle()
        compose.onNode(hasText("Check and repair") and hasClickAction()).assertIsEnabled()
        settle(JsonObject(detail + ("status" to JsonPrimitive("PENDING"))))
        compose.onNode(hasText("Check and repair") and hasClickAction()).assertIsNotEnabled()
    }

    /**
     * The repair loop through the review (project 34hIv3wbdtsxpc5RzDlOk): a running repair is opened, not checked; the server's
     * check of it holds every step; conflicts left go back to the same repair session; a session already on origin ends with Done.
     */
    @Test fun theRepairLoopOpensTheRepairWaitsForItsCheckAndEndsWithDone() {
        val repairId = "01a0cca7-8609-70ed-a0e2-d4b55b832b61"
        fun repair(runState: String) = buildJsonObject { put("id", repairId); put("title", "Resolve merge recovery for main"); put("runState", runState)
            put("lastTurnAt", "2026-10-11T11:28:00Z"); put("finishedAt", JsonNull); put("lastAssistantText", JsonNull); put("error", JsonNull) }
        val conflict = Wire.json.parseToJsonElement("""{"code":"CONFLICT","targetBranch":"main","previewId":"5971aa","phase":"SOURCE_REPLAY",
            "repairBranch":"orbit/recovery/5971aa","repairWorktree":"/w/recovery-5971aa","conflicts":["src/AgentsModel.swift"],"checkedAt":"2026-10-11T11:29:40Z"}""").jsonObject
        fun loop(vararg fields: Pair<String, JsonElement>) = session("mergeRecoverySupported" to JsonPrimitive(true), "mergeRepairTurnEndedAt" to JsonNull,
            "mergeStatus" to JsonPrimitive("conflict"), "mergeRecoveryAction" to JsonPrimitive("preview"), "mergeRecovery" to conflict, *fields)
        detail = loop("mergeRepairSession" to repair("RUNNING"))
        show()
        compose.onNodeWithText("Your changes conflict with the synchronized target").performClick()
        compose.onNodeWithText("Tap to open the running session").assertIsDisplayed()
        compose.onNodeWithText("Orbit checks again when the repair stops.").assertIsDisplayed()
        compose.onNodeWithText("Check again").assertDoesNotExist()
        compose.onNode(hasText("Open repair session") and hasClickAction()).assertIsEnabled().performClick()
        assertEquals(listOf("orbit-session:$repairId"), opened)

        // The repair stopped: the server's check is in flight, and nothing is pressed until it answers.
        settle(loop("mergeRepairSession" to repair("AWAITING_INPUT"), "mergeStatus" to JsonPrimitive("pending")))
        compose.onNodeWithText("Your changes conflict with the synchronized target").performClick()
        compose.onNodeWithText("Checking the repair…").assertIsDisplayed()
        compose.onNodeWithText("Checking its result…").assertIsDisplayed()
        compose.onNode(hasText("Checking…") and hasClickAction()).assertIsNotEnabled()

        // Conflicts left: the same repair session carries on.
        settle(loop("mergeRepairSession" to repair("AWAITING_INPUT")))
        compose.onNodeWithText("Repair session finished").assertIsDisplayed()
        compose.onNode(hasText("Continue repair") and hasClickAction()).performClick()
        compose.waitUntil(5_000) { sent("sessions", id, "merge-repair").isNotEmpty() }
        assertEquals(false, body(sent("sessions", id, "merge-repair").single())["preparePR"]?.jsonPrimitive?.booleanOrNull)

        // The repair failed and its turn queued a check: the row says it failed, and the page waits for the check.
        settle(loop("mergeRepairSession" to JsonObject(repair("FAILED") + ("error" to JsonPrimitive("The model provider rejected the request"))),
            "mergeStatus" to JsonPrimitive("pending")))
        compose.onNodeWithText("Repair session failed").assertIsDisplayed()
        compose.onNodeWithText("Checking the repair…").assertIsDisplayed()
        compose.onNode(hasText("Checking…") and hasClickAction()).assertIsNotEnabled()
        compose.onNodeWithText("Resolve in repair session").assertDoesNotExist()

        // Already on origin (the review is still open): no repair row, and Done asks the server to record it merged.
        settle(loop("mergeRepairSession" to repair("AWAITING_INPUT"), "mergeRecovery" to Wire.json.parseToJsonElement("""{"code":"ALREADY_LANDED",
            "targetBranch":"main","previewId":"1c0ffee","sourceSha":"${"a".repeat(40)}","landedCommits":[{"sha":"${"b".repeat(40)}",
            "subject":"Explicit self in the session-list currency closure","author":"coordinator","date":"2026-10-11T10:34:12Z","sourceSha":"${"a".repeat(40)}"}]}""")))
        compose.onNode(hasText("Already on origin/main") and isHeading()).assertIsDisplayed()
        compose.onNodeWithText("Repair session finished").assertDoesNotExist()
        compose.onNodeWithText("Explicit self in the session-list currency closure").assertIsDisplayed()
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("Done") and hasClickAction() and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hasText("Done") and hasClickAction()).performClick()
        compose.waitUntil(5_000) { sent("sessions", id, "merge").isNotEmpty() }
        val done = body(sent("sessions", id, "merge").single())
        assertEquals(listOf("main", "confirm-landed", "1c0ffee"), listOf(done.string("targetBranch"), done.string("recoveryAction"), done.string("previewId")))
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

    /**
     * A folder that is not a repository (docs/mocks/nogit-folder-notice ②–④): the notice names it and what editing it directly costs,
     * and Initialize git… spells out what it will do before it asks the workspace to set git up, which answers the notice.
     */
    @Test fun aFolderThatIsNotARepositoryIsNamedAndInitializeGitAsksFirst() {
        detail = shared()
        show()
        val headline = "⚠ /Users/alex/notes isn’t a git repository"
        compose.waitUntil(5_000) { shown(headline) }
        compose.onNodeWithText(headline).assertIsDisplayed()
        compose.onNodeWithText("Sessions here edit the folder directly: no branch or diff to review, and sessions running at the same time" +
            " can overwrite each other’s changes.").assertIsDisplayed()
        compose.onNodeWithText("Initialize git…").performClick()
        compose.onNodeWithText("Initialize git in this folder?").assertIsDisplayed()
        listOf("/Users/alex/notes", "When the next session starts in “notes”, Orbit will:", "run git init",
            "add a .gitignore for dependencies, build output and .env files, unless the folder has one",
            "commit the existing files as “orbit: baseline”. Nothing is pushed anywhere.",
            "Each new session then works on its own branch, with a diff you review and merge. This session keeps editing the folder directly.",
        ).forEach { compose.onNodeWithText(it).assertIsDisplayed() }
        assertTrue("nothing changes before it is confirmed", patches().isEmpty())
        compose.onNodeWithText("Initialize git").performClick()
        compose.waitUntil(5_000) { shown("Git will be set up when the next session starts") }
        assertEquals(listOf(buildJsonObject { put("autoInitGit", true) }), patches())
        compose.onNodeWithText("/Users/alex/notes").assertIsDisplayed()
        compose.waitUntil(5_000) { !shown(headline) }
    }

    /** ✕ on a folder that is not a repository keeps it a plain folder: worktree isolation goes off for the workspace, said by a toast
     * whose Undo turns it back on, and the notice with it (docs/mocks/nogit-folder-notice ⑤⑥). */
    @Test fun theCloseKeepsAPlainFolderAndUndoTurnsIsolationBackOn() {
        detail = shared()
        show()
        val headline = "⚠ /Users/alex/notes isn’t a git repository"
        compose.waitUntil(5_000) { shown(headline) }
        compose.onNodeWithContentDescription("Keep it as a plain folder").performClick()
        compose.waitUntil(5_000) { shown("Worktree isolation is off for “notes”") }
        assertEquals(listOf(buildJsonObject { put("enableWorktree", false) }), patches())
        compose.onNodeWithText("Its sessions keep editing the folder directly, without this notice. Turn it back on in the workspace’s settings.")
            .assertIsDisplayed()
        compose.waitUntil(5_000) { !shown(headline) }
        compose.onNodeWithContentDescription("Turn worktree isolation back on").performClick()
        compose.waitUntil(5_000) { shown(headline) }
        assertEquals(listOf(buildJsonObject { put("enableWorktree", false) }, buildJsonObject { put("enableWorktree", true) }), patches())
        compose.onNodeWithText("Worktree isolation is off for “notes”").assertDoesNotExist()
    }

    /** A repository git couldn't branch (docs/mocks/nogit-folder-notice ⑦): Initialize git… can't help there and isn't offered, and ✕
     * hides the notice for this session only, changing nothing. */
    @Test fun aRepositoryGitCouldNotBranchSaysWhyAndClosesForThisSessionOnly() {
        detail = shared()
        workspace = folder("workDir" to JsonPrimitive("/Users/alex/new-app"), "workDirIsGit" to JsonPrimitive(true))
        show()
        val headline = "⚠ No branch for this session: it edits /Users/alex/new-app directly"
        compose.waitUntil(5_000) { shown(headline) }
        compose.onNodeWithText("The folder is a git repository, but git couldn’t add a worktree for this session. A repository with no" +
            " commits has nothing to branch from.").assertIsDisplayed()
        compose.onNodeWithText("Initialize git…").assertDoesNotExist()
        compose.onNodeWithContentDescription("Hide for this session").performClick()
        compose.onNodeWithText(headline).assertDoesNotExist()
        assertTrue("the workspace has nothing to change", patches().isEmpty())
    }

    /** A refused change says what failed, in the server's words, and changes nothing: Initialize git…, ✕, and the toast's Undo. */
    @Test fun aRefusedChangeSaysWhatFailedInTheServersWords() {
        detail = shared()
        refusing = "This workspace is managed by your administrator"
        show()
        val headline = "⚠ /Users/alex/notes isn’t a git repository"
        compose.waitUntil(5_000) { shown(headline) }
        compose.onNodeWithText("Initialize git…").performClick()
        compose.onNodeWithText("Initialize git").performClick()
        compose.waitUntil(5_000) { shown("Couldn't turn on git setup") }
        compose.onNodeWithText("This workspace is managed by your administrator").assertIsDisplayed()
        compose.onNodeWithContentDescription("Keep it as a plain folder").performClick()
        compose.waitUntil(5_000) { shown("Couldn't turn off worktree isolation") }
        compose.onNodeWithText(headline).assertIsDisplayed()
        // The ✕ goes through this time; then its Undo is refused.
        refusing = null
        compose.onNodeWithContentDescription("Keep it as a plain folder").performClick()
        compose.waitUntil(5_000) { shown("Worktree isolation is off for “notes”") }
        refusing = "This workspace is managed by your administrator"
        compose.onNodeWithContentDescription("Turn worktree isolation back on").performClick()
        compose.waitUntil(5_000) { shown("Couldn't turn worktree isolation back on") }
        compose.onNodeWithText("This workspace is managed by your administrator").assertIsDisplayed()
        assertEquals(listOf(buildJsonObject { put("autoInitGit", true) }, buildJsonObject { put("enableWorktree", false) },
            buildJsonObject { put("enableWorktree", false) }, buildJsonObject { put("enableWorktree", true) }), patches())
    }

    /** On a phone the headline wraps, and Initialize git… and ✕ keep their size (docs/mocks/nogit-folder-notice frames/8b-phone-notice.png). */
    @Test @Config(qualifiers = "w360dp-h640dp") @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun onAPhoneTheHeadlineWrapsAndTheActionsKeepTheirSize() {
        detail = shared()
        show()
        val headline = "⚠ /Users/alex/notes isn’t a git repository"
        compose.waitUntil(5_000) { shown(headline) }
        assertKeepsItsSize("Initialize git…", compose.onNodeWithText("Initialize git…"))
        assertKeepsItsSize("✕", compose.onNodeWithContentDescription("Keep it as a plain folder"))
        assertTrue("the headline wraps", layout(compose.onNodeWithText(headline)).lineCount > 1)
        compose.onNodeWithText("Sessions here edit the folder directly", substring = true).assertIsDisplayed()
    }

    private fun layout(node: SemanticsNodeInteraction): TextLayoutResult {
        val results = mutableListOf<TextLayoutResult>()
        node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(results) }
        return results.single()
    }

    /** The text got all the width its words need: its row didn't squeeze it. Not `hasVisualOverflow`: semantics lays a plain
     * string out again at the width it was offered, so that reads as overflow whenever it was offered more than it took. */
    private fun assertKeepsItsSize(what: String, node: SemanticsNodeInteraction) {
        val text = layout(node)
        assertTrue("$what got ${text.size.width} px for words ${text.multiParagraph.maxIntrinsicWidth} px wide",
            text.size.width >= text.multiParagraph.maxIntrinsicWidth)
    }
}
