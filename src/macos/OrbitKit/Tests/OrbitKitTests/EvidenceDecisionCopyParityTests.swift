import Foundation
import XCTest
@testable import OrbitKit

/// The two clients say the same words about one judgment, and this is the tripwire that keeps them
/// saying them.
///
/// The failure being prevented is specific and was named when this pair of tasks was filed: one end
/// showing a line as 「机器已核」 while the other shows it as 「提交者自述」. Nothing in a build
/// catches that — the Swift client and the browser bundle share no compiler — so the check has to
/// be a test that reads the other end's source and compares the strings, which is the same tactic
/// `coordinator-evidence-ask.ts` uses for the two option labels it copies out of `DecisionRail`.
///
/// It also watches the two SERVER strings the card is recognised by. A card is a decision card
/// because its options carry the server's labels and its body carries the server's identity line;
/// if either is re-worded, the app quietly falls back to the generic form and nobody finds out for
/// a release. Here it is a red line naming the file that moved.
final class EvidenceDecisionCopyParityTests: XCTestCase {

    /// The repo root, found by walking up from this file until the web client is under foot.
    /// Not a fixed number of `..` hops: the depth of this file is not the thing being asserted.
    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(
                atPath: dir.appendingPathComponent("src/web/src/components/ApprovalPanel.tsx").path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        // Deliberately a failure and not an `XCTSkip`: a check that quietly opts out is a check
        // that reports green on exactly the day the thing it watches went missing.
        throw ParityError.noRepo
    }

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        var description: String {
            "src/web/src/components/ApprovalPanel.tsx was not found above this test file. "
                + "OrbitKit's decision card is one half of a pair; if the web half moved, move this "
                + "check with it rather than deleting it."
        }
    }

    private func source(_ relative: String) throws -> String {
        try String(contentsOf: try repoRoot().appendingPathComponent(relative), encoding: .utf8)
    }

    private func assertContains(_ haystack: String, _ needle: String, _ what: String,
                                file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(haystack.contains(needle),
                      "\(what) drifted: the other end no longer contains \(needle.debugDescription)",
                      file: file, line: line)
    }

    // MARK: the words on the card

    func testEveryVisibleStringMatchesTheWebCard() throws {
        let web = try source("src/web/src/components/ApprovalPanel.tsx")

        assertContains(web, EvidenceDecisions.askHeading, "the card heading")
        assertContains(web, EvidenceDecisions.confirmAction, "the confirm action")
        assertContains(web, EvidenceDecisions.sendBackAction, "the send-back action")
        assertContains(web, EvidenceDecisions.sendAction, "the send action")
        assertContains(web, EvidenceDecisions.chatAction, "the third answer")
        assertContains(web, EvidenceDecisions.noteLabel, "the reason's label")
        assertContains(web, EvidenceDecisions.notePlaceholder, "the reason's placeholder")
        assertContains(web, EvidenceDecisions.noClaim, "the empty-claim line")
        assertContains(web, EvidenceDecisions.noCriterion, "the no-criterion line")
        assertContains(web, EvidenceDecisions.noGaps, "the no-gaps line")
        assertContains(web, EvidenceDecisions.fullLabel, "the full-text fold")
    }

    /// The counted strings, which are templates on one side and interpolations on the other: the
    /// invariant is the words AROUND the number, since the number itself is the row's.
    func testCountedLinesMatchTheWebCard() throws {
        let web = try source("src/web/src/components/ApprovalPanel.tsx")

        assertContains(web, "还有 ${rest} 条", "「还有 N 条」")
        assertContains(web, "提交者声明的缺口 · ", "the gaps heading")
        assertContains(web, " 项机器已核", "the folded checks line")
        assertContains(web, " 项没过", "the checks that did not hold")
        assertContains(web, "证据 ${index + 1}/${total}", "the position chip")
        assertContains(web, "已选「", "the held-pick note")

        for check in EvidenceDecisions.checks(
            EvidenceDecisionRow(taskId: "t", title: "x", criterion: nil, evidenceRevision: "1",
                                claim: "c", gaps: [], citations: [],
                                decidability: EvidenceDecisionDecidability(decidable: true),
                                independence: EvidenceDecisionIndependence(independent: true))) {
            // The counted one reads `${resolved}/${total} 条引用解析成功` over there.
            let words = check.text.contains("条引用解析成功") ? " 条引用解析成功" : check.text
            assertContains(web, words, "the machine check \(check.text.debugDescription)")
        }
    }

    /// Three shown and the rest counted is a contract between the clients, not a width judgment —
    /// so the number itself has to be the same on both sides, unlike the claim clamp.
    func testGapsShownIsTheSameNumberOnBothEnds() throws {
        let web = try source("src/web/src/components/ApprovalPanel.tsx")
        assertContains(web, "const DECISION_GAPS_SHOWN = \(EvidenceDecisions.gapsShown);",
                       "the number of gaps shown before counting")
    }

    // MARK: what the card is recognised BY

    func testTheTwoOptionLabelsAreStillTheServersOwn() throws {
        let rail = try source("src/web/src/components/DecisionRail.tsx")
        assertContains(rail, "CONFIRM_LABEL = '\(EvidenceDecisions.confirmOption)'", "the confirm label")
        assertContains(rail, "SEND_BACK_LABEL = '\(EvidenceDecisions.sendBackOption)'", "the send-back label")

        let ask = try source("src/apiserver/src/tasks/coordinator-evidence-ask.ts")
        assertContains(ask, "CONFIRM_OPTION = '\(EvidenceDecisions.confirmOption)'",
                       "the label the ask actually raises")
        assertContains(ask, "SEND_BACK_OPTION = '\(EvidenceDecisions.sendBackOption)'",
                       "the label the ask actually raises")
    }

    /// `askIdentity` is a handle into a string the server writes. If that line is re-worded, every
    /// decision card silently becomes a generic form — so the wording is asserted, not assumed.
    func testTheIdentityLineIsStillTheOneTheServerWrites() throws {
        let ask = try source("src/apiserver/src/tasks/coordinator-evidence-ask.ts")
        assertContains(ask, "task ${uuidToBase62(row.taskId)}, evidence rev ${row.evidenceRevision}",
                       "the identity line the card matches on")

        // And the Swift spelling of it agrees, field for field.
        let row = EvidenceDecisionRow(
            taskId: "34LMiluvx0jK63cj8arWl", title: "t", criterion: nil, evidenceRevision: "7",
            claim: "c", gaps: [], citations: [],
            decidability: EvidenceDecisionDecidability(decidable: true),
            independence: EvidenceDecisionIndependence(independent: true))
        XCTAssertEqual(EvidenceDecisions.askIdentity(row),
                       "task 34LMiluvx0jK63cj8arWl, evidence rev 7")
    }
}
