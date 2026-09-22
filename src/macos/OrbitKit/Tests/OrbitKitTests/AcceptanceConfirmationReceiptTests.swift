import Foundation
import XCTest
@testable import OrbitKit

/// THE RECORD A CONFIRMATION LEAVES — AND WHY IT IS THE READ'S RATHER THAN THE PRESS'S.
///
/// "One of Orbit's decisions" is three things, not one: a signal while it waits, a fixed line
/// pointing at it, and a RECEIPT where it was made. This card had the middle one and neither of the
/// others — so when it was answered, the only trace of the answer lived in the console that pressed
/// the button (`ConsoleModel.confirmStandardSet` left a `LocalStatusCard`), and the next time that
/// console was opened the decision was gone from the conversation it had been made in. The three
/// receipts beside it had already been fixed for exactly this (`decideCriteria`'s note, 2026-09-16).
///
/// So what is asserted here is the wire that makes the difference: the record is built from the
/// STANDING THE READ PUBLISHES, in `refreshRulerQuestions`, and the press writes no line of its own.
/// A row kept by the window that pressed cannot pass either half, which is the day this check exists
/// for. It is one implementation for both native clients — `src/ios/project.yml` compiles
/// `Views/ApprovalCards.swift` in place, so iOS and macOS draw this same card — and the last case
/// here holds that arrangement rather than assuming it.
///
/// The instrument is the same one `CriteriaDecisionWiringTests` uses and it has the same limit: it
/// reads source, because SwiftUI does not exist on Linux and `ApprovalCards.swift` is compiled only
/// by the macOS and iOS jobs. It cannot see layout.
final class AcceptanceConfirmationReceiptTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found above this test. If it moved, move this check with "
                    + "it rather than deleting it: it is the only gate on Linux that sees whether a "
                    + "confirmation still leaves a record the next console can read."
            }
        }
    }

    private static let cardPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/ApprovalCards.swift"
    private static let consolePath = "src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift"
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
    /// about. (A bare `contains` over a whole file is how a scan like this goes falsely green.)
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

    // MARK: the fixture

    private static let signed = "4fc57753a6ec" + String(repeating: "a", count: 52)
    private static let moved = "9c4f7a1bb001" + String(repeating: "b", count: 52)

    /// A standing whose newer record is `signed` while the set standing now is `moved`: a
    /// confirmation that no longer counts, which is the state where the record has something to say
    /// that the card cannot — what was signed, as against what stands.
    private func staleStanding() -> StandardSetConfirmationStanding {
        let material = [ConfirmedCriterionVersion(definitionId: "d1", revision: 1, contentHash: "h1")]
        return StandardSetConfirmationStanding(
            state: .stale, confirmed: false,
            currentVersion: StandardSetVersion(digest: Self.moved, material: material),
            confirmation: RecordedStandardSetConfirmation(
                criteriaDigest: Self.signed, criteriaMaterial: material,
                confirmedAt: "2026-09-17T09:30:00.000Z", confirmedById: "u1"))
    }

    private func item(_ id: String, at ts: String?) -> TranscriptItem {
        .user(UserBubble(id: id, text: "…", ts: ts, pending: false, queued: false))
    }

    /// Three items: before the confirmation, the one it was made on top of, and one after it.
    private func transcript() -> [TranscriptItem] {
        [item("i1", at: "2026-09-17T09:00:00.000Z"),
         item("i2", at: "2026-09-17T09:25:00.000Z"),
         item("i3", at: "2026-09-17T10:00:00.000Z")]
    }

    // MARK: what the record says

    /// The seal on the record is the one somebody SIGNED. The card beside it names the version
    /// standing now — that is what it is asking about — and a receipt that read the same field would
    /// be telling the reader they confirmed wording they never saw.
    func testTheRecordNamesTheSealThatWasSignedAndNotTheOneStandingNow() throws {
        let standing = staleStanding()
        let receipt = try XCTUnwrap(AcceptanceConfirmations.receipt(standing: standing,
                                                                    items: transcript()))

        XCTAssertEqual(receipt.confirmation.criteriaDigest, Self.signed)
        let line = AcceptanceConfirmations.confirmedLine(receipt.confirmation)
        XCTAssertTrue(line.contains(CriteriaDecisions.shortSeal(Self.signed)), line)
        XCTAssertFalse(line.contains(CriteriaDecisions.shortSeal(Self.moved)), line)

        // And the two facts really are two: the card's own meta line names the version standing now,
        // in the same breath as saying the confirmation no longer stands. No `satisfied` here — the
        // question was asked before the work, and what the work has met has no bearing on it.
        let card = AcceptanceConfirmations.meta(standing, started: true, projectTitle: "Aurora")
        XCTAssertTrue(card.contains(CriteriaDecisions.shortSeal(Self.moved)), card)
        XCTAssertFalse(card.contains(CriteriaDecisions.shortSeal(Self.signed)), card)
    }

    /// A record belongs where the DECISION happened — the door's clock, against the rows' own
    /// clocks — and not where the read happened to bring it in. Here the confirmation landed
    /// between `i2` and `i3`, so `i2` is what it goes after, however many items arrived later.
    func testTheRecordIsPlacedWhereTheConfirmationHappened() throws {
        let receipt = try XCTUnwrap(AcceptanceConfirmations.receipt(standing: staleStanding(),
                                                                    items: transcript()))
        XCTAssertEqual(receipt.afterItemID, "i2")
        XCTAssertNotEqual(receipt.afterItemID, transcript().last?.id,
                          "a record anchored at the tail is drawn as though it happened last")
        XCTAssertEqual(receipt.id, "acceptance-confirmation-receipt")
        XCTAssertNotEqual(receipt.id,
                          DeliveredDecisionCard(kind: .acceptanceConfirmation).id,
                          "the record and the question can be on screen together, and two rows "
                              + "sharing an id costs the List its diff")
    }

    /// What the record is NOT drawn from. An unconfirmed standing has no record on it, and a
    /// confirmation older than everything this device holds cannot be placed without putting it
    /// above things that happened first — neither is drawn, and neither is invented.
    func testNoRecordIsDrawnWithoutOneToDraw() throws {
        let material = [ConfirmedCriterionVersion(definitionId: "d1", revision: 1, contentHash: "h1")]
        let unconfirmed = StandardSetConfirmationStanding(
            state: .unconfirmed, confirmed: false,
            currentVersion: StandardSetVersion(digest: Self.moved, material: material),
            confirmation: nil)
        XCTAssertNil(AcceptanceConfirmations.receipt(standing: unconfirmed, items: transcript()),
                     "a set nobody has confirmed has no record to draw")
        XCTAssertNil(AcceptanceConfirmations.receipt(standing: nil, items: transcript()),
                     "and a standing this device could not read is not an answer either")

        // Every loaded item is LATER than the confirmation: the moment is above this window.
        let later = [item("i9", at: "2026-09-18T09:00:00.000Z")]
        XCTAssertNil(AcceptanceConfirmations.receipt(standing: staleStanding(), items: later),
                     "a record nobody can place must not be drawn in the wrong one")
    }

    /// The words on it, whole: what it is headed, and the stamp under the line saying who signed it.
    func testTheRecordSaysWhatItIsAndWhoSignedIt() {
        XCTAssertEqual(AcceptanceConfirmations.receiptHeading,
                       CriteriaDecisions.recordedHeading,
                       "one word for one thing: the other three receipts are headed this too")
        XCTAssertEqual(AcceptanceConfirmations.receiptStamp("08:00"), "by you at 08:00")
        XCTAssertEqual(AcceptanceConfirmations.receiptStamp(nil), "by you",
                       "a moment this client cannot read is left off rather than left dangling")
    }

    // MARK: the wire — the read draws it, the press does not

    /// THE ASSERTION THIS FILE EXISTS FOR. `refreshRulerQuestions` adopts the record as part of the
    /// same read that draws the question, so a console that never pressed anything — opened
    /// tomorrow, on another device — draws it too. Take the call away and the only thing left is
    /// the press's own memory of having pressed, which is what the reload takes away.
    func testTheConsoleDrawsTheRecordFromItsOwnRead() throws {
        let console = try source(Self.consolePath)
        let refresh = try section(console,
                                  from: "func refreshRulerQuestions(force: Bool = false) async {",
                                  to: "\n    /// Whether this project is waiting to be started")
        let reads = statements(refresh)
        XCTAssertTrue(reads.contains("acceptanceConfirmation = standing"))
        XCTAssertTrue(reads.contains("adoptAcceptanceReceipt()"),
                      "the standing read no longer draws the record it publishes, so a console "
                          + "that did not press the button has nothing to show")

        let adopt = try section(console, from: "private func adoptAcceptanceReceipt() {",
                                to: "\n    /// Where one delivered proposal stands")
        let built = statements(adopt).joined(separator: " ")
        XCTAssertTrue(built.contains(
            "AcceptanceConfirmations.receipt(standing: acceptanceConfirmation, items: state.items)"),
                      "the record must be built from the standing this console read")
        XCTAssertTrue(built.contains(".acceptanceConfirmationReceipt(confirmed: receipt.confirmation)"),
                      "and drawn as a receipt row rather than as a second card")
    }

    /// And the other half of the same rule: the press keeps NO line of its own. An in-memory line
    /// lasts exactly as long as the console does, which is the defect — the record above is the
    /// thing that outlives it, and a fix that keeps both is a fix that kept the line.
    func testThePressKeepsNoLineOfItsOwn() throws {
        let console = try source(Self.consolePath)
        let press = try section(console, from: "func confirmStandardSet() async {",
                                to: "\n    // MARK: the project's two owner cards")
        let written = statements(press).joined(separator: " ")
        XCTAssertFalse(written.contains("appendDecisionLine"),
                       "the press is writing a line into this window's transcript again; that line "
                           + "is what a reload takes away")
        XCTAssertFalse(written.contains("AcceptanceConfirmations.confirmedLine"),
                       "the press is composing the record itself rather than letting the read draw "
                           + "it — the same defect with a different spelling")
        XCTAssertTrue(written.contains("close(.acceptanceConfirmation)"),
                      "the answered card still gives way")
        XCTAssertTrue(written.contains("await refreshRulerQuestions(force: true)"),
                      "and the re-read that draws the record runs on both paths: the door's answer "
                          + "and its refusal")
    }

    // MARK: what the app draws with it

    /// The row reaches the screen: the switch dispatches it, the card draws the line and the stamp
    /// from the record, and the record is never counted as an open question — it is an answer, and
    /// pointing a reader at it would be pointing them at something with nothing to press.
    func testTheRecordIsDrawnAsAReceiptAndNeverCountedAsAQuestion() throws {
        let card = try source(Self.cardPath)
        let dispatch = try section(card, from: "case .acceptanceConfirmation:",
                                   to: "case .ownerConfirmation(")
        XCTAssertTrue(dispatch.contains("case .acceptanceConfirmationReceipt(let confirmed):"),
                      "the delivered-card switch draws nothing for a confirmation's record")
        XCTAssertTrue(dispatch.contains("AcceptanceConfirmationReceiptCard(confirmed: confirmed)"),
                      "and what it draws must be handed the record it is about")

        let view = try section(card, from: "private struct AcceptanceConfirmationReceiptCard: View",
                               to: "\n// MARK: -")
        XCTAssertTrue(view.contains("AcceptanceConfirmations.receiptHeading"),
                      "the record draws OrbitKit's heading rather than one composed here")
        XCTAssertTrue(view.contains("AcceptanceConfirmations.confirmedLine(confirmed)"),
                      "and OrbitKit's line, which is the one naming the seal that was signed")
        XCTAssertTrue(view.contains("AcceptanceConfirmations.receiptStamp("),
                      "and the stamp saying who signed it, and when")
        XCTAssertFalse(view.contains("Button"),
                       "a record is not a question: nothing on it is pressable")

        let console = try source(Self.consolePath)
        let counted = try section(console, from: "var openBelowRows: [BelowRow] {",
                                  to: "\n    /// A row the transcript has been asked to scroll to")
        let receipts = try section(counted, from: "case .criteriaDecisionReceipt, .evidenceDecisionReceipt,",
                                   to: "case .acceptanceConfirmation:")
        XCTAssertTrue(receipts.contains(".acceptanceConfirmationReceipt"),
                      "the record's row is counted among the receipts — it is not a question, and a "
                          + "bar pointing at it would be pointing at nothing to answer")
    }

    /// ONE CARD FOR BOTH NATIVE CLIENTS. iOS does not have its own copy of this: its target compiles
    /// `../macos/OrbitApp/Sources/OrbitApp` in place and excludes the macOS-only files, so the
    /// record drawn above is what a phone draws too — unless somebody adds this file to that exclude
    /// list, which is the one way the two could come apart without a compiler saying so.
    func testBothNativeClientsDrawTheOneReceiptCard() throws {
        let project = try source(Self.iosProject)
        let sources = try section(project, from: "    sources:", to: "    dependencies:")
        XCTAssertTrue(sources.contains("path: ../macos/OrbitApp/Sources/OrbitApp"),
                      "the iOS client must still reuse the shared shell rather than a second copy "
                          + "of it")
        // The card, and the switch that dispatches it, are in `Views/ApprovalCards.swift` — which
        // this target compiles out of the path above unless somebody hands it to the exclude list.
        XCTAssertFalse(sources.contains("ApprovalCards.swift"),
                       "the iOS target no longer compiles the shared cards, so the record a "
                           + "confirmation leaves would exist on macOS only")
    }
}
