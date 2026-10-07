import Foundation
import XCTest
@testable import OrbitKit

/// The merge into main on the project's sessions page and as the coordinator conversation's line
/// (owner decision 2026-10-06) is worded by `PromotionCards` here and by `lib/projectMerge.ts` on the
/// web. A missing web counterpart fails: both clients say one thing about one merge.
final class ProjectMergeCopyParityTests: XCTestCase {
    private static let webSource = "src/web/src/lib/projectMerge.ts"

    private func web(_ source: String = "src/web/src/lib/projectMerge.ts") throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(source)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
                    .replacingOccurrences(of: "=\\s*\\n\\s*'", with: "= '", options: .regularExpression)
            }
            dir.deleteLastPathComponent()
        }
        XCTFail("\(source) was not found above this test file; if the web half moved, move this check with it")
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
        XCTAssertTrue(web.contains("export const MERGE_JOB_KINDS: readonly string[] = ['CHECK_PROMOTION', 'LAND_PROMOTION'];"))
        XCTAssertEqual(ProjectMergeCard.mergeJobKinds, ["CHECK_PROMOTION", "LAND_PROMOTION"])
    }

    /// The sentences built around a branch or a count, as both write them for `main`.
    func testTheSentencesAreTheWebsOwn() throws {
        let source = try web()
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
            "`✓ Merged into ${shortRef(promotion.upstreamRef)}`",
            "`Merged into ${shortRef(promotion.upstreamRef)}`",
            "'the checks on the combined tree did not pass'",
            "'No checks recorded'",
            "'Checks timed out'",
            "'✓ Checks passed'",
            "'✕ Checks failed'",
            "'no conflicts'",
        ]
        for sentence in sentences {
            XCTAssertTrue(source.contains(sentence), "the web no longer writes \(sentence)")
        }
        // And this side writes the same words, for `main`.
        let asking = ProjectPromotionView(promotionId: "p", state: .ready, sourceRef: "b", sourceSha: "s",
                                          upstreamRef: "refs/heads/main")
        XCTAssertEqual(PromotionCards.pageTitle(asking), "Merge into main?")
        XCTAssertEqual(PromotionCards.eventLine(asking).text, "Merge into main is waiting for you")
        XCTAssertEqual(PromotionCards.previewChecks(asking), "No checks recorded")
        XCTAssertEqual(PromotionCards.upstreamLine(asking), "no conflicts")
    }

    /// The queue a waiting merge is in (§2.2 J1): where it stands, who is ahead, and what each row
    /// of the line is doing — and that a head which has gone quiet is not called "running".
    func testTheQueueIsWordedTheSameOnBothSides() throws {
        let source = try web()
        let sentences = [
            "`Queue for ${shortRef(upstreamRef)}`",
            "`${queue.running} running · ${queue.waiting} waiting`",
            "`${ordinal(index + 1)} of ${queue.jobs.length} for ${shortRef(queue.targetRef)}`",
            "`“${job.title}”`",
            "`Your ${word}`",
            "`Another account’s ${word}`",
            "`${word} · queued`",
            "'running'",
            "'—'",
            "`no report for ${queueJobSpan(job, now)} — it may be stuck`",
            "`the landing of “${head.title}”`",
            "'a landing'",
            "'a merge to main'",
            "'another account’s landing'",
            "'another account’s merge to main'",
            "`Waiting to merge: ${what} is running on ${into} first`",
            "`Waiting to merge: ${what} has ${stale}`",
            "['th', 'st', 'nd', 'rd']",
        ]
        for sentence in sentences {
            XCTAssertTrue(source.contains(sentence), "the web no longer writes \(sentence)")
        }
        // The kind words and the phases the rows speak come from the page's own maps on both sides:
        // this test holds the two files to naming the same two maps…
        XCTAssertTrue(source.contains("JOB_WORDS") && source.contains("JOB_PHASES"),
                      "the web queue rows stopped reading the shared job words")
        let header = try web("src/web/src/components/ProjectPanoramaHeader.tsx")
        for literal in ["LAND_TASK: 'Landing'", "LAND_PROMOTION: 'Merge to main'",
                        "CHECK_PROMOTION: 'Merge check'", "FETCH: 'fetching'", "CHECK: 'checking'",
                        "PUSH: 'pushing'"] {
            XCTAssertTrue(header.contains(literal), "the web no longer writes \(literal)")
        }
        // …and this side spells them the same, for a promotion and a landing.
        XCTAssertEqual(ProjectPage.integrationJobWords["LAND_PROMOTION"], "Merge to main")
        XCTAssertEqual(ProjectPage.integrationJobWords["LAND_TASK"], "Landing")
        XCTAssertEqual(ProjectPage.integrationPhaseWords["FETCH"], "fetching")
        let queue = ProjectIntegrationQueue(targetRef: "refs/heads/main", running: 1, waiting: 1, jobs: [
            ProjectIntegrationQueueJob(jobId: "j1", kind: "LAND_PROMOTION", state: "RUNNING",
                                       phase: "FETCH", mine: true,
                                       enqueuedAt: "2026-10-06T23:05:25.864Z",
                                       startedAt: "2026-10-06T23:38:34.408Z"),
            ProjectIntegrationQueueJob(jobId: "j2", kind: "LAND_PROMOTION", state: "QUEUED",
                                       mine: true, projectId: "p", enqueuedAt: "2026-10-07T00:31:02.431Z"),
        ])
        XCTAssertEqual(PromotionQueueCards.title("refs/heads/main"), "Queue for main")
        XCTAssertEqual(PromotionQueueCards.summary(queue), "1 running · 1 waiting")
        XCTAssertEqual(PromotionQueueCards.position("j2", in: queue), "2nd of 2 for main")
        XCTAssertEqual(PromotionQueueCards.jobStatus(queue.jobs[0]), "Merge to main · fetching")
        XCTAssertEqual(PromotionQueueCards.jobStatus(queue.jobs[1]), "Merge to main · queued")
        XCTAssertEqual(PromotionQueueCards.jobTitle(queue.jobs[1]), "Your merge to main")
        XCTAssertEqual(PromotionQueueCards.waitLine("j2", in: queue, now: Date(timeIntervalSince1970: 0)),
                       "Waiting to merge: a merge to main is running on main first")
    }
}
