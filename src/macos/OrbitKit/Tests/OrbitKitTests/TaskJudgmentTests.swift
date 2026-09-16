import XCTest
@testable import OrbitKit

/// The detail page's judgment: which chip a row gets, what a gate row's button says and why, and
/// what the check card reads. The words themselves are pinned against the browser by
/// `TaskJudgmentCopyParityTests`; this holds the decisions that choose between them.
final class TaskJudgmentTests: XCTestCase {

    private func task(_ json: String) -> TaskItem {
        try! JSONDecoder().decode(TaskItem.self, from: Data(json.utf8))
    }

    private func verifier(_ json: String) -> TaskVerifierRef {
        try! JSONDecoder().decode(TaskVerifierRef.self, from: Data(json.utf8))
    }

    /// A gate row says the thing that is true of it; a work row names the method that settles it;
    /// a row written before criteria were required says neither, rather than inventing one.
    func testChipNamesTheJudgment() {
        let gate = task(#"{"id":"1","title":"a","status":"OPEN","completionPolicy":"VERIFICATION_PASSED"}"#)
        XCTAssertEqual(TaskJudgment.chip(gate), TaskJudgmentChip(isGate: true, text: "闸门 · 本行没有自己的活"))

        let executable = task(#"{"id":"2","title":"a","status":"OPEN","completionCriterion":"EXECUTABLE"}"#)
        XCTAssertEqual(TaskJudgment.chip(executable), TaskJudgmentChip(isGate: false, text: "完成判定 · 验收命令"))

        // A criterion that settles the row with an independent verdict is still work of its own.
        let independent = task(#"{"id":"3","title":"a","status":"OPEN","completionCriterion":"VERIFICATION","completionPolicy":"MANUAL"}"#)
        XCTAssertEqual(TaskJudgment.chip(independent)?.isGate, false)

        XCTAssertNil(TaskJudgment.chip(task(#"{"id":"4","title":"a","status":"OPEN"}"#)))
        XCTAssertNil(TaskJudgment.chip(task(#"{"id":"5","title":"a","status":"OPEN","completionCriterion":"SOMETHING_NEW"}"#)),
                     "an unknown criterion gets no chip rather than a guess")
    }

    /// The check's own state in the card's three words: a conclusion, or none yet — whatever the
    /// check's run is doing.
    func testVerifierOutcomeReadsTheVerdict() {
        XCTAssertEqual(VerifierOutcome.of(verifier(#"{"id":"v","title":"t","verdict":"PASS"}"#)), .pass)
        XCTAssertEqual(VerifierOutcome.of(verifier(#"{"id":"v","title":"t","verdict":"FAIL"}"#)), .fail)
        XCTAssertEqual(VerifierOutcome.of(verifier(#"{"id":"v","title":"t","verdict":"INCONCLUSIVE"}"#)), .fail)
        XCTAssertEqual(VerifierOutcome.of(verifier(#"{"id":"v","title":"t"}"#)), .open)
        XCTAssertEqual(VerifierOutcome.of(verifier(#"{"id":"v","title":"t","verdict":"SOMETHING_NEW"}"#)), .open)

        XCTAssertEqual(VerifierOutcome.pass.label, "PASS")
        XCTAssertEqual(VerifierOutcome.fail.label, "FAIL")
        XCTAssertEqual(VerifierOutcome.open.label, "Open")
        XCTAssertEqual(VerifierOutcome.pass.pillKind, .done)
        XCTAssertEqual(VerifierOutcome.fail.pillKind, .failed)
        XCTAssertEqual(VerifierOutcome.open.pillKind, .open)
    }

    /// The hint under a gate row's button is the check's state, and an unknown one gets the generic
    /// sentence rather than nothing.
    func testGateHintFollowsTheVerificationState() {
        XCTAssertEqual(TaskJudgment.gateHint("MISSING"), TaskJudgmentCopy.verifierCardEmpty)
        XCTAssertEqual(TaskJudgment.gateHint("RUNNING"),
                       "复核任务正在跑 —— 这一行由它的结论判定。")
        XCTAssertEqual(TaskJudgment.gateHint(nil), TaskJudgment.gateHint("PENDING"))
        XCTAssertEqual(TaskJudgment.gateHint("FROM_A_NEWER_SERVER"), TaskJudgment.gateHint("PENDING"))
    }

    /// The check card is drawn on a row the declaration owns, and on any row something checks.
    func testCardShowsOnGateRowsAndCheckedRows() {
        let gate = task(#"{"id":"1","title":"a","status":"OPEN","completionPolicy":"VERIFICATION_PASSED"}"#)
        let checked = task(#"{"id":"2","title":"a","status":"OPEN","verifier":{"id":"v","title":"check it"}}"#)
        let plain = task(#"{"id":"3","title":"a","status":"OPEN"}"#)

        XCTAssertTrue(TaskJudgment.isGateRow(gate) || gate.verifier != nil)
        XCTAssertTrue(TaskJudgment.isGateRow(checked) || checked.verifier != nil)
        XCTAssertFalse(TaskJudgment.isGateRow(plain) || plain.verifier != nil)
        XCTAssertEqual(checked.verifier?.title, "check it")
    }
}
