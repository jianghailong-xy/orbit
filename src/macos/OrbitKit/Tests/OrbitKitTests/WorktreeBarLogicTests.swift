import XCTest
@testable import OrbitKit

final class WorktreeBarLogicTests: XCTestCase {

    // MARK: mode

    func testModeHiddenWithoutIsolation() {
        XCTAssertEqual(WorktreeBarLogic.mode(isolationStatus: nil, branch: "orbit/x-abcdef", changedFileCount: 3), .hidden)
    }

    func testModeNotIsolated() {
        XCTAssertEqual(WorktreeBarLogic.mode(isolationStatus: "shared-nogit", branch: nil, changedFileCount: 0), .notIsolated)
    }

    func testModeHiddenWhenWorktreeButNoChanges() {
        XCTAssertEqual(WorktreeBarLogic.mode(isolationStatus: "worktree", branch: "orbit/x-abcdef", changedFileCount: 0), .hidden)
    }

    func testModeShowsFailedMergeEvenWithoutChangedFiles() {
        XCTAssertEqual(
            WorktreeBarLogic.mode(isolationStatus: "worktree", branch: "orbit/x-abcdef",
                                  changedFileCount: 0, mergeStatus: "error"),
            .worktree
        )
    }

    func testModeHiddenWhenWorktreeButNoBranch() {
        XCTAssertEqual(WorktreeBarLogic.mode(isolationStatus: "worktree", branch: nil, changedFileCount: 5), .hidden)
    }

    func testModeWorktree() {
        XCTAssertEqual(WorktreeBarLogic.mode(isolationStatus: "worktree", branch: "orbit/x-abcdef", changedFileCount: 5), .worktree)
    }

    // MARK: primary action

    func testPrimaryDirtyLiveShowsCommit() {
        XCTAssertEqual(WorktreeBarLogic.primary(worktreeDirty: true, committed: false, turnActive: false), .commit)
    }

    func testPrimaryCleanLiveShowsMerge() {
        // Runner reports a clean tree (dirty known) → Merge, even mid-session (live), once the turn settled.
        XCTAssertEqual(WorktreeBarLogic.primary(worktreeDirty: false, committed: false, turnActive: false), .merge)
    }

    func testPrimaryMergeHeldDuringTurn() {
        XCTAssertEqual(WorktreeBarLogic.primary(worktreeDirty: false, committed: false, turnActive: true), .none)
    }

    func testPrimaryDirtyButEndedFallsThroughToMerge() {
        // An ended session that still reports dirty must NOT keep offering Commit (the API 409s) —
        // it falls through to Merge like any other ended session.
        XCTAssertEqual(WorktreeBarLogic.primary(worktreeDirty: true, committed: true, turnActive: false), .merge)
    }

    func testPrimaryOlderRunnerFallsBackToLifecycle() {
        // No worktreeDirty: live → nothing actionable yet; committed → Merge.
        XCTAssertEqual(WorktreeBarLogic.primary(worktreeDirty: nil, committed: false, turnActive: false), .none)
        XCTAssertEqual(WorktreeBarLogic.primary(worktreeDirty: nil, committed: true, turnActive: false), .merge)
    }

    // MARK: default merge target

    func testDefaultTargetPrefersRememberedWhenStillOffered() {
        XCTAssertEqual(WorktreeBarLogic.defaultTarget(targets: ["main", "develop"], agentDefaultTarget: "develop"), "develop")
    }

    func testDefaultTargetIgnoresRememberedWhenGone() {
        XCTAssertEqual(WorktreeBarLogic.defaultTarget(targets: ["main", "master"], agentDefaultTarget: "deleted"), "main")
    }

    func testDefaultTargetMainThenMasterThenFirst() {
        XCTAssertEqual(WorktreeBarLogic.defaultTarget(targets: ["master", "main"], agentDefaultTarget: nil), "main")
        XCTAssertEqual(WorktreeBarLogic.defaultTarget(targets: ["master", "trunk"], agentDefaultTarget: nil), "master")
        XCTAssertEqual(WorktreeBarLogic.defaultTarget(targets: ["trunk", "release"], agentDefaultTarget: nil), "trunk")
    }

    func testDefaultTargetEmptyIsNil() {
        XCTAssertNil(WorktreeBarLogic.defaultTarget(targets: [], agentDefaultTarget: "main"))
    }

    // MARK: resolvable

    /// Any conflict is resolvable, whatever the target — retrying it would replay the same rebase.
    /// An `error` is a precondition failure a rebase can't fix, so it stays a plain retry.
    func testResolvableForAnyConflictNotForError() {
        XCTAssertTrue(WorktreeBarLogic.resolvable(mergeStatus: "conflict"))
        XCTAssertFalse(WorktreeBarLogic.resolvable(mergeStatus: "error"))
        XCTAssertFalse(WorktreeBarLogic.resolvable(mergeStatus: nil))
    }

    func testConflictTargetNamesTheBranchThatConflicted() {
        // The recorded target wins, even when it isn't main/master.
        XCTAssertEqual(
            WorktreeBarLogic.conflictTarget(mergeTarget: "release/1.2", targets: ["main", "release/1.2"],
                                            agentDefaultTarget: nil),
            "release/1.2")
        // Auto-detected merge (no recorded target) → the default the runner would have picked.
        XCTAssertEqual(
            WorktreeBarLogic.conflictTarget(mergeTarget: nil, targets: ["master", "dev"],
                                            agentDefaultTarget: nil),
            "master")
        // Nothing reported (older runner) → main.
        XCTAssertEqual(
            WorktreeBarLogic.conflictTarget(mergeTarget: nil, targets: [], agentDefaultTarget: nil),
            "main")
    }

    // MARK: failure detail

    func testFailureMessageIncludesMergeError() {
        XCTAssertEqual(
            WorktreeBarLogic.failureMessage(mergeStatus: "error", mergeError: " target has uncommitted changes \n",
                                            commitStatus: nil, commitError: nil),
            "target has uncommitted changes"
        )
    }

    func testFailureMessageIncludesConflictDetail() {
        XCTAssertEqual(
            WorktreeBarLogic.failureMessage(mergeStatus: "conflict", mergeError: "CONFLICT (content): file.txt",
                                            commitStatus: nil, commitError: nil),
            "Merge conflict — aborted, working tree left clean.\nCONFLICT (content): file.txt"
        )
    }

    func testFailureMessagePrefersCommitError() {
        XCTAssertEqual(
            WorktreeBarLogic.failureMessage(mergeStatus: "error", mergeError: "merge",
                                            commitStatus: "error", commitError: "commit failed"),
            "commit failed"
        )
    }

    func testManualMergeCommandUsesTargetAndBranch() {
        XCTAssertEqual(
            WorktreeBarLogic.manualMergeCommand(mergeTarget: "develop", branch: "orbit/fix-a1b2c3"),
            "git rebase develop orbit/fix-a1b2c3 && git checkout develop && git merge --ff-only orbit/fix-a1b2c3"
        )
    }

    // MARK: diff refresh

    func testDiffRefreshNeededWhenTextFileHasNoStoredPatch() {
        let files = [SessionChangedFile(path: "src/app.swift", additions: 1, deletions: 0, status: "M")]

        XCTAssertTrue(WorktreeBarLogic.shouldRefreshDiff(isLive: true, changedFiles: files, patches: []))
        XCTAssertTrue(WorktreeBarLogic.shouldRefreshDiff(
            isLive: true,
            changedFiles: files,
            patches: [FilePatch(path: "src/app.swift", patch: "", truncated: nil)]
        ))
    }

    func testDiffRefreshNotRequestedForEndedSession() {
        let files = [SessionChangedFile(path: "src/app.swift", additions: 1, deletions: 0, status: "M")]

        XCTAssertFalse(WorktreeBarLogic.shouldRefreshDiff(isLive: false, changedFiles: files, patches: []))
    }

    func testDiffRefreshNotNeededWhenPatchIsReady() {
        let files = [SessionChangedFile(path: "src/app.swift", additions: 1, deletions: 0, status: "M")]
        let patches = [FilePatch(path: "src/app.swift", patch: "@@ -1 +1 @@\n-old\n+new", truncated: nil)]

        XCTAssertFalse(WorktreeBarLogic.shouldRefreshDiff(
            isLive: true, changedFiles: files, patches: patches))
    }

    func testDiffRefreshSkipsBinaryAndTruncatedFiles() {
        let files = [
            SessionChangedFile(path: "Assets/icon.png", additions: -1, deletions: -1, status: "M"),
            SessionChangedFile(path: "generated.txt", additions: 8_000, deletions: 0, status: "A"),
        ]
        let patches = [FilePatch(path: "generated.txt", patch: nil, truncated: true)]

        XCTAssertFalse(WorktreeBarLogic.shouldRefreshDiff(
            isLive: true, changedFiles: files, patches: patches))
    }

    func testDiffRefreshNeededWhenAnyPreviewableFileIsMissing() {
        let files = [
            SessionChangedFile(path: "ready.swift", additions: 1, deletions: 1, status: "M"),
            SessionChangedFile(path: "missing.swift", additions: 2, deletions: 0, status: "A"),
        ]
        let patches = [FilePatch(path: "ready.swift", patch: "@@ -1 +1 @@\n-a\n+b", truncated: nil)]

        XCTAssertTrue(WorktreeBarLogic.shouldRefreshDiff(
            isLive: true, changedFiles: files, patches: patches))
    }

    // MARK: branch parts

    func testBranchPartsSplitsGeneratedBranch() {
        let parts = WorktreeBarLogic.branchParts("orbit/ios-git-web-style-3d553c")
        XCTAssertEqual(parts?.prefix, "orbit/")
        XCTAssertEqual(parts?.slug, "ios-git-web-style")
        XCTAssertEqual(parts?.hash, "-3d553c")
    }

    func testBranchPartsNilForPlainName() {
        XCTAssertNil(WorktreeBarLogic.branchParts("main"))
        XCTAssertNil(WorktreeBarLogic.branchParts("feature/login"))
    }

    func testBranchPartsNilForUppercaseHashOrMissingSlug() {
        XCTAssertNil(WorktreeBarLogic.branchParts("orbit/fix-ABCDEF"))  // web regex is lowercase-only
        XCTAssertNil(WorktreeBarLogic.branchParts("orbit/-abcdef"))     // empty slug
    }

    // MARK: DTO decoding

    func testSessionDetailDecodesWorktreeFields() throws {
        let json = #"""
        {
          "id": "s1", "title": "ignored", "status": "AWAITING_INPUT",
          "runStatus": "AWAITING_INPUT", "sessionState": "AWAITING_INPUT",
          "runState": "AWAITING_INPUT", "lifecycleState": "OPEN",
          "capabilities": {"canSend": true, "canResume": false,
            "resumeBlockedReason": "NOT_TERMINAL", "canComplete": true, "canRestore": false},
          "branch": "orbit/fix-a1b2c3", "isolationStatus": "worktree",
          "worktreeDirty": false, "mergeStatus": "pending", "mergeTarget": "main",
          "mergeTargets": ["main", "develop"], "branchMerged": false,
          "changedFiles": [
            {"path": "src/a.ts", "additions": 10, "deletions": 2, "status": "M"},
            {"path": "src/img.png", "additions": -1, "deletions": -1, "status": "A"}
          ],
          "agent": {"id": "a1", "defaultMergeTarget": "develop"}
        }
        """#
        let d = try JSONDecoder().decode(SessionDetail.self, from: Data(json.utf8))
        XCTAssertEqual(d.status, .awaitingInput)
        XCTAssertEqual(d.runStatus, .awaitingInput)
        XCTAssertEqual(d.effectiveRunStatus, .awaitingInput)
        XCTAssertEqual(d.sessionState, .awaitingInput)
        XCTAssertEqual(d.runState, .awaitingInput)
        XCTAssertEqual(d.effectiveRunState, .awaitingInput)
        XCTAssertEqual(d.lifecycleState, .open)
        XCTAssertEqual(d.effectiveLifecycleState, .open)
        XCTAssertTrue(try XCTUnwrap(d.capabilities).canSend)
        XCTAssertFalse(try XCTUnwrap(d.capabilities).canResume)
        XCTAssertEqual(d.capabilities?.resumeBlockedReason, .notTerminal)
        XCTAssertEqual(d.branch, "orbit/fix-a1b2c3")
        XCTAssertEqual(d.isolationStatus, "worktree")
        XCTAssertEqual(d.worktreeDirty, false)
        XCTAssertEqual(d.mergeStatus, "pending")
        XCTAssertEqual(d.mergeTargets ?? [], ["main", "develop"])
        XCTAssertEqual(d.changedFiles?.count, 2)
        XCTAssertEqual(d.changedFiles?.first?.additions, 10)
        XCTAssertEqual(d.agent?.defaultMergeTarget, "develop")
    }

    func testSessionDetailToleratesMissingWorktreeFields() throws {
        // A slim payload (older runner / pre-isolation) decodes with everything optional as nil.
        let d = try JSONDecoder().decode(SessionDetail.self, from: Data(#"{"id":"s2"}"#.utf8))
        XCTAssertNil(d.sessionState)
        XCTAssertNil(d.runState)
        XCTAssertNil(d.effectiveRunState)
        XCTAssertNil(d.lifecycleState)
        XCTAssertNil(d.capabilities)
        XCTAssertNil(d.status)
        XCTAssertNil(d.runStatus)
        XCTAssertNil(d.effectiveRunStatus)
        XCTAssertEqual(d.id, "s2")
        XCTAssertNil(d.branch)
        XCTAssertNil(d.changedFiles)
        XCTAssertNil(d.mergeStatus)
        XCTAssertNil(d.agent)
    }

    func testSlimOldDetailUsesMixedSessionStateOnlyWhenRawStatusIsMissing() throws {
        let legacy = try JSONDecoder().decode(
            SessionDetail.self, from: Data(#"{"id":"s3","sessionState":"FAILED"}"#.utf8))
        XCTAssertEqual(legacy.effectiveRunState, .failed)

        // The raw CANCELLED must not be read as the legacy COMPLETED's success.
        let rawWins = try JSONDecoder().decode(
            SessionDetail.self,
            from: Data(#"{"id":"s4","status":"CANCELLED","sessionState":"COMPLETED"}"#.utf8))
        XCTAssertEqual(rawWins.effectiveRunState, .ended)
    }
}
