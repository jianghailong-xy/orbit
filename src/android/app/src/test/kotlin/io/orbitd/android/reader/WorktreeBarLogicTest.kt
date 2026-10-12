package io.orbitd.android.reader

import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.NetworkException
import io.orbitd.android.core.protocol.Wire
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

    @Test fun primaryAction() {
        assertEquals(WorktreeBarLogic.Primary.COMMIT, L.primary(true, committed = false, turnActive = false))
        assertEquals(WorktreeBarLogic.Primary.MERGE, L.primary(false, committed = false, turnActive = false))
        assertEquals("merge waits for the turn", WorktreeBarLogic.Primary.NONE, L.primary(false, committed = false, turnActive = true))
        assertEquals("an ended dirty session merges", WorktreeBarLogic.Primary.MERGE, L.primary(true, committed = true, turnActive = false))
        assertEquals(WorktreeBarLogic.Primary.NONE, L.primary(null, committed = false, turnActive = false))
        assertEquals(WorktreeBarLogic.Primary.MERGE, L.primary(null, committed = true, turnActive = false))
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
