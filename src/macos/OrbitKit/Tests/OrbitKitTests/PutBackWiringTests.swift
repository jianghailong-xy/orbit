import Foundation
import XCTest

/// "Put back in the composer", as OrbitApp draws it (docs/mocks/put-back-ios, decided 2026-10-17). SwiftUI does
/// not build on Linux, so these read the app's sources: the meta row under a bubble offers it beside
/// "Not delivered", says "Couldn't confirm it was read" in the warning tone, and a receipt's row says
/// why; the console's rows hand it the press; the console puts the words back and discards a receipt.
/// `PutBackTests` holds the rules themselves.
final class PutBackWiringTests: XCTestCase {
    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw NSError(domain: "PutBackWiringTests", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "\(relative) not found"])
    }

    private let app = "src/macos/OrbitApp/Sources/OrbitApp/"

    func testTheMetaRowOffersItBesideWhatItSays() throws {
        let bubbles = try source(app + "Views/Console/MessageBubbles.swift")
        XCTAssertTrue(bubbles.contains("Text(\"Put back in the composer\").font(.orbitMeta)"))
        // Beside "Not delivered", and beside "Couldn't confirm it was read" — which is said in the
        // warning tone now, as web's and Android's are.
        let notDelivered = try XCTUnwrap(bubbles.range(of: "Label(SteerDelivery.state(\"failed\").label, systemImage: \"exclamationmark.circle\")"))
        let firstOffer = try XCTUnwrap(bubbles.range(of: "putBackButton", range: notDelivered.upperBound..<bubbles.endIndex))
        XCTAssertLessThan(bubbles.distance(from: notDelivered.upperBound, to: firstOffer.lowerBound), 120)
        XCTAssertTrue(bubbles.contains("} else if SteerDelivery.state(bubble.delivery).tone == .failed {"))
        XCTAssertTrue(bubbles.contains("Label(SteerDelivery.state(bubble.delivery).label, systemImage: \"exclamationmark.circle\")"))
        // A receipt's row says why, under the line that says it did not land.
        XCTAssertTrue(bubbles.contains("SteerDelivery.failureExplanation(code: bubble.deliveryCode, reason: bubble.deliveryReason)"))
        XCTAssertTrue(bubbles.contains("meta\n                why\n"))
    }

    func testTheConsolesRowsHandItThePress() throws {
        let console = try source(app + "Views/Console/ConsoleView.swift")
        XCTAssertTrue(console.contains("}, putBack: putBack(bubble))"), "the queued tail")
        XCTAssertTrue(console.contains("UserTurnRow(bubble: b, steer: steerControls(b), putBack: putBack(b))"),
                      "the conversation")
        // Each asks the one rule before it hands the press on.
        XCTAssertEqual(console.components(separatedBy: "guard SteerDelivery.offersPutBack(bubble) else { return nil }").count, 2,
                       "the queued tail's")
        XCTAssertEqual(console.components(separatedBy: "guard let console, SteerDelivery.offersPutBack(bubble) else { return nil }").count, 2,
                       "the conversation's")
        XCTAssertEqual(console.components(separatedBy: "return { Task { await console.putBack(bubble) } }").count, 3)
        let row = try source(app + "Views/Console/UserTurnRow.swift")
        XCTAssertTrue(row.contains("UserBubbleView(bubble: b, onCancelQueued: cancel, steer: steer, onPutBack: putBack)"))
    }

    func testTheConsolePutsTheWordsBackAndDiscardsAReceipt() throws {
        let model = try source(app + "ConsoleModel.swift")
        let start = try XCTUnwrap(model.range(of: "func putBack(_ bubble: UserBubble) async {"))
        let body = String(model[start.upperBound...].prefix(1200))
        XCTAssertTrue(body.contains("? body : composerText + \"\\n\\n\" + body"), "under any draft")
        XCTAssertTrue(body.contains("reducer.removeQueued(id: bubble.id)"), "a row at the tail goes")
        XCTAssertTrue(body.contains("guard bubble.delivery != nil, let turnId = bubble.turnId else { return }"))
        XCTAssertTrue(body.contains("try await api.withdrawTurn(sessionID: sessionID, turnId: turnId)"))
        XCTAssertTrue(body.contains("ToastRequest(message: \"Couldn't discard the message\""))
    }
}
