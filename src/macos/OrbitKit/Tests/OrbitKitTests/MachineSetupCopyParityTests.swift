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

    /// Sentences of pages these clients don't have: the web's approval page.
    private static let webOnly: Set<String> = ["ENROLL_NEXT_TITLE", "ENROLL_NEXT_BODY", "ENROLL_OPEN_MACHINE", "machineEmpty"]

    /// Sentences these clients say and the web doesn't, each checked on its own terms below.
    private static let thisClientsOwn: Set<String> = [
        "SETUP_USE_API_KEY", "SETUP_PAGE_TITLE", "machineEmptyHere", "RUNNER_WORKSPACES_TAP",
        "NO_WORKSPACES_YET", "NO_WORKSPACES_DETAIL",
    ]

    /// The words are the web's, in the title case board 03 draws its buttons in.
    private static let titleCased: Set<String> = ["SETUP_USE_FOLDER"]

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
        ("SETUP_LEAD", MachineSetupCopy.SETUP_LEAD),
        ("SETUP_OPEN_MACHINE", MachineSetupCopy.SETUP_OPEN_MACHINE),
        ("SETUP_FOLDER", MachineSetupCopy.SETUP_FOLDER),
        ("SETUP_REGISTER_DIR", MachineSetupCopy.SETUP_REGISTER_DIR),
        ("SETUP_NEW_FOLDER", MachineSetupCopy.SETUP_NEW_FOLDER),
        ("SETUP_NEW_FOLDER_NAME", MachineSetupCopy.SETUP_NEW_FOLDER_NAME),
        ("SETUP_NEW_FOLDER_META", MachineSetupCopy.SETUP_NEW_FOLDER_META),
        ("SETUP_NEW_FOLDER_DONE", MachineSetupCopy.SETUP_NEW_FOLDER_DONE),
        ("SETUP_NEW_FOLDER_INVALID", MachineSetupCopy.SETUP_NEW_FOLDER_INVALID),
        ("SETUP_USE_FOLDER", MachineSetupCopy.SETUP_USE_FOLDER),
        ("SETUP_CHANGE", MachineSetupCopy.SETUP_CHANGE),
        ("SETUP_FOUND_PREFIX", MachineSetupCopy.SETUP_FOUND_PREFIX),
        ("SETUP_NOT_GIT", MachineSetupCopy.SETUP_NOT_GIT),
        ("SETUP_CHECK_AGAIN", MachineSetupCopy.SETUP_CHECK_AGAIN),
        ("SETUP_SIGN_IN_HELP", MachineSetupCopy.SETUP_SIGN_IN_HELP),
        ("SETUP_ON_A_KEY", MachineSetupCopy.SETUP_ON_A_KEY),
        ("SETUP_ON_A_POOL", MachineSetupCopy.SETUP_ON_A_POOL),
        ("SETUP_FOOT", MachineSetupCopy.SETUP_FOOT),
        ("HELD_WITHDRAW", MachineSetupCopy.HELD_WITHDRAW),
        ("HELD_SENDING", MachineSetupCopy.HELD_SENDING),
        ("HELD_TRY_AGAIN", MachineSetupCopy.HELD_TRY_AGAIN),
        ("HELD_ALREADY_WAITING", MachineSetupCopy.HELD_ALREADY_WAITING),
        ("HELD_ALREADY_WAITING_DETAIL", MachineSetupCopy.HELD_ALREADY_WAITING_DETAIL),
        ("CREATED_WORKSPACE", MachineSetupCopy.CREATED_WORKSPACE),
        ("CREATED_ON", MachineSetupCopy.CREATED_ON),
        ("CREATED_RENAME", MachineSetupCopy.CREATED_RENAME),
        ("CREATED_SETTINGS", MachineSetupCopy.CREATED_SETTINGS),
        ("CREATED_RENAME_LABEL", MachineSetupCopy.CREATED_RENAME_LABEL),
        ("CREATED_RENAME_FAILED", MachineSetupCopy.CREATED_RENAME_FAILED),
        ("START_A_SESSION", MachineSetupCopy.START_A_SESSION),
        ("REGISTER_NEXT", MachineSetupCopy.REGISTER_NEXT),
    ]

    /// Each template rendered with the web's own interpolations for its values.
    private static let templates: [(name: String, rendered: String)] = [
        ("setupTitle", MachineSetupCopy.setupTitle(machine: "${machine}")),
        ("setupOffline", MachineSetupCopy.setupOffline(machine: "${machine}")),
        ("setupUpdating", MachineSetupCopy.setupUpdating(machine: "${machine}")),
        ("setupNeedsUpdate", MachineSetupCopy.setupNeedsUpdate(machine: "${machine}")),
        ("setupFolderHelp", MachineSetupCopy.setupFolderHelp(machine: "${machine}")),
        ("setupOtherFolder", MachineSetupCopy.setupOtherFolder(machine: "${machine}")),
        ("setupChecking", MachineSetupCopy.setupChecking(machine: "${machine}")),
        ("setupNoSuchDirectory", MachineSetupCopy.setupNoSuchDirectory(machine: "${machine}")),
        ("setupNotADirectory", MachineSetupCopy.setupNotADirectory(machine: "${machine}")),
        ("setupNoAnswer", MachineSetupCopy.setupNoAnswer(machine: "${machine}")),
        ("setupCouldNotCheck", MachineSetupCopy.setupCouldNotCheck(machine: "${machine}", why: "${why}")),
        ("setupSignIn", MachineSetupCopy.setupSignIn(engine: "${engine}", machine: "${machine}")),
        ("setupSignedIn", MachineSetupCopy.setupSignedIn(machine: "${machine}")),
        ("setupUseEngine", MachineSetupCopy.setupUseEngine(engine: "${engine}")),
        ("setupNotInstalled", MachineSetupCopy.setupNotInstalled(engine: "${engine}", machine: "${machine}")),
        ("setupReady", MachineSetupCopy.setupReady(workspace: "${workspace}", path: "${path}")),
        ("composerPlaceholderFor", MachineSetupCopy.composerPlaceholderFor(machine: "${machine}")),
        ("heldWaiting", MachineSetupCopy.heldWaiting(machine: "${machine}")),
        ("heldFailed", MachineSetupCopy.heldFailed(why: "${why}")),
    ]

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
        XCTAssertTrue(board.contains(">\(MachineSetupCopy.SETUP_USE_FOLDER)<"))
        XCTAssertTrue(board.contains("<b>\(MachineSetupCopy.SETUP_PAGE_TITLE)</b>"))
    }

    /// What is left of the old footer, with "on the web" gone: its first sentence.
    func testTheWorkspacesFooterIsTheOldOnesFirstSentence() {
        XCTAssertTrue(RunnerPageCopy.RUNNER_WORKSPACES_FOOTER.hasPrefix(MachineSetupCopy.RUNNER_WORKSPACES_TAP + " "))
        XCTAssertFalse(MachineSetupCopy.RUNNER_WORKSPACES_TAP.contains("web"))
    }

    /// Every sentence at either end has its counterpart, or is named above as one client's own.
    func testBothEndsDeclareTheSameSentencesUnderTheSameNames() throws {
        let raw = try source(Self.webCopy)
        let web = Set(try webConstants().keys).union(try webTemplates().keys).union(["setupGit", "machineEmpty"])
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
        let listed = Set(Self.constants.map(\.name)).union(Self.templates.map(\.name)).union(["setupGit"])
        XCTAssertEqual(listed, here.subtracting(Self.thisClientsOwn), "list every shared sentence above")
    }
}
