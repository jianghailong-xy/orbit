package io.orbitd.android.reader

import io.orbitd.android.wiki.RelativeTime
import java.time.Instant

internal object CommitsLogic {
    enum class Tab { COMMITS, ALL_CHANGES }

    // The runner caps the reported branch history at 100.
    fun count(count: Int): String = if (count >= 100) "100+" else count.toString()

    fun filesLabel(count: Int, truncated: Boolean = false): String =
        "$count${if (truncated) "+" else ""} ${if (count == 1 && !truncated) "file" else "files"}"

    fun barLabel(commitCount: Int, fileCount: Int, dirty: Boolean): String = when {
        commitCount == 0 -> "Uncommitted · ${filesLabel(fileCount)}"
        else -> "${count(commitCount)} ${if (commitCount == 1) "commit" else "commits"}" +
            if (dirty) " + uncommitted" else ""
    }

    fun initialTab(commitCount: Int?, file: String? = null): Tab? = when {
        commitCount == null -> null
        commitCount == 0 || file != null -> Tab.ALL_CHANGES
        else -> Tab.COMMITS
    }

    fun pendingRowTarget(dirty: Boolean): Tab? = Tab.ALL_CHANGES.takeIf { dirty }

    fun savedByLabel(savedBy: String?): String? = when (savedBy) {
        null, "" -> null
        "commit-button" -> "Saved with Commit"
        else -> "Auto-saved by Orbit"
    }

    fun shortSha(sha: String) = sha.take(7)
    fun age(iso: String, now: Instant) = RelativeTime.ago(iso, now) ?: "unknown"

    fun mixedNote(commit: BranchCommit, commits: List<BranchCommit>, dirty: Boolean): String? {
        val paths = commit.files.mapTo(mutableSetOf()) { it.path }
        val shared = commits.any { other -> other.sha != commit.sha && other.files.any { it.path in paths } }
        return if (dirty || shared) {
            "Some of these files change elsewhere on the branch too: their diffs show each file's whole change."
        } else null
    }
}
