import Foundation
import XCTest
@testable import OrbitKit

/// The owner-request doors after "Waiting on you" left the navigation: a link, a push's action and
/// the Later reminder all open the conversation that asked, on the request's row. Source checks
/// cover the SwiftUI/AppKit connections OrbitKit cannot compile; what a door resolves to is tested
/// in `OwnerRequestsTests` and `Notifications`.
final class OwnerRequestDoorsWiringTests: XCTestCase {
    private struct SourceMissing: Error { let path: String }

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir.deleteLastPathComponent()
        }
        throw SourceMissing(path: relative)
    }

    private func appSource(_ relative: String) throws -> String {
        try source("src/macos/OrbitApp/Sources/OrbitApp/\(relative)")
    }

    private func slice(_ text: String, from start: String, to end: String,
                       file: StaticString = #filePath, line: UInt = #line) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`", file: file, line: line)
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`", file: file, line: line)
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    // MARK: no entry, row or sheet left

    func testTheNavigationNoLongerDrawsAnOwnerRequestEntryOrSheet() throws {
        let removed = ["OwnerRequestInboxEntry", "OwnerRequestInboxSheet", "OwnerRequestInboxView",
                       "ownerRequestInboxSheet", "inboxPresented", "focusedRequestID",
                       "waitingOnYouRow", "owner-request-inbox-entry", "waitingCount"]
        for relative in ["Views/MainView.swift", "Views/CompactShell.swift", "Views/OwnerRequestViews.swift",
                         "OrbitApp.swift", "OwnerRequestsModel.swift", "AppModel.swift"] {
            let text = try appSource(relative)
            for needle in removed {
                XCTAssertFalse(text.contains(needle), "\(relative) still names `\(needle)`")
            }
        }
        let ios = try source("src/ios/Sources/OrbitiOSApp.swift")
        XCTAssertFalse(ios.contains("ownerRequestInboxSheet"), "the iOS shell still raises the sheet")
        XCTAssertFalse(ios.contains("inboxPresented"), "the iOS shell still raises the sheet")
    }

    // MARK: the link, the push action and the reminder share one door

    func testTheOwnerRequestDoorOpensTheAskingSessionOnItsRow() throws {
        let app = try appSource("AppModel.swift")
        let door = try slice(app, from: "func openOwnerRequest(_ id: String) {", to: "\n    }")
        // Only the id is known: a request the account's lists do not hold is read first.
        XCTAssertTrue(door.contains("await ownerRequests?.read(id)"))
        XCTAssertTrue(door.contains("open(ownerRequest: request)"))

        let open = try slice(app, from: "private func open(ownerRequest: OwnerRequest) {", to: "\n    }")
        XCTAssertTrue(open.contains("let sessionID = PublicID.toPublic(ownerRequest.askedBySessionId)"))
        XCTAssertTrue(open.contains(".focus(ownerRequestID: ownerRequest.id)"))
        XCTAssertTrue(open.contains("route(to: .session(sessionID))"))
    }

    func testTheConsoleHoldsTheRequestUntilItsRowIsDrawn() throws {
        let console = try appSource("ConsoleModel.swift")
        XCTAssertTrue(console.contains("private(set) var ownerRequestRequest: ScrollRequest?"))
        let focus = try slice(console, from: "func focus(ownerRequestID: String) {", to: "\n    }")
        XCTAssertTrue(focus.contains("DeliveredDecisionCard(kind: .ownerRequest(requestID: PublicID.toPublic(ownerRequestID))).id"))
        let adopt = try slice(console, from: "func adoptOwnerRequests(_ requests: [OwnerRequest]) {", to: "\n    }")
        XCTAssertTrue(adopt.contains("ownerRequestRequest = ScrollRequest(rowID: request.rowID, tick: scrollTick)"),
                      "the press is re-issued once the request read has drawn its row")

        let view = try appSource("Views/Console/ConsoleView.swift")
        XCTAssertTrue(view.contains(".onChange(of: console.ownerRequestRequest, initial: true) { _, request in"))
        XCTAssertTrue(view.contains("console.ownerRequestRequestFollowed()"))
    }

    func testTheModelReadsARequestItDoesNotHold() throws {
        let model = try appSource("OwnerRequestsModel.swift")
        let read = try slice(model, from: "func read(_ id: String) async -> OwnerRequest? {", to: "\n    }")
        XCTAssertTrue(read.contains("if let known = request(id) { return known }"))
        XCTAssertTrue(read.contains("try? await api.ownerRequest(id)"))
        XCTAssertTrue(read.contains("adopt(read)"))
    }
}
