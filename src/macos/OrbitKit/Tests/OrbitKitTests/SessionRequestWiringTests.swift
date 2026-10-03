import Foundation
import XCTest

/// Both native shells draw session requests — and only where a turn carries one.
///
/// The model half is `SessionRequestTests`; this is the view half, and it reads source, because
/// SwiftUI does not exist on Linux and the OrbitApp views are compiled only by the macOS and iOS jobs
/// (`client.yml`). What it holds is the wiring a compiler would let drift in silence: the transcript
/// draws reply cards for a turn that handed outcomes back (after the cards the session-message wiring
/// test pins, so neither check moves the other); the "From" card shows the request's state when the
/// message is one; and none of it gives the owner a way to answer for a session.
final class SessionRequestWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found above this test. If it moved, move this check with it "
                    + "rather than deleting it: it is the only gate on Linux that sees the request cards."
            }
        }
    }

    private static let consolePath = "src/macos/OrbitApp/Sources/OrbitApp/Views/Console/ConsoleView.swift"
    private static let messageCardPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/SessionMessageCardView.swift"
    private static let replyCardPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/SessionReplyCardView.swift"
    private static let iosProject = "src/ios/project.yml"

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

    private func section(_ source: String, from: String, to: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw WiringError.missing("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    /// The lines of one stretch that are CODE, so a call that is commented out does not count.
    private func statements(_ source: String) -> [String] {
        source.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("//") }
    }

    func testTheTranscriptDrawsReplyCardsForATurnThatHandedOutcomesBack() throws {
        let view = try section(try source(Self.consolePath),
                               from: "struct TranscriptItemView: View", to: "case .assistant(let b)")
        let user = statements(try section(view, from: "case .user(let b):", to: "UserBubbleView(bubble: b)\n"))
        let branch = try XCTUnwrap(user.firstIndex(of: "} else if let replies = b.sessionReplies, !replies.isEmpty {"),
                                   "a turn that handed outcomes back is not drawn as reply cards")
        // After the cards whose own wiring test pins the first branches, before the readings of text.
        let started = try XCTUnwrap(user.firstIndex(of: "} else if let started = b.startedCard {"))
        let watch = try XCTUnwrap(user.firstIndex(where: { $0.hasPrefix("} else if let wake = WatchWakeText.parse(") }))
        XCTAssertTrue(started < branch && branch < watch, "the reply-card branch moved out of its place")
        let body = user[branch..<watch].joined(separator: "\n")
        XCTAssertTrue(body.contains("SessionReplyCardsView(replies: replies, ts: b.ts, attached: replyRest(b))"))
        // The owner's own words, when the turn had any, stay theirs — without the note the cards drew.
        XCTAssertTrue(body.contains("UserBubbleView(bubble: withoutNote(b))"))
        XCTAssertFalse(user.contains { $0.hasPrefix("#if") }, "the cards are drawn on one platform only")
    }

    func testTheFromCardShowsTheRequestWhenTheMessageIsOne() throws {
        let card = statements(try source(Self.messageCardPath))
        XCTAssertTrue(card.contains("if let requestId = card.requestId {"))
        XCTAssertTrue(card.contains("SessionRequestStatusView(requestId: requestId)"))
    }

    func testTheStatusIsReadLiveAndRefreshedWhenTheAskedSessionMoves() throws {
        let file = try source(Self.replyCardPath)
        let status = statements(try section(file, from: "struct SessionRequestStatusView: View", to: "struct SessionReplyCardsView"))
        XCTAssertTrue(status.contains("if let fresh = try? await api.sessionRequest(requestId) { request = fresh }"))
        XCTAssertTrue(status.contains(".task(id: refreshKey) { await load() }"),
                      "the state is no longer read again when the request's session moves")
        XCTAssertTrue(status.contains { $0.contains("model.session(id: $0.toSessionId)") })
        XCTAssertTrue(status.contains { $0.contains("owesReplyTo") })
    }

    func testTheReplyCardOpensTheOriginalRequestAndOffersNothingToAnswer() throws {
        let file = try source(Self.replyCardPath)
        let card = statements(try section(file, from: "struct SessionReplyCardView: View", to: "\n}\n"))
        XCTAssertTrue(card.contains("if let url = SessionRequestCopy.requestLink(reply) {"))
        XCTAssertTrue(card.contains("Button(SessionRequestCopy.openRequest) { openURL(url) }"))
        // Read-only, both cards: the owner does not answer for a session (contract §9.3). Over the
        // code only: the file's header names the GET the status line reads.
        let code = statements(file).joined(separator: "\n")
        for control in ["TextField", "TextEditor", "sessionReply(", "session-requests/"] {
            XCTAssertFalse(code.contains(control), "a request card offers \(control)")
        }
    }

    func testBothNativeClientsDrawTheOneCard() throws {
        let project = try source(Self.iosProject)
        let sources = try section(project, from: "    sources:", to: "    dependencies:")
        XCTAssertTrue(sources.contains("path: ../macos/OrbitApp/Sources/OrbitApp"))
        XCTAssertFalse(sources.contains("SessionReplyCardView.swift"),
                       "the iOS target no longer compiles the request cards")
    }
}
