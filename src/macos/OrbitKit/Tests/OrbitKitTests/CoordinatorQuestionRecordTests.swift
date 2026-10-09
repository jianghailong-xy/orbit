import Foundation
import XCTest
@testable import OrbitKit

/// WHAT A COORDINATOR'S QUESTION BECOMES ONCE IT HAS ENDED (contract §5.2 R10, R12;
/// `docs/mocks/coordinator-question-answered/`).
///
/// The open-items read carries every question that was answered or withdrawn (`closedQuestions`),
/// and the conversation draws each as a record at the moment it ended. Before this the card's
/// "Answered" came from what one window had kept in memory (`CoordinatorReviewDraft.receipt`), so a
/// relaunch or another device had nothing, and what was asked — the question, its options, the
/// recommendation — was gone from the card the moment it was answered.
///
/// Everything a card and its sheet say is asserted here, line by line, because the views are a
/// rendering of exactly these answers and SwiftUI does not exist on this machine. The words are the
/// browser's (`OwnerItemCardsTests` holds them to `CoordinatorQuestionCard.tsx`), and so are the
/// cases: `CoordinatorQuestionRecord.test.tsx` draws the same records from the same question.
final class CoordinatorQuestionRecordTests: XCTestCase {

    private static let question = CoordinatorQuestion(
        question: """
        灰度回退之后的收尾都做完了：

        - 新版本部署之后，维护任务恢复了
        - **三处修复**都已经在生产上

        请批准重开灰度。
        """,
        options: [
            .init(label: "现在重开，接受这个代价", description: "不专门挑时间。"),
            .init(label: "等新一轮刚开始时再切", description: "盯着下一轮维护一开始就切。"),
            .init(label: "先不重开"),
        ],
        recommendedOption: 0, blocksTaskIds: ["t4"], ifUnanswered: "the rollout stays paused")

    private static let askedAt = "2026-10-09T00:10:00.000Z"
    private static let answeredAt = "2026-10-09T00:29:36.828Z"
    private static let now = RelativeTime.parse("2026-10-09T01:00:00.000Z")!

    private func record(option: Int? = 0, text: String? = nil, delivered: Bool = true,
                        question: CoordinatorQuestion = question) -> ProjectClosedQuestion {
        ProjectClosedQuestion(
            itemId: "item-1", question: question, askedAt: Self.askedAt,
            resolution: "ANSWERED", resolvedBy: "USER", resolvedAt: Self.answeredAt,
            answer: .init(option: option, text: text),
            delivery: delivered ? .init(sessionId: "coordinator-1", at: Self.answeredAt) : nil)
    }

    private func withdrawn(by: String = "COORDINATOR") -> ProjectClosedQuestion {
        ProjectClosedQuestion(
            itemId: "item-1", question: Self.question, askedAt: Self.askedAt,
            resolution: "WITHDRAWN", resolvedBy: by, resolvedAt: Self.answeredAt,
            withdrawReason: " 灰度已经回退，这一步不需要了。 ")
    }

    private static let free = CoordinatorQuestion(question: "文章重写排在夜里还是白天？")

    /// The clock the receipts write, so the assertions hold in whatever zone the suite runs.
    private func clock(_ iso: String, now: Date = now) -> String {
        OwnerConfirmations.receiptTime(iso, now: now)!
    }

    // MARK: the card

    func testTheCardOpensWithTheQuestionAsPlainText() {
        XCTAssertEqual(CoordinatorQuestions.lead(Self.question),
                       "灰度回退之后的收尾都做完了： 新版本部署之后，维护任务恢复了 三处修复都已经在生产上 请批准重开灰度。",
                       "the browser's `markdownToPlainText`: marks gone, lines joined — the card cuts it at two")
        XCTAssertEqual(CoordinatorQuestions.lead(.init(question: "1. first\n2) *second*")), "first second")
    }

    func testAnOptionAloneIsItsLabelWithNothingOwed() {
        let answered = record()
        XCTAssertEqual(CoordinatorQuestions.recordHeading(answered), "Answered")
        XCTAssertEqual(CoordinatorQuestions.time(answered, now: Self.now), clock(Self.answeredAt))
        XCTAssertEqual(CoordinatorQuestions.answerLine(answered), "现在重开，接受这个代价")
        XCTAssertNil(CoordinatorQuestions.noteLine(answered))
        XCTAssertNil(CoordinatorQuestions.waitingLine(answered), "it reached the coordinator")
        XCTAssertNil(CoordinatorQuestions.withdrewLine(answered))
        XCTAssertNil(CoordinatorQuestions.withdrawReasonLine(answered))
    }

    func testAnOptionAndANoteAreTwoLinesNotOneSentence() {
        let answered = record(option: 1, text: " 今晚 22 点以后再切，白天有人在用。 ")
        XCTAssertEqual(CoordinatorQuestions.answerLine(answered), "等新一轮刚开始时再切")
        XCTAssertEqual(CoordinatorQuestions.noteLine(answered), "“今晚 22 点以后再切，白天有人在用。”",
                       "the note on a line of its own, quoted — not `option — note` run together")
    }

    func testTheOtherRowIsTheOwnersWordsQuoted() {
        let answered = record(option: nil, text: "先别取文件，等我明天看过导出脚本再说。")
        XCTAssertEqual(CoordinatorQuestions.answerLine(answered), "“先别取文件，等我明天看过导出脚本再说。”")
        XCTAssertNil(CoordinatorQuestions.noteLine(answered))
    }

    func testAQuestionWithoutOptionsIsAnsweredInWords() {
        let answered = record(option: nil, text: "夜里跑，出了问题等我早上看。", question: Self.free)
        XCTAssertEqual(CoordinatorQuestions.answerLine(answered), "“夜里跑，出了问题等我早上看。”")
    }

    func testAnAnswerNoCoordinatorHasHadSaysItWaits() {
        let waiting = record(delivered: false)
        XCTAssertEqual(CoordinatorQuestions.waitingLine(waiting),
                       "Waiting for this project’s next coordinator")
    }

    func testAWithdrawnQuestionSaysWhoTookItBackAndWhy() {
        let taken = withdrawn()
        XCTAssertEqual(CoordinatorQuestions.recordHeading(taken), "Withdrawn")
        XCTAssertNil(CoordinatorQuestions.answerLine(taken))
        XCTAssertNil(CoordinatorQuestions.noteLine(taken))
        XCTAssertNil(CoordinatorQuestions.waitingLine(taken), "nothing is owed to anybody")
        XCTAssertEqual(CoordinatorQuestions.withdrewLine(taken), "The coordinator withdrew it")
        XCTAssertEqual(CoordinatorQuestions.withdrawReasonLine(taken), "“灰度已经回退，这一步不需要了。”")
        XCTAssertEqual(CoordinatorQuestions.withdrewLine(withdrawn(by: "USER")), "You withdrew it",
                       "closed through the owner's own door, the record does not blame the coordinator")
    }

    // MARK: the sheet

    func testTheSheetTicksTheChosenOptionAndKeepsTheNoteInsideIt() {
        let answered = record(option: 1, text: "今晚 22 点以后再切。")
        XCTAssertEqual(CoordinatorQuestions.askedAtLine(answered, now: Self.now), "asked \(clock(Self.askedAt))")
        XCTAssertEqual(CoordinatorQuestions.chosenOption(answered), 1)
        XCTAssertEqual(CoordinatorQuestions.note(answered), "今晚 22 点以后再切。")
        XCTAssertFalse(CoordinatorQuestions.choseOther(answered))
        XCTAssertNil(CoordinatorQuestions.ownWords(answered))
    }

    func testTheSheetTicksTheOtherRowOverTheOwnersWords() {
        let answered = record(option: nil, text: "先别取文件。")
        XCTAssertNil(CoordinatorQuestions.chosenOption(answered))
        XCTAssertTrue(CoordinatorQuestions.choseOther(answered))
        XCTAssertEqual(CoordinatorQuestions.ownWords(answered), "先别取文件。")
        XCTAssertNil(CoordinatorQuestions.note(answered))
    }

    func testTheSheetOfAQuestionWithoutOptionsHasAReadOnlyAnswerBox() {
        let answered = record(option: nil, text: "夜里跑。", question: Self.free)
        XCTAssertFalse(CoordinatorQuestions.choseOther(answered), "there is no Other row to tick")
        XCTAssertEqual(CoordinatorQuestions.ownWords(answered), "夜里跑。")
        XCTAssertEqual(CoordinatorQuestions.freeAnswerPrompt, "Your answer")
    }

    func testTheSheetOfAWithdrawnQuestionTicksNothing() {
        let taken = withdrawn()
        XCTAssertNil(CoordinatorQuestions.chosenOption(taken))
        XCTAssertFalse(CoordinatorQuestions.choseOther(taken))
        XCTAssertNil(CoordinatorQuestions.note(taken))
        XCTAssertNil(CoordinatorQuestions.ownWords(taken))
    }

    /// An option index the question never offered ticks nothing rather than the wrong row.
    func testAnOptionTheQuestionNeverOfferedTicksNothing() {
        let odd = record(option: 7)
        XCTAssertNil(CoordinatorQuestions.chosenOption(odd))
        XCTAssertNil(CoordinatorQuestions.answerLine(odd))
    }

    /// Where Send answer was: who, when, and where the answer went — or why it was withdrawn.
    func testTheFooterSaysWhoWhenAndWhereItWent() {
        let at = clock(Self.answeredAt)
        XCTAssertEqual(CoordinatorQuestions.footerLine(record(), now: Self.now), "Answered by you · \(at)")
        XCTAssertEqual(CoordinatorQuestions.footerDetail(record()), "Delivered to the current coordinator")
        XCTAssertEqual(CoordinatorQuestions.footerDetail(record(delivered: false)),
                       "Waiting for this project’s next coordinator")
        XCTAssertEqual(CoordinatorQuestions.footerLine(withdrawn(), now: Self.now),
                       "Withdrawn by the coordinator · \(at)")
        XCTAssertEqual(CoordinatorQuestions.footerDetail(withdrawn()), "“灰度已经回退，这一步不需要了。”")
        XCTAssertEqual(CoordinatorQuestions.footerLine(withdrawn(by: "USER"), now: Self.now),
                       "Withdrawn by you · \(at)")
    }

    /// The receipts' rule for the clock: the time on the day, the date as well after.
    func testTheTimeCarriesTheDateOnceItIsNotToday() {
        let later = RelativeTime.parse("2026-10-12T09:00:00.000Z")!
        let today = CoordinatorQuestions.time(record(), now: Self.now)!
        let another = CoordinatorQuestions.time(record(), now: later)!
        XCTAssertNotEqual(today, another)
        XCTAssertTrue(another.hasSuffix(today), "the same clock, with the day in front of it")
    }

    // MARK: the press, until the read has it

    func testTheAnswerSentHereIsTheRecordTheReadWillPublish() {
        let row = ProjectOpenItemRow(itemId: "item-1", kind: .coordinatorQuestion,
                                     title: "Coordinator asks: …", waitingSince: Self.askedAt,
                                     question: Self.question)
        let at = RelativeTime.parse(Self.answeredAt)!
        let sent = CoordinatorQuestions.answeredHere(
            row: row, question: Self.question,
            request: OwnerAnswerRequest(option: 1, text: "tonight"),
            receipt: OwnerAnswerReceipt(itemId: "item-1",
                                        delivery: .init(sessionId: "coordinator-1", turnId: "turn-1")),
            at: at)
        XCTAssertEqual(sent.itemId, "item-1")
        XCTAssertEqual(sent.question, Self.question, "the question it was sent about, whole")
        XCTAssertEqual(sent.askedAt, Self.askedAt)
        XCTAssertEqual(sent.resolution, "ANSWERED")
        XCTAssertEqual(sent.resolvedBy, "USER")
        XCTAssertEqual(RelativeTime.parse(sent.resolvedAt), RelativeTime.parse("2026-10-09T00:29:36Z"))
        XCTAssertEqual(sent.answer, .init(option: 1, text: "tonight"))
        XCTAssertEqual(sent.delivery?.sessionId, "coordinator-1")
        XCTAssertEqual(CoordinatorQuestions.answerLine(sent), "等新一轮刚开始时再切")
        XCTAssertEqual(CoordinatorQuestions.noteLine(sent), "“tonight”")

        let nobody = CoordinatorQuestions.answeredHere(
            row: row, question: Self.question, request: OwnerAnswerRequest(text: "later"),
            receipt: OwnerAnswerReceipt(itemId: "item-1"), at: at)
        XCTAssertNil(nobody.delivery)
        XCTAssertEqual(CoordinatorQuestions.waitingLine(nobody), "Waiting for this project’s next coordinator")
    }

    // MARK: the read

    func testTheReadDecodesTheRecordsAndAnOlderServerHasNone() throws {
        let json = """
        {"needsYou":[],"withCoordinator":[],"settled":[],
         "closedQuestions":[
          {"itemId":"q1","question":{"question":"Which first?","options":[{"label":"t4"},{"label":"t7","description":"why"}],
           "recommendedOption":0,"blocksTaskIds":[],"ifUnanswered":null},
           "askedAt":"2026-10-09T00:10:00.000Z","resolution":"ANSWERED","resolvedBy":"USER",
           "resolvedAt":"2026-10-09T00:29:36.828Z","answer":{"option":1,"text":null},
           "delivery":{"sessionId":"s1","at":"2026-10-09T00:29:37.000Z"},"withdrawReason":null},
          {"itemId":"q2","question":{"question":"Keep the branch?","options":[],"recommendedOption":null,
           "blocksTaskIds":[],"ifUnanswered":null},
           "askedAt":"2026-10-09T00:00:00.000Z","resolution":"WITHDRAWN","resolvedBy":"COORDINATOR",
           "resolvedAt":"2026-10-09T00:20:00.000Z","answer":null,"delivery":null,"withdrawReason":"not needed"}
         ]}
        """
        let read = try JSONDecoder().decode(ProjectOpenItemsView.self, from: Data(json.utf8))
        XCTAssertEqual(read.closedQuestions.map(\.itemId), ["q1", "q2"])
        XCTAssertEqual(read.closedQuestions[0].answer, .init(option: 1, text: nil))
        XCTAssertEqual(read.closedQuestions[0].delivery?.sessionId, "s1")
        XCTAssertEqual(read.closedQuestions[0].question.options[1].description, "why")
        XCTAssertTrue(read.closedQuestions[1].withdrawn)
        XCTAssertEqual(read.closedQuestions[1].withdrawReason, "not needed")

        let older = try JSONDecoder().decode(ProjectOpenItemsView.self,
                                             from: Data(#"{"needsYou":[],"withCoordinator":[]}"#.utf8))
        XCTAssertEqual(older.closedQuestions, [], "a server that predates the group has no records")
    }

    /// A record this build cannot read is a record it does not draw — never a read that fails and
    /// takes the open questions down with it.
    func testARecordThisBuildCannotReadDoesNotFailTheRead() throws {
        let json = """
        {"needsYou":[{"itemId":"open-1","kind":"COORDINATOR_QUESTION","title":"t","waitingSince":"2026-10-09T00:00:00Z",
          "question":{"question":"Still open?","options":[]}}],
         "withCoordinator":[],"closedQuestions":[{"itemId":"q1"}]}
        """
        let read = try JSONDecoder().decode(ProjectOpenItemsView.self, from: Data(json.utf8))
        XCTAssertEqual(CoordinatorQuestions.open(read).map(\.itemId), ["open-1"])
        XCTAssertEqual(read.closedQuestions, [])
    }

    // MARK: where the record is drawn

    func testEachRecordIsAReceiptAtTheMomentItEnded() {
        let items = ProjectOpenItemsView(closedQuestions: [record(), withdrawn()])
        let receipts = CoordinatorQuestions.receipts(items)
        XCTAssertEqual(receipts.map(\.moment), [Self.answeredAt, Self.answeredAt])
        XCTAssertEqual(receipts.first?.id, "question-record-item-1",
                       "beside the question card's `question-item-1`, not equal to it")
        XCTAssertEqual(DeliveredDecisionCard(kind: .coordinatorQuestionRecord(record: record())).id,
                       "question-record-item-1")
        XCTAssertTrue(CoordinatorQuestions.receipts(nil).isEmpty)
    }

    /// The read is newest first; records are adopted oldest first, so two answered between the same
    /// two rows are drawn after the same row in the order they were answered.
    func testRecordsAreAdoptedOldestFirst() {
        func ended(_ id: String, _ at: String) -> ProjectClosedQuestion {
            ProjectClosedQuestion(itemId: id, question: Self.question, askedAt: Self.askedAt,
                                  resolvedAt: at, answer: .init(option: 0))
        }
        let read = ProjectOpenItemsView(closedQuestions: [
            ended("second", "2026-10-09T00:29:36.000Z"), ended("first", "2026-10-09T00:29:23.000Z"),
            ended("yesterday", "2026-10-08T14:05:00.000Z"),
        ])
        XCTAssertEqual(CoordinatorQuestions.receipts(read).map(\.record.itemId), ["yesterday", "first", "second"])

        var state = TranscriptState()
        state.items = [.assistant(AssistantBubble(id: "asked", text: "…", streamingText: "", seq: 1, turnId: "t",
                                                  ts: "2026-10-09T00:10:00.000Z"))]
        let cards = CoordinatorQuestions.receipts(read).dropFirst().map {
            DeliveredDecisionCard(kind: .coordinatorQuestionRecord(record: $0.record), placement: .at($0.moment))
        }
        let rows = TranscriptRows.build(state: state, statusCards: [], canPageOlder: false,
                                        showWorkingIndicator: false, decisionCards: Array(cards))
        XCTAssertEqual(rows.map(\.id), ["asked", "question-record-first", "question-record-second", "transcript-bottom"])
    }

    /// Placed by `ReceiptAnchor`, the rule every record in the conversation is placed by: after the
    /// last row at or before the moment it ended, at the head when it is older than every row.
    func testTheTranscriptDrawsTheRecordWhereItEnded() {
        func bubble(_ id: String, _ ts: String) -> TranscriptItem {
            .assistant(AssistantBubble(id: id, text: "…", streamingText: "", seq: 1, turnId: "t", ts: ts))
        }
        var state = TranscriptState()
        state.items = [bubble("a", "2026-10-09T00:05:00.000Z"),
                       bubble("b", "2026-10-09T00:20:00.000Z"),
                       bubble("c", "2026-10-09T00:40:00.000Z")]
        let card = DeliveredDecisionCard(kind: .coordinatorQuestionRecord(record: record()),
                                         placement: .at(Self.answeredAt))
        let rows = TranscriptRows.build(state: state, statusCards: [], canPageOlder: false,
                                        showWorkingIndicator: false, decisionCards: [card])
        XCTAssertEqual(rows.map(\.id), ["a", "b", "question-record-item-1", "c", "transcript-bottom"])
        XCTAssertEqual(DeliveryAnchor.onArrival(of: card.kind, items: state.items), "c",
                       "the exhaustive switch names the record too")
    }

    // MARK: the console's wiring (compiled only on macOS and iOS, so asserted over its source)

    private static let consolePath = "src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift"
    private static let cardPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/ApprovalCards.swift"

    /// A missing file or marker is a FAILURE, not a skip: a wiring check that opts out quietly
    /// reports green on the one day the thing it watches goes missing.
    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String { "\(self) — not found; if it moved, move this check with it" }
    }

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw WiringError.missing(relative)
    }

    private func section(_ source: String, from: String, to: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw WiringError.missing("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    func testTheReadDrawsEveryRecordAndNeverPutsTheQuestionBack() throws {
        let console = try source(Self.consolePath)
        let read = try section(console,
                               from: "if let items = try? await api.projectOpenItems(projectID: projectID) {",
                               to: "ExceptionCards.cards(items)")
        XCTAssertTrue(read.contains("adoptQuestionRecords(items)"),
                      "the records the read carries are drawn where each ended")
        XCTAssertTrue(read.contains("for row in CoordinatorQuestions.open(items) where questionRecord(row.itemId) == nil {"),
                      "a read that left before an answer here must not put its question back")
        let adopt = try section(console, from: "private func adoptQuestionRecord(_ record: ProjectClosedQuestion) {",
                                to: "func questionRecord(_ itemID: String) -> ProjectClosedQuestion? {")
        XCTAssertTrue(adopt.contains("decisionCards.removeAll { $0.kind == .coordinatorQuestion(itemID: record.itemId) }"),
                      "the question card goes when its record comes")
        XCTAssertTrue(adopt.contains("placement: .at(receipt.moment)"),
                      "drawn at the moment it ended, resolved against the rows at render time")
    }

    func testThePressDrawsTheRecordFromWhatItSentBeforeTheReadComesBack() throws {
        let console = try source(Self.consolePath)
        let press = try section(console, from: "func answerQuestion(_ row: ProjectOpenItemRow,",
                                to: "/// Ask the coordinator again")
        let adopted = try XCTUnwrap(press.range(of: "adoptQuestionRecord(CoordinatorQuestions.answeredHere("))
        let reread = try XCTUnwrap(press.range(of: "await refreshRulerQuestions(force: true)"))
        XCTAssertLessThan(adopted.lowerBound, reread.lowerBound,
                          "the card is the record of what was sent before the read is asked, so it never stands empty")
        XCTAssertFalse(console.contains("draft.receipt"), "nothing keeps the answer in one window's memory any more")
    }

    func testTheBarCountsNoRecordAndTheCardsDrawThem() throws {
        let console = try source(Self.consolePath)
        let counted = try section(console, from: "var openBelowRows: [BelowRow] {",
                                  to: "case .acceptanceConfirmation:")
        XCTAssertTrue(counted.contains(".promotionReceipt, .coordinatorQuestionRecord:"),
                      "a record is not a question: the open-questions bar does not count it")
        let cards = try source(Self.cardPath)
        XCTAssertTrue(cards.contains("case .coordinatorQuestionRecord(let record):"))
        XCTAssertTrue(cards.contains("CoordinatorQuestionRecordView(record: console.questionRecord(record.itemId) ?? record)"))
        let questionCard = try section(cards, from: "private struct CoordinatorQuestionCardView: View {",
                                       to: "private var questionCard: some View {")
        XCTAssertTrue(questionCard.contains("if let record = console.questionRecord(itemID) {"),
                      "a sheet left open on the question shows the record once it has ended")
        let view = try section(cards, from: "private struct CoordinatorQuestionRecordView: View {",
                               to: "/// The exception that became the owner's without anybody asking")
        for line in ["CoordinatorQuestions.lead(record.question)", "CoordinatorQuestions.answerLine(record)",
                     "CoordinatorQuestions.noteLine(record)", "CoordinatorQuestions.waitingLine(record)",
                     "CoordinatorQuestions.withdrewLine(record)", "CoordinatorQuestions.withdrawReasonLine(record)",
                     "CoordinatorQuestions.time(record)", "CoordinatorQuestions.askedAtLine(record)",
                     "CoordinatorQuestions.footerLine(record)", "CoordinatorQuestions.footerDetail(record)",
                     "CoordinatorQuestions.yourNote", "CoordinatorQuestions.otherOption",
                     "CoordinatorQuestions.freeAnswerPrompt", "CoordinatorQuestions.viewDetails",
                     "MarkdownView(source: record.question.question)", "checkmark.circle.fill"] {
            XCTAssertTrue(view.contains(line), "the record view draws \(line)")
        }
        XCTAssertFalse(view.contains("detailLine"),
                       "what the question blocked while it waited is not repeated once it waits no more")
    }
}
