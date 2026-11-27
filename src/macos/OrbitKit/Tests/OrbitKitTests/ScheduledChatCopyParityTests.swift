import Foundation
import XCTest
@testable import OrbitKit

/// The Scheduled page chat says on iOS and macOS what it says on the web (CLAUDE.md §5: the web libs define the words,
/// Swift's `ScheduledChatCopy` mirrors them). A failure — never a skip — when the other half is missing:
/// - every single-quoted `SCHEDULED_CHAT_*` string scheduledChat.ts exports is in `ScheduledChatCopy.web` word for word,
///   and every name there is one it still exports;
/// - Run now's words are `RUN_NOW_COPY`'s, the row tag is `SCHEDULE_PAGE_CHAT_COPY.fromScheduled`, and the offer's
///   link is the one the server's note tells the agent to write.
final class ScheduledChatCopyParityTests: XCTestCase {

    private static let chatLib = "src/web/src/lib/scheduledChat.ts"
    private static let extras = "src/web/src/components/ScheduleChatExtras.tsx"
    private static let offers = "src/web/src/lib/scheduledChatOffers.ts"
    private static let shared = "src/shared/src/schedule.ts"
    private static let note = "src/apiserver/src/schedules/schedule-page-chat-note.ts"

    private struct Missing: Error, CustomStringConvertible {
        let file: String
        var description: String { "\(file) was not found above this test file: if it moved, move this check with it." }
    }

    private func read(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) { return try String(contentsOf: candidate, encoding: .utf8) }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(file: relative)
    }

    func testEveryWebStringIsMirroredWordForWord() throws {
        let source = try read(Self.chatLib)
        let pattern = try NSRegularExpression(pattern: #"export const (SCHEDULED_CHAT_[A-Z_]+) = '((?:[^'\\]|\\.)*)';"#)
        var web: [String: String] = [:]
        for match in pattern.matches(in: source, range: NSRange(source.startIndex..., in: source)) {
            let name = String(source[Range(match.range(at: 1), in: source)!])
            web[name] = String(source[Range(match.range(at: 2), in: source)!]).replacingOccurrences(of: "\\'", with: "'")
        }
        XCTAssertFalse(web.isEmpty, "scheduledChat.ts's strings could not be read")
        for (name, value) in web {
            XCTAssertEqual(ScheduledChatCopy.web[name], value, "\(name) differs from the web, or is missing from ScheduledChatCopy.web")
        }
        for name in ScheduledChatCopy.web.keys {
            XCTAssertNotNil(web[name], "ScheduledChatCopy.web names \(name), which scheduledChat.ts no longer exports as a string")
        }
    }

    func testRunNowTheTagAndTheLink() throws {
        let extras = try read(Self.extras)
        for (key, value) in ScheduledChatCopy.runNowWeb {
            XCTAssertTrue(extras.contains("\(key): '\(value)'"), "RUN_NOW_COPY.\(key) is not \(value)")
        }
        XCTAssertTrue(try read(Self.shared).contains("fromScheduled: '\(ScheduledChatCopy.fromScheduled)'"))
        XCTAssertTrue(try read(Self.offers).contains("/\(ScheduledChatLogic.runNowScheme):([A-Za-z0-9_-]+)/g"))
        XCTAssertTrue(try read(Self.note).contains("(\(ScheduledChatLogic.runNowScheme):<schedule id>)"))
        XCTAssertTrue(try read(Self.chatLib).contains("chatOrigin === '\(ScheduledChatLogic.origin)'"))
    }
}
