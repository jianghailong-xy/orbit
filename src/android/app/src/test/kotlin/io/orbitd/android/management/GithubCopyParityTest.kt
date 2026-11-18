package io.orbitd.android.management

import io.orbitd.android.composer.GithubInstallation
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Settings → GitHub says what OrbitKit's `GithubCopy.swift` and the web's `lib/githubIntegration.ts` and
 * `pages/GithubIntegrationPage.tsx` say. All three are read as text: every constant and one-line template is Swift's, word for word,
 * under the same name, and every sentence is looked for in the spelling the web writes it in. A missing file fails, never skips.
 */
class GithubCopyParityTest {
    private val root: File by lazy {
        generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .firstOrNull { File(it, "src/macos/OrbitKit/Sources/OrbitKit/App/GithubCopy.swift").isFile }
            .also { assertNotNull("the repository root was not found above the test's working directory", it) }!!
    }

    private fun source(relative: String): String =
        File(root, relative).also { assertTrue("$relative is missing", it.isFile) }.readText()

    private val swift by lazy { source("src/macos/OrbitKit/Sources/OrbitKit/App/GithubCopy.swift") }
    private val kotlin by lazy { source("src/android/app/src/main/kotlin/io/orbitd/android/management/GithubCopy.kt") }
    private val lib by lazy { source("src/web/src/lib/githubIntegration.ts") }
    private val page by lazy { source("src/web/src/pages/GithubIntegrationPage.tsx") }

    private val swiftConstants: Map<String, String> by lazy {
        val flat = swift.replace(Regex("""=\s*\n\s*""""), """= """")
        Regex("""^\s*public static let ([A-Z0-9_]+) = "([^"\n]*)"$""", RegexOption.MULTILINE)
            .findAll(flat).associate { it.groupValues[1] to it.groupValues[2] }
    }

    private val constants = listOf(
        "TITLE" to GithubCopy.TITLE, "INTEGRATIONS" to GithubCopy.INTEGRATIONS, "GITHUB_ROW_HINT" to GithubCopy.GITHUB_ROW_HINT,
        "GITHUB_NOT_SET_UP" to GithubCopy.GITHUB_NOT_SET_UP, "LOAD_FAILED" to GithubCopy.LOAD_FAILED, "RETRY" to GithubCopy.RETRY,
        "ACCOUNT" to GithubCopy.ACCOUNT, "BADGE_SIGN_IN_AGAIN" to GithubCopy.BADGE_SIGN_IN_AGAIN,
        "BADGE_CONNECTED" to GithubCopy.BADGE_CONNECTED, "SEES_ONLY" to GithubCopy.SEES_ONLY, "RECONNECT" to GithubCopy.RECONNECT,
        "DISCONNECT" to GithubCopy.DISCONNECT, "DISCONNECT_TITLE" to GithubCopy.DISCONNECT_TITLE,
        "DISCONNECT_NO_WORKSPACES" to GithubCopy.DISCONNECT_NO_WORKSPACES, "CONNECT_LEAD" to GithubCopy.CONNECT_LEAD,
        "CONNECT" to GithubCopy.CONNECT, "INSTALLED_WHERE" to GithubCopy.INSTALLED_WHERE, "NO_ANSWER" to GithubCopy.NO_ANSWER,
        "CONFIGURE_ON_GITHUB" to GithubCopy.CONFIGURE_ON_GITHUB, "INSTALL_ON_GITHUB" to GithubCopy.INSTALL_ON_GITHUB,
        "INSTALL_ON_ANOTHER" to GithubCopy.INSTALL_ON_ANOTHER, "WORKSPACES_FROM_GITHUB" to GithubCopy.WORKSPACES_FROM_GITHUB,
        "CONNECTED_TOAST" to GithubCopy.CONNECTED_TOAST, "DISCONNECTED_TOAST" to GithubCopy.DISCONNECTED_TOAST,
        "DISCONNECT_FAILED" to GithubCopy.DISCONNECT_FAILED, "CONNECT_FAILED" to GithubCopy.CONNECT_FAILED,
    )

    @Test fun everyConstantIsSwiftsWordForWord() {
        for ((name, value) in constants) assertEquals("$name drifted from GithubCopy.swift", swiftConstants[name], value)
        assertEquals("list every Swift constant here", swiftConstants.keys, constants.map { it.first }.toSet())
    }

    @Test fun bothFilesDeclareTheSameNames() {
        val swiftNames = Regex("""public static (?:let|func) (\w+)""").findAll(swift).map { it.groupValues[1] }.toSet()
        val kotlinNames = Regex("""(?:const val|fun) (\w+)""").findAll(kotlin).map { it.groupValues[1] }.toSet()
        // Swift's `installationSettingsURL` answers a URL; here it is a string, named as the web names it.
        assertEquals(swiftNames - "installationSettingsURL", kotlinNames - "installationSettingsUrl")
    }

    @Test fun theTemplatesAreSwifts() {
        assertTrue(swift.contains(""""@\(login) needs to sign in again""""))
        assertEquals("@ada needs to sign in again", GithubCopy.needsSignInAgain("ada"))
        assertTrue(swift.contains(""""on \(machine)""""))
        assertEquals("on mac", GithubCopy.onMachine("mac"))
        assertTrue(swift.contains(""""Connected \(format.string(from: at)) · \(SEES_ONLY)""""))
        assertTrue(GithubCopy.connectedSince("2026-11-03T10:00:00Z").startsWith("Connected Nov 3 · "))
    }

    @Test fun theLibrarysSentencesAreTheWebs() {
        assertTrue(lib.contains("export const GITHUB_ROW_HINT = '${GithubCopy.GITHUB_ROW_HINT}';"))
        assertTrue(lib.contains("export const GITHUB_NOT_SET_UP = '${GithubCopy.GITHUB_NOT_SET_UP}';"))
        for (code in listOf("GITHUB_ACCOUNT_IN_USE", "GITHUB_DENIED", "GITHUB_FLOW_EXPIRED")) {
            assertTrue(code, lib.contains("case '$code':\n      return '${GithubCopy.errorText(code)}';"))
        }
        assertEquals(GithubCopy.GITHUB_NOT_SET_UP, GithubCopy.errorText("GITHUB_NOT_CONFIGURED"))
        assertTrue(lib.contains("return \"${GithubCopy.errorText("ANYTHING_ELSE")}\";"))
        assertTrue(lib.contains("'Organization' ? 'Organization' : 'Personal account'"))
        assertTrue(lib.contains("`All repositories (\${installation.repositoryCount})`"))
        assertTrue(lib.contains("'selected repository', 'selected repositories'"))
        assertTrue(lib.contains("`\${kind} · \${repositories}`"))
    }

    @Test fun installationTextAndLinks() {
        val mine = GithubInstallation(7, "ada", "User", "selected", 1)
        val org = GithubInstallation(9, "orbit-labs", "Organization", "all", 11)
        assertEquals("Personal account · 1 selected repository", GithubCopy.installationText(mine))
        assertEquals("Personal account · 3 selected repositories", GithubCopy.installationText(mine.copy(repositoryCount = 3)))
        assertEquals("Organization · All repositories (11)", GithubCopy.installationText(org))
        assertEquals("https://github.com/settings/installations/7", GithubCopy.installationSettingsUrl(mine))
        assertEquals("https://github.com/organizations/orbit-labs/settings/installations/9", GithubCopy.installationSettingsUrl(org))
    }

    @Test fun thePagesSentencesAreTheWebs() {
        val needles = listOf(
            ">${GithubCopy.ACCOUNT}</h2>", ">${GithubCopy.INSTALLED_WHERE}</h2>", ">${GithubCopy.WORKSPACES_FROM_GITHUB}</h2>",
            ">${GithubCopy.NO_ANSWER}</div>", ">${GithubCopy.CONNECT_LEAD}</div>", "${GithubCopy.CONFIGURE_ON_GITHUB} <ExportOutlined />",
            "'${GithubCopy.INSTALL_ON_GITHUB}' : '${GithubCopy.INSTALL_ON_ANOTHER}'",
            "<SettingsHeader title=\"${GithubCopy.TITLE}\" description={GITHUB_ROW_HINT} />",
            "title=\"${GithubCopy.LOAD_FAILED}\"", ">${GithubCopy.RETRY}</Button>",
            "'${GithubCopy.BADGE_SIGN_IN_AGAIN}' : '${GithubCopy.BADGE_CONNECTED}'",
            "`${GithubCopy.needsSignInAgain("\${view.login}")}`", "})} · ${GithubCopy.SEES_ONLY}`",
            "\n                  ${GithubCopy.RECONNECT}\n", "title=\"${GithubCopy.DISCONNECT_TITLE}\"",
            ": '${GithubCopy.DISCONNECT_NO_WORKSPACES}'", "confirmText=\"${GithubCopy.DISCONNECT}\"",
            "\n                  ${GithubCopy.CONNECT}\n", "<> on {workspace.machine}</>",
            "message.success('${GithubCopy.CONNECTED_TOAST}')", "message.success('${GithubCopy.DISCONNECTED_TOAST}')",
            "message.error(\"${GithubCopy.DISCONNECT_FAILED}\"", "message.error(\"${GithubCopy.CONNECT_FAILED}\"",
            "'1 workspace keeps its folder.' : `\${workspaceCount} workspaces keep their folders.`",
            "`\${lead} Clones and landings that need GitHub will stop until you connect again.`",
        )
        for (needle in needles) assertTrue("the web no longer says $needle", page.contains(needle))
        assertEquals("1 workspace keeps its folder. Clones and landings that need GitHub will stop until you connect again.",
            GithubCopy.disconnectWarning(1))
        assertEquals("3 workspaces keep their folders. Clones and landings that need GitHub will stop until you connect again.",
            GithubCopy.disconnectWarning(3))
        for ((credential, state) in listOf("github-app" to null, "machine" to null, null to "CLONING", null to "FAILED", null to null)) {
            val words = GithubCopy.credentialText(credential, state)
            assertTrue(words, page.contains("return '$words';"))
        }
        assertEquals("Cloning", GithubCopy.credentialText(null, "PENDING"))
    }

    @Test fun settingsNamesTheGroupAndRowAsTheWebsNav() {
        assertTrue(source("src/web/src/components/settings/SettingsLayout.tsx").contains("<NavGroup title=\"${GithubCopy.INTEGRATIONS}\">"))
        assertTrue(source("src/web/src/pages/settings/settingsIndex.ts")
            .contains("{ path: '/settings/integrations/github', label: '${GithubCopy.TITLE}' }"))
    }
}
