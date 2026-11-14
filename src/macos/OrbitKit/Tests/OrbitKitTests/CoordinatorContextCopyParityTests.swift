import Foundation
import XCTest
@testable import OrbitKit

/// The handoff says the web's words: each one is looked up in `COORDINATOR_HANDOFF_COPY`
/// (src/shared/src/coordinator-handoff.ts), which the web draws board 02 from, with runs of
/// whitespace read as one space. The popover rows' words are pinned in
/// `CoordinatorContextActionsTests.testThePopoverRowsCopy`, word for word from boards 01 and 03.
///
/// A missing counterpart is a FAILURE, never an `XCTSkip`.
final class CoordinatorContextCopyParityTests: XCTestCase {

    private static let shared = "src/shared/src/coordinator-handoff.ts"

    private struct Missing: Error, CustomStringConvertible {
        let file: String
        var description: String {
            "\(file) was not found above this test file. The native copy is one half of a pair; if the other "
                + "half moved, move this check with it rather than deleting it."
        }
    }

    private func read(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(file: relative)
    }

    /// The TypeScript source with every run of whitespace as a single space.
    private func source(_ relative: String) throws -> String {
        try read(relative).replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    }

    private func assertSays(_ text: String, _ literal: String, in file: String, line: UInt = #line) {
        XCTAssertTrue(text.contains(literal), "\(file) no longer says \(literal)", line: line)
    }

    func testTheHandoffCopyIsTheSharedCopy() throws {
        let ts = try source(Self.shared)
        let pairs: [(String, String)] = [
            ("confirmTitle", CoordinatorHandoffCopy.confirmTitle),
            ("noteRowTitle", CoordinatorHandoffCopy.noteRowTitle),
            ("noteRowDetail", CoordinatorHandoffCopy.noteRowDetail),
            ("cancel", CoordinatorHandoffCopy.cancel),
            ("handOver", CoordinatorHandoffCopy.handOver),
            ("badgeHandingOver", CoordinatorHandoffCopy.badgeHandingOver),
            ("writing", CoordinatorHandoffCopy.writing),
            ("compacting", CoordinatorHandoffCopy.compacting),
            ("skipNote", CoordinatorHandoffCopy.skipNote),
            ("cancelHandover", CoordinatorHandoffCopy.cancelHandover),
            ("handingOver", CoordinatorHandoffCopy.handingOver),
            ("noteCardTitle", CoordinatorHandoffCopy.noteCardTitle),
            ("handedOver", CoordinatorHandoffCopy.handedOver),
            ("openIt", CoordinatorHandoffCopy.openIt),
            ("tryAgain", CoordinatorHandoffCopy.tryAgain),
            ("handOverWithoutNote", CoordinatorHandoffCopy.handOverWithoutNote),
            ("keepThisCoordinator", CoordinatorHandoffCopy.keepThisCoordinator),
        ]
        for (key, value) in pairs { assertSays(ts, "\(key): '\(value)',", in: Self.shared) }

        // The two bodies, the project's title where the template puts it.
        assertSays(ts, "`\(CoordinatorHandoffCopy.confirmBody("${projectTitle}"))`", in: Self.shared)
        assertSays(ts, "`\(CoordinatorHandoffCopy.confirmBodyWhileRunning("${projectTitle}"))`", in: Self.shared)
        // The two counts, singular and plural.
        assertSays(ts, "count === 1 ? '\(CoordinatorHandoffCopy.waitsRowTitle(1))' : "
                   + "`\(CoordinatorHandoffCopy.waitsRowTitle(7).replacingOccurrences(of: "7", with: "${count}"))`",
                   in: Self.shared)
        assertSays(ts, "count === 1 ? '\(CoordinatorHandoffCopy.waitsMovedHere(1))' : "
                   + "`\(CoordinatorHandoffCopy.waitsMovedHere(7).replacingOccurrences(of: "7", with: "${count}"))`",
                   in: Self.shared)
    }

    func testTheFailureSentencesSectionsAndTurnPrefixAreTheShared() throws {
        let ts = try source(Self.shared)
        for code in CoordinatorHandoffFailureCode.allCases {
            let reason = try XCTUnwrap(CoordinatorHandoffCopy.failureReasons[code])
            assertSays(ts, "\(code.rawValue): '\(reason)'", in: Self.shared)
        }
        assertSays(ts, "return `The handoff note wasn't written: ${COORDINATOR_HANDOFF_FAILURE_REASONS[code]}`;",
                   in: Self.shared)
        XCTAssertEqual(CoordinatorHandoffCopy.failureSentence(.turnFailed),
                       "The handoff note wasn't written: the turn failed.")
        let sections = CoordinatorHandoffCopy.sections.map { "'\($0)'," }.joined(separator: " ")
        assertSays(ts, "COORDINATOR_HANDOFF_SECTIONS = [ \(sections) ] as const;", in: Self.shared)
        assertSays(ts, "COORDINATOR_HANDOFF_TURN_PREFIX = '\(CoordinatorContextActions.handoffTurnPrefix)';",
                   in: Self.shared)
    }
}
