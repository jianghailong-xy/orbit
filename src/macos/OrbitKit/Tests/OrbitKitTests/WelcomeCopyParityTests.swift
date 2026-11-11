import Foundation
import XCTest
@testable import OrbitKit

/// The welcome card says what the web's says (docs/mocks/new-user-onboarding). `WelcomeCopy` is a
/// hand-copy of `src/web/src/lib/welcomeCopy.ts`, read here as text: every fixed sentence by name, every
/// sentence with a value in it rendered with the web's own interpolation, the three examples in order,
/// and both ends declaring the same names. A missing web file is a failure, never an `XCTSkip`.
final class WelcomeCopyParityTests: XCTestCase {

    private static let webCopy = "src/web/src/lib/welcomeCopy.ts"
    private static let webCard = "src/web/src/components/WelcomeCard.tsx"
    private static let swiftCopy = "src/macos/OrbitKit/Sources/OrbitKit/App/WelcomeCopy.swift"

    /// Words the web writes inline in its card rather than in welcomeCopy.ts; checked against the card.
    private static let thisClientsOwn: Set<String> = ["welcomeSignedIn"]

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

    private func captures(_ text: String, _ pattern: String) throws -> [[String]] {
        let re = try NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines])
        return re.matches(in: text, range: NSRange(text.startIndex..., in: text)).map { match in
            (1..<match.numberOfRanges).map { index in
                Range(match.range(at: index), in: text).map { String(text[$0]) } ?? ""
            }
        }
    }

    /// Every `export const NAME = '…'`, by name; a value may sit on the line under its `=`.
    private func webConstants() throws -> [String: String] {
        let flat = try source(Self.webCopy).replacingOccurrences(of: "=\\s*\\n\\s*(['\"])", with: "= $1",
                                                                 options: .regularExpression)
        let single = try captures(flat, "^export const ([A-Z0-9_]+) = '([^'\\n]*)';$")
        let double = try captures(flat, "^export const ([A-Z0-9_]+) = \"([^\"\\n]*)\";$")
        return Dictionary((single + double).map { ($0[0], $0[1]) }, uniquingKeysWith: { first, _ in first })
    }

    private static let constants: [(name: String, value: String)] = [
        ("WELCOME_LEAD", WelcomeCopy.WELCOME_LEAD),
        ("WELCOME_COMPUTER", WelcomeCopy.WELCOME_COMPUTER),
        ("WELCOME_COMPUTER_MANAGED", WelcomeCopy.WELCOME_COMPUTER_MANAGED),
        ("WELCOME_COMPUTER_OWN", WelcomeCopy.WELCOME_COMPUTER_OWN),
        ("WELCOME_OWN_INSTEAD", WelcomeCopy.WELCOME_OWN_INSTEAD),
        ("WELCOME_COMPUTER_DONE", WelcomeCopy.WELCOME_COMPUTER_DONE),
        ("WELCOME_WAITING_CONNECT", WelcomeCopy.WELCOME_WAITING_CONNECT),
        ("WELCOME_HAVING_TROUBLE", WelcomeCopy.WELCOME_HAVING_TROUBLE),
        ("WELCOME_MODEL", WelcomeCopy.WELCOME_MODEL),
        ("WELCOME_MODEL_HELP", WelcomeCopy.WELCOME_MODEL_HELP),
        ("WELCOME_MODEL_DONE", WelcomeCopy.WELCOME_MODEL_DONE),
        ("WELCOME_AFTER_COMPUTER", WelcomeCopy.WELCOME_AFTER_COMPUTER),
        ("WELCOME_AFTER_STEP_ONE", WelcomeCopy.WELCOME_AFTER_STEP_ONE),
        ("WELCOME_FIRST", WelcomeCopy.WELCOME_FIRST),
        ("WELCOME_FIRST_HELP", WelcomeCopy.WELCOME_FIRST_HELP),
        ("WELCOME_FOOT_WAIT", WelcomeCopy.WELCOME_FOOT_WAIT),
        ("WELCOME_FOOT_SEND_NOW", WelcomeCopy.WELCOME_FOOT_SEND_NOW),
        ("WELCOME_FOOT_READY", WelcomeCopy.WELCOME_FOOT_READY),
        ("WELCOME_PLACEHOLDER", WelcomeCopy.WELCOME_PLACEHOLDER),
    ]

    func testEveryConstantIsTheWebDeclarationOfTheSameName() throws {
        let web = try webConstants()
        for (name, value) in Self.constants {
            let declared = try XCTUnwrap(web[name], "welcomeCopy.ts declares no \(name)")
            XCTAssertEqual(value, declared, "\(name) drifted from welcomeCopy.ts")
        }
    }

    func testTheReadyLineIsTheWebTemplate() throws {
        let raw = try source(Self.webCopy)
        XCTAssertTrue(raw.contains("export const welcomeComputerReady = (machine: string) => `\(WelcomeCopy.welcomeComputerReady(machine: "${machine}"))`;"),
                      "welcomeComputerReady drifted from welcomeCopy.ts")
    }

    /// The title is a function on the web: its two outcomes, and the first word of the name.
    func testTheTitleGreetsByTheFirstWordAsTheWebDoes() throws {
        let raw = try source(Self.webCopy)
        XCTAssertTrue(raw.contains("return first ? `Welcome to Orbit, ${first}` : 'Welcome to Orbit';"), "welcomeTitle changed shape")
        XCTAssertTrue(raw.contains("(name ?? '').trim().split(/\\s+/)[0]"), "welcomeTitle takes another word")
        XCTAssertEqual(WelcomeCopy.welcomeTitle(name: "Mia Chen"), "Welcome to Orbit, Mia")
        XCTAssertEqual(WelcomeCopy.welcomeTitle(name: "  Mia\tChen "), "Welcome to Orbit, Mia")
        XCTAssertEqual(WelcomeCopy.welcomeTitle(name: ""), "Welcome to Orbit")
        XCTAssertEqual(WelcomeCopy.welcomeTitle(name: "   "), "Welcome to Orbit")
        XCTAssertEqual(WelcomeCopy.welcomeTitle(name: nil), "Welcome to Orbit")
    }

    func testTheExamplesAreTheWebsInItsOrder() throws {
        let raw = try source(Self.webCopy)
        let block = try XCTUnwrap(raw.range(of: "export const WELCOME_EXAMPLES = [").map { start in
            raw[start.upperBound...].prefix { $0 != "]" }
        })
        let web = try captures(String(block), "^\\s*'([^'\\n]*)',$").map { $0[0] }
        XCTAssertEqual(web, WelcomeCopy.WELCOME_EXAMPLES)
        XCTAssertEqual(web.count, 3)
    }

    /// The model step's done line is written inline in the web's card.
    func testTheSignedInLineIsTheWebCardsWords() throws {
        let card = try source(Self.webCard)
        XCTAssertTrue(card.contains("detail={`\(WelcomeCopy.welcomeSignedIn(engine: "${engineName}", machine: "${machine}"))`}"),
                      "the web card's signed-in line changed")
    }

    /// Every sentence at either end has its counterpart, or is named above as this client's own.
    func testBothEndsDeclareTheSameSentencesUnderTheSameNames() throws {
        let web = Set(try captures(try source(Self.webCopy), "^export const (\\w+)").map { $0[0] })
        // `WelcomeCopy` alone: the rules (`Welcome`) follow it in the same file.
        let swift = try source(Self.swiftCopy)
        let copy = String(swift[..<(try XCTUnwrap(swift.range(of: "public enum Welcome {"))).lowerBound])
        let here = Set(try captures(copy, "static (?:let|func) (\\w+)").map { $0[0] })
        XCTAssertEqual(here.subtracting(Self.thisClientsOwn), web)
        let listed = Set(Self.constants.map(\.name)).union(["welcomeComputerReady", "welcomeTitle", "WELCOME_EXAMPLES"])
        XCTAssertEqual(listed, web, "list every shared sentence above")
    }
}

/// The card's rules, the web's `WelcomeCard.tsx` and `WorkspaceView`'s wiring (board 03).
final class WelcomeTests: XCTestCase {
    /// Rule 1: both lists answered empty; anything else — a row, or a read that failed — is not new.
    func testANewAccountIsTwoEmptyLists() {
        XCTAssertTrue(Welcome.isNewAccount(openRows: 0, completedRows: 0))
        XCTAssertFalse(Welcome.isNewAccount(openRows: 1, completedRows: 0))
        XCTAssertFalse(Welcome.isNewAccount(openRows: 0, completedRows: 1))
        XCTAssertFalse(Welcome.isNewAccount(openRows: nil, completedRows: 0))
        XCTAssertFalse(Welcome.isNewAccount(openRows: 0, completedRows: nil))
        XCTAssertFalse(Welcome.isNewAccount(openRows: nil, completedRows: nil))
    }

    func testTheFootIsTheWebsThreeLines() {
        XCTAssertEqual(Welcome.foot(startsNow: false, up: false, signedIn: false), .wait)
        XCTAssertEqual(Welcome.foot(startsNow: false, up: true, signedIn: true), .wait)
        XCTAssertEqual(Welcome.foot(startsNow: true, up: false, signedIn: true), .sendNow)
        XCTAssertEqual(Welcome.foot(startsNow: true, up: true, signedIn: false), .sendNow)
        XCTAssertEqual(Welcome.foot(startsNow: true, up: true, signedIn: true), .ready)
        XCTAssertEqual(Welcome.Foot.wait.text, WelcomeCopy.WELCOME_FOOT_WAIT)
        XCTAssertEqual(Welcome.Foot.sendNow.text, WelcomeCopy.WELCOME_FOOT_SEND_NOW)
        XCTAssertEqual(Welcome.Foot.ready.text, WelcomeCopy.WELCOME_FOOT_READY)
    }

    /// Up is `available` or `modelUnavailable` (web `UP`), or the runner online.
    func testTheComputerIsUpByItsKindOrItsHeartbeat() {
        XCTAssertTrue(Welcome.computerUp(.available, runnerOnline: false))
        XCTAssertTrue(Welcome.computerUp(.modelUnavailable, runnerOnline: false))
        XCTAssertTrue(Welcome.computerUp(.preparing, runnerOnline: true))
        XCTAssertFalse(Welcome.computerUp(.preparing, runnerOnline: false))
        XCTAssertFalse(Welcome.computerUp(.failed, runnerOnline: false))
        XCTAssertFalse(Welcome.computerUp(nil, runnerOnline: false))
    }

    func testAnExampleIsPickedWhileTheComposerHoldsItUntouched() {
        let example = WelcomeCopy.WELCOME_EXAMPLES[0]
        XCTAssertTrue(Welcome.picked(example, example))
        XCTAssertTrue(Welcome.picked(" \(example)\n", example))
        XCTAssertFalse(Welcome.picked(example + " in Paris", example))
        XCTAssertFalse(Welcome.picked("", example))
    }

    /// The draft's engine when a first session can start and it signs in; the runner's first otherwise.
    func testTheEngineOfferedIsTheDraftsOrTheRunnersFirst() {
        XCTAssertEqual(Welcome.engine(draftEngine: "codex", startsNow: true, runner: nil), .codex)
        XCTAssertEqual(Welcome.engine(draftEngine: "codex", startsNow: false, runner: nil), .claude)
        XCTAssertEqual(Welcome.engine(draftEngine: "opencode", startsNow: true, runner: nil), .claude)
    }
}
