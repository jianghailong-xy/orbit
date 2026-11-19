import Foundation
import XCTest
@testable import OrbitKit

/// Settings → GitHub says what the web's page says. `GithubCopy` is a hand-copy of `src/web/src/lib/githubIntegration.ts`
/// and `src/web/src/pages/GithubIntegrationPage.tsx`; both are read as text here, and each sentence is looked for in the
/// spelling the web writes it in (a JSX text, a string literal, or a template with its values as interpolations). A
/// missing web file is a failure and never an `XCTSkip`.
final class GithubCopyParityTests: XCTestCase {
    private static let lib = "src/web/src/lib/githubIntegration.ts"
    private static let page = "src/web/src/pages/GithubIntegrationPage.tsx"

    private enum ParityError: Error { case noRepo }

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let file = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: file.path) { return try String(contentsOf: file, encoding: .utf8) }
            dir = dir.deletingLastPathComponent()
        }
        throw ParityError.noRepo
    }

    private func assertSays(_ text: String, _ needle: String, _ name: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(text.contains(needle), "\(name): the web no longer says \(needle)", file: file, line: line)
    }

    func testTheLibrarysSentencesAreTheWebs() throws {
        let lib = try source(Self.lib)
        assertSays(lib, "export const GITHUB_ROW_HINT = '\(GithubCopy.GITHUB_ROW_HINT)';", "GITHUB_ROW_HINT")
        assertSays(lib, "export const GITHUB_NOT_SET_UP = '\(GithubCopy.GITHUB_NOT_SET_UP)';", "GITHUB_NOT_SET_UP")
        for code in ["GITHUB_ACCOUNT_IN_USE", "GITHUB_DENIED", "GITHUB_FLOW_EXPIRED"] {
            assertSays(lib, "case '\(code)':\n      return '\(GithubCopy.errorText(code))';", code)
        }
        XCTAssertEqual(GithubCopy.errorText("GITHUB_NOT_CONFIGURED"), GithubCopy.GITHUB_NOT_SET_UP)
        assertSays(lib, "return \"\(GithubCopy.errorText("ANYTHING_ELSE"))\";", "githubErrorText default")
        assertSays(lib, "'Organization' ? 'Organization' : 'Personal account'", "installationText kind")
        assertSays(lib, "`All repositories (${installation.repositoryCount})`", "installationText all")
        assertSays(lib, "'selected repository', 'selected repositories'", "installationText selected")
        assertSays(lib, "`${kind} · ${repositories}`", "installationText")
    }

    func testInstallationTextAndLinks() {
        let mine = GithubInstallation(id: 7, account: "ada", type: "User", repositorySelection: "selected", repositoryCount: 1)
        let org = GithubInstallation(id: 9, account: "orbit-labs", type: "Organization", repositorySelection: "all",
                                     repositoryCount: 11)
        XCTAssertEqual(GithubCopy.installationText(mine), "Personal account · 1 selected repository")
        XCTAssertEqual(GithubCopy.installationText(org), "Organization · All repositories (11)")
        XCTAssertEqual(GithubCopy.installationSettingsURL(mine)?.absoluteString, "https://github.com/settings/installations/7")
        XCTAssertEqual(GithubCopy.installationSettingsURL(org)?.absoluteString,
                       "https://github.com/organizations/orbit-labs/settings/installations/9")
    }

    func testThePagesSentencesAreTheWebs() throws {
        let page = try source(Self.page)
        let jsxText: [(String, String)] = [
            ("ACCOUNT", ">\(GithubCopy.ACCOUNT)</h2>"),
            ("INSTALLED_WHERE", ">\(GithubCopy.INSTALLED_WHERE)</h2>"),
            ("WORKSPACES_FROM_GITHUB", ">\(GithubCopy.WORKSPACES_FROM_GITHUB)</h2>"),
            ("NO_ANSWER", ">\(GithubCopy.NO_ANSWER)</div>"),
            ("CONNECT_LEAD", ">\(GithubCopy.CONNECT_LEAD)</div>"),
            ("CONFIGURE_ON_GITHUB", "\(GithubCopy.CONFIGURE_ON_GITHUB) <ExportOutlined />"),
            ("INSTALL_ON_GITHUB", "'\(GithubCopy.INSTALL_ON_GITHUB)' : '\(GithubCopy.INSTALL_ON_ANOTHER)'"),
            ("TITLE", "<SettingsHeader title=\"\(GithubCopy.TITLE)\" description={GITHUB_ROW_HINT} />"),
            ("LOAD_FAILED", "title=\"\(GithubCopy.LOAD_FAILED)\""),
            ("RETRY", ">\(GithubCopy.RETRY)</Button>"),
            ("BADGE", "'\(GithubCopy.BADGE_SIGN_IN_AGAIN)' : '\(GithubCopy.BADGE_CONNECTED)'"),
            ("needsSignInAgain", "`\(GithubCopy.needsSignInAgain(login: "${view.login}"))`"),
            ("SEES_ONLY", "})} · \(GithubCopy.SEES_ONLY)`"),
            ("RECONNECT", "\n                  \(GithubCopy.RECONNECT)\n"),
            ("DISCONNECT_TITLE", "title=\"\(GithubCopy.DISCONNECT_TITLE)\""),
            ("DISCONNECT_NO_WORKSPACES", ": '\(GithubCopy.DISCONNECT_NO_WORKSPACES)'"),
            ("DISCONNECT", "confirmText=\"\(GithubCopy.DISCONNECT)\""),
            ("CONNECT", "\n                  \(GithubCopy.CONNECT)\n"),
            ("onMachine", "<> on {workspace.machine}</>"),
            ("CONNECTED_TOAST", "message.success('\(GithubCopy.CONNECTED_TOAST)')"),
            ("DISCONNECTED_TOAST", "message.success('\(GithubCopy.DISCONNECTED_TOAST)')"),
            ("DISCONNECT_FAILED", "message.error(\"\(GithubCopy.DISCONNECT_FAILED)\""),
            ("CONNECT_FAILED", "message.error(\"\(GithubCopy.CONNECT_FAILED)\""),
        ]
        for (name, needle) in jsxText { assertSays(page, needle, name) }
        XCTAssertEqual(GithubCopy.onMachine("mac"), "on mac")
        XCTAssertTrue(GithubCopy.connectedSince("2026-11-03T10:00:00Z").hasPrefix("Connected Nov 3 · "))
    }

    func testDisconnectAndCredentialWordsAreTheWebs() throws {
        let page = try source(Self.page)
        assertSays(page, "'1 workspace keeps its folder.' : `${workspaceCount} workspaces keep their folders.`", "disconnectWarning")
        assertSays(page, "`${lead} Clones and landings that need GitHub will stop until you connect again.`", "disconnectWarning")
        XCTAssertEqual(GithubCopy.disconnectWarning(workspaceCount: 1),
                       "1 workspace keeps its folder. Clones and landings that need GitHub will stop until you connect again.")
        XCTAssertEqual(GithubCopy.disconnectWarning(workspaceCount: 3),
                       "3 workspaces keep their folders. Clones and landings that need GitHub will stop until you connect again.")
        let credential: [(String?, String?)] = [("github-app", nil), ("machine", nil), (nil, "CLONING"), (nil, "FAILED"), (nil, nil)]
        for (c, state) in credential {
            assertSays(page, "return '\(GithubCopy.credentialText(credential: c, cloneState: state))';", "credentialText")
        }
        XCTAssertEqual(GithubCopy.credentialText(credential: nil, cloneState: "PENDING"), "Cloning")
    }

    func testSettingsNamesTheGroupAndRowAsTheWebsNav() throws {
        let nav = try source("src/web/src/components/settings/SettingsLayout.tsx")
        assertSays(nav, "<NavGroup title=\"\(GithubCopy.INTEGRATIONS)\">", "INTEGRATIONS")
        let index = try source("src/web/src/pages/settings/settingsIndex.ts")
        assertSays(index, "{ path: '/settings/integrations/github', label: '\(GithubCopy.TITLE)' }", "TITLE")
    }
}
