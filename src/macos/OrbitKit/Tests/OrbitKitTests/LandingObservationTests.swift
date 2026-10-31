import Foundation
import XCTest
@testable import OrbitKit

/// CONTRACT REVISION 29 ON THIS CLIENT (R29-11) — the view models under what R29-10 drew on the web:
///
///  - Delivery (§10.5 O-L1/O-L2): the start card and How it runs offer "Orbit lands it" / "The agent
///    pushes it", the agent's way only on a main line, and under it no merge into main asks anybody.
///  - The two items (§10.7/§10.8): `LANDING_UNOBSERVED` and `LANDED_WITHOUT_CONFIRMATION`, their
///    doors `Accept` and `Observe again`, and the handling line while an observation is in flight.
///  - The task row (§10.9): `Waiting to be seen on <branch> · <sha7>`, in Pending landing.
///  - The fifth owner item (owner 2026-10-28, §7.6 V12/V13): counted, named and pushed like the four.
///  - The owner confirmation card's `AGENT_PUSHED` landing.
///
/// Every word is held to the browser's own source, which R29-10 settled for the clients to copy
/// verbatim; a missing counterpart is a FAILURE, never an `XCTSkip`. The fixtures are the web test's
/// own (`ProjectProgressStatus.landingObservation.test.tsx`), so both ends are asked the same thing.
final class LandingObservationTests: XCTestCase {

    // MARK: the web's own words

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo(String)
        var description: String {
            switch self {
            case .noRepo(let path):
                return "\(path) was not found above this test file. This client is one half of a "
                    + "pair; if the web half moved, move this check with it rather than deleting it."
            }
        }
    }

    private func repoRoot(_ anchor: String) throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(anchor).path) { return dir }
            dir = dir.deletingLastPathComponent()
        }
        throw ParityError.noRepo(anchor)
    }

    /// A web source with its wrapped string literals put back together: where a long sentence breaks
    /// across lines is a formatting decision, while the words are the contract.
    private func web(_ relative: String) throws -> String {
        try String(contentsOf: try repoRoot(relative).appendingPathComponent(relative), encoding: .utf8)
            .replacingOccurrences(of: "['\"`]\\s*\\+\\s*['\"`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "=\\s*\\n\\s*(['\"`])", with: "= $1", options: .regularExpression)
    }

    private func assertSays(_ source: String, _ needle: String, _ what: String,
                            file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(source.contains(needle),
                      "\(what): the web no longer says \(needle.debugDescription)", file: file, line: line)
    }

    private static let projectStart = "src/web/src/lib/projectStart.ts"
    private static let runSettings = "src/web/src/components/ProjectRunSettings.tsx"
    private static let progressStatus = "src/web/src/components/ProjectProgressStatus.tsx"
    private static let projectsPage = "src/web/src/pages/ProjectsPage.tsx"
    private static let confirmationCard = "src/web/src/components/OwnerConfirmationCard.tsx"
    private static let workspaceView = "src/web/src/components/WorkspaceView.tsx"
    private static let projectAttention = "src/web/src/lib/projectAttention.ts"
    private static let sessionProjects = "src/web/src/lib/sessionProjects.ts"
    private static let shared = "src/shared/src/project-progress.ts"

    /// The browser's `${main}`, put where this end says the project's main branch.
    private static let main = "${main}"

    // MARK: fixtures (the web test's)

    private let now = RelativeTime.parse("2026-10-29T03:00:00.000Z")!

    private func row(_ json: String) throws -> ProjectOpenItemRow {
        try JSONDecoder().decode(ProjectOpenItemRow.self, from: Data(json.utf8))
    }

    /// A finished task of an AGENT_PUSH project whose commit the observation did not find on main.
    private func unobserved(assignee: String = "COORDINATOR", reason: String = "DEFAULT",
                            escalatedAt: String = "null",
                            actions: String = #"["OPEN_COORDINATOR","OPEN_TASK_SESSION","OBSERVE","CANCEL_TASK"]"#,
                            primary: String = "OPEN_TASK_SESSION", handling: String = "null") throws -> ProjectOpenItemRow {
        try row("""
        {"itemId":"4pLUnobserved00000001","kind":"LANDING_UNOBSERVED",
         "title":"Not on main yet: Ship the delivery mode picker",
         "detailLine":"Its commit was not found on the line · delivered 9f1c2ab7e4d0",
         "assignee":"\(assignee)","assigneeReason":"\(reason)",
         "waitingSince":"2026-10-29T02:35:00.000Z","escalateAt":null,"escalatedAt":\(escalatedAt),
         "taskId":"34npDeliveryPicker001","sessionId":"1TtDeliveryPickerRun1",
         "promotionId":null,"fuseEpisodeId":null,
         "delivery":{"state":"DELIVERED","sessionId":"34nkUBJx4xYwNbGqVojH7","at":"2026-10-29T02:36:00.000Z"},
         "actions":\(actions),
         "requiredAction":"This task’s work is not on main yet — record the commit that carries it, or send the task back to push it.",
         "primaryAction":"\(primary)","question":null,"facts":null,"handling":\(handling),"outcome":null}
        """)
    }

    /// The same item, handed to the owner by the coordinator: the owner's projection of the cell.
    private func handedOver(handling: String = "null") throws -> ProjectOpenItemRow {
        try unobserved(assignee: "OWNER", reason: "HANDED_OVER", escalatedAt: #""2026-10-29T02:55:00.000Z""#,
                       actions: #"["ASK_COORDINATOR_AGAIN","OPEN_TASK_SESSION","OBSERVE","CANCEL_TASK"]"#,
                       primary: "ASK_COORDINATOR_AGAIN", handling: handling)
    }

    /// The owner pressed Observe again, and the observation it queued has not run yet (§10.8, H1).
    private func handling(kind: String = "OBSERVE_LANDING", state: String = "QUEUED",
                          generation: Int = 3) -> String {
        #"{"sessionId":null,"userId":"2p7QMFOwEGtL5oaTxZHihm","reason":"I pushed the rebased commit to main by hand","startedAt":"2026-10-29T02:56:00.000Z","jobId":"4pObserveJob000000001","jobKind":"\#(kind)","generation":\#(generation),"state":"\#(state)"}"#
    }

    /// An observation's work, found on main without the owner's confirmation (§10.6 O-R3).
    private func landed(backfill: Bool = false) throws -> ProjectOpenItemRow {
        try row("""
        {"itemId":"\(backfill ? "4pULandedBackfill0001" : "4pULanded000000000001")",
         "kind":"LANDED_WITHOUT_CONFIRMATION",
         "title":"\(backfill ? "Reached main without your confirmation: 5 tasks"
                             : "Reached main without your confirmation: Fix the login redirect")",
         "detailLine":"\(backfill ? "On main: Fix the login redirect, Retry the export, Trim the logs and 2 more · seen by Orbit"
                                  : "7d3e9b01c2a4 is on main · seen by Orbit")",
         "assignee":"OWNER","assigneeReason":"DEFAULT",
         "waitingSince":"2026-10-29T01:00:00.000Z","escalateAt":null,"escalatedAt":null,
         "taskId":\(backfill ? "null" : #""34npLoginRedirect0001""#),
         "sessionId":\(backfill ? "null" : #""1TtLoginRedirectRun01""#),
         "promotionId":null,"fuseEpisodeId":null,
         "delivery":{"state":"NOT_REQUIRED","sessionId":"34nkUBJx4xYwNbGqVojH7","at":null},
         "actions":\(backfill ? #"["ACCEPT"]"# : #"["ACCEPT","OPEN_TASK_SESSION"]"#),
         "requiredAction":"This work reached main without your confirmation — accept it, or use Chat about this to have the coordinator file a task that reverts it.",
         "primaryAction":"ACCEPT","question":null,"facts":null,"handling":null,"outcome":null}
        """)
    }

    /// A project's observations failing three times running (§10.6 O-J4): about the line, no task.
    private func observeFailing() throws -> ProjectOpenItemRow {
        try row("""
        {"itemId":"4pIEObserve0000000001","kind":"INTEGRATION_ERROR","title":"Integration error: observing main",
         "detailLine":"","assignee":"OWNER","assigneeReason":"NO_COORDINATOR",
         "waitingSince":"2026-10-29T02:35:00.000Z","escalateAt":null,"escalatedAt":null,
         "taskId":null,"sessionId":null,"promotionId":null,"fuseEpisodeId":null,
         "delivery":{"state":"NOT_REQUIRED","sessionId":null,"at":null},
         "actions":["OBSERVE"],"primaryAction":"OBSERVE",
         "requiredAction":"Finished work is not recorded as landed until an observation of main succeeds — let a runner reach the repository, then look again.",
         "question":null,"facts":null}
        """)
    }

    private func doors(_ row: ProjectOpenItemRow) -> [[String]] {
        ExceptionCards.presses(row).map { [$0.label, $0.tier.rawValue, $0.consequence] }
    }

    // MARK: - the two items (§10.7) and their doors (§10.8)

    /// The new kinds and doors decode as themselves — `ACCEPT` and `OBSERVE` were `.unknown` here
    /// before, which `drawn` leaves undrawn — and so does the handling an observation is.
    func testTheTwoKindsTheirDoorsAndTheObservationDecode() throws {
        let landed = try landed()
        XCTAssertEqual(landed.kind, .landedWithoutConfirmation)
        XCTAssertEqual(landed.actions, [.accept, .openTaskSession])
        XCTAssertEqual(landed.primaryAction, .accept)

        let observing = try handedOver(handling: handling())
        XCTAssertEqual(observing.kind, .landingUnobserved)
        XCTAssertEqual(observing.actions, [.askCoordinatorAgain, .openTaskSession, .observe, .cancelTask])
        XCTAssertEqual(observing.handling, OpenItemHandling(reason: "I pushed the rebased commit to main by hand",
                                                            startedAt: "2026-10-29T02:56:00.000Z",
                                                            jobKind: "OBSERVE_LANDING", generation: 3,
                                                            state: "QUEUED"))
        // A handling this build cannot read costs that row and never the read that carried it.
        XCTAssertNil(try unobserved(handling: #"{"jobKind":7}"#).handling)
        XCTAssertNil(try observeFailing().handling, "absent is none")
    }

    /// LANDED_WITHOUT_CONFIRMATION is the owner's from birth: its own title heads it, the receipt is
    /// its line, Accept leads and Open task session follows — and there is no hand-close, because
    /// Accept is what it asks for (`open_item_resolve` refuses it).
    func testWorkThatLandedWithoutTheOwnerIsAcceptedOnItsOwnCard() throws {
        let landed = try landed()
        XCTAssertNil(ExceptionCards.heading(landed, now: now), "never escalated, so no escalation heading")
        XCTAssertEqual(ExceptionCards.headingLine(landed, now: now),
                       "Reached main without your confirmation: Fix the login redirect")
        XCTAssertNil(ExceptionCards.subject(landed, now: now), "the title is said once")
        XCTAssertEqual(ExceptionCards.facts(landed), .detailLine("7d3e9b01c2a4 is on main · seen by Orbit"))
        XCTAssertEqual(ExceptionCards.requiredAction(landed), landed.requiredAction)
        XCTAssertEqual(doors(landed), [
            ["Accept", "primary", "You accept the work as it landed, and this item closes."],
            ["Open task session", "secondary", "Open the task session to repair the branch."],
        ])
        XCTAssertFalse(ExceptionCards.markable(landed), "no Mark as handled on it")
        XCTAssertEqual(ExceptionCards.ownerLine(landed, now: now), "Owner: you · waiting 2h")
        // Its header is its own kind word — the banner's — and not "Escalated to you".
        XCTAssertEqual(ExceptionCards.title(landed.kind, isPause: false), "Landed without your confirmation")
        XCTAssertEqual(ExceptionCards.landedTitle, NeedsYouLogic.kindWord(.landedWithoutConfirmation))
        XCTAssertEqual(ExceptionCards.title(.landingUnobserved, isPause: false), ExceptionCards.escalatedTitle)
        XCTAssertEqual(ExceptionCards.title(nil, isPause: false), ExceptionCards.escalatedTitle,
                       "a card not read yet is drawn as the escalation it always was")
        XCTAssertEqual(ExceptionCards.title(.landedWithoutConfirmation, isPause: true), ExceptionCards.pauseTitle)

        // The deploy-time pass's one item per project names no task: Accept alone.
        let backfill = try self.landed(backfill: true)
        XCTAssertEqual(ExceptionCards.headingLine(backfill, now: now), "Reached main without your confirmation: 5 tasks")
        XCTAssertEqual(doors(backfill).map { [$0[0], $0[1]] }, [["Accept", "primary"]])

        // It is in the owner's group, so the conversation draws a card for it.
        let items = ProjectOpenItemsView(needsYou: [landed, backfill])
        XCTAssertEqual(ExceptionCards.cards(items).map(\.itemId), [landed.itemId, backfill.itemId])
    }

    /// LANDING_UNOBSERVED handed to the owner keeps its title as its first line under the heading
    /// that says how it became theirs, then the server's line about what was seen; its doors are the
    /// server's, Observe again among them, the hand-back leading.
    func testWorkNotSeenOnTheLineKeepsItsTitleUnderTheHandOver() throws {
        let row = try handedOver()
        XCTAssertEqual(ExceptionCards.headingLine(row, now: now), "Now yours — the coordinator handed it over")
        XCTAssertEqual(ExceptionCards.subject(row, now: now), "Not on main yet: Ship the delivery mode picker")
        XCTAssertEqual(ExceptionCards.facts(row),
                       .detailLine("Its commit was not found on the line · delivered 9f1c2ab7e4d0"))
        XCTAssertEqual(doors(row).map { [$0[0], $0[1]] }, [
            ["Ask the coordinator again", "primary"],
            ["Open task session", "secondary"],
            ["Observe again", "link"],
            ["Cancel task", "link"],
        ])
        XCTAssertEqual(ExceptionCards.actionConsequence(row, .observe),
                       "An observation of the line is queued with your reason.")
        XCTAssertFalse(ExceptionCards.markable(row), "it ends with a fact about the task, never by hand")
        XCTAssertEqual(ExceptionCards.ownerLine(row, now: now),
                       "Owner: you · waiting 25m · came to the owner at 20m")
        XCTAssertEqual(ExceptionCards.cards(ProjectOpenItemsView(needsYou: [row])).map(\.itemId), [row.itemId])

        // The item a project's failing observations open: Observe again is its one, leading door.
        XCTAssertEqual(doors(try observeFailing()), [
            ["Observe again", "primary", "An observation of the line is queued with your reason."],
        ])
    }

    /// While an observation is in flight the card says so in its own words — never as the rerun of a
    /// landing, and never with a generation, which for an observation is only the project's count of
    /// looks — with the reason it was asked for under it.
    func testAnObservationInFlightIsSaidInItsOwnWords() throws {
        let queued = try handedOver(handling: handling())
        XCTAssertEqual(ExceptionCards.handlingLine(queued, queued.handling!, now: now),
                       "Observing main… — queued · asked 4m ago")
        XCTAssertEqual(ExceptionCards.handlingRows(queued, now: now).map { [$0.label, $0.value] }, [
            ["Handling", "Observing main… — queued · asked 4m ago"],
            ["Reason", "I pushed the rebased commit to main by hand"],
        ])
        let running = try handedOver(handling: handling(state: "RUNNING"))
        XCTAssertEqual(ExceptionCards.handlingLine(running, running.handling!, now: now),
                       "Observing main… — running · asked 4m ago")
        XCTAssertEqual(ExceptionCards.handlingLine(running, running.handling!, now: now, main: "feature/v1.1.1"),
                       "Observing feature/v1.1.1… — running · asked 4m ago", "the project's main branch by name")
        XCTAssertEqual(ExceptionCards.observingLine("feature/v1.1.1"), "Observing feature/v1.1.1…")
        let said = ExceptionCards.handlingRows(running, now: now).map(\.value).joined(separator: "\n")
        XCTAssertFalse(said.contains("the rerun of the landing"))
        XCTAssertFalse(said.contains("generation 3"))

        // A rerun is still said as one: a task's landing, or a candidate's check of the merge into main.
        let rerun = try handedOver(handling: handling(kind: "LAND_TASK"))
        XCTAssertEqual(ExceptionCards.handlingLine(rerun, rerun.handling!, now: now),
                       "the rerun of the landing — generation 3 is queued · asked 4m ago")
        let recheck = try handedOver(handling: handling(kind: "CHECK_PROMOTION", state: "RUNNING", generation: 2))
        XCTAssertEqual(ExceptionCards.handlingLine(recheck, recheck.handling!, now: now, main: "master"),
                       "the re-check of the merge into master — generation 2 is running · asked 4m ago")
        // Nobody handling it: no rows at all.
        XCTAssertEqual(ExceptionCards.handlingRows(try handedOver(), now: now), [])
    }

    /// Observe again asks for the reason the door requires: trimmed, and a blank one is no press.
    /// Accept takes nothing. Both doors are the row's own to reach: the item, and its project.
    func testObserveAgainSendsTheTrimmedReasonAndAcceptNothing() throws {
        XCTAssertEqual(ExceptionCards.observeRequest("  I pushed the rebased commit to main by hand  "),
                       IntegrationObserveRequest(reason: "I pushed the rebased commit to main by hand"))
        XCTAssertNil(ExceptionCards.observeRequest(""))
        XCTAssertNil(ExceptionCards.observeRequest("   \n "))
        XCTAssertEqual(ExceptionCards.observeMaxLength, 2_000, "the door's own ceiling")
        let body = try JSONEncoder().encode(IntegrationObserveRequest(reason: "look again"))
        XCTAssertEqual(String(decoding: body, as: UTF8.self), #"{"reason":"look again"}"#)

        let backfill = try landed(backfill: true)
        XCTAssertTrue(ExceptionCards.addressed(backfill, .accept), "Accept answers the item itself")
        XCTAssertTrue(ExceptionCards.addressed(try observeFailing(), .observe),
                      "Observe again is the project's door, which needs nothing from the row")
    }

    /// Chat about this on work that landed without the owner tells the coordinator what it is — not
    /// that nobody acted on it, which is what an escalation says.
    func testChatAboutWorkThatLandedSaysWhatItIs() throws {
        let context = ExceptionCards.chatContext(projectTitle: "Payments", row: try landed(), isPause: false, now: now)
        XCTAssertTrue(context.hasPrefix("About the work in “Payments” that reached main without the owner's "
                                            + "confirmation — waiting on the owner for 2h:"), context)
        XCTAssertFalse(context.contains("no one acted on it"))
        XCTAssertTrue(context.contains("Reached main without your confirmation: Fix the login redirect"))
        XCTAssertTrue(context.contains("4pULanded000000000001"), "the address the coordinator acts on")
    }

    /// The project page's Open items row: the item is the fifth owner kind when the row is, an
    /// escalation when it is the work not seen; the row is a way in, and Accept is the card's.
    func testTheProjectPageRowLandsOnTheCard() throws {
        let landed = try landed()
        XCTAssertEqual(ProjectPage.ownerItemKind(landed), .landedWithoutConfirmation)
        XCTAssertEqual(ProjectPage.ownerItemKind(try handedOver()), .escalated)
        XCTAssertEqual(ProjectPage.primaryAction(landed), .openTaskSession)
        XCTAssertNil(ProjectPage.actionLabel(.accept))
        XCTAssertNil(ProjectPage.actionLabel(.observe))
        // The delivery card has no word for either kind on the web either: its header names them.
        XCTAssertEqual(OpenItemDeliveryCard.kindLabel(.landingUnobserved), OpenItemDeliveryCard.header)
        XCTAssertEqual(OpenItemDeliveryCard.kindLabel(.landedWithoutConfirmation), OpenItemDeliveryCard.header)
    }

    /// Every word the cards say, as the browser declares it.
    func testTheCardsWordsAreTheBrowsers() throws {
        let web = try web(Self.progressStatus)
        assertSays(web, "ACCEPT: '\(ExceptionCards.accept)',", "Accept's label")
        assertSays(web, "OBSERVE: '\(ExceptionCards.observeAgain)',", "Observe again's label")
        assertSays(web, "ACCEPT: '\(ExceptionCards.actionConsequences[.accept]!)',", "Accept's consequence")
        assertSays(web, "OBSERVE: '\(ExceptionCards.actionConsequences[.observe]!)',", "Observe again's consequence")
        assertSays(web, "export const OBSERVE_MODAL_TITLE = '\(ExceptionCards.observeTitle)';", "the question")
        assertSays(web, "export const OBSERVE_MODAL_BODY = '\(ExceptionCards.observeBody)';", "what it does")
        assertSays(web, "export const OBSERVE_REASON_LABEL = '\(ExceptionCards.observeReason)';", "the field")
        assertSays(web, "export const OBSERVE_FAILED = '\(ExceptionCards.notObserved)';", "its refusal")
        assertSays(web, "export const ACCEPT_FAILED = '\(ExceptionCards.notAccepted)';", "Accept's refusal")
        assertSays(web, "export const HANDLING_TAG = '\(ExceptionCards.handlingLabel)';", "the handling row")
        assertSays(web, "{reason ? <FactRow label=\"\(ExceptionCards.reasonLabel)\">{reason}</FactRow> : null}",
                   "the reason row")
        assertSays(web, "return `\(ExceptionCards.observingLine("${branch}"))`;", "the observation's line")
        assertSays(web, "if (handling.jobKind === 'OBSERVE_LANDING') {", "the observation's own words")
        assertSays(web, "return `${observingLine(main)} — ${handling.state === 'RUNNING' ? 'running' : 'queued'} · asked "
                       + "${ago(handling.startedAt, now)}`;", "the observation's whole line")
        assertSays(web, "const where = handling.state === 'RUNNING' ? 'is running' : 'is queued';", "a rerun's state")
        assertSays(web, "return `${rerunOf(row, handling.jobKind, main)} — generation ${handling.generation} ${where} "
                       + "· asked ${ago(handling.startedAt, now)}`;", "a rerun's line")
        assertSays(web, "return check ? `the re-check of the merge into ${main}` : 'the rerun of the landing';",
                   "which rerun")
        assertSays(web, "if (action === 'ASK_COORDINATOR_AGAIN' || action === 'ACCEPT' || action === 'OBSERVE') "
                       + "return row.itemId;", "the two doors need nothing from the row but the row")
        // An item the owner has from birth wears the owner's amber, as this client's card always does.
        assertSays(web, "tone={row.assignee === 'OWNER' ? 'owner' : 'coordinator'}", "the owner's amber")
    }

    // MARK: - the task row (§10.9)

    private func task(_ id: String, state: String, sha: String? = nil) -> ProjectTaskRow {
        ProjectTaskRow(id: id, title: id, status: "DONE", dependencyState: "READY", workState: "DONE",
                       integration: ProjectTaskIntegration(state: state, deliveredSha: sha))
    }

    /// An AGENT_PUSH task finished and not yet seen on its line waits in Pending landing, naming the
    /// commit it waits to see; once a receipt says it is there it reads On main, in Landed.
    func testATaskWaitingToBeSeenNamesItsCommitAndWaitsInPendingLanding() throws {
        let frozen = task("o1", state: "AWAITING_OBSERVATION", sha: "9f1c2ab7e4d0b5a6c3f8e1d2a7b4c9e0f1a2b3c4")
        let moving = task("o2", state: "AWAITING_OBSERVATION")
        let seen = task("o3", state: "ON_UPSTREAM")
        XCTAssertEqual(ProjectPage.integrationTag(frozen, ref: nil, upstreamRef: "main")?.text,
                       "Waiting to be seen on main · 9f1c2ab")
        XCTAssertEqual(ProjectPage.integrationTag(moving, ref: nil, upstreamRef: "main")?.text,
                       "Waiting to be seen on main", "the words alone while the identity is not frozen")
        XCTAssertEqual(ProjectPage.integrationTag(frozen, ref: nil, upstreamRef: "refs/heads/feature/v1.1.1")?.text,
                       "Waiting to be seen on feature/v1.1.1 · 9f1c2ab")
        XCTAssertEqual(ProjectPage.integrationTag(frozen, ref: nil, upstreamRef: nil)?.tone, .neutral)
        XCTAssertEqual(ProjectPage.integrationTag(seen, ref: nil, upstreamRef: "main")?.text, "On main")
        XCTAssertEqual(ProjectPage.waitingToBeSeenOn("feature/v1.1.1",
                                                     deliveredSha: "0123456789abcdef0123456789abcdef01234567"),
                       "Waiting to be seen on feature/v1.1.1 · 0123456")
        XCTAssertEqual(ProjectPage.waitingToBeSeenOn("main", deliveredSha: nil), "Waiting to be seen on main")
        // Not seen is not landed.
        XCTAssertEqual(ProjectPage.taskGroups([frozen, moving, seen]).map { [$0.key] + $0.tasks.map(\.id) },
                       [["integrating", "o1", "o2"], ["landed", "o3"]])
        XCTAssertEqual(ProjectPage.taskGroups([frozen]).first?.heading, "Pending landing")

        let decoded = try JSONDecoder().decode(ProjectTaskIntegration.self, from: Data("""
            {"state":"AWAITING_OBSERVATION","since":"2026-10-29T02:40:00Z","handler":null,"openItemId":null,
             "jobId":null,"checksRunningForMs":null,"deliveredSha":"9f1c2ab7e4d0","mainBranch":"main"}
            """.utf8))
        XCTAssertEqual(decoded.deliveredSha, "9f1c2ab7e4d0")

        let web = try web(Self.projectsPage)
        assertSays(web, "const words = `Waiting to be seen on ${branch}`;", "the row's words")
        assertSays(web, "return deliveredSha ? `${words} · ${deliveredSha.slice(0, 7)}` : words;", "and its commit")
        assertSays(web, "return { text: waitingToBeSeenOn(branches.upstreamRef ?? 'main', integration.deliveredSha), "
                       + "color: 'default' };", "on the project's main branch, in the plain tone")
        assertSays(web, "'QUEUED', 'RUNNING', 'CONFLICT', 'CHECK_FAILED', 'ERROR', 'AWAITING_OWNER', 'AWAITING_OBSERVATION',",
                   "in Pending landing")
    }

    // MARK: - Delivery (§10.5 O-L1/O-L2)

    private func settings(_ line: IntegrationLine) -> ProjectStartSettings {
        ProjectStartSettings(line: line, projectBranchName: nil, upstreamRef: "refs/heads/main", automatic: true,
                             maxConcurrentTasks: 2, mergeCheckCommand: nil)
    }

    private func standing(_ mode: DeliveryMode?, line: IntegrationLine? = .main,
                          locked: Bool = false) -> ProjectIntegrationView {
        ProjectIntegrationView(line: line, ref: line == .projectBranch ? "project/p1" : "main",
                               upstreamRef: "main", repository: "acme/payments", locked: locked,
                               deliveryMode: mode)
    }

    /// The start card offers the choice once the read says the server takes it: what the project
    /// chose when that is the agent's way on a line that stays main, Orbit's otherwise.
    func testTheStartCardOffersDeliveryOnlyWhereTheServerTakesIt() {
        XCTAssertNil(StartSettingsDraft(settings(.main), standing: standing(nil)).deliveryMode,
                     "an older server: no choice, and no row")
        XCTAssertNil(StartSettingsDraft(settings(.main)).deliveryMode, "a read that did not come back says nothing")
        XCTAssertEqual(StartSettingsDraft(settings(.main), standing: standing(.platform)).deliveryMode, .platform)
        XCTAssertEqual(StartSettingsDraft(settings(.main), standing: standing(.agentPush)).deliveryMode, .agentPush)
        XCTAssertEqual(StartSettingsDraft(settings(.projectBranch), standing: standing(.agentPush)).deliveryMode,
                       .platform, "a start that leaves the project on a project branch is Orbit's")
    }

    /// Under the agent's way the start card says no merge into main asks anybody — in its sentence
    /// and in what still comes to the owner — and a line moved off main takes it back to Orbit's.
    func testTheAgentsWayChangesWhatTheStartCardSays() {
        var draft = StartSettingsDraft(settings(.main), standing: standing(.platform))
        XCTAssertFalse(draft.agentPushes)
        XCTAssertEqual(draft.automaticSays, RunSettings.automaticSays(automatic: true, line: .main,
                                                                     hasMergeCheck: false, main: "main"))
        XCTAssertEqual(draft.deliveryHint,
                       "The agent doesn’t push to main: Orbit lands its branch once the work is accepted.")

        draft.deliveryMode = .agentPush
        XCTAssertTrue(draft.agentPushes)
        XCTAssertEqual(draft.automaticSays,
                       "The coordinator decides when each task is done. The agent pushes each task’s work to main itself.")
        draft.automatic = false
        XCTAssertEqual(draft.automaticSays,
                       "You decide when each task is done. The agent pushes each task’s work to main itself.")
        XCTAssertEqual(draft.deliveryHint, "The agent pushes to main itself, and Orbit checks the commits are there.")

        let merges = { (mode: DeliveryMode) in
            StartProject.comesToYou(automatic: true, line: .main, ownerConfirmed: [], evidenceJudged: 0,
                                    escalationSeconds: 7_200, main: "main", deliveryMode: mode).map(\.text)
        }
        XCTAssertTrue(merges(.platform).contains("Each merge into main"))
        XCTAssertFalse(merges(.agentPush).contains("Each merge into main"), "nobody is asked to merge it")
        XCTAssertEqual(merges(.agentPush), ["Any change to the criteria", "Problems it can’t resolve within 2 h"])

        // Off a main line the agent cannot push: the menu goes back to Orbit's, and the line under it
        // says why.
        draft.chooseLine(.projectBranch)
        XCTAssertEqual(draft.deliveryMode, .platform)
        XCTAssertFalse(draft.agentPushes)
        XCTAssertEqual(draft.deliveryHint, "The agent can push only on a project that lands directly into main. "
                       + "On a project branch, Orbit lands the work.")
        var older = StartSettingsDraft(settings(.main))
        older.chooseLine(.projectBranch)
        XCTAssertNil(older.deliveryMode, "a card that offered no choice records none")
    }

    /// The start sends the delivery only with a main line — the door refuses AGENT_PUSH anywhere else
    /// (409 `DELIVERY_MODE_NEEDS_MAIN_LINE`) — and a card that offered no choice sends none.
    func testTheStartSendsTheDeliveryOnlyWithAMainLine() throws {
        let request = ProjectStartRequest(settings: settings(.main), why: "", criteriaDigest: "sha256:abc")
        func body(_ draft: StartSettingsDraft) throws -> [String: Any] {
            let data = try JSONEncoder().encode(StartProject.body(request: request, draft: draft, requestId: nil))
            return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        var draft = StartSettingsDraft(settings(.main), standing: standing(.agentPush))
        XCTAssertEqual(try body(draft)["deliveryMode"] as? String, "AGENT_PUSH")
        draft.deliveryMode = .platform
        XCTAssertEqual(try body(draft)["deliveryMode"] as? String, "PLATFORM")
        draft.chooseLine(.projectBranch)
        XCTAssertNil(try body(draft)["deliveryMode"], "a project branch sends none")
        XCTAssertNil(try body(StartSettingsDraft(settings(.main)))["deliveryMode"], "no choice, none sent")
    }

    /// How it runs: the choice does not lock, the agent's way is drawn but not offered off main with
    /// the reason, and each write carries only what moved — a line leaving main takes the delivery
    /// back to Orbit's in the same write.
    func testHowItRunsOffersAndWritesTheDelivery() throws {
        XCTAssertFalse(RunSettings.deliveryShown(standing(nil)), "an older server draws no row")
        XCTAssertTrue(RunSettings.deliveryShown(standing(.platform)))

        let onMain = RunSettings.deliveryChoices(line: .main, main: "main")
        XCTAssertEqual(onMain.map { [$0.label, $0.hint] }, [
            ["Orbit lands it", "The agent doesn’t push to main: Orbit lands its branch once the work is accepted."],
            ["The agent pushes it", "The agent pushes to main itself, and Orbit checks the commits are there."],
        ])
        XCTAssertEqual(onMain.map(\.offered), [true, true])
        let offMain = RunSettings.deliveryChoices(line: .projectBranch, main: "main")
        XCTAssertEqual(offMain.map(\.offered), [true, false])
        XCTAssertEqual(offMain[1].hint, "The agent can push only on a project that lands directly into main. "
                       + "On a project branch, Orbit lands the work.")
        XCTAssertEqual(RunSettings.deliveryChoices(line: nil).map(\.offered), [true, false],
                       "a line nobody decided offers it no more than a project branch does")

        let pushing = standing(.agentPush, locked: true)
        XCTAssertEqual(RunSettings.delivery(of: pushing), .agentPush)
        XCTAssertEqual(RunSettings.delivery(of: standing(.agentPush, line: .projectBranch)), .platform)
        XCTAssertEqual(RunSettings.deliveryWrite(pushing, to: .platform), UpdateProjectIntegrationRequest(deliveryMode: .platform),
                       "it does not lock with the line")
        XCTAssertNil(RunSettings.deliveryWrite(pushing, to: .agentPush), "no move, no write")
        XCTAssertNil(RunSettings.deliveryWrite(standing(.platform, line: .projectBranch), to: .agentPush),
                     "the door would refuse it off main")
        XCTAssertNil(RunSettings.deliveryWrite(standing(nil), to: .agentPush), "only to a server that reads it")

        XCTAssertEqual(RunSettings.lineWrite(standing(.agentPush), to: .projectBranch),
                       UpdateProjectIntegrationRequest(line: .projectBranch, deliveryMode: .platform))
        XCTAssertEqual(RunSettings.lineWrite(standing(.platform), to: .projectBranch),
                       UpdateProjectIntegrationRequest(line: .projectBranch))
        XCTAssertEqual(RunSettings.lineWrite(standing(.agentPush, line: nil), to: .main),
                       UpdateProjectIntegrationRequest(line: .main))

        // What the line and Automatic say while the agent pushes.
        XCTAssertEqual(RunSettings.lineMainHint(pushing, main: "main"),
                       "For a single task or an urgent fix. The agent pushes each task’s work to main itself.")
        XCTAssertEqual(RunSettings.lineMainHint(standing(.platform), main: "main"), RunSettings.lineMainHint("main"))
        XCTAssertEqual(RunSettings.automaticHint(pushing, main: "main"),
                       "The coordinator runs it for you: it decides when each task is done and handles failed tasks "
                       + "and work not seen on main. The agent pushes each task’s work to main itself. The criteria "
                       + "and anything irreversible stay yours.")
        XCTAssertEqual(RunSettings.automaticHint(standing(.platform), main: "main"), RunSettings.automaticHint(.main))
        XCTAssertEqual(RunSettings.automaticHint(standing(.platform, line: .projectBranch), main: "main"),
                       RunSettings.automaticHint(.projectBranch))

        let encoded = try JSONEncoder().encode(UpdateProjectIntegrationRequest(line: .projectBranch, deliveryMode: .platform))
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: String])
        XCTAssertEqual(sent, ["line": "PROJECT_BRANCH", "deliveryMode": "PLATFORM"])
        XCTAssertFalse(UpdateProjectIntegrationRequest(deliveryMode: .agentPush).isEmpty)

        let read = try JSONDecoder().decode(ProjectIntegrationView.self, from: Data("""
            {"line":"MAIN","ref":"main","upstreamRef":"main","locked":true,"deliveryMode":"AGENT_PUSH",
             "deliveryModeChosenAt":"2026-10-29T01:00:00Z","integratingCount":0,"queuedCount":0,"landTasks":[]}
            """.utf8))
        XCTAssertEqual(read.deliveryMode, .agentPush)
        let older = try JSONDecoder().decode(ProjectIntegrationView.self, from: Data(#"{"line":"MAIN","ref":"main"}"#.utf8))
        XCTAssertNil(older.deliveryMode)
    }

    /// Every sentence about the delivery, as the browser writes it for the project's main branch.
    func testTheDeliveryWordsAreTheBrowsers() throws {
        let web = try web(Self.projectStart)
        assertSays(web, "export const RUN_DELIVERY = '\(RunSettings.delivery)';", "the row")
        assertSays(web, "export const RUN_DELIVERY_PLATFORM = '\(RunSettings.deliveryPlatform)';", "Orbit's way")
        assertSays(web, "export const RUN_DELIVERY_AGENT_PUSH = '\(RunSettings.deliveryAgentPush)';", "the agent's way")
        assertSays(web, "return `\(RunSettings.deliveryPlatformHint(Self.main))`;", "what Orbit's way means")
        assertSays(web, "return `\(RunSettings.deliveryAgentPushHint(Self.main))`;", "what the agent's way means")
        assertSays(web, RunSettings.deliveryNeedsMainLine(Self.main), "why the agent's way is not offered")
        assertSays(web, "return `\(RunSettings.lineMainHintAgentPush(Self.main))`;", "Directly into main's hint")
        assertSays(web, RunSettings.automaticHintAgentPush(Self.main), "How it runs' Automatic sentence")
        let says = RunSettings.automaticSaysAgentPush(automatic: true, main: Self.main)
        let tail = String(says.dropFirst("The coordinator decides".count))
        assertSays(web, "`${automatic ? 'The coordinator decides' : 'You decide'}\(tail)`;", "the start card's sentence")
        XCTAssertEqual(RunSettings.automaticSaysAgentPush(automatic: false, main: Self.main), "You decide\(tail)")
        assertSays(web, "? input.deliveryMode === 'AGENT_PUSH' ? [] : [{ text: startEachMergeInto(input.main), detail: null }]",
                   "no merge comes to the owner while the agent pushes")
        let settings = try self.web(Self.runSettings)
        assertSays(settings, "return draft.line === 'MAIN' ? draft.deliveryMode : 'PLATFORM';",
                   "the agent pushes only on a main line")
        assertSays(settings, "{draft.line === 'MAIN' ? runDeliveryAgentPushHint(main) : runDeliveryNeedsMainLine(main)}",
                   "and is drawn but not offered off it, with why")
        assertSays(settings, "{view.locked ? null : delivery === 'AGENT_PUSH' ? (",
                   "Directly into main's hint follows the delivery")
    }

    // MARK: - the fifth owner item (owner 2026-10-28, §7.6 V12/V13)

    private func coordinator(project: String, items: [SessionOwnerItem]) -> Session {
        Session(id: "c1", title: "Project coordinator", status: .awaitingInput, agentId: "orbit",
                assignedRunnerId: "runner", pendingApprovals: items.count, waitingKind: .ownerItem,
                ownerItems: items, branch: nil, updatedAt: nil, projectId: "p1", projectTitle: project,
                engineTurnActive: false,
                agent: SessionAgentRef(id: "orbit", name: "orbit", provider: nil, model: nil, effort: nil),
                lastTurnAt: "2026-10-29T00:00:00Z")
    }

    private let landedItem = SessionOwnerItem(
        itemId: "i5", kind: .landedWithoutConfirmation,
        title: "Reached main without your confirmation: Fix the login redirect",
        since: "2026-10-29T01:00:00Z", need: "Landed without your confirmation")

    /// Counted, named and drawn like the four: the session row says its word once (its `need` is the
    /// same words, not appended), the banner says WHAT on its first line and WHERE on its second —
    /// the contract's `Landed without your confirmation · <project>` — and the menu bar counts it.
    func testTheFifthOwnerItemIsCountedAndNamedLikeTheFour() throws {
        let decoded = try JSONDecoder().decode(SessionOwnerItem.self, from: Data("""
            {"itemId":"i5","kind":"LANDED_WITHOUT_CONFIRMATION","title":"t","since":"2026-10-29T01:00:00Z",
             "need":"Landed without your confirmation","mainBranch":"main"}
            """.utf8))
        XCTAssertEqual(decoded.kind, .landedWithoutConfirmation, "it was `.unknown` here before")

        let session = coordinator(project: "Payments", items: [landedItem])
        XCTAssertEqual(SessionLine.make(for: session, live: true),
                       SessionLine(text: "Landed without your confirmation", tone: .approval))
        XCTAssertEqual(NeedsYouLogic.oldestItemWord([landedItem]), "Landed without your confirmation")

        let groups = SessionGrouping.group([session])
        XCTAssertEqual(groups.needsYou.map(\.id), ["c1"])
        XCTAssertEqual(MenuBar.summary(from: [session]).needsYou, 1, "the menu bar counts it")
        let banner = try XCTUnwrap(NeedsYouLogic.banner(waiting: groups.needsYou))
        XCTAssertEqual(banner.text, "Landed without your confirmation")
        XCTAssertEqual(banner.detail, "Payments")
        XCTAssertEqual([banner.text, banner.detail].compactMap { $0 }.joined(separator: " · "),
                       "Landed without your confirmation · Payments")
        XCTAssertEqual(banner.glyph, .merge, "the merge's mark, as Android draws it")
        XCTAssertEqual(banner.ownerItem?.itemId, "i5", "and the press lands on its card")
        XCTAssertEqual(banner.since, "2026-10-29T01:00:00Z")

        // The oldest item names the row: an older question beats it, a newer one does not.
        let question = SessionOwnerItem(itemId: "i6", kind: .coordinatorQuestion, title: "q",
                                        since: "2026-10-29T00:00:00Z")
        XCTAssertEqual(NeedsYouLogic.oldestItemWord([landedItem, question]), "Question from coordinator")
        let newer = SessionOwnerItem(itemId: "i6", kind: .coordinatorQuestion, title: "q",
                                     since: "2026-10-29T02:00:00Z")
        XCTAssertEqual(NeedsYouLogic.oldestItemWord([landedItem, newer]), "Landed without your confirmation")

        let web = try web(Self.workspaceView)
        assertSays(web, "export const OWNER_ITEM_LANDED_WITHOUT_CONFIRMATION = '\(NeedsYouLogic.kindWord(.landedWithoutConfirmation)!)';",
                   "the kind word")
        assertSays(web, "LANDED_WITHOUT_CONFIRMATION: OWNER_ITEM_LANDED_WITHOUT_CONFIRMATION,", "the row's words")
    }

    /// The projects list: the chip, its tier and lane, its tie order after the pause, and the
    /// drawer's count — the browser's own reason and words.
    func testTheProjectsListWaitsOnTheOwnerForIt() throws {
        func project(_ items: [ProjectListOwnerItem]) -> ProjectSummary {
            ProjectSummary(id: "p1", title: "Payments", createdAt: "2026-10-01T00:00:00Z", taskCount: 3,
                           buckets: ProjectBuckets(done: 3), lastActivityAt: "2026-10-29T02:00:00Z",
                           attention: ProjectListAttention(ownerItems: items))
        }
        let landed = ProjectListOwnerItem(kind: .landedWithoutConfirmation, count: 1,
                                          oldestWaitingSince: "2026-10-29T01:00:00Z")
        let row = project([landed])
        XCTAssertEqual(ProjectAttention.reason(of: row, now: now), .landedWithoutConfirmation)
        XCTAssertEqual(ProjectAttention.section(of: row, now: now), .attention)
        XCTAssertEqual(ProjectAttention.chip(of: row, now: now),
                       ProjectAttentionChip(tone: .warning, text: "Needs you · Landed without your confirmation · 2h"))
        XCTAssertEqual(ProjectAttention.needsYouItemCount(row), 1)
        XCTAssertEqual(ProjectAttention.drawerMark(row), .needsYou(1))
        XCTAssertTrue(ProjectAttentionReason.landedWithoutConfirmation.isOwnerItem)

        // A tie is settled in the contract's order: after the pause.
        let paused = ProjectListOwnerItem(kind: .fusePaused, count: 1, oldestWaitingSince: "2026-10-29T01:00:00Z")
        XCTAssertEqual(ProjectAttention.leadOwnerItem(project([landed, paused]))?.kind, .fusePaused)
        let older = ProjectListOwnerItem(kind: .landedWithoutConfirmation, count: 1,
                                         oldestWaitingSince: "2026-10-28T23:00:00Z")
        XCTAssertEqual(ProjectAttention.leadOwnerItem(project([paused, older]))?.kind, .landedWithoutConfirmation)

        let web = try web(Self.projectAttention)
        assertSays(web, "'\(ProjectAttentionReason.landedWithoutConfirmation.rawValue)': 1,", "its tier")
        assertSays(web, "'FUSE_PAUSED',\n  'LANDED_WITHOUT_CONFIRMATION',\n];", "its tie order")
        // The coordinator's own phrase for the work not seen, on the list and on the session row.
        assertSays(web, "LANDING_UNOBSERVED: 'handling work not on the line yet',", "the list's phrase")
        XCTAssertEqual(SessionProjectCopy.coordinatorLead(.landingUnobserved), "Handling work not on the line yet")
        assertSays(try self.web(Self.sessionProjects), "LANDING_UNOBSERVED: 'Handling work not on the line yet',",
                   "the session row's phrase")
    }

    /// Its push is one of the five slugs and is handled like the three that are not the merge: a tap
    /// opens the coordinator conversation the payload names, which is where its card is drawn.
    func testItsPushOpensTheConversationItsCardIsIn() throws {
        let shared = try web(Self.shared)
        assertSays(shared, "LANDED_WITHOUT_CONFIRMATION: '\(ProjectAttentionReason.landedWithoutConfirmation.rawValue)',",
                   "the push slug")
        let push = ["sessionID": "s1", "kind": "landed-without-confirmation", "projectID": "p1", "openItemID": "i5"]
        XCTAssertEqual(Notifications.intent(actionId: "com.apple.UNNotificationDefaultActionIdentifier", userInfo: push),
                       .open(.session("s1")))
        let question = ["sessionID": "s1", "kind": "coordinator-question", "projectID": "p1", "openItemID": "i2"]
        XCTAssertEqual(Notifications.intent(actionId: "com.apple.UNNotificationDefaultActionIdentifier", userInfo: push),
                       Notifications.intent(actionId: "com.apple.UNNotificationDefaultActionIdentifier", userInfo: question),
                       "the same as the question, the escalation and the pause")
        XCTAssertNil(Notifications.intent(actionId: "com.apple.UNNotificationDefaultActionIdentifier",
                                          userInfo: ["kind": "landed-without-confirmation", "projectID": "p1"]),
                     "a project with no coordinator names no session, and its push opens nothing — as for the four")
    }

    // MARK: - the owner confirmation card (§10.5 O-L2)

    /// An AGENT_PUSH project's task: confirming merges nothing — the branch row says so — and the
    /// landing row says the agent pushes it and Orbit records it once it sees the commit. It decoded
    /// as nothing here before (`landing` is read with `try?`).
    func testTheConfirmationCardSaysTheAgentPushesIt() throws {
        let read = try JSONDecoder().decode(OwnerConfirmationIfConfirmed.self, from: Data("""
            {"branch":{"name":"orbit/task-login-1a2b3c","linesAdded":1240,"linesRemoved":38,"files":9,"onMain":"NO"},
             "landing":"AGENT_PUSHED","mainBranch":"master"}
            """.utf8))
        XCTAssertEqual(read.landing, .agentPushed)
        XCTAssertEqual(OwnerConfirmations.ifConfirmedRows(read), [
            .init(kind: .branch, lead: "Not on master yet", added: "+1,240",
                  detail: "orbit/task-login-1a2b3c — confirming doesn’t merge it"),
            .init(kind: .landing, lead: "Pushed to master by the agent; Orbit records it once it sees the commit there"),
        ])
        XCTAssertEqual(OwnerConfirmations.agentPushed(RunSettings.defaultMainBranch), OwnerConfirmations.agentPushed)

        let web = try web(Self.confirmationCard)
        assertSays(web, "return `\(OwnerConfirmations.agentPushed(Self.main))`;", "the landing row")
        assertSays(web, "detail: landing === 'NONE' || landing === 'LINE_THEN_OWNER' || landing === 'AGENT_PUSHED'",
                   "confirming does not merge it")
        assertSays(web, "if (landing === 'AGENT_PUSHED') {\n    rows.push({ kind: 'LANDING', lead: ifConfirmedAgentPushed(main), "
                       + "added: null, detail: null });", "drawn as the landing row")
    }
}
