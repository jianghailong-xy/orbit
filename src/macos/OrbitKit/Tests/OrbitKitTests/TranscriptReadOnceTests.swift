import XCTest
@testable import OrbitKit

/// What the console reads once instead of on every update or scroll — a row's clock
/// (`ThinkingSummary.date` through `RelativeTime.parse`'s cache, `ReceiptAnchor.Clocks` handed to
/// `TranscriptRows.build`) and which user turns are questions (`StickyQuestions`) — must answer
/// exactly what reading it every time answered. Each test holds the kept answer to the old reading.
final class TranscriptReadOnceTests: XCTestCase {
    // MARK: clocks

    /// The two formatters `ThinkingSummary` kept of its own before it asked `RelativeTime.parse`.
    private static let oldFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let oldWhole = ISO8601DateFormatter()

    private func oldDate(_ stamp: String?) -> Date? {
        guard let stamp else { return nil }
        return Self.oldFractional.date(from: stamp) ?? Self.oldWhole.date(from: stamp)
    }

    private static let stamps = [
        "2026-09-15T17:51:52.123Z", "2026-09-15T17:51:52Z", "2026-09-15T17:51:52.1Z",
        "2026-09-15T17:51:52.123456Z", "2026-09-15T19:51:52+02:00", "2026-09-15T19:51:52.5+02:00",
        "2026-09-15", "2026-09-15 17:51:52Z", "17:51:52Z", "", "not a time", "2026-13-40T99:99:99Z",
    ]

    func testAStampReadsTheSameThroughTheCacheAsThroughTheOldFormatters() {
        XCTAssertEqual(ISO8601DateFormatter().formatOptions, [.withInternetDateTime],
                       "the default the old whole-second formatter relied on")
        XCTAssertNil(ThinkingSummary.date(nil))
        for stamp in Self.stamps {
            // Twice: the first read fills the cache, the second is answered from it.
            XCTAssertEqual(ThinkingSummary.date(stamp), oldDate(stamp), stamp)
            XCTAssertEqual(ThinkingSummary.date(stamp), oldDate(stamp), stamp)
        }
        XCTAssertNotNil(ThinkingSummary.date("2026-09-15T17:51:52Z"))
        XCTAssertNotNil(ThinkingSummary.date("2026-09-15T17:51:52.123Z"))
    }

    func testTheReadMomentsOrderAsTheStampsDid() {
        for a in Self.stamps {
            for b in Self.stamps {
                let old: Bool = {
                    guard let x = oldDate(a), let y = oldDate(b) else { return false }
                    return x < y
                }()
                XCTAssertEqual(ReceiptAnchor.ascending(a, b), old, "\(a) < \(b)")
                XCTAssertEqual(ReceiptAnchor.ascending(ThinkingSummary.date(a), ThinkingSummary.date(b)), old)
            }
        }
    }

    private func user(_ id: String, _ text: String = "hi", queued: Bool = false,
                      note: String? = nil, at ts: String? = nil) -> UserBubble {
        var b = UserBubble(id: id, text: text, ts: ts, pending: false, queued: queued)
        b.note = note
        return b
    }

    private func receipt(_ intent: String, at stamp: String) -> DeliveredDecisionCard {
        DeliveredDecisionCard(kind: .criteriaDecisionReceipt(settled: SettledCriteriaDecision(
            intentId: intent, decision: .approve, decidedAt: stamp,
            baseSeal: "a", resultingSeal: "b")), placement: .at(stamp))
    }

    /// Rows built with clocks read once (the console's `receiptClocks`) are the rows built reading
    /// them itself, and records above the window — ties, unreadable stamps and all — keep the order
    /// the sort reading each moment inside the comparator gave them.
    func testRowsBuiltWithKeptClocksAreTheRowsBuiltWithout() {
        var state = TranscriptState()
        state.items = [.user(user("i1", at: "2026-09-21T09:00:00.000Z")),
                       .assistant(AssistantBubble(id: "a1", text: "…", streamingText: "", seq: 1,
                                                  turnId: "t", ts: "2026-09-21T09:10:00Z")),
                       .interrupt(id: "x1", seq: 9),
                       .user(user("i2", at: "2026-09-21T10:00:00.000Z"))]
        state.oldestSeq = 7
        var cards: [DeliveredDecisionCard] = []
        let moments = ["2026-09-20T09:00:00.000Z", "2026-09-19T09:00:00Z", "2026-09-20T09:00:00Z",
                       "2026-09-18T23:59:59.999Z", "2026-09-21T09:05:00.000Z", "bogus",
                       "2026-09-21T11:00:00Z", "2026-09-19T09:00:00.000Z", "2026-09-17T00:00:00Z"]
        for (n, moment) in moments.enumerated() { cards.append(receipt("r\(n)", at: moment)) }
        cards.append(DeliveredDecisionCard(kind: .criteriaDecision(intentID: "q"),
                                           placement: .onArrival(afterItemID: "i1")))

        let read = TranscriptRows.build(state: state, statusCards: [], canPageOlder: true,
                                        showWorkingIndicator: false, decisionCards: cards)
        let kept = TranscriptRows.build(state: state, statusCards: [], canPageOlder: true,
                                        showWorkingIndicator: false, decisionCards: cards,
                                        clocks: ReceiptAnchor.Clocks(state.items))
        XCTAssertEqual(kept.map(\.id), read.map(\.id))

        // The head, against the sort as it was: in place, each moment read inside the comparator.
        var head = cards.filter {
            guard case .at(let moment) = $0.placement else { return false }
            return ReceiptAnchor.place(ReceiptAnchor.Clocks(state.items), at: moment) == .beforeWindow
        }
        head.sort { a, b in
            guard case .at(let x) = a.placement, case .at(let y) = b.placement else { return false }
            guard let x = oldDate(x), let y = oldDate(y) else { return false }
            return x < y
        }
        XCTAssertEqual(Array(kept.map(\.id).prefix(head.count)), head.map(\.id))
        XCTAssertEqual(kept.map(\.id)[head.count], "load-older-7")
    }

    // MARK: questions

    private static let jobNote = """
        <background-job-wake>
          A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:
            bgj_13c53745a88a｜job｜bash scripts/run-pg-spec.sh｜pg matrix
              ended｜failed｜exit code 124
              output /root/.orbit/runs/4f50733a/bgj_13c53745a88a.output｜this covers bytes 0–512
              (no output)
          The control plane recorded this for you; the user did not say it.
        </background-job-wake>
        """

    /// `ConsoleView.namesAQuestion`, as the console asks it.
    private func namesAQuestion(_ b: UserBubble) -> Bool {
        !b.queued && StickySummary.isAnchor(text: b.text, note: b.note, itemCard: b.itemCard,
                                            taskStart: b.taskStart, startedCard: b.startedCard,
                                            sessionMessage: b.sessionMessage)
    }

    /// `recomputeStuck`'s walk as it was: from the head to the anchor, or from the tail when no row
    /// has claimed the top.
    private func walk(_ items: [TranscriptItem], anchor: String?) -> String? {
        var found: String? = nil
        if let anchor {
            for item in items {
                if item.id == anchor { break }
                if case .user(let b) = item, namesAQuestion(b) { found = b.id }
            }
        } else {
            for item in items.reversed() {
                if case .user(let b) = item, namesAQuestion(b) { found = b.id; break }
            }
        }
        return found
    }

    private func transcript() -> [TranscriptItem] {
        [
            .assistant(AssistantBubble(id: "a0", text: "hello", streamingText: "", seq: 1, turnId: nil)),
            .user(user("u1", "deploy it")),
            .thinking(ThinkingBlock(id: "t1", text: "…", streamingText: "", seq: 2)),
            .user(user("u2", "", note: Self.jobNote)),                 // a job's news: not a question
            .assistant(AssistantBubble(id: "a1", text: "ok", streamingText: "", seq: 3, turnId: nil)),
            .user(user("u3", "and the dark theme", note: Self.jobNote)), // typed on the wake: one
            .user(user("u4", WatchFixture.matchWake())),               // a watch's wake: one
            .interrupt(id: "x1", seq: 9),
            .user(user("u5", "queued", queued: true)),                 // not asked yet
            .assistant(AssistantBubble(id: "u1", text: "dup", streamingText: "", seq: 4, turnId: nil)),
            .user(user("u6", "", note: Self.jobNote)),
            .assistant(AssistantBubble(id: "a2", text: "done", streamingText: "", seq: 5, turnId: nil)),
        ]
    }

    func testTheQuestionsReadOnceNameWhatTheWalkNamed() {
        let shapes: [[TranscriptItem]] = [[], transcript(), Array(transcript().prefix(4)),
                                          transcript().filter { if case .user = $0 { return false }; return true },
                                          transcript().reversed()]
        for items in shapes {
            let questions = StickyQuestions(items, isQuestion: namesAQuestion)
            XCTAssertEqual(questions.last, walk(items, anchor: nil))
            for anchor in items.map(\.id) + ["gone", ""] {
                XCTAssertEqual(questions.above(anchor), walk(items, anchor: anchor),
                               "anchor \(anchor) in \(items.map(\.id))")
            }
        }
    }

    func testTheTranscriptNamesTheTurnsItShould() {
        let questions = StickyQuestions(transcript(), isQuestion: namesAQuestion)
        XCTAssertNil(questions.above("a0"))
        XCTAssertNil(questions.above("u1"), "an id met twice stops at its first")
        XCTAssertEqual(questions.above("a1"), "u1", "a job's news is a line inside the answer")
        XCTAssertEqual(questions.above("x1"), "u4")
        XCTAssertEqual(questions.above("a2"), "u4", "a queued turn has not been asked")
        XCTAssertEqual(questions.above("trimmed"), "u4", "an anchor no longer held: every question")
        XCTAssertEqual(questions.last, "u4")
    }
}
