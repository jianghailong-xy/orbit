import Foundation
import XCTest

/// The tray above the composer, as OrbitApp draws it (docs/mocks/steer-tray, decided 2026-10-16).
/// SwiftUI does not build on Linux, so these read the app's sources: the tray is the band's first card,
/// above the parking strip (docs/mocks/pending-tray-above-parking, decided 2026-10-28), its rows act
/// through the console, and Send carries the other way to send a message while a turn runs.
/// `PendingTrayTests` holds the rows themselves.
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

    func testTheTrayIsTheBandsFirstCardAboveTheParkingStrip() throws {
        let console = try source(app + "Views/Console/ConsoleView.swift")
        let band = try XCTUnwrap(console.range(of: "ComposerBand {"))
        let tray = try XCTUnwrap(console.range(of: "PendingTrayView(console: console, rows: console.pendingTrayRows("))
        let banner = try XCTUnwrap(console.range(of: "if let managed = console.managed, managed.showsBanner {"))
        XCTAssertLessThan(band.lowerBound, tray.lowerBound)
        XCTAssertLessThan(tray.lowerBound, banner.lowerBound, "the band's first card, right under the conversation")
        let strip = try XCTUnwrap(console.range(of: "WatchingCardStack(sessionID: console.sessionID)"))
        XCTAssertLessThan(tray.lowerBound, strip.lowerBound, "above the parking strip")
        let fold = try XCTUnwrap(console.range(of: ".modifier(TypingFold(folded: foldsChrome(console)))"))
        let folded = try XCTUnwrap(console.range(of: "VStack(spacing: 0) {", range: banner.upperBound..<fold.lowerBound))
        XCTAssertLessThan(tray.lowerBound, folded.lowerBound, "and is not folded away while typing")
        XCTAssertEqual(console.components(separatedBy: "PendingTrayView(").count - 1, 1, "drawn once")

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
