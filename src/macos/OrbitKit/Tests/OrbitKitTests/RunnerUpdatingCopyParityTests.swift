import Foundation
import XCTest
@testable import OrbitKit

/// `RunnerUpdating`'s words are the web's `runnerSlots.ts` (the runner_updating half). Swift cannot
/// import it, so this reads the file as text: every constant against the web declaration of the same
/// name, every sentence template rendered with the web's own placeholder names, and every sentence the
/// web spec (`runnerSlots.runnerUpdating.test.ts`) expects for board 5's fixture against what Swift
/// says for the same fixture. A missing counterpart is a failure, never an `XCTSkip`.
final class RunnerUpdatingCopyParityTests: XCTestCase {
    private static let webCopy = "src/web/src/lib/runnerSlots.ts"
    private static let webSpec = "src/web/src/lib/runnerSlots.runnerUpdating.test.ts"

    private struct NoRepo: Error, CustomStringConvertible {
        var description: String {
            "\(RunnerUpdatingCopyParityTests.webCopy) was not found above this test file. "
                + "RunnerUpdating is one half of a pair; if the web half moved, move this check with it."
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
        try assertSays(Self.webCopy, "export const RUNNER_UPDATING_TITLE = '\(RunnerUpdating.RUNNER_UPDATING_TITLE)';")
        try assertSays(Self.webCopy, "export const RUNNER_UPDATING_TAG = '\(RunnerUpdating.RUNNER_UPDATING_TAG)';")
        try assertSays(Self.webCopy, "export const RUNNER_STOPPING_TITLE = '\(RunnerUpdating.RUNNER_STOPPING_TITLE)';")
        try assertSays(Self.webCopy, "export const RUNNER_STOPPING_TAG = '\(RunnerUpdating.RUNNER_STOPPING_TAG)';")
        try assertSays(Self.webCopy, "gate?.queuedReason === '\(RunnerUpdating.reason)'")
        try assertSays(Self.webCopy, "gate?.queuedRunnerUpdate?.stopping === true")
        // The word before the tag, in the web's foot row.
        try assertSays("src/web/src/components/WorkspaceView.tsx",
                       "<span className=\"chat-runner-updating\"> \(RunnerUpdating.queuedWord) <span className=\"chat-meta-sep\">·</span>")
    }

    /// The sentences that open with the machine and the version, rendered with the web's placeholder
    /// names, are the web's template literals character for character.
    func testTheTemplatesAreTheWebs() throws {
        let named = RunnerUpdatingTests.held(active: 0, version: "${version}", turns: [])
        let unnamed = RunnerUpdatingTests.held(active: 0, version: nil, turns: [])
        guard case .text(let versioned) = RunnerUpdating.description(named, machine: "${who}")[0],
              case .text(let bare) = RunnerUpdating.description(unnamed, machine: "${who}")[0]
        else { return XCTFail("the description no longer opens with words") }
        try assertSays(Self.webCopy, "`\(versioned)`")
        try assertSays(Self.webCopy, "`\(bare)`")
        try assertSays(Self.webCopy, "'This session starts right after.'")
        let stopping = RunnerUpdatingTests.held(active: 0, version: nil, turns: [], stopping: true)
        guard case .text(let stops) = RunnerUpdating.description(stopping, machine: "${who}")[0],
              case .text(let back)? = RunnerUpdating.description(stopping, machine: "${name || 'it'}").last
        else { return XCTFail("the stopping description no longer opens and ends with words") }
        try assertSays(Self.webCopy, "`\(stops)`")
        try assertSays(Self.webCopy, "`\(back)`")
        try assertSays(Self.webCopy, "`${who} starts no new turns until ${turnsFinish(count)}, then stops.`")
        try assertSays(Self.webCopy, "`${who} stops now.`")
        try assertSays(Self.webCopy, "`${first} This message is sent once it is back.`")
        try assertSays(Self.webCopy, "`It starts no new work until ${turnsFinish(count)}: `")
        try assertSays(Self.webCopy, "`${who} ${update} now.`")
        try assertSays(Self.webCopy, "`${first} This message is sent right after.`")
        try assertSays(Self.webCopy, "`${who} starts no new turns until ${turnsFinish(count)}, then ${update}.`")
        try assertSays(Self.webCopy, "`updates to ${version}` : 'updates'")
        try assertSays(Self.webCopy, "count === 1 ? '1 turn finishes' : `${count} turns finish`")
        try assertSays(Self.webCopy, "`${count - named.length} more`")
        try assertSays(Self.webCopy, "i === items.length - 1 ? ' and ' : ', '")
        try assertSays(Self.webCopy, "title?.trim() || 'Untitled session'")
        try assertSays(Self.webCopy, "machine?.trim() || 'The runner'")
        try assertSays(Self.webCopy, "return 'Waiting less than a minute';")
        try assertSays(Self.webCopy, "return `Waiting ${minutes} min`;")
        try assertSays(Self.webCopy, "return `Waiting ${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ''}`;")
    }

    /// For the board's fixture and each variant the web spec checks, the web spec expects exactly what
    /// Swift says.
    func testTheWebSpecExpectsWhatSwiftSays() throws {
        let board = RunnerUpdatingTests.held()
        let said: [String] = [
            RunnerUpdating.RUNNER_UPDATING_TITLE,
            RunnerUpdating.plain(RunnerUpdating.description(board, machine: "studio-mac")),
            RunnerUpdating.messageText(board, machine: "studio-mac"),
            RunnerUpdating.plain(RunnerUpdating.description(RunnerUpdatingTests.held(active: 3), machine: "studio-mac")),
            RunnerUpdating.waited(board, now: RunnerUpdatingTests.now)!,
            RunnerUpdating.waited(RunnerUpdatingTests.held(sinceMinutes: 0), now: RunnerUpdatingTests.now)!,
            RunnerUpdating.waited(RunnerUpdatingTests.held(sinceMinutes: 60), now: RunnerUpdatingTests.now)!,
            RunnerUpdating.waited(RunnerUpdatingTests.held(sinceMinutes: 125), now: RunnerUpdatingTests.now)!,
        ]
        let old = RunnerUpdatingTests.held(active: 1, version: nil, sinceMinutes: nil,
                                           turns: [RunnerUpdatingTests.boardTurns[0]])
        let idle = RunnerUpdatingTests.held(active: 0, version: nil, turns: [])
        for sentence in said + [
            RunnerUpdating.plain(RunnerUpdating.description(old, machine: "studio-mac")),
            RunnerUpdating.messageText(old, machine: "studio-mac"),
            RunnerUpdating.plain(RunnerUpdating.description(idle, machine: "studio-mac")),
        ] {
            try assertSays(Self.webSpec, "'\(sentence)'")
        }
    }
}
