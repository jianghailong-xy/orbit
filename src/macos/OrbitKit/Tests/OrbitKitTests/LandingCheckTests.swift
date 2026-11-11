import Foundation
import XCTest
@testable import OrbitKit

final class LandingCheckTests: XCTestCase {
    func testEveryWebCopyKeyHasAnExactNativeCounterpart() throws {
        var root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while !FileManager.default.fileExists(atPath: root.appendingPathComponent("src/web/src/lib/landingCheck.ts").path) {
            let parent = root.deletingLastPathComponent()
            guard parent != root else { return XCTFail("Missing web copy source") }
            root = parent
        }
        let web = try String(contentsOf: root.appendingPathComponent("src/web/src/lib/landingCheck.ts"), encoding: .utf8)
        let pairs: [(String, String)] = [
            ("LABEL", LandingCheckCopy.label),
            ("CONFIRM_TITLE", LandingCheckCopy.confirmTitle),
            ("CONFIRM_ACTION", LandingCheckCopy.confirmAction),
            ("COMMAND", LandingCheckCopy.command),
            ("TIMEOUT", LandingCheckCopy.timeout),
            ("HINT", LandingCheckCopy.hint),
            ("INHERITS", LandingCheckCopy.inherits),
            ("COMMAND_PLACEHOLDER", LandingCheckCopy.commandPlaceholder),
            ("INHERITS_TIMEOUT", LandingCheckCopy.inheritsTimeout),
            ("TIMEOUT_PLACEHOLDER", LandingCheckCopy.timeoutPlaceholder),
            ("TIMEOUT_HINT", LandingCheckCopy.timeoutHint),
            ("MAIN", LandingCheckCopy.main),
            ("APPLIES", LandingCheckCopy.applies),
            ("WAITING", LandingCheckCopy.waiting),
            ("RESUMES", LandingCheckCopy.resumes),
            ("BASELINE_BODY", LandingCheckCopy.baselineBody),
            ("HELD", LandingCheckCopy.held),
            ("UPSTREAM", LandingCheckCopy.upstream),
            ("TIP", LandingCheckCopy.tip),
            ("BASELINE", LandingCheckCopy.baseline),
            ("VIEW_HELD", LandingCheckCopy.viewHeld),
        ]
        let regex = try NSRegularExpression(pattern: "(?m)^  ([A-Z_]+): '([^']*)',")
        let keys = regex.matches(in: web, range: NSRange(web.startIndex..., in: web)).compactMap {
            Range($0.range(at: 1), in: web).map { String(web[$0]) }
        }
        XCTAssertEqual(Set(keys), Set(pairs.map { $0.0 }), "A missing parity counterpart must fail")
        for (key, value) in pairs { XCTAssertTrue(web.contains("\(key): '\(value)'"), key) }
        XCTAssertEqual(LandingCheckCopy.inheritedCommand("make all"), "Uses merge check: make all")
        XCTAssertEqual(LandingCheckCopy.inheritedTimeout(900), "Uses merge check timeout: 900 seconds")
        XCTAssertEqual(LandingCheckCopy.title("project/payments"), "Baseline checks failing on project/payments")
    }

    func testSettingsDecodeAndWriteExactCommandAndIndependentNulls() throws {
        let view = try JSONDecoder().decode(ProjectIntegrationView.self, from: Data("""
            {"landingCheckCommand":"  make fast  ","landingCheckTimeoutSeconds":600,
             "landingCheckCommandAbsentReason":null,"mergeCheckTimeoutSeconds":900}
            """.utf8))
        XCTAssertEqual(view.landingCheckCommand, "  make fast  ")
        XCTAssertEqual(view.landingCheckTimeoutSeconds, 600)
        XCTAssertEqual(view.mergeCheckTimeoutSeconds, 900)
        XCTAssertNil(RunSettings.landingCheckWrite(view, command: "  make fast  ", timeout: 600))
        let write = try XCTUnwrap(RunSettings.landingCheckWrite(view, command: "", timeout: nil))
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(write)) as! [String: Any]
        XCTAssertTrue(json["landingCheckCommand"] is NSNull)
        XCTAssertTrue(json["landingCheckTimeoutSeconds"] is NSNull)
        XCTAssertNil(json["mergeCheckCommand"])
    }

    func testConfirmationSnapshotPreservesOmittedFieldsAndNullInherits() throws {
        let input = try JSONDecoder().decode(JSONValue.self, from: Data("""
            {"currentLandingCheckCommand":"  make fast  ","currentLandingCheckTimeoutSeconds":300,
             "currentMergeCheckCommand":"make all","currentMergeCheckTimeoutSeconds":900,
             "landingCheckTimeoutSeconds":null}
            """.utf8))
        let preview = try XCTUnwrap(Approvals.mergeCheckChangePreview(toolName: "orbit_project_update_integration", from: input))
        XCTAssertEqual(preview.commandLine("landing", after: true), "  make fast  ")
        XCTAssertEqual(preview.commandLine("merge", after: true), "make all")
        XCTAssertEqual(preview.budgetLine("landing", after: false), "300 seconds")
        XCTAssertEqual(preview.budgetLine("landing", after: true), "Uses merge check timeout: 900 seconds")
    }

    func testThreeLandingVerdictsAndBothAttributionsHaveSeparateRows() {
        for text in ["Landing check passed · 14m", "Landing check failed · exit 1 · 14m",
                     "Landing check skipped · only exempt paths changed"] {
            for verdict in ["also fails", "passes"] {
                let attribution = "Checked the project branch with main, without this task · " + verdict
                let entries = [IntegrationTimelineEntry(kind: "CHECK_FINISHED", check: LandingTimelineCheck(name: "LANDING_CHECK", index: 1), text: text),
                    IntegrationTimelineEntry(kind: "CHECK_FINISHED", check: LandingTimelineCheck(name: "LANDING_CHECK", index: 2),
                        data: ["scope": .string("BASELINE")], text: attribution)]
                let rows = LandingSteps.steps(entries, kind: "LAND_TASK")
                XCTAssertEqual(rows.map(\.key), ["check:LANDING_CHECK", "check:BASELINE"])
                XCTAssertEqual(rows.map { $0.summary.text }, [text, attribution])
                XCTAssertEqual(rows.first?.name, "Landing check")
            }
        }
    }

    func testBaselineCardReadsTheMeasuredTreeAndHeldTasks() throws {
        let row = try JSONDecoder().decode(ProjectOpenItemRow.self, from: Data("""
            {"itemId":"b1","kind":"INTEGRATION_CHECK_FAILED","title":"Baseline red",
             "waitingSince":"2026-11-11T00:00:00Z","baseline":{"upstreamSha":"u","targetSha":"t",
             "mergeTreeSha":"m","check":{"name":"LANDING_CHECK","command":"make fast"}},"heldTaskIds":["t1","t2"]}
            """.utf8))
        XCTAssertEqual(row.heldTaskIds, ["t1", "t2"])
        guard case .rows(let block) = ExceptionCards.facts(row) else { return XCTFail("Missing baseline card") }
        XCTAssertEqual(block.rows.map(\.label), ["", "Landings on hold", "Upstream", "Project tip", "Combined baseline", "Landing check", ""])
        XCTAssertEqual(block.rows.map(\.value), [LandingCheckCopy.baselineBody, "2", "u", "t", "m", "make fast", LandingCheckCopy.resumes])
    }
    func testScopeRecoveryNeverAssignsNewestResultsToAnotherAttemptClaimOrRound() {
        let entry = IntegrationTimelineEntry(kind: "CHECK_FINISHED", claim: 2, round: 3,
            check: LandingTimelineCheck(name: "LANDING_CHECK", index: 1), data: ["exitCode": .number(1), "expectedExitCode": .number(0)],
            text: "Landing check failed · exit 1 · 14m")
        let landing = SessionLandingView(checks: [LandingCheckResult(scope: "BASELINE")],
            currentAttempt: SessionLandingAttempt(jobId: "new", kind: "LAND_TASK", state: "CHECK_FAILED", round: 3, claim: 2))
        let scoped = LandingCheckCopy.scopedEntries([entry], landing: landing, jobID: "new")
        XCTAssertEqual(LandingCheckCopy.timelineText(scoped[0]), "Checked the project branch with main, without this task · also fails")
        XCTAssertEqual(LandingCheckCopy.scopedEntries([entry], landing: landing, jobID: "old"), [entry])
        let earlier = SessionLandingView(checks: landing.checks,
            currentAttempt: SessionLandingAttempt(jobId: "new", kind: "LAND_TASK", state: "CHECK_FAILED", round: 3, claim: 3))
        XCTAssertEqual(LandingCheckCopy.scopedEntries([entry], landing: earlier, jobID: "new"), [entry])
    }

}
