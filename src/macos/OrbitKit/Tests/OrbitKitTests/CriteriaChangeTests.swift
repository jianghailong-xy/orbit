import Foundation
import XCTest
@testable import OrbitKit

/// "Confirm the new criteria?" — a started project whose criteria moved since the owner confirmed
/// them, asked about what moved and nothing else. What is held here is the logic under the words
/// (`CriteriaChangeCardCopyParityTests` holds the words): the list is the SERVER's, read off the
/// confirmation read; the card is asked only of a started project, and only while the server can
/// say what changed; and what a press confirmed is said on its receipt.
final class CriteriaChangeTests: XCTestCase {

    private static let seal = "7d1e03a9c2f4" + String(repeating: "7", count: 52)
    private static let signed = "c2b4e16c4b59" + String(repeating: "0", count: 52)

    /// The mock's example: criterion 5 added, criterion 2's check made stricter, 1, 3 and 4 as they
    /// were.
    private func standingJSON(changes: String = """
        {"added":[{"key":"k5","ordinal":5,"text":"macOS：设置 → Runners 与 iOS 同结构"}],
         "stricter":[{"key":"k2","ordinal":2,"verificationMethod":"跑 RunnersPage 的 vitest",
                      "confirmedVerificationMethod":"owner 看截图确认"}],
         "revised":[],"removed":[],"unchanged":[4,1,3]}
        """, state: String = "STALE") -> String {
        let material = (1...5).map { #"{"definitionId":"d\#($0)","revision":1,"contentHash":"h\#($0)"}"# }
        let signedMaterial = (1...4).map { #"{"definitionId":"d\#($0)","revision":1,"contentHash":"h\#($0)"}"# }
        return """
        {"state":"\(state)","confirmed":\(state == "CONFIRMED"),
         "currentVersion":{"digest":"\(Self.seal)","material":[\(material.joined(separator: ","))]},
         "confirmation":{"criteriaDigest":"\(Self.signed)","criteriaMaterial":[\(signedMaterial.joined(separator: ","))],
           "confirmedAt":"2026-09-29T08:26:00.000Z","confirmedById":"u1","startedWith":null},
         "changesSinceConfirmed":\(changes),"changesSinceConfirmedAbsentReason":null}
        """
    }

    private func standing(_ json: String) throws -> StandardSetConfirmationStanding {
        try JSONDecoder().decode(StandardSetConfirmationStanding.self, from: Data(json.utf8))
    }

    // MARK: the read

    func testTheChangesAreReadOffTheConfirmationRead() throws {
        let read = try standing(standingJSON())
        let changes = try XCTUnwrap(read.changesSinceConfirmed)
        XCTAssertEqual(changes.added.map(\.ordinal), [5])
        XCTAssertEqual(changes.stricter.first?.confirmedVerificationMethod, "owner 看截图确认")
        XCTAssertEqual(changes.unchanged, [4, 1, 3])
        XCTAssertFalse(changes.isEmpty)

        // Never confirmed: nothing to compare with, which is not a set with no changes.
        let never = try standing(standingJSON(changes: "null", state: "UNCONFIRMED"))
        XCTAssertNil(never.changesSinceConfirmed)
        // A server older than this build does not send the list at all; a shape this build cannot
        // read is no list either — and neither takes the confirmation read down with it.
        let older = try standing(standingJSON().replacingOccurrences(
            of: #""changesSinceConfirmed":"#, with: #""notTheList":"#))
        XCTAssertNil(older.changesSinceConfirmed)
        let odd = try standing(standingJSON(changes: #""sideways""#))
        XCTAssertNil(odd.changesSinceConfirmed)
        XCTAssertEqual(odd.state, .stale)
    }

    // MARK: the card

    func testTheRowsAreTheServersChangesNewFirstNumberedByTheirOwnOrdinals() throws {
        let changes = try XCTUnwrap(try standing(standingJSON()).changesSinceConfirmed)
        let rows = CriteriaChanges.rows(changes)
        XCTAssertEqual(rows.map(\.mark), [.new, .stricter])
        XCTAssertEqual(rows.map(\.kind), ["5 · New", "2 · Stricter check"])
        XCTAssertEqual(rows.map(\.text), ["macOS：设置 → Runners 与 iOS 同结构", "跑 RunnersPage 的 vitest"])
        XCTAssertEqual(rows.map(\.was), [nil, "was: owner 看截图确认"])
        XCTAssertEqual(CriteriaChanges.unchangedLine(changes), "1, 3, 4 unchanged")

        // A change landed some other way is listed as changed rather than counted as unchanged, and
        // a confirmed criterion that is gone is counted, since no words of it are left to show.
        let other = CriteriaChangesSinceConfirmed(
            revised: [CriterionRevisedSinceConfirmed(key: "k3", ordinal: 3, text: "reworded")],
            removed: ["k9"], unchanged: [1])
        XCTAssertEqual(CriteriaChanges.rows(other).map(\.kind), ["3 · Changed"])
        XCTAssertEqual(CriteriaChanges.rows(other).map(\.mark.rawValue), ["~"])
        XCTAssertEqual(CriteriaChanges.unchangedLine(other), "1 unchanged · 1 removed")
        XCTAssertEqual(CriteriaChanges.unchanged([], removed: 2), "2 removed")
    }

    func testTheMetaLineAndTheActionCountTheCriteria() throws {
        let read = try standing(standingJSON())
        XCTAssertEqual(CriteriaChanges.meta(read, projectTitle: "Runner 页整页改版（iOS/macOS + web）"),
                       "Runner 页整页改版（iOS/macOS + web） · running · 4 → 5 criteria · seal 7d1e03a9c2f4")
        XCTAssertEqual(CriteriaChanges.confirmLabel(5), "Confirm 5 criteria")
        XCTAssertEqual(CriteriaChanges.confirmLabel(1), "Confirm 1 criterion")
        XCTAssertEqual(CriteriaChanges.showAll(5), "Show all 5")
        XCTAssertEqual(CriteriaChanges.whatChangedHead(2), "What changed · 2")
    }

    /// What a press on the card leaves for the receipt of that confirmation: "1 new, 1 stricter".
    func testWhatAPressConfirmedIsCountedForItsReceipt() throws {
        let changes = try XCTUnwrap(try standing(standingJSON()).changesSinceConfirmed)
        XCTAssertEqual(CriteriaChanges.counts(changes), "1 new, 1 stricter")
        XCTAssertEqual(CriteriaChanges.summary(added: 0, stricter: 0, revised: 2, removed: 1),
                       "2 changed, 1 removed")
        XCTAssertEqual(CriteriaChanges.summary(added: 0, stricter: 0, revised: 0, removed: 0), "")
    }

    // MARK: when it is asked

    func testItIsAskedOfAStartedOpenProjectWhoseSetMovedAndWhoseServerSaysHow() throws {
        let moved = try standing(standingJSON())
        func held(_ s: StandardSetConfirmationStanding?, status: String? = "OPEN", criteria: Int = 5,
                  tasks: Int = 6, started: Bool? = true) -> Bool {
            CriteriaChanges.held(s, projectStatus: status, criteriaCount: criteria, taskCount: tasks,
                                 started: started)
        }
        XCTAssertTrue(held(moved))
        XCTAssertFalse(held(moved, started: false),
                       "an unstarted project is the start card's: it confirms the criteria as it starts")
        XCTAssertFalse(held(moved, started: nil), "a project nobody could read is not asked anything")
        XCTAssertFalse(held(moved, status: "DONE"))
        XCTAssertFalse(held(moved, criteria: 0))
        XCTAssertFalse(held(moved, tasks: 0))
        XCTAssertFalse(held(nil))
        // Confirmed: nothing moved. Stale with no list: the older card asks, since this one cannot
        // say what changed.
        XCTAssertFalse(held(try standing(standingJSON(state: "CONFIRMED"))))
        XCTAssertFalse(held(try standing(standingJSON(changes: "null"))))
    }

    /// Still asking — what the needs-you bar counts — while the set it lists stands unconfirmed, and
    /// while a read has not answered; confirmed at another end, it stays on screen and stops being
    /// counted.
    func testItStopsBeingAQuestionOnceTheSetIsConfirmedAnywhere() throws {
        XCTAssertTrue(CriteriaChanges.isOpen(try standing(standingJSON())))
        XCTAssertTrue(CriteriaChanges.answerable(try standing(standingJSON())))
        XCTAssertTrue(CriteriaChanges.isOpen(nil))
        XCTAssertFalse(CriteriaChanges.answerable(nil),
                       "a standing nobody could read names no version to confirm")
        let confirmed = try standing(standingJSON(changes: #"{"added":[],"stricter":[],"revised":[],"removed":[],"unchanged":[1,2,3,4,5]}"#,
                                                  state: "CONFIRMED"))
        XCTAssertFalse(CriteriaChanges.isOpen(confirmed))
        XCTAssertFalse(CriteriaChanges.answerable(confirmed))
        XCTAssertTrue(try XCTUnwrap(confirmed.changesSinceConfirmed).isEmpty)
    }

    /// The composer the card's second action arms asks what should change about THESE, and carries
    /// the set as one a running project is being worked against.
    func testTalkingAboutTheNewCriteriaSaysTheProjectKeepsRunning() {
        XCTAssertEqual(AcceptanceConfirmations.planChangePlaceholder(for: .criteriaChange),
                       "What should change about these?")
        XCTAssertEqual(AcceptanceConfirmations.planChangePlaceholder(for: .start),
                       "What should change before it starts?")
        XCTAssertEqual(AcceptanceConfirmations.planChangePlaceholder(for: .confirmation),
                       AcceptanceConfirmations.planChangePlaceholder)
        let carried = AcceptanceConfirmations.planChangeContext(
            projectTitle: "Aurora", criteriaDigest: Self.seal, criteria: ["alpha", "beta"],
            question: .criteriaChange)
        XCTAssertTrue(carried.contains("which changed after the owner confirmed them while the "
                                           + "project keeps running"), carried)
        XCTAssertFalse(carried.contains("no work has started"), carried)
        XCTAssertTrue(carried.hasSuffix("\n\n1. alpha\n2. beta"), carried)
    }
}
