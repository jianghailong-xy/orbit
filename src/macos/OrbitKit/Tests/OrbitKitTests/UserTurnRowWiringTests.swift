import Foundation
import XCTest
@testable import OrbitKit

/// Both native shells decide which card a user turn is in ONE place, `UserTurnRow`, for a turn the
/// transcript holds and for one still waiting on the queue — and the queue adds only its Cancel,
/// which a steer never gets.
///
/// The model half is `QueuedTurnCardsTests` (every card reaches the queued `UserBubble`); this is the
/// view half, and it reads source, because SwiftUI does not exist on Linux and the OrbitApp views are
/// compiled only by the macOS and iOS jobs (`client.yml`). What it holds is what a compiler lets drift
/// in silence: a second chain growing back beside the first, a card the queue carries that the row
/// never asks about, and a Cancel built anywhere but `QueuedControls`.
final class UserTurnRowWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found above this test. If it moved, move this check with it "
                    + "rather than deleting it: it is the only gate on Linux that sees whether a queued "
                    + "turn and a delivered one are still drawn by the same row."
            }
        }
    }

    private static let app = "src/macos/OrbitApp/Sources/OrbitApp"
    private static let rowPath = app + "/Views/Console/UserTurnRow.swift"
    private static let consolePath = app + "/Views/Console/ConsoleView.swift"
    private static let taskStartCardPath = app + "/Views/TaskStartCardView.swift"
    private static let iosProject = "src/ios/project.yml"

    /// The cards a user turn can be drawn as.
    private static let cardViews = [
        "SessionMessageCardView(", "OpenItemDeliveryCardView(", "TaskStartCardView(",
        "ProjectStartedCardView(", "ReviewRequestedCardView(", "SentBackByReviewerCardView(",
        "SessionReplyCardsView(", "WatchWakeCardView(", "BackgroundWakeCardView(",
    ]

    private func path(_ relative: String) throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            dir = dir.deletingLastPathComponent()
        }
        throw WiringError.missing(relative)
    }

    private func source(_ relative: String) throws -> String {
        try String(contentsOf: try path(relative), encoding: .utf8)
    }

    /// One stretch of a file, so a match somewhere else cannot answer for the part being asserted about.
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

    private var rowBody: [String] {
        get throws {
            statements(try section(try source(Self.rowPath),
                                   from: "var body: some View {", to: "private func attachedRest"))
        }
    }

    /// ONE CHAIN. The transcript and the queued tail both hand the turn to the row, and nothing else in
    /// the app builds a user turn's card: a second chain is how each card used to reach the queue late,
    /// or never.
    func testTheTranscriptAndTheQueueDrawAUserTurnThroughTheOneRow() throws {
        let console = statements(try source(Self.consolePath))
        XCTAssertTrue(console.contains("UserTurnRow(bubble: b)"),
                      "the transcript no longer draws a user turn with the row")
        XCTAssertTrue(console.contains("UserTurnRow(bubble: bubble, queued: QueuedControls(bubble: bubble) {"),
                      "the queued tail no longer draws its turn with the row the transcript draws it with")
        XCTAssertEqual(console.filter { $0.contains("UserTurnRow(") }.count, 2)
        XCTAssertFalse(console.contains { $0.contains("UserBubbleView(") },
                       "the console draws a user turn's bubble outside the row")

        let root = try path(Self.app)
        let files = (FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?
            .compactMap { $0 as? URL } ?? [])
            .filter { $0.pathExtension == "swift" && $0.lastPathComponent != "UserTurnRow.swift" }
        XCTAssertGreaterThan(files.count, 50, "the walk found almost none of the app's sources")
        for file in files {
            let code = statements(try String(contentsOf: file, encoding: .utf8)).joined(separator: "\n")
            for view in Self.cardViews where code.contains(view) {
                XCTFail("\(file.lastPathComponent) builds \(view)…) itself — a second place deciding "
                    + "which card a user turn is. Draw the turn with UserTurnRow instead.")
            }
        }
    }

    /// Every card the queue carries onto a `UserBubble` (`TurnCards`) is one the row asks about: a card
    /// added there and to the echo but never asked about here is a turn drawn as the owner's bubble.
    func testTheRowAsksAboutEveryCardTheQueueCarries() throws {
        let code = try rowBody.joined(separator: "\n")
        for case let field? in Mirror(reflecting: TurnCards()).children.map(\.label) {
            XCTAssertTrue(code.contains(" = b.\(field)"), "the row never asks whether the turn is a \(field)")
        }
    }

    /// The queue adds only its Cancel, built in one place — none until the turn id is known, none for a
    /// steer, which the server refuses to withdraw — and every card is handed that one, never its own.
    func testEveryCardTakesTheQueuesOneCancelAndASteerGetsNone() throws {
        let controls = statements(try section(try source(Self.rowPath),
                                              from: "struct QueuedControls", to: "struct UserTurnRow"))
        XCTAssertTrue(controls.contains("onCancel = bubble.turnId == nil || bubble.steer ? nil : cancel"),
                      "a steer, or a turn whose id is not known yet, is offered a Cancel")

        let body = try rowBody
        XCTAssertTrue(body.contains("let cancel: (() -> Void)? = queued?.onCancel"))
        let code = body.joined(separator: "\n")
        XCTAssertFalse(code.contains("cancelQueued"), "the row builds a Cancel of its own")
        let handed = try NSRegularExpression(pattern: "(?:onCancelQueued|onWithdraw): ([^,)\\n]+)")
        let values = handed.matches(in: code, range: NSRange(code.startIndex..., in: code)).compactMap {
            Range($0.range(at: 1), in: code).map { String(code[$0]) }
        }
        // Each card, and the owner's own bubble last.
        XCTAssertEqual(values.count, Self.cardViews.count + 1, "a card is drawn with no Cancel while queued")
        XCTAssertEqual(Set(values), ["cancel"], "a card is handed a Cancel that is not the queue's")
    }

    /// A queued turn's words still hold the blocks delivery moves into the note, and the card draws
    /// them: no bubble of the owner's under a queued reply turn or wake.
    func testAQueuedTurnDrawsNoBubbleForTheBlocksItsCardDraws() throws {
        let body = try rowBody
        XCTAssertTrue(body.contains("if queued == nil, !b.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {"),
                      "a queued reply turn draws its blocks as the owner's bubble")
        XCTAssertTrue(body.contains("if queued == nil, BackgroundWakeCard.drawsBubble(text: b.text) {"),
                      "a queued wake draws its block as the owner's bubble")
        XCTAssertTrue(body.contains("queued: queued != nil)"), "a queued wake is not drawn dashed")
    }

    /// A resumed run's brief waits on the queue as its card, with the queue's line at the foot.
    func testTheTaskStartCardCarriesTheQueuesLine() throws {
        let card = statements(try source(Self.taskStartCardPath))
        XCTAssertTrue(card.contains("var onCancelQueued: (() -> Void)?"))
        XCTAssertTrue(card.contains("if let onCancelQueued { queuedFoot(onCancelQueued) }"),
                      "a queued brief offers no way to withdraw it")
        XCTAssertTrue(card.contains("style: StrokeStyle(lineWidth: 1, dash: queued ? [4, 3] : []))"),
                      "a queued brief is not drawn dashed, as the other queued cards are")
    }

    /// ONE ROW FOR BOTH NATIVE CLIENTS: the iOS target compiles the shared shell in place, so the row is
    /// what a phone draws too — unless somebody adds it to that target's list of macOS-only files.
    func testBothNativeClientsDrawTheOneRow() throws {
        let project = try source(Self.iosProject)
        let sources = try section(project, from: "    sources:", to: "    dependencies:")
        XCTAssertTrue(sources.contains("path: ../macos/OrbitApp/Sources/OrbitApp"),
                      "the iOS client must still reuse the shared shell rather than a second copy of it")
        XCTAssertFalse(sources.contains("UserTurnRow.swift"), "the iOS target no longer compiles the row")
    }
}
