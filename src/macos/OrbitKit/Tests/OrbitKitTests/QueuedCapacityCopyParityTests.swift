import Foundation
import XCTest
@testable import OrbitKit

/// `QueuedCapacity`'s words are the web's `queuedCapacity.ts`. Swift cannot import it, so this reads the
/// file as text: every constant against the web declaration of the same name, and every sentence Swift
/// says for the shared fixtures against what the web spec (`queuedCapacity.test.ts`) expects for them.
/// A missing counterpart is a failure, never an `XCTSkip`.
final class QueuedCapacityCopyParityTests: XCTestCase {
    private static let webCopy = "src/web/src/lib/queuedCapacity.ts"
    private static let webSpec = "src/web/src/lib/queuedCapacity.test.ts"

    private struct NoRepo: Error, CustomStringConvertible {
        var description: String {
            "\(QueuedCapacityCopyParityTests.webCopy) was not found above this test file. "
                + "QueuedCapacity is one half of a pair; if the web half moved, move this check with it."
        }
    }

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let file = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: file.path) {
                return try String(contentsOf: file, encoding: .utf8)
                    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw NoRepo()
    }

    private func assertSays(_ file: String, _ literal: String, line: UInt = #line) throws {
        XCTAssertTrue(try source(file).contains(literal), "\(file) no longer says \(literal)", line: line)
    }

    func testTheConstantsAreTheWebs() throws {
        try assertSays(Self.webCopy, "export const RUNNER_FULL_TITLE = '\(QueuedCapacity.RUNNER_FULL_TITLE)';")
        try assertSays(Self.webCopy, "export const RUNNER_FULL_TAG = '\(QueuedCapacity.RUNNER_FULL_TAG)';")
        try assertSays(Self.webCopy, "export const RUN_FULL_TITLE = '\(QueuedCapacity.RUN_FULL_TITLE)';")
        try assertSays(Self.webCopy, "export const RUN_FULL_TAG = '\(QueuedCapacity.RUN_FULL_TAG)';")
        try assertSays(Self.webCopy, "export const BATCH_FULL_TITLE = '\(QueuedCapacity.BATCH_FULL_TITLE)';")
        try assertSays(Self.webCopy, "export const BATCH_FULL_TAG = '\(QueuedCapacity.BATCH_FULL_TAG)';")
        try assertSays(Self.webCopy, "export const CAPACITY_HELD_LINE = '\(QueuedCapacity.CAPACITY_HELD_LINE)';")
        for reason in QueuedCapacity.reasons {
            try assertSays(Self.webCopy, "reason === '\(reason)'")
        }
    }

    /// Each sentence Swift says for the shared fixtures is one the web spec expects, character for character.
    func testTheSentencesAreTheWebs() throws {
        for sentence in try QueuedCapacityTests.sentences() {
            try assertSays(Self.webSpec, "'\(sentence)'")
        }
    }
}
