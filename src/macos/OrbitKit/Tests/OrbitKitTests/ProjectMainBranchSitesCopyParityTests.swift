import Foundation
import XCTest
@testable import OrbitKit

/// Every sentence that says where a project's work is merged names the project's main branch, and
/// says it the way the browser does (docs/evidence/project-main-branch-web/copy-sites.md and
/// docs/evidence/project-main-branch-reads/copy-sites.md) — the sites outside the start card and How
/// it runs, whose sentences are `ProjectMainBranchCopyParityTests`'. Each function here is said of a
/// sentinel branch and put back as the web template's `${main}`, then looked up in the web source it
/// was ported from; each one, said of main, is still its constant word for word — the words the other
/// parity tests, and Android's, read.
///
/// A missing counterpart is a FAILURE, never an `XCTSkip`.
final class ProjectMainBranchSitesCopyParityTests: XCTestCase {

    /// The branch every function is said of here: no sentence has it on its own.
    private static let branch = "BRANCH_SENTINEL"
    /// The branch a candidate merges from, for the sentences that name both.
    private static let source = "SOURCE_SENTINEL"

    private struct Missing: Error, CustomStringConvertible {
        let file: String
        var description: String {
            "\(file) was not found above this test file. The native words are one half of a pair; if "
                + "the web half moved, move this check with it rather than deleting it."
        }
    }

    private func web(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(file: relative)
    }

    private func assertSays(_ web: String, _ literal: String, in file: String, line: UInt = #line) {
        XCTAssertTrue(web.contains(literal), "\(file) no longer says \(literal)", line: line)
    }

    /// One of this end's sentences, said of the sentinel, as the web template writes it.
    private static func asWeb(_ said: String, branch template: String = "${main}") -> String {
        said.replacingOccurrences(of: branch, with: template)
    }

    private static let panorama = "src/web/src/components/ProjectPanoramaHeader.tsx"
    private static let acceptance = "src/web/src/components/ProjectAcceptanceCard.tsx"
    private static let integrationLine = "src/web/src/components/ProjectIntegrationLine.tsx"
    private static let confirmation = "src/web/src/components/OwnerConfirmationCard.tsx"
    private static let promotionCard = "src/web/src/components/ProjectPromotionCard.tsx"
    private static let mergeStrip = "src/web/src/components/ProjectMergeStrip.tsx"
    private static let merge = "src/web/src/lib/projectMerge.ts"
    private static let doneWords = "src/web/src/lib/projectDone.ts"
    private static let settlement = "src/web/src/components/ProjectSettlementCard.tsx"
    private static let shareControls = "src/web/src/components/ProjectShareControls.tsx"
    private static let attention = "src/web/src/lib/projectAttention.ts"
    private static let console = "src/web/src/components/WorkspaceView.tsx"
    private static let sessionProjects = "src/web/src/lib/sessionProjects.ts"

    // MARK: each function, said of main, is its constant

    func testEachFunctionSaidOfMainIsTheConstantBesideIt() {
        let main = RunSettings.defaultMainBranch
        XCTAssertEqual(ProjectPage.integrationJobWords(main), ProjectPage.integrationJobWords)
        XCTAssertEqual(ProjectPage.integrationPhaseWords(main), ProjectPage.integrationPhaseWords)
        XCTAssertEqual(OwnerConfirmations.notOn(main), OwnerConfirmations.notOnMain)
        XCTAssertEqual(OwnerConfirmations.noRecordOn(main), OwnerConfirmations.noRecordOnMain)
        XCTAssertEqual(OwnerConfirmations.lineThenOwner(main), OwnerConfirmations.lineThenOwner)
        XCTAssertEqual(OwnerConfirmations.autoMain(main), OwnerConfirmations.autoMain)
        XCTAssertEqual(PromotionCards.mergeTo(main), PromotionCards.mergeToMain)
        XCTAssertEqual(PromotionCards.mergedHeading(main), PromotionCards.mergedHeading)
        XCTAssertEqual(PromotionCards.mergedAutomaticallyHeading(main), PromotionCards.mergedAutomaticallyHeading)
        XCTAssertEqual(ProjectDone.on(main), ProjectDone.onMain)
        XCTAssertEqual(ProjectDone.landedOn(main), ProjectDone.landedOnMain)
        XCTAssertEqual(ProjectDone.waitingDetail(main), ProjectDone.waitingDetail)
        XCTAssertEqual(ProjectDone.needsCallDetail(main), ProjectDone.needsCallDetail)
        for (landing, words) in ShareMarkdown.landingWords {
            XCTAssertEqual(ShareMarkdown.landingWords(landing, main: main), words, landing)
        }
        XCTAssertEqual(ShareMarkdown.landingWords("SOMETHING_NEW", main: main), "SOMETHING_NEW")
        for kind in [OwnerItemKind.promotionApproval, .coordinatorQuestion, .escalated, .fusePaused, .unknown] {
            XCTAssertEqual(NeedsYouLogic.kindWord(kind, main: main), NeedsYouLogic.kindWord(kind), "\(kind)")
        }
        let approval = ProjectListOwnerItem(kind: .promotionApproval, count: 1, oldestWaitingSince: "")
        XCTAssertEqual(ProjectAttention.ownerItemSays(approval, main: main), "Needs you · Approve merge to main")
        XCTAssertEqual(ProjectDone.landingReasonLabel(nil, main: main), "Landed on main")
    }

    /// …and said of another branch, each names that one and never main.
    func testEachFunctionSaidOfAnotherBranchNamesIt() {
        let said = [
            ProjectPage.integrationJobWords("master")["LAND_PROMOTION"],
            ProjectPage.integrationPhaseWords("master")["MAIN_SYNC"],
            OwnerConfirmations.notOn("master"), OwnerConfirmations.noRecordOn("master"),
            OwnerConfirmations.lineThenOwner("master"), OwnerConfirmations.autoMain("master"),
            PromotionCards.mergeTo("master"), PromotionCards.mergedHeading("master"),
            PromotionCards.mergedAutomaticallyHeading("master"),
            ProjectDone.on("master"), ProjectDone.landedOn("master"), ProjectDone.waitingDetail("master"),
            ProjectDone.needsCallDetail("master"), ProjectDone.landingReasonLabel(nil, main: "master"),
            ShareMarkdown.landingWords("LANDED", main: "master"),
            ShareMarkdown.landingWords("ON_INTEGRATION_LINE", main: "master"),
            NeedsYouLogic.kindWord(.promotionApproval, main: "master"),
            ProjectAttention.ownerItemSays(ProjectListOwnerItem(kind: .promotionApproval, count: 1,
                                                                oldestWaitingSince: ""), main: "master"),
        ].map { $0 ?? "" }
        for sentence in said {
            XCTAssertTrue(sentence.contains("master"), sentence)
            XCTAssertNil(sentence.range(of: "\\bmain\\b", options: .regularExpression), sentence)
        }
        XCTAssertEqual(ProjectPage.integrationJobWords("master")["LAND_PROMOTION"], "Merge to master")
        XCTAssertEqual(ProjectPage.integrationPhaseWords("master")["MAIN_SYNC"], "syncing master")
        XCTAssertEqual(PromotionCards.mergedAutomaticallyHeading("master"), "✓ Merged into master automatically")
        XCTAssertEqual(ProjectDone.needsCallDetail("master"),
                       "Orbit saw no merge for it. The coordinator checked master has it and asked you to record "
                           + "the project done.")
    }

    // MARK: the project page

    /// The Work overview's lanes and the landing row's words: `integrationLanes`, `jobWords` and
    /// `jobPhases`, every other word the constant's — and the row and its list take the branch off
    /// the view they draw.
    func testTheOverviewAndTheLandingRowSayItAsTheWebDoes() throws {
        let web = try web(Self.panorama)
        let words = ProjectPage.integrationJobWords(Self.branch)
        let phases = ProjectPage.integrationPhaseWords(Self.branch)
        assertSays(web, "return { ...JOB_WORDS, LAND_PROMOTION: `\(Self.asWeb(words["LAND_PROMOTION"] ?? ""))` };",
                   in: Self.panorama)
        assertSays(web, "return { ...JOB_PHASES, MAIN_SYNC: `\(Self.asWeb(phases["MAIN_SYNC"] ?? ""))` };",
                   in: Self.panorama)
        XCTAssertEqual(words.filter { $0.key != "LAND_PROMOTION" },
                       ProjectPage.integrationJobWords.filter { $0.key != "LAND_PROMOTION" })
        XCTAssertEqual(phases.filter { $0.key != "MAIN_SYNC" },
                       ProjectPage.integrationPhaseWords.filter { $0.key != "MAIN_SYNC" })
        XCTAssertEqual(web.components(separatedBy: "const main = mainBranchName(view.upstreamRef);").count, 3,
                       "the landing row and its job list each take the branch off the view")
        for call in ["jobWords(main)[inFlight.kind]", "jobWords(main)[job.kind]",
                     "running ? (job.phase ? jobPhases(main)[job.phase] ?? 'running' : 'running') : 'queued'",
                     "const stoppedAt = job.phase ? jobPhases(main)[job.phase] ?? 'running' : 'running';"] {
            assertSays(web, call, in: Self.panorama)
        }

        let integrating = ProjectPanoramaBuckets(running: 1, ready: 1, blocked: 1, awaitingVerification: 1,
                                                 done: 4, failed: 1, cancelled: 1, integrating: 1,
                                                 onIntegrationLine: 1, onUpstream: 1, doneNotIntegrated: 1,
                                                 waitingForLanding: 1)
        let cells = ProjectPage.overviewCells(integrating, taskCount: 9, line: .projectBranch, main: Self.branch)
        let branchLane = try XCTUnwrap(cells.first { $0.key == "onIntegrationLine" })
        let upstream = try XCTUnwrap(cells.first { $0.key == "onUpstream" })
        assertSays(web, "footnote: `\(Self.asWeb(branchLane.footnote))`", in: Self.panorama)
        assertSays(web, "label: `\(Self.asWeb(upstream.label))`, value: at(buckets.onUpstream), "
                       + "footnote: `\(Self.asWeb(upstream.footnote))`", in: Self.panorama)
        // Every other lane is the same at any branch.
        let atMain = ProjectPage.overviewCells(integrating, taskCount: 9, line: .projectBranch)
        XCTAssertEqual(cells.filter { !["onIntegrationLine", "onUpstream"].contains($0.key) },
                       atMain.filter { !["onIntegrationLine", "onUpstream"].contains($0.key) })
    }

    /// Where met work is, under a criterion: on the main branch, or on the project branch and not on
    /// the main branch yet (`landingSentence`).
    func testTheCriteriaSayItAsTheWebDoes() throws {
        let web = try web(Self.acceptance)
        let landed = ProjectPage.criterionWork(
            ProjectCriterion(id: "c", ordinal: 1, text: "t", satisfied: true, landing: "LANDED"),
            integrationRef: nil, main: Self.branch)
        let onLine = ProjectPage.criterionWork(
            ProjectCriterion(id: "c", ordinal: 1, text: "t", satisfied: true, landing: "ON_INTEGRATION_LINE"),
            integrationRef: "project/x", main: Self.branch)
        assertSays(web, "landing === 'LANDED' ? `\(Self.asWeb(try XCTUnwrap(landed?.landing)))`", in: Self.acceptance)
        assertSays(web, "tail: `\(Self.asWeb(try XCTUnwrap(onLine?.landingWarning)))`", in: Self.acceptance)
        XCTAssertEqual(onLine?.landing, "on project/x")
    }

    /// The line row's two facts about the main branch — JSX's `{main}`, off the integration read.
    func testTheIntegrationFactsSayItAsTheWebDoes() throws {
        let web = try web(Self.integrationLine)
        let now = try XCTUnwrap(RelativeTime.parse("2026-10-11T00:12:00Z"))
        let view = ProjectIntegrationView(line: .projectBranch, ref: "project/x", upstreamRef: Self.branch,
                                          commitsAheadOfUpstream: 7, lastUpstreamSyncAt: "2026-10-11T00:00:00Z")
        let facts = try XCTUnwrap(ProjectPage.integrationFacts(view, now: now))
        XCTAssertEqual(Array(facts.prefix(3)), ["project/x", "7 commits ahead of \(Self.branch) at last measurement",
                                                "synced with \(Self.branch) 12m ago"])
        assertSays(web, "commit{ahead === 1 ? '' : 's'} ahead of {main} at last measurement", in: Self.integrationLine)
        assertSays(web, "synced with {main} {ago(view.lastUpstreamSyncAt, Date.now())}", in: Self.integrationLine)
        assertSays(web, "const main = mainBranchName(view.upstreamRef);", in: Self.integrationLine)
    }

    // MARK: the confirmation card

    func testIfYouConfirmSaysItAsTheWebDoes() throws {
        let web = try web(Self.confirmation)
        for said in [OwnerConfirmations.notOn(Self.branch), OwnerConfirmations.noRecordOn(Self.branch),
                     OwnerConfirmations.lineThenOwner(Self.branch), OwnerConfirmations.autoMain(Self.branch)] {
            assertSays(web, "return `\(Self.asWeb(said))`;", in: Self.confirmation)
        }
        // …of the branch the card's own read names.
        assertSays(web, "const main = mainBranchName(ifConfirmed.mainBranch);", in: Self.confirmation)
        assertSays(web, "lead: branch.onMain === 'NO' ? ifConfirmedNotOn(main) : ifConfirmedNoRecordOn(main),",
                   in: Self.confirmation)
        assertSays(web, "lead: landing === 'LINE_THEN_OWNER' ? ifConfirmedLineThenOwner(main) : ifConfirmedAutoMain(main),",
                   in: Self.confirmation)
    }

    // MARK: the merge

    private func candidate(_ state: PromotionState, blockedReason: String? = nil, conflicts: [String] = [],
                           merged: ProjectPromotionView.Merged? = nil) -> ProjectPromotionView {
        ProjectPromotionView(promotionId: "pr-1", state: state, sourceRef: "refs/heads/\(Self.source)",
                             sourceSha: "58f3a4711d0c", upstreamRef: "refs/heads/\(Self.branch)", commitsAhead: 2,
                             taskIds: ["t1"], conflicts: conflicts, blockedReason: blockedReason, merged: merged)
    }

    /// The card's press, its two receipt headings and its receipt row: `mergeTo`, `mergedHeading`,
    /// `mergedAutomaticallyHeading`, `Now on …` — each of the candidate's own `upstreamRef`, on the
    /// card and on the sessions page's strip.
    func testTheMergeCardSaysItAsTheWebDoes() throws {
        let web = try web(Self.promotionCard)
        for said in [PromotionCards.mergeTo(Self.branch), PromotionCards.mergedHeading(Self.branch),
                     PromotionCards.mergedAutomaticallyHeading(Self.branch)] {
            assertSays(web, "return `\(Self.asWeb(said))`;", in: Self.promotionCard)
        }
        let merged = candidate(.merged, merged: .init(sha: "8d5a8681", at: "2026-10-10T00:00:00Z"))
        XCTAssertEqual(PromotionCards.title(merged), PromotionCards.mergedHeading(Self.branch))
        let automatic = candidate(.merged, merged: .init(sha: "8d5a8681", at: "2026-10-10T00:00:00Z",
                                                         automatic: true))
        XCTAssertEqual(PromotionCards.title(automatic), PromotionCards.mergedAutomaticallyHeading(Self.branch))
        assertSays(web, "return promotion.merged?.automatic ? mergedAutomaticallyHeading(upstream) : mergedHeading(upstream);",
                   in: Self.promotionCard)
        let named = "${mainBranchName(promotion.upstreamRef)}"
        assertSays(web, "<Row k={`\(Self.asWeb(PromotionCards.nowOnLabel(merged), branch: named))`}>", in: Self.promotionCard)
        assertSays(web, "{mergeTo(mainBranchName(promotion.upstreamRef))}", in: Self.promotionCard)
        let strip = try self.web(Self.mergeStrip)
        assertSays(strip, "{mergeTo(mainBranchName(current.upstreamRef))}", in: Self.mergeStrip)
    }

    /// The sentences `lib/projectMerge.ts` names the branch in one way, `mainBranchName`, and this end
    /// puts the branch exactly where they do — `shortRef` only for the branch merged from.
    func testTheMergeSentencesPutTheBranchWhereTheWebDoes() throws {
        let web = try web(Self.merge)
        let named = "${mainBranchName(promotion.upstreamRef)}"
        func asWeb(_ said: String) -> String {
            Self.asWeb(said, branch: named).replacingOccurrences(of: Self.source, with: "${shortRef(promotion.sourceRef)}")
        }
        let merged = candidate(.merged, merged: .init(sha: "8d5a8681", at: "2026-10-10T00:00:00Z"))
        XCTAssertEqual(PromotionCards.receiptLine(merged), "✓ Merged into \(Self.branch) · 8d5a868 · 1 task")
        assertSays(web, "`\(asWeb("✓ Merged into \(Self.branch)"))`,", in: Self.merge)
        assertSays(web, "return `\(asWeb(PromotionCards.timelineTitle(merged)))`;", in: Self.merge)
        assertSays(web, "return { text: `\(asWeb(PromotionCards.eventLine(candidate(.ready)).text))`, tone: 'needsYou' };",
                   in: Self.merge)
        assertSays(web, "return `\(asWeb(PromotionCards.blockedLine(candidate(.blocked, blockedReason: "ALREADY_LANDED"))))`;",
                   in: Self.merge)
        XCTAssertEqual(PromotionCards.branchLine(candidate(.ready)), "\(Self.source) · 2 commits ahead of \(Self.branch)")
        assertSays(web, "ahead of \(named)`;", in: Self.merge)
        XCTAssertEqual(PromotionCards.upstreamLine(candidate(.ready, conflicts: ["a.go"])),
                       "1 file conflict with \(Self.branch)")
        assertSays(web, "`${plural(promotion.conflicts.length, 'file')} conflict with \(named)`", in: Self.merge)
        // The page's heading and the merge's status say `into`, which is the same name.
        XCTAssertEqual(PromotionCards.pageTitle(candidate(.ready)), "Merge into \(Self.branch)?")
        XCTAssertEqual(web.components(separatedBy: "const into = mainBranchName(promotion.upstreamRef);").count, 3)
        // Who is in front of a blocked merge: a sync of the branch it merges into.
        assertSays(web, "jobPhases(mainBranchName(promotion.upstreamRef))[job.phase]", in: Self.merge)
    }

    // MARK: the done cards

    func testTheDoneCardsSayItAsTheWebDoes() throws {
        let words = try web(Self.doneWords)
        for said in [ProjectDone.on(Self.branch), ProjectDone.waitingDetail(Self.branch),
                     ProjectDone.needsCallDetail(Self.branch), ProjectDone.landedOn(Self.branch)] {
            assertSays(words, "return `\(Self.asWeb(said))`;", in: Self.doneWords)
        }
        assertSays(words, "default: return `\(Self.asWeb(ProjectDone.landingReasonLabel(nil, main: Self.branch)))`;",
                   in: Self.doneWords)

        let card = try web(Self.settlement)
        let subject = ProjectDoneSubject(
            title: "P", status: "OPEN", criteria: [.init(id: "c1", ordinal: 1, text: "It ships")],
            derivedDone: ProjectDerivedDone(criteria: [ProjectDoneCriterion(definitionId: "c1", satisfied: true,
                                                                            landingReason: .noReceipt)]),
            upstreamRef: Self.branch)
        let gap = try XCTUnwrap(ProjectDone.syntheticGaps(subject).first?.whyNotProven)
        let reason = ProjectDone.landingReasonLabel(.noReceipt, main: Self.branch)
        assertSays(card, "? `\(Self.asWeb(gap.replacingOccurrences(of: reason, with: "${reason}")))`", in: Self.settlement)
        // Off the project document the cards read, in each of the three cards.
        XCTAssertEqual(card.components(separatedBy: "const main = mainBranchName(project.integration?.upstreamRef);").count, 4)
    }

    // MARK: Copy as Markdown

    func testCopyAsMarkdownSaysItAsTheWebDoes() throws {
        let web = try web(Self.shareControls)
        assertSays(web, "if (landing === 'LANDED') return `\(Self.asWeb(ShareMarkdown.landingWords("LANDED", main: Self.branch)))`;",
                   in: Self.shareControls)
        assertSays(web, "if (landing === 'ON_INTEGRATION_LINE') return `\(Self.asWeb(ShareMarkdown.landingWords("ON_INTEGRATION_LINE", main: Self.branch)))`;",
                   in: Self.shareControls)
        assertSays(web, "return LANDING_WORDS[landing] ?? landing;", in: Self.shareControls)
        assertSays(web, "const main = mainBranchName(project.integration?.upstreamRef);", in: Self.shareControls)
        assertSays(web, "landingWords(criterion.landing, main)", in: Self.shareControls)
    }

    // MARK: the rows that ask for a merge

    /// The projects list's chip and a session row's word for a merge approval, each of the main
    /// branch its own read carries (`GET /projects`'s row, `ownerItems[].mainBranch`).
    func testTheMergeApprovalSaysItAsTheWebDoes() throws {
        let attention = try web(Self.attention)
        let approval = ProjectListOwnerItem(kind: .promotionApproval, count: 1, oldestWaitingSince: "")
        let chip = try XCTUnwrap(ProjectAttention.ownerItemSays(approval, main: Self.branch))
        assertSays(attention, "PROMOTION_APPROVAL: (_item, main) => `\(Self.asWeb(chip))`,", in: Self.attention)
        assertSays(attention, "const says = OWNER_ITEM_SAYS[item.kind](item, mainBranchName(project.mainBranch));",
                   in: Self.attention)

        let console = try web(Self.console)
        let word = try XCTUnwrap(NeedsYouLogic.kindWord(.promotionApproval, main: Self.branch))
        assertSays(console, "({ ...OWNER_ITEM_WORDS, PROMOTION_APPROVAL: `\(Self.asWeb(word))` });", in: Self.console)
        assertSays(console, "const word = ownerItemWords(mainBranchName(item?.mainBranch))[item?.kind];", in: Self.console)
    }

    // MARK: the sessions page

    /// The session list's project landing line names the sidebar row's main branch, and the start
    /// row's suggestion the one the start card opens with.
    func testTheSessionsPageSaysItAsTheWebDoes() throws {
        let web = try web(Self.sessionProjects)
        for call in ["(job.kind && jobWords(main)[job.kind as keyof typeof JOB_WORDS]) || 'Integration'",
                     "(job.phase && jobPhases(main)[job.phase as keyof typeof JOB_PHASES]) || 'running'",
                     "summary?.integration, opts.now ?? Date.now(), mainBranchName(summary?.mainBranch));"] {
            assertSays(web, call, in: Self.sessionProjects)
        }
        let console = try self.web(Self.console)
        assertSays(console, "SESSION_PROJECT_COPY.startSuggestion(settings, startMainBranch(settings.upstreamRef, standing))",
                   in: Self.console)
        let settings = ProjectStartSettings(line: .main, automatic: false, maxConcurrentTasks: 1)
        XCTAssertEqual(SessionProjectCopy.startSuggestion(settings, main: Self.branch),
                       "\(RunSettings.lineMain(Self.branch)) · Automatic off · 1 at a time")
    }
}
