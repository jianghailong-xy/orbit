import Foundation
import XCTest
@testable import OrbitKit

/// The two clients fold the same turns into the same words, and this is the tripwire that keeps them
/// doing it.
///
/// `OrbitExchangeFold.swift` is a hand-copy of the browser's fold (`lib/orbitExchangeFold.ts`, the
/// rows in `components/OrbitExchangeFold.tsx`, the rules in `components/Transcript.tsx`). Neither end
/// compiles the other, so a word changed at one end is one screen disagreeing with the other about the
/// same conversation. A missing counterpart is a FAILURE and never an `XCTSkip`.
final class OrbitExchangeFoldCopyParityTests: XCTestCase {
    private static let webLib = "src/web/src/lib/orbitExchangeFold.ts"
    private static let webFold = "src/web/src/components/OrbitExchangeFold.tsx"
    private static let webTranscript = "src/web/src/components/Transcript.tsx"

    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.webLib).path) { return dir }
            dir = dir.deletingLastPathComponent()
        }
        XCTFail("\(Self.webLib) was not found above this test file. If the web half moved, move this check with it.")
        throw CocoaError(.fileNoSuchFile)
    }

    private func source(_ relative: String) throws -> String {
        try String(contentsOf: repoRoot().appendingPathComponent(relative), encoding: .utf8)
    }

    func testTheLengthAShortAnswerFoldsAtIsTheWebs() throws {
        let lib = try source(Self.webLib)
        XCTAssertTrue(lib.contains("export const WATCH_FOLDS_BELOW = \(OrbitExchangeFold.watchFoldsBelow);"))
        XCTAssertTrue(lib.contains("export const OTHER_FOLDS_BELOW = \(OrbitExchangeFold.otherFoldsBelow);"))
        XCTAssertTrue(lib.contains("if (category === 'reply') return false;"), "a reply folds by length on the web")
    }

    func testTheGroupAndBranchWordsAreTheWebs() throws {
        let fold = try source(Self.webFold)
        let lib = try source(Self.webLib)
        XCTAssertEqual(OrbitExchangeFold.groupCount(7), "7 Orbit updates handled")
        XCTAssertTrue(fold.contains("Orbit updates handled`"), "web group line moved")
        XCTAssertTrue(lib.contains("export const OTHER_BRANCH_TITLE = '\(OrbitExchangeFold.otherBranchTitle)';"))
        for words in ["'update' : 'updates'", "downstream`", "`last: ${"] {
            XCTAssertTrue(fold.contains(words), "\(words) is not in \(Self.webFold)")
        }
        XCTAssertEqual(OrbitExchangeFold.updates(1), "1 update")
        XCTAssertEqual(OrbitExchangeFold.updates(3), "3 updates")
    }

    func testEveryKindIsCountedInTheWebsWordsAndOrder() throws {
        let lib = try source(Self.webLib)
        // `['evidence', 'evidence', 'evidence'],` … in the web's table, in this order.
        var cursor = lib.startIndex
        for (category, one, many) in [
            (ExchangeCategory.evidence, "evidence", "evidence"), (.ready, "can start", "can start"),
            (.project, "project update", "project updates"), (.watch, "watch", "watches"),
            (.job, "background job", "background jobs"), (.notice, "run notice", "run notices"),
            (.message, "message", "messages"), (.reply, "reply", "replies"),
        ] {
            let entry = "['\(category.rawValue)', '\(one)', '\(many)']"
            guard let range = lib.range(of: entry, range: cursor..<lib.endIndex) else {
                return XCTFail("\(entry) is not in \(Self.webLib), or not in this order")
            }
            cursor = range.upperBound
            let exchanges = [OrbitExchange(id: "a", ts: nil, what: "", reply: "", category: category, target: nil)]
            XCTAssertEqual(OrbitExchangeFold.kinds(exchanges), "1 \(one)")
        }
        XCTAssertEqual(Set(ExchangeCategory.allCases.map(\.rawValue)),
                       ["evidence", "ready", "project", "watch", "job", "notice", "message", "reply"])
    }

    func testTheSameDeliveriesStayInView() throws {
        let transcript = try source(Self.webTranscript)
        guard let line = transcript.components(separatedBy: "\n").first(where: { $0.contains("const LOUD_DELIVERIES") }) else {
            return XCTFail("LOUD_DELIVERIES is not declared in \(Self.webTranscript)")
        }
        let re = try NSRegularExpression(pattern: "'([A-Z_]+)'")
        let web = Set(re.matches(in: line, range: NSRange(line.startIndex..., in: line)).compactMap {
            Range($0.range(at: 1), in: line).map { String(line[$0]) }
        })
        XCTAssertEqual(web, Set(OrbitExchangeFold.loudDeliveries.map(\.rawValue)))
    }

    func testAReplyAndAnAskingCallReadTheSame() throws {
        let transcript = try source(Self.webTranscript)
        XCTAssertTrue(transcript.contains("what: `Reply from ${reply.fromTitle}`"))
        // A task run's message and a run notice, in the web's words.
        for words in ["what: `Message from ${task ?? card.fromTitle}`", "whatInTask: 'Message'",
                      "card.fromTitle.replace(/^Task: /, '')", "`Run notice: ${notice.taskTitle}`", "'Run notice'"] {
            XCTAssertTrue(transcript.contains(words), "\(words) is not in \(Self.webTranscript)")
        }
        let lib = try source(Self.webLib)
        for words in ["<orbit-run-notice task=", "A run of the task “", "” used notify", "</orbit-run-notice>"] {
            XCTAssertTrue(lib.contains(words), "\(words) is not in \(Self.webLib)")
        }
        XCTAssertTrue(transcript.contains("(ask_owner|request_owner_action)"))
    }
}
