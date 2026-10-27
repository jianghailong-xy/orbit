package io.orbitd.android.reader

import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.NetworkException
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.reader.WorktreeBarLogic.SharedFolder
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The worktree bar's decisions — OrbitKit's WorktreeBarLogicTests and WorktreeFileTests, case for case — and A06-8. */
class WorktreeBarLogicTest {
    private val L = WorktreeBarLogic

    @Test fun modes() {
        assertEquals(WorktreeBarLogic.Mode.HIDDEN, L.mode(null, "orbit/x-abcdef", 3))
        assertEquals(WorktreeBarLogic.Mode.NOT_ISOLATED, L.mode("shared-nogit", null, 0))
        assertEquals(WorktreeBarLogic.Mode.HIDDEN, L.mode("worktree", "orbit/x-abcdef", 0))
        assertEquals("a failed merge keeps the bar even without changes", WorktreeBarLogic.Mode.WORKTREE, L.mode("worktree", "orbit/x-abcdef", 0, mergeStatus = "error"))
        assertEquals(WorktreeBarLogic.Mode.WORKTREE, L.mode("worktree", "orbit/x-abcdef", 0, hasMergeRecovery = true))
        assertEquals(WorktreeBarLogic.Mode.HIDDEN, L.mode("worktree", null, 5))
        assertEquals(WorktreeBarLogic.Mode.WORKTREE, L.mode("worktree", "orbit/x-abcdef", 5))
    }

    /** A session without a worktree: the notice its workspace hasn't answered yet (web's `sharedFolderOf`, docs/mocks/nogit-folder-notice). */
    @Test fun theNoticeOfASessionWithoutAWorktree() {
        // Answered — isolation turned off, or git initialization queued: no session of the workspace shows it.
        assertEquals(SharedFolder.HIDDEN, L.sharedFolder(workDirIsGit = false, autoInitGit = false, enableWorktree = false))
        assertEquals(SharedFolder.HIDDEN, L.sharedFolder(workDirIsGit = false, autoInitGit = true, enableWorktree = true))
        assertEquals(SharedFolder.HIDDEN, L.sharedFolder(workDirIsGit = true, autoInitGit = false, enableWorktree = false))
        assertEquals(SharedFolder.HIDDEN, L.sharedFolder(workDirIsGit = null, autoInitGit = true, enableWorktree = null))
        assertEquals(SharedFolder.NOT_GIT, L.sharedFolder(workDirIsGit = false, autoInitGit = false, enableWorktree = true))
        assertEquals(SharedFolder.NO_BRANCH, L.sharedFolder(workDirIsGit = true, autoInitGit = false, enableWorktree = true))
        // Unknown reads as the common case, a folder that is not a repository: never probed, or the record not read.
        assertEquals(SharedFolder.NOT_GIT, L.sharedFolder(workDirIsGit = null, autoInitGit = false, enableWorktree = true))
        assertEquals(SharedFolder.NOT_GIT, L.sharedFolder(workDirIsGit = null, autoInitGit = null, enableWorktree = null))
    }

    @Test fun theNoticeNamesItsFolderAndItsWorkspaceOrSaysThemInWords() {
        fun headline(notice: SharedFolder, path: String?) = SharedFolderCopy.headline(notice, path).toList().joinToString("")
        assertEquals("⚠ /Users/alex/notes isn’t a git repository", headline(SharedFolder.NOT_GIT, "/Users/alex/notes"))
        assertEquals("⚠ This folder isn’t a git repository", headline(SharedFolder.NOT_GIT, null))
        assertEquals("⚠ No branch for this session: it edits /Users/alex/new-app directly", headline(SharedFolder.NO_BRANCH, "/Users/alex/new-app"))
        assertEquals("⚠ No branch for this session: it edits the folder directly", headline(SharedFolder.NO_BRANCH, null))
        assertEquals("When the next session starts in “notes”, Orbit will:", SharedFolderCopy.confirmLead("notes"))
        assertEquals("When the next session starts in this workspace, Orbit will:", SharedFolderCopy.confirmLead(null))
        assertEquals("Worktree isolation is off for “notes”", SharedFolderCopy.isolationOff("notes"))
        assertEquals("Worktree isolation is off for this workspace", SharedFolderCopy.isolationOff(null))
    }

    @Test fun primaryAction() {
        assertEquals(WorktreeBarLogic.Primary.COMMIT, L.primary(true, committed = false, turnActive = false))
        assertEquals(WorktreeBarLogic.Primary.MERGE, L.primary(false, committed = false, turnActive = false))
        assertEquals("merge waits for the turn", WorktreeBarLogic.Primary.NONE, L.primary(false, committed = false, turnActive = true))
        assertEquals("an ended dirty session merges", WorktreeBarLogic.Primary.MERGE, L.primary(true, committed = true, turnActive = false))
        assertEquals(WorktreeBarLogic.Primary.NONE, L.primary(null, committed = false, turnActive = false))
        assertEquals(WorktreeBarLogic.Primary.MERGE, L.primary(null, committed = true, turnActive = false))
    }

    // A06-14: OrbitKit's turn-in-flight cases (f759d743e), case for case.
    @Test fun turnActiveWhileQueuedOrRunning() {
        // The owner's report, 2026-10-09: Merge pressed just after sending, while the turn was still queued, came back
        // "wait for the current turn to finish before merging".
        assertTrue(L.turnActive("PENDING", runningSubagents = null, sending = false))
        assertTrue(L.turnActive("RUNNING", runningSubagents = null, sending = false))
    }

    @Test fun turnActiveFromTheSendBeforeTheRecordCatchesUp() {
        assertTrue(L.turnActive("AWAITING_INPUT", runningSubagents = null, sending = true))
        assertFalse(L.turnActive("AWAITING_INPUT", runningSubagents = null, sending = false))
        assertTrue(L.turnActive("INTERRUPTED", runningSubagents = null, sending = true))
    }

    @Test fun turnActiveWhileParkedSubagentsRun() {
        assertTrue(L.turnActive("AWAITING_INPUT", runningSubagents = 1, sending = false))
        assertFalse(L.turnActive("AWAITING_INPUT", runningSubagents = 0, sending = false))
        assertTrue(L.turnActive("INTERRUPTED", runningSubagents = 2, sending = false))
    }

    @Test fun endedSessionHoldsNothingBack() {
        for (status in listOf("SUCCEEDED", "FAILED", "CANCELLED")) assertFalse(status, L.turnActive(status, runningSubagents = 2, sending = true))
    }

    @Test fun subagentsAreReadFromTheDetailOrTheListRow() {
        assertEquals(2, L.runningSubagents(Wire.json.parseToJsonElement("""{"runningSubagents":["toolu_a","toolu_b"]}""").jsonObject))
        assertEquals(0, L.runningSubagents(Wire.json.parseToJsonElement("""{"runningSubagents":[]}""").jsonObject))
        assertEquals(3, L.runningSubagents(Wire.json.parseToJsonElement("""{"runningSubagentCount":3}""").jsonObject))
        assertNull(L.runningSubagents(JsonObject(emptyMap())))
    }

    @Test fun targets() {
        assertEquals("develop", L.defaultTarget(listOf("main", "develop"), "develop"))
        assertEquals("main", L.defaultTarget(listOf("main", "master"), "deleted"))
        assertEquals("main", L.defaultTarget(listOf("master", "main"), null))
        assertEquals("master", L.defaultTarget(listOf("master", "trunk"), null))
        assertEquals("trunk", L.defaultTarget(listOf("trunk", "release"), null))
        assertNull(L.defaultTarget(emptyList(), "main"))
        assertTrue(L.resolvable("conflict")); assertFalse(L.resolvable("error")); assertFalse(L.resolvable(null))
        assertEquals("release/1.2", L.conflictTarget("release/1.2", listOf("main", "release/1.2"), null))
        assertEquals("master", L.conflictTarget(null, listOf("master", "dev"), null))
        assertEquals("main", L.conflictTarget(null, emptyList(), null))
    }

    @Test fun failures() {
        assertEquals("target has uncommitted changes", L.failureMessage("error", " target has uncommitted changes \n", null, null))
        assertEquals("Merge conflict — aborted, working tree left clean.\nCONFLICT (content): file.txt", L.failureMessage("conflict", "CONFLICT (content): file.txt", null, null))
        assertEquals("commit failed", L.failureMessage("error", "merge", "error", "commit failed"))
        val git = "fatal: Unable to create '/root/orbit/.git/worktrees/01a0d723/index.lock': File exists.\nthe commit waited 2s for this checkout's index.lock"
        val summary = "A git process (pid 48213) has held this worktree's index lock for 3 minutes. Retry once it finishes, or hand it to the session."
        assertEquals(WorktreeBarLogic.CommitFailure("Couldn't commit — git is busy in this worktree", summary, git), L.commitFailure("error", git, " $summary "))
        assertEquals("Another git process holds this worktree's index lock. Retry once it finishes, or hand it to the session.", L.commitFailure("error", git, null)?.why)
        val error = "error: Your local changes to the following files would be overwritten by merge"
        assertEquals(WorktreeBarLogic.CommitFailure("Couldn't commit", error, null), L.commitFailure("error", error, null))
        assertEquals(WorktreeBarLogic.CommitFailure("Couldn't commit", "Commit failed — try again.", null), L.commitFailure("error", null, null))
        listOf(null, "pending", "committed", "nochange").forEach { assertNull(L.commitFailure(it, git, summary)) }
        assertEquals("The Commit button on the worktree bar could not commit this session's work. It said: \"$summary\"\n\n" +
            "You're in this session's isolated git worktree, checked out on orbit/web-command-workspace-7960ce." +
            " Find out what stopped the commit and clear it: let a git command that is still running here" +
            " finish; an index.lock that no process has open was left behind by a git that died and is safe" +
            " to remove. Then commit the work on this branch with a message that describes it. Do not push.",
            L.resolveCommitPrompt("orbit/web-command-workspace-7960ce", summary))
        assertEquals("git rebase develop orbit/fix-a1b2c3 && git checkout develop && git merge --ff-only orbit/fix-a1b2c3", L.manualMergeCommand("develop", "orbit/fix-a1b2c3"))
    }

    private fun patch(path: String, text: String?, truncated: Boolean? = null) = buildJsonObject {
        put("path", path); text?.let { put("patch", it) }; truncated?.let { put("truncated", it) } }

    @Test fun diffRefresh() {
        val files = listOf(ChangedFile("src/app.swift", 1, 0, "M"))
        assertTrue(L.shouldRefreshDiff(true, files, emptyList()))
        assertTrue(L.shouldRefreshDiff(true, files, listOf(patch("src/app.swift", ""))))
        assertFalse(L.shouldRefreshDiff(false, files, emptyList()))
        assertFalse(L.shouldRefreshDiff(true, files, listOf(patch("src/app.swift", "@@ -1 +1 @@\n-old\n+new"))))
        assertFalse(L.shouldRefreshDiff(true, listOf(ChangedFile("Assets/icon.png", -1, -1, "M"), ChangedFile("generated.txt", 8_000, 0, "A")),
            listOf(patch("generated.txt", null, truncated = true))))
        assertTrue(L.shouldRefreshDiff(true, listOf(ChangedFile("ready.swift", 1, 1, "M"), ChangedFile("missing.swift", 2, 0, "A")),
            listOf(patch("ready.swift", "@@ -1 +1 @@\n-a\n+b"))))
    }

    @Test fun branchParts() {
        assertEquals(Triple("orbit/", "ios-git-web-style", "-3d553c"), L.branchParts("orbit/ios-git-web-style-3d553c"))
        assertNull(L.branchParts("main")); assertNull(L.branchParts("feature/login"))
        assertNull(L.branchParts("orbit/fix-ABCDEF")); assertNull(L.branchParts("orbit/-abcdef"))
    }

    /** A06-8 (iOS 621e62f0b): a coordinator shows its project's integration line, and Merge goes to the server-resolved target. */
    @Test fun aCoordinatorShowsItsProjectsLineAndMergesWhereTheServerResolved() {
        val coordinator = Wire.json.parseToJsonElement("""{"branch":"orbit/coord-abcdef","projectIntegrationRef":"project/34ZZn8fmemArxvl2CsCFp",
            "projectMembership":{"projectId":"p","role":"COORDINATOR"},"mergeTarget":"project/34ZZn8fmemArxvl2CsCFp","mergeTargets":["main","develop"],
            "agent":{"id":"a","defaultMergeTarget":"develop"}}""").jsonObject
        assertEquals("project/34ZZn8fmemArxvl2CsCFp", L.displayBranch(coordinator, "orbit/coord-abcdef"))
        assertEquals("project/34ZZn8fmemArxvl2CsCFp", L.mergeTarget(coordinator))
        val task = JsonObject(coordinator + ("projectMembership" to buildJsonObject { put("role", "TASK") }) - "mergeTarget")
        assertEquals("a task session keeps its own branch", "orbit/coord-abcdef", L.displayBranch(task, "orbit/coord-abcdef"))
        assertEquals("without a resolved target, the agent's remembered one", "develop", L.mergeTarget(task))
        assertEquals("a coordinator on a server without the line shows its branch", "orbit/coord-abcdef",
            L.displayBranch(JsonObject(coordinator - "projectIntegrationRef"), "orbit/coord-abcdef"))
    }

    @Test fun fileFailuresSayWhatHappenedAndWhetherToRetry() {
        fun api(status: Int, body: String = "{}") = ApiError.parse(status, body.encodeToByteArray())
        assertEquals(WorktreeFileFailure("File not found", "The file may have moved or been removed from the current worktree.", true), WorktreeFileFailure.from(api(404)))
        assertEquals(WorktreeFileFailure("File too large", "This file exceeds the download limit. Open it on the runner instead.", false), WorktreeFileFailure.from(api(413)))
        assertEquals("Runner unavailable", WorktreeFileFailure.from(api(503)).title)
        assertEquals("File request timed out", WorktreeFileFailure.from(api(504)).title)
        assertEquals(WorktreeFileFailure("File unavailable", "Path is outside the worktree", false), WorktreeFileFailure.from(api(400, """{"message":"Path is outside the worktree"}""")))
        assertEquals(WorktreeFileFailure("Couldn't load file", "the connection dropped", true), WorktreeFileFailure.from(NetworkException()))
        assertEquals(WorktreeFileFailure("Couldn't load file", "the server returned 500", true), WorktreeFileFailure.from(api(500)))
        assertFalse(WorktreeFileFailure.deleted.canRetry)
    }

    @Test fun diffLinesDropGitsHeadersAndStopAtTheCap() {
        val (lines, trimmed) = diffLines("diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file")
        assertEquals(listOf("@@ -1 +1 @@", "-old", "+new"), lines)
        assertFalse(trimmed)
        assertTrue(diffLines((1..5).joinToString("\n") { "+$it" }, cap = 3).second)
    }
}
