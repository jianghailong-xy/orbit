import XCTest
@testable import OrbitKit

/// The coordinator-conversation receipts, proved against the shared fixtures web reads too
/// (decisions D1 A and D4 A):
///
/// * src/shared/src/criteria-decision-receipt.fixture.json — a settled decision and what the
///   receipt's fold "What this approved · …" says about it (web
///   `CriteriaDecisionCard.receiptFixture.test.tsx`, over `CriteriaDecisionReceipt`);
/// * src/shared/src/project-page-labels.fixture.json `receiptTime` — the moment every receipt
///   prints (web `ProjectPageLabels.fixture.test.tsx`, over `receiptClock`).
final class CriteriaDecisionReceiptFixtureTests: XCTestCase {

    private static let receiptFixture = "src/shared/src/criteria-decision-receipt.fixture.json"
    private static let labelsFixture = "src/shared/src/project-page-labels.fixture.json"

    private func fixture(_ relative: String) throws -> Data {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try Data(contentsOf: candidate)
            }
            dir = dir.deletingLastPathComponent()
        }
        XCTFail("\(relative) was not found above this test file")
        throw CocoaError(.fileNoSuchFile)
    }

    // MARK: the fold

    private struct ReceiptFixture: Decodable {
        struct Row: Decodable, Equatable {
            let ordinal: Int?
            let text: String
            let badge: String
        }
        struct Unchanged: Decodable, Equatable {
            struct Row: Decodable, Equatable { let ordinal: Int; let text: String }
            let line: String
            let rows: [Row]
        }
        struct Expected: Decodable {
            let warningTone: Bool
            let summary: String
            let legend: String?
            let rows: [Row]
            let unchanged: Unchanged?
            let note: String?
        }
        struct Case: Decodable {
            let name: String
            let settled: SettledCriteriaDecision
            let expected: Expected
        }
        let cases: [Case]
    }

    func testTheReceiptFoldSaysWhatWebsSaysForTheSameSettledRecord() throws {
        let read = try JSONDecoder().decode(ReceiptFixture.self, from: try fixture(Self.receiptFixture))
        XCTAssertFalse(read.cases.isEmpty)
        for each in read.cases {
            let expected = each.expected
            XCTAssertEqual(CriteriaDecisions.receiptTone == .warning, expected.warningTone, each.name)
            guard let fold = CriteriaDecisions.settledFold(each.settled) else {
                XCTFail("\(each.name): no fold"); continue
            }
            XCTAssertEqual(fold.summary, expected.summary, each.name)
            XCTAssertEqual(fold.legend, expected.legend, each.name)
            XCTAssertEqual(fold.rows.map { ReceiptFixture.Row(ordinal: $0.ordinal, text: $0.text, badge: $0.badge) },
                           expected.rows, each.name)
            let unchanged = fold.unchangedLine.map { line in
                ReceiptFixture.Unchanged(line: line, rows: fold.unchanged.map {
                    ReceiptFixture.Unchanged.Row(ordinal: $0.ordinal ?? -1, text: $0.text)
                })
            }
            XCTAssertEqual(unchanged, expected.unchanged, each.name)
            XCTAssertEqual(fold.note, expected.note, each.name)
        }
    }

    /// The case the project's criterion names: a settled APPROVE with one rewording and one
    /// addition is drawn in the warning tone with its verdict in the success tone, and folds out
    /// web's line — off the stored diff when the record has it.
    func testASettledApproveWithOneRewordingAndOneAddition() throws {
        let read = try JSONDecoder().decode(ReceiptFixture.self, from: try fixture(Self.receiptFixture))
        let approve = try XCTUnwrap(read.cases.first {
            $0.settled.decision == .approve && $0.settled.diff.map { if case .snapshot = $0 { true } else { false } } == true
        })
        XCTAssertEqual(CriteriaDecisions.receiptTone, .warning)
        XCTAssertEqual(CriteriaDecisions.receiptVerdictTone, .success)
        let fold = try XCTUnwrap(CriteriaDecisions.settledFold(approve.settled))
        XCTAssertEqual(fold.summary, "What this approved · 1 reworded, 1 added, 2 unchanged")
        XCTAssertEqual(fold.rows.map(\.badge),
                       [CriteriaDecisions.rewordedLabel, CriteriaDecisions.addedLabel])
        // The stored rewrite keeps its cut, so the row can strike the dropped words in place.
        XCTAssertEqual(fold.rows.first?.words.map(\.side), [.kept, .removed, .added])
    }

    /// No fold when the record says nothing about what was answered: an empty disclosure would
    /// promise something behind it.
    func testNoFoldForARecordWithNothingBehindIt() {
        let bare = SettledCriteriaDecision(intentId: "i", decision: .approve,
                                           decidedAt: "2026-11-19T15:45:00.000Z",
                                           baseSeal: "a", resultingSeal: "b")
        XCTAssertNil(CriteriaDecisions.settledFold(bare))
        let unreadable = SettledCriteriaDecision(intentId: "i", decision: .approve,
                                                 decidedAt: "2026-11-19T15:45:00.000Z",
                                                 baseSeal: "a", resultingSeal: "b", diff: .unreadable)
        XCTAssertNil(CriteriaDecisions.settledFold(unreadable))
    }

    /// A diff state this build does not know costs the fold its diff, not the queue its decode.
    func testAnUnknownDiffStateDecodesAsUnreadable() throws {
        let json = #"{"intentId":"i","decision":"APPROVE","decidedAt":"2026-11-19T15:45:00.000Z","baseSeal":"a","resultingSeal":"b","diff":{"state":"SOMETHING_NEW"}}"#
        let settled = try JSONDecoder().decode(SettledCriteriaDecision.self, from: Data(json.utf8))
        XCTAssertEqual(settled.diff, .unreadable)
        XCTAssertNil(settled.proposal)
    }

    // MARK: the moment every receipt prints

    private struct LabelsFixture: Decodable {
        struct ReceiptTime: Decodable {
            struct Case: Decodable { let name: String; let at: String; let expected: String }
            let now: String
            let timeZone: String
            let locale: String
            let cases: [Case]
        }
        let receiptTime: ReceiptTime
    }

    func testReceiptTimesFromTheSharedFixture() throws {
        let read = try JSONDecoder().decode(LabelsFixture.self, from: try fixture(Self.labelsFixture))
        let rule = read.receiptTime
        let now = try XCTUnwrap(RelativeTime.parse(rule.now))
        let zone = try XCTUnwrap(TimeZone(identifier: rule.timeZone))
        let locale = Locale(identifier: rule.locale.replacingOccurrences(of: "-", with: "_"))
        for each in rule.cases {
            XCTAssertEqual(OwnerConfirmations.receiptTime(each.at, now: now, timeZone: zone, locale: locale),
                           each.expected, each.name)
        }
    }

    /// The three cards' moments all come from that one rule: the criteria receipt's clock, the
    /// evidence receipt's, and the start receipt's stamp (`AcceptanceConfirmationReceiptCard` prints
    /// `receiptStamp(OwnerConfirmations.receiptTime(…))`). Read in the reader's zone, as the cards
    /// are, so a moment from another day carries its date on each.
    func testEveryReceiptUsesTheSameRule() throws {
        let read = try JSONDecoder().decode(LabelsFixture.self, from: try fixture(Self.labelsFixture))
        let now = try XCTUnwrap(RelativeTime.parse(read.receiptTime.now))
        for each in read.receiptTime.cases {
            let rule = try XCTUnwrap(OwnerConfirmations.receiptTime(each.at, now: now))
            XCTAssertEqual(CriteriaDecisions.receiptClock(each.at, now: now), rule, each.name)
            XCTAssertEqual(EvidenceDecisions.receiptTime(each.at, now: now), rule, each.name)
            let settled = SettledCriteriaDecision(intentId: "i", decision: .approve, decidedAt: each.at,
                                                  baseSeal: "a", resultingSeal: "b")
            XCTAssertEqual(CriteriaDecisions.receiptLine(settled, now: now),
                           "✓ Approved by you at \(rule)", each.name)
            XCTAssertEqual(AcceptanceConfirmations.receiptStamp(rule), "by you at \(rule)", each.name)
        }
        let anotherYear = try XCTUnwrap(read.receiptTime.cases.first { $0.name == "another year" })
        XCTAssertTrue(CriteriaDecisions.receiptClock(anotherYear.at, now: now).contains("/"),
                      "a receipt from another day carries its date")
    }
}
