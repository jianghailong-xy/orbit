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
        // Every copy object the web declares, each held key by key: a key two objects share (`COMMAND`,
        // `LABEL`) is held in each of them, and an object this table does not know fails. (This guard
        // came with main's second port of revision 42 part two; kept, pointed at this client's words.)
        let objects: [String: [(String, String)]] = [
            "LANDING_CHECK_COPY": [
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
            ],
            // Revision 42 part two (docs/mocks/landing-measured): the three values, who set it, the
            // coordinator's changes and a task's exemption.
            "LANDING_MODE_COPY": [
                ("MERGE_CHECK", LandingProvenanceCopy.modeMergeCheck),
                ("COMMAND", LandingProvenanceCopy.modeCommand),
                ("NONE", LandingProvenanceCopy.modeNone),
                ("NONE_HEAD", LandingProvenanceCopy.noneLead),
                ("NONE_BODY", LandingProvenanceCopy.noneBody),
                ("COMMAND_NOTE", LandingProvenanceCopy.commandNote),
                ("WHO_CAN_SET", LandingProvenanceCopy.whoCanSet),
            ],
            "LANDING_CHECK_ORIGIN_COPY": [
                ("OWNER", LandingProvenanceCopy.you),
                ("COORDINATOR", LandingProvenanceCopy.coordinator),
                ("CARD", LandingProvenanceCopy.card),
                ("START", LandingProvenanceCopy.start),
            ],
            "CHANGES_COPY": [
                ("TITLE", LandingProvenanceCopy.changesTitle),
                ("INTRO", LandingProvenanceCopy.changesIntro),
                ("EMPTY", LandingProvenanceCopy.noChanges),
                ("LANDING_CHECK", LandingProvenanceCopy.landingCheck),
                ("CHECK_EXEMPT", LandingProvenanceCopy.checkExemptHead),
                ("USES_MERGE_CHECK", LandingProvenanceCopy.usesMergeCheck),
                ("NO_CHECK", LandingProvenanceCopy.modeNone),
                ("EXEMPT", LandingProvenanceCopy.exemptValue),
                ("NOT_EXEMPT", LandingProvenanceCopy.notExemptValue),
                ("REVERT", LandingProvenanceCopy.revert),
                ("YOUR_CHANGE", LandingProvenanceCopy.yourChangeHead),
                ("YOUR_CHANGE_NOTHING", LandingProvenanceCopy.yourChange),
                ("CONFIRM_TITLE", LandingProvenanceCopy.revertTitle),
                ("CONFIRM_CONSEQUENCE", LandingProvenanceCopy.revertAfter),
                ("CANCEL", LandingProvenanceCopy.cancel),
            ],
            "TASK_EXEMPT_COPY": [
                ("LABEL", LandingProvenanceCopy.landingCheck),
                ("BADGE", LandingProvenanceCopy.exempt),
                ("REMOVE", LandingProvenanceCopy.removeExemption),
                ("SKIPPED", LandingProvenanceCopy.skipped),
                ("MERGE_CHECK_STILL_RUNS", LandingProvenanceCopy.mergeCheckStillRuns),
                ("STILL_RUNS", LandingProvenanceCopy.stillRuns),
            ],
        ]
        let block = try NSRegularExpression(pattern: "(?s)export const ([A-Z_]+) = \\{\\n(.*?)\\n\\} as const;")
        let entry = try NSRegularExpression(pattern: "(?m)^  ([A-Z_]+): '([^']*)',")
        var declared: [String: [String: String]] = [:]
        for match in block.matches(in: web, range: NSRange(web.startIndex..., in: web)) {
            guard let name = Range(match.range(at: 1), in: web).map({ String(web[$0]) }),
                  let bodyRange = Range(match.range(at: 2), in: web) else { continue }
            let body = String(web[bodyRange])
            var keys: [String: String] = [:]
            for row in entry.matches(in: body, range: NSRange(body.startIndex..., in: body)) {
                guard let key = Range(row.range(at: 1), in: body), let value = Range(row.range(at: 2), in: body) else { continue }
                XCTAssertNil(keys[String(body[key])], "\(name) declares \(body[key]) twice")
                keys[String(body[key])] = String(body[value])
            }
            declared[name] = keys
        }
        XCTAssertEqual(Set(declared.keys), Set(objects.keys), "A copy object without a native counterpart must fail")
        for (name, pairs) in objects {
            let keys = declared[name] ?? [:]
            XCTAssertEqual(Set(keys.keys), Set(pairs.map { $0.0 }), "A missing parity counterpart in \(name) must fail")
            for (key, value) in pairs { XCTAssertEqual(keys[key], value, "\(name).\(key)") }
        }
        // Who can set it, under No check: every note in the web's order and words, and no other.
        for entry in LandingProvenanceCopy.originNotes {
            XCTAssertTrue(web.contains("{ by: '\(entry.by)', note: '\(entry.note)' }"), "the note for \(entry.by)")
        }
        let notes = try NSRegularExpression(pattern: "\\{ by: '([A-Z_]+)'")
            .matches(in: web, range: NSRange(web.startIndex..., in: web))
            .compactMap { Range($0.range(at: 1), in: web).map { String(web[$0]) } }
        XCTAssertEqual(notes, LandingProvenanceCopy.originNotes.map(\.by))
        let originLabels = Dictionary(uniqueKeysWithValues: objects["LANDING_CHECK_ORIGIN_COPY"]!)
        for entry in LandingProvenanceCopy.originNotes {
            XCTAssertEqual(entry.label, originLabels[entry.by], "the note for \(entry.by) wears another badge")
        }
        XCTAssertEqual(LandingCheckCopy.inheritedCommand("make all"), "Uses merge check: make all")
        XCTAssertEqual(LandingCheckCopy.inheritedTimeout(900), "Uses merge check timeout: 900 seconds")
        XCTAssertEqual(LandingCheckCopy.title("project/payments"), "Baseline checks failing on project/payments")
        // The functions beside the objects: the count row, the revert line, the exemption's reason.
        XCTAssertTrue(web.contains("`${count} ${count === 1 ? 'change' : 'changes'}`"))
        XCTAssertEqual(LandingProvenanceCopy.changesCount(3), "3 changes")
        XCTAssertEqual(LandingProvenanceCopy.changesCount(1), "1 change")
        XCTAssertTrue(web.contains("`Reverted by you · ${when} · coordinator needs a card for this field`"))
        XCTAssertEqual(LandingProvenanceCopy.revertedByYou("just now"),
                       "Reverted by you · just now · coordinator needs a card for this field")
        XCTAssertTrue(web.contains("`Exempt: ${reason}`"))
        XCTAssertEqual(LandingProvenanceCopy.exemptBecause("why"), "Exempt: why")
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
    func testEscalatedBaselineItemKeepsTheBaselineCardNotWhoFixes() throws {
        let row = try JSONDecoder().decode(ProjectOpenItemRow.self, from: Data("""
            {"itemId":"b1","kind":"INTEGRATION_CHECK_FAILED","title":"Baseline red","assignee":"OWNER",
             "assigneeReason":"ESCALATED","escalatedAt":"2026-11-11T00:06:00Z","taskId":"t0",
             "waitingSince":"2026-11-11T00:00:00Z","facts":{"targetRef":"refs/heads/project/payments"},
             "baseline":{"upstreamSha":"u","targetSha":"t",
             "mergeTreeSha":"m","check":{"name":"LANDING_CHECK","command":"make fast"}},"heldTaskIds":["t1","t2"]}
            """.utf8))
        XCTAssertEqual(row.assignee, .owner)
        XCTAssertEqual(row.assigneeReason, .escalated)
        XCTAssertFalse(ExceptionCards.whoFixesIt(row), "A baseline item keeps its own card once escalated")
        XCTAssertEqual(ExceptionCards.headingLine(row), "Baseline checks failing on project/payments")
        guard case .rows(let block) = ExceptionCards.facts(row) else { return XCTFail("Missing baseline card") }
        XCTAssertEqual(block.rows.map(\.label), ["", "Landings on hold", "Upstream", "Project tip", "Combined baseline", "Landing check", ""])
        XCTAssertEqual(block.rows.map(\.value), [LandingCheckCopy.baselineBody, "2", "u", "t", "m", "make fast",
                                                 "Landings resume automatically when this open item is resolved."])
        // One "View held tasks" link per held task: the card draws one per id.
        XCTAssertEqual(LandingCheckCopy.viewHeld, "View held tasks")
        XCTAssertEqual(row.heldTaskIds, ["t1", "t2"])
    }
    func testScopeRecoveryNeverAssignsNewestResultsToAnotherAttemptClaimOrRound() {
        let entry = IntegrationTimelineEntry(kind: "CHECK_FINISHED", claim: 2, round: 3,
            check: LandingTimelineCheck(name: "LANDING_CHECK", index: 1), data: ["exitCode": .int(1), "expectedExitCode": .int(0)],
            text: "Landing check failed · exit 1 · 14m")
        let landing = SessionLandingView(checks: [LandingCheckResult(scope: "BASELINE")],
            currentAttempt: SessionLandingAttempt(jobId: "new", kind: "LAND_TASK", state: "CHECK_FAILED", round: 3, claim: 2))
        let scoped = LandingCheckCopy.scopedEntries([entry], landing: landing, jobID: "new")
        XCTAssertEqual(LandingCheckCopy.timelineText(scoped[0]), "Checked the project branch with main, without this task · also fails")
        XCTAssertEqual(LandingCheckCopy.scopedEntries([entry], landing: landing, jobID: "old"), [entry])
        let explicit = IntegrationTimelineEntry(kind: "CHECK_FINISHED", claim: 2, round: 3,
            check: entry.check, data: ["scope": .string("TASK"), "exitCode": .int(1), "expectedExitCode": .int(0)], text: entry.text)
        XCTAssertEqual(LandingCheckCopy.scopedEntries([explicit], landing: landing, jobID: "new"), [explicit],
                       "Event scope wins over a conflicting result-array scope")
        let server = IntegrationTimelineEntry(kind: "CHECK_FINISHED", claim: 1, round: 1,
            check: entry.check, data: ["scope": .string("BASELINE"), "exitCode": .int(0), "expectedExitCode": .int(0)],
            text: "Checked the project branch with main, without this task · passes")
        XCTAssertEqual(LandingCheckCopy.timelineText(LandingCheckCopy.scopedEntries([server], landing: landing, jobID: "old")[0]), server.text)
        let earlier = SessionLandingView(checks: landing.checks,
            currentAttempt: SessionLandingAttempt(jobId: "new", kind: "LAND_TASK", state: "CHECK_FAILED", round: 3, claim: 3))
        XCTAssertEqual(LandingCheckCopy.scopedEntries([entry], landing: earlier, jobID: "new"), [entry])
    }

}
