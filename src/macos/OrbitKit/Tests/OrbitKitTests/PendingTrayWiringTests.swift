import Foundation
import XCTest

/// The tray above the composer, as OrbitApp draws it (docs/mocks/steer-tray, decided 2026-10-16).
/// SwiftUI does not build on Linux, so these read the app's sources: the tray stands in the band on
/// the composer and is one of the band's cards, its rows act through the console, and Send carries
/// the other way to send a message while a turn runs. `PendingTrayTests` holds the rows themselves.
final class PendingTrayWiringTests: XCTestCase {
    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw NSError(domain: "PendingTrayWiringTests", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "\(relative) not found"])
    }

    private let app = "src/macos/OrbitApp/Sources/OrbitApp/"

    func testTheTrayIsTheBandsCardOnTheComposer() throws {
        let console = try source(app + "Views/Console/ConsoleView.swift")
        let tray = try XCTUnwrap(console.range(of: "PendingTrayView(console: console, rows: console.pendingTrayRows("))
        let composer = try XCTUnwrap(console.range(of: "ComposerView(console: console)"))
        XCTAssertLessThan(tray.lowerBound, composer.lowerBound, "the tray is drawn right above the composer")
        let fold = try XCTUnwrap(console.range(of: ".modifier(TypingFold(folded: foldsChrome(console)))"))
        XCTAssertLessThan(fold.lowerBound, tray.lowerBound, "and is not folded away while typing")

        let view = try source(app + "Views/Console/PendingTrayView.swift")
        XCTAssertTrue(view.contains(".composerBandCard(cornerRadius: 12)"), "one of the band's cards, glass where it floats")
    }

    func testEachRowActsThroughTheConsole() throws {
        let view = try source(app + "Views/Console/PendingTrayView.swift")
        XCTAssertTrue(view.contains("await console.steerQueued(row.bubble)"), "Steer")
        XCTAssertTrue(view.contains("await console.withdrawSteer(row.bubble)"), "a steer's Withdraw")
        XCTAssertTrue(view.contains("await console.cancelQueued(row.bubble)"), "a queued message's Withdraw")

        let model = try source(app + "ConsoleModel.swift")
        XCTAssertTrue(model.contains("try await api.steerQueuedTurn(sessionID: sessionID, turnId: turnId)"))
        XCTAssertTrue(model.contains("reducer.markQueuedSteered(turnId: turnId)"))
        // A withdrawn queued message's words come back under the draft, as a withdrawn steer's do.
        XCTAssertTrue(model.contains("? body : composerText + \"\\n\\n\" + body"))
    }

    func testSendCarriesTheOtherWayToSendWhileATurnRuns() throws {
        let composer = try source(app + "Views/ComposerView.swift")
        XCTAssertTrue(composer.contains(".contextMenu {"))
        XCTAssertTrue(composer.contains("await console.send(authoritative: status, queueForNextTurn: true)"))
        XCTAssertTrue(composer.contains("Label(\"Queue for next turn\""))
        XCTAssertTrue(composer.contains("SteerDelivery.runtimeTakesMidTurnSteer(console.engine)"),
                      "offered only where the message would otherwise go into the turn")
    }
}
