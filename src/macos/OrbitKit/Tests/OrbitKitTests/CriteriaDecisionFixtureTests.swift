import Foundation
import XCTest
@testable import OrbitKit

/// The one real weakening proposal, read out of the file the server's spec and the web card's spec
/// both read, and drawn by THIS client.
///
/// `criteria-weakening-1GB4IZ4B.fixture.json` records intent 1GB4IZ4B as it was filed and answered
/// on 2026-09-09: eight Chinese criteria restated to reword three, and — under each rewritten
/// entry — the cut the server takes of it, run for run. Three ends now draw one recorded fact
/// instead of three hand-made examples free to drift apart, which is the whole reason it is a file
/// and not a literal in each of them.
///
/// The cut is fed in AS THE SERVER'S. Nothing here compares two strings: that is the rule the whole
/// surface is built on, and a client that recomputed the diff would be making the card's central
/// claim its own conclusion.
final class CriteriaDecisionFixtureTests: XCTestCase {

    private static let fixture =
        "src/apiserver/src/projects/criteria-weakening-1GB4IZ4B.fixture.json"

    private enum FixtureError: Error, CustomStringConvertible {
        case missing
        var description: String {
            "\(CriteriaDecisionFixtureTests.fixture) was not found above this test file. It is the "
                + "one recorded proposal three ends are pinned to; if it moved, move this check "
                + "with it rather than deleting it."
        }
    }

    /// Deliberately a failure and never an `XCTSkip`: a check that quietly opts out reports green
    /// on exactly the day the thing it watches goes missing.
    private func recorded() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(Self.fixture)
            if FileManager.default.fileExists(atPath: candidate.path) {
                let data = try Data(contentsOf: candidate)
                return try XCTUnwrap(
                    JSONSerialization.jsonObject(with: data) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw FixtureError.missing
    }

    /// The recorded proposal as a row of the derived read, with the recorded cut on each rewrite.
    private func realProposal() throws -> PendingCriteriaDecisionRow {
        let file = try recorded()
        let onRecord = try XCTUnwrap(file["onRecord"] as? [[String: Any]])
        let proposed = try XCTUnwrap(file["proposed"] as? [[String: Any]])
        let expected = try XCTUnwrap(file["expected"] as? [String: Any])
        let verdicts = try XCTUnwrap(expected["entries"] as? [[String: Any]])
        let wasByOrdinal = Dictionary(uniqueKeysWithValues: onRecord.map {
            ($0["ordinal"] as? Int ?? 0, $0)
        })

        let entries = try zip(proposed, verdicts).map { each, verdict -> CriteriaProposalChangeEntry in
            let retains = each["retains"] as? Int
            let was = retains.flatMap { wasByOrdinal[$0] }
            let decoder = JSONDecoder()
            let cuts = try (verdict["rewrites"] as? [[String: Any]] ?? []).map { raw in
                try decoder.decode(CriterionFieldRewrite.self,
                                   from: JSONSerialization.data(withJSONObject: raw))
            }
            return CriteriaProposalChangeEntry(
                change: try XCTUnwrap(
                    CriteriaProposalChange(rawValue: verdict["change"] as? String ?? "")),
                definitionId: was.map { "definition-\($0["ordinal"] as? Int ?? 0)" },
                ordinal: try XCTUnwrap(each["ordinal"] as? Int),
                proposed: CriterionWording(
                    text: try XCTUnwrap(each["text"] as? String),
                    verificationMethod: each["verificationMethod"] as? String),
                onRecord: was.map {
                    CriterionWording(text: $0["text"] as? String ?? "",
                                     verificationMethod: $0["verificationMethod"] as? String)
                },
                changed: (verdict["changed"] as? [String] ?? [])
                    .compactMap(CriteriaProposalField.init(rawValue:)),
                rewrites: cuts)
        }
        return PendingCriteriaDecisionRow(
            intentId: try XCTUnwrap(file["intentPublicId"] as? String),
            projectId: "34LWcmLItBx6ytdO26XXF",
            commitToken: "b81c7d2e-3f4a-4b5c-9d6e-7f8091a2b3c4",
            actionDigest: String(repeating: "a", count: 64),
            filedAt: try XCTUnwrap(file["filedAt"] as? String),
            ageSeconds: 17 * 60,
            baselineSeal: try XCTUnwrap(file["baselineSeal"] as? String),
            currentSeal: try XCTUnwrap(file["baselineSeal"] as? String),
            proposed: [],
            diff: CriteriaProposalDiff(
                entries: entries,
                sameCount: expected["sameCount"] as? Int ?? 0,
                changedCount: expected["changedCount"] as? Int ?? 0,
                newCount: expected["newCount"] as? Int ?? 0,
                removedCount: expected["removedCount"] as? Int ?? 0),
            supersededIntentId: nil,
            decidability: CriteriaDecisionDecidability(decidable: true, refusal: nil,
                                                       requiredAction: nil))
    }

    func testTheRecordedProposalIsDrawnAsThreeRowsAndFiveFolded() throws {
        let proposal = try realProposal()
        // The positive control: the whole collection really did arrive, so folding it is this
        // client's doing rather than the server having sent three rows.
        XCTAssertEqual(proposal.diff.entries.count, 8)
        let rows = CriteriaDecisions.changeRows(proposal)
        XCTAssertEqual(rows.map(\.ordinal), [1, 2, 4])
        XCTAssertEqual(CriteriaDecisions.changeSummary(proposal.diff), "3 reworded, 5 unchanged")
        XCTAssertEqual(CriteriaDecisions.unchangedRows(proposal).count, 5)
    }

    /// THE ROW IS THE RECORDED CUT AND NOTHING ELSE.
    ///
    /// Each of the three rewrites swapped one clause inside a ninety-character Chinese sentence.
    /// Drawn as two paragraphs the pair cost about 180 characters of card; drawn as the cut it is
    /// one line in which the sentence appears once. Both of those are asserted: the runs are the
    /// server's, and neither version of the sentence is on the row whole.
    func testEachRewriteIsTheServersCutAndNeitherVersionAppearsWhole() throws {
        let proposal = try realProposal()
        for row in CriteriaDecisions.changeRows(proposal) {
            let entry = try XCTUnwrap(proposal.diff.entries.first { $0.ordinal == row.ordinal })
            let cut = try XCTUnwrap(entry.rewrites.first { $0.field == .text })
            XCTAssertEqual(row.words, cut.segments, "row \(row.ordinal) is not the server's cut")
            // The positive control under the two below: this really is a cut and not one run.
            XCTAssertGreaterThan(row.words.count, 2, "row \(row.ordinal)")

            let line = row.words.map(\.text).joined()
            let was = try XCTUnwrap(entry.onRecord).text
            let now = try XCTUnwrap(entry.proposed).text
            // The shape that is gone: the sentence laid out once as proposed and once as recorded.
            XCTAssertFalse(line.contains(was), "row \(row.ordinal) still carries the words on "
                + "record in full — that is the two-paragraph layout, back")
            XCTAssertFalse(line.contains(now), "row \(row.ordinal) still carries the proposed "
                + "words in full")
            // And both are still RECOVERABLE from the one line, which is what makes it a cut of
            // the two texts rather than a summary of them.
            XCTAssertEqual(row.words.filter { $0.side != .added }.map(\.text).joined(), was)
            XCTAssertEqual(row.words.filter { $0.side != .removed }.map(\.text).joined(), now)
        }
    }

    /// And the clause a person said moved is what carries the marks — the assertion that fails on
    /// a cut which gave up and reported the whole sentence as replaced.
    func testTheMarksLandOnTheClauseTheFixtureSaysMoved() throws {
        let proposal = try realProposal()
        let file = try recorded()
        let expected = try XCTUnwrap(file["expected"] as? [String: Any])
        let verdicts = try XCTUnwrap(expected["entries"] as? [[String: Any]])

        for row in CriteriaDecisions.changeRows(proposal) {
            let verdict = try XCTUnwrap(verdicts.first { $0["ordinal"] as? Int == row.ordinal })
            let clause = try XCTUnwrap(verdict["movedClause"] as? [String: String])
            let text = { (side: CriterionSegmentSide) in
                row.words.filter { $0.side == side }.map(\.text).joined()
            }
            XCTAssertTrue(text(.removed).contains(try XCTUnwrap(clause["removed"])),
                          "row \(row.ordinal): the dropped clause is not struck through")
            XCTAssertTrue(text(.added).contains(try XCTUnwrap(clause["added"])),
                          "row \(row.ordinal): the new clause is not marked as added")
            XCTAssertFalse(text(.kept).contains(try XCTUnwrap(clause["removed"])),
                           "row \(row.ordinal): the dropped clause is inside the unmarked words")
        }
    }
}
