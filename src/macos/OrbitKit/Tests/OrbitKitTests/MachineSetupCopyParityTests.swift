import Foundation
import XCTest
@testable import OrbitKit

/// The setup card says what the web's card says, and this is the tripwire that keeps it saying it.
///
/// `MachineSetupCopy` is a hand-copy of `src/web/src/lib/machineSetupCopy.ts`. That file is read as
/// text: one `export const NAME = '…';` per fixed sentence, one `export const name = (…) => `…`;` per
/// sentence with values in it. Every Swift sentence is compared whole, with its values put back as the
/// web's interpolations; a sentence at one end and not the other fails here too, unless it is named
/// below as belonging to one client. A missing web file is a failure and never an `XCTSkip`.
final class MachineSetupCopyParityTests: XCTestCase {

    private static let webCopy = "src/web/src/lib/machineSetupCopy.ts"
    private static let swiftCopy = "src/macos/OrbitKit/Sources/OrbitKit/App/MachineSetupCopy.swift"

    /// Sentences of pages these clients don't have: the web's approval page, and its register guide's Settings
    /// variant (these clients register from the machine's own card, which says `REGISTER_NEXT`).
    private static let webOnly: Set<String> = ["ENROLL_NEXT_TITLE", "ENROLL_NEXT_BODY", "ENROLL_OPEN_MACHINE",
                                               "REGISTER_NEXT_IN_SETTINGS", "machineEmpty"]

    /// Sentences these clients say and the web doesn't, each checked on its own terms below.
    private static let thisClientsOwn: Set<String> = [
        "SETUP_USE_API_KEY", "SETUP_PAGE_TITLE", "machineEmptyHere", "RUNNER_WORKSPACES_TAP",
        "NO_WORKSPACES_YET", "NO_WORKSPACES_DETAIL",
    ]

    /// The words are the web's, in the title case board 03 draws its buttons in.
    private static let titleCased: Set<String> = []

    private enum ParityError: Error { case noRepo }

    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.webCopy).path) { return dir }
            dir = dir.deletingLastPathComponent()
        }
        throw ParityError.noRepo
    }

    private func source(_ relative: String) throws -> String {
        try String(contentsOf: try repoRoot().appendingPathComponent(relative), encoding: .utf8)
    }

    /// Every match of `pattern` in `text`, as its capture groups.
    private func captures(_ text: String, _ pattern: String) throws -> [[String]] {
        let re = try NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines])
        return re.matches(in: text, range: NSRange(text.startIndex..., in: text)).map { match in
            (1..<match.numberOfRanges).map { index in
                Range(match.range(at: index), in: text).map { String(text[$0]) } ?? ""
            }
        }
    }

    /// Every `export const NAME = '…'` or `"…"`, by name. A sentence with an apostrophe in it is written
    /// in double quotes, and a value may sit on the line under its `=`.
    private func webConstants() throws -> [String: String] {
        let flat = try source(Self.webCopy).replacingOccurrences(of: "=\\s*\\n\\s*(['\"])", with: "= $1",
                                                                 options: .regularExpression)
        let single = try captures(flat, "^export const ([A-Z0-9_]+) = '([^'\\n]*)';$")
        let double = try captures(flat, "^export const ([A-Z0-9_]+) = \"([^\"\\n]*)\";$")
        return Dictionary((single + double).map { ($0[0], $0[1]) }, uniquingKeysWith: { first, _ in first })
    }

    /// Every `export const name = (…) => `…`;`, by name: the whole template.
    private func webTemplates() throws -> [String: String] {
        let found = try captures(try source(Self.webCopy),
                                 "^export const ([a-z]\\w*) = \\([^)]*\\)(?:: \\w+)? =>\\s*`([^`]*)`;$")
        return Dictionary(found.map { ($0[0], $0[1]) }, uniquingKeysWith: { first, _ in first })
    }

    private static let constants: [(name: String, value: String)] = [
        ("SETUP_OPEN_MACHINE", MachineSetupCopy.SETUP_OPEN_MACHINE),
        ("SETUP_FOLDER", MachineSetupCopy.SETUP_FOLDER),
        ("SETUP_NEW_FOLDER_NAME", MachineSetupCopy.SETUP_NEW_FOLDER_NAME),
        ("SETUP_FOLDER_HINT", MachineSetupCopy.SETUP_FOLDER_HINT),
        ("SETUP_NEW_FOLDER_META", MachineSetupCopy.SETUP_NEW_FOLDER_META),
        ("SETUP_NEW_FOLDER_DONE", MachineSetupCopy.SETUP_NEW_FOLDER_DONE),
        ("SETUP_NEW_FOLDER_INVALID", MachineSetupCopy.SETUP_NEW_FOLDER_INVALID),
        ("SETUP_CHANGE", MachineSetupCopy.SETUP_CHANGE),
        ("SETUP_FOUND_PREFIX", MachineSetupCopy.SETUP_FOUND_PREFIX),
        ("SETUP_NOT_GIT", MachineSetupCopy.SETUP_NOT_GIT),
        ("SETUP_CHECK_AGAIN", MachineSetupCopy.SETUP_CHECK_AGAIN),
        ("SETUP_ON_A_KEY", MachineSetupCopy.SETUP_ON_A_KEY),
        ("SETUP_ON_A_POOL", MachineSetupCopy.SETUP_ON_A_POOL),
        ("SETUP_NEW_FOLDER_WITH_WORKSPACE", MachineSetupCopy.SETUP_NEW_FOLDER_WITH_WORKSPACE),
        ("SETUP_NAME", MachineSetupCopy.SETUP_NAME),
        ("SETUP_NAME_PLACEHOLDER", MachineSetupCopy.SETUP_NAME_PLACEHOLDER),
        ("SETUP_NAME_HINT", MachineSetupCopy.SETUP_NAME_HINT),
        ("SETUP_NAME_EDITED", MachineSetupCopy.SETUP_NAME_EDITED),
        ("SETUP_NAME_EMPTY", MachineSetupCopy.SETUP_NAME_EMPTY),
        ("SETUP_CREATE", MachineSetupCopy.SETUP_CREATE),
        ("CREATED_WORKSPACE", MachineSetupCopy.CREATED_WORKSPACE),
        ("CREATED_ON", MachineSetupCopy.CREATED_ON),
        ("CREATED_RENAME", MachineSetupCopy.CREATED_RENAME),
        ("CREATED_SETTINGS", MachineSetupCopy.CREATED_SETTINGS),
        ("CREATED_RENAME_LABEL", MachineSetupCopy.CREATED_RENAME_LABEL),
        ("CREATED_RENAME_FAILED", MachineSetupCopy.CREATED_RENAME_FAILED),
        ("START_A_SESSION", MachineSetupCopy.START_A_SESSION),
        ("REGISTER_NEXT", MachineSetupCopy.REGISTER_NEXT),
        ("SETUP_FROM_GITHUB", MachineSetupCopy.SETUP_FROM_GITHUB),
        ("SETUP_NEW_TAG", MachineSetupCopy.SETUP_NEW_TAG),
        ("SETUP_GITHUB_META", MachineSetupCopy.SETUP_GITHUB_META),
        ("SETUP_OR", MachineSetupCopy.SETUP_OR),
        ("SETUP_FOLDER_NAME_INSTEAD", MachineSetupCopy.SETUP_FOLDER_NAME_INSTEAD),
        ("SETUP_CONNECT_GITHUB", MachineSetupCopy.SETUP_CONNECT_GITHUB),
        ("SETUP_CONNECT_GITHUB_META", MachineSetupCopy.SETUP_CONNECT_GITHUB_META),
        ("SETUP_RECONNECT_GITHUB", MachineSetupCopy.SETUP_RECONNECT_GITHUB),
        ("SETUP_GITHUB_SEARCH", MachineSetupCopy.SETUP_GITHUB_SEARCH),
        ("SETUP_GITHUB_NOT_LISTED", MachineSetupCopy.SETUP_GITHUB_NOT_LISTED),
        ("SETUP_GITHUB_ADD_REPOSITORIES", MachineSetupCopy.SETUP_GITHUB_ADD_REPOSITORIES),
        ("SETUP_GITHUB_LOADING", MachineSetupCopy.SETUP_GITHUB_LOADING),
        ("SETUP_GITHUB_NONE", MachineSetupCopy.SETUP_GITHUB_NONE),
        ("SETUP_GITHUB_PRIVATE", MachineSetupCopy.SETUP_GITHUB_PRIVATE),
        ("SETUP_GITHUB_CLONED_META", MachineSetupCopy.SETUP_GITHUB_CLONED_META),
        ("SETUP_OTHER_BRANCH", MachineSetupCopy.SETUP_OTHER_BRANCH),
        ("SETUP_DEFAULT_BRANCH", MachineSetupCopy.SETUP_DEFAULT_BRANCH),
        ("SETUP_BRANCH", MachineSetupCopy.SETUP_BRANCH),
        ("SETUP_GITHUB_DONE", MachineSetupCopy.SETUP_GITHUB_DONE),
        ("CLONE_CLONING", MachineSetupCopy.CLONE_CLONING),
        ("CLONE_WAITING", MachineSetupCopy.CLONE_WAITING),
        ("CLONE_INSTALL_ON_GITHUB", MachineSetupCopy.CLONE_INSTALL_ON_GITHUB),
        ("CLONE_SIGN_IN_EXPIRED", MachineSetupCopy.CLONE_SIGN_IN_EXPIRED),
        ("CLONE_RECONNECT", MachineSetupCopy.CLONE_RECONNECT),
        ("CLONE_RETRY", MachineSetupCopy.CLONE_RETRY),
        ("CLONE_RETRY_FAILED", MachineSetupCopy.CLONE_RETRY_FAILED),
        ("CLONE_STARTS_WHEN_DONE", MachineSetupCopy.CLONE_STARTS_WHEN_DONE),
    ]

    /// Each template rendered with the web's own interpolations for its values.
    private static let templates: [(name: String, rendered: String)] = [
        ("setupTitle", MachineSetupCopy.setupTitle(machine: "${machine}")),
        ("setupNeedsUpdate", MachineSetupCopy.setupNeedsUpdate(machine: "${machine}")),
        ("setupNewFolderIsFile", MachineSetupCopy.setupNewFolderIsFile(machine: "${machine}")),
        ("setupChecking", MachineSetupCopy.setupChecking(machine: "${machine}")),
        ("setupNoSuchDirectory", MachineSetupCopy.setupNoSuchDirectory(machine: "${machine}")),
        ("setupNotADirectory", MachineSetupCopy.setupNotADirectory(machine: "${machine}")),
        ("setupNoAnswer", MachineSetupCopy.setupNoAnswer(machine: "${machine}")),
        ("setupCouldNotCheck", MachineSetupCopy.setupCouldNotCheck(machine: "${machine}", why: "${why}")),
        ("setupNewWorkspaceTitle", MachineSetupCopy.setupNewWorkspaceTitle(machine: "${machine}")),
        ("setupNewWorkspaceLead", MachineSetupCopy.setupNewWorkspaceLead(machine: "${machine}")),
        ("setupOfflineCreate", MachineSetupCopy.setupOfflineCreate(machine: "${machine}")),
        ("setupConnectingCreate", MachineSetupCopy.setupConnectingCreate(machine: "${machine}")),
        ("setupUpdatingCreate", MachineSetupCopy.setupUpdatingCreate(machine: "${machine}")),
        ("setupCreateFailed", MachineSetupCopy.setupCreateFailed(why: "${why}")),
        ("setupFolderOrPathHint", MachineSetupCopy.setupFolderOrPathHint(root: "${root}")),
        ("setupPathUnchecked", MachineSetupCopy.setupPathUnchecked(machine: "${machine}")),
        ("composerPlaceholderFor", MachineSetupCopy.composerPlaceholderFor(machine: "${machine}")),
        ("heldWaiting", MachineSetupCopy.heldWaiting(machine: "${machine}")),
        ("setupGithubSignInAgain", MachineSetupCopy.setupGithubSignInAgain(login: "${login}")),
        ("setupGithubConnectFailed", MachineSetupCopy.setupGithubConnectFailed(why: "${why}")),
        ("setupGithubListFailed", MachineSetupCopy.setupGithubListFailed(why: "${why}")),
        ("setupGithubFolderExists", MachineSetupCopy.setupGithubFolderExists(machine: "${machine}")),
        ("setupGithubDonePath", MachineSetupCopy.setupGithubDonePath(repository: "${repository}", path: "${path}")),
        ("setupCloneUpdating", MachineSetupCopy.setupCloneUpdating(machine: "${machine}")),
        ("setupCloneNeedsUpdate", MachineSetupCopy.setupCloneNeedsUpdate(machine: "${machine}")),
        ("cloneAppRemoved", MachineSetupCopy.cloneAppRemoved(repository: "${repository}")),
    ]

    /// The web's templates with a condition in them, read as what they render, each named here.
    private static let conditional: Set<String> = ["setupGit", "setupGithubAccount", "cloneCouldNot", "pushedAgo"]

    func testEveryConstantIsTheWebDeclarationOfTheSameName() throws {
        let web = try webConstants()
        for (name, value) in Self.constants {
            let declared = try XCTUnwrap(web[name], "machineSetupCopy.ts declares no \(name)")
            if Self.titleCased.contains(name) {
                XCTAssertEqual(value.lowercased(), declared.lowercased(), "\(name) drifted")
                XCTAssertNotEqual(value, declared, "\(name) is the web's as it stands: take it off `titleCased`")
            } else {
                XCTAssertEqual(value, declared, "\(name) drifted from machineSetupCopy.ts")
            }
        }
    }

    func testEveryTemplateIsTheWebTemplateWordForWord() throws {
        let web = try webTemplates()
        for (name, rendered) in Self.templates {
            XCTAssertEqual(web[name], rendered, "\(name) drifted from machineSetupCopy.ts")
        }
    }

    /// `setupGit` is the web's one template with a condition in it, so it is read as what it renders.
    func testTheBranchIsTheWebsToo() throws {
        let raw = try source(Self.webCopy)
        XCTAssertTrue(raw.contains("`git repository${branch ? ` · ${branch}` : ''}`"), "setupGit changed shape on the web")
        XCTAssertEqual(MachineSetupCopy.setupGit(branch: "main"), "git repository · main")
        XCTAssertEqual(MachineSetupCopy.setupGit(branch: nil), "git repository")
    }

    /// The account line leaves the count out when GitHub wasn't asked, and says one repository in the singular.
    func testTheGithubAccountLineIsTheWebs() throws {
        let raw = try source(Self.webCopy)
        XCTAssertTrue(raw.contains("? `Signed in to GitHub as @${login}`"), "setupGithubAccount changed shape on the web")
        XCTAssertTrue(raw.contains(": `Signed in to GitHub as @${login} · ${repositories} ${repositories === 1 ? 'repository' : 'repositories'}`"))
        XCTAssertEqual(MachineSetupCopy.setupGithubAccount(login: "ada", repositories: nil), "Signed in to GitHub as @ada")
        XCTAssertEqual(MachineSetupCopy.setupGithubAccount(login: "ada", repositories: 1), "Signed in to GitHub as @ada · 1 repository")
        XCTAssertEqual(MachineSetupCopy.setupGithubAccount(login: "ada", repositories: 12),
                       "Signed in to GitHub as @ada · 12 repositories")
    }

    /// A failed clone whose reason hasn't been read yet ends at the repository, with no colon left hanging.
    func testCouldNotCloneIsTheWebsWithAndWithoutAReason() throws {
        let raw = try source(Self.webCopy)
        XCTAssertTrue(raw.contains("why ? `Couldn’t clone ${repository}: ${why}` : `Couldn’t clone ${repository}.`"))
        XCTAssertEqual(MachineSetupCopy.cloneCouldNot(repository: "o/r", why: "git said no."), "Couldn’t clone o/r: git said no.")
        XCTAssertEqual(MachineSetupCopy.cloneCouldNot(repository: "o/r", why: ""), "Couldn’t clone o/r.")
    }

    /// When a repository was pushed, in the web's words at each step.
    func testPushedAgoIsTheWebsAtEachStep() throws {
        let raw = try source(Self.webCopy)
        for words in ["'pushed just now'", "`pushed ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`",
                      "`pushed ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`", "'pushed yesterday'"] {
            XCTAssertTrue(raw.contains(words), "pushedAgo no longer says \(words) on the web")
        }
        let now = try XCTUnwrap(RelativeTime.parse("2026-11-16T12:00:00Z"))
        func ago(_ seconds: TimeInterval) -> String {
            MachineSetupCopy.pushedAgo(ISO8601DateFormatter().string(from: now.addingTimeInterval(-seconds)), now: now)
        }
        XCTAssertEqual(MachineSetupCopy.pushedAgo(nil, now: now), "")
        XCTAssertEqual(ago(20), "pushed just now")
        XCTAssertEqual(ago(60), "pushed 1 minute ago")
        XCTAssertEqual(ago(59 * 60), "pushed 59 minutes ago")
        XCTAssertEqual(ago(3600), "pushed 1 hour ago")
        XCTAssertEqual(ago(30 * 3600), "pushed yesterday")
        XCTAssertTrue(ago(30 * 86_400).hasPrefix("pushed Oct "))
    }

    /// The web's sentence for an empty machine ends on the form its page has and these don't: everything
    /// before that is this client's sentence, word for word.
    func testAnEmptyMachineSaysTheWebsSentenceUpToItsForm() throws {
        let raw = try source(Self.webCopy)
        let marker = " — or add one here."
        XCTAssertTrue(raw.contains("`No workspaces on ${machine} yet. Start a session and pick the folder it works in as you go\(marker)`"))
        let here = MachineSetupCopy.machineEmptyHere(machine: "${machine}")
        XCTAssertTrue(raw.contains(String(here.dropLast()) + marker), "machineEmptyHere drifted from machineEmpty")
    }

    /// Rule 5's words, and board 03's: the same button the web calls "Use an API key instead".
    func testTheApiKeyButtonIsBoardThreesWords() throws {
        XCTAssertEqual(MachineSetupCopy.SETUP_USE_API_KEY, "Use an API Key")
        let board = try source("docs/mocks/first-workspace-in-conversation/03-iphone.html")
        XCTAssertTrue(board.contains(">\(MachineSetupCopy.SETUP_USE_API_KEY)<"))
        XCTAssertTrue(board.contains("<b>\(MachineSetupCopy.SETUP_PAGE_TITLE)</b>"))
    }

    /// A machine's page sends nobody to the web any more.
    func testTheWorkspacesFooterSaysNothingOfTheWeb() {
        XCTAssertEqual(MachineSetupCopy.RUNNER_WORKSPACES_TAP, "Tap a workspace to open its sessions.")
    }

    /// Every sentence at either end has its counterpart, or is named above as one client's own.
    func testBothEndsDeclareTheSameSentencesUnderTheSameNames() throws {
        let raw = try source(Self.webCopy)
        let web = Set(try webConstants().keys).union(try webTemplates().keys).union(Self.conditional).union(["machineEmpty"])
        XCTAssertEqual(web, Set(try captures(raw, "^export const (\\w+)").map { $0[0] }),
                       "machineSetupCopy.ts declares a sentence this check can't read")

        let swift = try source(Self.swiftCopy)
        let here = Set(try captures(swift, "static (?:let|func) (\\w+)").map { $0[0] })
        for name in web.subtracting(Self.webOnly).subtracting(here).sorted() {
            XCTFail("machineSetupCopy.ts declares \(name), which MachineSetupCopy does not")
        }
        for name in here.subtracting(web).subtracting(Self.thisClientsOwn).sorted() {
            XCTFail("MachineSetupCopy declares \(name), which machineSetupCopy.ts does not")
        }
        let listed = Set(Self.constants.map(\.name)).union(Self.templates.map(\.name)).union(Self.conditional)
        XCTAssertEqual(listed, here.subtracting(Self.thisClientsOwn), "list every shared sentence above")
    }
}
