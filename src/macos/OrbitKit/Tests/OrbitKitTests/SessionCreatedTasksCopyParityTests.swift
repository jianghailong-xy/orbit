import Foundation
import XCTest
@testable import OrbitKit

/// The two clients write the same words on the "Tasks created here" card, and this is the tripwire
/// that keeps them doing it.
///
/// `src/shared/src/session-created-tasks.fixture.json` is the contract: `@orbit/shared` proves the
/// browser's words against it (`sessionCreatedTasks.spec.ts`), and this file proves this client's,
/// case by case. The two ends share no compiler, so a sentence reworded at one of them would
/// otherwise simply never appear at the other.
///
/// Shaped after `OrbitLinkCopyParityTests`, including the part that matters most: a missing fixture
/// is a FAILURE and never an `XCTSkip`. A check that quietly opts out reports green on exactly the
/// day the thing it watches goes missing.
final class SessionCreatedTasksCopyParityTests: XCTestCase {

    private static let fixturePath = "src/shared/src/session-created-tasks.fixture.json"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case unreadable(String)

        var description: String {
            switch self {
            case .noRepo:
                return "\(SessionCreatedTasksCopyParityTests.fixturePath) was not found above this "
                    + "test file. It is the set of cases this client shares with the web client — "
                    + "if it moved, point this check at its new home rather than deleting it."
            case .unreadable(let why):
                return "the shared fixture is not readable as its own format: \(why)"
            }
        }
    }

    private struct Fixture: Decodable {
        let copy: [String: String]
        let singleNamesTheTask: Bool
        let countLine: [CountLineCase]
    }

    private struct CountLineCase: Decodable, CustomStringConvertible {
        let running: Int
        let failed: Int
        let done: Int
        let total: Int
        let text: String

        var description: String { "running \(running), failed \(failed), done \(done)/\(total)" }
    }

    /// The repo root, found by walking up from this file until the fixture is under foot. Not a
    /// fixed number of `..` hops: how deep this file sits is not the thing being asserted.
    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.fixturePath).path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        // Deliberately a failure and not an `XCTSkip`, for the reason in the type's note above.
        throw ParityError.noRepo
    }

    private func fixture() throws -> Fixture {
        let url = try repoRoot().appendingPathComponent(Self.fixturePath)
        guard let data = FileManager.default.contents(atPath: url.path) else {
            throw ParityError.unreadable("\(Self.fixturePath) has no contents")
        }
        do {
            return try JSONDecoder().decode(Fixture.self, from: data)
        } catch {
            throw ParityError.unreadable(String(describing: error))
        }
    }

    private func row(_ id: String, running: Bool = false) -> SessionCreatedTaskRow {
        SessionCreatedTaskRow(id: id, title: "Task \(id)", status: "OPEN", running: running,
                              queued: false, createdAt: "2026-09-25T02:12:44.959Z", projectId: nil,
                              replaces: nil)
    }

    // MARK: the words

    /// Key for key, both ways: a word added at either end without its counterpart is one short here,
    /// and a word reworded at either end is a different word here.
    func testTheWordsAreTheFixturesWords() throws {
        let theirs = try fixture().copy
        let mine: [String: String] = [
            "title": SessionCreatedTasksCopy.title,
            "viewAll": SessionCreatedTasksCopy.viewAll,
            "openProject": SessionCreatedTasksCopy.openProject,
            "replacesPrefix": SessionCreatedTasksCopy.replacesPrefix,
            "createdInChip": SessionCreatedTasksCopy.createdInChip,
        ]
        XCTAssertEqual(Set(theirs.keys), Set(mine.keys),
                       "the fixture's words and this client's are not the same set of words")
        for (key, word) in mine.sorted(by: { $0.key < $1.key }) {
            XCTAssertEqual(theirs[key], word, "copy.\(key) drifted")
        }
    }

    /// The two words that are followed by a value are followed by it directly.
    func testTheWordsBeforeAValueRunStraightIntoIt() throws {
        let theirs = try fixture().copy
        let replaced = "修复 token 过期后登录重定向循环"
        XCTAssertEqual(SessionCreatedTasksCopy.replaces(replaced), (theirs["replacesPrefix"] ?? "") + replaced)
        XCTAssertEqual(SessionCreatedTasksCopy.createdIn("会话任务显示在停车栏"),
                       (theirs["createdInChip"] ?? "") + "会话任务显示在停车栏")
    }

    // MARK: the sentence

    func testEveryCountLineCaseIsTheSentenceThisClientWrites() throws {
        let cases = try fixture().countLine
        XCTAssertFalse(cases.isEmpty, "the fixture has no countLine cases, so this check checks nothing")
        for c in cases {
            XCTAssertEqual(SessionCreatedTasksCopy.countLine(running: c.running, failed: c.failed,
                                                             done: c.done, total: c.total),
                           c.text, "\(c)")
        }
    }

    /// What the collapsed row actually draws for a response carrying those counts: the same
    /// sentence, put together from parts, with the failed count — and only it — the part in red.
    func testTheCollapsedRowWritesTheFixturesSentence() throws {
        for c in try fixture().countLine {
            let tasks = SessionCreatedTasks(total: c.total, running: c.running, failed: c.failed,
                                            done: c.done,
                                            items: (0..<min(c.total, 20)).map { row("t\($0)") },
                                            projects: [])
            guard case .counted(let parts) = SessionCreatedTasksCopy.line(tasks) else {
                XCTFail("\(c): a response with \(c.total) rows writes its sentence")
                continue
            }
            XCTAssertEqual(parts.map(\.text).joined(separator: SessionCreatedTasksCopy.separator),
                           c.text, "\(c)")
            XCTAssertEqual(parts.filter(\.failed).map(\.text),
                           c.failed > 0 ? ["\(c.failed) failed"] : [], "\(c)")
        }
    }

    /// " · ": U+00B7 between two spaces, as the fixture spells it out — not a bullet, not a period.
    func testTheJointIsTheMiddleDotBetweenTwoSpaces() throws {
        XCTAssertEqual(SessionCreatedTasksCopy.separator.unicodeScalars.map(\.value), [0x20, 0xB7, 0x20])
        let joined = try fixture().countLine.filter { $0.running > 0 && $0.failed > 0 }
        XCTAssertFalse(joined.isEmpty, "the fixture has no case with all three parts")
        for c in joined {
            XCTAssertEqual(c.text.components(separatedBy: SessionCreatedTasksCopy.separator).count, 3,
                           "\(c)")
        }
    }

    // MARK: one row, and none

    /// One row names its task and shows its pill instead of counting it; no rows is no card.
    func testOneRowNamesItsTaskAndNoRowsIsNoCard() throws {
        let fixture = try fixture()
        XCTAssertEqual(SessionCreatedTasksCopy.singleNamesTheTask, fixture.singleNamesTheTask)

        let only = row("t1", running: true)
        let one = SessionCreatedTasks(total: 1, running: 1, failed: 0, done: 0, items: [only],
                                      projects: [])
        if fixture.singleNamesTheTask {
            XCTAssertEqual(SessionCreatedTasksCopy.line(one), .single(only))
        } else {
            XCTAssertEqual(SessionCreatedTasksCopy.line(one),
                           .counted(SessionCreatedTasksCopy.countParts(running: 1, failed: 0,
                                                                       done: 0, total: 1)))
        }

        let none = SessionCreatedTasks(total: 0, running: 0, failed: 0, done: 0, items: [],
                                       projects: [])
        XCTAssertEqual(SessionCreatedTasksCopy.line(none), .hidden)

        // Two rows are counted, even when the sentence is short.
        let two = SessionCreatedTasks(total: 2, running: 0, failed: 0, done: 2,
                                      items: [row("t1"), row("t2")], projects: [])
        XCTAssertEqual(SessionCreatedTasksCopy.line(two),
                       .counted([SessionCreatedTasksCopy.CountPart(text: "2/2 done", failed: false)]))
    }
}
