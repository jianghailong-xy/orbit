import Foundation
import XCTest
@testable import OrbitKit

/// The Drive chat says on iOS and macOS what it says on the web (CLAUDE.md §5: the web libs define the words, Swift's
/// `DriveChatCopy` mirrors them). A failure — never a skip — when the other half is missing:
/// - every single-quoted `DRIVE_*` string driveChat.ts and driveChanges.ts export is in `DriveChatCopy.web` word for
///   word, and every name there is one they still export;
/// - the examples, the shared `DRIVE_CHAT_COPY`, and the sentences the libs and the cards build are the same.
final class DriveChatCopyParityTests: XCTestCase {

    private static let chatLib = "src/web/src/lib/driveChat.ts"
    private static let changesLib = "src/web/src/lib/driveChanges.ts"
    private static let cards = "src/web/src/components/drive/DriveChangeCards.tsx"
    private static let shared = "src/shared/src/driveChat.ts"

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

    /// `export const DRIVE_X = '…';`, by name.
    private func exportedStrings(_ source: String) -> [String: String] {
        let pattern = try! NSRegularExpression(pattern: #"export const (DRIVE_[A-Z_]+) = '((?:[^'\\]|\\.)*)';"#)
        var found: [String: String] = [:]
        for match in pattern.matches(in: source, range: NSRange(source.startIndex..., in: source)) {
            let name = String(source[Range(match.range(at: 1), in: source)!])
            let value = String(source[Range(match.range(at: 2), in: source)!]).replacingOccurrences(of: "\\'", with: "'")
            found[name] = value
        }
        return found
    }

    func testEveryWebStringIsMirroredWordForWord() throws {
        var web = exportedStrings(try read(Self.chatLib))
        web.merge(exportedStrings(try read(Self.changesLib))) { a, _ in a }
        XCTAssertFalse(web.isEmpty, "the web libs' strings could not be read")
        for (name, value) in web {
            XCTAssertEqual(DriveChatCopy.web[name], value, "\(name) differs from the web, or is missing from DriveChatCopy.web")
        }
        for name in DriveChatCopy.web.keys {
            XCTAssertNotNil(web[name], "DriveChatCopy.web names \(name), which the web libs no longer export as a string")
        }
    }

    func testTheExamplesAndTheSharedCopy() throws {
        let chat = try read(Self.chatLib)
        for example in DriveChatCopy.examples {
            XCTAssertTrue(chat.contains("'\(example)'"), "example \(example) is not the web's")
        }
        XCTAssertEqual(chat.components(separatedBy: "\n").drop { !$0.contains("DRIVE_CHAT_EXAMPLES = [") }
                        .prefix { !$0.contains("] as const") }.filter { $0.contains("'") }.count,
                       DriveChatCopy.examples.count, "the web has a different number of examples")
        XCTAssertTrue(chat.contains("DRIVE_CHAT_CHOOSE_WORKSPACE = DRIVE_CHAT_COPY.chooseWorkspace"))
        XCTAssertTrue(chat.contains("`Folder · ${name}`"))
        let shared = try read(Self.shared)
        for (key, value) in DriveChatCopy.shared where key != "runsIn" {
            XCTAssertTrue(shared.contains("\(key): '\(value)'"), "DRIVE_CHAT_COPY.\(key) is not \(value)")
        }
        XCTAssertTrue(shared.contains("runsIn: 'Runs in'"))
    }

    func testTheSentencesTheLibsAndTheCardsBuild() throws {
        let changes = try read(Self.changesLib)
        for fragment in ["`Done · ${plural(n, 'change', 'changes')}`", "`${plural(n, 'change', 'changes')} waiting for Apply`",
                         "`and ${n} more`", "`${n} left as ${n === 1 ? 'it is' : 'they are'}`",
                         "plural(names.length, 'file', 'files')", "export const DRIVE_CHANGES_PREVIEW = 4;",
                         "export const DRIVE_DETAILS_BESIDE_WIDTH = 1760;", "'You'", "`Agent in ${sessionTitle}`", "'An agent'",
                         "'Another machine'"] {
            XCTAssertTrue(changes.contains(fragment), "driveChanges.ts no longer says \(fragment)")
        }
        for (kind, label) in DriveChatCopy.kindLabels {
            XCTAssertTrue(changes.contains("\(kind): '\(label)'"), "driveChanges.ts names \(kind) other than \(label)")
        }
        for mark in [DriveChatCopy.markNew, DriveChatCopy.markMoved, DriveChatCopy.markRenamed] {
            XCTAssertTrue(changes.contains("'\(mark)'"), "the mark \(mark) is not the web's")
        }
        let cards = try read(Self.cards)
        for sentence in [DriveChatCopy.alreadyThere, DriveChatCopy.incoming, DriveChatCopy.replaced, DriveChatCopy.staleQuestion] {
            XCTAssertTrue(cards.contains(sentence), "DriveChangeCards.tsx no longer says \(sentence)")
        }
        XCTAssertTrue(cards.contains("`Kept both${question.outcome ? ` · saved as ${question.outcome.name}` : ''}.`"))
        XCTAssertEqual(DriveChatCopy.done(24), "Done · 24 changes")
        XCTAssertEqual(DriveChatCopy.pending(212), "212 changes waiting for Apply")
        XCTAssertEqual(DriveChatCopy.more(20), "and 20 more")
        XCTAssertEqual(DriveChatCopy.skipped(2), "2 left as they are")
        XCTAssertEqual(DriveChatLogic.preview, 4)
        XCTAssertEqual(DriveChatLogic.detailsBesideWidth, 1760)
        XCTAssertEqual(DriveChatLogic.panelWidth, 400)
    }
}
