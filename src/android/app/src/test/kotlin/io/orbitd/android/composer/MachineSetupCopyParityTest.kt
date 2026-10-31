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
        "SETUP_LEAD" to MachineSetupCopy.SETUP_LEAD,
        "SETUP_OPEN_MACHINE" to MachineSetupCopy.SETUP_OPEN_MACHINE,
        "SETUP_FOLDER" to MachineSetupCopy.SETUP_FOLDER,
        "SETUP_REGISTER_DIR" to MachineSetupCopy.SETUP_REGISTER_DIR,
        "SETUP_NEW_FOLDER" to MachineSetupCopy.SETUP_NEW_FOLDER,
        "SETUP_NEW_FOLDER_NAME" to MachineSetupCopy.SETUP_NEW_FOLDER_NAME,
        "SETUP_NEW_FOLDER_META" to MachineSetupCopy.SETUP_NEW_FOLDER_META,
        "SETUP_NEW_FOLDER_DONE" to MachineSetupCopy.SETUP_NEW_FOLDER_DONE,
        "SETUP_NEW_FOLDER_INVALID" to MachineSetupCopy.SETUP_NEW_FOLDER_INVALID,
        "SETUP_USE_FOLDER" to MachineSetupCopy.SETUP_USE_FOLDER,
        "SETUP_CHANGE" to MachineSetupCopy.SETUP_CHANGE,
        "SETUP_FOUND_PREFIX" to MachineSetupCopy.SETUP_FOUND_PREFIX,
        "SETUP_NOT_GIT" to MachineSetupCopy.SETUP_NOT_GIT,
        "SETUP_CHECK_AGAIN" to MachineSetupCopy.SETUP_CHECK_AGAIN,
        "SETUP_SIGN_IN_HELP" to MachineSetupCopy.SETUP_SIGN_IN_HELP,
        "SETUP_ON_A_KEY" to MachineSetupCopy.SETUP_ON_A_KEY,
        "SETUP_ON_A_POOL" to MachineSetupCopy.SETUP_ON_A_POOL,
        "SETUP_FOOT" to MachineSetupCopy.SETUP_FOOT,
        "HELD_WITHDRAW" to MachineSetupCopy.HELD_WITHDRAW,
        "HELD_SENDING" to MachineSetupCopy.HELD_SENDING,
        "HELD_TRY_AGAIN" to MachineSetupCopy.HELD_TRY_AGAIN,
        "HELD_ALREADY_WAITING" to MachineSetupCopy.HELD_ALREADY_WAITING,
        "HELD_ALREADY_WAITING_DETAIL" to MachineSetupCopy.HELD_ALREADY_WAITING_DETAIL,
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
    )

    private val templates = listOf(
        "setupTitle" to MachineSetupCopy.setupTitle("\\(machine)"),
        "setupOffline" to MachineSetupCopy.setupOffline("\\(machine)"),
        "setupUpdating" to MachineSetupCopy.setupUpdating("\\(machine)"),
        "setupNeedsUpdate" to MachineSetupCopy.setupNeedsUpdate("\\(machine)"),
        "setupFolderHelp" to MachineSetupCopy.setupFolderHelp("\\(machine)"),
        "setupOtherFolder" to MachineSetupCopy.setupOtherFolder("\\(machine)"),
        "setupChecking" to MachineSetupCopy.setupChecking("\\(machine)"),
        "setupNoSuchDirectory" to MachineSetupCopy.setupNoSuchDirectory("\\(machine)"),
        "setupNotADirectory" to MachineSetupCopy.setupNotADirectory("\\(machine)"),
        "setupNoAnswer" to MachineSetupCopy.setupNoAnswer("\\(machine)"),
        "setupCouldNotCheck" to MachineSetupCopy.setupCouldNotCheck("\\(machine)", "\\(why)"),
        "setupSignIn" to MachineSetupCopy.setupSignIn("\\(engine)", "\\(machine)"),
        "setupSignedIn" to MachineSetupCopy.setupSignedIn("\\(machine)"),
        "setupUseEngine" to MachineSetupCopy.setupUseEngine("\\(engine)"),
        "setupNotInstalled" to MachineSetupCopy.setupNotInstalled("\\(engine)", "\\(machine)"),
        "setupReady" to MachineSetupCopy.setupReady("\\(workspace)", "\\(path)"),
        "composerPlaceholderFor" to MachineSetupCopy.composerPlaceholderFor("\\(machine)"),
        "heldWaiting" to MachineSetupCopy.heldWaiting("\\(machine)"),
        "heldFailed" to MachineSetupCopy.heldFailed("\\(why)"),
        "machineEmptyHere" to MachineSetupCopy.machineEmptyHere("\\(machine)"),
    )

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
        val listed = constants.map { it.first }.toSet() + templates.map { it.first }.toSet() + setOf("setupGit")
        assertEquals("list every sentence in MachineSetupCopyParityTest", swiftNames, listed)
    }
}
