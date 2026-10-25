import Foundation
import XCTest
@testable import OrbitKit

/// The project's main branch on this end (docs/mocks/project-main-branch/02-ios.png): what the start
/// card's Main branch row opens on, what Start and a pick in How it runs write, what the picker lists,
/// and every sentence of the settings band that says where work goes — case for case with the
/// browser's `projectStart.mainBranch.test.ts`, `MainBranchSelect.test.tsx`, `StartProjectCard.test.tsx`
/// and `ProjectRunSettings.test.tsx`. The words are held to the browser's own by
/// `ProjectMainBranchCopyParityTests`.
final class ProjectMainBranchTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private func object<T: Encodable>(_ value: T) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any] ?? [:]
    }

    private let last = ProjectLastMainBranch(branch: "develop", repository: "acme/payments-api",
                                             chosenAt: "2026-10-07T01:00:00.000Z")
    private let reported = ProjectBranchCandidates(names: ["develop", "master", "release/2.4"],
                                                   workspaceName: "payments-api",
                                                   reportedAt: "2026-10-10T01:00:00.000Z")

    private func view(upstreamRef: String? = "main", chosenAt: String? = nil,
                      last: ProjectLastMainBranch? = nil, repository: String? = "acme/payments-api",
                      locked: Bool = false) -> ProjectIntegrationView {
        ProjectIntegrationView(line: .projectBranch, ref: "project/34cfQ7mPaYmN2Wd8Rk3Jt",
                               upstreamRef: upstreamRef, upstreamChosenAt: chosenAt, lastMainBranch: last,
                               repository: repository, branches: reported, locked: locked,
                               startedAt: locked ? "2026-10-07T00:00:00.000Z" : nil)
    }

    private func suggestion(_ upstreamRef: String? = nil, line: IntegrationLine = .projectBranch) -> ProjectStartSettings {
        ProjectStartSettings(line: line, upstreamRef: upstreamRef, automatic: true, maxConcurrentTasks: 2)
    }

    // MARK: the read

    func testTheIntegrationReadCarriesTheMainBranchsFourFacts() throws {
        let read = try decode(ProjectIntegrationView.self, #"""
            {"line":"PROJECT_BRANCH","ref":"project/34cfQ","upstreamRef":"master","locked":false,
             "upstreamChosenAt":"2026-10-08T01:00:00.000Z",
             "lastMainBranch":{"branch":"master","repository":"acme/payments-api","chosenAt":"2026-10-08T01:00:00.000Z"},
             "repository":"acme/payments-api",
             "branches":{"names":["develop","master","release/2.4"],"workspaceName":"payments-api",
                         "reportedAt":"2026-10-10T01:00:00.000Z"},
             "integratingCount":0,"queuedCount":0,"mergeCheckOnTip":"UNKNOWN","inFlight":null}
            """#)
        XCTAssertEqual(read.upstreamChosenAt, "2026-10-08T01:00:00.000Z")
        XCTAssertEqual(read.lastMainBranch, ProjectLastMainBranch(branch: "master", repository: "acme/payments-api",
                                                                  chosenAt: "2026-10-08T01:00:00.000Z"))
        XCTAssertEqual(read.repository, "acme/payments-api")
        XCTAssertEqual(read.branches, reported)

        // A server that predates them says none of the four, and the rest still reads.
        let older = try decode(ProjectIntegrationView.self, #"{"line":"MAIN","upstreamRef":"main"}"#)
        XCTAssertNil(older.upstreamChosenAt)
        XCTAssertNil(older.lastMainBranch)
        XCTAssertNil(older.repository)
        XCTAssertNil(older.branches)
        XCTAssertEqual(older.upstreamRef, "main")
        // One this build cannot read is the same absence, never a failed integration read.
        let odd = try decode(ProjectIntegrationView.self,
                             #"{"line":"MAIN","branches":"develop","lastMainBranch":7,"repository":null}"#)
        XCTAssertNil(odd.branches)
        XCTAssertNil(odd.lastMainBranch)
        XCTAssertEqual(odd.line, .main)
    }

    // MARK: what the start card opens on

    func testTheStartOpensOnTheProjectsOwnChoiceThenTheLastForItsRepositoryThenTheSuggestionThenMain() {
        let chosen = view(upstreamRef: "trunk", chosenAt: "2026-10-08T01:00:00.000Z", last: last)
        XCTAssertEqual(StartProject.mainBranch(suggested: "refs/heads/master", standing: chosen), "trunk",
                       "this project's own choice outranks everything")
        XCTAssertEqual(StartProject.mainBranch(suggested: "refs/heads/master", standing: view(last: last)), "develop",
                       "then the owner's last choice for the repository, ahead of the coordinator's suggestion")
        XCTAssertEqual(StartProject.mainBranch(suggested: "refs/heads/master", standing: view()), "master",
                       "then the suggestion: a main branch the project only stands on by default is nobody's choice")
        XCTAssertEqual(StartProject.mainBranch(suggested: nil, standing: view()), "main", "then main")
        // A read that failed says nothing at all; the suggestion still decides.
        XCTAssertEqual(StartProject.mainBranch(suggested: "refs/heads/master", standing: nil), "master")
        XCTAssertEqual(StartProject.mainBranch(suggested: nil, standing: nil), "main")
        // A chosen time with no branch beside it is no choice.
        XCTAssertEqual(StartProject.mainBranch(suggested: "refs/heads/master",
                                               standing: view(upstreamRef: nil, chosenAt: "2026-10-08T01:00:00.000Z")),
                       "master")
    }

    func testTheCardOffersAMainBranchOnlyForAProjectTheReadSaysHasARepository() {
        let draft = StartSettingsDraft(suggestion("refs/heads/master"), standing: view(last: last))
        XCTAssertEqual(draft.upstream, "develop", "the row opens on the first the order finds")
        XCTAssertEqual(draft.main, "develop", "and every sentence on the card names it")
        XCTAssertTrue(draft.automatic, "Automatic still opens on")

        XCTAssertNil(StartSettingsDraft(suggestion("refs/heads/master"), standing: view(repository: nil)).upstream,
                     "a project with no repository has no main branch to choose, and no row")
        XCTAssertNil(StartSettingsDraft(suggestion("refs/heads/master"), standing: view(repository: "")).upstream)
        let unread = StartSettingsDraft(suggestion("refs/heads/master"))
        XCTAssertNil(unread.upstream, "a read that does not say whether it has one offers none")
        XCTAssertEqual(unread.main, "main", "and the card's sentences say main")
    }

    // MARK: what Start writes

    func testStartSendsTheMainBranchOnTheCardAsAFullRefAndNothingWhenTheCardOfferedNone() throws {
        let request = ProjectStartRequest(settings: suggestion("refs/heads/master"), criteriaDigest: "seal")
        var draft = StartSettingsDraft(request.settings, standing: view())
        XCTAssertEqual(draft.upstream, "master")
        draft.upstream = "release/3.0"
        let body = StartProject.body(request: request, draft: draft, requestId: "item")
        XCTAssertEqual(body.upstreamRef, "refs/heads/release/3.0", "the owner's choice once pressed")
        XCTAssertEqual(try object(body)["upstreamRef"] as? String, "refs/heads/release/3.0")

        let none = StartProject.body(request: request, draft: StartSettingsDraft(request.settings), requestId: nil)
        XCTAssertNil(none.upstreamRef)
        XCTAssertNil(try object(none)["upstreamRef"],
                     "a card that offered no main branch asks for nothing: the door refuses one for a project with no repository")
        // The rest of the body is as it was.
        XCTAssertEqual(try object(none)["line"] as? String, "PROJECT_BRANCH")
        XCTAssertTrue(try object(none)["mergeCheckCommand"] is NSNull)
    }

    func testTheStartSettingsCarryTheMainBranchTheyName() throws {
        let decoded = try decode(ProjectStartSettings.self, #"""
            {"line":"MAIN","upstreamRef":"refs/heads/master","automatic":false,"maxConcurrentTasks":1,"mergeCheckCommand":null}
            """#)
        XCTAssertEqual(decoded.upstreamRef, "refs/heads/master")
        XCTAssertEqual(try object(decoded)["upstreamRef"] as? String, "refs/heads/master")
        // The Project started card's settings, read as JSON, keep it.
        let card: JSONValue = .object(["line": .string("MAIN"), "automatic": .bool(false),
                                       "maxConcurrentTasks": .int(1), "mergeCheckCommand": .null,
                                       "upstreamRef": .string("refs/heads/master")])
        XCTAssertEqual(ProjectStartSettings.parse(card)?.upstreamRef, "refs/heads/master")
        XCTAssertNil(try decode(ProjectStartSettings.self,
                                #"{"line":"MAIN","automatic":true,"maxConcurrentTasks":1}"#).upstreamRef)

        // The owner's own Start… keeps the main branch the project stands on, as a full ref.
        let own = StartProject.defaultSettings(view: view(upstreamRef: "master"), maxConcurrentTasks: 2, graph: nil)
        XCTAssertEqual(own.upstreamRef, "refs/heads/master")
        XCTAssertNil(StartProject.defaultSettings(view: view(upstreamRef: nil), maxConcurrentTasks: 2, graph: nil).upstreamRef)
        XCTAssertNil(StartProject.defaultSettings(view: nil, maxConcurrentTasks: 2, graph: nil).upstreamRef)
    }

    // MARK: the sentences that say where work goes

    /// The settings band's 16 (web's `SENTENCES`), each as a function of the main branch, with its
    /// constant — what the sentence said before there was a branch to name.
    private var sentences: [(what: String, say: (String) -> String, before: String)] {
        [
            ("the line, by name", { RunSettings.lineMain($0) }, RunSettings.lineMain),
            ("what the line means", { RunSettings.lineMainHint($0) }, RunSettings.lineMainHint),
            ("Automatic on a project branch", { RunSettings.automaticHint(.projectBranch, main: $0) },
             RunSettings.automaticHintProjectBranch),
            ("Automatic directly into main", { RunSettings.automaticHint(.main, main: $0) }, RunSettings.automaticHintMain),
            ("the merge check", { RunSettings.mergeCheckHint($0) }, RunSettings.mergeCheckHint),
            ("no merge check", { RunSettings.noMergeCheckWarning($0) }, RunSettings.noMergeCheckWarning),
            ("Automatic on, checked",
             { RunSettings.automaticSays(automatic: true, line: .projectBranch, hasMergeCheck: true, main: $0) },
             RunSettings.automaticOnChecked),
            ("Automatic on, unchecked",
             { RunSettings.automaticSays(automatic: true, line: .projectBranch, hasMergeCheck: false, main: $0) },
             RunSettings.automaticOnUnchecked),
            ("Automatic on, directly into main",
             { RunSettings.automaticSays(automatic: true, line: .main, hasMergeCheck: true, main: $0) },
             RunSettings.automaticOnMain),
            ("Automatic off",
             { RunSettings.automaticSays(automatic: false, line: .projectBranch, hasMergeCheck: true, main: $0) },
             RunSettings.automaticOff),
            ("Automatic off, directly into main",
             { RunSettings.automaticSays(automatic: false, line: .main, hasMergeCheck: false, main: $0) },
             RunSettings.automaticOffMain),
            ("what comes to the owner: merging", { StartProject.mergingInto($0) }, StartProject.mergingIntoMain),
            ("what comes to the owner: each merge", { StartProject.eachMergeInto($0) }, StartProject.eachMergeIntoMain),
            ("the line mid-sentence", { RunSettings.lineInSentence(.main, main: $0) }, "directly into main"),
            ("what Pause stops", { RunSettings.pauseHint($0) }, RunSettings.pauseHint),
            ("why the line is locked", { RunSettings.mainBranchLocked(since: "2h ago", main: $0) },
             RunSettings.lineLocked(since: "2h ago")),
        ]
    }

    /// The one change the contract allows a project on main: the lock sentence under Main branch says
    /// the line and its main branch lock together.
    private func now(_ what: String, _ before: String) -> String {
        what == "why the line is locked"
            ? before.replacingOccurrences(of: "the line it lands on can", with: "the line it lands on and its main branch can")
            : before
    }

    func testTheSixteenSentencesSayMainWordForWordAsBefore() {
        XCTAssertEqual(sentences.count, 16)
        for (what, say, before) in sentences {
            XCTAssertEqual(say("main"), now(what, before), what)
            XCTAssertEqual(say(RunSettings.defaultMainBranch), now(what, before), what)
        }
        // And the functions' defaults are main.
        XCTAssertEqual(RunSettings.automaticHint(.projectBranch), RunSettings.automaticHintProjectBranch)
        XCTAssertEqual(RunSettings.automaticHint(.main), RunSettings.automaticHintMain)
        XCTAssertEqual(RunSettings.automaticSays(automatic: true, line: .projectBranch, hasMergeCheck: false),
                       RunSettings.automaticOnUnchecked)
        XCTAssertEqual(RunSettings.lineInSentence(.main), "directly into main")
        XCTAssertEqual(RunSettings.lineInSentence(.projectBranch, main: "master"), "a project branch")
    }

    func testTheSixteenSentencesNameMasterWhereverTheySaidMainAndNowhereElse() throws {
        let word = try NSRegularExpression(pattern: "\\bmain\\b")
        for (what, say, before) in sentences {
            let said = now(what, before)
            let master = word.stringByReplacingMatches(in: said, range: NSRange(said.startIndex..., in: said),
                                                       withTemplate: "master")
                .replacingOccurrences(of: "its master branch", with: "its main branch")
            XCTAssertEqual(say("master"), master, what)
        }
        XCTAssertEqual(RunSettings.lineMain("master"), "Directly into master")
        XCTAssertEqual(RunSettings.mainBranchLocked(since: nil, main: "master"),
                       "This project started integrating, so the line it lands on and its main branch can no longer "
                           + "change. Merge it into master, or give up the branch, to start another.")
        XCTAssertTrue(RunSettings.automaticHint(.main, main: "develop").contains(
            "Merging into develop always asks you — a project that lands directly on develop never merges by itself."))
    }

    func testTheLinesOwnLockSentenceKeepsItsWordsForAProjectWithNoMainBranchRow() {
        XCTAssertEqual(RunSettings.lineLocked(since: "2h ago"),
                       "This project started integrating 2h ago, so the line it lands on can no longer change. Merge it "
                           + "into main, or give up the branch, to start another.")
        XCTAssertEqual(RunSettings.lineLocked(since: nil),
                       "This project started integrating, so the line it lands on can no longer change. Merge it into "
                           + "main, or give up the branch, to start another.")
    }

    func testWhatComesToTheOwnerIsListedByTheProjectsMainBranch() {
        func texts(_ automatic: Bool, _ line: IntegrationLine, _ main: String?) -> [String] {
            let items = main.map {
                StartProject.comesToYou(automatic: automatic, line: line, ownerConfirmed: [], evidenceJudged: 0,
                                        escalationSeconds: 7_200, main: $0)
            } ?? StartProject.comesToYou(automatic: automatic, line: line, ownerConfirmed: [], evidenceJudged: 0,
                                         escalationSeconds: 7_200)
            return items.map(\.text)
        }
        XCTAssertEqual(texts(true, .main, "master").first, "Each merge into master")
        XCTAssertTrue(texts(false, .projectBranch, "master").contains("Merging the branch into master"))
        XCTAssertTrue(texts(false, .projectBranch, nil).contains("Merging the branch into main"))
        XCTAssertEqual(texts(true, .main, nil).first, StartProject.eachMergeIntoMain)
    }

    func testTheStartsOwnLinesNameTheMainBranchTheStartNames() {
        let direct = ProjectStartSettings(line: .main, automatic: false, maxConcurrentTasks: 1)
        XCTAssertEqual(RunSettings.parts(direct).first?.text, RunSettings.lineMain)
        XCTAssertEqual(RunSettings.line(direct), "Directly into main · Automatic off · 1 task at a time · no merge check")
        XCTAssertEqual(StartProject.requestSummary(direct),
                       "The coordinator asked · directly into main · Automatic off · at most 1 at a time")

        let onMaster = ProjectStartSettings(line: .main, upstreamRef: "refs/heads/master", automatic: false,
                                            maxConcurrentTasks: 1)
        XCTAssertEqual(RunSettings.parts(onMaster, differs: [.line]).first,
                       RunSettings.Part(key: .line, text: "Directly into master", differs: true))
        XCTAssertEqual(RunSettings.line(onMaster), "Directly into master · Automatic off · 1 task at a time · no merge check")
        XCTAssertEqual(StartProject.requestSummary(onMaster),
                       "The coordinator asked · directly into master · Automatic off · at most 1 at a time")
        // The request's row says the branch the start card opens with, where the page can say it.
        XCTAssertEqual(StartProject.requestSummary(onMaster, main: "develop"),
                       "The coordinator asked · directly into develop · Automatic off · at most 1 at a time")
        // A project branch names no main branch, whatever the start recorded.
        let branch = ProjectStartSettings(line: .projectBranch, upstreamRef: "refs/heads/master", automatic: false,
                                          maxConcurrentTasks: 1)
        XCTAssertEqual(RunSettings.line(branch), "A project branch · Automatic off · 1 task at a time · no merge check")
        // The integration row of a project nobody started: directly into the branch the start opens with.
        XCTAssertEqual(RunSettings.undecidedLine(suggested: .main, main: "master"),
                       "Tasks land on: decided when you start — the coordinator suggests directly into master")
        XCTAssertEqual(RunSettings.undecidedLine(suggested: .main),
                       "Tasks land on: decided when you start — the coordinator suggests directly into main")
    }

    func testPauseStopsMergesIntoTheMainBranchTheProjectStandsOn() {
        let at = Date(timeIntervalSince1970: 1_800_000_000)
        let twentyMinutes = ISO8601DateFormatter().string(from: at.addingTimeInterval(-20 * 60))
        XCTAssertEqual(RunSettings.pauseFootnote(pausedAt: nil, now: at, main: "master"),
                       "Stops new tasks, wake-ups and merges into master. Running tasks finish.")
        XCTAssertEqual(RunSettings.pauseFootnote(pausedAt: twentyMinutes, now: at, main: "master"),
                       "Paused 20m ago. Stops new tasks, wake-ups and merges into master. Running tasks finish.")
        XCTAssertEqual(RunSettings.pauseFootnote(pausedAt: nil, now: at), RunSettings.pauseHint)
    }

    // MARK: the row's own words

    func testTheMainBranchRowsOwnWords() {
        XCTAssertEqual(RunSettings.mainBranch, "Main branch")
        XCTAssertEqual(RunSettings.mainBranchHint, "Tasks start from it, and the project’s work ends up on it.")
        XCTAssertEqual(RunSettings.lastChoiceFor("acme/payments-api"), "Your last choice for acme/payments-api")
        XCTAssertEqual(RunSettings.mainBranchRemembers("acme/payments-api"),
                       "New projects in acme/payments-api start with your last choice.")
        XCTAssertEqual(RunSettings.lastChosen, "last chosen")
        XCTAssertEqual(RunSettings.branchesIn("payments-api"), "Branches in payments-api")
        XCTAssertEqual(RunSettings.typeABranch, "Type a branch name")
        XCTAssertEqual(RunSettings.useBranch("release/3.0"), "Use “release/3.0”")
    }

    func testAMainBranchIsTakenByNameAndGivenToTheDoorsAsAFullRef() {
        XCTAssertEqual(RunSettings.mainBranchRef("master"), "refs/heads/master")
        XCTAssertEqual(RunSettings.mainBranchRef("release/2.4"), "refs/heads/release/2.4")
        XCTAssertEqual(RunSettings.mainBranchName("refs/heads/release/2.4"), "release/2.4")
        XCTAssertEqual(RunSettings.mainBranchName("master"), "master")
        XCTAssertEqual(RunSettings.mainBranchName(nil), "main")
        XCTAssertEqual(RunSettings.mainBranchName(""), "main")
    }

    // MARK: the picker

    func testThePickerListsTheReportedBranchesAndTicksTheOneTheRowStandsOn() {
        let choices = RunSettings.branchChoices(branches: reported, remembered: nil, current: "master", query: "")
        XCTAssertEqual(choices.map(\.label), ["develop", "master", "release/2.4"])
        XCTAssertEqual(choices.filter(\.current).map(\.name), ["master"])
        XCTAssertTrue(choices.allSatisfy { !$0.typed && !$0.lastChosen })
        XCTAssertEqual(RunSettings.branchesHead(reported), "Branches in payments-api")
    }

    func testThePickerKeepsTheCurrentAndTheRememberedBranchesEvenWhenTheRunnerNeverReportedThem() {
        XCTAssertEqual(RunSettings.branchChoices(branches: reported, remembered: nil, current: "trunk", query: "")
            .map(\.label), ["develop", "master", "release/2.4", "trunk"])
        let remembered = RunSettings.branchChoices(branches: reported, remembered: "trunk", current: "master", query: "")
        XCTAssertEqual(remembered.map(\.label), ["develop", "master", "release/2.4", "trunk"])
        XCTAssertEqual(remembered.filter(\.lastChosen).map(\.name), ["trunk"], "the last choice is tagged")
        let both = RunSettings.branchChoices(branches: reported, remembered: "master", current: "master", query: "")
        XCTAssertEqual(both.map(\.label), ["develop", "master", "release/2.4"], "each branch once")
        XCTAssertEqual(both.first { $0.name == "master" }.map { [$0.lastChosen, $0.current] }, [true, true])
    }

    func testThePickerNarrowsAsANameIsTypedAndOffersANameNobodyReportedAsItself() {
        XCTAssertEqual(RunSettings.branchChoices(branches: reported, remembered: nil, current: "master", query: "rel")
            .map(\.label), ["release/2.4", "Use “rel”"])
        XCTAssertEqual(RunSettings.branchChoices(branches: reported, remembered: nil, current: "master", query: "REL")
            .map(\.label), ["release/2.4", "Use “REL”"], "matched whatever the case")
        XCTAssertEqual(RunSettings.branchChoices(branches: reported, remembered: nil, current: "master", query: "develop")
            .map(\.label), ["develop"], "a reported branch is offered only as itself")
        let typed = RunSettings.branchChoices(branches: reported, remembered: nil, current: "master",
                                              query: "  release/3.0 ")
        XCTAssertEqual(typed.map(\.label), ["Use “release/3.0”"])
        XCTAssertEqual(typed.first?.name, "release/3.0", "a pick of it takes the name, not the words")
        XCTAssertEqual(typed.first?.typed, true)
    }

    func testThePickerOffersNothingToUseForANameGitWouldRefuse() {
        for name in ["two words", "a..b", "x~1", "what?", "end/", "-flag", "held.lock", "back\\slash", "a:b",
                     "x^1", "st*r", "[x", "/lead"] {
            XCTAssertFalse(RunSettings.takesBranchName(name), name)
            XCTAssertFalse(RunSettings.branchChoices(branches: reported, remembered: nil, current: "master", query: name)
                .contains { $0.typed }, name)
        }
        for name in ["master", "release/3.0", "feature/x-y_z", "v1.2", "trunk"] {
            XCTAssertTrue(RunSettings.takesBranchName(name), name)
        }
    }

    func testWithNoBranchesReportedThePickerTakesATypedName() {
        XCTAssertEqual(RunSettings.branchesHead(nil), "Type a branch name")
        XCTAssertEqual(RunSettings.branchChoices(branches: nil, remembered: nil, current: "main", query: "")
            .map(\.label), ["main"])
        XCTAssertEqual(RunSettings.branchChoices(branches: nil, remembered: nil, current: "main", query: "master")
            .map(\.label), ["Use “master”"])
    }

    func testTheStartCardSaysWhereItsMainBranchCameFromOnlyWhileItIsTheLastChoice() {
        XCTAssertEqual(RunSettings.lastChoiceNote(upstream: "develop", lastMainBranch: last),
                       "Your last choice for acme/payments-api")
        XCTAssertNil(RunSettings.lastChoiceNote(upstream: "master", lastMainBranch: last), "changed to another, it says nothing")
        XCTAssertNil(RunSettings.lastChoiceNote(upstream: "develop", lastMainBranch: nil))
        XCTAssertNil(RunSettings.lastChoiceNote(upstream: nil, lastMainBranch: last))
    }

    // MARK: How it runs

    func testHowItRunsShowsTheMainBranchTheProjectStandsOnAndOnlyWithARepository() {
        XCTAssertEqual(RunSettings.storedMainBranch(view(upstreamRef: "master")), "master")
        XCTAssertEqual(RunSettings.storedMainBranch(view(upstreamRef: nil, last: last)), "develop",
                       "before it is bound, the branch binding will give it: the owner's last choice there")
        XCTAssertEqual(RunSettings.storedMainBranch(view(upstreamRef: nil)), "main", "else main")
        XCTAssertNil(RunSettings.storedMainBranch(view(upstreamRef: "master", repository: nil)),
                     "a project with no repository has no row")
        XCTAssertNil(RunSettings.storedMainBranch(view(repository: "")))

        XCTAssertEqual(RunSettings.mainBranchNote(view(upstreamRef: "master"), since: nil),
                       "Tasks start from it, and the project’s work ends up on it. New projects in "
                           + "acme/payments-api start with your last choice.")
        XCTAssertEqual(RunSettings.mainBranchNote(view(upstreamRef: "master", locked: true), since: "3d ago"),
                       "This project started integrating 3d ago, so the line it lands on and its main branch can no "
                           + "longer change. Merge it into master, or give up the branch, to start another.")
        XCTAssertNil(RunSettings.mainBranchNote(view(repository: nil), since: nil))
    }

    func testAPickInHowItRunsWritesTheMainBranchOnlyWhileItCanMoveAndOnlyWhenItMoves() throws {
        let write = RunSettings.mainBranchWrite(view(), to: "master")
        XCTAssertEqual(write, UpdateProjectIntegrationRequest(upstreamRef: "refs/heads/master"))
        XCTAssertEqual(try object(write).keys.sorted(), ["upstreamRef"], "the main branch alone")
        XCTAssertEqual(try object(write)["upstreamRef"] as? String, "refs/heads/master", "as a full ref")
        XCTAssertEqual(write?.isEmpty, false)
        XCTAssertNil(RunSettings.mainBranchWrite(view(), to: "main"), "the branch it already stands on is no move")
        XCTAssertNil(RunSettings.mainBranchWrite(view(locked: true), to: "master"),
                     "locked with the line: sending it would be refused 409")
        XCTAssertNil(RunSettings.mainBranchWrite(view(repository: nil), to: "master"))
        XCTAssertNil(RunSettings.mainBranchWrite(view(), to: "   "))
        XCTAssertEqual(RunSettings.mainBranchWrite(view(), to: " master ")?.upstreamRef, "refs/heads/master")
        // Before it is bound: the branch binding would give it is no move, any other is.
        XCTAssertNil(RunSettings.mainBranchWrite(view(upstreamRef: nil, last: last), to: "develop"))
        XCTAssertEqual(RunSettings.mainBranchWrite(view(upstreamRef: nil, last: last), to: "master")?.upstreamRef,
                       "refs/heads/master")
        // The other writes still say nothing of it.
        XCTAssertNil(try object(UpdateProjectIntegrationRequest(line: .main))["upstreamRef"])
        XCTAssertTrue(UpdateProjectIntegrationRequest().isEmpty)
    }
}
