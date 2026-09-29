import Foundation
import XCTest
@testable import OrbitKit

/// A link to one record of a session — a turn, an event or a tool call (`SessionRecordLink`) — from
/// the URL that names it to the row the transcript scrolls to and marks. Web parity:
/// `lib/transcriptDeepLink.ts` and `WorkspaceView.sessionDeepLink.test.tsx`.
final class TranscriptDeepLinkTests: XCTestCase {
    private let session = "01a0d191-1a54-76ee-b10c-df98bbadec34"
    private let record = "01a0d191-2b10-7a00-8a00-000000000abc"
    private var sessionPublic: String { PublicID.toPublic(session) }
    private var recordPublic: String { PublicID.toPublic(record) }

    // MARK: - the link

    func testTheAppSchemeCarriesTheRecordBesideTheSessionRoute() throws {
        let url = try XCTUnwrap(URL(string: "orbit://session/\(sessionPublic)?at=\(recordPublic)"))
        // The route is the session's, exactly as before: the record rides beside it.
        XCTAssertEqual(DeepLink.parse(url), .session(sessionPublic))
        let link = try XCTUnwrap(SessionRecordLink.parse(url, host: nil))
        XCTAssertEqual(link.session, sessionPublic)
        XCTAssertEqual(link.record, recordPublic)
        // Either spelling of either id is the same record of the same session.
        let raw = try XCTUnwrap(URL(string: "orbit://session/\(session)?at=\(record)"))
        XCTAssertEqual(SessionRecordLink.parse(raw, host: nil)?.session, sessionPublic)
        XCTAssertEqual(SessionRecordLink.parse(raw, host: nil)?.record, recordPublic)
        // The app's own link to a record is that URL, and reads back as it.
        let built = SessionRecordLink.url(session: session, record: record)
        XCTAssertEqual(built.absoluteString, "orbit://session/\(sessionPublic)?at=\(recordPublic)")
        XCTAssertEqual(SessionRecordLink.parse(built, host: nil)?.record, recordPublic)
    }

    func testAPageURLOfThisDeploymentCarriesItToo() throws {
        let host = "https://orbitd.io"
        let page = try XCTUnwrap(URL(string: "https://orbitd.io/sessions/\(sessionPublic)?at=\(recordPublic)"))
        XCTAssertEqual(SessionRecordLink.parse(page, host: host)?.session, sessionPublic)
        XCTAssertEqual(SessionRecordLink.parse(page, host: host)?.record, recordPublic)
        // Another server's page, another kind of page, a session link with no record and one whose
        // record is not an id: nothing to follow — the session (if any) opens at its latest message.
        for text in ["https://elsewhere.io/sessions/\(sessionPublic)?at=\(recordPublic)",
                     "https://orbitd.io/tasks/\(sessionPublic)?at=\(recordPublic)",
                     "https://orbitd.io/sessions/\(sessionPublic)",
                     "https://orbitd.io/sessions/\(sessionPublic)?at=not-an-id!",
                     "orbit://task/\(sessionPublic)?at=\(recordPublic)"] {
            let url = try XCTUnwrap(URL(string: text))
            XCTAssertNil(SessionRecordLink.parse(url, host: host), text)
        }
        XCTAssertEqual(SessionRecordLink.parameter, "at")
    }

    // MARK: - the page

    func testThePageAroundARecordDecodesItsCursorsAndAnchor() throws {
        let around = """
        {"events":[{"seq":42,"type":"user","payload":{"text":"the question"},"turnId":"\(recordPublic)",
                    "ts":"2026-09-20T10:00:00Z"}],
         "hasMore":true,"before":42,"after":45,
         "anchor":{"kind":"turn","id":"\(recordPublic)","seq":42,"publicId":"\(recordPublic)"}}
        """
        let page = try JSONDecoder().decode(EventPage.self, from: Data(around.utf8))
        XCTAssertEqual(page.before, 42)
        XCTAssertEqual(page.after, 45)
        XCTAssertEqual(page.anchor, TranscriptAnchor(kind: "turn", id: recordPublic, seq: 42))
        // The page that reaches the tail says so with a null `after` — the same nil a tail page has.
        let last = try JSONDecoder().decode(EventPage.self,
                                            from: Data(#"{"events":[],"hasMore":true,"before":7,"after":null}"#.utf8))
        XCTAssertEqual(last.before, 7)
        XCTAssertNil(last.after)
        XCTAssertNil(last.anchor)
        let tail = try JSONDecoder().decode(EventPage.self, from: Data(#"{"events":[],"hasMore":false}"#.utf8))
        XCTAssertNil(tail.before)
        XCTAssertNil(tail.after)
    }

    // MARK: - the window

    private func ask(_ seq: Int, _ text: String, turn: String? = nil) -> RunEvent {
        RunEvent(seq: seq, type: .user, turnId: turn ?? "turn-\(seq)", payload: .object(["text": .string(text)]))
    }

    private func reply(_ seq: Int, _ text: String) -> RunEvent {
        RunEvent(seq: seq, type: .assistant, payload: .object(["text": .string(text)]))
    }

    private func call(_ seq: Int, _ id: String) -> [RunEvent] {
        [RunEvent(seq: seq, type: .toolUse,
                  payload: .object(["id": .string(id), "name": .string("Bash"),
                                    "input": .object(["command": .string("ls")])])),
         RunEvent(seq: seq + 1, type: .toolResult,
                  payload: .object(["toolUseId": .string(id), "content": .string("a"), "isError": .bool(false)]))]
    }

    private func texts(_ state: TranscriptState) -> [String] {
        state.items.compactMap { item -> String? in
            switch item {
            case .user(let b): return b.text
            case .assistant(let b): return b.text
            default: return nil
            }
        }
    }

    func testTheRecordsPageBecomesTheWindowAndNewerPagesFoldOntoItsEnd() {
        var reducer = TranscriptReducer()
        // A console already at the tail of its session, idle.
        reducer.applyTailPage(EventPage(events: [ask(300, "the latest question"), reply(301, "the latest answer"),
                                                 RunEvent(seq: 302, type: .turnEnd, payload: .object(["status": .string("AWAITING_INPUT")]))],
                                        hasMore: true))
        let statusAtTail = reducer.state.status

        // The link: the page around seq 42, with older history before it and newer after it.
        let around = EventPage(events: [ask(40, "an earlier question"), reply(41, "an earlier answer"),
                                        ask(42, "the linked question", turn: recordPublic), reply(43, "its answer"),
                                        RunEvent(seq: 44, type: .status, payload: .object(["status": .string("RUNNING")]))],
                               hasMore: true, before: 40, after: 44,
                               anchor: TranscriptAnchor(kind: "turn", id: recordPublic, seq: 42))
        reducer.applyRecordPage(around)
        XCTAssertEqual(texts(reducer.state), ["an earlier question", "an earlier answer", "the linked question", "its answer"],
                       "the window is the record's page and nothing of the tail")
        XCTAssertEqual(reducer.state.oldestSeq, 40)
        XCTAssertTrue(reducer.state.hasMoreOlder, "older history is still a page away, from the page's own cursor")
        XCTAssertEqual(reducer.state.maxSeq, 44)
        XCTAssertEqual(reducer.state.status, statusAtTail,
                       "a historical page's `status` event does not say what the session is doing now")

        // Paging down: the next newer page folds onto the end, as the live stream would have.
        reducer.appendNewer(EventPage(events: [ask(45, "a later question"), reply(46, "a later answer")],
                                      hasMore: true, before: 45, after: nil))
        XCTAssertEqual(Array(texts(reducer.state).suffix(2)), ["a later question", "a later answer"])
        XCTAssertEqual(reducer.state.maxSeq, 46, "the live stream resumes right after the last page")
        XCTAssertEqual(reducer.state.oldestSeq, 40)

        // A record page with no older history says so, and one read again replaces the window whole.
        reducer.applyRecordPage(EventPage(events: [ask(1, "the first question")], hasMore: false,
                                          before: nil, after: 1))
        XCTAssertEqual(texts(reducer.state), ["the first question"])
        XCTAssertFalse(reducer.state.hasMoreOlder)
        XCTAssertEqual(reducer.state.maxSeq, 1)
    }

    // MARK: - the row

    func testTheAnchorLandsOnTheRowThatShowsTheRecord() throws {
        let events = [ask(10, "the question", turn: recordPublic), reply(11, "the answer")]
            + call(12, "toolu_a") + call(14, "toolu_b") + call(16, "toolu_c")
            + [reply(18, "what the calls found"), RunEvent(seq: 19, type: .turnEnd, payload: .object([:])),
               RunEvent(seq: 20, type: .user, turnId: nil,
                        payload: .object(["text": .string("a question whose bubble kept no turn")]))]
        var reducer = TranscriptReducer()
        reducer.applyTailPage(EventPage(events: events, hasMore: false))
        let items = reducer.state.items
        let rows = TranscriptRows.build(state: reducer.state, statusCards: [], canPageOlder: false,
                                        showWorkingIndicator: false)

        func row(_ anchor: TranscriptAnchor) -> String? {
            TranscriptRecordAnchor.itemID(for: anchor, page: events, in: items)
                .flatMap { TranscriptRecordAnchor.rowID(containing: $0, in: rows) }
        }
        func itemID(where match: (TranscriptItem) -> Bool) throws -> String {
            try XCTUnwrap(items.first(where: match)).id
        }
        let question = try itemID { if case .user(let b) = $0 { return b.text == "the question" }; return false }
        let answer = try itemID { if case .assistant(let b) = $0 { return b.text == "the answer" }; return false }
        let found = try itemID { if case .assistant(let b) = $0 { return b.text == "what the calls found" }; return false }

        // A turn is the message it sent, found by its turn id…
        XCTAssertEqual(row(TranscriptAnchor(kind: "turn", id: recordPublic, seq: 10)), question)
        // …compared as an id: the anchor spelled one way finds the bubble that kept the other, even
        // with no page to read the event from.
        let byAnchorAlone = TranscriptRecordAnchor.itemID(for: TranscriptAnchor(kind: "turn", id: record, seq: 10),
                                                          page: [], in: items)
        XCTAssertEqual(byAnchorAlone, question)
        // An event is its own row.
        XCTAssertEqual(row(TranscriptAnchor(kind: "event", id: "e", seq: 11)), answer)
        // Three calls in a run fold into one row, named by its first call: a tool call — or its
        // result — inside the run lands on that row.
        let group = try XCTUnwrap(rows.first { if case .toolGroup = $0 { return true }; return false })
        XCTAssertEqual(group.id, "toolu_a")
        XCTAssertEqual(row(TranscriptAnchor(kind: "tool_call", id: "c", seq: 14)), group.id)
        XCTAssertEqual(row(TranscriptAnchor(kind: "event", id: "r", seq: 17)), group.id)
        // An event that drew nothing of its own (a turn's end) lands on the last row before it.
        XCTAssertEqual(row(TranscriptAnchor(kind: "event", id: "t", seq: 19)), found)
        // A message whose bubble carries no turn id is still found where it sits — here, last.
        let lastQuestion = try itemID { if case .user(let b) = $0 { return b.text.contains("kept no turn") }; return false }
        XCTAssertEqual(row(TranscriptAnchor(kind: "event", id: "u", seq: 20)), lastQuestion)
    }

    // MARK: - the words

    /// The sentences a link to a record puts on screen are the web's, word for word. A missing web
    /// file is a failure and never a skip: a check that opts out reports green on exactly the day the
    /// thing it watches goes missing.
    func testTheCopyIsTheWebsWordForWord() throws {
        let webFile = "src/web/src/lib/transcriptDeepLink.ts"
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        var source: String?
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(webFile)
            if FileManager.default.fileExists(atPath: candidate.path) {
                source = try String(contentsOf: candidate, encoding: .utf8)
                break
            }
            dir = dir.deletingLastPathComponent()
        }
        let web = try XCTUnwrap(source, "\(webFile) was not found above this test: move this check with it")
        for (name, value) in [("RECORD_NOT_FOUND", SessionRecordLink.Copy.notFound),
                              ("JUMP_TO_LATEST", SessionRecordLink.Copy.jumpToLatest),
                              ("LOADING_NEWER", SessionRecordLink.Copy.loadingNewer),
                              ("RECORD_PARAM", SessionRecordLink.parameter)] {
            XCTAssertTrue(web.contains("export const \(name) = '\(value)'"),
                          "the web no longer declares \(name) as \(value.debugDescription)")
        }
    }
}
