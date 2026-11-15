import Foundation
import XCTest
@testable import OrbitKit

/// Board 02-2: while the outgoing coordinator writes its handoff note and while the replacement
/// runs, its conversation header reads "Handing over" in place of the run word — and only then.
/// The word is `SessionHeader.headerWord`; the Mac's header band (`ConsoleView.headerStatus`) is
/// SwiftUI, which does not compile here, so its use of that word is pinned over the source.
final class CoordinatorHandoffHeaderTests: XCTestCase {
    private func coordinator(_ state: CoordinatorHandoffState?) -> Session {
        var s = Session(id: "s", title: "Checkout redesign", status: .running, agentId: nil,
                        assignedRunnerId: nil, pendingApprovals: nil, branch: nil, updatedAt: nil,
                        projectId: "p", projectTitle: "Checkout redesign")
        s.coordinatorHandoff = state.map {
            SessionCoordinatorHandoff(state: $0, startedAt: "2026-11-15T03:00:00Z",
                                      failureCode: $0 == .failed ? .turnFailed : nil,
                                      handedOverToSessionId: $0 == .completed ? "s-next" : nil)
        }
        return s
    }

    func testTheHeaderReadsHandingOverWhileTheNoteIsWrittenAndTheReplacementRuns() {
        for state in [CoordinatorHandoffState.writing, .handingOver] {
            let s = coordinator(state)
            XCTAssertEqual(SessionHeader.headerWord(for: s), "Handing over", "\(state)")
            XCTAssertEqual(SessionHeader.subtitle(for: s)?.components(separatedBy: " · ").first,
                           "Handing over", "\(state)")
        }
        XCTAssertEqual(CoordinatorHandoffCopy.badgeHandingOver, "Handing over")
    }

    func testTheBadgeIsGoneInEveryOtherState() {
        for state in [CoordinatorHandoffState.failed, .completed, .cancelled, .unknown, nil] {
            let s = coordinator(state)
            XCTAssertEqual(SessionHeader.headerWord(for: s), "Running", "\(String(describing: state))")
            XCTAssertFalse(SessionHeader.subtitle(for: s)?.contains("Handing over") ?? true,
                           "\(String(describing: state))")
        }
    }

    func testOnlyTheHeaderChangesItsWord() {
        // List rows and the menu bar keep the run word: the badge belongs to the header.
        XCTAssertEqual(SessionHeader.statusWord(for: coordinator(.writing)), "Running")
    }

    func testTheMacHeaderBandLeadsWithTheHeaderWord() throws {
        let console = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/Console/ConsoleView.swift")
        guard let start = console.range(of: "private var headerStatus: Text {"),
              let end = console.range(of: "private static func statusWordColor", range: start.upperBound..<console.endIndex)
        else { return XCTFail("ConsoleView.headerStatus was not found; move this check with it") }
        let body = String(console[start.upperBound..<end.lowerBound])
        XCTAssertTrue(body.contains("let word = SessionHeader.headerWord(for: session"),
                      "the Mac header's leading word must be SessionHeader.headerWord")
        XCTAssertFalse(body.contains("SessionHeader.statusWord("),
                       "statusWord has no Handing over: the header must not lead with it")
    }

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir.deleteLastPathComponent()
        }
        throw NSError(domain: "CoordinatorHandoffHeaderTests", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "\(relative) not found"])
    }
}
