package io.orbitd.android.reader

import io.orbitd.android.reader.WorktreeBarLogic.SharedFolder
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The notice of a session without a worktree says the web's words (docs/mocks/nogit-folder-notice): every fixed word of
 * [SharedFolderCopy] is a literal in web's `SessionOutputs.tsx` (the notice, `InitializeGitSteps`) or `WorkspaceView.tsx` (the
 * confirmation, the toasts), and each sentence built around a folder or a workspace — rendered with a sentinel, put back as the web's
 * own interpolation, whose fallback is what Kotlin says when there is none — is one there too. Held to the web rather than the Swift,
 * which is changing alongside. A missing source fails, never skips.
 */
class SharedFolderCopyParityTest {
    private val root: File by lazy {
        val found = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.firstOrNull { File(it, "src/web/src").isDirectory }
        assertNotNull("the repository root was not found above the test's working directory", found)
        found!!
    }
    /** A web component's source with its `<code>` marks taken out, so the words read as they are said. */
    private fun web(name: String) = File(root, "src/web/src/components/$name").also { assertTrue("$name is missing", it.isFile) }.readText()
        .replace("<code>", "").replace("</code>", "")
    private val outputs by lazy { web("SessionOutputs.tsx") }
    private val view by lazy { web("WorkspaceView.tsx") }
    private val c = SharedFolderCopy

    private fun assertSays(source: String, name: String, words: String) = assertTrue("$name no longer says `$words`", source.contains(words))

    /** [named], rendered around “§”, with “§” put back as the web's [interpolation] of the words [unnamed] says in its place. */
    private fun template(named: String, unnamed: String, interpolation: (String) -> String): String {
        val (before, after) = named.substringBefore("“§”") to named.substringAfter("“§”")
        return before + interpolation(unnamed.removePrefix(before).removeSuffix(after)) + after
    }

    @Test fun theNoticeIsTheWebs() {
        fun headline(notice: SharedFolder, path: String?) = c.headline(notice, path).toList().joinToString("")
        // `const folder = path ? <code …>{path}</code> : 'This folder'`, then `⚠ {folder} isn’t a git repository`.
        assertSays(outputs, "SessionOutputs.tsx", ": '${c.headline(SharedFolder.NOT_GIT, null).second}'")
        assertSays(outputs, "SessionOutputs.tsx", headline(SharedFolder.NOT_GIT, "§").replace("§", "{folder}"))
        assertSays(outputs, "SessionOutputs.tsx", headline(SharedFolder.NO_BRANCH, "§")
            .replace("§", "{path ? folder : '${c.headline(SharedFolder.NO_BRANCH, null).second}'}"))
        listOf(c.NOT_GIT_DETAIL, c.NO_BRANCH_DETAIL, c.KEEP_PLAIN, c.HIDE_HERE).forEach { assertSays(outputs, "SessionOutputs.tsx", "'$it'") }
        assertSays(outputs, "SessionOutputs.tsx", c.INITIALIZE)
    }

    @Test fun theConfirmationIsTheWebs() {
        assertSays(view, "WorkspaceView.tsx", "title: '${c.CONFIRM_TITLE}'")
        assertSays(view, "WorkspaceView.tsx", "confirmText: '${c.CONFIRM}'")
        assertSays(outputs, "SessionOutputs.tsx", template(c.confirmLead("§"), c.confirmLead(null)) { "{workspace ? `“\${workspace}”` : '$it'}" })
        (c.confirmSteps + c.CONFIRM_AFTER).forEach { assertSays(outputs, "SessionOutputs.tsx", it) }
    }

    @Test fun theToastsAreTheWebs() {
        assertSays(view, "WorkspaceView.tsx", "'${c.GIT_QUEUED}'")
        listOf(c.GIT_FAILED, c.OFF_FAILED, c.ON_FAILED).forEach { assertSays(view, "WorkspaceView.tsx", "\"$it\"") }
        assertSays(view, "WorkspaceView.tsx", template(c.isolationOff("§"), c.isolationOff(null)) { "\${ws?.name ? `“\${ws.name}”` : '$it'}" })
        assertSays(view, "WorkspaceView.tsx", "detail: '${c.ISOLATION_OFF_DETAIL}'")
        assertSays(view, "WorkspaceView.tsx", "ariaLabel: '${c.UNDO}'")
    }
}
