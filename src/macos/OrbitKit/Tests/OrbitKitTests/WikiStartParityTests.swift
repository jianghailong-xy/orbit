import Foundation
import XCTest
@testable import OrbitKit

/// The Wiki while it has nothing to read (design §12.3.1, mock 41): the setup card says the web's words, reads every
/// state of the plan as the web reads it, and offers the workspaces the web's two forms offer.
///
/// Three halves, each a failure — never an `XCTSkip` — when its counterpart goes missing:
/// - the cases of `src/shared/src/wiki-start.fixture.json`, read with `plan.states` of `wiki-docs.fixture.json`, which
///   the web's `lib/wikiStart.test.ts` and Android's `WikiStartLogicTest` read too;
/// - every `WikiStartCopy` word looked up in the web source it mirrors, and the sheet's own `Create` on the board;
/// - what the home, its two forms and the no-wiki page do with a press, in the app's source.
final class WikiStartParityTests: XCTestCase {

    private static let lib = "src/web/src/lib/wikiStart.ts"
    private static let planLib = "src/web/src/lib/wikiPlan.ts"
    private static let card = "src/web/src/components/WikiStartCard.tsx"
    private static let dialog = "src/web/src/components/WikiSetUpDialog.tsx"
    private static let board = "docs/mocks/wiki/41-home-setup.html"
    private static let startFixture = "src/shared/src/wiki-start.fixture.json"
    private static let docsFixture = "src/shared/src/wiki-docs.fixture.json"
    private static let app = "src/macos/OrbitApp/Sources/OrbitApp/"

    private struct Missing: Error, CustomStringConvertible {
        let file: String
        var description: String {
            "\(file) was not found above this test file. The setup card is one half of a pair; if the other half "
                + "moved, move this check with it rather than deleting it."
        }
    }

    private func find(_ relative: String) throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(file: relative)
    }

    private func web(_ relative: String) throws -> String {
        try String(contentsOf: find(relative), encoding: .utf8)
            .replacingOccurrences(of: "['`]\\s*\\+\\s*['`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    }

    /// A native page's source without its comment lines, whitespace kept.
    private func native(_ file: String) throws -> String {
        try String(contentsOf: find(Self.app + file), encoding: .utf8)
            .split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    private func assertOrder(_ text: String, _ literals: [String], _ what: String, line: UInt = #line) {
        let positions = literals.map { text.range(of: $0)?.lowerBound }
        XCTAssertFalse(positions.contains(nil), "\(what): lost \(literals.filter { text.range(of: $0) == nil })", line: line)
        let found = positions.compactMap { $0 }
        XCTAssertEqual(found, found.sorted(), "\(what) is no longer in the order \(literals)", line: line)
    }

    private func assertSays(_ text: String, _ literal: String, in file: String, line: UInt = #line) {
        XCTAssertTrue(text.contains(literal), "\(file) no longer says \(literal)", line: line)
    }

    private func assertDeclares(_ text: String, _ name: String, _ value: String, in file: String, line: UInt = #line) {
        let single = "\(name) = '\(value.replacingOccurrences(of: "'", with: "\\'"))'"
        XCTAssertTrue(text.contains(single), "\(name) drifted: \(file) no longer declares it as \(value.debugDescription)", line: line)
    }

    private func slice(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex), "no `\(end)` after `\(start)`")
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    // MARK: the fixtures

    /// A card as the fixture spells it, which is the web's shape of one.
    private struct Card: Decodable, Equatable {
        struct Progress: Decodable, Equatable {
            let done: Int
            let total: Int
            let now: String?
        }

        struct Action: Decodable, Equatable {
            let label: String
            let to: String
            let primary: Bool
        }

        struct Step: Decodable, Equatable {
            let state: String
            let title: String
            let text: String
            let note: String?
            let progress: Progress?
            let action: Action?
        }

        let title: String
        let lead: String
        let steps: [Step]
    }

    private func spelled(_ card: WikiStartLogic.Card) -> Card {
        Card(title: card.title, lead: card.lead, steps: card.steps.map { step in
            Card.Step(state: step.state.rawValue, title: step.title, text: step.text, note: step.note,
                      progress: step.progress.map { Card.Progress(done: $0.done, total: $0.total, now: $0.now) },
                      action: step.action.map { Card.Action(label: $0.label, to: $0.to.rawValue, primary: $0.primary) })
        })
    }

    private struct StartFixture: Decodable {
        struct Context: Decodable {
            let maintenance: Bool
            let readsFrom: String
        }

        struct First: Decodable {
            let workspaces: Card
            let noRepository: Card
        }

        struct Shown: Decodable {
            let written: Int
            let topics: Int
            let shown: Bool
        }

        struct Repository: Decodable {
            let url: String
            let repository: String?
            let title: String?
        }

        struct Workspaces: Decodable {
            struct Choice: Decodable {
                let id: String
                let label: String
                let repository: String?
                let repoUrl: String?
                let online: Bool
            }

            struct Group: Decodable {
                let repository: String
                let choices: [String]
            }

            struct Default: Decodable {
                let current: String?
                let from: String?
                let pick: String?
            }

            let choices: [Choice]
            let inOrder: [String]
            let groups: [Group]
            let defaults: [Default]
            let allOffline: String?
            let none: String?
        }

        /// A state `plan.states` does not reach: a draft, or its failure, with no version confirmed yet, and documents
        /// whose writing waits for an offline runner.
        struct FirstDraft: Decodable {
            let spec: DocsFixture.Plan.State.Spec
            let card: Card
        }

        let timeZone: String
        let now: String
        let context: Context
        let states: [String: Card]
        let firstDrafts: [String: FirstDraft]
        let writingOffline: FirstDraft
        let maintenanceOff: Card
        let readsFromUnknown: Card
        let first: First
        let shown: [Shown]
        let repositories: [Repository]
        let workspaces: Workspaces
        let hasWiki: HasWiki
        let wikiCreateCard: WikiCreateCard

        /// The Create wiki form once a wiki exists (design §3.4, board 46 parts 4-5).
        struct HasWiki: Decodable {
            struct Group: Decodable {
                let repository: String
                let choices: [String]
                let hasWiki: Bool
            }

            struct AllHaveWikis: Decodable {
                let wikis: [String]
                let offered: [String]
                let pick: String?
            }

            struct Refusal: Decodable {
                let status: Int
                let code: String
                let message: String
            }

            let newWiki: String
            let label: String
            let wikis: [String]
            let groups: [Group]
            let offered: [String]
            let defaults: [Workspaces.Default]
            let allHaveWikis: AllHaveWikis
            let refusal: Refusal
        }

        /// The WIKI_CREATE owner-request card (design §3.6).
        struct WikiCreateCard: Decodable {
            struct Labels: Decodable, Equatable {
                let repository: String
                let readsFrom: String
                let maintenance: String
            }

            struct Case: Decodable {
                struct Request: Decodable {
                    let repoUrlNorm: String?
                    let workspaceId: String?
                }

                struct Facts: Decodable, Equatable {
                    let repository: String?
                    let readsFrom: String?
                    let offline: Bool
                    let maintenance: String
                }

                let request: Request
                let facts: Facts
            }

            let labels: Labels
            let buttons: [String]
            let cases: [Case]
        }
    }

    private struct DocsFixture: Decodable {
        struct Docs: Decodable {
            struct Directory: Decodable {
                let read: WikiDocsDirectory
            }

            let directory: Directory
        }

        struct Plan: Decodable {
            struct State: Decodable {
                struct Spec: Decodable {
                    let confirmed: String?
                    let draft: String?
                    let proposals: Bool
                    let job: String?
                    let runnerOnline: Bool?
                }

                let spec: Spec
            }

            let versions: [String: WikiPlanVersion]
            let proposals: [WikiPlanProposal]
            let jobs: [String: WikiPlanJob]
            let states: [String: State]
        }

        let now: String
        let docs: Docs
        let plan: Plan
    }

    private func startFixture() throws -> StartFixture {
        try JSONDecoder().decode(StartFixture.self, from: Data(contentsOf: find(Self.startFixture)))
    }

    private func docsFixture() throws -> DocsFixture {
        try JSONDecoder().decode(DocsFixture.self, from: Data(contentsOf: find(Self.docsFixture)))
    }

    private func state(_ spec: DocsFixture.Plan.State.Spec, _ plan: DocsFixture.Plan) -> WikiPlanState {
        WikiPlanState(spaceId: "sp1", confirmed: spec.confirmed.flatMap { plan.versions[$0] },
                      draft: spec.draft.flatMap { plan.versions[$0] },
                      proposals: spec.proposals ? plan.proposals : [], job: spec.job.flatMap { plan.jobs[$0] })
    }

    /// The context the fixture's cards are read with: `directory` once a version is confirmed.
    private func context(_ spec: DocsFixture.Plan.State.Spec, start: StartFixture, docs: DocsFixture, maintenance: Bool? = nil,
                         readsFrom: String?) throws -> WikiStartLogic.Context {
        WikiStartLogic.Context(now: try XCTUnwrap(RelativeTime.parse(start.now)), maintenance: maintenance ?? start.context.maintenance,
                               readsFrom: readsFrom, runnerOnline: spec.runnerOnline,
                               directory: spec.confirmed != nil ? docs.docs.directory.read : nil)
    }

    private func zone(_ start: StartFixture) throws -> TimeZone {
        try XCTUnwrap(TimeZone(identifier: start.timeZone))
    }

    // MARK: the card of every state of the plan

    func testEveryStateOfThePlanDrawsTheFixturesCard() throws {
        let start = try startFixture()
        let docs = try docsFixture()
        XCTAssertEqual(start.states.keys.sorted(), docs.plan.states.keys.sorted(), "the card of every state the plan has")
        XCTAssertEqual(start.now, docs.now)
        XCTAssertEqual(start.states.count, 17)
        for (name, spec) in docs.plan.states.mapValues(\.spec).sorted(by: { $0.key < $1.key }) {
            let card = WikiStartLogic.card(state(spec, docs.plan), context: try context(spec, start: start, docs: docs, readsFrom: start.context.readsFrom),
                                           timeZone: try zone(start))
            XCTAssertEqual(spelled(card), try XCTUnwrap(start.states[name]), name)
        }
    }

    func testItAsksForTheRepositoryWhenMaintenanceIsOffAndNothingIsOnItsWay() throws {
        let start = try startFixture()
        let docs = try docsFixture()
        let spec = try XCTUnwrap(docs.plan.states["none"]).spec
        let card = WikiStartLogic.card(state(spec, docs.plan),
                                       context: try context(spec, start: start, docs: docs, maintenance: false, readsFrom: start.context.readsFrom))
        XCTAssertEqual(spelled(card), start.maintenanceOff)
    }

    func testItSaysItIsConnectedWhileTheWorkspacesNameIsNotRead() throws {
        let start = try startFixture()
        let docs = try docsFixture()
        let spec = try XCTUnwrap(docs.plan.states["noneDrafting"]).spec
        let card = WikiStartLogic.card(state(spec, docs.plan), context: try context(spec, start: start, docs: docs, readsFrom: nil))
        XCTAssertEqual(spelled(card), start.readsFromUnknown)
    }

    func testItNeverOffersMoreThanOnePrimaryButton() throws {
        let start = try startFixture()
        for card in Array(start.states.values) + [start.first.workspaces, start.first.noRepository] {
            XCTAssertLessThanOrEqual(card.steps.filter { $0.action?.primary == true }.count, 1)
        }
    }

    func testExactlyOneStepIsInMotion() throws {
        for (name, card) in try startFixture().states {
            XCTAssertEqual(card.steps.filter { $0.state == "wait" || $0.state == "run" }.count, 1, name)
        }
    }

    /// `plan.states` with a draft all stand on a version in force, so the fixture's `firstDrafts` hold the second
    /// step of a FIRST draft: the same cases on every client.
    func testEveryFirstDraftDrawsTheFixturesCard() throws {
        let start = try startFixture()
        let docs = try docsFixture()
        XCTAssertEqual(start.firstDrafts.count, 3)
        for (name, row) in start.firstDrafts.sorted(by: { $0.key < $1.key }) {
            let card = WikiStartLogic.card(state(row.spec, docs.plan),
                                           context: try context(row.spec, start: start, docs: docs, readsFrom: start.context.readsFrom),
                                           timeZone: try zone(start))
            XCTAssertEqual(spelled(card), row.card, name)
        }
    }

    func testDocumentsWhoseWritingWaitsForAnOfflineRunnerSendTheReaderToTheRunners() throws {
        let start = try startFixture()
        let docs = try docsFixture()
        let row = start.writingOffline
        let card = WikiStartLogic.card(state(row.spec, docs.plan),
                                       context: try context(row.spec, start: start, docs: docs, readsFrom: start.context.readsFrom),
                                       timeZone: try zone(start))
        XCTAssertEqual(spelled(card), row.card)
    }

    /// The same three, step by step, with what the fixture does not say: the Plan card's own sentence over a version
    /// in force, and how each reads out of the job.
    func testAFirstDraftsSecondStepSaysWhereItHasGotTo() throws {
        let start = try startFixture()
        let docs = try docsFixture()
        let now = try XCTUnwrap(RelativeTime.parse(start.now))
        let context = WikiStartLogic.Context(now: now, maintenance: true, readsFrom: "shop-cli @ SG · build-01", runnerOnline: true, directory: nil)

        let draft = try XCTUnwrap(docs.plan.versions["v2"])
        let ready = WikiStartLogic.card(WikiPlanState(spaceId: "sp1", confirmed: nil, draft: draft, proposals: [], job: nil), context: context).steps[1]
        XCTAssertEqual(ready.state, .wait)
        XCTAssertEqual(ready.text, "Draft v2 passed the plan check and waits for you. Documents are written once you confirm it.")
        XCTAssertEqual(ready.note, "\(draft.categories?.count ?? 0) categories · \(draft.docs?.count ?? 0) documents")
        XCTAssertEqual(ready.action, WikiStartLogic.Action(label: WikiPlanCopy.open, to: .plan, primary: true))

        let job = try XCTUnwrap(docs.plan.jobs["failed"])
        let failed = WikiStartLogic.card(WikiPlanState(spaceId: "sp1", confirmed: nil, draft: nil, proposals: [], job: job), context: context).steps[1]
        XCTAssertEqual(failed.state, .wait)
        XCTAssertEqual(failed.text, "\(WikiPlanCopy.jobFailed). \(job.error ?? "") Nothing was saved.")
        XCTAssertEqual(failed.action, WikiStartLogic.Action(label: WikiPlanCopy.open, to: .plan, primary: true))
        XCTAssertEqual(WikiPlanLogic.draftFailedText(job, state: WikiPlanState(spaceId: "sp1", confirmed: docs.plan.versions["v1"], draft: nil, proposals: [], job: job)),
                       "\(WikiPlanCopy.redraftFailed). \(job.error ?? "") v1 stays in force.", "the Plan card's sentence, whole")

        // A job that has been made and whose run has not started: drafting, with nothing yet to count.
        let unstarted = try XCTUnwrap(docs.plan.jobs["notStarted"])
        let drafting = WikiStartLogic.card(WikiPlanState(spaceId: "sp1", confirmed: nil, draft: nil, proposals: [], job: unstarted), context: context).steps[1]
        XCTAssertEqual(drafting.state, .run)
        XCTAssertEqual(drafting.text, "Drafting the plan · waiting for its run to start")
        XCTAssertEqual(drafting.note, WikiStartCopy.draftingNote)
    }

    /// A build that stopped short of a version no longer in force says nothing of its writing.
    func testAStoppedBuildCountsOnlyForTheVersionInForce() throws {
        let docs = try docsFixture()
        let stopped = try XCTUnwrap(docs.plan.jobs["writingStopped"])
        let state = WikiPlanState(spaceId: "sp1", confirmed: try XCTUnwrap(docs.plan.versions["v1"]), draft: nil, proposals: [], job: stopped)
        XCTAssertEqual(WikiPlanLogic.failedBuild(state)?.id, stopped.id)
        XCTAssertNil(WikiPlanLogic.failedBuild(WikiPlanState(spaceId: "sp1", confirmed: nil, draft: nil, proposals: [], job: stopped)))
        XCTAssertNil(WikiPlanLogic.failedBuild(WikiPlanState(spaceId: "sp1", confirmed: try XCTUnwrap(docs.plan.versions["v2"]), draft: nil, proposals: [], job: stopped)))
    }

    /// A job's start is no event (`realtime.publishedWhen`), so the plan is read again while one is queued or running.
    func testThePlanIsReadAgainWhileAJobIsOnItsWay() throws {
        let jobs = try docsFixture().plan.jobs
        let underWay = jobs.filter { WikiPlanLogic.jobUnderWay(WikiPlanState(spaceId: "sp1", confirmed: nil, draft: nil, proposals: [], job: $0.value)) }
        XCTAssertEqual(underWay.keys.sorted(), ["drafting", "notStarted", "queued", "writing", "writingQueued"])
        XCTAssertFalse(WikiPlanLogic.jobUnderWay(nil))
        assertSays(try web("src/web/src/lib/queries.ts"), "return state === 'queued' || state === 'running' ? 30_000 : false;", in: "queries.ts")
        let home = try native("Views/WikiScreens.swift")
        assertOrder(home, [".task(id: WikiPlanLogic.jobUnderWay(wiki.plan)) {", "while !Task.isCancelled, WikiPlanLogic.jobUnderWay(wiki.plan) {",
                           "await VisibilityGate.app.pause(30)", "await wiki.loadPlan()"], "the home while a job is on its way")
    }

    // MARK: an account with no wiki

    func testTheCardOfAnAccountWithNoWiki() throws {
        let start = try startFixture()
        XCTAssertEqual(spelled(WikiStartLogic.firstCard(workspaces: true)), start.first.workspaces)
        XCTAssertEqual(spelled(WikiStartLogic.firstCard(workspaces: false)), start.first.noRepository)
        XCTAssertNil(start.first.noRepository.steps[0].action)
    }

    // MARK: whether it is drawn

    func testItStandsUntilThereIsSomethingToRead() throws {
        for row in try startFixture().shown {
            XCTAssertEqual(WikiStartLogic.shown(written: row.written, topics: row.topics), row.shown, "\(row)")
        }
    }

    // MARK: the workspaces the two forms offer

    private func choices(_ start: StartFixture) -> [WikiStartLogic.WorkspaceChoice] {
        start.workspaces.choices.map {
            WikiStartLogic.WorkspaceChoice(id: $0.id, label: $0.label, repository: $0.repository, repoUrl: $0.repoUrl, online: $0.online)
        }
    }

    func testARepositoryIsNamedAsTheServerNamesIt() throws {
        for row in try startFixture().repositories {
            XCTAssertEqual(WikiStartLogic.repositoryName(row.url), row.repository, row.url)
            XCTAssertEqual(row.repository.map(WikiStartLogic.repositoryTitle), row.title, row.url)
        }
        XCTAssertNil(WikiStartLogic.repositoryName(nil))
    }

    func testChoicesAreOfferedUpFirstThenByName() throws {
        let start = try startFixture()
        XCTAssertEqual(WikiStartLogic.choicesInOrder(choices(start)).map(\.id), start.workspaces.inOrder)
    }

    func testTwoChoicesOfOneNameKeepTheirOrder() {
        let twins = ["b", "a", "c"].map { WikiStartLogic.WorkspaceChoice(id: $0, label: "same · build-01", repository: nil, repoUrl: nil, online: true) }
        XCTAssertEqual(WikiStartLogic.choicesInOrder(twins).map(\.id), ["b", "a", "c"], "the web's sort is stable")
    }

    func testChoicesGroupByRepositoryAndOneWithNoneIsLeftOut() throws {
        let start = try startFixture()
        let groups = WikiStartLogic.repositoryGroups(choices(start))
        XCTAssertEqual(groups.map(\.repository), start.workspaces.groups.map(\.repository))
        XCTAssertEqual(groups.map { $0.choices.map(\.id) }, start.workspaces.groups.map(\.choices))
    }

    func testAFormOpensOnTheWorkspaceInUseElseTheReadersIfItIsUpElseTheFirstThatIs() throws {
        let start = try startFixture()
        let all = choices(start)
        for row in start.workspaces.defaults {
            XCTAssertEqual(WikiStartLogic.workspaceDefault(all, current: row.current, from: row.from), row.pick, "\(row)")
        }
        XCTAssertEqual(WikiStartLogic.workspaceDefault(all.filter { !$0.online }, current: nil, from: nil), start.workspaces.allOffline)
        XCTAssertEqual(WikiStartLogic.workspaceDefault([], current: nil, from: nil), start.workspaces.none)
    }

    // MARK: the Create wiki form once a wiki exists (design §3.4)

    func testItNamesTheWayToAnotherWikiAndTheMarkOfARepositoryThatHasOne() throws {
        let start = try startFixture()
        XCTAssertEqual(WikiStartCopy.newWiki, start.hasWiki.newWiki)
        XCTAssertEqual(WikiStartCopy.hasAWiki, start.hasWiki.label)
    }

    func testARepositoryThatHasAWikiIsGreyedAsAWholeGroup() throws {
        let start = try startFixture()
        let groups = WikiStartLogic.repositoryGroups(choices(start), wikis: start.hasWiki.wikis)
        XCTAssertEqual(groups.map(\.repository), start.hasWiki.groups.map(\.repository))
        XCTAssertEqual(groups.map { $0.choices.map(\.id) }, start.hasWiki.groups.map(\.choices))
        XCTAssertEqual(groups.map(\.hasWiki), start.hasWiki.groups.map(\.hasWiki))
    }

    func testItOffersOnlyRepositoriesWithNoWikiAndOpensOnOneOfThem() throws {
        let start = try startFixture()
        let left = WikiStartLogic.createOffered(WikiStartLogic.repositoryGroups(choices(start), wikis: start.hasWiki.wikis))
        XCTAssertEqual(left.map(\.id), start.hasWiki.offered)
        for row in start.hasWiki.defaults {
            XCTAssertEqual(WikiStartLogic.workspaceDefault(left, current: row.current, from: row.from), row.pick, "\(row)")
        }
    }

    func testItOffersNothingWhenEveryRepositoryHasAWiki() throws {
        let start = try startFixture()
        let all = start.hasWiki.allHaveWikis
        let left = WikiStartLogic.createOffered(WikiStartLogic.repositoryGroups(choices(start), wikis: all.wikis))
        XCTAssertEqual(left.map(\.id), all.offered)
        XCTAssertEqual(WikiStartLogic.workspaceDefault(left, current: nil, from: nil), all.pick)
    }

    func testItGreysNothingWithoutAWiki() throws {
        let start = try startFixture()
        XCTAssertTrue(WikiStartLogic.repositoryGroups(choices(start)).allSatisfy { !$0.hasWiki })
        XCTAssertTrue(WikiStartLogic.repositoryGroups(choices(start), wikis: [nil, ""]).allSatisfy { !$0.hasWiki })
    }

    /// A submission that meets a wiki made meanwhile shows the server's message, read as every wiki refusal is.
    func testAWikiMadeMeanwhileIsTheServersRefusal() throws {
        let refusal = try startFixture().hasWiki.refusal
        XCTAssertEqual(refusal.status, 409)
        XCTAssertEqual(refusal.code, "WIKI_SPACE_EXISTS")
        let body = String(decoding: try JSONSerialization.data(withJSONObject: ["code": refusal.code, "message": refusal.message]), as: UTF8.self)
        let error = APIError.http(status: refusal.status, body: body)
        XCTAssertEqual(APIClient.refusalCode(error), refusal.code)
        XCTAssertEqual(APIClient.refusalString(error, "message"), refusal.message, "the form shows the server's message (WikiModel.refusal)")
    }

    /// Change settings… opens the form on the filing workspace only when the form offers it.
    func testChangeSettingsOpensOnTheFilingWorkspaceWhenItIsOffered() throws {
        let start = try startFixture()
        let left = WikiStartLogic.createOffered(WikiStartLogic.repositoryGroups(choices(start), wikis: start.hasWiki.wikis))
        XCTAssertEqual(WikiStartLogic.asked(left, workspaceId: "ba"), "ba")
        XCTAssertNil(WikiStartLogic.asked(left, workspaceId: "sg"), "a repository with a wiki is not offered")
        XCTAssertNil(WikiStartLogic.asked(left, workspaceId: nil))
    }

    // MARK: the WIKI_CREATE card (design §3.6)

    func testTheCardSaysWhatItMakesUnderTheFixturesLabelsWithItsThreeButtons() throws {
        let card = try startFixture().wikiCreateCard
        XCTAssertEqual(StartFixture.WikiCreateCard.Labels(repository: WikiStartCopy.cardRepository, readsFrom: WikiStartCopy.cardReadsFrom,
                                                          maintenance: WikiStartCopy.cardMaintenance), card.labels)
        XCTAssertEqual([OwnerRequests.primaryLabel(.wikiCreate), WikiStartCopy.changeSettings, WikiStartCopy.notHere], card.buttons)
        XCTAssertEqual(WikiStartCopy.create, OwnerRequests.primaryLabel(.wikiCreate))
    }

    func testTheCardReadsEachRequestAgainstTheWorkspaces() throws {
        let start = try startFixture()
        for row in start.wikiCreateCard.cases {
            let facts = WikiStartLogic.cardFacts(repoUrlNorm: row.request.repoUrlNorm, workspaceId: row.request.workspaceId, choices: choices(start))
            XCTAssertEqual(StartFixture.WikiCreateCard.Case.Facts(repository: facts.repository, readsFrom: facts.readsFrom,
                                                                 offline: facts.offline, maintenance: facts.maintenance),
                           row.facts, "\(row.request.repoUrlNorm ?? "-") from \(row.request.workspaceId ?? "-")")
        }
    }

    func testTheCardReadsAWikiCreateRequestFromTheWire() throws {
        let json = #"{"id":"r1","kind":"WIKI_CREATE","state":"DONE","title":"Create a wiki for billing-api?","why":"w","askedBySessionId":"s1","repoUrlNorm":"github.com/acme/billing-api","workspaceId":"ba","answer":{"spaceId":"sp1","name":"billing-api"},"createdAt":"2026-11-12T00:00:00.000Z"}"#
        let request = try JSONDecoder().decode(OwnerRequest.self, from: Data(json.utf8))
        XCTAssertEqual(request.kind, .wikiCreate)
        XCTAssertEqual(request.repoUrlNorm, "github.com/acme/billing-api")
        XCTAssertEqual(request.workspaceId, "ba")
        XCTAssertEqual(request.answer?.name, "billing-api")
        XCTAssertEqual(OwnerRequests.outcomeLine(request, runner: ""), "Created the wiki billing-api")
    }

    /// The workspaces as this client reads them: the list's `repoUrl`, its runner's name, and offline only when the
    /// runner read says so. `GET /agents` is `GET /workspaces` by another name (`workspaces.controller.ts`).
    func testChoicesAreReadFromTheWorkspaceList() throws {
        let sg = "0196e300-0000-7000-8000-0000000000a1"
        let down = "0196e300-0000-7000-8000-0000000000d2"
        let agents = try JSONDecoder().decode([Agent].self, from: Data(#"""
            [{"id":"\#(sg)","name":"shop-cli @ SG","runnerId":"\#(PublicID.toPublic(down))","repoUrl":"git@github.com:acme/shop-cli.git"},
             {"id":"us","name":"shop-cli @ US","runnerId":"up","repoUrl":"https://github.com/acme/shop-cli"},
             {"id":"no","name":"notes","runnerId":"unread","repoUrl":null},
             {"id":"old","name":"from an older server"}]
            """#.utf8))
        let read = WikiStartLogic.choices(agents, runnerNames: [PublicID.toPublic(down): "build-02", "up": "build-01"],
                                          runnerOnline: [down: false, "up": true])
        XCTAssertEqual(read, [
            WikiStartLogic.WorkspaceChoice(id: sg, label: "shop-cli @ SG · build-02", repository: "github.com/acme/shop-cli",
                                           repoUrl: "git@github.com:acme/shop-cli.git", online: false),
            WikiStartLogic.WorkspaceChoice(id: "us", label: "shop-cli @ US · build-01", repository: "github.com/acme/shop-cli",
                                           repoUrl: "https://github.com/acme/shop-cli", online: true),
            WikiStartLogic.WorkspaceChoice(id: "no", label: "notes", repository: nil, repoUrl: nil, online: true),
            WikiStartLogic.WorkspaceChoice(id: "old", label: "from an older server", repository: nil, repoUrl: nil, online: true),
        ])
        XCTAssertEqual(WikiStartLogic.optionLabel(read[0]), "shop-cli @ SG · build-02 · offline")
        XCTAssertEqual(WikiStartLogic.optionLabel(read[1]), "shop-cli @ US · build-01")
    }

    /// Set up maintenance offers this wiki's workspaces and always the one in use; a wiki with none in it, every one.
    func testSetUpOffersThisWikisWorkspaces() throws {
        let start = try startFixture()
        let all = choices(start)
        let row = { (id: String, inWiki: Bool) in WikiSpaceWorkspaceRow(id: id, name: id, runner: nil, inWiki: inWiki) }
        let members = WikiSpaceWorkspaces(workspaces: [row("sg", true), row("eu", true), row("us", false)], addable: [row("no", false)])

        XCTAssertEqual(WikiStartLogic.setUpOffered(all, members: members, current: nil).map(\.id), ["sg", "eu"], "up first, then by name")
        XCTAssertEqual(WikiStartLogic.setUpOffered(all, members: members, current: "ba").map(\.id), ["ba", "sg", "eu"], "the one in use stays")
        XCTAssertEqual(WikiStartLogic.setUpOffered(all, members: nil, current: nil).map(\.id), start.workspaces.inOrder, "not read yet: all of them")
        let leftOut = WikiSpaceWorkspaces(workspaces: [row("us", false)], addable: [])
        XCTAssertEqual(WikiStartLogic.setUpOffered(all, members: leftOut, current: nil).map(\.id), start.workspaces.inOrder, "none in the wiki: all of them")

        let offered = WikiStartLogic.setUpOffered(all, members: members, current: nil)
        XCTAssertEqual(WikiStartLogic.opensOn(offered, current: nil, from: "gone"), "sg")
        XCTAssertEqual(WikiStartLogic.opensOn(offered, current: nil, from: "eu"), "sg", "the reader's, but its runner is offline")
        XCTAssertEqual(WikiStartLogic.opensOn(offered, current: "eu", from: "sg"), "eu", "the one in use, offline or not")
    }

    /// Ids meet in either spelling: a space's settings keep a workspace's id as it was stored, the lists answer in the
    /// other spelling, and the picker's tags are the list's.
    func testIdsAreComparedAcrossTheirTwoSpellings() throws {
        let uuid = "0196e300-0000-7000-8000-0000000000a1"
        let listed = PublicID.toPublic(uuid)
        let agents = try JSONDecoder().decode([Agent].self, from: Data(#"[{"id":"\#(listed)","name":"shop-cli @ SG","runnerId":"r1"}]"#.utf8))
        let offered = [WikiStartLogic.WorkspaceChoice(id: listed, label: "shop-cli @ SG", repository: nil, repoUrl: nil, online: false),
                       WikiStartLogic.WorkspaceChoice(id: "us", label: "shop-cli @ US", repository: nil, repoUrl: nil, online: true)]
        XCTAssertEqual(WikiStartLogic.opensOn(offered, current: uuid, from: nil), listed)
        XCTAssertEqual(WikiStartLogic.opensOn(offered, current: "gone", from: nil), "gone", "kept, as the web keeps a workspace it cannot find")
        XCTAssertEqual(WikiStartLogic.workspaceLabel(uuid, agents: agents, runnerNames: ["r1": "build-01"]), "shop-cli @ SG · build-01")
        XCTAssertNil(WikiStartLogic.workspaceLabel("gone", agents: agents, runnerNames: [:]))
        XCTAssertNil(WikiStartLogic.workspaceLabel(nil, agents: agents, runnerNames: [:]))
        let members = WikiSpaceWorkspaces(workspaces: [WikiSpaceWorkspaceRow(id: uuid, name: "sg", runner: nil, inWiki: true)], addable: [])
        XCTAssertEqual(WikiStartLogic.setUpOffered(offered, members: members, current: nil).map(\.id), [listed])
    }

    /// What the form that makes a wiki says under its picker and what it sends: the repository's last segment for a
    /// title, the URL as the workspace records it, and maintenance on — all of history as null, not a key left out.
    func testCreateWikiSaysWhatItWillDescribeAndSendsIt() throws {
        let start = try startFixture()
        let sg = try XCTUnwrap(choices(start).first { $0.id == "sg" })
        XCTAssertEqual(WikiStartLogic.createWorkspaceNote(sg),
                       "This wiki will describe github.com/acme/shop-cli. The server reads the repository through this workspace’s runner.")
        XCTAssertEqual(WikiStartLogic.createWorkspaceNote(nil), WikiModeCopy.repoFromNote)
        let maintenance = WikiMaintenanceUpdate(enabled: true, workspaceId: "sg", dailyRunLimit: 8, lookbackDays: .some(14))
        let request = try XCTUnwrap(WikiStartLogic.createRequest(sg, maintenance: maintenance))
        XCTAssertEqual(request, WikiSpaceCreate(title: "shop-cli", repoUrl: "https://github.com/acme/shop-cli.git", maintenance: maintenance))
        XCTAssertNil(WikiStartLogic.createRequest(try XCTUnwrap(choices(start).first { $0.id == "no" }), maintenance: maintenance))

        let body = { (request: WikiSpaceCreate) throws -> [String: Any] in
            try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        }
        let sent = try body(request)
        XCTAssertEqual(Set(sent.keys), ["title", "repoUrl", "maintenance"])
        XCTAssertEqual(sent["title"] as? String, "shop-cli")
        XCTAssertEqual(sent["repoUrl"] as? String, "https://github.com/acme/shop-cli.git")
        let keys = try XCTUnwrap(sent["maintenance"] as? [String: Any])
        XCTAssertEqual(Set(keys.keys), ["enabled", "workspaceId", "dailyRunLimit", "lookbackDays"])
        XCTAssertEqual(keys["enabled"] as? Bool, true)
        XCTAssertEqual(keys["workspaceId"] as? String, "sg")
        XCTAssertEqual(keys["dailyRunLimit"] as? Int, 8)
        XCTAssertEqual(keys["lookbackDays"] as? Int, 14)

        let allOfIt = WikiMaintenanceUpdate(enabled: true, workspaceId: "sg", dailyRunLimit: 8, lookbackDays: .some(nil))
        let all = try body(WikiSpaceCreate(title: "shop-cli", repoUrl: "r", maintenance: allOfIt))
        XCTAssertTrue((all["maintenance"] as? [String: Any])?["lookbackDays"] is NSNull, "all of history is sent as null")
    }

    // MARK: the words

    func testEveryWordIsDeclaredOnTheWeb() throws {
        let lib = try web(Self.lib)
        let constants: [(String, String)] = [
            ("WIKI_START_TITLE", WikiStartCopy.title), ("WIKI_START_FIRST_TITLE", WikiStartCopy.firstTitle),
            ("WIKI_START_LEAD", WikiStartCopy.lead), ("WIKI_START_FIRST_LEAD", WikiStartCopy.firstLead),
            ("WIKI_START_CONNECT", WikiStartCopy.connect), ("WIKI_START_CONNECT_FIRST", WikiStartCopy.connectFirst),
            ("WIKI_START_CONFIRM", WikiStartCopy.confirm), ("WIKI_START_WRITE", WikiStartCopy.write),
            ("WIKI_START_CONNECT_TEXT", WikiStartCopy.connectText), ("WIKI_START_CONNECT_FIRST_TEXT", WikiStartCopy.connectFirstText),
            ("WIKI_START_NO_REPOSITORY", WikiStartCopy.noRepository), ("WIKI_START_WRITE_TODO", WikiStartCopy.writeTodo),
            ("WIKI_START_CONNECTED", WikiStartCopy.connected), ("WIKI_START_DRAFTING_NOTE", WikiStartCopy.draftingNote),
            ("WIKI_START_NO_PLAN", WikiStartCopy.noPlan), ("WIKI_START_NOT_WRITTEN", WikiStartCopy.notWritten),
            ("WIKI_CREATE", WikiStartCopy.create), ("WIKI_CREATE_OPEN", WikiStartCopy.createOpen),
            ("WIKI_WORKSPACE_OFFLINE", WikiStartCopy.workspaceOffline),
            ("WIKI_NEW", WikiStartCopy.newWiki), ("WIKI_HAS_A_WIKI", WikiStartCopy.hasAWiki),
            ("WIKI_CREATE_REPOSITORY", WikiStartCopy.cardRepository), ("WIKI_CREATE_READS_FROM", WikiStartCopy.cardReadsFrom),
            ("WIKI_CREATE_MAINTENANCE", WikiStartCopy.cardMaintenance), ("WIKI_CREATE_CHANGE_SETTINGS", WikiStartCopy.changeSettings),
            ("WIKI_CREATE_NOT_HERE", WikiStartCopy.notHere),
        ]
        for (name, value) in constants { assertDeclares(lib, name, value, in: Self.lib) }

        // The two that name the drafter, each the same template at both ends.
        let drafter = { (words: String) in words.replacingOccurrences(of: WikiPlanCopy.drafterServer, with: "${WIKI_PLAN_DRAFTER_SERVER}") }
        assertSays(lib, "WIKI_START_CONFIRM_TODO = `\(drafter(WikiStartCopy.confirmTodo))`;", in: Self.lib)
        assertSays(lib, "WIKI_CREATE_NOTE = `\(drafter(WikiStartCopy.createNote))`;", in: Self.lib)

        // The sentences built around a value.
        assertSays(lib, "(workspace ? `\(WikiStartCopy.readsFrom("${workspace}"))` : WIKI_START_CONNECTED)", in: Self.lib)
        XCTAssertEqual(WikiStartCopy.readsFrom(nil), WikiStartCopy.connected)
        assertSays(lib, "`v${version} confirmed${day ? ` ${day}` : ''} · ${wikiCount(documents)} ${documents === 1 ? 'document' : 'documents'}`",
                   in: Self.lib)
        XCTAssertEqual(WikiStartCopy.confirmed(version: 1, day: "Nov 2", documents: 34), "v1 confirmed Nov 2 · 34 documents")
        XCTAssertEqual(WikiStartCopy.confirmed(version: 2, day: nil, documents: 1), "v2 confirmed · 1 document")
        XCTAssertEqual(WikiStartCopy.confirmed(version: 3, day: "Nov 2", documents: 1_200), "v3 confirmed Nov 2 · 1,200 documents")
        assertSays(lib, "`\(WikiStartCopy.createRepositoryNote("${repository}"))`", in: Self.lib)
        assertSays(lib, "`Draft queued · ${WIKI_PLAN_QUEUED_TEXT}.`", in: Self.lib)
        XCTAssertEqual(WikiStartCopy.draftQueued, "Draft queued · \(WikiPlanCopy.queuedText).")
        assertSays(lib, "`Drafting the plan · ${WIKI_PLAN_WRITING_SOON}`", in: Self.lib)
        XCTAssertEqual(WikiStartCopy.draftingSoon, "Drafting the plan · \(WikiPlanCopy.writingSoon)")
        assertSays(lib, "`\(WikiStartCopy.drafting(attempt: 7, of: 8, started: "${wikiAgo(open.startedAt, context.now)}").replacingOccurrences(of: "attempt 7 of 8", with: "attempt ${open.attempt ?? 1} of ${open.attemptsMax}"))`",
                   in: Self.lib)

        // The sheet's answer is the iOS frame's own word: the web's dialog says `Create wiki` on its button.
        let board = try web(Self.board)
        assertSays(board, "<b>\(WikiStartCopy.create)</b></div><span class=\"io-glass r io-sheetbtn go\">\(WikiStartCopy.createAnswer)</span>", in: Self.board)

        // What the Plan card's readings say, which the web's `wikiStart.ts` takes from `wikiPlanCard`.
        let plan = try web(Self.planLib)
        assertSays(lib, "if (look === 'draftFailed' || look === 'draftReady') {", in: Self.lib)
        assertSays(lib, "const card = wikiPlanCard(look, state,", in: Self.lib)
        assertSays(plan, "text: `${state.confirmed || state.draft ? WIKI_PLAN_REDRAFT_FAILED : WIKI_PLAN_JOB_FAILED}. ${wikiPlanFailedText(job, state)}`,", in: Self.planLib)
        assertSays(plan, "text: `Draft v${draft.version} ${toLook === 0 ? 'passed the plan check and waits for you' : `is ready for review, with ${wikiCount(toLook)} to look at`}. Documents are written once you confirm it.`,", in: Self.planLib)
        assertSays(plan, "note: `${plural(draft.categories.length, 'category', 'categories')} · ${plural(draft.docs.length, 'document', 'documents')}`,",
                   in: Self.planLib)
        assertSays(plan, "job && job.kind === 'build' && job.state === 'failed' && state.confirmed && job.version === state.confirmed.version ? job : null;",
                   in: Self.planLib)
    }

    // MARK: the wiring

    /// The card, block for block in the web's order: the title and its lead, then a step's mark, title, text, progress,
    /// note and button; at most one is prominent, and the mark wears the Wiki's colours.
    func testTheCardDrawsTheWebsBlocksInItsOrder() throws {
        let card = try web(Self.card)
        assertOrder(card, ["<b>{card.title}</b>", "<span>{card.lead}</span>",
                           "{step.state === 'done' ? <CheckOutlined className=\"ic\" /> : index + 1}",
                           "<span className=\"wk-start-t\">{step.title}</span>", "<div className=\"wk-start-d\">{step.text}</div>",
                           "{step.progress && (", "{WIKI_PLAN_WRITING_NOW} <b>{step.progress.now}</b>", "{step.note && ", "{step.action && ("],
                    "the web's card")
        assertSays(card, "variant={step.action.primary ? 'primary' : 'default'}", in: Self.card)

        let view = try native("Views/WikiView.swift")
        let section = try slice(view, from: "struct WikiStartSection: View {", to: "private struct WikiStartMark: View {")
        assertOrder(section, ["Text(card.title)", "Text(card.lead)", "WikiStartMark(state: step.state, number: number)", "Text(step.title)",
                              "Text(step.text)", "if let progress = step.progress {", "ProgressView(value: Double(progress.done), total: Double(max(1, progress.total)))",
                              "Text(WikiPlanCopy.writingNow)", "if let note = step.note {", "if let action = step.action { button(action) }"],
                    "the native card")
        assertOrder(section, ["if action.primary {", ".buttonStyle(.borderedProminent)", "} else {", ".buttonStyle(.bordered)"],
                    "at most one prominent button")
        assertSays(section, ".disabled(busy && action.to == .draft)", in: "WikiView.swift")
        let mark = try slice(view, from: "private struct WikiStartMark: View {", to: "struct WikiFirstStartPage: View {")
        assertOrder(mark, ["case .done: return WikiPalette.color(.green).opacity(0.12)", "case .wait: return WikiPalette.color(.amber)",
                           "case .run:  return WikiPalette.color(.blue)", "if state == .done {", "Image(systemName: \"checkmark\")", "Text(\"\\(number)\")"],
                    "a step's mark")
    }

    /// The home draws the card from the plan as the web does — nothing until the plan is in — above a plan's categories,
    /// and alone with nothing listed; each press does what `WikiStartCard.tsx` does: the form and a draft where the reader
    /// is, and only the plan and the runners elsewhere.
    func testAStepsButtonDoesWhatTheWebsDoes() throws {
        let card = try web(Self.card)
        assertSays(card, "if (!plan.data) return null;", in: Self.card)
        assertSays(card, "if (to === 'setUp') return setSettingUp(true);", in: Self.card)
        assertSays(card, "if (to === 'plan') return navigate(wikiPlanPath(space.slug));", in: Self.card)
        assertSays(card, "if (to === 'runners') return navigate('/infrastructure');", in: Self.card)
        assertSays(card, "const answer = await draft.mutateAsync(undefined);", in: Self.card)
        assertSays(card, "message.success(answer.created ? WIKI_PLAN_REDRAFT_ASKED : WIKI_PLAN_REDRAFT_ALREADY);", in: Self.card)
        assertSays(card, "message.error(\"\(WikiCopy.planDraftFailed)\"", in: Self.card)

        let screens = try native("Views/WikiScreens.swift")
        let home = try slice(screens, from: "struct WikiHomeView: View {", to: "struct WikiHomePlaceholder: View {")
        assertOrder(home, ["guard let plan = wiki.plan else { return nil }", "WikiStartLogic.card(plan, context: WikiStartLogic.Context(",
                           "maintenance: maintenance.enabled", "readsFrom: model.wikiWorkspaceLabel(maintenance.workspaceId),",
                           "runnerOnline: model.wikiMaintenanceRunnerOnline(of: space), directory: wiki.docsDirectory"], "the card's reads")
        assertSays(home, "start: startCard(wiki, space: space, now: context.date), busy: wiki.busy,", in: "WikiScreens.swift")
        assertSays(home, "TimelineView(.periodic(from: .now, by: 60)) { context in", in: "WikiScreens.swift")
        let act = try slice(home, from: "private func act(_ to: WikiStartLogic.ActionTo, _ wiki: WikiModel) {", to: "private func draft(_ wiki: WikiModel) async {")
        assertOrder(act, ["case .setUp:   settingUp = true", "case .draft:   Task { await draft(wiki) }", "case .plan:    go(.plan)",
                          "case .runners: if let runner = model.wikiMaintenanceRunnerID { model.route(to: .runner(runner)) }"], "a step's press")
        XCTAssertFalse(act.contains("wikiSettings"), "Set up… opens where the reader is, not on the settings page")
        assertSays(home, "if let space = wiki.currentSpace { WikiSetUpSheet(wiki: wiki, space: space) }", in: "WikiScreens.swift")
        assertSays(home, "startAction: { to in act(to, wiki) })", in: "WikiScreens.swift")
        let draft = try slice(home, from: "private func draft(_ wiki: WikiModel) async {", to: "private func readShareLink(")
        assertOrder(draft, ["await wiki.redraftPlan(instructions: nil)", "draftRefusal = refusal",
                            "model.showToast(answer.created ? WikiPlanCopy.redraftAsked : WikiPlanCopy.redraftAlready)"], "the card's Draft plan")
        assertSays(home, ".alert(WikiCopy.planDraftFailed, isPresented:", in: "WikiScreens.swift")
    }

    /// Set up maintenance is one sheet, opened from Wiki settings and from the card; Create wiki is the same form. A
    /// refusal stays in it and says why, and the card moves on as the sheet closes.
    func testBothFormsAreTheOneForm() throws {
        let dialog = try web(Self.dialog)
        assertSays(dialog, "const inWiki = (members.data?.workspaces ?? []).filter((row) => row.inWiki);", in: Self.dialog)
        assertSays(dialog, "inWiki.length === 0 ? choices : choices.filter((choice) => sameId(choice.id, maintenance.workspaceId) || inWiki.some((row) => sameId(row.id, choice.id))),",
                   in: Self.dialog)
        assertSays(dialog, "const chosen = picked ?? wikiWorkspaceDefault(offered, { current, from: fromWorkspace(offered) });", in: Self.dialog)
        assertSays(dialog, "const chosen = picked ?? wikiWorkspaceDefault(offered, { current: asked, from: fromWorkspace(offered) });", in: Self.dialog)
        assertSays(dialog, "workspaceNote={choice?.repository ? wikiCreateRepositoryNote(choice.repository) : WIKI_REPO_FROM_NOTE}", in: Self.dialog)
        assertOrder(dialog, ["title: wikiRepositoryTitle(choice!.repository!),", "repoUrl: choice!.repoUrl!,", "maintenance,"], "what makes a wiki")

        let settings = try native("Views/WikiSettingsView.swift")
        assertSays(settings, ".sheet(isPresented: $settingUp) { WikiSetUpSheet(wiki: wiki, space: space) }", in: "WikiSettingsView.swift")
        let form = try slice(settings, from: "struct WikiMaintenanceForm: View {", to: "struct WikiSetUpSheet: View {")
        assertOrder(form, ["private var chosen: String? { choice.workspaceID ?? opensOn }", "Text(WikiStartLogic.optionLabel(workspace)).tag(Optional(workspace.id))",
                           "Picker(WikiModeCopy.repoFrom, selection: Binding(get: { chosen }, set: { id in",
                           "if let id, offeredIDs.contains(id) { choice.workspaceID = id }",
                           "if chosen == nil { Text(WikiModeCopy.noWorkspace).tag(String?.none) }",
                           "if let repository = group.repository, group.hasWiki {",
                           "Section(\"\\(repository) · \\(WikiStartCopy.hasAWiki)\") { greyed(group.choices) }",
                           "} else if let repository = group.repository {",
                           "Section(repository) { options(group.choices) }"], "the form's picker")
        assertSays(form, "private var offeredIDs: Set<String> { Set(groups.filter { !$0.hasWiki }.flatMap(\\.choices).map(\\.id)) }",
                   in: "WikiSettingsView.swift")
        let greyed = try slice(form, from: "private func greyed(", to: "var body: some View {")
        assertOrder(greyed, [".foregroundStyle(.secondary)", ".selectionDisabled()", ".disabled(true)"], "a repository that has a wiki")
        assertOrder(form, ["if let refusal {", "Text(refusal).foregroundStyle(.red)", "Button(submitLabel) {"], "the form's end")
        let answer = try slice(form, from: "Button(submitLabel) {", to: ".disabled(saving || chosen == nil || probed?.canTurnOn == false)")
        assertOrder(answer, ["answer.workspaceID = chosen", "refusal = await submit(answer)", "saving = false", "if refusal == nil { dismiss() }"],
                    "the form stays open on a refusal")
        let setUp = try slice(settings, from: "struct WikiSetUpSheet: View {", to: "struct WikiCreateSheet: View {")
        assertOrder(setUp, ["WikiStartLogic.setUpOffered(model.wikiWorkspaceChoices, members: wiki.spaceWorkspaces[space.id],",
                            "groups: [WikiStartLogic.WorkspaceGroup(repository: nil, choices: offered)],",
                            "opensOn: WikiStartLogic.opensOn(offered, current: current.workspaceId, from: wiki.fromWorkspaceID),",
                            "await wiki.updateSpace(space, WikiSpaceUpdate(maintenance: choice.maintenance))", "await wiki.loadPlan()",
                            "model.showToast(WikiCopy.settingsSaved)", "await wiki.loadSpaceWorkspaces(space)"], "Set up maintenance")
        let create = try slice(settings, from: "struct WikiCreateSheet: View {", to: "struct WikiSettingsView: View {")
        assertSays(dialog, "const groups = wikiRepositoryGroups(choices, (spaces.data ?? []).map((space) => space.repoUrlNorm));", in: Self.dialog)
        assertSays(dialog, "const offered = wikiCreateOffered(groups);", in: Self.dialog)
        assertSays(dialog, "const asked = offered.find((row) => sameId(row.id, workspaceId))?.id ?? null;", in: Self.dialog)
        assertOrder(create, ["WikiStartLogic.repositoryGroups(model.wikiWorkspaceChoices, wikis: wiki.spaces.map(\\.repoUrlNorm))",
                             "let offered = WikiStartLogic.createOffered(groups)",
                             "title: WikiStartCopy.create", "note: WikiStartCopy.createNote",
                             "submitLabel: WikiStartCopy.createAnswer",
                             "opensOn: WikiStartLogic.opensOn(offered, current: WikiStartLogic.asked(offered, workspaceId: workspaceID),",
                             "from: wiki.fromWorkspaceID),",
                             "initial: WikiMaintenanceChoice(.default)", "workspaceNote: WikiStartLogic.createWorkspaceNote",
                             "WikiStartLogic.createRequest($0, maintenance: choice.maintenance)", "await wiki.createSpace(request)",
                             "if refusal == nil { await created() }",
                             "await wiki.loadSystemModel()", "await wiki.loadSpaces()"], "Create wiki")
        XCTAssertFalse(settings.contains("WikiPickerOption"), "the forms offer `WikiStartLogic.WorkspaceChoice`")

        let model = try native("WikiModel.swift")
        let write = try slice(model, from: "func createSpace(_ request: WikiSpaceCreate) async -> String? {", to: "func loadSpaceWorkspaces(")
        assertOrder(write, ["try await api.createWikiSpace(request)", "selectedSlug = space.slug", "await loadSpaces()", "return nil",
                            "return Self.refusal(error)"], "making a wiki goes to it")
    }

    /// An account with no wiki gets the card where it had one sentence; the sentence stays for the writes that find no
    /// space. An address that names no wiki is the web's alone: a native page has none.
    func testAnAccountWithNoWikiGetsTheCard() throws {
        let card = try web(Self.card)
        assertSays(card, "const card = wikiStartFirstCard(!read || choices.some((choice) => choice.repository !== null));", in: Self.card)
        assertSays(card, "<WikiStartSteps card={card} busy={false} onAction={() => setCreating(true)}", in: Self.card)

        let screens = try native("Views/WikiScreens.swift")
        let placeholder = try slice(screens, from: "struct WikiHomePlaceholder: View {", to: "struct WikiDetailPane: View {")
        assertOrder(placeholder, ["} else if wiki.spacesState.hasLoaded && wiki.spaces.isEmpty {", "WikiFirstStartScreen(wiki: wiki)",
                                  "model.wikiWorkspacesLoading || model.wikiWorkspaceChoices.contains { $0.repository != nil }",
                                  "WikiFirstStartPage(card: WikiStartLogic.firstCard(workspaces: workspaces), trashed: wiki.trash.count,",
                                  "openTrash: { model.push(.wikiTrash) }) { _ in creating = true }",
                                  ".sheet(isPresented: $creating) { WikiCreateSheet(wiki: wiki) }"], "the no-wiki page")
        XCTAssertFalse(screens.contains("WikiCopy.noSpaces"), "the no-wiki page says the card, not the sentence")
        let view = try native("Views/WikiView.swift")
        let page = try slice(view, from: "struct WikiFirstStartPage: View {", to: "struct WikiSpacePicker: View {")
        assertOrder(page, ["Text(WikiCopy.title)", "WikiStartSection(card: card, act: act)"], "the no-wiki page")
        XCTAssertTrue(try native("WikiModel.swift").contains("WikiCopy.noSpaces"), "a write with no space on screen still says why")
    }

    /// New wiki… (design §3.4, board 46 part 4): a row under the drawer's and the sidebar's Wiki row once there is a
    /// wiki, and the head picker's item under its divider, each raising the one Create wiki form over the shell.
    func testNewWikiOpensTheCreateWikiForm() throws {
        let sidebar = try web("src/web/src/components/TasksSidePanel.tsx")
        assertOrder(sidebar, ["className=\"tp-item tp-wiki-new\"", "onClick={() => setCreatingWiki(true)}", "<PlusOutlined aria-hidden=\"true\" />",
                              "<span className=\"tp-label\">{WIKI_NEW}</span>"], "the web's row")
        let page = try web("src/web/src/pages/WikiPage.tsx")
        assertOrder(page, ["<hr />", "<option value={NEW_WIKI_VALUE}>{WIKI_NEW}</option>"], "the web's picker")

        let drawer = try native("Views/CompactShell.swift")
        assertSays(drawer, "if model.wiki?.shown == true, model.wiki?.spaces.isEmpty == false { newWikiRow }", in: "CompactShell.swift")
        let row = try slice(drawer, from: "private var newWikiRow: some View {", to: ".accessibilityIdentifier(\"drawer-new-wiki\")")
        assertOrder(row, ["model.wiki?.creating = true", "Image(systemName: \"plus\")", "Text(WikiStartCopy.newWiki)", ".foregroundStyle(.secondary)"],
                    "the drawer's row")
        let sidebarNative = try native("Views/MainView.swift")
        assertSays(sidebarNative, "if section == .wiki, model.wiki?.shown == true, model.wiki?.spaces.isEmpty == false {", in: "MainView.swift")
        let macRow = try slice(sidebarNative, from: "private var newWikiRow: some View {", to: ".accessibilityIdentifier(\"sidebar-new-wiki\")")
        assertOrder(macRow, ["model.wiki?.creating = true", "Label(WikiStartCopy.newWiki, systemImage: \"plus\")", ".foregroundStyle(.secondary)"],
                    "the sidebar's row")

        let view = try native("Views/WikiView.swift")
        let picker = try slice(view, from: "struct WikiSpacePicker: View {", to: "private let wikiHomeHeadColor")
        assertOrder(picker, ["ForEach(WikiSpaceLogic.menuRows(spaces, names: names)) { row in", "Divider()", "Button(action: create) {",
                             "Label(WikiStartCopy.newWiki, systemImage: \"plus\")", "Button(action: manage) {"], "the head picker")
        assertSays(view, "create: actions.createWiki)", in: "WikiView.swift")
        assertSays(try native("Views/WikiScreens.swift"), "createWiki: { wiki.creating = true },", in: "WikiScreens.swift")
        assertSays(try native("Views/WikiContentsColumn.swift"), "create: { wiki.creating = true })", in: "WikiContentsColumn.swift")

        let settings = try native("Views/WikiSettingsView.swift")
        let host = try slice(settings, from: "struct WikiCreateHost: ViewModifier {", to: "func wikiCreateHost(")
        assertOrder(host, ["get: { model.wiki?.creating ?? false }", "set: { model.wiki?.creating = $0 }", "if let wiki = model.wiki { WikiCreateSheet(wiki: wiki) }"],
                    "the form over the shell")
        assertSays(try native("OrbitApp.swift"), ".wikiCreateHost(model)", in: "OrbitApp.swift")
    }

    /// The WIKI_CREATE card (design §3.6, board 46 part 3): its facts, then Create wiki, Change settings… and Not for this
    /// repository, as the web's `OwnerRequestCard` draws them.
    func testTheWikiCreateCardDrawsTheWebsFactsAndButtons() throws {
        let web = try self.web("src/web/src/components/OwnerRequestCard.tsx")
        assertOrder(web, ["<Fact label={WIKI_CREATE_REPOSITORY}>", "<Fact label={WIKI_CREATE_READS_FROM}>", "{WIKI_WORKSPACE_OFFLINE}",
                          "<Fact label={WIKI_CREATE_MAINTENANCE}>"], "the web's facts")
        assertOrder(web, ["onClick={() => end.mutate({ to: 'create-wiki', body: {} })}", "{WIKI_CREATE_CHANGE_SETTINGS}",
                          "onClick={() => end.mutate({ to: 'decline', body: { reason: WIKI_CREATE_NOT_HERE } })}",
                          "<WikiCreateDialog workspaceId={request.workspaceId ?? null}"], "the web's buttons")

        let card = try native("Views/OwnerRequestViews.swift")
        assertSays(card, "case .wikiCreate:\n            OwnerRequestWikiCreateFacts(request: request)", in: "OwnerRequestViews.swift")
        let facts = try slice(card, from: "struct OwnerRequestWikiCreateFacts: View {", to: "struct OwnerRequestKindTag: View {")
        assertOrder(facts, ["WikiStartLogic.cardFacts(repoUrlNorm: request.repoUrlNorm, workspaceId: request.workspaceId,",
                            "Text(WikiStartCopy.cardRepository)", "Text(WikiStartCopy.cardReadsFrom)", "if facts.offline {",
                            "Text(WikiStartCopy.workspaceOffline)", "Text(WikiStartCopy.cardMaintenance)", "Text(facts.maintenance)"], "the native facts")
        assertSays(card, "if request.kind == .wikiCreate { wikiCreateActions } else { kindActions }", in: "OwnerRequestViews.swift")
        let actions = try slice(card, from: "private var wikiCreateActions: some View {", to: "private var declineForm: some View {")
        assertOrder(actions, ["try await model.createWiki(request)", "await appModel.wiki?.loadSpaces()", "Text(OwnerRequests.primaryLabel(request.kind)).bold()",
                              ".buttonStyle(.borderedProminent)", "Button(WikiStartCopy.changeSettings) { changingSettings = true }",
                              "Button(WikiStartCopy.notHere) { run { try await model.decline(request, reason: WikiStartCopy.notHere) } }",
                              "WikiCreateSheet(wiki: wiki, workspaceID: request.workspaceId, created: { await model.load() })"], "the native buttons")
        let requests = try native("OwnerRequestsModel.swift")
        assertSays(requests, "adopt(try await api.createWikiFromOwnerRequest(request.id))", in: "OwnerRequestsModel.swift")
    }
}
