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

    private func commit(_ sha: String, _ subject: String, merge: Bool? = nil) -> [String: Any] {
        var value: [String: Any] = ["sha": String(repeating: sha, count: 40), "subject": subject, "author": "Orbit", "date": "2026-10-01"]
        if let merge { value["merge"] = merge }
        return value
    }

    /// Each commit the push adds is told apart by where it comes from, and this session's beyond the
    /// first five wait behind one row — never the local-only commits the review is for.
    func testThePushListsWhereEachCommitComesFrom() throws {
        let session = (1...7).map { commit("\($0)", "Session \($0)") }
        let pushed = session + [commit("f", "Merge origin/develop into develop", merge: true),
                                commit("b", "Extra local work", merge: false)]
        let r = try decode(payload(["pushCommits": pushed, "addsMergeCommit": true]))
        XCTAssertEqual(r.pushCommits?.map { r.origin(of: $0) },
                       Array(repeating: .session, count: 7) + [.merge, .localOnly])
        let inline = r.inlinePushCommits()
        XCTAssertEqual(inline.shown.map(\.subject), (1...5).map { "Session \($0)" }
                       + ["Merge origin/develop into develop", "Extra local work"])
        XCTAssertEqual(inline.hidden, 2)
        XCTAssertEqual(r.landingNote, "A merge commit joins both histories; nothing already on origin/develop is rewritten."
                       + " Includes 1 local-only commit that was never pushed.")
        XCTAssertEqual(r.reviewNote, "Git preview only; no merge check is configured."
                       + " For linear history or required PRs, prepare a PR candidate instead.",
                       "the push's own note already names the local-only commit")
    }

    /// The owner's case, 2026-10-01: local develop matched origin/develop and only this session's
    /// commits went out, yet the sheet's note spoke of "the local-only commits above".
    func testTheNoteNeverPointsAtLocalOnlyCommitsThatAreNotThere() throws {
        let matching: [String: Any] = ["remoteSha": String(repeating: "b", count: 40), "localCommits": NSNull()]
        let r = try decode(payload(matching.merging(["pushCommits": [commit("d", "Session work")]]) { _, new in new }))
        XCTAssertEqual(r.targetRelation, "Local develop matches origin/develop")
        XCTAssertEqual(r.landingNote, "Fast-forward push: nothing already on origin/develop is rewritten.")
        XCTAssertEqual(r.reviewNote, "Git preview only; no merge check is configured."
                       + " For linear history or required PRs, prepare a PR candidate instead.")
        XCTAssertEqual(try decode(payload(matching)).reviewNote, r.reviewNote, "nor from a runner that predates the push list")
        XCTAssertEqual(try decode(payload()).reviewNote, "Git preview only; no merge check is configured."
                       + " The local-only commits above will be pushed with this session’s changes."
                       + " For linear history or required PRs, prepare a PR candidate instead.",
                       "an older runner's sheet lists them on their own, so it still names them")
    }

    /// Two absent lists mean "the same" only when the tips agree; otherwise nothing was read.
    func testTheTargetRelationNeedsBothSidesRead() throws {
        let c = commit("f", "Remote work")
        XCTAssertEqual(try decode(payload()).targetRelation, "Local develop is 1 ahead of origin/develop")
        XCTAssertEqual(try decode(payload(["remoteCommits": [c, c]])).targetRelation,
                       "Local develop: 1 ahead, 2 behind origin/develop")
        XCTAssertEqual(try decode(payload(["localCommits": NSNull(), "remoteCommits": [c]])).targetRelation,
                       "Local develop is 1 behind origin/develop")
        XCTAssertNil(try decode(payload(["localCommits": NSNull()])).targetRelation)
        XCTAssertNil(try decode(["code": "TARGET_DIVERGED", "targetBranch": "develop"]).targetRelation)
    }

    /// The review sheet pins the step the state asks for, the other steps under it, and keeps
    /// "Check again" in its header whenever checking isn't that step.
    func testTheSheetPinsTheStepTheStateAsksFor() throws {
        let check = MergeRecoveryButton(title: "Check again", action: .preview)
        let resolve = MergeRecoveryButton(title: "Resolve in repair session", action: .repair(preparePR: false))
        let preparePR = MergeRecoveryButton(title: "Prepare PR candidate", action: .repair(preparePR: true))

        let ready = try decode(payload()).buttons(supported: true)
        XCTAssertEqual(ready, MergeRecoveryButtons(
            primary: MergeRecoveryButton(title: "Sync develop and merge", action: .apply),
            secondary: [preparePR], headerCheck: check))
        XCTAssertEqual(try decode(payload(["repairWorktree": NSNull()])).buttons(supported: true).secondary, [],
                       "no repair worktree, no PR candidate to prepare")

        XCTAssertEqual(try decode(["code": "TARGET_DIVERGED", "targetBranch": "develop"]).buttons(supported: true),
                       MergeRecoveryButtons(primary: MergeRecoveryButton(title: "Check and repair", action: .preview),
                                            secondary: [], headerCheck: nil),
                       "not checked yet: checking is the step")
        XCTAssertEqual(try decode(payload(["code": "PREVIEW_CHANGED"])).buttons(supported: true),
                       MergeRecoveryButtons(primary: check, secondary: [resolve, preparePR], headerCheck: nil),
                       "the title says check again, so that is the step")
        XCTAssertEqual(try decode(payload(["code": "CONFLICT"])).buttons(supported: true),
                       MergeRecoveryButtons(primary: resolve, secondary: [preparePR], headerCheck: check))
        XCTAssertEqual(try decode(payload(["code": "PUSH_FAILED"])).buttons(supported: true),
                       MergeRecoveryButtons(
                           primary: MergeRecoveryButton(title: "Check result / retry reviewed candidate", action: .apply),
                           secondary: [resolve, preparePR], headerCheck: check))
        XCTAssertEqual(try decode(payload(["code": "LOCAL_SYNC_PENDING"])).buttons(supported: true),
                       MergeRecoveryButtons(primary: MergeRecoveryButton(title: "Sync local checkout", action: .syncLocal),
                                            secondary: [], headerCheck: nil))
        XCTAssertEqual(try decode(payload()).buttons(supported: false),
                       MergeRecoveryButtons(primary: nil, secondary: [], headerCheck: nil),
                       "an older runner can't recover: nothing to press")
    }
}
