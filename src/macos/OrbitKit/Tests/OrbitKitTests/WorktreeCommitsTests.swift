import Foundation
import XCTest
@testable import OrbitKit

/// The worktree bar counted in commits on Apple (board docs/mocks/session-commits-first/02-native):
/// the session detail reads the branch's commits, the logic decides what the bar and the sheet say,
/// and the SwiftUI views — which no job here compiles, SwiftUI not existing on Linux — are checked
/// over their source, each assertion written so that detaching the wire is what turns it red.
final class WorktreeCommitsTests: XCTestCase {

    private func commit(_ sha: String, _ paths: [String], savedBy: String? = nil) -> BranchCommit {
        BranchCommit(sha: sha, subject: "s-\(sha)", committedAt: "2026-11-22T10:00:00Z", savedBy: savedBy,
                     files: paths.map { BranchCommitFile(path: $0, additions: 3, deletions: 1) })
    }

    // MARK: decoding

    func testTheDetailReadsTheBranchCommitsAndKeepsNullApart() throws {
        let json = """
        {"id":"s1","status":"COMPLETED","branch":"orbit/x-1","baseSha":"e9f1c07aaaaaaa",
         "branchCommits":[{"sha":"a41c9e2bbbbbbbbb","subject":"feat: paginate","body":"Why.",
           "committedAt":"2026-11-22T10:00:00Z","savedBy":"session-end",
           "files":[{"path":"a.ts","additions":3,"deletions":1},{"path":"b.png","additions":-1,"deletions":-1}]}]}
        """
        let d = try JSONDecoder().decode(SessionDetail.self, from: Data(json.utf8))
        XCTAssertEqual(d.baseSha, "e9f1c07aaaaaaa")
        XCTAssertEqual(d.branchCommits?.count, 1)
        XCTAssertEqual(d.branchCommits?.first?.savedBy, "session-end")
        XCTAssertEqual(d.branchCommits?.first?.files.last?.additions, -1)
        XCTAssertEqual(d.branchCommits?.first?.changedFiles.map(\.path), ["a.ts", "b.png"])

        let old = try JSONDecoder().decode(SessionDetail.self, from: Data(#"{"id":"s2","status":"COMPLETED"}"#.utf8))
        XCTAssertNil(old.branchCommits, "a runner too old to report commits is nil, not an empty branch")
        let none = try JSONDecoder().decode(SessionDetail.self,
                                            from: Data(#"{"id":"s3","status":"COMPLETED","branchCommits":[]}"#.utf8))
        XCTAssertEqual(none.branchCommits, [])
    }

    // MARK: logic

    func testTheCountReadsAsTheWebDoes() {
        XCTAssertEqual(WorktreeBarLogic.commitCountLabel(1), "1 commit")
        XCTAssertEqual(WorktreeBarLogic.commitCountLabel(3), "3 commits")
        XCTAssertEqual(WorktreeBarLogic.commitCountLabel(100), "100+ commits")
    }

    func testTheRunnersOwnCommitsAreLabelled() {
        XCTAssertNil(WorktreeBarLogic.savedByLabel(nil))
        XCTAssertEqual(WorktreeBarLogic.savedByLabel("session-end"), "Auto-saved by Orbit")
        XCTAssertEqual(WorktreeBarLogic.savedByLabel("checkpoint"), "Auto-saved by Orbit")
        XCTAssertEqual(WorktreeBarLogic.savedByLabel("commit-button"), "Saved with Commit")
    }

    func testTheSheetOpensOnCommitsOnlyWhenThereAreSome() {
        XCTAssertEqual(WorktreeBarLogic.openingTab(commits: [commit("a", ["x"])]), .commits)
        XCTAssertNil(WorktreeBarLogic.openingTab(commits: []), "no commit yet: today's list, no tabs")
        XCTAssertNil(WorktreeBarLogic.openingTab(commits: nil), "an old runner: today's list, no tabs")
    }

    func testACommitSaysWhenItsDiffsShowMoreThanItself() {
        let newer = commit("b", ["shared.ts"])
        let older = commit("a", ["shared.ts", "only.ts"])
        let alone = commit("c", ["alone.ts"])
        let all = [newer, older, alone]
        XCTAssertTrue(WorktreeBarLogic.commitDiffsShowMore(older, among: all, worktreeDirty: false))
        XCTAssertFalse(WorktreeBarLogic.commitDiffsShowMore(alone, among: all, worktreeDirty: false))
        XCTAssertTrue(WorktreeBarLogic.commitDiffsShowMore(alone, among: all, worktreeDirty: true),
                      "uncommitted work may change any file")
    }

    func testStatAndBase() {
        let c = BranchCommit(sha: "a41c9e2bbbb", subject: "s", committedAt: "",
                             files: [BranchCommitFile(path: "a", additions: 5, deletions: 2),
                                     BranchCommitFile(path: "b.png", additions: -1, deletions: -1)])
        XCTAssertEqual(WorktreeBarLogic.commitStat(c).add, 5)
        XCTAssertEqual(WorktreeBarLogic.commitStat(c).del, 2)
        XCTAssertEqual(WorktreeBarLogic.shortSha(c.sha), "a41c9e2")
        XCTAssertEqual(WorktreeBarLogic.basedOn(mergeTarget: "develop", baseSha: "e9f1c07aaaa"), "develop @ e9f1c07")
        XCTAssertEqual(WorktreeBarLogic.basedOn(mergeTarget: nil, baseSha: "e9f1c07aaaa"), "main @ e9f1c07")
        XCTAssertNil(WorktreeBarLogic.basedOn(mergeTarget: "main", baseSha: nil))
    }

    // MARK: wiring (source)

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        XCTFail("\(relative) not found")
        return ""
    }

    func testTheBarAndTheSheetAreWiredToTheCommits() throws {
        let bar = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/WorktreeBar.swift")
        XCTAssertTrue(bar.contains("commits: d.branchCommits"), "the bar must be handed the branch's commits")
        XCTAssertTrue(bar.contains("WorktreeBarLogic.commitCountLabel(commits.count)"), "the bar must count commits")
        XCTAssertTrue(bar.contains("WorktreeBarLogic.openingTab(commits: detail?.branchCommits)"),
                      "the sheet's opening tab must come from the commits")
        XCTAssertTrue(bar.contains("CommitDetailView(console: console, commit: commit"), "a commit row must open its screen")
        XCTAssertTrue(bar.contains("WorktreeBarLogic.commitDiffsShowMoreNote"), "the commit screen must say when diffs show more")
        let checkout = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/MainCheckoutViews.swift")
        XCTAssertTrue(checkout.contains("DiffSheet(console: console, startOnAllChanges: true)"),
                      "an open that names no commit must start on All changes")
    }
}
