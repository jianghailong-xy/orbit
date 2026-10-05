import Foundation
import XCTest

/// When the transcript scrolls — the wire behind TestFlight crash D8B79F89 (0.1.2 build 4028,
/// iOS 26.6.1: SIGABRT 4.9s after launch, `NSInternalInconsistencyException` out of
/// `-[UICollectionView _validateScrollingTargetIndexPath:]` under SwiftUI's
/// `UpdateCoalescingCollectionView.updateContent()`, no Orbit frame on the stack).
///
/// `ScrollViewProxy.scrollTo` on the iOS transcript `List` picks the row's index path when it is
/// CALLED and scrolls when the List next updates. Called from inside an update — an `onChange` or
/// `onAppear` action, after the List has taken that update's rows — both halves see the same rows.
/// Called from outside one, a publish that lands in between and removes rows leaves the picked index
/// past the end of the list, and UIKit aborts. A simulator replica of this view measured both: no
/// stale index from an in-update scroll in 1,193 of them, and stale, out-of-bounds ones as soon as the
/// same scrolls were made from a main-queue hop.
///
/// SwiftUI does not exist on Linux and `ConsoleView.swift` is compiled only by the macOS and iOS
/// jobs, so the rule is asserted over the source, each check written so that putting a scroll back
/// outside an update is what turns it red.
final class TranscriptScrollWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found above this test. If it moved, move this check with "
                    + "it rather than deleting it: it is the only gate on Linux that sees whether "
                    + "the transcript still scrolls only from inside an update."
            }
        }
    }

    private static let viewPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/Console/ConsoleView.swift"
    private static let consolePath = "src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift"

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

    /// One stretch of a file, so a match elsewhere cannot answer for the part being asserted about.
    private func section(_ source: String, from: String, to: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw WiringError.missing("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    /// The code with its comments taken out: several comments NAME `proxy.scrollTo`, and a sentence
    /// is not a call. (`://` is a URL in a string, not a comment.)
    private func code(_ source: String) -> String {
        source.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
            var from = line.startIndex
            while let slashes = line.range(of: "//", range: from..<line.endIndex) {
                if slashes.lowerBound > line.startIndex, line[line.index(before: slashes.lowerBound)] == ":" {
                    from = slashes.upperBound
                    continue
                }
                return String(line[..<slashes.lowerBound])
            }
            return String(line)
        }.joined(separator: "\n")
    }

    /// Every block that opens with `opener` (which ends in `{`), braces balanced, opener included.
    private func blocks(opening opener: String, in code: String) -> [String] {
        var found: [String] = []
        var from = code.startIndex
        while let start = code.range(of: opener, range: from..<code.endIndex) {
            var depth = 0
            var end = code.endIndex
            var i = code.index(before: start.upperBound)   // the opener's own `{`
            while i < code.endIndex {
                if code[i] == "{" { depth += 1 }
                if code[i] == "}" {
                    depth -= 1
                    if depth == 0 { end = code.index(after: i); break }
                }
                i = code.index(after: i)
            }
            found.append(String(code[start.lowerBound..<end]))
            from = start.upperBound
        }
        return found
    }

    private func transcriptView() throws -> String {
        code(try section(try source(Self.viewPath),
                         from: "struct TranscriptView: View {",
                         to: "private struct CoastingButton"))
    }

    /// No scroll is made from a closure that runs outside an update. The main-queue hops stay — the
    /// coast fix needs the scroll a runloop after the halt, and a link's row needs the page it is on —
    /// but what they carry is a request, and the update that delivers it makes the scroll.
    func testNoTranscriptScrollIsMadeFromOutsideAnUpdate() throws {
        let view = try transcriptView()
        let hops = blocks(opening: "DispatchQueue.main.async {", in: view)
        XCTAssertGreaterThanOrEqual(hops.count, 4,
                                    "the hops of the needs-you bar, the record link, the sticky question "
                                        + "and the jump-to-latest disc were not all found")
        for closure in hops + blocks(opening: "Task {", in: view) {
            XCTAssertFalse(closure.contains("scrollTo("),
                           "a scroll made from a main-queue hop or a Task runs outside SwiftUI's update: "
                               + "its row becomes an index path against rows a pending publish can "
                               + "shrink — the out-of-bounds abort. Hand it to `holdScroll(to:anchor:)`:\n"
                               + closure)
        }
    }

    /// …and the held request is made inside the update that delivers it, by the one `.onChange`.
    func testTheHeldScrollIsMadeInsideTheNextUpdate() throws {
        let view = try transcriptView()
        let made = blocks(opening: ".onChange(of: heldScroll) {", in: view)
        XCTAssertEqual(made.count, 1, "one `.onChange(of: heldScroll)` makes every held scroll")
        XCTAssertTrue(made.first?.contains("proxy.scrollTo(held.rowID, anchor: held.anchor)") == true,
                      "the held row is scrolled to there, with the anchor it was asked for")
        XCTAssertGreaterThanOrEqual(view.components(separatedBy: "holdScroll(to:").count - 1, 4,
                                    "the four hops each carry their scroll as a held request")
    }

    /// The waiting-card bar is both a reading jump and an invitation to answer. Unpin before the
    /// next publish, halt iOS momentum, and carry the review request into the same safe update as
    /// the scroll; opening a sheet directly in the bar callback would race the row's relocation.
    func testTheWaitingCardJumpUnpinsBeforeDeferringItsScrollAndReview() throws {
        let view = try transcriptView()
        let callback = try XCTUnwrap(blocks(opening: ".onChange(of: console.scrollRequest) {",
                                            in: view).first)
        let ordered = ["atBottom = false", "transcriptScroll.halt()", "DispatchQueue.main.async",
                       "holdScroll(to: request.rowID, anchor: .center, opensReview: true)"]
        let positions = ordered.map { callback.range(of: $0)?.lowerBound }
        XCTAssertFalse(positions.contains(nil), "the waiting-card jump lost a step: \(ordered)")
        XCTAssertEqual(positions.compactMap { $0 }, positions.compactMap { $0 }.sorted(),
                       "unpin and halt before requesting the deferred scroll and review")
        XCTAssertFalse(callback.contains("scrollTo("), "the next List update owns the scroll")
        XCTAssertFalse(callback.contains("openReview("), "the review follows that update's scroll")
        XCTAssertFalse(callback.contains("openApprovalReview("))
        XCTAssertFalse(callback.contains("openPromotionReview("))
    }

    /// A card can disappear between the press and the next update. Only a row that survived may
    /// be scrolled to or opened, and the nonanimated scroll finishes before its sheet is raised.
    func testTheDeferredReviewUsesALiveRowAndScrollsBeforeOpening() throws {
        let view = try transcriptView()
        let update = try XCTUnwrap(blocks(opening: ".onChange(of: heldScroll) {", in: view).first)
        XCTAssertTrue(update.contains("guard let held, held.sessionID == console.sessionID else { return }"),
                      "a queued jump from the previous conversation must not open this one's sheet")
        let review = try XCTUnwrap(blocks(opening: "if held.opensReview {", in: update).first)
        let ordered = ["rows.first(where: { $0.id == held.rowID })",
                       "proxy.scrollTo(held.rowID, anchor: held.anchor)", "openReview(for: row)"]
        let positions = ordered.map { review.range(of: $0)?.lowerBound }
        XCTAssertFalse(positions.contains(nil), "the review lost its live row, scroll, or open: \(ordered)")
        XCTAssertEqual(positions.compactMap { $0 }, positions.compactMap { $0 }.sorted(),
                       "resolve the current row, reveal it, then open its review")
        XCTAssertTrue(review.contains("else { return }"), "a removed row must not open a stale review")
        XCTAssertFalse(review.contains("withAnimation"), "the sheet must not cover an unfinished scroll")
        XCTAssertEqual(view.components(separatedBy: "openReview(for:").count - 1, 1,
                       "only the held update may open the review after scrolling")
    }

    /// Record links, the sticky question, and jump-to-latest all use held scrolls too. Opening a
    /// review is opt-in only for the waiting-card bar; none of the reading jumps acquires a sheet.
    func testOrdinaryHeldScrollsDoNotOptIntoOpeningAReview() throws {
        let view = try transcriptView()
        XCTAssertTrue(view.contains("opensReview: Bool = false"),
                      "ordinary held scroll callers keep their existing reading-only behavior")
        XCTAssertEqual(view.components(separatedBy: "opensReview: true").count - 1, 1,
                       "only the waiting-card request opts into a review")
        let ordinary = try XCTUnwrap(blocks(opening: ".onChange(of: heldScroll) {", in: view).first)
        XCTAssertTrue(ordinary.contains("withAnimation(.easeOut(duration: 0.2))"),
                      "ordinary reading jumps retain their existing scroll animation")
    }

    /// Only cards drawn as previews have reviews. The merge keeps its existing sheet, the six
    /// other preview families share theirs, and inline evidence/exception/receipt rows only scroll.
    func testTheWaitingCardJumpOpensOnlyTheExistingPreviewSheets() throws {
        let view = try transcriptView()
        let route = try XCTUnwrap(blocks(opening: "private func openReview(for row: TranscriptRow) {",
                                         in: view).first)
        XCTAssertTrue(route.contains("guard case .decisionCard(let card) = row else { return }"),
                      "ordinary transcript rows and pending tool cards keep their inline behavior")
        let promotion = try section(route, from: "case .promotionApproval(let promotionID):",
                                    to: "case .criteriaDecision")
        XCTAssertTrue(promotion.contains("openPromotionReview(promotionID)"))
        XCTAssertFalse(promotion.contains("openApprovalReview("), "merge uses its own existing review")
        let shared = try section(route, from: "case .criteriaDecision", to: "default:")
        for kind in [".criteriaDecision", ".acceptanceConfirmation", ".startProject", ".criteriaChange",
                     ".ownerConfirmation", ".coordinatorQuestion"] {
            XCTAssertTrue(shared.contains(kind), "\(kind) has a preview and must open its review")
        }
        XCTAssertTrue(shared.contains("openApprovalReview(.delivered(card))"),
                      "the review receives the addressed card, not a copy of its displayed content")
        for inline in [".evidenceDecision", ".escalatedItem", ".fusePause", "Receipt", "case .approval"] {
            XCTAssertFalse(route.contains(inline), "\(inline) is inline and must not gain a sheet")
        }
        XCTAssertTrue(route.contains("default:\n            break"), "other rows remain scroll-only")
    }

    /// Both review sheets may refresh the console while they are open. Streaming after that read
    /// must not pull the transcript off the preview the owner will return to when closing the sheet.
    func testReviewPresentationKeepsThePreviewAwayFromTheLiveTail() throws {
        let source = code(try source(Self.viewPath))
        XCTAssertTrue(source.contains("reviewingCard: approvalReview != nil || promotionReview != nil"),
                      "both existing sheet hosts tell the transcript that the owner is reviewing")
        let view = try transcriptView()
        let follow = try XCTUnwrap(blocks(opening: ".onChange(of: console.stateRevision) {", in: view).first)
        XCTAssertTrue(follow.contains("if atBottom && !console.detached && !reviewingCard {"),
                      "a sheet's refresh or streamed update must not follow the live tail")
        let presentation = try XCTUnwrap(blocks(opening: ".onChange(of: reviewingCard, initial: true) {",
                                                in: view).first)
        let opened = try XCTUnwrap(blocks(opening: "if reviewingCard {", in: presentation).first)
        XCTAssertTrue(opened.contains("reviewSessionID = console.sessionID"),
                      "opening or restoring a sheet remembers the conversation being reviewed")
        XCTAssertTrue(opened.contains("atBottom = false"), "opening the review preserves its preview")
        let closed = try section(presentation, from: "} else {", to: "reviewSessionID = nil")
        let sameSession = "if reviewSessionID == console.sessionID { atBottom = false }"
        XCTAssertTrue(closed.contains(sameSession),
                      "closing a sheet only unpins the conversation that presented it")
        XCTAssertFalse(closed.replacingOccurrences(of: sameSession, with: "").contains("atBottom"),
                       "dismissing the old conversation's sheet must not unpin the new conversation")
        XCTAssertTrue(presentation.contains("reviewSessionID = nil"),
                      "the dismissed review releases its remembered conversation")
        let held = try XCTUnwrap(blocks(opening:
            "private func holdScroll(to rowID: String, anchor: UnitPoint, opensReview: Bool = false) {",
                                       in: view).first)
        XCTAssertTrue(held.contains("sessionID: console.sessionID, opensReview: opensReview"),
                      "the deferred request keeps its originating conversation and review intent")
    }

    /// The reading-history trim is published a turn later. `setReadingHistory` is called from inside
    /// the transcript's own update; a publish there lands between the scroll that update asks for next
    /// (`onAppear`, a session switch) and the List update that makes it, and the trim is the publish
    /// that removes the most rows — a thousand-row window's head.
    func testTheReadingHistoryTrimIsNotPublishedFromInsideTheTranscriptsUpdate() throws {
        let body = code(try section(try source(Self.consolePath),
                                    from: "func setReadingHistory(_ reading: Bool) {",
                                    to: "/// Enforce `maxWindowItems`"))
        let later = blocks(opening: "Task {", in: body)
        XCTAssertTrue(later.contains { $0.contains("trimWindow()") && $0.contains("publishStateNow()") },
                      "the trim must still be made and published — from the Task, a turn later")
        var now = body
        for block in later { now = now.replacingOccurrences(of: block, with: "") }
        XCTAssertFalse(now.contains("publishStateNow()"),
                       "publishing from the call is the shape that aims the next scroll at rows being trimmed")
        XCTAssertFalse(now.contains("trimWindow()"),
                       "nor may the trim run from the call while its publish waits: the published rows "
                           + "and the window would disagree for a turn")
    }
}
