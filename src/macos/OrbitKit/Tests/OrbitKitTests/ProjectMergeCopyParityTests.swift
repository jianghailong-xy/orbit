import Foundation
import XCTest
@testable import OrbitKit

/// The merge into main on the project's sessions page and as the coordinator conversation's line
/// (owner decision 2026-10-06) is worded by `PromotionCards` here and by `lib/projectMerge.ts` on the
/// web. A missing web counterpart fails: both clients say one thing about one merge.
final class ProjectMergeCopyParityTests: XCTestCase {
    private static let webSource = "src/web/src/lib/projectMerge.ts"

    private func web() throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(Self.webSource)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
                    .replacingOccurrences(of: "=\\s*\\n\\s*'", with: "= '", options: .regularExpression)
            }
            dir.deleteLastPathComponent()
        }
        XCTFail("\(Self.webSource) was not found above this test file; if the web half moved, move this check with it")
        return ""
    }

    func testTheConstantsAreTheWebsOwn() throws {
        let web = try web()
        let constants: [(String, String)] = [
            ("NO_LONGER_ON_OFFER", PromotionCards.supersededTitle),
            ("REVIEW", PromotionCards.review),
            ("NEEDS_YOU", PromotionCards.needsYouBadge),
            ("DETAILS", PromotionCards.details),
            ("PAGE_NOTHING_TO_DO", PromotionCards.pageNothingToDo),
        ]
        for (name, copy) in constants {
            XCTAssertTrue(web.contains("export const \(name) = '\(copy)';"),
                          "\(name): the web's words drifted from \(copy.debugDescription)")
        }
        // Who is in front of a blocked merge, in the same words on both ends.
        XCTAssertTrue(web.contains("export const BLOCKED_BY = '\(PromotionCards.blockedByLabel)';"),
                      "BLOCKED_BY drifted from \(PromotionCards.blockedByLabel.debugDescription)")
        XCTAssertTrue(web.contains("`“${holding.taskTitle}” is landing on the project line`"),
                      "the sentence that names the landing holding the branch drifted")
        XCTAssertTrue(web.contains("export const MERGE_JOB_KINDS: readonly string[] = ['CHECK_PROMOTION', 'LAND_PROMOTION'];"))
        XCTAssertEqual(ProjectMergeCard.mergeJobKinds, ["CHECK_PROMOTION", "LAND_PROMOTION"])
    }

    /// The sentences built around a branch or a count, as both write them for `main`.
    func testTheSentencesAreTheWebsOwn() throws {
        let web = try web()
        let into = "${into}"
        let sentences = [
            "`Merge into \(into)?`",
            "`Merge into \(into) queued`",
            "`Merge into \(into) confirmed`",
            "`Re-checking before merging into \(into)…`",
            "`Merging into \(into)…`",
            "`Can’t merge into \(into) yet`",
            "is waiting for you`",
            "`+${more} more`",
            "'checks failed'",
            "'by you'",
            "'automatically'",
            // The branch it goes into is the project's main branch, named the one way the project page
            // names it.
            "`✓ Merged into ${mainBranchName(promotion.upstreamRef)}`",
            "`Merged into ${mainBranchName(promotion.upstreamRef)}`",
            "'the checks on the combined tree did not pass'",
            // Why a blocked merge is blocked, when the job said so (0409).
            "`nothing to merge — ${shortRef(promotion.sourceRef)} is already on ${mainBranchName(promotion.upstreamRef)}`",
            "'the merge stopped on an error — no check failed'",
            "'nothing to merge'",
            "'check errored'",
            "'No checks recorded'",
            "'Checks timed out'",
            "'✓ Checks passed'",
            "'✕ Checks failed'",
            "'no conflicts'",
        ]
        for sentence in sentences {
            XCTAssertTrue(web.contains(sentence), "the web no longer writes \(sentence)")
        }
        // And this side writes the same words, for `main`.
        let asking = ProjectPromotionView(promotionId: "p", state: .ready, sourceRef: "b", sourceSha: "s",
                                          upstreamRef: "refs/heads/main")
        XCTAssertEqual(PromotionCards.pageTitle(asking), "Merge into main?")
        XCTAssertEqual(PromotionCards.eventLine(asking).text, "Merge into main is waiting for you")
        XCTAssertEqual(PromotionCards.previewChecks(asking), "No checks recorded")
        XCTAssertEqual(PromotionCards.upstreamLine(asking), "no conflicts")
        let landed = ProjectPromotionView(promotionId: "p", state: .blocked, sourceRef: "refs/heads/b", sourceSha: "",
                                          upstreamRef: "refs/heads/main", blockedReason: "ALREADY_LANDED")
        XCTAssertEqual(PromotionCards.blockedLine(landed), "nothing to merge — b is already on main")
        XCTAssertEqual(PromotionCards.blockedReason(landed), "nothing to merge")
        let errored = ProjectPromotionView(promotionId: "p", state: .blocked, sourceRef: "b", sourceSha: "",
                                           upstreamRef: "refs/heads/main", blockedReason: "ERROR")
        XCTAssertEqual(PromotionCards.blockedLine(errored), "the merge stopped on an error — no check failed")
        XCTAssertEqual(PromotionCards.blockedReason(errored), "check errored")
    }
}
