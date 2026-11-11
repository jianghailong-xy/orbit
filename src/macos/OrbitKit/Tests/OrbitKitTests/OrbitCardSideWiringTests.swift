import Foundation
import XCTest

/// The cards Orbit hands a conversation — an exception item, a task's start, the project's start, a
/// confirmation review's request and return, another session's message — sit on the agent's side, in
/// the reply column at its full width: the right side is the owner's own words only
/// (docs/mocks/orbit-cards-left, approved 2026-11-11; the browser's `.oic/.tsc/.psc/.crc/.smc-wrap`
/// moved left to match). Natively they always filled the column; the owner's bubble is the one view
/// that pushes itself right (`UserBubbleView`'s leading Spacer).
///
/// SwiftUI does not exist on Linux, so this reads source, like `UserTurnRowWiringTests`: each card's
/// outermost frame fills from the leading edge, and none of them takes the bubble's right-side spacer.
final class OrbitCardSideWiringTests: XCTestCase {

    private static let views = "src/macos/OrbitApp/Sources/OrbitApp/Views"
    private static let cards: [(file: String, view: String)] = [
        ("OpenItemDeliveryCardView.swift", "struct OpenItemDeliveryCardView"),
        ("TaskStartCardView.swift", "struct TaskStartCardView"),
        ("ProjectStartedCardView.swift", "struct ProjectStartedCardView"),
        ("ConfirmationReviewTurnCardViews.swift", "struct ReviewRequestedCardView"),
        ("ConfirmationReviewTurnCardViews.swift", "struct SentBackByReviewerCardView"),
        ("SessionMessageCardView.swift", "struct SessionMessageCardView"),
    ]

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir.deleteLastPathComponent()
        }
        throw XCTSkip("\(relative) is not in this checkout")
    }

    /// The text of one view's `body`, from its `var body` to the next declaration at the same depth.
    private func body(of view: String, in text: String) throws -> String {
        guard let start = text.range(of: view) else { XCTFail("\(view) not found"); return "" }
        let rest = text[start.upperBound...]
        guard let bodyStart = rest.range(of: "var body: some View {") else { XCTFail("\(view) has no body"); return "" }
        let after = rest[bodyStart.upperBound...]
        // The body ends at the first line that closes it at four spaces of indent.
        let end = after.range(of: "\n    }\n") ?? after.endIndex..<after.endIndex
        return String(after[..<end.lowerBound])
    }

    func testOrbitsCardsFillTheReplyColumnFromTheLeadingEdge() throws {
        for card in Self.cards {
            let text = try source(Self.views + "/" + card.file)
            let body = try body(of: card.view, in: text)
            XCTAssertTrue(body.contains(".frame(maxWidth: .infinity, alignment: .leading)"),
                          "\(card.view) no longer fills the reply column from the leading edge")
            XCTAssertFalse(body.contains("Spacer(minLength: 60)") || body.contains("alignment: .trailing)"),
                           "\(card.view) pushes itself to the owner's side, which is the owner's words only")
        }
    }

    func testOnlyTheOwnersBubbleTakesTheRightSide() throws {
        let bubbles = try source(Self.views + "/Console/MessageBubbles.swift")
        let owner = try body(of: "struct UserBubbleView", in: bubbles)
        XCTAssertTrue(owner.contains("Spacer(minLength: 60)"),
                      "the owner's bubble no longer pushes itself right; check docs/mocks/orbit-cards-left")
    }
}
