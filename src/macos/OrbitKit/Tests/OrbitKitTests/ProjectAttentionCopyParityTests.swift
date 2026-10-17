import Foundation
import XCTest
@testable import OrbitKit

/// The projects index says the same words on both clients, and this is the tripwire that keeps it
/// so: `ProjectAttention.swift` is a port of `src/web/src/lib/projectAttention.ts`, and nothing in
/// either build notices a lane title or a chip re-worded at one end only.
///
/// A missing counterpart is a FAILURE, never an `XCTSkip`: a check that quietly opts out reports
/// green on exactly the day the thing it watches goes missing.
final class ProjectAttentionCopyParityTests: XCTestCase {

    private static let webSource = "src/web/src/lib/projectAttention.ts"

    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.webSource).path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        throw ParityError.noRepo
    }

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        var description: String {
            "\(ProjectAttentionCopyParityTests.webSource) was not found above this test file. "
                + "OrbitKit's ProjectAttention is one half of a pair; if the web half moved, move "
                + "this check with it rather than deleting it."
        }
    }

    /// The web source with adjacent string literals joined and wrapped values pulled up, so a
    /// sentence is compared as words rather than as wherever the formatter broke the line.
    private func web() throws -> String {
        let source = try String(contentsOf: try repoRoot().appendingPathComponent(Self.webSource),
                                encoding: .utf8)
        return source
            .replacingOccurrences(of: "['`]\\s*\\+\\s*['`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "([=:])\\s*\\n\\s*(['`])", with: "$1 $2",
                                  options: .regularExpression)
    }

    func testLaneTitlesAndNotesAreTheWebsOwn() throws {
        let web = try web()
        for section in ProjectAttentionSection.allCases {
            XCTAssertTrue(web.contains("key: '\(section.rawValue)',"),
                          "the web no longer has a lane keyed \(section.rawValue)")
            XCTAssertTrue(web.contains("title: '\(section.title)',"),
                          "lane \(section.rawValue): the web no longer titles it \(section.title.debugDescription)")
            XCTAssertTrue(web.contains("note: '\(section.note)',"),
                          "lane \(section.rawValue): the web's note drifted from \(section.note.debugDescription)")
        }
    }

    /// One of this end's sentences about main, as the browser writes it for whichever branch is the
    /// project's main branch: each `main` put back as the template's `${main}`. A project on main then
    /// reads the same sentence at both ends.
    private static func onMainBranch(_ sentence: String) -> String {
        sentence.replacingOccurrences(of: "\\bmain\\b", with: "${main}", options: .regularExpression)
    }

    func testOwnerItemChipsAreTheWebsOwn() throws {
        let web = try web()
        func item(_ kind: OwnerItemKind, _ count: Int) -> ProjectListOwnerItem {
            ProjectListOwnerItem(kind: kind, count: count, oldestWaitingSince: "2026-01-01T00:00:00Z")
        }
        // The merge approval names the project's main branch, which the row carries (`mainBranch`).
        XCTAssertTrue(web.contains(
            "PROMOTION_APPROVAL: (_item, main) => `\(Self.onMainBranch(ProjectAttention.ownerItemSays(item(.promotionApproval, 1))!))`,"),
                      "the merge approval's chip drifted")
        XCTAssertTrue(web.contains("const says = OWNER_ITEM_SAYS[item.kind](item, mainBranchName(project.mainBranch));"),
                      "the chip no longer takes the main branch off the row")
        XCTAssertTrue(web.contains(
            "FUSE_PAUSED: () => '\(ProjectAttention.ownerItemSays(item(.fusePaused, 1))!)',"))

        // Rendered with a sentinel count and put back into the web's template spelling.
        let escalated = ProjectAttention.ownerItemSays(item(.escalated, 23))!
            .replacingOccurrences(of: "23", with: "${item.count}")
        XCTAssertTrue(web.contains("ESCALATED: (item) => `\(escalated)`,"),
                      "the escalated chip drifted from \(escalated.debugDescription)")

        XCTAssertEqual(ProjectAttention.ownerItemSays(item(.coordinatorQuestion, 1)),
                       "Needs you · 1 question from coordinator")
        XCTAssertEqual(ProjectAttention.ownerItemSays(item(.coordinatorQuestion, 2)),
                       "Needs you · 2 questions from coordinator")
        XCTAssertTrue(web.contains(
            "`Needs you · ${item.count} question${item.count === 1 ? '' : 's'} from coordinator`"),
                      "the question chip's template drifted")
    }

    /// The fifth thing a row can wait on the owner for: its coordinator asking to start the project.
    /// Its reason is keyed and ranked the web's way, and it says the web's words — the same two the
    /// coordinator's session row says (`READY_TO_START` in `lib/projectStart.ts`).
    func testTheStartRequestChipIsTheWebsOwn() throws {
        let web = try web()
        XCTAssertTrue(web.contains("| '\(ProjectAttentionReason.readyToStart.rawValue)'"),
                      "the web no longer has a reason keyed \(ProjectAttentionReason.readyToStart.rawValue)")
        XCTAssertTrue(web.contains("'\(ProjectAttentionReason.readyToStart.rawValue)': 1,"),
                      "the web no longer ranks a start request in the owner tier")
        XCTAssertTrue(web.contains("export const READY_TO_START_SAYS = `Needs you · ${READY_TO_START}`;"),
                      "the start request's chip drifted from the web's")
        XCTAssertEqual(ProjectAttention.readyToStartSays, "Needs you · \(StartProject.readyToStart)")
        XCTAssertTrue(web.contains("text: [READY_TO_START_SAYS, age].filter(Boolean).join(' · ')"),
                      "the chip says how long the request has waited, as the four do")

        let start = try String(contentsOf: try repoRoot().appendingPathComponent("src/web/src/lib/projectStart.ts"),
                               encoding: .utf8)
        XCTAssertTrue(start.contains("export const READY_TO_START = '\(StartProject.readyToStart)';"),
                      "READY_TO_START drifted from \(StartProject.readyToStart.debugDescription)")
    }

    /// The sixth: its coordinator asking to record the project done (criterion 2: "the projects list
    /// says Ready to close"). Keyed, ranked, worded and counted the browser's way since its fix
    /// 1f85c0afe — and held to the shared read model too, which documents the row as saying exactly
    /// this, built from the session row's own word (`READY_TO_CLOSE` in `lib/projectDone.ts`).
    func testTheDoneRequestChipIsTheReadModelsOwnWords() throws {
        let shared = try String(contentsOf: try repoRoot().appendingPathComponent("src/shared/src/project-progress.ts"),
                                encoding: .utf8)
            .replacingOccurrences(of: "\\s*\\n\\s*\\*\\s*", with: " ", options: .regularExpression)
        XCTAssertTrue(shared.contains("doneRequest?: { waitingSince: Instant } | null;"),
                      "the index no longer carries the done request")
        XCTAssertTrue(shared.contains("row names it as waiting on the owner (\"\(ProjectAttention.readyToCloseSays)\")"),
                      "the read model no longer says the row names it \(ProjectAttention.readyToCloseSays.debugDescription)")
        let words = try String(contentsOf: try repoRoot().appendingPathComponent("src/web/src/lib/projectDone.ts"),
                               encoding: .utf8)
        XCTAssertTrue(words.contains("export const READY_TO_CLOSE = '\(ProjectDone.readyToClose)';"),
                      "READY_TO_CLOSE drifted from \(ProjectDone.readyToClose.debugDescription)")
        let web = try web()
        XCTAssertTrue(web.contains("export const READY_TO_START_SAYS = `Needs you · ${READY_TO_START}`;"),
                      "the owner tier's request chips no longer open with Needs you ·")
        XCTAssertTrue(web.contains("text: [READY_TO_START_SAYS, age].filter(Boolean).join(' · ')"),
                      "a request's chip no longer says how long it has waited")
        XCTAssertEqual(ProjectAttention.readyToCloseSays, "Needs you · \(ProjectDone.readyToClose)")
        XCTAssertNotEqual(ProjectAttentionReason.doneRequest.rawValue, ProjectAttentionReason.readyToClose.rawValue,
                          "the settled-but-unasked chip is the web's ready-to-close; the request is not it")
        XCTAssertTrue(web.contains("| '\(ProjectAttentionReason.readyToClose.rawValue)';"))
        // The browser's own: the reason, its tier, its words and its age.
        XCTAssertTrue(web.contains("| '\(ProjectAttentionReason.doneRequest.rawValue)'"),
                      "the web no longer has a reason keyed \(ProjectAttentionReason.doneRequest.rawValue)")
        XCTAssertTrue(web.contains("'\(ProjectAttentionReason.doneRequest.rawValue)': 1,"),
                      "the web no longer ranks a done request in the owner tier")
        XCTAssertTrue(web.contains("export const READY_TO_CLOSE_SAYS = `Needs you · ${READY_TO_CLOSE}`;"),
                      "the done request's chip drifted from the web's")
        XCTAssertTrue(web.contains("text: [READY_TO_CLOSE_SAYS, age].filter(Boolean).join(' · ')"),
                      "the chip says how long the request has waited, as the start request's does")
        // Who leads when several wait: the longest, and on a tie the four, then the start, then this.
        XCTAssertTrue(web.contains("['ready-to-start', startRequestOf(project)],\n    ['done-request', doneRequestOf(project)],"),
                      "the order a tie is settled in drifted")
        XCTAssertTrue(web.contains("if (request && (!lead || byInstantAsc(request.waitingSince, lead.since) < 0)) {"))
        // The drawer and sidebar count it, and order by its wait.
        XCTAssertTrue(web.contains("+ (waitingDoneRequest(project) ? 1 : 0);"), "the sidebar no longer counts it")
        XCTAssertTrue(web.contains("waitingDoneRequest(project)?.waitingSince,"), "the sidebar no longer orders by it")
    }

    /// A done project's row on the index says who recorded it — the owner with the gaps accepted,
    /// or Orbit — in `doneProvenance`'s words, where the web's row says it.
    func testADoneProjectsRowSaysWhoRecordedIt() throws {
        let page = try String(contentsOf: try repoRoot().appendingPathComponent("src/web/src/pages/ProjectsPage.tsx"),
                              encoding: .utf8)
        XCTAssertTrue(page.contains("{p.status === 'DONE' ? (\n                        <span className=\"project-row-done-provenance\">{doneProvenance(p)}</span>"),
                      "the web's projects list no longer says who recorded a done project")
        let words = try String(contentsOf: try repoRoot().appendingPathComponent("src/web/src/lib/projectDone.ts"),
                               encoding: .utf8)
        XCTAssertTrue(words.contains("return `${PROJECT_DONE_COPY.recordedByYou} · ${n} ${PROJECT_DONE_COPY.gapsAccepted}`;"))
        XCTAssertTrue(words.contains("return PROJECT_DONE_COPY.recordedByOrbit;"))
        let gaps = [AcceptedGap(criterionKey: "a"), AcceptedGap(criterionKey: "b")]
        XCTAssertEqual(ProjectSummary(id: "p", title: "t", status: .done, doneBy: .owner, acceptedGaps: gaps).doneProvenance,
                       "recorded by you · 2 gaps accepted")
        XCTAssertEqual(ProjectSummary(id: "p", title: "t", status: .done, doneBy: .derived).doneProvenance,
                       "recorded by Orbit")
        XCTAssertNil(ProjectSummary(id: "p", title: "t", status: .open, doneBy: .owner).doneProvenance,
                     "an open project's row says nothing of who recorded it")
    }

    func testCoordinatorAndBlockerWordsAreTheWebsOwn() throws {
        let web = try web()
        let phrases: [(String, String)] = [
            ("INTEGRATION_CONFLICT", "resolving a merge conflict"),
            ("INTEGRATION_CHECK_FAILED", "checks failed"),
            ("INTEGRATION_ERROR", "handling an integration error"),
            ("TASK_FAILED", "handling a failed task"),
        ]
        for (kind, phrase) in phrases {
            XCTAssertTrue(web.contains("\(kind): '\(phrase)',"), "coordinator phrase for \(kind) drifted")
        }
        for literal in ["'Coordinator'", "'Needs you'", "'Auto-remediation'", "'Coordinator-owned'",
                        "CRITICAL: 'Critical'", "WARNING: 'Warning'", "INFO: 'Info'",
                        "tasks settled · project still open`", "`Running · no activity ${days}d`",
                        "`Ready · no activity ${days}d`"] {
            XCTAssertTrue(web.contains(literal), "the web no longer says \(literal)")
        }
    }
}
