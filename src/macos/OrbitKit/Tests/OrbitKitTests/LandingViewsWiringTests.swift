import Foundation
import XCTest
@testable import OrbitKit

/// The SwiftUI connections the Linux suite cannot compile: a source check per entrance the landing
/// session work adds, so a view that stops drawing one fails here rather than in a screenshot.
final class LandingViewsWiringTests: XCTestCase {
    private struct SourceMissing: Error { let path: String }

    private func appSource(_ relative: String) throws -> String {
        let path = "src/macos/OrbitApp/Sources/OrbitApp/\(relative)"
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(path)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir.deleteLastPathComponent()
        }
        throw SourceMissing(path: path)
    }

    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    /// A LANDING session draws the landing page in the console frame — the same `.console` node, so
    /// pushes and `/sessions/<id>` links still reach it.
    func testTheConsoleDrawsALandingSessionAsItsOwnPage() throws {
        let view = code(try appSource("Views/Console/ConsoleView.swift"))
        XCTAssertTrue(view.contains("if appModel.session(id: sessionID)?.isLanding == true {"))
        XCTAssertTrue(view.contains("LandingSessionPageView(sessionID: sessionID)"))
        XCTAssertTrue(view.contains("guard appModel.session(id: sessionID)?.isLanding != true else { return }"),
                      "a landing session never creates a conversation console")
        // The landing page itself holds the mockup's parts.
        let page = code(try appSource("Views/LandingSessionPageView.swift"))
        for part in ["ProjectLandingHead(",
                     "LandingPageCopy.attemptCard(landing, now: now, updatedAt: readAt,",
                     "LandingPageCopy.outcomeCard(landing, promotion: currentPromotion(landing))",
                     "LandingPageCopy.menuItems(",
                     "LandingPageCopy.gates(landing, now: now, updatedAt: readAt, failed: readFailed)",
                     "LandingPageCopy.footer(landing, onPass: currentPromotion(landing)?.onPass)",
                     "LandingPageCopy.noReportBand(landing)",
                     "LandingPageCopy.timeoutLine(landing, attempt: attempt,",
                     "LandingCheckLogView(sessionID: sessionID, selectors: openLog)",
                     "LandingPageCopy.offlinePlaceholder(",
                     "app.landingInFlightCache[sessionID]"] {
            XCTAssertTrue(page.contains(part), "the landing page keeps `\(part)`")
        }
        XCTAssertFalse(page.contains("ComposerView("), "a landing page has no composer (LS6)")
        XCTAssertFalse(page.contains("Copy Link"), "design §3: no Copy Link on the landing menu")
    }

    /// Board 05's timed-out doors: Retry and Re-run the check solid, Abandon the light red secondary
    /// (`cap4.red`, the web's default danger button). The X-E5 card's solid Abandon lead is its own
    /// `weighted(...)` in ApprovalCards.swift, pinned by ExceptionCardsWiringTests.
    func testTheStatusCardDrawsAbandonAsTheLightSecondaryDoor() throws {
        let page = code(try appSource("Views/LandingSessionPageView.swift"))
        guard let start = page.range(of: "@ViewBuilder private func timedOutDoors("),
              let end = page.range(of: "private var offlineCard: some View {",
                                   range: start.upperBound..<page.endIndex),
              let split = page.range(of: "if gates.abandon {", range: start.upperBound..<end.lowerBound) else {
            return XCTFail("the status card keeps its timed-out doors")
        }
        let solid = String(page[start.upperBound..<split.lowerBound])
        let abandon = String(page[split.lowerBound..<end.lowerBound])
        XCTAssertTrue(solid.contains(".buttonStyle(.borderedProminent)"), "Retry and Re-run the check stay solid")
        XCTAssertTrue(abandon.contains("Button(role: .destructive) { act(.abandon, landing) } label: {"))
        XCTAssertTrue(abandon.contains(".buttonStyle(.bordered).tint(.red).controlSize(.small).disabled(acting)"),
                      "Abandon is the bordered secondary door, its fill the light red wash of a red tint")
        XCTAssertFalse(abandon.contains(".borderedProminent"), "Abandon is not a solid red door")
        XCTAssertTrue(abandon.contains("#if os(macOS)") && abandon.contains(".foregroundStyle(.red)"),
                      "a Mac push button keeps Abandon's word red")
    }

    /// The Landing card's sentence, which Linux cannot render: a card holding only a merge job says
    /// no "Nothing to do" (that job lands no task; board v4 04 draws no body under its head), and a
    /// timed-out card still says where its runner stopped. The model's `mergeJob` decides it
    /// (ProjectLandingCardTests); this pins that the card reads it.
    func testALoneMergeJobsCardSaysNoTaskLandingSentence() throws {
        let card = code(try appSource("Views/ProjectLandingCard.swift"))
        XCTAssertTrue(card.contains("if card.timedOut, let detail = card.detail {"),
                      "a timed-out card says where its runner stopped")
        XCTAssertTrue(card.contains("} else if !card.timedOut && (several || !card.mergeJob) {"),
                      "the task-landing sentence is not said under a lone merge job")
        XCTAssertTrue(card.contains("Text(ProjectPage.landingNothingToDo)"))
    }

    /// 方案 A's entrances: one job's card foot, a row each for several (never the merge job's), one
    /// per list row, the merge round's whole row, the CONFIRMED card's foot and the receipt's.
    func testTheLandingCardAndTheJobsListAndTheMergeRowCarryTheirEntries() throws {
        let card = code(try appSource("Views/ProjectLandingCard.swift"))
        XCTAssertTrue(card.contains("if !job.mergeJob {"),
                      "a merge job's row carries no entry: the merge card is that round's way in")
        XCTAssertTrue(card.contains("LandingEntryLink(entry: LandingPageCopy.landingEntry(job.landingSessionId))"))
        XCTAssertTrue(card.contains("if let lead {"), "one job's way in is the card's foot")
        XCTAssertTrue(card.contains("LandingEntryLink(entry: LandingPageCopy.landingEntry(lead.landingSessionId))"))
        XCTAssertTrue(card.contains("if card.retryJobId != nil || onOpenJobs != nil || lead != nil {"))

        let sheet = code(try appSource("Views/ProjectLandingJobsSheet.swift"))
        XCTAssertTrue(sheet.contains("LandingEntryLink(entry: LandingPageCopy.landingEntry(row.landingSessionId))"),
                      "a list row's own way in, beside Retry")

        let page = code(try appSource("Views/SessionProjectPage.swift"))
        XCTAssertTrue(page.contains("roundLanding: ProjectMergeCard.roundLandingSessionId("))
        XCTAssertTrue(page.contains("if let roundLanding, let url = URL(string: \"orbit-session:"),
                      "the merge row opens this round's landing")
        XCTAssertTrue(page.contains("private var openLandingFoot: some View {"),
                      "the CONFIRMED card's foot names the round's landing")
        XCTAssertTrue(page.contains("LandingPageCopy.moreJobsQueued(jobCount)"),
                      "+N job queued · All jobs ›")
        XCTAssertTrue(page.contains("if mergeJobKind == \"CHECK_PROMOTION\""),
                      "a timed-out check offers Re-run the check")
        XCTAssertTrue(page.contains("if let mergeJobID {"), "and every timed-out round offers Abandon")
        XCTAssertTrue(page.contains("private func landingGroupRow(_ row: LandingGroupRow) -> some View {"))

        let overview = code(try appSource("Views/ProjectsView.swift"))
        XCTAssertTrue(overview.contains("ProjectPage.landingCard(integration, now: context.date,"))
        XCTAssertFalse(overview.contains("ProjectMergeCard.taskLandingCard"),
                       "the Work overview draws a merge job too")

        let approval = code(try appSource("Views/ApprovalCards.swift"))
        XCTAssertTrue(approval.contains("if let landingID = ProjectMergeCard.receiptLandingSessionId(promotion) {"),
                      "the receipt's foot opens the round's landing")
        XCTAssertTrue(approval.contains("case .openLanding:"), "the X-E5 card draws Open landing")
        XCTAssertTrue(approval.contains("case .abandon:"), "and its lead door")
    }

    /// The task page's Landing section: the web's words, the Open landing link and the 4 s / 15 s
    /// reread while the attempt is live.
    func testTheTaskPageDrawsItsLandingSection() throws {
        let tasks = code(try appSource("Views/TasksView.swift"))
        XCTAssertTrue(tasks.contains("if let landing = TaskLandingLogic.status(task.integration, taskStatus: task.status.rawValue) {"))
        XCTAssertTrue(tasks.contains("private func landingSection(_ status: TaskLandingStatus) -> some View {"))
        XCTAssertTrue(tasks.contains("LandingEntryLink(entry: .link(sessionID), compact: false)"))
        XCTAssertTrue(tasks.contains("TaskLandingCopy.refetchInterval(tasks.detail?.integration)"))
        XCTAssertTrue(tasks.contains("private func pollLanding() async {"))

        let delivery = code(try appSource("Views/OpenItemDeliveryCardView.swift"))
        XCTAssertTrue(delivery.contains("OpenItemDeliveryCard.landingLink(card)"))
        XCTAssertTrue(delivery.contains("OpenItemDeliveryCard.openLanding"))
    }

    /// The source session's derived label at the bottom of the conversation that fed the landing.
    func testTheSourceSessionCarriesItsLandingLabel() throws {
        let console = code(try appSource("Views/Console/ConsoleView.swift"))
        XCTAssertTrue(console.contains("SourceLandingChip(console: console)"))
        let chip = code(try appSource("Views/LandingEntryLink.swift"))
        XCTAssertTrue(chip.contains("SessionProjectLandings.sourceLabel(console.worktree.detail?.sourceLanding)"))
        XCTAssertTrue(chip.contains("orbit-session:"))
    }

    /// Each Re-run the check door names its own sentence, as web's two doors do: the merge card on
    /// the project sessions page sends the merge card's, the landing page the landing page's.
    /// APIClient only forwards the reason it is given, so the choice is pinned here, at the doors.
    func testEachReRunDoorSendsItsOwnReason() throws {
        let collapse = { (text: String) in text.split(whereSeparator: \.isWhitespace).joined(separator: " ") }
        let card = code(try appSource("Views/SessionProjectPage.swift"))
        XCTAssertTrue(collapse(card).contains("try await app.rerunPromotionCheck(address.projectID, promotionID: promotionID, reason: LandingPageCopy.rerunCheckReason)"),
                      "the merge card's Re-run the check names the merge card")
        XCTAssertFalse(card.contains("rerunLandingCheckReason"), "the merge card never sends the landing page's sentence")
        let page = code(try appSource("Views/LandingSessionPageView.swift"))
        XCTAssertTrue(collapse(page).contains("try await api.rerunPromotionCheck(projectID: landing.projectId, promotionID: promotionID, reason: LandingPageCopy.rerunLandingCheckReason)"),
                      "the landing page's Re-run the check names the landing page")
        XCTAssertFalse(page.contains("LandingPageCopy.rerunCheckReason"), "the landing page never sends the merge card's sentence")
    }

    /// The timeline's marks read each line's structured fields, as web and Android do: the ✓ and
    /// the inline output come from `checkPassed` / `succeeded(in:)`, never from the sentence's
    /// words, and a result's ✓ also reads the job kind of the section it is in (a merge check's
    /// READY is a pass, a merge to main's is not).
    func testTheTimelinesMarksReadTheLinesFields() throws {
        let page = code(try appSource("Views/LandingSessionPageView.swift"))
        XCTAssertTrue(page.contains("} else if entry.kind == \"CHECK_FINISHED\", let check = entry.check, !entry.checkPassed {"))
        XCTAssertTrue(page.contains("let mark = glyph(entry, jobKind: section.kind, entries: entries, index: index)"),
                      "a line's mark is read with its section's job kind")
        XCTAssertTrue(page.contains("return entry.succeeded(in: jobKind) ? Mark(glyph: \"✓\", color: .green) : Mark(glyph: \"✗\", color: .red)"))
        for words in ["contains(\"passed\")", "\"Nothing to push\"", "\"Already\"", "hasPrefix("] {
            XCTAssertFalse(page.contains(words), "the page still reads a line's words: \(words)")
        }
    }

    /// The page's own reads: `includeLanding=1` on the project list, the landing's own cadence, and
    /// the last inFlight snapshot kept for a page that cannot reach the server.
    func testTheLandingReadsAreWired() throws {
        let app = code(try appSource("AppModel.swift"))
        XCTAssertTrue(app.contains("includeLanding: true"))
        XCTAssertTrue(app.contains("private(set) var landingInFlightCache: [String: ProjectIntegrationInFlight] = [:]"))
        XCTAssertTrue(app.contains("landingInFlightCache[landingSessionId] = ProjectIntegrationInFlight("))
        XCTAssertTrue(app.contains("let members = SessionProjectMembers.members(of: address.projectID, in: kept)")
                      && app.contains(".filter { !$0.isLanding }")
                      && app.contains("projectSessions = members + landedRows(of: address.projectID, in: kept)"),
                      "a landing row is a member too — it must not be drawn twice")
        XCTAssertTrue(app.contains("$0.isLanding && $0.landing?.state == \"AWAITING_DECISION\""),
                      "the Landings group's holders are read where a landing waits")
        XCTAssertTrue(app.contains("func abandonIntegrationJob(_ projectID: String, jobID: String) async throws"))
        XCTAssertTrue(app.contains("func rerunPromotionCheck(_ projectID: String, promotionID: String, reason: String) async throws"))

        let model = code(try appSource("ConsoleModel.swift"))
        XCTAssertTrue(model.contains("func abandonIntegration(_ row: ProjectOpenItemRow) async {"))
    }
}
