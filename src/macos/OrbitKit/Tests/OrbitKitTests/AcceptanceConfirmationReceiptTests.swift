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

    private func state(_ items: [TranscriptItem]) -> TranscriptState {
        var s = TranscriptState()
        s.items = items
        return s
    }

    /// Three items: before the confirmation, the one it was made on top of, and one after it.
    private func transcript() -> [TranscriptItem] {
        [item("i1", at: "2026-09-17T09:00:00.000Z"),
         item("i2", at: "2026-09-17T09:25:00.000Z"),
         item("i3", at: "2026-09-17T10:00:00.000Z")]
    }

    // MARK: what the record says

    /// The seal on the record is the one somebody SIGNED, and it lives in the fold now — the
    /// headline is the count and what changed. The card beside it names the version standing now —
    /// that is what it is asking about — and a receipt that read the same field would be telling
    /// the reader they confirmed wording they never saw.
    func testTheRecordNamesTheSealThatWasSignedAndNotTheOneStandingNow() throws {
        let standing = staleStanding()
        let receipt = try XCTUnwrap(AcceptanceConfirmations.receipt(standing: standing))

        XCTAssertEqual(receipt.confirmation.criteriaDigest, Self.signed)
        let seal = AcceptanceConfirmations.receiptSeal(receipt.confirmation)
        XCTAssertTrue(seal.contains(CriteriaDecisions.shortSeal(Self.signed)), seal)
        XCTAssertFalse(seal.contains(CriteriaDecisions.shortSeal(Self.moved)), seal)

        // And the two facts really are two: the card's own meta line names the version standing now,
        // in the same breath as saying the confirmation no longer stands. No `satisfied` here — the
        // question was asked before the work, and what the work has met has no bearing on it.
        let card = AcceptanceConfirmations.meta(standing, started: true, projectTitle: "Aurora")
        XCTAssertTrue(card.contains(CriteriaDecisions.shortSeal(Self.moved)), card)
        XCTAssertFalse(card.contains(CriteriaDecisions.shortSeal(Self.signed)), card)
    }

    /// A record belongs where the DECISION happened — the door's clock, against the rows' own
    /// clocks, resolved at RENDER time — and not where the read happened to bring it in. Here the
    /// confirmation landed between `i2` and `i3`, so `i2` is what it goes after, however many items
    /// arrived later and whatever the window has since dropped.
    func testTheRecordIsPlacedWhereTheConfirmationHappened() throws {
        let receipt = try XCTUnwrap(AcceptanceConfirmations.receipt(standing: staleStanding()))
        let rows = TranscriptRows.build(
            state: state(transcript()), statusCards: [], canPageOlder: false,
            showWorkingIndicator: false,
            decisionCards: [DeliveredDecisionCard(
                kind: .acceptanceConfirmationReceipt(confirmed: receipt.confirmation),
                placement: .at(receipt.moment))])
        XCTAssertEqual(rows.map(\.id),
                       ["i1", "i2", "acceptance-confirmation-receipt", "i3", "transcript-bottom"],
                       "a record placed at the tail is drawn as though it happened last")
        XCTAssertEqual(receipt.moment, "2026-09-17T09:30:00.000Z",
                       "the row is resolved from the door's own clock, so that is what the card "
                       + "carries to the transcript")
        XCTAssertEqual(receipt.id, "acceptance-confirmation-receipt")
        XCTAssertNotEqual(receipt.id,
                          DeliveredDecisionCard(kind: .acceptanceConfirmation).id,
                          "the record and the question can be on screen together, and two rows "
                              + "sharing an id costs the List its diff")
    }

    /// What the record is NOT drawn from: an unconfirmed standing has no record on it, and a
    /// standing this device could not read is not an answer either. Neither is invented. (A
    /// confirmation older than everything loaded IS drawn — at the head of the window, which is
    /// `TranscriptRowsTests`' case and the rule of 2026-09-22.)
    func testNoRecordIsDrawnWithoutOneToDraw() throws {
        let material = [ConfirmedCriterionVersion(definitionId: "d1", revision: 1, contentHash: "h1")]
        let unconfirmed = StandardSetConfirmationStanding(
            state: .unconfirmed, confirmed: false,
            currentVersion: StandardSetVersion(digest: Self.moved, material: material),
            confirmation: nil)
        XCTAssertNil(AcceptanceConfirmations.receipt(standing: unconfirmed),
                     "a set nobody has confirmed has no record to draw")
        XCTAssertNil(AcceptanceConfirmations.receipt(standing: nil),
                     "and a standing this device could not read is not an answer either")
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

    // MARK: what the record keeps — the words, and what changed

    /// The new fields decode tolerantly: absent on a server older than this build, present with the
    /// words confirmed and what the press changed on one that keeps them, and a shape this build
    /// cannot read is none of — never a confirmation read that fails to decode.
    func testTheRecordReadsTheWordsAndTheChangesItKeeps() throws {
        func decode(_ json: String) throws -> RecordedStandardSetConfirmation {
            try JSONDecoder().decode(RecordedStandardSetConfirmation.self, from: Data(json.utf8))
        }
        // Absent: an older server's record — no changes, no words, and nothing is invented.
        let old = try decode("""
        {"criteriaDigest":"d","criteriaMaterial":[],"confirmedAt":"t","confirmedById":"u1"}
        """)
        XCTAssertNil(old.changes)
        XCTAssertEqual(old.criteria, [])
        XCTAssertFalse(old.wordingRecorded)

        // Present: the confirmed set in the words confirmed, and what this confirmation changed.
        let kept = try decode("""
        {"criteriaDigest":"d","criteriaMaterial":[],"confirmedAt":"t","confirmedById":"u1",
         "changes":{"added":[{"key":"k2","ordinal":2,"text":"B"}],"stricter":[],"revised":[],
                    "removed":["k9"],"unchanged":[1]},
         "criteria":[{"key":"k1","ordinal":1,"text":"A","verificationMethod":"npm test","since":"UNCHANGED"},
                     {"key":"k2","ordinal":2,"text":"B","verificationMethod":"review","since":"EDITED"},
                     {"key":"k9","ordinal":null,"text":null,"verificationMethod":null,"since":"REMOVED"}],
         "wordingRecorded":true}
        """)
        XCTAssertEqual(kept.changes?.added.map(\.key), ["k2"])
        XCTAssertEqual(kept.changes?.removed, ["k9"])
        XCTAssertEqual(kept.changes?.unchanged, [1])
        XCTAssertEqual(kept.criteria.map(\.key), ["k1", "k2", "k9"])
        XCTAssertEqual(kept.criteria[1].since, .edited)
        XCTAssertEqual(kept.criteria[2].since, .removed)
        XCTAssertNil(kept.criteria[2].ordinal,
                     "a criterion that no longer stands has no number to be listed under")
        XCTAssertNil(kept.criteria[2].text, "and a changed criterion's old words are gone")
        XCTAssertTrue(kept.wordingRecorded)

        // A shape this build cannot read is none of it, not a failed read.
        let odd = try decode("""
        {"criteriaDigest":"d","criteriaMaterial":[],"confirmedAt":"t","confirmedById":"u1",
         "changes":"yesterday","criteria":{"k1":"A"},"wordingRecorded":"yes"}
        """)
        XCTAssertNil(odd.changes)
        XCTAssertEqual(odd.criteria, [])
        XCTAssertFalse(odd.wordingRecorded)

        // And a `since` this build has no tag for leaves the row untagged, rather than failing it.
        let ahead = try decode("""
        {"criteriaDigest":"d","criteriaMaterial":[],"confirmedAt":"t","confirmedById":"u1",
         "criteria":[{"key":"k1","ordinal":1,"text":"A","verificationMethod":null,"since":"MERGED"}],
         "wordingRecorded":true}
        """)
        XCTAssertEqual(ahead.criteria.count, 1)
        XCTAssertEqual(ahead.criteria[0].since, .unchanged)
    }

    /// The note under the fold's list, or none: the two sentences a record can need, read off the
    /// record's own facts.
    func testTheNoteUnderTheList() {
        func record(_ criteria: [ConfirmedCriterionReading], wordingRecorded: Bool)
            -> RecordedStandardSetConfirmation {
            RecordedStandardSetConfirmation(criteriaDigest: Self.signed, criteriaMaterial: [],
                                            confirmedAt: "2026-09-17T09:30:00.000Z",
                                            confirmedById: "u1", criteria: criteria,
                                            wordingRecorded: wordingRecorded)
        }
        // A record older than keeping the words: today's words stand in where the hash still
        // matches, and the criteria that changed have none left — counted after the note.
        let old = record([ConfirmedCriterionReading(key: "k1", ordinal: 1, text: "A"),
                          ConfirmedCriterionReading(key: "k2", ordinal: 2)],
                         wordingRecorded: false)
        XCTAssertEqual(AcceptanceConfirmations.receiptNote(old),
                       AcceptanceConfirmations.receiptWordingNotKept
                           + AcceptanceConfirmations.receiptWordsGoneSentence(1))
        let oldIntact = record([ConfirmedCriterionReading(key: "k1", ordinal: 1, text: "A")],
                               wordingRecorded: false)
        XCTAssertEqual(AcceptanceConfirmations.receiptNote(oldIntact),
                       AcceptanceConfirmations.receiptWordingNotKept,
                       "nothing gone adds nothing")

        // A record whose words were kept, once some of them moved: which, by number.
        let moved = record([ConfirmedCriterionReading(key: "k1", ordinal: 1, text: "A"),
                            ConfirmedCriterionReading(key: "k3", ordinal: 3, text: "C",
                                                      since: .edited),
                            ConfirmedCriterionReading(key: "k5", ordinal: 5, text: "E",
                                                      since: .removed)],
                           wordingRecorded: true)
        XCTAssertEqual(AcceptanceConfirmations.receiptNote(moved),
                       AcceptanceConfirmations.receiptMovedNote([3, 5]))
        let intact = record([ConfirmedCriterionReading(key: "k1", ordinal: 1, text: "A")],
                            wordingRecorded: true)
        XCTAssertNil(AcceptanceConfirmations.receiptNote(intact),
                     "a kept record whose criteria all still stand has nothing to note")
        // A criterion with no number left is not named by number.
        let gone = record([ConfirmedCriterionReading(key: "k9", since: .removed)],
                          wordingRecorded: true)
        XCTAssertNil(AcceptanceConfirmations.receiptNote(gone))
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
            "AcceptanceConfirmations.receipt(standing: acceptanceConfirmation)"),
                      "the record must be built from the standing this console read")
        XCTAssertTrue(built.contains(".acceptanceConfirmationReceipt(confirmed: receipt.confirmation)"),
                      "and drawn as a receipt row rather than as a second card")
        XCTAssertTrue(built.contains("placement: .at(receipt.moment)"),
                      "with the door's own clock for the transcript to resolve against the rows "
                      + "the console holds at render time")
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

    /// The press closes the card for the version it signed, and for no other. The set can move after
    /// it — the owner's own yes to a held proposal moves it — and the version standing then asks the
    /// same question again. 2026-09-27: confirmed on the iPhone at 21:42 UTC, an edit to criterion 7
    /// approved there at 21:54, and the conversation drew nothing to press while its row in the list
    /// read "Waiting for approval": the first press had closed the card for good.
    func testAVersionThatMovesAfterAPressHereAsksAgain() throws {
        let console = try source(Self.consolePath)
        let press = try section(console, from: "func confirmStandardSet() async {",
                                to: "\n    // MARK: the project's two owner cards")
        XCTAssertTrue(statements(press).joined(separator: " ").contains("confirmedHereDigest = digest"),
                      "the press no longer records which version it closed the card for, so no "
                          + "later version can be told apart from it")

        let refresh = try section(console,
                                  from: "func refreshRulerQuestions(force: Bool = false) async {",
                                  to: "\n    /// Whether this project is waiting to be started")
        let reads = statements(refresh)
        let reopen = try XCTUnwrap(reads.firstIndex(of: "reopenConfirmationForANewVersion()"),
                                   "the read no longer lets the card back in for a new version")
        let deliver = try XCTUnwrap(reads.firstIndex(of: "deliver(.acceptanceConfirmation)"))
        XCTAssertLessThan(reopen, deliver,
                          "the card has to be let back in before it is delivered, or the delivery is "
                              + "refused by the press that closed it")

        let reopening = statements(try section(
            console, from: "private func reopenConfirmationForANewVersion() {", to: "\n    }\n"))
            .joined(separator: " ")
        XCTAssertTrue(reopening.contains("standing != signed"),
                      "only a DIFFERENT version reopens it: a read that left before the press landed "
                          + "still shows the signed one, and must not bring the answered card back")
        XCTAssertTrue(reopening.contains(
            "closedCards.remove(DeliveredDecisionCard(kind: .acceptanceConfirmation).id)"),
                      "and what it lets back in is the confirmation card's own id")
    }

    // MARK: what the app draws with it

    /// The row reaches the screen: the switch dispatches it, the card draws the line and the stamp
    /// from the record, with what the confirmation was about folded under it, and the record is
    /// never counted as an open question — it is an answer, and pointing a reader at it would be
    /// pointing them at something with nothing to press.
    func testTheRecordIsDrawnAsAReceiptAndNeverCountedAsAQuestion() throws {
        let card = try source(Self.cardPath)
        let dispatch = try section(card, from: "case .acceptanceConfirmation:",
                                   to: "case .ownerConfirmation(")
        XCTAssertTrue(dispatch.contains("case .acceptanceConfirmationReceipt(let confirmed):"),
                      "the delivered-card switch draws nothing for a confirmation's record")
        XCTAssertTrue(dispatch.contains("AcceptanceConfirmationReceiptCard(confirmed: confirmed)"),
                      "and what it draws must be handed the record it is about — and nothing a "
                          + "window remembered: what the press changed is on the record now")

        let view = try section(card, from: "private struct AcceptanceConfirmationReceiptCard: View",
                               to: "\n// MARK: -")
        XCTAssertTrue(view.contains("AcceptanceConfirmations.receiptHeading"),
                      "the record draws OrbitKit's heading rather than one composed here")
        XCTAssertTrue(view.contains("AcceptanceConfirmations.receiptLine(confirmed)"),
                      "and OrbitKit's line — started for a start, confirmed for anything else")
        XCTAssertTrue(view.contains("RunSettingsSummaryText(settings: started.settings,"),
                      "and a start's record says what the project was started with")
        XCTAssertTrue(view.contains("AcceptanceConfirmations.receiptStamp("),
                      "and the stamp saying who signed it, and when")
        XCTAssertFalse(view.contains("approvalActionLabel"),
                       "a record is not a question: nothing on it is a pressable action — the "
                           + "fold's toggle is a reading control and writes nothing")

        // The fold, closed by default: the change card's own rows, the numbered criteria with
        // their tags, the note, and the seal — all off the record, all in OrbitKit's words.
        XCTAssertTrue(view.contains("AcceptanceReceiptFold(confirmed: confirmed)"),
                      "what the confirmation was about is folded under its record")
        XCTAssertTrue(view.contains("@State private var open = false"),
                      "and the fold is closed by default")
        XCTAssertTrue(view.contains("AcceptanceConfirmations.receiptOpenLabel("),
                      "the closed toggle says what it opens and how much of it there is")
        XCTAssertTrue(view.contains("AcceptanceConfirmations.receiptCloseLabel"),
                      "and the open one says it closes")
        XCTAssertTrue(view.contains("CriteriaChanges.rows(changes)"),
                      "the change rows are the change card's own, so question and record read alike")
        XCTAssertTrue(view.contains("CriteriaChangeRowView(row: row)"),
                      "drawn by the same row view")
        XCTAssertTrue(view.contains("AcceptanceConfirmations.receiptWordsGone"),
                      "a criterion whose words were never kept says so")
        XCTAssertTrue(view.contains("AcceptanceConfirmations.receiptTagNew"),
                      "and what was new, moved or removed since is tagged")
        XCTAssertTrue(view.contains("AcceptanceConfirmations.receiptNote(confirmed)"),
                      "with the note under the list when there is one")
        XCTAssertTrue(view.contains("AcceptanceConfirmations.receiptSeal(confirmed)"),
                      "and the seal the press locked as the fold's last line")

        let console = try source(Self.consolePath)
        XCTAssertFalse(console.contains("confirmedChanges("),
                       "the window-held 'what this press changed' is gone: the record keeps it")
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
