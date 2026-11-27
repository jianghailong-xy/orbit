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
            ("openPrevious", CoordinatorHandoffCopy.openPrevious),
            ("tryAgain", CoordinatorHandoffCopy.tryAgain),
            ("handOverWithoutNote", CoordinatorHandoffCopy.handOverWithoutNote),
            ("keepThisCoordinator", CoordinatorHandoffCopy.keepThisCoordinator),
            ("successorRowTitle", CoordinatorHandoffCopy.successorRowTitle),
            ("successorKeep", CoordinatorHandoffCopy.successorKeep),
        ]
        for (key, value) in pairs { assertSays(ts, "\(key): '\(value)',", in: Self.shared) }
        assertSays(ts, "successorRowDetail: \"\(CoordinatorHandoffCopy.successorRowDetail)\",", in: Self.shared)

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
        assertSays(ts, "decisions === 0 && merges === 0 ? null", in: Self.shared)
        assertSays(ts, "`${decisions} ${decisions === 1 ? 'decision' : 'decisions'} and "
                   + "${merges} ${merges === 1 ? 'merge' : 'merges'} before this conversation`",
                   in: Self.shared)
        // A refused press: web's toast title is this line's lead (double-quoted for its apostrophe).
        assertSays(ts, "refused: \"\(CoordinatorHandoffCopy.refused)\",", in: Self.shared)
    }

    /// The words naming a wait's kind are `COORDINATOR_PENDING_WAIT_KIND_LABELS`, and the line around them
    /// is `coordinatorPendingWaitLine`'s.
    func testThePendingWaitKindsAreTheShared() throws {
        let ts = try source(Self.shared)
        for kind in CoordinatorPendingWaitKind.allCases {
            let words = CoordinatorHandoffCopy.waitKind(kind).map { "'\($0)'" } ?? "null"
            assertSays(ts, "\(kind.rawValue): \(words),", in: Self.shared)
        }
        assertSays(ts, "return `${wait.label}${wait.paused ? '\(CoordinatorHandoffCopy.pausedSuffix)' : ''}${kind ? ` · ${kind}` : ''}`;",
                   in: Self.shared)
    }

    /// Board 03 iOS 2's confirm body is the shared one, which Android's confirm says too: the same
    /// two leads, the same sentence around them, the count the confirm's own.
    func testThePhoneConfirmBodyIsTheShared() throws {
        let ts = try source(Self.shared)
        let lead = CoordinatorContextCopy.phoneConfirmBody(waits: 0, running: false)
            .components(separatedBy: ", then").first!
        let runningLead = CoordinatorContextCopy.phoneConfirmBody(waits: 0, running: true)
            .components(separatedBy: ", then").first!
        assertSays(ts, "const lead = running ? '\(runningLead)' : '\(lead)';", in: Self.shared)
        assertSays(ts, "const moves = waits > 0 ? ` ${COORDINATOR_HANDOFF_COPY.waitsRowTitle(waits)}.` : '';",
                   in: Self.shared)
        let tail = CoordinatorContextCopy.phoneConfirmBody(waits: 0, running: false)
            .replacingOccurrences(of: lead, with: "")
            .replacingOccurrences(of: " Nothing is deleted.", with: "${moves} Nothing is deleted.")
        assertSays(ts, "return `${lead}\(tail)`;", in: Self.shared)
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
        assertSays(ts, "COORDINATOR_HANDOFF_PROMPT_HEAD = '\(CoordinatorContextActions.handoffPromptHead)';",
                   in: Self.shared)
    }
}
