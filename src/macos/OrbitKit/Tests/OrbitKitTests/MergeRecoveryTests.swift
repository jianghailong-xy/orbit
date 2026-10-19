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
                       MergeRecoveryButtons(primary: resolve, secondary: [preparePR], headerCheck: check),
                       "no repair session yet: starting one is the step (with one, see testTheRepairSessionLeadsTheSteps)")
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

    // MARK: - the repair loop (project 34hIv3wbdtsxpc5RzDlOk, docs/mocks/merge-recovery-repair-loop-ios.html)

    private let now = ISO8601DateFormatter().date(from: "2026-10-11T11:20:30Z")!
    private let utc = TimeZone(identifier: "UTC")!
    private let roundEnded = "2026-10-11T11:20:00.500Z"

    private func repairSession(_ status: String, lastTurnAt: String? = "2026-10-11T11:20:00.500Z",
                               said: String? = nil, error: String? = nil) -> [String: Any] {
        var value: [String: Any] = ["id": "repair", "title": "Resolve merge recovery for develop", "status": status]
        if let lastTurnAt { value["lastTurnAt"] = lastTurnAt }
        if let said { value["lastAssistantText"] = said }
        if let error { value["error"] = error }
        return value
    }

    /// The parent's detail: its recovery, checked at 11:20:00 unless `changes` says otherwise, the repair
    /// session on it, and whatever else the detail carries (`extra`).
    private func detail(_ changes: [String: Any] = [:], repair: [String: Any]?,
                        _ extra: [String: Any] = [:]) throws -> SessionDetail {
        var value: [String: Any] = ["id": "parent", "mergeRecoverySupported": true,
                                    "mergeRecovery": payload(["checkedAt": "2026-10-11T11:20:00Z"].merging(changes) { _, new in new })]
        if let repair { value["mergeRepairSession"] = repair }
        value.merge(extra) { _, new in new }
        return try JSONDecoder().decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: value))
    }

    private func row(_ changes: [String: Any] = [:], repair: [String: Any],
                     _ extra: [String: Any] = [:]) throws -> MergeRepairRow {
        try XCTUnwrap(MergeRepairRow(detail: detail(changes, repair: repair, extra)))
    }

    /// What R1 and S1 added decodes, and a payload from before them still does, with nothing in its place.
    func testTheRepairLoopsFieldsDecodeAndOlderPayloadsStillDo() throws {
        let landed = try decode(["code": "ALREADY_LANDED", "targetBranch": "main", "landedCommits": [
            ["sha": String(repeating: "9", count: 40), "subject": "Update AgentsModel.swift", "author": "coordinator",
             "date": "2026-10-11T09:36:40+08:00", "sourceSha": String(repeating: "e", count: 40)],
        ]])
        XCTAssertEqual(landed.landedCommits?.first?.sourceSha, String(repeating: "e", count: 40))
        XCTAssertNil(try decode(payload()).localCommits?.first?.sourceSha, "only a landed commit names one")
        XCTAssertNil(try decode(payload()).landedCommits)

        let d = try detail(repair: repairSession("AWAITING_INPUT", said: "Keep the target's version?")
                               .merging(["finishedAt": "2026-10-11T11:20:01Z"]) { _, new in new },
                           ["mergeStatus": "pending", "mergeRecoveryAction": "preview", "mergeRepairTurnEndedAt": roundEnded])
        XCTAssertEqual(d.mergeRecoveryAction, "preview")
        XCTAssertEqual(d.mergeRepairTurnEndedAt, roundEnded)
        XCTAssertEqual(d.mergeRepairSession?.lastTurnAt, roundEnded)
        XCTAssertEqual(d.mergeRepairSession?.finishedAt, "2026-10-11T11:20:01Z")
        XCTAssertEqual(d.mergeRepairSession?.lastAssistantText, "Keep the target's version?")

        let old = try detail(repair: ["id": "repair", "status": "AWAITING_INPUT"])
        XCTAssertNil(old.mergeRecoveryAction)
        XCTAssertNil(old.mergeRepairTurnEndedAt)
        XCTAssertNil(old.mergeRepairSession?.lastTurnAt)
        XCTAssertNil(old.mergeRepairSession?.lastAssistantText)
    }

    /// The design board's six states of the repair row, each in its words.
    func testTheRepairRowsSixStates() throws {
        func words(_ row: MergeRepairRow) -> [String?] { [row.headline, row.status(now: now)] }

        XCTAssertEqual(words(try row(["code": "CONFLICT"], repair: repairSession("RUNNING"))),
                       ["Repair session running", "Tap to open the running session"])
        XCTAssertEqual(try row(repair: repairSession("PENDING")).state, .running, "queued counts as at work")

        let checking = try row(["code": "CONFLICT"], repair: repairSession("AWAITING_INPUT"),
                               ["mergeStatus": "pending", "mergeRecoveryAction": "preview"])
        XCTAssertEqual(checking.state, .checking)
        XCTAssertEqual(words(checking), ["Repair session finished", "Checking its result…"])

        XCTAssertEqual(words(try row(repair: repairSession("AWAITING_INPUT"))),
                       ["Repair session finished", "Checked just now — ready to merge"])
        XCTAssertEqual(words(try row(["code": "CONFLICT"], repair: repairSession("AWAITING_INPUT"))),
                       ["Repair session finished", "Checked just now — 1 conflict left"])
        XCTAssertEqual(try row(["code": "CONFLICT", "conflicts": ["a", "b"]], repair: repairSession("CANCELLED")).status(now: now),
                       "Checked just now — 2 conflicts left")

        let reply = try row(["code": "REPAIR_IN_PROGRESS"],
                            repair: repairSession("AWAITING_INPUT", lastTurnAt: "2026-10-11T11:18:00Z",
                                                  said: "Keep the target's\n  version?"))
        XCTAssertEqual(words(reply), ["Repair session needs your reply", "“Keep the target's version?” · 2m ago"],
                       "AWAITING_INPUT is no longer \"completed\": it stopped with the repair unfinished")

        let failed = try row(["code": "CONFLICT"], repair: repairSession("FAILED", error: "The model provider rejected the request"),
                             ["mergeStatus": "pending", "mergeRecoveryAction": "preview"])
        XCTAssertEqual(words(failed), ["Repair session failed", "The model provider rejected the request"])
        XCTAssertTrue(failed.checking, "a failed round is checked too; the row keeps saying why it failed")
    }

    /// Checking is a preview in flight, or a check owed until this session's own turn ends — nothing else.
    func testCheckingIsAPreviewInFlightOrOneOwed() throws {
        let repair = repairSession("AWAITING_INPUT")
        XCTAssertTrue(try row(repair: repair, ["mergeStatus": "pending", "mergeRecoveryAction": "preview"]).checking)
        XCTAssertTrue(try row(repair: repair, ["mergeRepairTurnEndedAt": roundEnded]).checking)
        XCTAssertFalse(try row(repair: repair, ["mergeStatus": "pending", "mergeRecoveryAction": "apply"]).checking,
                       "a push under way is not a check")
        XCTAssertFalse(try row(repair: repair, ["mergeStatus": "pending"]).checking, "an older server names no action")
        XCTAssertFalse(try row(repair: repair).checking)
    }

    /// The row when no check has seen the repair's last round, or the check's answer is the title's to give.
    func testTheRowWithoutAVerdictOnTheLastRound() throws {
        let legacy = try row(repair: ["id": "repair", "status": "AWAITING_INPUT"])
        XCTAssertEqual(legacy.state, .unchecked, "a server that predates lastTurnAt can't say which round was checked")
        XCTAssertEqual([legacy.headline, legacy.status(now: now)], ["Repair session finished", nil],
                       "no verdict to give: the header's Check again is the way to one")
        XCTAssertEqual(try row(["checkedAt": "2026-10-11T11:20:30Z"],
                               repair: ["id": "repair", "status": "SUCCEEDED", "finishedAt": "2026-10-11T11:20:10Z"]).state,
                       .ready(checkedAt: "2026-10-11T11:20:30Z"), "a finished session's round ends when it finished")
        XCTAssertEqual(try row(["checkedAt": "2026-10-11T11:19:59Z"], repair: repairSession("AWAITING_INPUT")).state,
                       .unchecked, "checked before the round ended")
        XCTAssertEqual(try row(["checkedAt": "2026-10-11T11:20:00Z"], repair: repairSession("AWAITING_INPUT")).state,
                       .ready(checkedAt: "2026-10-11T11:20:00Z"), "the runner stamps whole seconds: the same second counts")
        let diverged = try row(["code": "TARGET_DIVERGED"], repair: repairSession("AWAITING_INPUT"))
        XCTAssertEqual(diverged.state, .finished(checkedAt: "2026-10-11T11:20:00Z"))
        XCTAssertEqual(diverged.status(now: now), "Checked just now", "the title says what the check found")
        XCTAssertNil(MergeRepairRow(detail: try detail(repair: nil)), "no repair session, no row")
        XCTAssertNil(MergeRepairRow(detail: try detail(["code": "ALREADY_LANDED"], repair: repairSession("RUNNING"))),
                     "already on origin: nothing is left to repair, so no row")
    }

    /// The detail is read on while the server checks the repair, and for a minute after a round no check
    /// has seen yet ended: a read can fall between the round's end and the check it queues.
    func testTheDetailIsReadUntilTheRepairsCheckShows() throws {
        let stopped = repairSession("AWAITING_INPUT")
        XCTAssertTrue(MergeRepairRow.awaitsCheck(try detail(repair: stopped, ["mergeStatus": "pending", "mergeRecoveryAction": "preview"]),
                                                 now: now))
        XCTAssertTrue(MergeRepairRow.awaitsCheck(try detail(repair: stopped, ["mergeRepairTurnEndedAt": roundEnded]), now: now))
        let unchecked = try detail(["checkedAt": "2026-10-11T11:19:59Z"], repair: stopped)
        XCTAssertTrue(MergeRepairRow.awaitsCheck(unchecked, now: now))
        XCTAssertFalse(MergeRepairRow.awaitsCheck(unchecked, now: now.addingTimeInterval(60)), "not forever: a minute")
        XCTAssertFalse(MergeRepairRow.awaitsCheck(try detail(repair: stopped), now: now), "checked since: the answer is here")
        XCTAssertFalse(MergeRepairRow.awaitsCheck(try detail(repair: ["id": "repair", "status": "AWAITING_INPUT"]), now: now),
                       "an older server checks nothing by itself")
    }

    /// With a repair session on the recovery it leads the steps: open it while it works, wait while the
    /// server checks it, then go on in it — unless it failed, which a new session replaces.
    func testTheRepairSessionLeadsTheSteps() throws {
        let check = MergeRecoveryButton(title: "Check again", action: .preview)
        let preparePR = MergeRecoveryButton(title: "Prepare PR candidate", action: .repair(preparePR: true))
        func buttons(_ changes: [String: Any] = [:], repair: [String: Any],
                     _ extra: [String: Any] = [:]) throws -> MergeRecoveryButtons {
            let d = try detail(changes, repair: repair, extra)
            return try XCTUnwrap(d.mergeRecovery).buttons(supported: true, repair: MergeRepairRow(detail: d))
        }

        XCTAssertEqual(try buttons(["code": "CONFLICT"], repair: repairSession("RUNNING")), MergeRecoveryButtons(
            primary: MergeRecoveryButton(title: "Open repair session", action: .openRepair),
            secondary: [], headerCheck: nil, note: "Orbit checks again when the repair stops."),
                       "no Check again while it works: it would only find the repair unfinished")
        XCTAssertEqual(try buttons(["code": "CONFLICT"], repair: repairSession("AWAITING_INPUT"),
                                   ["mergeStatus": "pending", "mergeRecoveryAction": "preview"]),
                       MergeRecoveryButtons(primary: MergeRecoveryButton(title: "Checking…", action: .preview, waiting: true),
                                            secondary: [], headerCheck: nil))
        // The coordinator's ruling (as web's panel): a failed repair session keeps its row while a check is in
        // flight or owed, and the disabled Checking… is still the only step.
        for inFlight: [String: Any] in [["mergeStatus": "pending", "mergeRecoveryAction": "preview"],
                                         ["mergeRepairTurnEndedAt": roundEnded]] {
            let failed = try detail(["code": "CONFLICT"], repair: repairSession("FAILED", error: "rejected"), inFlight)
            let row = try XCTUnwrap(MergeRepairRow(detail: failed))
            XCTAssertEqual(row.state, .failed("rejected"))
            XCTAssertTrue(row.checking)
            XCTAssertEqual(try XCTUnwrap(failed.mergeRecovery).buttons(supported: true, repair: row),
                           MergeRecoveryButtons(primary: MergeRecoveryButton(title: "Checking…", action: .preview, waiting: true),
                                                secondary: [], headerCheck: nil), "\(inFlight)")
        }
        XCTAssertEqual(try buttons(repair: repairSession("AWAITING_INPUT")), MergeRecoveryButtons(
            primary: MergeRecoveryButton(title: "Sync develop and merge", action: .apply), secondary: [preparePR], headerCheck: check))
        for resumable in ["AWAITING_INPUT", "SUCCEEDED", "CANCELLED", "INTERRUPTED"] {
            XCTAssertEqual(try buttons(["code": "CONFLICT"], repair: repairSession(resumable)), MergeRecoveryButtons(
                primary: MergeRecoveryButton(title: "Continue repair", action: .repair(preparePR: false)),
                secondary: [preparePR], headerCheck: check), "\(resumable): the same repair session goes on")
        }
        XCTAssertEqual(try buttons(["code": "CONFLICT"], repair: repairSession("FAILED")), MergeRecoveryButtons(
            primary: MergeRecoveryButton(title: "Resolve in repair session", action: .repair(preparePR: false)),
            secondary: [preparePR], headerCheck: check),
                       "a failed repair session is replaced by a new one, never continued (S2)")
        XCTAssertEqual(try buttons(["code": "REPAIR_IN_PROGRESS"], repair: repairSession("AWAITING_INPUT", said: "Keep the target's version?")),
                       MergeRecoveryButtons(primary: MergeRecoveryButton(title: "Reply in repair session", action: .repair(preparePR: false)),
                                            secondary: [], headerCheck: check))
        XCTAssertEqual(try buttons(["code": "REPAIR_IN_PROGRESS"], repair: repairSession("FAILED", error: "rejected")),
                       MergeRecoveryButtons(primary: MergeRecoveryButton(title: "Resolve in repair session", action: .repair(preparePR: false)),
                                            secondary: [], headerCheck: check),
                       "a failed repair session can't be replied to: a new one resolves it, and still no PR candidate")
        XCTAssertEqual(try decode(payload(["code": "REPAIR_IN_PROGRESS"])).buttons(supported: true).primary, check,
                       "no repair session to reply in: the existing rule")
        XCTAssertEqual(try buttons(["code": "ALREADY_LANDED"], repair: repairSession("AWAITING_INPUT")).primary,
                       MergeRecoveryButton(title: "Done", action: .confirmLanded))
        XCTAssertEqual(try buttons(["code": "ALREADY_LANDED"], repair: repairSession("RUNNING")).primary,
                       MergeRecoveryButton(title: "Done", action: .confirmLanded),
                       "once everything is on origin nothing is left to repair, even while the repair session runs")
        XCTAssertEqual(try buttons(["code": "LOCAL_SYNC_PENDING"], repair: repairSession("RUNNING")).primary,
                       MergeRecoveryButton(title: "Sync local checkout", action: .syncLocal), "a landing being finished keeps its step")
    }

    func testAnUnfinishedRepairAndALandedSessionHaveTheirOwnTitles() throws {
        let unfinished = try decode(payload(["code": "REPAIR_IN_PROGRESS", "conflicts": ["src/a.swift"]]))
        XCTAssertEqual(unfinished.title, "The repair isn’t finished", "not the generic \"develop needs synchronization\"")
        XCTAssertEqual(unfinished.conflictsTitle, "Still unresolved")
        XCTAssertEqual(try decode(payload(["code": "CONFLICT"])).conflictsTitle, "Conflicts")
        XCTAssertEqual(try decode(["code": "ALREADY_LANDED", "targetBranch": "main"]).title, "Already on origin/main")
    }

    /// The board's ④ footnote, by the coordinator's rule: a CONFLICT in TARGET_SYNC on a repair branch an
    /// earlier check named (a carried repair). A carried repair can meet a fresh SOURCE_REPLAY conflict with
    /// nothing moved, and a fresh branch has no repair behind it — neither says the target moved.
    func testTheTargetMovedNoteNeedsACarriedRepairAndATargetSyncConflict() throws {
        let carried: [String: Any] = ["code": "CONFLICT", "phase": "TARGET_SYNC", "previewId": "second",
                                      "repairBranch": "orbit/recovery/first", "conflicts": ["src/AgentsModel.swift"]]
        XCTAssertEqual(try decode(payload(carried)).targetMovedNote,
                       "origin/develop moved after the repair. The repair was kept; only this file conflicts with the new commits.")
        XCTAssertNil(try decode(payload(carried.merging(["phase": "SOURCE_REPLAY"]) { _, new in new })).targetMovedNote)
        XCTAssertNil(try decode(payload(carried.merging(["repairBranch": "orbit/recovery/second"]) { _, new in new })).targetMovedNote)
        XCTAssertEqual(try decode(payload(carried.merging(["conflicts": ["a", "b"]]) { _, new in new })).targetMovedNote,
                       "origin/develop moved after the repair. The repair was kept; only these files conflict with the new commits.")
    }

    /// The board's ⑥ with its real data: both of the session's commits reached origin/main on Oct 11 as
    /// copies (the branch was rewritten after), and local main has two commits of its own.
    func testAnAlreadyLandedSessionSaysWhatOriginHasAndEndsWithDone() throws {
        func sha(_ c: String) -> String { String(repeating: c, count: 40) }
        let later = ISO8601DateFormatter().date(from: "2026-10-19T03:00:30Z")!
        var value: [String: Any] = [
            "code": "ALREADY_LANDED", "targetBranch": "main", "previewId": "stored", "sourceSha": sha("0"),
            "localSha": sha("b"), "remoteSha": sha("c"), "checkedAt": "2026-10-19T03:00:00Z",
            "localCommits": [commit("8", "feat(suggestions)"), commit("7", "feat(composer)")],
            "remoteCommits": [commit("5", "Remote work")],
            "landedCommits": [
                ["sha": sha("e"), "subject": "Explicit self in the session-list currency closure", "author": "coordinator",
                 "date": "2026-10-11T18:34:12+08:00", "sourceSha": sha("1")],
                ["sha": sha("9"), "subject": "Update AgentsModel.swift, SessionListSwitchWiringTests.swift",
                 "author": "coordinator", "date": "2026-10-11T17:36:40+08:00", "sourceSha": sha("2")],
            ],
        ]
        let r = try decode(value)
        XCTAssertTrue(r.confirmable)
        XCTAssertEqual(r.buttons(supported: true), MergeRecoveryButtons(
            primary: MergeRecoveryButton(title: "Done", action: .confirmLanded), secondary: [], headerCheck: nil))
        XCTAssertEqual(r.landedSummary(now: later, timeZone: utc),
                       "This session’s changes reached origin/main on Oct 11. Nothing is left to merge.")
        XCTAssertEqual(r.landedCommits?.map { MergeRecovery.mergedDay($0, now: later, timeZone: utc) },
                       ["Merged Oct 11", "Merged Oct 11"])
        XCTAssertEqual(r.landedByContentNote, "Matched by content — this branch was rewritten after these merged.")
        XCTAssertEqual(r.landedLocalNote, "Local main’s own 2 commits aren’t part of this session.")
        XCTAssertEqual(r.targetRelation, "Local main: 2 ahead, 1 behind origin/main")

        value["landedCommits"] = [["sha": sha("1"), "subject": "Its own commit", "author": "coordinator",
                                   "date": "2025-10-11T10:00:00Z", "sourceSha": sha("1")]]
        value["localCommits"] = [commit("8", "One of its own")]
        let same = try decode(value)
        XCTAssertNil(same.landedByContentNote, "the session's own commit is no copy")
        XCTAssertEqual(same.landedSummary(now: later, timeZone: utc),
                       "This session’s changes reached origin/main on Oct 11, 2025. Nothing is left to merge.")
        XCTAssertEqual(same.landedLocalNote, "Local main’s own 1 commit isn’t part of this session.")

        value["landedCommits"] = [["sha": sha("2"), "subject": "A copy", "author": "coordinator",
                                   "date": "2026-10-11T10:00:00Z", "sourceSha": sha("1")]]
        XCTAssertEqual(try decode(value).landedByContentNote,
                       "Matched by content — this branch was rewritten after it merged.")

        value["landedCommits"] = nil
        value["localCommits"] = nil
        let bare = try decode(value)
        XCTAssertEqual(bare.landedSummary(now: later, timeZone: utc), "Nothing is left to merge.")
        XCTAssertNil(bare.landedLocalNote)

        value["previewId"] = nil
        XCTAssertFalse(try decode(value).confirmable, "Done is fenced on the stored check's previewId")
        XCTAssertFalse(try decode(payload(["code": "ALREADY_LANDED", "sourceSha": "short"])).confirmable)
    }
}
