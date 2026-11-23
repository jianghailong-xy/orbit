package io.orbitd.android.reader

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.reader.CommitsLogic.Tab
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class CommitsLogicTest {
    @Test fun countLabels() {
        assertEquals("Uncommitted · 0 files", CommitsLogic.barLabel(0, 0, dirty = false))
        assertEquals("Uncommitted · 1 file", CommitsLogic.barLabel(0, 1, dirty = true))
        assertEquals("1 commit", CommitsLogic.barLabel(1, 8, dirty = false))
        assertEquals("2 commits + uncommitted", CommitsLogic.barLabel(2, 8, dirty = true))
        assertEquals("99 commits", CommitsLogic.barLabel(99, 8, dirty = false))
        assertEquals("100+ commits", CommitsLogic.barLabel(100, 8, dirty = false))
        assertEquals("100+", CommitsLogic.count(101))
        assertEquals("1+ files", CommitsLogic.filesLabel(1, truncated = true))
    }

    @Test fun whichTabOpens() {
        assertNull(CommitsLogic.initialTab(null))
        assertNull(CommitsLogic.initialTab(null, "README.md"))
        assertEquals(Tab.ALL_CHANGES, CommitsLogic.initialTab(0))
        assertEquals(Tab.COMMITS, CommitsLogic.initialTab(2))
        assertEquals(Tab.ALL_CHANGES, CommitsLogic.initialTab(2, "README.md"))
    }

    @Test fun pendingRowOpensAllChangesWhenDirty() {
        assertEquals(Tab.ALL_CHANGES, CommitsLogic.pendingRowTarget(dirty = true))
        assertNull(CommitsLogic.pendingRowTarget(dirty = false))
    }

    @Test fun saveLabels() {
        assertNull(CommitsLogic.savedByLabel(null))
        assertNull(CommitsLogic.savedByLabel(""))
        assertEquals("Saved with Commit", CommitsLogic.savedByLabel("commit-button"))
        assertEquals("Auto-saved by Orbit", CommitsLogic.savedByLabel("session-end"))
        assertEquals("Auto-saved by Orbit", CommitsLogic.savedByLabel("checkpoint"))
    }

    @Test fun wholeChangeNoteDependsOnOverlapOrDirtyWorktree() {
        val commit = commit("abc", "src/Bar.kt", "src/Other.kt")
        val other = commit("def", "src/Alone.kt")
        val overlap = commit("123", "src/Other.kt")
        val note = "Some of these files change elsewhere on the branch too: their diffs show each file's whole change."
        assertNull(CommitsLogic.mixedNote(commit, listOf(commit, other), dirty = false))
        assertEquals(note, CommitsLogic.mixedNote(commit, listOf(commit, other), dirty = true))
        assertEquals(note, CommitsLogic.mixedNote(commit, listOf(commit, overlap), dirty = false))
    }

    @Test fun readsTheWireShapeAndPreservesRunnerOrder() {
        assertNull(read("{}"))
        assertNull(read("""{"branchCommits":null}"""))
        assertEquals(emptyList<BranchCommit>(), read("""{"branchCommits":[]}"""))
        val commits = checkNotNull(read("""{"branchCommits":[
            {"sha":"12345678","subject":"Add image","body":"Show a preview","committedAt":"2026-11-22T10:00:00Z",
             "savedBy":"checkpoint","files":[{"path":"logo.png","additions":-1,"deletions":-1}],"filesTruncated":true},
            {"sha":"abcdefgh","subject":"Set up","committedAt":"2026-11-21T10:00:00Z","files":[]}
        ]}"""))
        assertEquals(listOf("12345678", "abcdefgh"), commits.map { it.sha })
        val first = commits.first()
        assertEquals("Add image", first.subject)
        assertEquals("Show a preview", first.body)
        assertEquals("checkpoint", first.savedBy)
        assertEquals(ChangedFile("logo.png", -1, -1, ""), first.files.single())
        assertTrue(first.files.single().binary)
        assertTrue(first.filesTruncated)
        assertFalse(commits.last().filesTruncated)
        assertEquals("12m ago", CommitsLogic.age(first.committedAt, Instant.parse("2026-11-22T10:12:00Z")))
    }

    private fun read(json: String) = BranchCommit.of(Wire.json.parseToJsonElement(json).jsonObject)

    private fun commit(sha: String, vararg paths: String) = BranchCommit(
        sha, "Update files", null, "2026-11-22T10:00:00Z", null, paths.map { ChangedFile(it, 2, 1, "") }, false,
    )
}
