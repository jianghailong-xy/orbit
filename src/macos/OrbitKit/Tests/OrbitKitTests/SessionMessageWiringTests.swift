import Foundation
import XCTest

/// Both native shells draw another session's message as its card — and only a turn that carries one.
///
/// The model half is `SessionMessageTests`; this is the view half, and it reads source, because
/// SwiftUI does not exist on Linux and `ConsoleView.swift` and `SessionMessageCardView.swift` are
/// compiled only by the macOS and iOS jobs (`client.yml`). It cannot see layout. What it holds is the
/// wiring a compiler would let drift in silence: the transcript asks for the card before anything
/// else and falls through to the old bubble without one, the card's title is the way into the
/// sending session, and the iOS target still compiles the one shared copy of both files.
final class SessionMessageWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found above this test. If it moved, move this check with it "
                    + "rather than deleting it: it is the only gate on Linux that sees whether a "
                    + "message from another session is still drawn as one."
            }
        }
    }

    private static let consolePath = "src/macos/OrbitApp/Sources/OrbitApp/Views/Console/ConsoleView.swift"
    private static let rowPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/Console/UserTurnRow.swift"
    private static let cardPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/SessionMessageCardView.swift"
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

    /// One stretch of a file, so a match somewhere else cannot answer for the part being asserted
    /// about.
    private func section(_ source: String, from: String, to: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw WiringError.missing("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    /// The lines of one stretch that are CODE: a call that is commented out still contains its own
    /// words, so every assertion below is made over these and never over the raw slice.
    private func statements(_ source: String) -> [String] {
        source.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("//") }
    }

    func testTheTranscriptAsksForTheCardFirstAndKeepsTheBubbleWithoutOne() throws {
        // The transcript draws a user turn with the one row both states share (`UserTurnRow`).
        let view = try section(try source(Self.consolePath),
                               from: "struct TranscriptItemView: View", to: "case .assistant(let b)")
        XCTAssertTrue(statements(view).contains("UserTurnRow(bubble: b)"),
                      "the transcript no longer draws a user turn with the row that asks for the card")
        let row = try section(try source(Self.rowPath), from: "struct UserTurnRow: View", to: "private func attachedRest")
        let user = statements(try section(row, from: "var body: some View {",
                                          to: "UserBubbleView(bubble: b, onCancelQueued: cancel)\n"))
        let first = try XCTUnwrap(user.firstIndex { $0.hasPrefix("if ") }, "the row asks nothing about the turn")
        XCTAssertEqual(user[first], "if let card = b.sessionMessage {",
                       "the card is no longer the first thing a user turn is asked about")
        // The branch itself: the card, drawn from the turn's own words and note, and then on to the
        // readings every other turn has always had.
        XCTAssertEqual(Array(user[(first + 1)...].prefix(4)), [
            "SessionMessageCardView(card: card, text: b.text, ts: b.ts,",
            "undelivered: undelivered,",
            "attached: b.attached, onCancelQueued: cancel)",
            "} else if let card = b.itemCard {",
        ], "a turn with a sender is not drawn as the session-message card")
        XCTAssertTrue(row.contains("UserBubbleView(bubble: b, onCancelQueued: cancel)"),
                      "a turn with no sender lost its bubble")
        // Not behind a platform: one branch, drawn by both shells.
        XCTAssertFalse(user.contains { $0.hasPrefix("#if") }, "the card is drawn on one platform only")
    }

    /// While it waits in the queue it is the same card — the queued row is the transcript's own row,
    /// which asks for it before the shapes its words could take — with the queue's Cancel at its foot.
    func testTheQueuedRowDrawsTheCardFirstWithItsCancel() throws {
        let row = statements(try section(try source(Self.consolePath),
                                         from: "case .queued(let bubble):", to: "case .bottom:"))
        XCTAssertEqual(Array(row.dropFirst()), [
            "UserTurnRow(bubble: bubble, queued: QueuedControls(bubble: bubble) {",
            "Task { await console.cancelQueued(bubble) }",
            "})",
        ], "a queued message from another session is not drawn by the row that draws its card")
        let controls = statements(try section(try source(Self.rowPath),
                                              from: "struct QueuedControls", to: "struct UserTurnRow"))
        XCTAssertTrue(controls.contains("onCancel = bubble.turnId == nil || bubble.steer ? nil : cancel"),
                      "a queued message from another session is offered a Cancel the server refuses: "
                          + "none for a steer, nor before the turn id is known")
        // Cancel is the console's ordinary withdraw, whose composer rule keeps the words out
        // (`QueuedTurnRestoreTests`); the card offers it only while the message is still queued.
        let card = statements(try source(Self.cardPath))
        XCTAssertTrue(card.contains("var onCancelQueued: (() -> Void)? = nil"))
        XCTAssertTrue(card.contains("if let onCancelQueued { queuedFoot(onCancelQueued) }"),
                      "the queued card offers no way to withdraw it")
    }

    func testTheBarAndItsAnchorsAreHandedTheSender() throws {
        let console = try source(Self.consolePath)
        let anchor = try section(console, from: "private func namesAQuestion", to: "private var stuckBubble")
        XCTAssertTrue(anchor.contains("sessionMessage: b.sessionMessage"),
                      "the bar's anchor test no longer knows a turn came from another session")
        let bar = try section(console, from: "let summary = StickySummary.of(", to: "CoastingButton")
        XCTAssertTrue(bar.contains("sessionMessage: bubble.sessionMessage"),
                      "the bar would call another session's message \"Your question\"")
    }

    func testTheTitleOpensTheSendingSession() throws {
        let card = statements(try source(Self.cardPath))
        XCTAssertTrue(card.contains("if let url = SessionMessageCard.sessionLink(card) {"),
                      "the sender's title is no longer a link to the sending session")
        XCTAssertTrue(card.contains("openURL(url)"), "the link opens nowhere")
        XCTAssertTrue(card.contains("Text(SessionMessageCard.title(card))"))
        XCTAssertFalse(card.contains { $0.hasPrefix("#if os(") }, "the card differs by platform")
    }

    /// ONE CARD FOR BOTH NATIVE CLIENTS. iOS has no copy of its own: its target compiles
    /// `../macos/OrbitApp/Sources/OrbitApp` in place and excludes the macOS-only files, so the card
    /// drawn above is what a phone draws too — unless somebody adds either file to that exclude list,
    /// which is the one way the two could come apart without a compiler saying so.
    func testBothNativeClientsDrawTheOneCard() throws {
        let project = try source(Self.iosProject)
        let sources = try section(project, from: "    sources:", to: "    dependencies:")
        XCTAssertTrue(sources.contains("path: ../macos/OrbitApp/Sources/OrbitApp"),
                      "the iOS client must still reuse the shared shell rather than a second copy of it")
        XCTAssertFalse(sources.contains("SessionMessageCardView.swift"),
                       "the iOS target no longer compiles the session-message card")
        XCTAssertFalse(sources.contains("ConsoleView.swift"),
                       "the iOS target no longer compiles the transcript that draws the card")
    }
}
