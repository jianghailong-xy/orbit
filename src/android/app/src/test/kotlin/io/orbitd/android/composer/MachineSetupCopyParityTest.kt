package io.orbitd.android.composer

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * The setup card says what Swift's `MachineSetupCopy.swift` (and the web's `machineSetupCopy.ts`) says, word for word.
 * Reads `src/macos/OrbitKit/Sources/OrbitKit/App/MachineSetupCopy.swift` as text and checks every constant, template,
 * and declaration name. A missing file fails, never skips.
 */
class MachineSetupCopyParityTest {
    private val root: File by lazy {
        generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .firstOrNull { File(it, "src/macos/OrbitKit/Sources/OrbitKit/App/MachineSetupCopy.swift").isFile }
            .also { assertNotNull("the repository root was not found above the test's working directory", it) }!!
    }

    private val swiftSource: String by lazy {
        File(root, "src/macos/OrbitKit/Sources/OrbitKit/App/MachineSetupCopy.swift")
            .also { assertTrue("MachineSetupCopy.swift is missing", it.isFile) }
            .readText()
    }

    private val kotlinSource: String by lazy {
        File(root, "src/android/app/src/main/kotlin/io/orbitd/android/composer/MachineSetupCopy.kt")
            .also { assertTrue("MachineSetupCopy.kt is missing", it.isFile) }
            .readText()
    }

    private val swiftConstants: Map<String, String> by lazy {
        val flat = swiftSource.replace(Regex("""=\s*\n\s*""""), """= """")
        Regex("""^\s*public static let ([A-Z0-9_]+) = "([^"\n]*)"$""", RegexOption.MULTILINE)
            .findAll(flat)
            .associate { it.groupValues[1] to it.groupValues[2] }
    }

    private val swiftTemplates: Map<String, String> by lazy {
        val flat = swiftSource.replace(Regex("""\{\s*\n\s*"([^\n"]*)"\s*\n\s*\}"""), """{ "$1" }""")
        Regex("""^\s*public static func (\w+)\([^)]*\) -> String \{ "((?:[^"\\]|\\.)*)" \}$""", RegexOption.MULTILINE)
            .findAll(flat)
            .associate { it.groupValues[1] to it.groupValues[2] }
    }

    private val constants = listOf(
        "SETUP_OPEN_MACHINE" to MachineSetupCopy.SETUP_OPEN_MACHINE,
        "SETUP_FOLDER" to MachineSetupCopy.SETUP_FOLDER,
        "SETUP_NEW_FOLDER_NAME" to MachineSetupCopy.SETUP_NEW_FOLDER_NAME,
        "SETUP_FOLDER_HINT" to MachineSetupCopy.SETUP_FOLDER_HINT,
        "SETUP_NEW_FOLDER_META" to MachineSetupCopy.SETUP_NEW_FOLDER_META,
        "SETUP_NEW_FOLDER_DONE" to MachineSetupCopy.SETUP_NEW_FOLDER_DONE,
        "SETUP_NEW_FOLDER_INVALID" to MachineSetupCopy.SETUP_NEW_FOLDER_INVALID,
        "SETUP_CHANGE" to MachineSetupCopy.SETUP_CHANGE,
        "SETUP_FOUND_PREFIX" to MachineSetupCopy.SETUP_FOUND_PREFIX,
        "SETUP_NOT_GIT" to MachineSetupCopy.SETUP_NOT_GIT,
        "SETUP_CHECK_AGAIN" to MachineSetupCopy.SETUP_CHECK_AGAIN,
        "SETUP_ON_A_KEY" to MachineSetupCopy.SETUP_ON_A_KEY,
        "SETUP_ON_A_POOL" to MachineSetupCopy.SETUP_ON_A_POOL,
        "CREATED_WORKSPACE" to MachineSetupCopy.CREATED_WORKSPACE,
        "CREATED_ON" to MachineSetupCopy.CREATED_ON,
        "CREATED_RENAME" to MachineSetupCopy.CREATED_RENAME,
        "CREATED_SETTINGS" to MachineSetupCopy.CREATED_SETTINGS,
        "CREATED_RENAME_LABEL" to MachineSetupCopy.CREATED_RENAME_LABEL,
        "CREATED_RENAME_FAILED" to MachineSetupCopy.CREATED_RENAME_FAILED,
        "START_A_SESSION" to MachineSetupCopy.START_A_SESSION,
        "REGISTER_NEXT" to MachineSetupCopy.REGISTER_NEXT,
        "SETUP_USE_API_KEY" to MachineSetupCopy.SETUP_USE_API_KEY,
        "SETUP_PAGE_TITLE" to MachineSetupCopy.SETUP_PAGE_TITLE,
        "RUNNER_WORKSPACES_TAP" to MachineSetupCopy.RUNNER_WORKSPACES_TAP,
        "NO_WORKSPACES_YET" to MachineSetupCopy.NO_WORKSPACES_YET,
        "NO_WORKSPACES_DETAIL" to MachineSetupCopy.NO_WORKSPACES_DETAIL,
        "SETUP_NEW_FOLDER_WITH_WORKSPACE" to MachineSetupCopy.SETUP_NEW_FOLDER_WITH_WORKSPACE,
        "SETUP_NAME" to MachineSetupCopy.SETUP_NAME,
        "SETUP_NAME_PLACEHOLDER" to MachineSetupCopy.SETUP_NAME_PLACEHOLDER,
        "SETUP_NAME_HINT" to MachineSetupCopy.SETUP_NAME_HINT,
        "SETUP_NAME_EDITED" to MachineSetupCopy.SETUP_NAME_EDITED,
        "SETUP_NAME_EMPTY" to MachineSetupCopy.SETUP_NAME_EMPTY,
        "SETUP_CREATE" to MachineSetupCopy.SETUP_CREATE,
        "SETUP_FROM_GITHUB" to MachineSetupCopy.SETUP_FROM_GITHUB,
        "SETUP_NEW_TAG" to MachineSetupCopy.SETUP_NEW_TAG,
        "SETUP_OR" to MachineSetupCopy.SETUP_OR,
        "SETUP_FOLDER_NAME_INSTEAD" to MachineSetupCopy.SETUP_FOLDER_NAME_INSTEAD,
        "SETUP_GITHUB_META" to MachineSetupCopy.SETUP_GITHUB_META,
        "SETUP_CONNECT_GITHUB" to MachineSetupCopy.SETUP_CONNECT_GITHUB,
        "SETUP_CONNECT_GITHUB_META" to MachineSetupCopy.SETUP_CONNECT_GITHUB_META,
        "SETUP_RECONNECT_GITHUB" to MachineSetupCopy.SETUP_RECONNECT_GITHUB,
        "SETUP_GITHUB_SEARCH" to MachineSetupCopy.SETUP_GITHUB_SEARCH,
        "SETUP_GITHUB_NOT_LISTED" to MachineSetupCopy.SETUP_GITHUB_NOT_LISTED,
        "SETUP_GITHUB_ADD_REPOSITORIES" to MachineSetupCopy.SETUP_GITHUB_ADD_REPOSITORIES,
        "SETUP_GITHUB_LOADING" to MachineSetupCopy.SETUP_GITHUB_LOADING,
        "SETUP_GITHUB_NONE" to MachineSetupCopy.SETUP_GITHUB_NONE,
        "SETUP_GITHUB_PRIVATE" to MachineSetupCopy.SETUP_GITHUB_PRIVATE,
        "SETUP_GITHUB_CLONED_META" to MachineSetupCopy.SETUP_GITHUB_CLONED_META,
        "SETUP_OTHER_BRANCH" to MachineSetupCopy.SETUP_OTHER_BRANCH,
        "SETUP_DEFAULT_BRANCH" to MachineSetupCopy.SETUP_DEFAULT_BRANCH,
        "SETUP_BRANCH" to MachineSetupCopy.SETUP_BRANCH,
        "SETUP_GITHUB_DONE" to MachineSetupCopy.SETUP_GITHUB_DONE,
        "CLONE_CLONING" to MachineSetupCopy.CLONE_CLONING,
        "CLONE_WAITING" to MachineSetupCopy.CLONE_WAITING,
        "CLONE_INSTALL_ON_GITHUB" to MachineSetupCopy.CLONE_INSTALL_ON_GITHUB,
        "CLONE_SIGN_IN_EXPIRED" to MachineSetupCopy.CLONE_SIGN_IN_EXPIRED,
        "CLONE_RECONNECT" to MachineSetupCopy.CLONE_RECONNECT,
        "CLONE_RETRY" to MachineSetupCopy.CLONE_RETRY,
        "CLONE_RETRY_FAILED" to MachineSetupCopy.CLONE_RETRY_FAILED,
        "CLONE_STARTS_WHEN_DONE" to MachineSetupCopy.CLONE_STARTS_WHEN_DONE,
    )

    private val templates = listOf(
        "setupTitle" to MachineSetupCopy.setupTitle("\\(machine)"),
        "setupNeedsUpdate" to MachineSetupCopy.setupNeedsUpdate("\\(machine)"),
        "setupNewFolderIsFile" to MachineSetupCopy.setupNewFolderIsFile("\\(machine)"),
        "setupChecking" to MachineSetupCopy.setupChecking("\\(machine)"),
        "setupNoSuchDirectory" to MachineSetupCopy.setupNoSuchDirectory("\\(machine)"),
        "setupNotADirectory" to MachineSetupCopy.setupNotADirectory("\\(machine)"),
        "setupNoAnswer" to MachineSetupCopy.setupNoAnswer("\\(machine)"),
        "setupCouldNotCheck" to MachineSetupCopy.setupCouldNotCheck("\\(machine)", "\\(why)"),
        "composerPlaceholderFor" to MachineSetupCopy.composerPlaceholderFor("\\(machine)"),
        "heldWaiting" to MachineSetupCopy.heldWaiting("\\(machine)"),
        "machineEmptyHere" to MachineSetupCopy.machineEmptyHere("\\(machine)"),
        "setupNewWorkspaceTitle" to MachineSetupCopy.setupNewWorkspaceTitle("\\(machine)"),
        "setupNewWorkspaceLead" to MachineSetupCopy.setupNewWorkspaceLead("\\(machine)"),
        "setupOfflineCreate" to MachineSetupCopy.setupOfflineCreate("\\(machine)"),
        "setupConnectingCreate" to MachineSetupCopy.setupConnectingCreate("\\(machine)"),
        "setupUpdatingCreate" to MachineSetupCopy.setupUpdatingCreate("\\(machine)"),
        "setupFolderOrPathHint" to MachineSetupCopy.setupFolderOrPathHint("\\(root)"),
        "setupPathUnchecked" to MachineSetupCopy.setupPathUnchecked("\\(machine)"),
        "setupCreateFailed" to MachineSetupCopy.setupCreateFailed("\\(why)"),
        "setupGithubSignInAgain" to MachineSetupCopy.setupGithubSignInAgain("\\(login)"),
        "setupGithubConnectFailed" to MachineSetupCopy.setupGithubConnectFailed("\\(why)"),
        "setupGithubListFailed" to MachineSetupCopy.setupGithubListFailed("\\(why)"),
        "setupGithubFolderExists" to MachineSetupCopy.setupGithubFolderExists("\\(machine)"),
        "setupGithubDonePath" to MachineSetupCopy.setupGithubDonePath("\\(repository)", "\\(path)"),
        "setupCloneUpdating" to MachineSetupCopy.setupCloneUpdating("\\(machine)"),
        "setupCloneNeedsUpdate" to MachineSetupCopy.setupCloneNeedsUpdate("\\(machine)"),
        "cloneAppRemoved" to MachineSetupCopy.cloneAppRemoved("\\(repository)"),
    )

    /** Swift's templates with a condition in them, checked by what they render, each named here. */
    private val conditional = setOf("setupGit", "setupGithubAccount", "cloneCouldNot", "pushedAgo")

    @Test fun everyConstantMatchesSwiftWordForWord() {
        for ((name, value) in constants) {
            assertEquals("$name drifted from MachineSetupCopy.swift", swiftConstants[name], value)
        }
    }

    @Test fun everyTemplateMatchesSwiftWordForWord() {
        for ((name, rendered) in templates) {
            assertEquals("$name drifted from MachineSetupCopy.swift", swiftTemplates[name], rendered)
        }
    }

    @Test fun setupGitMatchesSwift() {
        assertTrue(
            "setupGit changed shape in Swift",
            swiftSource.contains(""""git repository\(branch.map { " · \($0)" } ?? "")"""")
        )
        assertEquals("git repository · main", MachineSetupCopy.setupGit("main"))
        assertEquals("git repository", MachineSetupCopy.setupGit(null))
        assertEquals("git repository", MachineSetupCopy.setupGit(""))
    }

    @Test fun bothFilesDeclareTheExactSameSentencesUnderTheSameNames() {
        val swiftNames = Regex("""public static (?:let|func) (\w+)""")
            .findAll(swiftSource)
            .map { it.groupValues[1] }
            .toSet()
        val kotlinNames = Regex("""(?:const val|fun) (\w+)""")
            .findAll(kotlinSource)
            .map { it.groupValues[1] }
            .toSet()
        assertEquals("MachineSetupCopy.kt and MachineSetupCopy.swift declaration names differ", swiftNames, kotlinNames)
        val listed = constants.map { it.first }.toSet() + templates.map { it.first }.toSet() + conditional
        assertEquals("list every sentence in MachineSetupCopyParityTest", swiftNames, listed)
    }

    /** The account line leaves the count out when GitHub wasn't asked, and says one repository in the singular. */
    @Test fun theGithubAccountLineIsSwifts() {
        assertTrue("setupGithubAccount changed shape in Swift", swiftSource.contains("""guard let repositories else { return "Signed in to GitHub as @\(login)" }"""))
        assertTrue(swiftSource.contains(""""Signed in to GitHub as @\(login) · \(repositories) \(repositories == 1 ? "repository" : "repositories")""""))
        assertEquals("Signed in to GitHub as @ada", MachineSetupCopy.setupGithubAccount("ada", null))
        assertEquals("Signed in to GitHub as @ada · 1 repository", MachineSetupCopy.setupGithubAccount("ada", 1))
        assertEquals("Signed in to GitHub as @ada · 12 repositories", MachineSetupCopy.setupGithubAccount("ada", 12))
    }

    /** A failed clone whose reason hasn't been read yet ends at the repository, with no colon left hanging. */
    @Test fun couldNotCloneIsSwiftsWithAndWithoutAReason() {
        assertTrue(swiftSource.contains("""why.isEmpty ? "Couldn’t clone \(repository)." : "Couldn’t clone \(repository): \(why)""""))
        assertEquals("Couldn’t clone o/r: git said no.", MachineSetupCopy.cloneCouldNot("o/r", "git said no."))
        assertEquals("Couldn’t clone o/r.", MachineSetupCopy.cloneCouldNot("o/r", ""))
    }

    /** When a repository was pushed, in Swift's (and the web's) words at each step. */
    @Test fun pushedAgoIsSwiftsAtEachStep() {
        for (words in listOf(""""pushed just now"""", """"pushed \(minutes) \(minutes == 1 ? "minute" : "minutes") ago"""",
                """"pushed \(hours) \(hours == 1 ? "hour" : "hours") ago"""", """"pushed yesterday"""")) {
            assertTrue("pushedAgo no longer says $words in Swift", swiftSource.contains(words))
        }
        val now = java.time.Instant.parse("2026-11-16T12:00:00Z").toEpochMilli()
        fun ago(seconds: Long) = MachineSetupCopy.pushedAgo(java.time.Instant.ofEpochMilli(now - seconds * 1000).toString(), now)
        assertEquals("", MachineSetupCopy.pushedAgo(null, now))
        assertEquals("", MachineSetupCopy.pushedAgo("not a date", now))
        assertEquals("pushed just now", ago(20))
        assertEquals("pushed 1 minute ago", ago(60))
        assertEquals("pushed 59 minutes ago", ago(59 * 60))
        assertEquals("pushed 1 hour ago", ago(3600))
        assertEquals("pushed yesterday", ago(30 * 3600))
        assertTrue(ago(30 * 86_400).startsWith("pushed Oct "))
        assertTrue(ago(400 * 86_400).matches(Regex("""pushed \w{3} \d{1,2}, 2025""")))
    }
}
