import Foundation
import XCTest
@testable import OrbitKit

/// THE TWO OWNER CARDS THIS CLIENT DRAWS — the merge waiting to be confirmed and the question the
/// coordinator put to its owner (contract §7.5, mocks 4 and 5).
///
/// Everything here is the logic under the SwiftUI: which state a candidate is in, what each row
/// says, whether a press may be made and what it sends. The views are a rendering of exactly these
/// answers, which is what lets the cards be held to the browser's wording on a machine with no
/// SwiftUI at all.
///
/// The question card's words are checked against the browser's own declarations, and a missing
/// counterpart is a FAILURE rather than an `XCTSkip` — a parity check that opts out quietly reports
/// green on the one day the thing it watches goes missing (`WatchStripCopyParityTests`).
final class OwnerItemCardsTests: XCTestCase {

    private static let webQuestionCard = "src/web/src/components/CoordinatorQuestionCard.tsx"
    private static let webConsole = "src/web/src/components/WorkspaceView.tsx"
    private static let webPromotionCard = "src/web/src/components/ProjectPromotionCard.tsx"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case notDeclared(what: String)
        var description: String {
            switch self {
            case .noRepo:
                return "\(OwnerItemCardsTests.webQuestionCard) was not found above this test file. "
                    + "This card is one half of a pair; if the web half moved, move this check with "
                    + "it rather than deleting it."
            case .notDeclared(let what):
                return "\(what) was not found in \(OwnerItemCardsTests.webQuestionCard). Either it "
                    + "was renamed — then rename it here too, which is what this check is for — or "
                    + "the browser no longer says it and this client is saying it alone."
            }
        }
    }

    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.webQuestionCard).path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        throw ParityError.noRepo
    }

    /// The web source with its wrapped string literals put back together: where a long sentence
    /// breaks across lines is a formatting decision, while the words are the contract.
    private func webSource(_ relative: String) throws -> String {
        try String(contentsOf: try repoRoot().appendingPathComponent(relative), encoding: .utf8)
            .replacingOccurrences(of: "['\"`]\\s*\\+\\s*['\"`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "=\\s*\\n\\s*(['\"])", with: "= $1", options: .regularExpression)
    }

    private func declaration(_ source: String, _ name: String) throws -> String {
        let pattern = "const \(name) =\\s*['\"](.+?)['\"];"
        let re = try NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators])
        guard let match = re.firstMatch(in: source, range: NSRange(source.startIndex..., in: source)),
              match.numberOfRanges > 1, let range = Range(match.range(at: 1), in: source) else {
            throw ParityError.notDeclared(what: name)
        }
        return String(source[range])
    }

    // MARK: the coordinator's question

    /// Word for word the browser's, by the constants it exports. A person reads this card on a
    /// phone and the same card in a browser, often about the same question.
    func testTheQuestionCardsWordsAreTheBrowsersDeclarations() throws {
        let web = try webSource(Self.webQuestionCard)
        let pairs: [(String, String)] = [
            ("COORDINATOR_QUESTION_HEADING", CoordinatorQuestions.heading),
            ("FROM_COORDINATOR", CoordinatorQuestions.provenance),
            ("FROM_COORDINATOR_TITLE", CoordinatorQuestions.provenanceTitle),
            ("SEND_ANSWER", CoordinatorQuestions.sendAnswer),
            ("RECOMMENDED", CoordinatorQuestions.recommended),
            ("ANSWERED_HEADING", CoordinatorQuestions.answeredHeading),
            ("WAITING_FOR_COORDINATOR", CoordinatorQuestions.waitingForCoordinator),
            ("DELIVERED_TO_COORDINATOR", CoordinatorQuestions.deliveredToCoordinator),
            ("NOTE_PROMPT", CoordinatorQuestions.notePrompt),
            ("OWN_ANSWER_PROMPT", CoordinatorQuestions.ownAnswerPrompt),
            ("OTHER_OPTION", CoordinatorQuestions.otherOption),
            ("YOUR_ANSWER", CoordinatorQuestions.freeAnswerPrompt),
            // The record a question becomes once it has ended (§5.2 R10, R12).
            ("WITHDRAWN_HEADING", CoordinatorQuestions.withdrawnHeading),
            ("ANSWERED_BY_YOU", CoordinatorQuestions.answeredByYou),
            ("WITHDRAWN_BY_COORDINATOR", CoordinatorQuestions.withdrawnByCoordinator),
            ("WITHDRAWN_BY_YOU", CoordinatorQuestions.withdrawnByYou),
            ("COORDINATOR_WITHDREW", CoordinatorQuestions.coordinatorWithdrew),
            ("YOU_WITHDREW", CoordinatorQuestions.youWithdrew),
            ("YOUR_NOTE", CoordinatorQuestions.yourNote),
            ("VIEW_DETAILS", CoordinatorQuestions.viewDetails),
        ]
        for (name, mine) in pairs {
            XCTAssertEqual(mine, try declaration(web, name),
                           "\(name) drifted — first is this client's, second is the browser's.")
        }
    }

    // MARK: the four, in one word each

    /// One word per kind, and both ends say the same one. Four surfaces read this: the browser's
    /// session row, this client's row, the bar above the list, and the card in the conversation —
    /// and a person moves between them, so "the same fact, told two ways" is the failure.
    func testTheOwnerItemWordsAreTheBrowsersDeclarations() throws {
        let web = try webSource(Self.webConsole)
        let pairs: [(String, OwnerItemKind)] = [
            ("OWNER_ITEM_APPROVE_MERGE", .promotionApproval),
            ("OWNER_ITEM_COORDINATOR_QUESTION", .coordinatorQuestion),
            ("OWNER_ITEM_ESCALATED", .escalated),
            ("OWNER_ITEM_PAUSED", .fusePaused),
        ]
        for (name, kind) in pairs {
            XCTAssertEqual(try declaration(web, name), NeedsYouLogic.kindWord(kind),
                           "\(name) drifted — first is the browser's, second is this client's.")
        }
        // A kind neither end can name is named by neither: the row falls back to its generic words
        // rather than trailing an empty separator, which is the choice the bar already makes.
        XCTAssertNil(NeedsYouLogic.kindWord(.unknown))
    }

    private func question(options: [CoordinatorQuestion.Option] = [],
                          recommended: Int? = nil) -> CoordinatorQuestion {
        CoordinatorQuestion(question: "Start t4 first, or run t4 and t7 together?",
                            options: options, recommendedOption: recommended,
                            blocksTaskIds: ["t4"], ifUnanswered: "t4 waits")
    }

    private func questionRow(_ q: CoordinatorQuestion, id: String = "item-1",
                             since: String = "2026-09-13T10:00:00Z") -> ProjectOpenItemRow {
        ProjectOpenItemRow(itemId: id, kind: .coordinatorQuestion,
                           title: "Coordinator asks: \(q.question)",
                           detailLine: "Blocks: 1 task · If you don’t answer: t4 waits",
                           waitingSince: since, question: q)
    }

    /// Only the owner's group, and only rows that carry a question: an item in the coordinator's
    /// group is not one this card could be the answer to, whatever its kind says.
    func testOnlyTheOwnersQuestionsAreDrawn() {
        let mine = questionRow(question())
        let theirs = ProjectOpenItemRow(itemId: "item-2", kind: .integrationConflict,
                                        title: "Merge conflict", waitingSince: "2026-09-13T10:00:00Z")
        let items = ProjectOpenItemsView(needsYou: [mine], withCoordinator: [theirs])
        XCTAssertEqual(CoordinatorQuestions.open(items).map(\.itemId), ["item-1"])
        XCTAssertTrue(CoordinatorQuestions.open(ProjectOpenItemsView(withCoordinator: [theirs])).isEmpty)
    }

    /// A card is delivered once and re-derived on every render, so "the read has not answered yet"
    /// has to be its own state: a card that drew `gone` while unread would claim a question went
    /// away because a request was in flight.
    func testAQuestionGoesStaleInPlaceRatherThanVanishing() {
        let items = ProjectOpenItemsView(needsYou: [questionRow(question())])
        // A question that has ended is read as the record it became — and not counted.
        let ended = ProjectClosedQuestion(itemId: "answered", question: question(),
                                          askedAt: "2026-09-13T10:00:00Z",
                                          resolvedAt: "2026-09-13T10:05:00Z",
                                          answer: .init(option: nil, text: "t4 first"))
        let read = ProjectOpenItemsView(needsYou: [questionRow(question())], closedQuestions: [ended])
        XCTAssertEqual(CoordinatorQuestions.standing(items: read, itemId: "answered"), .closed(ended))
        XCTAssertFalse(CoordinatorQuestions.isOpen(.closed(ended)),
                       "a question that has ended is not one the bar points at")
        XCTAssertEqual(CoordinatorQuestions.standing(items: nil, itemId: "item-1"), .unread)
        XCTAssertFalse(CoordinatorQuestions.isOpen(.unread), "an unreadable standing is not a question to point at")

        guard case .open(let row) = CoordinatorQuestions.standing(items: items, itemId: "item-1") else {
            return XCTFail("the read carries this question, so the card is open")
        }
        XCTAssertEqual(row.question?.question, "Start t4 first, or run t4 and t7 together?")
        XCTAssertTrue(CoordinatorQuestions.isOpen(.open(row)))

        XCTAssertEqual(CoordinatorQuestions.standing(items: items, itemId: "answered"), .gone)
        XCTAssertFalse(CoordinatorQuestions.isOpen(.gone))
    }

    /// The button is live exactly when the door would take the press: an option chosen, or any
    /// non-empty text. Text beside a chosen option is a note on it; text with no option chosen is
    /// the answer itself, which is what the Other row is for.
    func testTheAnswerIsOnlySendableWhenTheDoorWouldTakeIt() {
        let choice = question(options: [.init(label: "t4 first"), .init(label: "both")], recommended: 1)
        XCTAssertFalse(CoordinatorQuestions.sendable(question: choice, chosen: nil, text: ""))
        XCTAssertTrue(CoordinatorQuestions.sendable(question: choice, chosen: nil, text: "neither"),
                      "words alone are an answer — that is what the Other row is on the card for")
        XCTAssertTrue(CoordinatorQuestions.sendable(question: choice, chosen: .option(0), text: ""))
        XCTAssertTrue(CoordinatorQuestions.sendable(question: choice, chosen: .other, text: "neither"))
        XCTAssertFalse(CoordinatorQuestions.sendable(question: choice, chosen: .other, text: "  \n "),
                       "the Other row with an empty box is not an answer the door would take")

        let free = question()
        XCTAssertFalse(CoordinatorQuestions.sendable(question: free, chosen: nil, text: "   \n "),
                       "whitespace is not an answer")
        XCTAssertTrue(CoordinatorQuestions.sendable(question: free, chosen: nil, text: "t4 first"))

        XCTAssertNil(CoordinatorQuestions.request(question: choice, chosen: nil, text: ""))
        XCTAssertNil(CoordinatorQuestions.request(question: choice, chosen: .other, text: " \n "),
                     "a row that was picked with nothing written under it is not a press the door takes")

        let both = CoordinatorQuestions.request(question: choice, chosen: .option(1),
                                                text: " they can share a runner ")
        XCTAssertEqual(both?.option, 1)
        XCTAssertEqual(both?.text, "they can share a runner", "sent trimmed, as the browser sends it")

        let mine = CoordinatorQuestions.request(question: choice, chosen: .other, text: " neither ")
        XCTAssertNil(mine?.option, "the Other row sends the words with no option in front of them")
        XCTAssertEqual(mine?.text, "neither")

        let prose = CoordinatorQuestions.request(question: free, chosen: nil, text: "t4 first")
        XCTAssertNil(prose?.option)
        XCTAssertEqual(prose?.text, "t4 first")
    }

    /// Which row is picked, and what the box under them says its text will be — the browser's own
    /// three states: an option (a note on it), the Other row or nothing yet (the answer), and a
    /// question asked without options, where the box is the whole of it.
    func testTheBoxSaysWhatItsTextWillBe() {
        let choice = question(options: [.init(label: "t4 first")], recommended: 0)
        XCTAssertEqual(CoordinatorQuestions.answerPrompt(question: choice, chosen: .option(0)),
                       CoordinatorQuestions.notePrompt)
        XCTAssertEqual(CoordinatorQuestions.answerPrompt(question: choice, chosen: .other),
                       CoordinatorQuestions.ownAnswerPrompt)
        XCTAssertEqual(CoordinatorQuestions.answerPrompt(question: choice, chosen: nil),
                       CoordinatorQuestions.ownAnswerPrompt)
        XCTAssertEqual(CoordinatorQuestions.answerPrompt(question: question(), chosen: nil),
                       CoordinatorQuestions.freeAnswerPrompt)

        XCTAssertTrue(CoordinatorQuestions.isOther(.other))
        XCTAssertFalse(CoordinatorQuestions.isOther(.option(0)))
        XCTAssertFalse(CoordinatorQuestions.isOther(nil))
        XCTAssertEqual(CoordinatorQuestions.optionIndex(.option(2)), 2)
        XCTAssertNil(CoordinatorQuestions.optionIndex(.other))
        XCTAssertNil(CoordinatorQuestions.optionIndex(nil))
    }

    /// The footnote rounds the way the browser's `ago` does, because both cards write it.
    func testTheAskedFootnoteReadsLikeTheBrowsers() {
        let now = RelativeTime.parse("2026-09-13T12:10:00Z")!
        XCTAssertEqual(CoordinatorQuestions.askedLine(since: "2026-09-13T10:00:00Z", now: now),
                       "asked 2h 10m ago")
        XCTAssertEqual(CoordinatorQuestions.askedLine(since: "2026-09-13T12:09:58Z", now: now),
                       "asked just now")
    }

    // MARK: the merge into main

    /// Mock 4's own candidate: the numbers in its four states are what these assertions read.
    private func candidate(_ state: PromotionState,
                           conflicts: [String] = [],
                           merged: ProjectPromotionView.Merged? = nil,
                           execution: ProjectPromotionView.Execution? = nil) -> ProjectPromotionView {
        ProjectPromotionView(
            promotionId: "pr-1", state: state,
            sourceRef: "refs/heads/project/bg-jobs", sourceSha: "58f3a4711d0c",
            upstreamRef: "refs/heads/main", commitsAhead: 7, filesChanged: 18,
            taskIds: ["t1", "t2", "t3", "t4"],
            checks: [IntegrationCheckResult(name: "MERGE_CHECK",
                                            command: "cd src/runner-go && go test -count=1 ./...",
                                            expectedExitCode: 0, exitCode: 0, timedOut: false,
                                            durationMs: 372_000)],
            conflicts: conflicts, landsAs: "MERGE_COMMIT",
            askedAt: "2026-09-13T10:00:00Z", recheckedAt: nil, merged: merged, execution: execution)
    }

    /// Four states, four cards — and the two that are neither: a candidate still being checked is
    /// not a question yet, and one that was declined is not one any more.
    func testTheMergeCardDrawsTheFourStatesAndNothingElse() {
        XCTAssertEqual(PromotionCards.stage(candidate(.ready)), .askingYou)
        XCTAssertEqual(PromotionCards.stage(candidate(.confirmed)), .merging)
        XCTAssertEqual(PromotionCards.stage(candidate(.rechecking)), .merging)
        XCTAssertEqual(PromotionCards.stage(candidate(.merged)), .merged)
        XCTAssertEqual(PromotionCards.stage(candidate(.blocked, conflicts: ["a.go"])), .blocked)
        XCTAssertNil(PromotionCards.stage(candidate(.checking)))
        XCTAssertNil(PromotionCards.stage(candidate(.declined)))
        XCTAssertNil(PromotionCards.stage(nil))
    }

    /// The headings, in mock 4's own words.
    func testTheMergeCardsHeadingsAreTheDesignsWords() {
        XCTAssertEqual(PromotionCards.title(candidate(.ready)), "Merge project/bg-jobs into main?")
        XCTAssertEqual(PromotionCards.title(candidate(.rechecking, execution: .init(
            state: "RUNNING", phase: "CHECK", startedAt: "2026-09-13T12:00:00Z"))),
                       "Re-checking project/bg-jobs before merging into main…")
        XCTAssertEqual(PromotionCards.title(candidate(.merged)), "✓ Merged into main")
        XCTAssertEqual(PromotionCards.title(candidate(.blocked, conflicts: ["a.go"])),
                       "project/bg-jobs can’t merge into main yet")
    }

    /// State A's rows: what is being merged, what was run on it, and what will land. Every one of
    /// them is a fact off the candidate — the card describes the merge it is confirming, which is
    /// the whole reason a candidate is frozen before it is offered.
    func testTheMergeCardSaysWhatIsBeingMerged() {
        let ready = candidate(.ready)
        XCTAssertEqual(PromotionCards.branchLine(ready), "project/bg-jobs · 7 commits ahead of main")
        XCTAssertEqual(PromotionCards.tasksLine(ready), "4 landed on the branch")
        XCTAssertEqual(PromotionCards.checksLine(ready),
                       "✓ Passed on the combined tree · cd src/runner-go && go test -count=1 ./... · 6m 12s")
        XCTAssertEqual(PromotionCards.upstreamLine(ready), "no conflicts")
        XCTAssertEqual(PromotionCards.criteriaLine(met: 3, of: 6),
                       "3 of 6 met on this branch — merging does not close the project")
        XCTAssertNil(PromotionCards.criteriaLine(met: 0, of: 0),
                     "criteria nobody has read are not reported as none met")
        XCTAssertEqual(PromotionCards.landsLine(ready), "exactly the tested tree 58f3a47 · as a merge commit")
        let now = RelativeTime.parse("2026-09-13T12:10:00Z")!
        XCTAssertEqual(PromotionCards.askedLine(ready, now: now), "asked 2h 10m ago")
    }

    /// A failed check is not drawn as a passed one — the verdict is read off the exit code the
    /// check declared, not off the fact that a check ran.
    func testAFailedCheckSaysSo() {
        let failed = ProjectPromotionView(
            promotionId: "pr-1", state: .blocked, sourceRef: "refs/heads/project/bg-jobs",
            sourceSha: "58f3a47", upstreamRef: "refs/heads/main",
            checks: [IntegrationCheckResult(name: "MERGE_CHECK", command: "npm test",
                                            expectedExitCode: 0, exitCode: 1, timedOut: false,
                                            durationMs: 48_000)])
        XCTAssertEqual(PromotionCards.checksLine(failed), "✕ Failed on the combined tree · npm test · 48s")
    }

    func testMergePreviewKeepsLongCommandsOutOfTheTranscript() {
        let ready = candidate(.ready)
        XCTAssertEqual(PromotionCards.previewTitle(ready), "Merge to main")
        XCTAssertEqual(PromotionCards.previewCounts(ready), "7 commits · 4 tasks")
        XCTAssertEqual(PromotionCards.previewChecks(ready), "✓ Checks passed")
        XCTAssertEqual(PromotionCards.previewTitle(candidate(.declined)), PromotionCards.supersededTitle)
        XCTAssertEqual(PromotionCards.previewTitle(candidate(.blocked)), "Merge to main blocked")
    }

    func testMergePreviewDoesNotReportPassedForMissingOrFailedChecks() {
        func view(_ checks: [IntegrationCheckResult]) -> ProjectPromotionView {
            ProjectPromotionView(promotionId: "pr-1", state: .ready, sourceRef: "project/long-branch",
                                 sourceSha: "abc", upstreamRef: "main", taskIds: ["t1"], checks: checks)
        }
        let passed = IntegrationCheckResult(name: "build", command: "npm run build")
        let failed = IntegrationCheckResult(name: "tests", command: "npm test", exitCode: 1)
        let timedOut = IntegrationCheckResult(name: "tests", command: "npm test", timedOut: true)
        let unfinished = IntegrationCheckResult(name: "tests", command: "npm test", exitCode: nil)
        XCTAssertEqual(PromotionCards.previewChecks(view([])), "No checks recorded")
        XCTAssertEqual(PromotionCards.previewChecks(view([failed, passed])), "✕ Checks failed")
        XCTAssertEqual(PromotionCards.previewChecks(view([unfinished, passed])), "✕ Checks failed")
        XCTAssertEqual(PromotionCards.previewChecks(view([timedOut, passed])), "Checks timed out")
        XCTAssertEqual(PromotionCards.previewCounts(view([])), "1 task")
        XCTAssertEqual(PromotionCards.checksLine(view([failed, passed])),
                       "✕ Failed on the combined tree · npm test\n\n✓ Passed on the combined tree · npm run build")
    }

    /// Only a READY candidate may be confirmed (§3.3): a blocked one's checks did not pass, and a
    /// confirmed one is already landing. The button follows the door rather than the other way round.
    func testOnlyAReadyCandidateIsConfirmable() {
        XCTAssertTrue(PromotionCards.confirmable(candidate(.ready)))
        for state in [PromotionState.checking, .confirmed, .rechecking, .blocked, .merged, .declined] {
            XCTAssertFalse(PromotionCards.confirmable(candidate(state)), "\(state) is not confirmable")
        }
        XCTAssertFalse(PromotionCards.confirmable(nil))
    }

    /// B and D say the two things their states exist to say: that the reader may walk away, and
    /// who has it while they cannot merge — D's on its press rather than in a row of its own
    /// (owner decision 2026-09-24), which is why the press carries the wait.
    func testTheMergingAndBlockedCardsSayWhoHasIt() {
        XCTAssertEqual(PromotionCards.mergingStatusLine(candidate(.rechecking, execution: .init(
            state: "RUNNING", phase: "CHECK", startedAt: "2026-09-13T12:00:00Z"))),
                       "main moved since the check — re-checking the combined tree")
        XCTAssertEqual(PromotionCards.nothingToDo,
                       "nothing to do — it lands on its own if the re-check passes, and comes back "
                           + "here if it doesn’t")
        let blocked = candidate(.blocked, conflicts: ["src/runner-go/session_pool.go",
                                                      "src/apiserver/prisma/schema.prisma"])
        XCTAssertEqual(PromotionCards.blockedLine(blocked),
                       "2 files conflict with main: src/runner-go/session_pool.go, "
                           + "src/apiserver/prisma/schema.prisma")

        let now = RelativeTime.parse("2026-09-13T12:12:00Z")!
        let theirs = ProjectOpenItemRow(itemId: "item-1", kind: .integrationConflict,
                                        title: "Merge conflict", waitingSince: "2026-09-13T12:00:00Z",
                                        assignee: .coordinator, promotionId: "pr-1")
        let held = PromotionCards.holder(of: "pr-1", in: ProjectOpenItemsView(withCoordinator: [theirs]))
        XCTAssertEqual(held, .open(theirs))
        XCTAssertEqual(PromotionCards.resolvingLine(held, now: now), "Coordinator is resolving it · 12m")
        XCTAssertTrue(PromotionCards.resolvingSpins(held))
        XCTAssertFalse(PromotionCards.resolvingIsYours(held))
        // The clock handed it over: the same press, the other holder, and nothing turning over
        // work that is waiting on the reader.
        let mine = ProjectOpenItemRow(itemId: "item-1", kind: .integrationConflict,
                                      title: "Merge conflict", waitingSince: "2026-09-13T12:00:00Z",
                                      assignee: .owner, escalatedAt: "2026-09-13T12:10:00Z",
                                      promotionId: "pr-1")
        let handed = PromotionCards.holder(of: "pr-1", in: ProjectOpenItemsView(needsYou: [mine]))
        XCTAssertEqual(PromotionCards.resolvingLine(handed, now: now), "It is yours · waiting 12m")
        XCTAssertFalse(PromotionCards.resolvingSpins(handed))
        XCTAssertTrue(PromotionCards.resolvingIsYours(handed))
        // No item read yet, or no readable instant on it: the sentence, and no clock under it.
        XCTAssertEqual(PromotionCards.holder(of: "pr-1", in: nil), .unread)
        XCTAssertEqual(PromotionCards.resolvingLine(.unread, now: now), "Coordinator is resolving it")
        let unreadable = ProjectOpenItemRow(itemId: "item-1", kind: .integrationConflict,
                                            title: "Merge conflict", waitingSince: "",
                                            assignee: .coordinator)
        XCTAssertEqual(PromotionCards.resolvingLine(.open(unreadable), now: now),
                       "Coordinator is resolving it")
    }

    /// A blocked candidate nobody holds — its exception closed, as the coordinator closed it on
    /// 2026-10-09 because the work was already on main — has no press: the card does not name the
    /// coordinator as resolving it, and nothing turns.
    func testABlockedCandidateNobodyHoldsHasNoPress() {
        let otherCandidates = ProjectOpenItemRow(itemId: "item-2", kind: .integrationError,
                                                 title: "Integration error", waitingSince: "2026-09-13T12:00:00Z",
                                                 assignee: .coordinator, promotionId: "pr-older")
        let nobody = PromotionCards.holder(of: "pr-1", in: ProjectOpenItemsView(withCoordinator: [otherCandidates]))
        XCTAssertEqual(nobody, .gone)
        XCTAssertNil(PromotionCards.resolvingLine(nobody))
        XCTAssertFalse(PromotionCards.resolvingSpins(nobody))
        XCTAssertFalse(PromotionCards.resolvingIsYours(nobody))
        XCTAssertEqual(PromotionCards.holder(of: "pr-1", in: ProjectOpenItemsView()), .gone)
    }

    /// D's reason is the job's own answer when the server recorded it (0409): a branch already on
    /// main has nothing to merge, and a job that stopped on an error reached no check — neither is
    /// "the checks did not pass". A block from before the reason is read off the arrays as before.
    func testTheBlockedReasonIsTheJobsAnswer() {
        func blocked(_ reason: String?, conflicts: [String] = []) -> ProjectPromotionView {
            ProjectPromotionView(promotionId: "pr-1", state: .blocked,
                                 sourceRef: "refs/heads/orbit/docs-evidence-33cf64", sourceSha: "",
                                 upstreamRef: "refs/heads/main", conflicts: conflicts, blockedReason: reason)
        }
        XCTAssertEqual(PromotionCards.blockedLine(blocked("ALREADY_LANDED")),
                       "nothing to merge — orbit/docs-evidence-33cf64 is already on main")
        XCTAssertEqual(PromotionCards.blockedReason(blocked("ALREADY_LANDED")), "nothing to merge")
        XCTAssertEqual(PromotionCards.blockedLine(blocked("ERROR")), "the merge stopped on an error — no check failed")
        XCTAssertEqual(PromotionCards.blockedReason(blocked("ERROR")), "check errored")
        XCTAssertEqual(PromotionCards.eventLine(blocked("ERROR")).text, "Can’t merge into main yet · check errored")
        XCTAssertEqual(PromotionCards.blockedLine(blocked("CHECK_FAILED")), "the checks on the combined tree did not pass")
        XCTAssertEqual(PromotionCards.blockedLine(blocked(nil)), "the checks on the combined tree did not pass")
        XCTAssertEqual(PromotionCards.blockedReason(blocked(nil)), "checks failed")
        XCTAssertEqual(PromotionCards.blockedLine(blocked("CONFLICT", conflicts: ["a.go"])), "1 file conflict with main: a.go")
        XCTAssertEqual(PromotionCards.blockedReason(blocked(nil, conflicts: ["a.go"])), "1 file conflict")
    }

    func testConfirmationDoesNotInventARunningMerge() {
        let unknown = candidate(.confirmed)
        XCTAssertEqual(PromotionCards.title(unknown), "Merge confirmed: project/bg-jobs into main")
        XCTAssertEqual(PromotionCards.mergingStatusLine(unknown), "confirmed — waiting for merge execution")
        XCTAssertEqual(PromotionCards.mergingActionLabel(unknown), "Confirmed")
        for state in [PromotionState.confirmed, .rechecking] {
            let queued = candidate(state, execution: .init(state: "QUEUED", startedAt: "2026-09-13T12:00:00Z"))
            XCTAssertEqual(PromotionCards.title(queued), "Merge queued: project/bg-jobs into main")
            XCTAssertEqual(PromotionCards.mergingStatusLine(queued), "confirmed — queued to merge into main")
            XCTAssertEqual(PromotionCards.mergingActionLabel(queued), "Queued")
        }
        let pushing = candidate(.rechecking, execution: .init(
            state: "RUNNING", phase: "PUSH", startedAt: "2026-09-13T12:00:00Z"))
        XCTAssertEqual(PromotionCards.mergingStatusLine(pushing), "confirmed — publishing the tested tree to main")
        XCTAssertEqual(PromotionCards.mergingActionLabel(pushing), "Merging…")
    }

    /// D's press is word for word the browser's, by the constants it exports — the same parity the
    /// question card's words are held to, because a person reads this card on a phone and in a
    /// browser, often about the same branch.
    func testTheMergePressWordingIsTheBrowsersDeclarations() throws {
        let web = try webSource(Self.webPromotionCard)
        XCTAssertEqual(PromotionCards.resolving, try declaration(web, "RESOLVING"),
                       "RESOLVING drifted — first is this client's, second is the browser's.")
        XCTAssertEqual(PromotionCards.itIsYours, try declaration(web, "IT_IS_YOURS"),
                       "IT_IS_YOURS drifted — first is this client's, second is the browser's.")
    }

    /// C is a receipt: the commit that landed, and when.
    func testTheMergedCardIsAReceipt() {
        let now = RelativeTime.parse("2026-09-13T12:02:00Z")!
        let merged = candidate(.merged, merged: .init(sha: "324cf0031a", at: "2026-09-13T12:00:00Z"))
        XCTAssertEqual(PromotionCards.mergedLine(merged, now: now),
                       "324cf00 · merge of project/bg-jobs · by you · 2m")
        // A pressed merge's receipt is what it always was: its own heading, and no undo row.
        XCTAssertEqual(PromotionCards.title(merged), "✓ Merged into main")
        XCTAssertNil(PromotionCards.revertLine(merged))
    }

    /// C when nobody pressed Merge (§3.3 M-T11): the Automatic setting merged a clean project
    /// branch, and the receipt is the only place the owner learns it — so it says it was the setting,
    /// not them, and gives the one command that takes the merge back out of main. The same words as
    /// web's `MERGED_AUTOMATICALLY_HEADING` / `UNDER_AUTOMATIC`.
    func testAnAutomaticMergeSaysSoAndHowToUndoIt() {
        let now = RelativeTime.parse("2026-09-13T12:02:00Z")!
        let merged = candidate(.merged, merged: .init(
            sha: "324cf0031a", at: "2026-09-13T12:00:00Z",
            automatic: true, revert: "git revert -m 1 324cf0031a"))
        XCTAssertEqual(PromotionCards.title(merged), "✓ Merged into main automatically")
        XCTAssertEqual(PromotionCards.mergedLine(merged, now: now),
                       "324cf00 · merge of project/bg-jobs · under your Automatic setting · 2m")
        XCTAssertEqual(PromotionCards.revertLine(merged), "git revert -m 1 324cf0031a")
    }

    /// The two cards have their own transcript rows, addressed the way the bar above the transcript
    /// and the push that opens it point at them.
    func testEachCardHasItsOwnRowID() {
        XCTAssertEqual(DeliveredDecisionCard(kind: .coordinatorQuestion(itemID: "i1")).id, "question-i1")
        XCTAssertEqual(DeliveredDecisionCard(kind: .promotionApproval(promotionID: "pr-1")).id, "promotion-pr-1")
    }
}
