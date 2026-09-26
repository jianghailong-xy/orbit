import Foundation
import XCTest
@testable import OrbitKit

/// Where a tap on an Orbit link card goes, case by case.
///
/// The rule is `OrbitLinkDestination` (`OrbitKit/App`), and this file is that rule asserted: each kind
/// of object a link can name has exactly one place to land — a project included, which lands on its
/// own page as it does on the web — and an object the server would not describe leaves the app rather
/// than opening a page with nothing to show.
///
/// A project used to land on the conversation that coordinates it, from before this client had a
/// project page. Inside that conversation — where its coordinator writes the link — the tap went
/// nowhere (2026-09-26).
///
/// The last case is the project name on a native task start card. It is a link to a project like any
/// other and has to go through this rule rather than one of its own; it used to be drawn as
/// `orbit-project:` and handed to the system, which no shell opened, so the tap did nothing. Half of
/// that case is asserted by parsing the address the card builds, through the same parser the app's
/// door uses; the other half reads the app's source, because the shells do not compile on Linux.
///
/// The two tests that first asserted this rule lived in `OrbitLinkTests`, beside the reading that
/// produces a link. They are here now — this file is the one home for where a tap goes — and the
/// situations this criterion does not name by hand (a card nothing has answered yet) came with them
/// rather than being written out twice.
final class OrbitLinkDestinationTests: XCTestCase {

    // MARK: ids

    /// The production rows `OrbitLinkTests` is drawn from too (2026-09-23), so a failure here reads
    /// against the same object the screenshots show.
    private let taskID = "34TcwNgAIo6tGUiIKjqnQ"
    private let taskUUID = "01a0cca7-8609-70ed-a0e2-d4b55b832b60"
    private let sessionID = "34TYUP5wb87XfuYCInJRY"
    private let sessionUUID = "01a0cc01-771c-767d-846b-8fddfa669490"
    private let projectID = "34Tcl0kralZrY8opuLJU4"
    private let projectUUID = "01a0cca0-aeaa-7618-bd5a-caccc089108c"
    private let listID = "347en66xizlGSG9a6Nej5"
    private let listUUID = "01a00627-1ce2-7302-8e73-89516a879df3"

    private var baseURL: URL { URL(string: "https://orbitd.io")! }

    // MARK: fixtures

    private func ref(_ kind: OrbitLinkKind, _ id: String, _ url: String) -> OrbitLinkRef {
        OrbitLinkRef(target: OrbitLinkTarget(kind: kind, id: id), source: .pageURL(url))
    }

    private func preview(_ json: String, line: UInt = #line) throws -> LinkPreview {
        do {
            return try JSONDecoder().decode(LinkPreview.self, from: Data(json.utf8))
        } catch {
            XCTFail("the wire shape below is not what the DTO reads: \(error)", line: line)
            throw error
        }
    }

    /// A project the server described, with `coordinatorSessionId` written as the wire writes it —
    /// the id of the conversation that coordinates it, or null when there is none to open.
    private func project(coordinator: String?) throws -> LinkPreview {
        let id = coordinator.map { "\"\($0)\"" } ?? "null"
        return try preview("""
        {"kind":"project","id":"\(projectID)","state":"ok","project":{"title":"p","total":1,
          "buckets":{"running":0,"ready":0,"blocked":0,"awaitingVerification":0,"done":1,"failed":0,
                     "cancelled":0},
          "coordinatorSessionId":\(id)}}
        """)
    }

    // MARK: the four kinds, and where each goes

    /// One destination per kind: a task, a session, a task list and a project are pages this app has.
    func testEveryKindAndWhereItGoes() throws {
        let task = try preview("""
        {"kind":"task","id":"\(taskID)","state":"ok","task":{"title":"t","status":"DONE"}}
        """)
        let session = try preview("""
        {"kind":"session","id":"\(sessionID)","state":"ok","session":{"id":"\(sessionID)","title":"t"}}
        """)
        let list = try preview("""
        {"kind":"list","id":"\(listID)","state":"ok","list":{"title":"l","counts":{"total":1}}}
        """)

        let cases: [(OrbitLinkRef, LinkPreview, OrbitLinkDestination)] = [
            (ref(.task, taskUUID, "https://orbitd.io/tasks/\(taskID)"), task,
             .task(id: taskID)),
            (ref(.session, sessionUUID, "https://orbitd.io/sessions/\(sessionID)"), session,
             .session(id: sessionID)),
            // A list is the scope the Tasks page switches to, so the destination carries the
            // spelling that page knows the list by — the link named it by UUID.
            (ref(.list, listUUID, "https://orbitd.io/lists/\(listID)"), list,
             .list(id: listID)),
            // A project opens its own page, in the spelling the Projects list knows it by.
            (ref(.project, projectUUID, "https://orbitd.io/projects/\(projectID)"),
             try project(coordinator: sessionID),
             .project(id: projectID)),
        ]
        for (link, answer, expected) in cases {
            XCTAssertEqual(OrbitLinkDestination.tap(for: link, preview: answer, baseURL: baseURL),
                           expected, "\(link.kind) \(link.id)")
        }
    }

    /// Whoever coordinates it — somebody, nobody (the server nulls the id when the coordinator is in
    /// Trash), or an `ok` answer that carries no project at all — a project opens its own page in the
    /// app. The conversation that coordinates it is no longer where its link goes.
    func testAProjectOpensItsOwnPageWhoeverCoordinatesIt() throws {
        let answers = [try project(coordinator: sessionID),
                       try project(coordinator: nil),
                       try project(coordinator: ""),
                       try preview("""
                       {"kind":"project","id":"\(projectID)","state":"ok"}
                       """)]
        for answer in answers {
            let link = ref(.project, projectUUID, "https://orbitd.io/projects/\(projectID)")
            XCTAssertEqual(OrbitLinkDestination.tap(for: link, preview: answer, baseURL: baseURL),
                           .project(id: projectID), "a project opens its own page in the app")
        }
    }

    /// An object the server would not describe — deleted, or not in this account — leaves the app
    /// for its own page, for every kind: a tap must never open a page of this app that has nothing
    /// to show, and it must never go nowhere.
    func testAnObjectTheServerWouldNotDescribeLeavesForItsOwnPage() throws {
        let objects: [(OrbitLinkKind, uuid: String, publicID: String)] = [
            (.task, taskUUID, taskID),
            (.session, sessionUUID, sessionID),
            (.project, projectUUID, projectID),
            (.list, listUUID, listID),
        ]
        for (kind, uuid, publicID) in objects {
            let answer = try preview("""
            {"kind":"\(kind.rawValue)","id":"\(publicID)","state":"unavailable"}
            """)
            let own = "https://orbitd.io/\(kind.pathSegment)/\(publicID)"
            XCTAssertEqual(OrbitLinkDestination.tap(for: ref(kind, uuid, own), preview: answer,
                                                    baseURL: baseURL),
                           .web(URL(string: own)!),
                           "\(kind.rawValue): an object the server would not describe leaves for its "
                               + "own page")
        }
    }

    /// The address it leaves for is the deployment's own spelling of the object, whichever spelling
    /// the link that named it used: the routes this deployment serves take the public id.
    func testTheAddressItLeavesForIsSpelledTheWayTheDeploymentSpellsIt() {
        XCTAssertEqual(OrbitLinkParser.pageURL(for: OrbitLinkTarget(kind: .task, id: taskUUID),
                                               baseURL: baseURL),
                       URL(string: "https://orbitd.io/tasks/\(taskID)"))
        XCTAssertEqual(OrbitLinkParser.pageURL(for: OrbitLinkTarget(kind: .list, id: listUUID),
                                               baseURL: baseURL),
                       URL(string: "https://orbitd.io/lists/\(listID)"))
    }

    /// A tap that arrives before the read finishes leaves the app, exactly as an unavailable object
    /// does: the app has nothing to open yet, and a page that is still loading is not a place to
    /// land.
    func testACardNothingHasAnsweredYetLeavesRatherThanOpeningAnEmptyPage() {
        XCTAssertEqual(OrbitLinkDestination.tap(for: ref(.task, taskUUID,
                                                         "https://orbitd.io/tasks/\(taskID)"),
                                                preview: nil, baseURL: baseURL),
                       .web(URL(string: "https://orbitd.io/tasks/\(taskID)")!))
    }

    /// And a link somebody wrote or pasted, with nothing read at all: every kind is a page in this app
    /// whatever the object turns out to be — a project's page included, which says so when the
    /// project is gone.
    func testALinkSomebodyWroteGoesInAppWithoutReadingAnything() {
        XCTAssertEqual(OrbitLinkDestination.inApp(for: OrbitLinkTarget(kind: .task, id: taskUUID)),
                       .task(id: taskID))
        XCTAssertEqual(OrbitLinkDestination.inApp(for: OrbitLinkTarget(kind: .session, id: sessionUUID)),
                       .session(id: sessionID))
        XCTAssertEqual(OrbitLinkDestination.inApp(for: OrbitLinkTarget(kind: .list, id: listUUID)),
                       .list(id: listID))
        XCTAssertEqual(OrbitLinkDestination.inApp(for: OrbitLinkTarget(kind: .project, id: projectUUID)),
                       .project(id: projectID))
    }

    // MARK: a wiki entry

    private let wikiID = "34UDFnrgM4q5oGQloG3uq"
    private let wikiUUID = "01a0d1f2-3a44-7c11-9b02-5f6e7d8c9a10"

    /// A wiki entry has a page in this app that reads by its id alone, and the deployment's page for
    /// it takes the entry's space as well — which only a read names. So an `orbit-wiki:` link opens
    /// the entry here whether or not anything has been read, and a card the server would not
    /// describe opens it here too: the entry's own page is the one that can say it is gone, where a
    /// browser has no page to open for an id alone.
    func testAWikiEntryOpensItsOwnPageInTheApp() throws {
        let target = OrbitLinkTarget(kind: .wiki, id: wikiUUID)
        XCTAssertEqual(OrbitLinkDestination.inApp(for: target), .wikiEntry(id: wikiID))
        let link = OrbitLinkRef(target: target, source: .reference("orbit-wiki:\(wikiID)"))
        let answered = try preview("""
        {"kind":"wiki","id":"\(wikiID)","state":"ok","wiki":{"spaceSlug":"orbit","title":"t"}}
        """)
        let unavailable = try preview("""
        {"kind":"wiki","id":"\(wikiID)","state":"unavailable"}
        """)
        for answer in [answered, unavailable, nil] {
            XCTAssertEqual(OrbitLinkDestination.tap(for: link, preview: answer, baseURL: baseURL),
                           .wikiEntry(id: wikiID))
        }
    }

    /// The deployment's page for an entry is its space's and its own together; with no space in hand
    /// there is no page, rather than a `/wiki/<id>` that the deployment does not serve.
    func testAWikiEntrysPageTakesItsSpace() {
        let target = OrbitLinkTarget(kind: .wiki, id: wikiUUID)
        XCTAssertNil(OrbitLinkParser.pageURL(for: target, baseURL: baseURL))
        XCTAssertEqual(OrbitLinkParser.pageURL(for: target, baseURL: baseURL, wikiSpaceSlug: "orbit"),
                       URL(string: "https://orbitd.io/wiki/orbit/e/\(wikiID)"))
        // A slug means nothing to any other kind.
        XCTAssertEqual(OrbitLinkParser.pageURL(for: OrbitLinkTarget(kind: .task, id: taskUUID),
                                               baseURL: baseURL, wikiSpaceSlug: "orbit"),
                       URL(string: "https://orbitd.io/tasks/\(taskID)"))
    }

    // MARK: the task start card's project name

    /// The project name on a task's start card is a link to a project like any other, so it has to
    /// go through the rule above rather than one of its own.
    func testTheTaskStartCardsProjectNameOpensThroughTheSameRule() throws {
        let card = TaskStart(taskId: taskUUID, title: "t",
                             project: TaskStartProject(id: projectID, title: "p"))
        let url = try XCTUnwrap(TaskStartCard.projectLink(card), "the card names its project as a link")
        XCTAssertEqual(url.scheme, "orbit-project")

        // The address the row opens, read back through the parser the app's door reads a link with:
        // the object it names is the one this file's rule answers for.
        let text = url.absoluteString
        let target = try XCTUnwrap(OrbitLinkParser.target(forReference: text),
                                   "\(text) is not a link this app's door understands")
        XCTAssertEqual(target, OrbitLinkTarget(kind: .project, id: projectUUID))

        // It opens the project's own page, read or not.
        XCTAssertEqual(OrbitLinkDestination.inApp(for: target), .project(id: projectID))
        let link = OrbitLinkRef(target: target, source: .reference(text))
        XCTAssertEqual(OrbitLinkDestination.tap(for: link, preview: try project(coordinator: sessionID),
                                                baseURL: baseURL),
                       .project(id: projectID))
    }

    /// The same claim read off the view that draws the row, because the shells do not compile here:
    /// its address is the card's own (`TaskStartCard.projectLink`, OrbitKit's), it opens through the
    /// app's one door, and it builds no address of its own.
    func testTheTaskStartCardViewOpensThroughTheDoorRatherThanOneOfItsOwn() throws {
        let view = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/TaskStartCardView.swift")
        let row = code(try slice(view,
                                 from: "private func projectRow(_ project: TaskStartProject) -> some View {",
                                 to: "\n    @ViewBuilder"))

        // The slice is the project row alone: the `links` view below it opens the task, and a
        // `contains` that could be answered by that one would not be asserting about this row.
        XCTAssertFalse(row.contains("TaskStartCard.taskLink"),
                       "the slice overran — this is not the project row")
        XCTAssertTrue(row.contains("TaskStartCard.projectLink(card)"),
                      "the row's address is the card's own, from OrbitKit")
        XCTAssertTrue(row.contains("if app?.openOrbitLink(url) != true { openURL(url) }"),
                      "and it opens through the app's one door — the system action is only what is "
                          + "left when there is no app around the card (a preview). If this line was "
                          + "reformatted, keep that order.")
        for built in ["URL(string:", "orbit-project:", "pageURL(", "route(to:"] {
            XCTAssertFalse(row.contains(built),
                           "the row builds no address and chooses no destination itself: it must not "
                               + "spell `\(built)`")
        }
    }

    // MARK: the one door

    /// …and the door is this rule: every kind is answered from the link alone, a card's tap from what
    /// that card's read returned, and every destination either hands back lands somewhere — a page in
    /// this app, or out to the system for the one that leaves it.
    func testTheOneDoorResolvesThroughTheDestinationRule() throws {
        let cards = try source("src/macos/OrbitApp/Sources/OrbitApp/OrbitLinkCards.swift")
        let door = code(try slice(cards, from: "func openOrbitLink(_ ref: OrbitLinkRef, overConsole: Bool = false) {",
                                  to: "\n    }"))
        XCTAssertTrue(door.contains("open(OrbitLinkDestination.inApp(for: ref.target), overConsole: overConsole)"),
                      "the door spends this rule's answer for every kind, with nothing read first")
        let tap = code(try slice(cards, from: "func destination(for ref: OrbitLinkRef) -> OrbitLinkDestination {",
                                 to: "\n    }"))
        XCTAssertTrue(tap.contains("OrbitLinkDestination.tap(for: ref, preview:"),
                      "and a card's tap spends its read-first answer")

        // A task or a session goes through the conversation's door, which routes exactly as before
        // unless the link is in a phone's conversation — then it is pushed over that console, so the
        // back swipe returns to it (`CreatedTasksWiringTests.testEveryDoorOutOfAConversationPushes…`).
        let open = code(try slice(cards, from: "func open(_ destination: OrbitLinkDestination, overConsole: Bool = false) {",
                                  to: "\n    }"))
        let landings = [("case .task(let id):", "openFromConversation(.task(id), overConsole: overConsole)"),
                        ("case .session(let id):", "openFromConversation(.session(id), overConsole: overConsole)"),
                        ("case .project(let id):", "openProjectFromConversation(id, overConsole: overConsole)"),
                        ("case .list(let id):", "route(to: .list(id))"),
                        ("case .wikiEntry(let id):", "openWikiEntry(id, overConsole: overConsole)"),
                        ("case .web(let url):", "openExternal(url)")]
        for (arm, landing) in landings {
            XCTAssertTrue(open.contains(arm), "`open(_:)` still lands \(arm)")
            XCTAssertTrue(open.contains(landing), "\(arm) lands \(landing)")
        }
    }

    // MARK: reading the app's source

    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "\(path) wasn't found above this test. If it moved, point this check at its new home — "
                + "don't delete it: a view that stops going through this rule is the bug this file "
                + "exists to catch."
        }
    }

    /// Found by walking up from this file; never a skip, so the check cannot go quiet when a file
    /// moves.
    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir.deleteLastPathComponent()
        }
        throw SourceMissing(path: relative)
    }

    /// From `start` through the next `end` after it, so a match elsewhere in the file cannot answer
    /// for the stretch being asserted about.
    private func slice(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`")
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    /// The text without its comment lines, which are free to talk about what the code must not do.
    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }
}
