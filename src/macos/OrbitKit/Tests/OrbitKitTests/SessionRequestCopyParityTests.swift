import Foundation
import XCTest
@testable import OrbitKit

/// The two clients read the request payloads the same way and say the same words about them — the
/// tripwire for `SessionRequest.swift`, which is a hand-copy of the browser's `lib/sessionRequest.ts`
/// and of the shared `SessionReplyCard` interface. The Swift client and the browser bundle share no
/// compiler, so a sentence reworded or a field added at one end would never appear at the other.
///
/// Shaped after `SessionMessageCopyParityTests`, including the part that matters most: a missing
/// counterpart is a FAILURE and never an `XCTSkip`.
final class SessionRequestCopyParityTests: XCTestCase {

    private static let webLib = "src/web/src/lib/sessionRequest.ts"
    private static let shared = "src/shared/src/session-request.ts"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case missing(String)
        var description: String {
            switch self {
            case .noRepo:
                return "\(SessionRequestCopyParityTests.webLib) was not found above this test file. If the "
                    + "web half moved, move this check with it rather than deleting it."
            case .missing(let what):
                return "\(what) was not found: either it moved — point this check at its new home — or "
                    + "it is gone, and this client mirrors something that no longer exists."
            }
        }
    }

    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.webLib).path) { return dir }
            dir = dir.deletingLastPathComponent()
        }
        throw ParityError.noRepo
    }

    /// A web source with its string literals put back together.
    private func flat(_ relative: String) throws -> String {
        let url = try repoRoot().appendingPathComponent(relative)
        guard FileManager.default.fileExists(atPath: url.path) else { throw ParityError.missing(relative) }
        return try String(contentsOf: url, encoding: .utf8)
            .replacingOccurrences(of: "['\"`]\\s*\\+\\s*['\"`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "=\\s*\\n\\s*(['\"`])", with: "= $1", options: .regularExpression)
    }

    private func section(_ source: String, from: String, to: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw ParityError.missing("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    private func assertDeclares(_ source: String, _ name: String, _ value: String, line: UInt = #line) {
        let quoted = "'\(value.replacingOccurrences(of: "'", with: "\\'"))'"
        XCTAssertTrue(source.contains("\(name) = \(quoted)"),
                      "\(name) drifted: \(Self.webLib) no longer declares it as \(quoted)", line: line)
    }

    private func assertLabels(_ source: String, _ table: String, _ pairs: [(String, String)], line: UInt = #line) throws {
        let body = try section(source, from: "export const \(table)", to: "};")
        for (key, word) in pairs {
            XCTAssertTrue(body.contains("\(key): '\(word)'"), "\(table).\(key) drifted from '\(word)'", line: line)
        }
    }

    // MARK: the payload

    func testEveryFieldOfTheReplyCardIsCalledWhatSharedCallsIt() throws {
        let shared = try flat(Self.shared)
        let body = try section(shared, from: "export interface SessionReplyCard {", to: "\n}")
        let re = try NSRegularExpression(pattern: "(?m)^  (\\w+)\\??:")
        let theirs = re.matches(in: body, range: NSRange(body.startIndex..., in: body)).compactMap {
            Range($0.range(at: 1), in: body).map { String(body[$0]) }
        }
        let mine = Mirror(reflecting: SessionReply(requestId: "r", outcome: .replied, fromSessionId: "s"))
            .children.compactMap(\.label)
        XCTAssertFalse(theirs.isEmpty, "no field of the interface was captured — the check is asleep")
        XCTAssertEqual(mine, theirs, "SessionReplyCard's fields drifted — first is this client's (in "
                           + "declaration order), second is the interface in \(Self.shared).")
    }

    func testTheOutcomesAreTheSharedOutcomes() throws {
        let shared = try flat(Self.shared)
        let union = try section(shared, from: "export type SessionRequestOutcome =", to: ";")
        for outcome in SessionRequestOutcome.allCases {
            XCTAssertTrue(union.contains("'\(outcome.rawValue)'"), "\(outcome.rawValue) is not a shared outcome")
        }
        XCTAssertEqual(union.components(separatedBy: "'").count / 2, SessionRequestOutcome.allCases.count,
                       "the shared union and this enum hold different outcomes")
    }

    // MARK: the words

    func testTheCardsWordsAreTheWebsWords() throws {
        let web = try flat(Self.webLib)
        assertDeclares(web, "SESSION_REQUEST_ASKS", SessionRequestCopy.asks)
        assertDeclares(web, "SESSION_REQUEST_DUE", SessionRequestCopy.due)
        assertDeclares(web, "SESSION_REPLY_FROM", SessionRequestCopy.replyFrom)
        assertDeclares(web, "SESSION_REPLY_YOU_ASKED", SessionRequestCopy.youAsked)
        assertDeclares(web, "SESSION_REPLY_LAST_WORDS", SessionRequestCopy.lastWords)
        assertDeclares(web, "SESSION_REPLY_CHOSE", SessionRequestCopy.chose)
        assertDeclares(web, "SESSION_REPLY_OPEN_REQUEST", SessionRequestCopy.openRequest)
        assertDeclares(web, "SESSION_REPLY_NOT_YOU", SessionRequestCopy.notYou)
        assertDeclares(web, "SESSION_REPLY_NEVER_SEEN", SessionRequestCopy.neverSeen)
    }

    func testEveryStateAndOutcomeIsCalledTheSameThing() throws {
        let web = try flat(Self.webLib)
        try assertLabels(web, "SESSION_REQUEST_STATE_LABEL", [("OPEN", SessionRequestCopy.stateLabel(.open))]
            + SessionRequestOutcome.allCases.map { ($0.rawValue, SessionRequestCopy.stateLabel(.closed($0))) })
        try assertLabels(web, "SESSION_REPLY_OUTCOME_LABEL",
                         SessionRequestOutcome.allCases.map { ($0.rawValue, SessionRequestCopy.outcomeLabel($0)) })
    }
}
