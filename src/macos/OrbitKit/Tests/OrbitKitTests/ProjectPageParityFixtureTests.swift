import Foundation
import XCTest
@testable import OrbitKit

/// The iOS project page held to web's mobile page and to the shared fixtures every client reads
/// (project "Project page and coordinator cards: iOS/web/Android parity", D2 A, D3 A, G1/G2, G4/G5):
///
/// - the section order, read back out of web's `ProjectsPage.tsx`, with Open items second;
/// - the Open items header's detail and its Needs you rows, for a project with none open and with two;
/// - How it runs' one-line summary, as web's `project-run-settings-summary` writes it;
/// - `src/shared/src/project-page-labels.fixture.json`: the landing half-sentence and the task rows'
///   stalled and start-by-hand labels (web: `ProjectPageLabels.fixture.test.tsx`);
/// - `contracts/unmet-criteria-counts.fixtures.json`: the Done tallies and the Record as done
///   confirmation counting unmet criteria apart (web: `projectDone.unmetCounts.test.tsx`).
///
/// A missing web source or fixture is a FAILURE, never a skip.
final class ProjectPageParityFixtureTests: XCTestCase {

    private struct Missing: Error, CustomStringConvertible {
        let file: String
        var description: String { "\(file) was not found above this test file." }
    }

    private func repoFile(_ relative: String) throws -> Data {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) { return try Data(contentsOf: candidate) }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(file: relative)
    }

    private func json(_ relative: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: try repoFile(relative)) as? [String: Any])
    }

    private func decode<T: Decodable>(_ type: T.Type, _ object: Any) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed]))
    }

    // MARK: - section order (D3 A)

    /// Web's mobile page blocks, top to bottom, and the iOS row each is. Web draws three blocks the
    /// iOS page carries elsewhere: the promotion card and the coordinator's questions are answered in
    /// the coordinator conversation, and the chain strip is part of the task graph's own section.
    private static let webBlockToRow: [String: ProjectPageListRow?] = [
        // The title area's integration line is part of the iOS header row.
        "integration-line": nil,
        "open-items": .openItems,
        "promotion": nil,
        "coordinator-questions": nil,
        "overview": .overview,
        "coordinator": .coordinator,
        "run-settings": .runSettings,
        "goal": .goal,
        "task-graph": .graph,
        "chain-progress": nil,
        "blockers": .blockers,
        "run-queue": .runQueue,
        "acceptance-criteria": .criteria,
        "instructions": .instructions,
        "tasks": .tasks,
        "crossings": .crossings,
    ]

    private func webMobileOrder() throws -> [ProjectPageListRow] {
        let page = String(decoding: try repoFile("src/web/src/pages/ProjectsPage.tsx"), as: UTF8.self)
        // The blocks, and the command centre's two halves (Work overview, then Coordinator), by where
        // each opens in the page's JSX.
        var marks: [(String.Index, String)] = []
        let block = try NSRegularExpression(pattern: #"<ProjectPageBlock name="([a-z-]+)">"#)
        for match in block.matches(in: page, range: NSRange(page.startIndex..., in: page)) {
            let range = try XCTUnwrap(Range(match.range, in: page))
            marks.append((range.lowerBound, String(page[try XCTUnwrap(Range(match.range(at: 1), in: page))])))
        }
        let overview = try XCTUnwrap(page.range(of: "<ProjectPanoramaHeader")?.lowerBound)
        let coordinator = try XCTUnwrap(page.range(of: "<ProjectCoordinatorSection")?.lowerBound)
        marks += [(overview, "overview"), (coordinator, "coordinator")]
        var rows: [ProjectPageListRow] = []
        for (_, name) in marks.sorted(by: { $0.0 < $1.0 }) {
            let row = try XCTUnwrap(Self.webBlockToRow[name], "web added a block \(name) this test does not map")
            if let row { rows.append(row) }
        }
        return rows
    }

    private func row(_ id: String, _ kind: ProjectOpenItemKind, assignee: ProjectOpenItemAssignee) -> ProjectOpenItemRow {
        ProjectOpenItemRow(itemId: id, kind: kind, title: "Item \(id)", waitingSince: "2026-11-19T10:00:00.000Z",
                           assignee: assignee)
    }

    private let counted = ProjectDerivedDone(criteria: [ProjectDoneCriterion(definitionId: "c1", satisfied: false)],
                                             counts: ProjectDoneCounts(criteria: 1, met: 0, landed: 0, onMain: 0))

    func testThePageOrderIsWebsMobileOrderWithOpenItemsSecond() throws {
        let web = try webMobileOrder()
        XCTAssertEqual(web.first, .openItems, "web's mobile page leads with Open items under its title area")
        XCTAssertEqual(ProjectPageListLogic.rows, [.header] + web)
        XCTAssertEqual(ProjectPageListLogic.rows.firstIndex(of: .openItems), 1)
        XCTAssertEqual(ProjectPageListLogic.rows.firstIndex(of: .overview), 2)
    }

    func testOpenItemsIsDrawnForAStartedProjectWithNothingOpen() throws {
        let section = try XCTUnwrap(ProjectPage.openItemsSection(status: .open, started: true, derivedDone: counted,
                                                                 items: ProjectOpenItemsView()))
        XCTAssertEqual(section.hint, "0 need you · oldest first")
        XCTAssertTrue(section.drawsNeedsYou)
        XCTAssertEqual(section.done, .own, "its Needs you row is the owner's own Record as done…")
        XCTAssertEqual(ProjectDone.recordAsDoneRow, "Record as done…")
        XCTAssertEqual(ProjectDone.notAskedYet, "not asked yet")
        XCTAssertNil(section.start)
        XCTAssertTrue(section.needsYou.isEmpty)
        // The order does not depend on what is open: one row per block, the same for every project.
        XCTAssertEqual(ProjectPageListLogic.rows, [.header] + (try webMobileOrder()))
    }

    func testOpenItemsIsDrawnForAProjectWithTwoOpen() throws {
        let items = ProjectOpenItemsView(needsYou: [row("q", .coordinatorQuestion, assignee: .owner),
                                                    row("r", .taskFailed, assignee: .owner)],
                                         withCoordinator: [row("f", .taskFailed, assignee: .coordinator)])
        let section = try XCTUnwrap(ProjectPage.openItemsSection(status: .open, started: true, derivedDone: counted,
                                                                 items: items))
        // The coordinator's item is neither counted nor drawn, as web's page does since c85d2d7ab7.
        XCTAssertEqual(section.hint, "2 need you · oldest first")
        XCTAssertEqual(section.needsYou.map(\.itemId), ["q", "r"])
        XCTAssertEqual(section.done, .own)
        XCTAssertEqual(ProjectPageListLogic.rows, [.header] + (try webMobileOrder()))
        // The pause is a card, not counted, as web's is.
        let paused = ProjectOpenItemsView(needsYou: [row("p", .fusePaused, assignee: .owner)])
        XCTAssertEqual(ProjectPage.openItemsSection(status: .open, started: true, derivedDone: counted,
                                                    items: paused)?.hint,
                       "0 need you · oldest first")
    }

    func testOpenItemsDrawsNothingUntilItsReadIsInOrWhenAClosedProjectHasNothingOpen() {
        XCTAssertNil(ProjectPage.openItemsSection(status: .open, started: true, derivedDone: counted, items: nil))
        XCTAssertNil(ProjectPage.openItemsSection(status: .done, started: true, derivedDone: counted,
                                                  items: ProjectOpenItemsView()))
        // Only the coordinator's items open: nothing for the owner here, as web's returns null.
        XCTAssertNil(ProjectPage.openItemsSection(
            status: .done, started: true, derivedDone: counted,
            items: ProjectOpenItemsView(withCoordinator: [row("f", .taskFailed, assignee: .coordinator)])))
    }

    /// Web's header detail, read back from its source.
    func testTheHeaderDetailIsWebs() throws {
        let web = String(decoding: try repoFile("src/web/src/components/ProjectProgressStatus.tsx"), as: UTF8.self)
        XCTAssertTrue(web.contains(
            "{`${needsYou.length + signIns.length + (accountWait ? 1 : 0)} need you · oldest first`}"))
        XCTAssertFalse(web.contains("with the coordinator · oldest first"))
        XCTAssertEqual(ProjectPage.openItemsHint(needsYou: 0), "0 need you · oldest first")
        XCTAssertEqual(ProjectPage.openItemsHint(needsYou: 2), "2 need you · oldest first")
    }

    // MARK: - How it runs' summary

    private func view(_ line: IntegrationLine?, ref: String? = nil) -> ProjectIntegrationView {
        ProjectIntegrationView(line: line, ref: ref, upstreamRef: "main", repository: "acme/orbit")
    }

    func testTheRunSettingsSummaryReadsAsWebs() throws {
        let id = "34ycavCsYoARJ89WqS2F6"
        XCTAssertEqual(RunSettings.summary(view(.projectBranch, ref: "project/\(id)"), projectID: id,
                                           automatic: true, maxConcurrentTasks: 3, nonCode: false),
                       RunSettings.Summary(title: "Automatic On",
                                           line: "A project branch · project/34yca… · 3 tasks at a time"))
        // No ref yet: web names the branch the project will have.
        XCTAssertEqual(RunSettings.summary(view(.projectBranch), projectID: id, automatic: false,
                                           maxConcurrentTasks: 1, nonCode: false),
                       RunSettings.Summary(title: "Automatic Off",
                                           line: "A project branch · project/34yca… · 1 task at a time"))
        XCTAssertEqual(RunSettings.summary(ProjectIntegrationView(line: .main, upstreamRef: "master", repository: "acme/x"),
                                           projectID: id, automatic: true, maxConcurrentTasks: 2, nonCode: false).line,
                       "Directly into master · 2 tasks at a time")
        XCTAssertEqual(RunSettings.summary(view(.main), projectID: id, automatic: true, maxConcurrentTasks: 2,
                                           nonCode: true).line,
                       "Non-code · 2 tasks at a time")
        XCTAssertEqual(RunSettings.summary(view(nil), projectID: id, automatic: true, maxConcurrentTasks: 2,
                                           nonCode: false).line, "")
        XCTAssertEqual(RunSettings.summary(view(.main), projectID: id, automatic: true, maxConcurrentTasks: nil,
                                           nonCode: false).line, "Directly into main")
        // The template these are web's: Automatic + On/Off over the line, its branch and the count.
        let web = String(decoding: try repoFile("src/web/src/components/ProjectRunSettings.tsx"), as: UTF8.self)
        for piece in ["<div className=\"project-run-settings-summary\">",
                      "<strong>{RUN_AUTOMATIC} {draft.automatic ? RUN_SWITCH_ON : RUN_SWITCH_OFF}</strong>",
                      "? NON_CODE_BADGE", "? runLineMain(main)",
                      ": `${RUN_LINE_PROJECT_BRANCH} · ${shortBranch(branch)}`}",
                      "? ` · ${draft.maxConcurrentTasks} ${runTasksAtATime(draft.maxConcurrentTasks)}`"] {
            XCTAssertTrue(web.contains(piece), "web's summary no longer reads \(piece)")
        }
        // Built from the start receipt's parts: the line and the count are the same words.
        let parts = RunSettings.parts(ProjectStartSettings(line: .projectBranch, projectBranchName: "project/\(id)",
                                                           automatic: true, maxConcurrentTasks: 3))
        XCTAssertEqual(parts.first { $0.key == .line }?.text, "project/34yca…")
        XCTAssertEqual(parts.first { $0.key == .maxConcurrentTasks }?.text, "3 tasks at a time")
    }

    // MARK: - project-page-labels.fixture.json

    private func labels() throws -> [String: Any] { try json("src/shared/src/project-page-labels.fixture.json") }

    func testTheLandingHalfSentenceReadsTheLandingReason() throws {
        let landing = try XCTUnwrap(try labels()["landing"] as? [String: Any])
        let main = try XCTUnwrap(landing["main"] as? String)
        let cases = try XCTUnwrap(landing["cases"] as? [[String: Any]])
        XCTAssertEqual(cases.count, 8)
        for (index, c) in cases.enumerated() {
            let name = c["name"] as? String ?? "\(index)"
            var item = try XCTUnwrap(c["criterion"] as? [String: Any])
            let expected = c["expected"] as? String
            // As the server serves it: the item without its reason, the reason on the done read.
            let reason = item.removeValue(forKey: "landingReason")
            item["id"] = "c\(index)"
            item["ordinal"] = index + 1
            item["text"] = "Criterion \(name)"
            let document: [String: Any] = [
                "id": "p", "title": "Coordinator handoff v2", "status": "OPEN",
                "integration": ["ref": "project/p", "upstreamRef": main, "locked": false],
                "acceptanceCriteriaItems": [item],
                "derivedDone": ["criteria": [["definitionId": "c\(index)", "satisfied": item["satisfied"] ?? false,
                                              "landing": item["landing"] ?? "UNKNOWN",
                                              "landingReason": reason ?? NSNull()]]],
            ]
            let criterion = try XCTUnwrap(try decode(ProjectDocument.self, document).acceptanceCriteriaItems.first)
            XCTAssertTrue(criterion.landingReasonRead, name)
            let work = try XCTUnwrap(ProjectPage.criterionWork(criterion, integrationRef: "project/p", main: main))
            XCTAssertEqual(work.landing, expected, name)
            XCTAssertNil(work.landingWarning, name)
            XCTAssertEqual(ProjectPage.criterionLandingHalfSentence(satisfied: criterion.satisfied,
                                                                    landingReason: criterion.landingReason, main: main),
                           expected, name)
        }
        // The criterion model decodes the field itself, too.
        let own = try decode(ProjectCriterion.self, ["id": "c", "satisfied": true, "landing": "UNKNOWN",
                                                     "landingReason": "IN_FLIGHT"])
        XCTAssertEqual(own.landingReason, .inFlight)
        XCTAssertEqual(ProjectPage.criterionWork(own, integrationRef: nil)?.landing, "In flight")
        // No reason read (an older server): the row keeps the landing lane's words.
        let old = try decode(ProjectCriterion.self, ["id": "c", "satisfied": true, "landing": "UNKNOWN"])
        XCTAssertFalse(old.landingReasonRead)
        XCTAssertEqual(ProjectPage.criterionWork(old, integrationRef: nil)?.landing, "no merge receipt either way")
    }

    func testTheTaskRowsSayStalledAndStartByHand() throws {
        let rows = try XCTUnwrap(try labels()["taskRows"] as? [String: Any])
        let cases = try XCTUnwrap(rows["cases"] as? [[String: Any]])
        XCTAssertEqual(cases.count, 5)
        for (index, c) in cases.enumerated() {
            let name = c["name"] as? String ?? "\(index)"
            var task = try XCTUnwrap(c["task"] as? [String: Any])
            task["id"] = "task-\(index)"
            task["title"] = "Task case \(index)"
            let row = try decode(ProjectTaskRow.self, task)
            XCTAssertEqual(ProjectPage.workTag(row)?.text, c["taskRow"] as? String, name)
            // The row's band does not swallow it: only a tag its heading already says goes.
            XCTAssertEqual(ProjectPage.rowTags(row, heading: "Tasks", ref: nil, upstreamRef: nil).first?.text,
                           c["taskRow"] as? String, name)
            if var queue = c["runQueue"] as? [String: Any] {
                queue["taskId"] = "task-\(index)"
                queue["title"] = "Task case \(index)"
                let item = try decode(ProjectReadyToRun.Item.self, queue)
                XCTAssertEqual(ProjectPage.queueRowState(item), c["runQueueRow"] as? String, name)
            }
        }
        // A server that sends no reason keeps the words the run queue always drew.
        XCTAssertEqual(ProjectPage.queueRowState(ProjectReadyToRun.Item(taskId: "t", title: "t", runState: .running)),
                       "Work in progress")
        // An older server sends no autoRunWhenReady: that is no claim either way.
        XCTAssertEqual(ProjectPage.workTag(ProjectTaskRow(id: "t", title: "t", workState: "BLOCKED"))?.text, "Blocked")
        // Web's words for the same two labels.
        let graph = String(decoding: try repoFile("src/web/src/lib/projectDependencyGraph.ts"), as: UTF8.self)
        XCTAssertTrue(graph.contains("export const RUN_STALLED = '\(ProjectPage.runStalled)';"))
        let start = String(decoding: try repoFile("src/web/src/lib/projectStart.ts"), as: UTF8.self)
        XCTAssertTrue(start.contains("export const PROJECT_TASK_STARTS_BY_HAND = '\(ProjectPage.startsByHand)';"))
    }

    // MARK: - unmet-criteria-counts.fixtures.json (G1/G2)

    func testTheDoneTalliesAndTheRecordAsDoneConfirmationCountUnmetCriteriaApart() throws {
        let fixture = try json("contracts/unmet-criteria-counts.fixtures.json")
        let project = try XCTUnwrap(fixture["project"] as? [String: Any])
        let main = try XCTUnwrap(project["main"] as? String)
        let expect = try XCTUnwrap(fixture["expect"] as? [String: Any])
        let text = try XCTUnwrap(expect["text"] as? [String: String])
        let criteria = try XCTUnwrap(fixture["criteria"] as? [[String: Any]])
        let derived: [String: Any] = [
            "status": "OPEN", "done": expect["done"] ?? false, "withheld": expect["withheld"] ?? [],
            "confirmation": project["confirmation"] ?? "CONFIRMED", "nonCode": false,
            "counts": expect["counts"] ?? [:],
            "criteria": criteria.map { c in
                ["definitionId": "c\(c["ordinal"] ?? 0)", "satisfied": c["satisfied"] ?? false,
                 "landing": c["landing"] ?? "UNKNOWN", "landingReason": c["landingReason"] ?? NSNull()]
            },
        ]
        let derivedDone = try decode(ProjectDerivedDone.self, derived)
        let counts = try XCTUnwrap(derivedDone.counts)
        XCTAssertEqual(ProjectDone.tally(counts, main: main), text["doneTally"])
        XCTAssertEqual(ProjectDone.cardTally(counts, main: main), text["doneCardTally"])
        XCTAssertEqual(ProjectDone.whyNotDoneTally(derivedDone, main: main), text["whyNotDoneTally"])
        let running = ProjectDone.criteriaInFlightCount(derivedDone)
        XCTAssertEqual(running, expect["running"] as? Int)
        XCTAssertEqual(ProjectDone.orbitCheckedLine(counts: counts, confirmedAt: nil, openItems: 0, running: running),
                       text["orbitChecked"])
        XCTAssertTrue(try XCTUnwrap(text["doneCardTally"]).contains("\(expect["notMet"] ?? 0) not met"))
        // An unmet criterion landing right now is still running, though byReason leaves it out.
        var withUnmetInFlight = derived
        withUnmetInFlight["criteria"] = (derived["criteria"] as? [[String: Any]] ?? [])
            + [["definitionId": "c6", "satisfied": false, "landing": "UNKNOWN", "landingReason": "IN_FLIGHT"]]
        XCTAssertEqual(ProjectDone.criteriaInFlightCount(try decode(ProjectDerivedDone.self, withUnmetInFlight)),
                       running + 1)
        // A criterion waiting for a confirmation is counted by its own part, never twice.
        XCTAssertEqual(ProjectDone.cardTally(counts, main: main, waitingConfirmation: 1),
                       "1 met · 0 landed on main · 3 not met · 1 wait for confirmation")

        // The page's Record as done confirmation says the Done tally, never "with no merge receipt".
        let document: [String: Any] = [
            "id": "p-handoff-v2", "title": project["title"] ?? "", "status": "OPEN",
            "integration": ["upstreamRef": main, "locked": false],
            "acceptanceCriteriaItems": criteria.map { c in
                ["id": "c\(c["ordinal"] ?? 0)", "ordinal": c["ordinal"] ?? 0, "text": "Criterion \(c["ordinal"] ?? 0)",
                 "satisfied": c["satisfied"] ?? false, "landing": c["landing"] ?? "UNKNOWN"]
            },
            "derivedDone": derived,
        ]
        let confirmation = ProjectDone.recordAsDoneTally(try decode(ProjectDocument.self, document))
        XCTAssertEqual(confirmation, text["doneTally"])
        for line in Array(text.values) + [confirmation] {
            XCTAssertNil(line.range(of: "merged outside Orbit|ran without a branch|no code to land|nothing to land|no merge receipt",
                                    options: [.regularExpression, .caseInsensitive]), line)
        }
    }
}
