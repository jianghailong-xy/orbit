import Foundation
import XCTest
@testable import OrbitKit

/// The two clients read one `sessionMessage` payload the same way and say the same words about it,
/// and this is the tripwire that keeps them doing it.
///
/// `SessionMessage.swift` is a hand-copy of the browser's reading of the payload and of the card's
/// words (`lib/sessionMessage.ts`). The Swift client and the browser bundle share no compiler, so a
/// sentence reworded at one end would simply never appear at the other.
///
/// Shaped after `TaskStartCopyParityTests`, including the part that matters most: a missing
/// counterpart is a FAILURE and never an `XCTSkip`.
final class SessionMessageCopyParityTests: XCTestCase {

    private static let webLib = "src/web/src/lib/sessionMessage.ts"
    private static let webCard = "src/web/src/components/SessionMessageCard.tsx"
    private static let shared = "src/shared/src/session-message.ts"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case missing(String)
        case notDeclared(what: String, file: String)

        var description: String {
            switch self {
            case .noRepo:
                return "\(SessionMessageCopyParityTests.webLib) was not found above this test file. "
                    + "OrbitKit's session-message card is one half of a pair; if the web half moved, "
                    + "move this check with it rather than deleting it."
            case .missing(let path):
                return "\(path) was not found. Either it moved — then point this check at its new "
                    + "home — or it is gone, and this client is now mirroring something that no "
                    + "longer exists."
            case .notDeclared(let what, let file):
                return "\(what) was not found in \(file). Either it was renamed — then rename it here "
                    + "too, which is what this check is for — or it is gone."
            }
        }
    }

    /// The repo root, found by walking up from this file until the web's reader is under foot.
    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.webLib).path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        // Deliberately a failure and not an `XCTSkip`, for the reason in the type's note above.
        throw ParityError.noRepo
    }

    /// A web source with its string literals put back together — where TypeScript wraps a sentence
    /// is a formatting decision, the words are the contract.
    private func flat(_ relative: String) throws -> String {
        let url = try repoRoot().appendingPathComponent(relative)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw ParityError.missing(relative)
        }
        return try String(contentsOf: url, encoding: .utf8)
            .replacingOccurrences(of: "['\"`]\\s*\\+\\s*['\"`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "=\\s*\\n\\s*(['\"`])", with: "= $1", options: .regularExpression)
    }

    private func captures(_ source: String, _ pattern: String) throws -> [String] {
        let re = try NSRegularExpression(pattern: pattern)
        return re.matches(in: source, range: NSRange(source.startIndex..., in: source)).compactMap {
            guard $0.numberOfRanges > 1, let range = Range($0.range(at: 1), in: source) else { return nil }
            return String(source[range])
        }
    }

    private func section(_ source: String, from: String, to: String, _ file: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw ParityError.notDeclared(what: "\(from) … \(to)", file: file)
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    /// A named constant, anchored on its declaration — not on the sentence, which a comment alone
    /// could satisfy.
    private func assertDeclares(_ source: String, _ name: String, _ value: String, line: UInt = #line) {
        let quoted = "'\(value.replacingOccurrences(of: "'", with: "\\'"))'"
        XCTAssertTrue(source.contains("\(name) = \(quoted)"),
                      "\(name) drifted: \(Self.webLib) no longer declares it as \(quoted)",
                      file: #filePath, line: line)
    }

    // MARK: the payload

    func testEveryFieldOfTheCardIsCalledWhatSharedCallsIt() throws {
        let shared = try flat(Self.shared)
        let body = try section(shared, from: "export interface SessionMessageCard {", to: "\n}", Self.shared)
        let theirs = try captures(body, "(?m)^  (\\w+)\\??:")
        let mine = Mirror(reflecting: SessionMessage(fromSessionId: "s")).children.compactMap(\.label)

        XCTAssertFalse(theirs.isEmpty, "no field of the interface was captured — the check is asleep")
        XCTAssertEqual(mine, theirs, "SessionMessageCard's fields drifted — first is this client's (in "
                           + "declaration order), second is the interface in \(Self.shared).")
    }

    func testTheReaderRequiresTheSameOneKey() throws {
        let web = try flat(Self.webLib)
        XCTAssertTrue(web.contains("typeof card.fromSessionId !== 'string' || card.fromSessionId === ''"))
        XCTAssertTrue(web.contains("typeof card.fromTaskId === 'string' && card.fromTaskId !== ''"),
                      "an empty task is no task at both ends")
        XCTAssertNil(SessionMessage.parse(.object(["sessionMessage": .object(["fromTitle": .string("x")])])))
        XCTAssertNotNil(SessionMessage.parse(.object(["sessionMessage": .object(["fromSessionId": .string("s")])])))
    }

    // MARK: the words

    func testTheCardsWordsAreTheWebsWords() throws {
        let web = try flat(Self.webLib)
        assertDeclares(web, "SESSION_MESSAGE_FROM", SessionMessageCard.from)
        assertDeclares(web, "SESSION_MESSAGE_UNTITLED", SessionMessageCard.untitled)
        assertDeclares(web, "SESSION_MESSAGE_NOT_YOU", SessionMessageCard.notYou)
        assertDeclares(web, "SESSION_MESSAGE_OPEN_TASK", SessionMessageCard.openTask)
        assertDeclares(web, "SESSION_MESSAGE_UNDELIVERED", SessionMessageCard.undelivered)
        // The sticky bar's label is the same composition at both ends: the word, a space, the title.
        XCTAssertTrue(web.contains("label: `${SESSION_MESSAGE_FROM} ${sessionMessageTitle(card)}`"),
                      "the sticky label drifted: \(Self.webLib) names the turn differently")
        XCTAssertEqual(SessionMessageCard.sticky(SessionMessage(fromSessionId: "s", fromTitle: "Worker"),
                                                 text: "hi").label, "From Worker")
    }

    /// The card puts the time and the task in the foot line the same way at both ends.
    func testTheFootLineIsBuiltTheSameWay() throws {
        let card = try flat(Self.webCard)
        XCTAssertTrue(card.contains("{SESSION_MESSAGE_NOT_YOU}"), "the foot line no longer opens with who this is not")
        XCTAssertTrue(card.contains("{ts ? ` · ${relTime(ts)}` : ''}"), "the foot line's time drifted")
        XCTAssertTrue(SessionMessageCard.meta(ts: "2026-10-01T15:40:00.000Z",
                                              now: Date(timeIntervalSince1970: 1_790_000_000))
            .hasPrefix("\(SessionMessageCard.notYou) · "))
    }
}
