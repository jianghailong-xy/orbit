import Foundation
import XCTest
@testable import OrbitKit

/// The wires between the accepted head (`TranscriptState.accepted`, `AcceptedTurnPlaceholderTests`)
/// and the console that fetches and draws it.
///
/// The model half proves the reducer keeps the head and `TranscriptRows.build` draws it as a transcript
/// row; nothing on Linux compiles the OrbitApp shell that feeds the one and draws the other — SwiftUI
/// does not exist here, and those files are built only by the macOS and iOS jobs (`client.yml`). So the
/// wiring is asserted over the source, as `UserTurnRowWiringTests` does, each assertion written so that
/// CUTTING the wire is what turns it red:
///  - the console tells the reconcile which heads it already drew, or a head the listing stops naming
///    would never leave the screen;
///  - the row the head is drawn as is the transcript's own user row, which carries no Cancel.
final class AcceptedTurnWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found above this test. If it moved, move this check with it "
                    + "rather than deleting it: it is the only gate on Linux that sees whether the console "
                    + "still fetches the accepted head and draws it without a Cancel."
            }
        }
    }

    private static let app = "src/macos/OrbitApp/Sources/OrbitApp"
    private static let modelPath = app + "/ConsoleModel.swift"
    private static let consolePath = app + "/Views/Console/ConsoleView.swift"

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw WiringError.missing(relative)
    }

    /// One stretch of a file, so a match somewhere else cannot answer for the part being asserted about.
    private func section(_ source: String, from: String, to: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw WiringError.missing("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    /// The lines of one stretch that are CODE: a call that is commented out still contains its words.
    private func statements(_ source: String) -> [String] {
        source.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("//") }
    }

    /// The refresh reads the listing that carries the head (`APIClient.queuedTurns`, `view=active`), and
    /// hands the reconcile every turn it already drew — the head's among them — as known before the
    /// fetch: a known head the listing no longer names is one delivered or dropped elsewhere.
    func testTheRefreshTellsTheReconcileAboutTheHeadItAlreadyDrew() throws {
        let refresh = statements(try section(try source(Self.modelPath),
                                             from: "private func refreshQueuedTurns() async {",
                                             to: "reducer.reconcileQueuedTurns(turns, knownBefore: knownBefore)"))
        XCTAssertTrue(refresh.contains("let knownBefore = reducer.state.listedTurnIDs"),
                      "the refresh no longer counts the accepted head as known, so a head delivered or "
                          + "dropped elsewhere would stay on screen")
        XCTAssertTrue(refresh.contains { $0.contains("try? await api.queuedTurns(sessionID: sessionID)") },
                      "the refresh no longer reads the listing that carries the accepted head")
    }

    /// The head is drawn as an `.item` row (`TranscriptRows.build`), and the console draws an item's user
    /// turn with the transcript's row and no queued controls: the same card its echo is drawn as, with no
    /// Cancel — the runner has the turn.
    func testTheHeadIsDrawnByTheTranscriptsOwnRowWithNoCancel() throws {
        let console = try source(Self.consolePath)
        let item = statements(try section(console, from: "case .item(let item):", to: "case .toolGroup(let cards):"))
        XCTAssertEqual(item.dropFirst().first,
                       "TranscriptItemView(item: item, fullPayload: console.fullPayload, console: console)",
                       "an item row is no longer drawn by the transcript's item view")

        let user = statements(try section(console, from: "struct TranscriptItemView: View {",
                                          to: "case .assistant(let b):"))
        let row = user.filter { $0.contains("UserTurnRow(") }
        XCTAssertEqual(row, ["UserTurnRow(bubble: b)"],
                       "the transcript's user row is handed queued controls, so the accepted head would offer a Cancel")
    }
}
