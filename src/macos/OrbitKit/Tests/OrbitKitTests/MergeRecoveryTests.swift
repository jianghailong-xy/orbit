import XCTest
@testable import OrbitKit

final class MergeRecoveryTests: XCTestCase {
    private func payload(_ changes: [String: Any] = [:]) -> [String: Any] {
        var value: [String: Any] = [
            "code": "READY", "targetBranch": "develop", "previewId": "reviewed",
            "sourceSha": String(repeating: "a", count: 40), "localSha": String(repeating: "b", count: 40),
            "remoteSha": String(repeating: "c", count: 40), "candidateSha": String(repeating: "d", count: 40),
            "candidateTreeSha": String(repeating: "e", count: 40), "patch": "full diff",
            "repairBranch": "orbit/recovery/abc", "repairWorktree": "/private/abc",
            "check": ["status": "unconfigured"], "phase": "TARGET_SYNC", "conflicts": ["file.ts"],
            "localCommits": [["sha": String(repeating: "b", count: 40), "subject": "Extra local work", "author": "Alice", "date": "2026-09-30"]],
        ]
        value.merge(changes) { _, new in new }
        return value
    }

    private func decode(_ value: [String: Any]) throws -> MergeRecovery {
        try JSONDecoder().decode(MergeRecovery.self, from: JSONSerialization.data(withJSONObject: value))
    }

    func testCompleteCandidateAndLegacyDiagnosticsDecode() throws {
        let recovery = try decode(payload())
        XCTAssertTrue(recovery.ready)
        XCTAssertEqual(recovery.localCommits?.first?.subject, "Extra local work")
        XCTAssertFalse(try decode(["code": "TARGET_DIVERGED", "targetBranch": "develop"]).ready)
        XCTAssertFalse(try decode(payload(["code": "FUTURE_REASON"])).ready)
        let detail = try JSONDecoder().decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: [
            "id": "session", "mergeRecovery": payload(), "mergeRecoverySupported": true, "workspace": ["id": "workspace"],
        ]))
        XCTAssertEqual(detail.workspace?.id, "workspace")
        XCTAssertTrue(detail.mergeRecoverySupported == true)
        XCTAssertTrue(detail.mergeRecovery?.ready == true)
    }

    func testIncompleteOrFailedCandidateCannotBeApproved() throws {
        for change: [String: Any] in [
            ["previewId": ""], ["candidateSha": "short"], ["patch": NSNull()],
            ["check": NSNull()], ["check": ["status": "failed"]], ["code": "PREVIEW_CHANGED"],
        ] {
            XCTAssertFalse(try decode(payload(change)).ready)
        }
    }

    func testRequestApprovesOnlyTheNamedPreview() throws {
        let data = try JSONEncoder().encode(MergeRequest(targetBranch: "develop", recoveryAction: "apply", previewId: "reviewed"))
        let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(fields, ["targetBranch": "develop", "recoveryAction": "apply", "previewId": "reviewed"])
        let legacy = try JSONSerialization.jsonObject(with: JSONEncoder().encode(MergeRequest())) as? [String: String]
        XCTAssertEqual(legacy, [:])
    }

    func testPartialLandingRemainsVisibleAndNamesLocalSync() throws {
        let recovery = try decode(payload(["code": "LOCAL_SYNC_PENDING"]))
        XCTAssertTrue(recovery.title.contains("local sync pending"))
        XCTAssertEqual(WorktreeBarLogic.mode(isolationStatus: "worktree", branch: "orbit/session",
                                           changedFileCount: 0, mergeStatus: "merged", hasMergeRecovery: true), .worktree)
    }

    func testRepairPromptKeepsSharedTargetAndOriginalSourceSafe() throws {
        let recovery = try decode(payload())
        let prompt = recovery.repairPrompt(preparePR: false)
        XCTAssertTrue(prompt.contains("/private/abc"))
        XCTAssertTrue(prompt.contains("file.ts"))
        XCTAssertTrue(prompt.contains("TARGET_SYNC"))
        XCTAssertTrue(prompt.contains("Do not push the target."))
        XCTAssertTrue(prompt.contains("owner will check"))
        XCTAssertTrue(recovery.repairPrompt(preparePR: true).contains("organize commits on a separate PR candidate"))
    }
}
