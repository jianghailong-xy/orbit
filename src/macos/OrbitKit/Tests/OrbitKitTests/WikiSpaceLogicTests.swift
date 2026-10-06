import Foundation
import XCTest
@testable import OrbitKit

/// The spaces as a reader knows them — what each is called, which one the Wiki opens, what waits on the
/// owner across them — held to the web's rules by the one set of cases both ends read:
/// `src/shared/src/wiki-space.fixture.json`, which the web's `wikiSpace.test.ts` reads too. A missing
/// fixture is a failure, never a skip; so is a fixture that lost its cases.
final class WikiSpaceLogicTests: XCTestCase {
    private static let fixturePath = "src/shared/src/wiki-space.fixture.json"

    private struct Missing: Error, CustomStringConvertible {
        let file: String
        var description: String {
            "\(file) was not found above this test file. The web reads the same cases; if the fixture moved, "
                + "move this check with it rather than deleting it."
        }
    }

    private struct Fixture: Decodable {
        /// A space as a case writes it: only the fields its rule reads.
        struct Space: Decodable {
            let id: String?
            let slug: String?
            let title: String?
            let repoUrlNorm: String?
            let workspaceIds: [String]?
            let docs: WikiDocsDirectory.Counts?
            let pendingOps: Int?
            let planWaiting: Int?

            var space: WikiSpace {
                WikiSpace(id: id ?? slug ?? "", slug: slug ?? id ?? "", title: title, repoUrlNorm: repoUrlNorm,
                          pendingOps: pendingOps, planWaiting: planWaiting, workspaceIds: workspaceIds, docs: docs)
            }
        }

        struct Names: Decodable {
            let name: String
            let spaces: [Space]
            let names: [String: String]
        }

        struct Default: Decodable {
            let name: String
            let spaces: [Space]
            let workspaceId: String?
            let lastSlug: String?
            let opens: String?
        }

        struct Waiting: Decodable {
            let name: String
            let spaces: [Space]
            let current: String
            let waiting: Int
            let proposals: Int
            let banner: String?
            let options: [String]
        }

        let names: [Names]
        let defaults: [Default]
        let waiting: [Waiting]
    }

    private func fixture() throws -> Fixture {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(Self.fixturePath)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: candidate))
            }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(file: Self.fixturePath)
    }

    /// The fixture still holds its cases, among them one where a plan waits too (the acceptance's own).
    func testTheFixtureHoldsItsCases() throws {
        let cases = try fixture()
        XCTAssertGreaterThanOrEqual(cases.names.count, 6)
        XCTAssertGreaterThanOrEqual(cases.defaults.count, 9)
        XCTAssertGreaterThanOrEqual(cases.waiting.count, 10)
        XCTAssertTrue(cases.waiting.contains { $0.spaces.count > 1 && $0.spaces.contains { ($0.planWaiting ?? 0) > 0 } },
                      "a case with several spaces and a plan that waits")
    }

    // MARK: the name

    /// A space is called by its repository's last segment, its title without one, and more segments
    /// while two would be the same.
    func testEveryNameIsTheFixtures() throws {
        for test in try fixture().names {
            XCTAssertEqual(WikiSpaceLogic.names(test.spaces.map(\.space)), test.names, test.name)
        }
    }

    // MARK: which space the Wiki opens

    /// The workspace's space, else the last one looked at, else the most written — the first on a tie.
    func testTheSpaceTheWikiOpensIsTheFixtures() throws {
        for test in try fixture().defaults {
            let opens = WikiSpaceLogic.defaultSpace(test.spaces.map(\.space), workspaceID: test.workspaceId,
                                                    lastSlug: test.lastSlug)
            XCTAssertEqual(opens?.slug, test.opens, test.name)
        }
    }

    /// Where the reader is when they open the Wiki: the workspace whose list is showing, a project's
    /// coordinator workspace on its pages, and nowhere on the Projects or Tasks list.
    func testWhereTheReaderIs() {
        let coordinator: (String) -> String? = { $0 == "P1" ? "ws-coordinator" : nil }
        func reader(_ nav: NavState, agent: String? = "ws-list") -> String? {
            WikiSpaceLogic.workspaceInView(nav, agentID: agent, coordinatorWorkspace: coordinator)
        }
        XCTAssertEqual(reader(NavState(section: .agents)), "ws-list", "a workspace's session list")
        XCTAssertEqual(reader(NavState(section: .agents, stacks: [.agents: [.console(sessionID: "s", origin: .list)]])),
                       "ws-list", "one of its conversations")
        XCTAssertNil(reader(NavState(section: .agents), agent: nil), "no workspace picked")
        let project = SessionProjectAddress(projectID: "P1", agentID: "ws-list", view: .open)
        XCTAssertEqual(reader(NavState(section: .agents, stacks: [.agents: [.sessionProject(project, asDestination: true)]])),
                       "ws-coordinator", "a project's sessions page: its coordinator's workspace")
        let unknown = SessionProjectAddress(projectID: "P2", agentID: "ws-list", view: .open)
        XCTAssertNil(reader(NavState(section: .agents, stacks: [.agents: [.sessionProject(unknown, asDestination: true)]])),
                     "a coordinator not known yet is nowhere, as the web's sidebar says until the project is read")
        XCTAssertEqual(reader(NavState(section: .projects, stacks: [.projects: [.projectDetail(projectID: "P1")]])),
                       "ws-coordinator", "a project's page")
        XCTAssertEqual(reader(NavState(section: .projects,
                                       stacks: [.projects: [.projectDetail(projectID: "P1"), .taskDetail(taskID: "t")]])),
                       "ws-coordinator", "a task over its project's page")
        XCTAssertNil(reader(NavState(section: .projects)), "the Projects list")
        XCTAssertNil(reader(NavState(section: .tasks)), "the Tasks list")
    }

    // MARK: what waits on the owner

    /// The number, the proposals alone, Activity's first banner and the picker's options, case by case —
    /// a plan that waits counts in the number and not in the banner.
    func testWhatWaitsIsTheFixtures() throws {
        for test in try fixture().waiting {
            let spaces = test.spaces.map(\.space)
            XCTAssertEqual(WikiSpaceLogic.waiting(spaces), test.waiting, test.name)
            XCTAssertEqual(WikiSpaceLogic.proposalsWaiting(spaces), test.proposals, test.name)
            XCTAssertEqual(WikiSpaceLogic.proposalsBanner(spaces, current: test.current), test.banner, test.name)
            let names = WikiSpaceLogic.names(spaces)
            XCTAssertEqual(spaces.map { WikiSpaceLogic.option(names[$0.id] ?? "", $0) }, test.options, test.name)
            XCTAssertEqual(spaces.map(WikiSpaceLogic.waitingIn).reduce(0, +), test.waiting, test.name)
        }
    }

    /// The drawer's number, the bar's Activity badge and Activity's amber banners are one number — every
    /// space's proposals and what each plan waits on the owner for — and Activity's first banner is
    /// Review's head, the proposals alone (§12.3.3, mock 31 ⑤), with plans that wait in two spaces.
    func testFourPlacesSayOneNumber() throws {
        func plan(_ json: String) throws -> WikiPlanState {
            try JSONDecoder().decode(WikiPlanState.self, from: Data(json.utf8))
        }
        let spaces = [
            WikiSpace(id: "s1", slug: "github-com-jianghailong-xy-orbit", title: "github-com-jianghailong-xy-orbit",
                      repoUrlNorm: "github.com/jianghailong-xy/orbit", pendingOps: 1, planWaiting: 1),
            WikiSpace(id: "s2", slug: "wikova", title: "wikova", repoUrlNorm: "github.com/jianghailong-xy/wikova",
                      pendingOps: 2, planWaiting: 2),
            WikiSpace(id: "s3", slug: "wikids", title: "wikids", repoUrlNorm: "github.com/jianghailong-xy/wikids",
                      pendingOps: 0, planWaiting: 0),
        ]
        let plans = [
            "s1": try plan(#"{"spaceId":"s1","confirmed":null,"draft":{"id":"v1","version":1,"status":"draft"},"proposals":[],"job":null}"#),
            "s2": try plan(#"{"spaceId":"s2","confirmed":null,"draft":null,"proposals":[{"id":"p1","status":"pending"},{"id":"p2","status":"pending"}],"job":null}"#),
            "s3": try plan(#"{"spaceId":"s3","confirmed":null,"draft":null,"proposals":[],"job":null}"#),
        ]
        // Each plan read counts what the server's planWaiting counts.
        for space in spaces {
            XCTAssertEqual(WikiPlanLogic.pending(try XCTUnwrap(plans[space.id]), runnerOnline: true), space.planWaiting)
        }
        let drawer = WikiSpaceLogic.waiting(spaces)
        XCTAssertEqual(drawer, 6, "1 + 1 in orbit, 2 + 2 in wikova")

        let onOrbit = WikiSpaceLogic.activityBanners(spaces: spaces, current: spaces[0], plans: plans, now: Date(),
                                                     docs: nil, runnerOnline: { _ in true })
        XCTAssertEqual(onOrbit.map(\.text), ["3 proposals to review · 2 in wikova", "Plan draft ready to confirm",
                                             "2 plan changes to review · in wikova"])
        XCTAssertEqual(onOrbit.map(\.band), [.reviewBanner, .planBanners, .otherPlanBanners])
        XCTAssertEqual(onOrbit.map(\.to), [.review, .plan(slug: "github-com-jianghailong-xy-orbit"), .plan(slug: "wikova")])
        XCTAssertTrue(onOrbit.allSatisfy { $0.tone == .amber })
        XCTAssertEqual(onOrbit.map(\.count).reduce(0, +), drawer, "Activity's amber banners add up to the drawer's number")

        // On a space whose plan waits for nothing, its plan says what it is doing, in blue, counting nothing.
        let onWikids = WikiSpaceLogic.activityBanners(spaces: spaces, current: spaces[2], plans: plans, now: Date(),
                                                      docs: nil, runnerOnline: { _ in true })
        XCTAssertEqual(onWikids.map(\.text), ["3 proposals to review · 1 in orbit · 2 in wikova", "No plan yet — draft one",
                                              "Plan draft ready to confirm · in orbit", "2 plan changes to review · in wikova"])
        XCTAssertEqual(onWikids.map(\.tone), [.amber, .blue, .amber, .amber])
        XCTAssertEqual(onWikids.map(\.count).reduce(0, +), drawer)

        // The first banner is the proposals alone — Review's head, over the same queue.
        let first = try XCTUnwrap(onOrbit.first)
        XCTAssertEqual(first.count, WikiSpaceLogic.proposalsWaiting(spaces))
        let queue = [WikiChangeset(id: "c1", spaceId: "s1", sessionId: "a",
                                   ops: [WikiChangesetOp(id: "o1", seq: 1, op: .add, decision: .pending)]),
                     WikiChangeset(id: "c2", spaceId: "s2", sessionId: "b",
                                   ops: [WikiChangesetOp(id: "o2", seq: 1, op: .add, decision: .pending),
                                         WikiChangesetOp(id: "o3", seq: 2, op: .amend, decision: .pending)])]
        let cards = WikiLogic.reviewCards(queue)
        XCTAssertEqual(cards.count, first.count)
        XCTAssertEqual(WikiCopy.proposalsFrom(cards.count, sessions: WikiLogic.proposingSessions(cards)),
                       "3 proposals from 2 sessions")
    }

    /// The native picker's rows (mock 31 ④): the name, the repository and the documents under it, and
    /// the amber number — said at the end of the line where a menu cannot draw it.
    func testTheNativePickersRows() {
        let spaces = [
            WikiSpace(id: "s1", slug: "github-com-jianghailong-xy-orbit", title: "github-com-jianghailong-xy-orbit",
                      repoUrlNorm: "github.com/jianghailong-xy/orbit", pendingOps: 1, planWaiting: 0,
                      docs: WikiDocsDirectory.Counts(total: 35, written: 5)),
            WikiSpace(id: "s2", slug: "wikova", title: "wikova", repoUrlNorm: "github.com/jianghailong-xy/wikova",
                      pendingOps: 2, planWaiting: 0, docs: WikiDocsDirectory.Counts(total: 12, written: 12)),
            WikiSpace(id: "s3", slug: "wikids", title: "Kids", repoUrlNorm: "github.com/jianghailong-xy/wikids",
                      pendingOps: 0, planWaiting: 0),
            WikiSpace(id: "s4", slug: "notes", title: "Design notes", pendingOps: 51, planWaiting: 1,
                      docs: WikiDocsDirectory.Counts(total: 1, written: 1)),
        ]
        let rows = WikiSpaceLogic.menuRows(spaces)
        XCTAssertEqual(rows.map(\.name), ["orbit", "wikova", "wikids", "Design notes"])
        XCTAssertEqual(rows.map(\.slug), spaces.map(\.slug), "a row opens its space by slug")
        XCTAssertEqual(rows[0].lines, ["github.com/jianghailong-xy/orbit", "35 documents"])
        XCTAssertEqual(rows[2].lines, ["github.com/jianghailong-xy/wikids", "No documents yet"])
        XCTAssertEqual(rows[3].lines, ["1 document"], "no repository, no line for it")
        XCTAssertEqual(rows.map(\.waiting), [1, 2, 0, 52])
        XCTAssertEqual(rows.map(\.waitingSymbol), ["1.circle.fill", "2.circle.fill", nil, nil],
                       "the numbered circles stop at 50")
        XCTAssertEqual(rows[0].subtitle(sayWaiting: false), "github.com/jianghailong-xy/orbit\n35 documents")
        XCTAssertEqual(rows[0].subtitle(sayWaiting: true), "github.com/jianghailong-xy/orbit\n35 documents · 1 waiting",
                       "the web option's own words")
        XCTAssertEqual(rows[2].subtitle(sayWaiting: true), "github.com/jianghailong-xy/wikids\nNo documents yet",
                       "nothing waiting says nothing")
        XCTAssertEqual(WikiCopy.documentCount(1234), "1,234 documents")
    }

    // MARK: since the reader last looked

    /// The home moves the stamp as it opens and Activity reads what it said before; Activity moving it in
    /// its turn leaves the next page the home's visit to compare against (the web's `wiki.test.ts` cases).
    func testThePageAfterTheHomeReadsTheStampFromBefore() {
        var store: [String: Double] = [:]
        var log = WikiSeenLog()
        let key = WikiSeenLog.key(space: "stamp-test")
        XCTAssertEqual(key, "orbit.wiki.seen.stamp-test.home")
        func move(_ at: Double) {
            log.move(key, at: at, stored: store[key] ?? 0)
            store[key] = at
        }
        store[key] = 1
        XCTAssertEqual(log.seenBefore(key, stored: store[key] ?? 0), 1, "the stamp itself until this run moved it")
        move(5)
        XCTAssertEqual(store[key], 5)
        XCTAssertEqual(log.seenBefore(key, stored: store[key] ?? 0), 1, "the home's move keeps the visit before")
        move(9)
        XCTAssertEqual(log.seenBefore(key, stored: store[key] ?? 0), 5, "Activity's move: the next page compares against the home")
        // One opening moving it twice keeps what it said before the first.
        let twice = WikiSeenLog.key(space: "stamp-twice")
        var again = WikiSeenLog()
        again.move(twice, at: 50, stored: 1)
        again.move(twice, at: 50.002, stored: 50)
        XCTAssertEqual(again.seenBefore(twice, stored: 50.002), 1)
    }

    /// What is new: everything when nothing was seen; after that, what happened after the stamp.
    func testWhatIsNewSinceTheReaderLastLooked() throws {
        let seen = try XCTUnwrap(RelativeTime.parse("2026-10-06T10:00:00.000Z")).timeIntervalSince1970
        XCTAssertTrue(WikiSeenLog.isNew("2026-10-06T09:00:00.000Z", seen: 0), "never looked: all of it is new")
        XCTAssertTrue(WikiSeenLog.isNew("2026-10-06T10:00:01.000Z", seen: seen))
        XCTAssertFalse(WikiSeenLog.isNew("2026-10-06T10:00:00.000Z", seen: seen), "at the stamp is not after it")
        XCTAssertFalse(WikiSeenLog.isNew("2026-10-06T09:59:59.000Z", seen: seen))
        XCTAssertFalse(WikiSeenLog.isNew(nil, seen: seen), "a row with no time is not new")
        XCTAssertFalse(WikiSeenLog.isNew("not a time", seen: seen))
    }
}
