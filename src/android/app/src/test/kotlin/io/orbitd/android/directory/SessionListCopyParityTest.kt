package io.orbitd.android.directory

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The list's words are iOS's, byte for byte: every constant of [SessionListCopy] is a literal of the Swift it was ported from, and every
 * built one is a Swift interpolation. A missing counterpart is a failure, never a skip (ProjectCopyParityTest's rule). */
class SessionListCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
    private fun views(name: String) = File(root, "src/macos/OrbitApp/Sources/OrbitApp/Views/$name").readText()
    private fun app(name: String) = File(root, "src/macos/OrbitApp/Sources/OrbitApp/$name").readText()
    private fun kit(name: String) = File(root, "src/macos/OrbitKit/Sources/OrbitKit/App/$name").readText()

    @Test fun everyWordIsASwiftLiteral() {
        val agents = views("AgentsView.swift")
        val shell = views("CompactShell.swift")
        val folder = views("SessionFolderPage.swift")
        val held = mapOf(
            SessionListCopy.FILTER_BY_TAG to agents, SessionListCopy.GROUP_BY_TAG to agents, SessionListCopy.ALL_TAGS to agents,
            SessionListCopy.SETTINGS to agents, SessionListCopy.LOADING to agents, SessionListCopy.UNTAGGED to agents,
            SessionListCopy.PINNED_SHOWS to agents, SessionListCopy.PINNED_HIDES to agents, SessionListCopy.WORKSPACES_FAILED to agents,
            SessionListCopy.REQUEST_FAILED to agents, SessionListCopy.RETRY to agents,
            SessionListCopy.SESSION_EXPIRED to app("AgentsModel.swift"),
            SessionListCopy.UNREACHABLE to shell, SessionListCopy.UNREACHABLE_DETAIL to shell,
            SessionListCopy.FOLDER_ACTIONS to folder, SessionListCopy.FOLDER_EMPTY to folder,
            SessionListCopy.FOLDER_RUNNING to folder, SessionListCopy.FOLDER_JOBS to folder,
            SessionListCopy.COORDINATOR to views("SessionCoordinatorBadge.swift"), SessionListCopy.COORDINATOR_LABEL to views("SessionCoordinatorBadge.swift"),
            SessionListCopy.NEW_FOLDER to kit("SessionMove.swift"), SessionListCopy.SEARCH to views("SessionListSearch.swift"),
        )
        held.forEach { (words, source) -> assertTrue("no Swift literal says \"$words\"", source.contains("\"$words\"")) }
        // A word added to the object and not above fails.
        val declared = SessionListCopy::class.java.declaredFields.filter { it.type == String::class.java }
            .map { it.isAccessible = true; it.get(null) as String }.toSet()
        assertEquals(declared, held.keys)
    }

    @Test fun everyBuiltLineIsOneSwiftInterpolation() {
        val agents = views("AgentsView.swift")
        val folder = views("SessionFolderPage.swift")
        assertEquals("Session scope, Open", SessionListCopy.scope(SessionView.OPEN))
        assertTrue(agents.contains("\"Session scope, \\(view.title)\""))
        assertEquals("Start a new session with Alpha", SessionListCopy.startSession("Alpha"))
        assertTrue(agents.contains("\"Start a new session with \\(agent.name)\""))
        assertEquals("Start a new session in Research", SessionListCopy.startSessionIn("Research"))
        assertTrue(folder.contains("\"Start a new session in \\(titleText)\""))
        assertEquals("No completed sessions", SessionListCopy.noSessions(SessionView.COMPLETED))
        assertTrue(agents.contains("\"No \\(view.title.lowercased()) sessions\""))
        assertEquals("3 sessions", SessionListCopy.folderSessions(3))
        assertTrue(folder.contains("\"\\(row.sessionCount) sessions\""))
    }
}
