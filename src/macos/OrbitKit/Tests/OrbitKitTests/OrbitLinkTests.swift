import Foundation
import XCTest
@testable import OrbitKit

/// Orbit links: which ones become cards, where the card goes, and what it says.
///
/// The rules are written once in the project's own words and are the same on all three clients, so
/// this file is the native half of a pair: `src/shared/src/orbit-link.fixture.json` is the same set
/// of cases the web client reads, and `testEverySharedCaseRuns` walks it in full. That test fails —
/// never skips — when the file cannot be found: a check that quietly opts out reports green on
/// exactly the day the thing it watches goes missing.
///
/// The ids below are production rows from 2026-09-23, the same conversation the iOS mock is drawn
/// from, so a failure here reads against the same object the screenshots show.
final class OrbitLinkTests: XCTestCase {

    // MARK: ids

    private let taskID = "34TcwNgAIo6tGUiIKjqnQ"
    private let taskUUID = "01a0cca7-8609-70ed-a0e2-d4b55b832b60"
    private let sessionID = "34TYUP5wb87XfuYCInJRY"
    private let sessionUUID = "01a0cc01-771c-767d-846b-8fddfa669490"
    private let projectID = "34Tcl0kralZrY8opuLJU4"
    private let projectUUID = "01a0cca0-aeaa-7618-bd5a-caccc089108c"
    private let listID = "347en66xizlGSG9a6Nej5"
    private let listUUID = "01a00627-1ce2-7302-8e73-89516a879df3"
    private let goneID = "34Mx0dQe8RkV2uLbNw7Ta"

    private let host = "orbitd.io"
    private var baseURL: URL { URL(string: "https://orbitd.io")! }

    /// One instant every relative time in this file is measured from.
    private var now: Date { RelativeTime.parse("2026-09-23T13:00:00.000Z")! }

    // MARK: helpers

    private func place(_ text: String, host: String? = nil) -> [OrbitRenderBlock] {
        OrbitLinkPlacement.place(parseMarkdownBlocks(text), host: host ?? self.host)
    }

    private func pageRef(_ kind: OrbitLinkKind, _ id: String, _ url: String, uuid: String) -> OrbitRenderBlock {
        .card(OrbitLinkRef(target: OrbitLinkTarget(kind: kind, id: uuid), source: .pageURL(url)))
    }

    private func referenceRef(_ kind: OrbitLinkKind, _ id: String, uuid: String) -> OrbitRenderBlock {
        .card(OrbitLinkRef(target: OrbitLinkTarget(kind: kind, id: uuid),
                           source: .reference("orbit-\(kind.rawValue):\(id)")))
    }

    private func paragraph(_ text: String) -> OrbitRenderBlock { .markdown(.paragraph(text: text)) }

    private func preview(_ json: String, line: UInt = #line) throws -> LinkPreview {
        do {
            return try JSONDecoder().decode(LinkPreview.self, from: Data(json.utf8))
        } catch {
            XCTFail("the wire shape below is not what the DTO reads: \(error)", line: line)
            throw error
        }
    }

    private func ref(_ kind: OrbitLinkKind, _ id: String, _ source: OrbitLinkSource) -> OrbitLinkRef {
        OrbitLinkRef(target: OrbitLinkTarget(kind: kind, id: id), source: source)
    }

    // MARK: the shared cases, walked in full

    /// Every case in `src/shared/src/orbit-link.fixture.json`, against this client's reading of it.
    ///
    /// The file is the contract: the same text, the same host, the same blocks the web client has to
    /// produce. Reading it here rather than restating it is what makes the two ends provably the
    /// same rule instead of two rules that happen to agree today.
    func testEverySharedCaseRuns() throws {
        let fixture = try SharedFixture.load()
        XCTAssertFalse(fixture.cases.isEmpty, "the shared fixture has no cases in it")
        for item in fixture.cases {
            let got = OrbitLinkPlacement.place(parseMarkdownBlocks(item.text),
                                               host: item.host ?? fixture.host)
            let expected = try item.expected()
            XCTAssertEqual(got, expected, "shared case failed: \(item.name)\n"
                               + "text: \(item.text.debugDescription)")
        }
        // The coverage the fixture is for, so a case deleted in passing is a failure rather than one
        // fewer line of output. Deliberately a check on the shapes, not on the exact sentences.
        let names = fixture.cases.map(\.name)
        for required in ["url at the start", "url alone", "url at the end", "middle of a sentence"] {
            XCTAssertTrue(names.contains { $0.contains(required) },
                          "the fixture no longer covers \"\(required)\": \(names)")
        }
        let excluded = names.filter { $0.hasPrefix("excluded") }
        XCTAssertGreaterThanOrEqual(excluded.count, 6,
                                    "the fixture must keep every excluded path: \(names)")
        for required in ["a reference written into a sentence", "a reference in a list item",
                         "a reference in a table cell", "alone in a paragraph"] {
            XCTAssertTrue(names.contains { $0.contains(required) },
                          "the fixture no longer covers \"\(required)\": \(names)")
        }
    }

    /// The repository root, found by walking up from this file until the shared fixture is under
    /// foot. Not a fixed number of `..` hops: how deep this file sits is not what is being asserted.
    private enum SharedFixture {
        struct Fixture { let host: String; let cases: [Case] }

        struct Case {
            let name: String
            let text: String
            let host: String?
            let blocks: [Block]

            func expected() throws -> [OrbitRenderBlock] { try blocks.map { try $0.render() } }
        }

        struct Block: Decodable {
            let card: Card?
            let markdown: Markdown?

            struct Card: Decodable {
                let kind: String
                let id: String
                let url: String?
                let ref: String?
            }

            struct Markdown: Decodable {
                let type: String
                let text: String?
                let level: Int?
                let language: String?
                let code: String?
                let source: String?
                let alt: String?
                let items: [Item]?
                let headers: [String]?
                let rows: [[String]]?
                let alignments: [String]?

                struct Item: Decodable {
                    let indent: Int
                    let ordered: Bool
                    let number: Int?
                    let text: String
                    let checkbox: Bool?
                }
            }

            func render() throws -> OrbitRenderBlock {
                if let card {
                    guard let kind = OrbitLinkKind(rawValue: card.kind) else {
                        throw FixtureError.bad("unknown card kind \(card.kind)")
                    }
                    let source: OrbitLinkSource
                    if let ref = card.ref { source = .reference(ref) }
                    else if let url = card.url { source = .pageURL(url) }
                    else { throw FixtureError.bad("a card with neither url nor ref") }
                    return .card(OrbitLinkRef(target: OrbitLinkTarget(kind: kind, id: card.id), source: source))
                }
                guard let markdown else { throw FixtureError.bad("a block that is neither a card nor markdown") }
                switch markdown.type {
                case "paragraph":
                    return .markdown(.paragraph(text: try text(markdown)))
                case "heading":
                    return .markdown(.heading(level: markdown.level ?? 1, text: try text(markdown)))
                case "quote":
                    return .markdown(.quote(text: try text(markdown)))
                case "code":
                    return .markdown(.code(language: markdown.language, code: markdown.code ?? ""))
                case "rule":
                    return .markdown(.rule)
                case "image":
                    return .markdown(.image(source: markdown.source ?? "", alt: markdown.alt ?? ""))
                case "list":
                    let items = (markdown.items ?? []).map {
                        MarkdownListItem(indent: $0.indent, ordered: $0.ordered, number: $0.number,
                                         text: $0.text, checkbox: $0.checkbox)
                    }
                    return .markdown(.list(items: items))
                case "table":
                    return .markdown(.table(MarkdownTable(
                        headers: markdown.headers ?? [],
                        rows: markdown.rows ?? [],
                        alignments: (markdown.alignments ?? []).map {
                            switch $0 {
                            case "left":   return .left
                            case "center": return .center
                            case "right":  return .right
                            default:       return .none
                            }
                        })))
                default:
                    throw FixtureError.bad("unknown markdown type \(markdown.type)")
                }
            }

            private func text(_ markdown: Markdown) throws -> String {
                guard let text = markdown.text else { throw FixtureError.bad("a \(markdown.type) with no text") }
                return text
            }
        }

        enum FixtureError: Error, CustomStringConvertible {
            case noRepo
            case missing(String)
            case bad(String)

            var description: String {
                switch self {
                case .noRepo:
                    return "\(path) was not found above this test file. It is the set of cases this "
                        + "client shares with the web client — if it moved, point this check at its new "
                        + "home rather than deleting it."
                case .missing(let file):
                    return "\(file) was not found. The two clients are proved against the same cases; "
                        + "one of them missing its half means neither proves anything."
                case .bad(let why):
                    return "the shared fixture is not readable as its own format: \(why)"
                }
            }
        }

        static let path = "src/shared/src/orbit-link.fixture.json"

        private static func repoRoot() throws -> URL {
            var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            for _ in 0..<12 {
                if FileManager.default.fileExists(atPath: dir.appendingPathComponent(path).path) {
                    return dir
                }
                dir = dir.deletingLastPathComponent()
            }
            // Deliberately a failure and not an `XCTSkip`, for the reason in the type's note above.
            throw FixtureError.noRepo
        }

        static func load() throws -> Fixture {
            let url = try repoRoot().appendingPathComponent(path)
            guard let data = FileManager.default.contents(atPath: url.path) else {
                throw FixtureError.missing(path)
            }
            let raw = try JSONDecoder().decode(Raw.self, from: data)
            return Fixture(host: raw.host, cases: raw.cases.map {
                Case(name: $0.name, text: $0.text, host: $0.host, blocks: $0.blocks)
            })
        }

        private struct Raw: Decodable {
            let host: String
            let cases: [RawCase]

            struct RawCase: Decodable {
                let name: String
                let text: String
                let host: String?
                let blocks: [Block]
            }
        }
    }

    // MARK: the four positions

    /// Where a pasted page URL can stand in a sentence, and what is left of the sentence in each
    /// case. An empty fragment is dropped — a paragraph that was nothing but the URL is nothing but
    /// the card — and the words either side keep their own order.
    func testTheFourPositionsAURLCanStandIn() {
        let url = "https://orbitd.io/tasks/\(taskID)"
        let card = pageRef(.task, taskID, url, uuid: taskUUID)

        XCTAssertEqual(place("\(url) 看这个"), [card, paragraph("看这个")],
                       "a URL with words after it")
        XCTAssertEqual(place(url), [card], "a URL alone on its line")
        XCTAssertEqual(place("看看这个 \(url)"), [paragraph("看看这个"), card],
                       "a URL with words before it")
        XCTAssertEqual(place("先看 \(url) 再决定"), [paragraph("先看"), card, paragraph("再决定")],
                       "a URL in the middle of a sentence")
        XCTAssertEqual(place("\(url) \(url)"), [card, card],
                       "two links in one message are two cards, and the gap between them is nothing")
    }

    /// The autolink form, which is what a pasted link becomes in a markdown field: the angle
    /// brackets belong to the card's span, not to the text it left behind.
    func testAngleBracketsArePartOfWhatTheCardReplaces() {
        let url = "https://orbitd.io/projects/\(projectID)"
        XCTAssertEqual(place("<\(url)>"), [pageRef(.project, projectID, url, uuid: projectUUID)])
        XCTAssertEqual(place("看看 <\(url)> 这个项目"),
                       [paragraph("看看"), pageRef(.project, projectID, url, uuid: projectUUID),
                        paragraph("这个项目")])
    }

    // MARK: what is recognised

    func testBothSpellingsOfAnIDNameTheSameObject() {
        let publicURL = "https://orbitd.io/tasks/\(taskID)"
        let uuidURL = "https://orbitd.io/tasks/01A0CCA7-8609-70ED-A0E2-D4B55B832B60"
        XCTAssertEqual(place(publicURL), [pageRef(.task, taskID, publicURL, uuid: taskUUID)])
        // The canonical spelling is the id, not what was written: a card that kept the UUID would
        // miss every cache entry the public spelling had already filled, and the other way round.
        XCTAssertEqual(place(uuidURL), [pageRef(.task, taskID, uuidURL, uuid: taskUUID)])
    }

    func testEveryPagePathThatNamesAnObject() {
        for (path, kind, id, uuid) in [("tasks", OrbitLinkKind.task, taskID, taskUUID),
                                       ("sessions", .session, sessionID, sessionUUID),
                                       ("projects", .project, projectID, projectUUID),
                                       ("lists", .list, listID, listUUID)] {
            let url = "https://orbitd.io/\(path)/\(id)"
            XCTAssertEqual(place(url), [pageRef(kind, id, url, uuid: uuid)], url)
        }
        // The pre-1.0 spellings both name a session.
        for workspace in ["workspaces/orbit", "agents/orbit"] {
            let url = "https://orbitd.io/\(workspace)/sessions/\(sessionID)"
            XCTAssertEqual(place(url), [pageRef(.session, sessionID, url, uuid: sessionUUID)], url)
        }
        // A path with parameters still names the object in its path.
        let withQuery = "https://orbitd.io/tasks/\(taskID)?list=\(listID)#done"
        XCTAssertEqual(place(withQuery), [pageRef(.task, taskID, withQuery, uuid: taskUUID)])
        // The deployment's own scheme is not part of which host it is.
        let plain = "http://orbitd.io/tasks/\(taskID)"
        XCTAssertEqual(place(plain), [pageRef(.task, taskID, plain, uuid: taskUUID)])
    }

    /// Every link that keeps its own shape today, for the reason the rule gives: a card would
    /// replace the thing the reader pasted with a summary of it.
    func testTheLinksThatStayLinks() {
        let unchanged = [
            "https://orbitd.io/api/runner/tasks/\(taskID)",     // a pasted error log
            "https://orbitd.io/dl/\(taskID)",
            "https://orbitd.io/install",
            "https://orbitd.io/s/9f3c1a7b",
            "https://orbitd.io/lists/none",                     // no list, and never was one
            "https://orbitd.io/settings/tokens",
            "https://other.example/tasks/\(taskID)",            // somebody else's deployment
            "https://orbitd.io.evil.example/tasks/\(taskID)",
            "https://orbitd.io:8443/tasks/\(taskID)",
            "[这个任务](https://orbitd.io/tasks/\(taskID))",      // a link with a label of its own
            "[截图](https://orbitd.io/tasks/\(taskID).png)",
            "`https://orbitd.io/tasks/\(taskID)`",              // code, not a link
            "**https://orbitd.io/tasks/\(taskID)**",            // emphasis around a token
            "xhttps://orbitd.io/tasks/\(taskID)",
            "https://orbitd.io/tasks/abc-def",
            "https://orbitd.io/workspaces/orbit/projects/\(projectID)",
            "看看https://orbitd.io/tasks/\(taskID)",             // glued to a word, so not a token
        ]
        for text in unchanged {
            XCTAssertEqual(place(text), [paragraph(text)], "should have stayed as it was: \(text)")
        }
        // The port only matters when the reader's own server names one.
        let localhost = "http://localhost:3000/tasks/\(taskID)"
        XCTAssertEqual(place("http://localhost:8123/tasks/\(taskID)", host: "localhost:3000"),
                       [paragraph("http://localhost:8123/tasks/\(taskID)")])
        XCTAssertEqual(place(localhost, host: "localhost:3000"),
                       [pageRef(.task, taskID, localhost, uuid: taskUUID)])
    }

    /// A reference is a card only when it is the whole paragraph. Written into a sentence, a list
    /// item or a table cell it stays the name link it is today — that is where most of them are.
    func testAReferenceIsACardOnlyOnItsOwn() {
        let link = "[runner + web：配额按账户归属](orbit-task:\(taskID))"
        XCTAssertEqual(place(link), [referenceRef(.task, taskID, uuid: taskUUID)])
        XCTAssertEqual(place("  \(link)  "), [referenceRef(.task, taskID, uuid: taskUUID)],
                       "surrounding whitespace is not a sentence")

        for text in ["这个已经合了：\(link)，看下一个。",
                     "- \(link)\n- 另一条",
                     "| 单 | 链接 |\n| --- | --- |\n| 已合 | \(link) |",
                     "> \(link)",
                     "# \(link)",
                     "\(link) 后面还有话"] {
            let blocks = parseMarkdownBlocks(text)
            XCTAssertEqual(place(text), blocks.map { OrbitRenderBlock.markdown($0) },
                           "a reference here is not a card: \(text)")
        }

        // The four kinds, and a scheme this deployment does not have.
        for kind in OrbitLinkKind.allCases {
            let own = "[x](orbit-\(kind.rawValue):\(listID))"
            let target = OrbitLinkTarget(kind: kind, id: listUUID)
            XCTAssertEqual(place(own),
                           [.card(OrbitLinkRef(target: target,
                                               source: .reference("orbit-\(kind.rawValue):\(listID)")))])
        }
        for text in ["[x](orbit-attachment:\(taskID))", "[x](orbit-task:)", "[x](orbit-task:abc-def)",
                     "[x](https://orbitd.io/tasks/\(taskID))"] {
            XCTAssertEqual(place(text), [paragraph(text)], "should have stayed as it was: \(text)")
        }
    }

    // MARK: what the four cards say

    /// A task: its pill, the project it is filed under, and how its newest run came out.
    func testTheTaskCard() throws {
        let json = """
        {"kind":"task","id":"\(taskID)","state":"ok","task":{
          "title":"runner + web：配额按账户归属","status":"DONE","running":false,"queued":false,
          "project":{"id":"\(projectID)","title":"Codex 多账户：一台机器上登录多个 Codex"},
          "assignee":{"id":"3CuIHiSJZBQ7nLVUwc7ekz","name":"orbit"},
          "runs":2,
          "lastRun":{"status":"SUCCEEDED","runState":"SUCCEEDED","numTurns":93,
                     "endedAt":"2026-09-23T12:16:00.000Z"},
          "updatedAt":"2026-09-23T12:16:00.000Z"}}
        """
        let url = "https://orbitd.io/tasks/\(taskID)"
        let content = OrbitLinkCardContent.preview(ref(.task, taskUUID, .pageURL(url)),
                                                   try preview(json), host: host, now: now)
        XCTAssertEqual(content.state, .ready)
        XCTAssertEqual(content.kind, .task)
        XCTAssertEqual(content.title, "runner + web：配额按账户归属")
        XCTAssertEqual(content.pill, TaskPill(kind: .done, label: "Done"))
        XCTAssertEqual(content.lines.count, 2)
        XCTAssertEqual(content.lines[0], OrbitLinkCardContent.Line(
            text: "Codex 多账户：一台机器上登录多个 Codex", glyph: .project))
        XCTAssertEqual(content.lines[1].text, "orbit · 2 runs · last Succeeded, 93 turns · 44m ago")
        XCTAssertEqual(content.lines[1].isWarning, false)
        XCTAssertNil(content.foot)
        XCTAssertEqual(content.path, "orbitd.io/tasks/\(taskID)")

        // A live run outranks the lifecycle, and a task nothing has run says so.
        let running = try preview("""
        {"kind":"task","id":"\(taskID)","state":"ok","task":{"title":"t","status":"OPEN","running":true,
          "queued":false,"assignee":null,"runs":0,"lastRun":null,"updatedAt":null}}
        """)
        let runningContent = OrbitLinkCardContent.preview(ref(.task, taskUUID, .pageURL(url)),
                                                          running, host: host, now: now)
        XCTAssertEqual(runningContent.pill, TaskPill(kind: .running, label: "Running"))
        XCTAssertEqual(runningContent.lines[0].text, "Unassigned · never run")

        // A status this build has never heard of keeps its own name (ReferencedTaskNote's rule).
        let unknown = try preview("""
        {"kind":"task","id":"\(taskID)","state":"ok","task":{"title":"t","status":"ARCHIVED",
          "assignee":null,"runs":1,"lastRun":{"status":"FAILED","runState":"FAILED","numTurns":0,
          "endedAt":"2026-09-23T12:00:00.000Z"}}}
        """)
        let unknownContent = OrbitLinkCardContent.preview(ref(.task, taskUUID, .pageURL(url)),
                                                          unknown, host: host, now: now)
        XCTAssertEqual(unknownContent.pill, TaskPill(kind: .open, label: "ARCHIVED"))
        XCTAssertEqual(unknownContent.lines.count, 1, "a task in no project draws no project row")
        XCTAssertEqual(unknownContent.lines[0].text, "Unassigned · 1 run · last Failed · 1h ago")
    }

    /// A session: the glyph's own word, the Coordinator badge, and who ran it.
    func testTheSessionCard() throws {
        let json = """
        {"kind":"session","id":"\(sessionID)","state":"ok","session":{
          "id":"\(sessionID)","title":"Codex 多账户：一台机器上登录多个 Codex",
          "status":"AWAITING_INPUT","runState":"AWAITING_INPUT","sessionState":"AWAITING_INPUT",
          "lifecycleState":"OPEN","endReason":null,"error":null,"retryAt":null,
          "engineTurnActive":false,"pendingApprovals":0,"waitingKind":null,
          "runningBgCount":0,"runningBgJobCount":0,"watching":null,
          "workspace":{"id":"3CuIHiSJZBQ7nLVUwc7ekz","name":"orbit"},"model":"Opus 5.5",
          "numTurns":240,"createdAt":"2026-09-22T10:00:00.000Z",
          "lastTurnAt":"2026-09-23T12:30:00.000Z","updatedAt":"2026-09-23T12:30:00.000Z",
          "projectId":"\(projectID)","projectTitle":"Codex 多账户"}}
        """
        let url = "https://orbitd.io/sessions/\(sessionID)"
        let content = OrbitLinkCardContent.preview(ref(.session, sessionUUID, .pageURL(url)),
                                                   try preview(json), host: host, now: now)
        XCTAssertEqual(content.state, .ready)
        XCTAssertEqual(content.sessionGlyph?.label, "Waiting for your reply",
                       "the card says what the glyph says, nothing of its own")
        XCTAssertNil(content.pill)
        XCTAssertEqual(content.lines.count, 1)
        XCTAssertEqual(content.lines[0].badge, "Coordinator")
        XCTAssertEqual(content.lines[0].text, "orbit · Opus 5.5 · 240 turns · 30m ago")

        // An ordinary session has no badge, and a running one says Running.
        let running = try preview("""
        {"kind":"session","id":"\(sessionID)","state":"ok","session":{"id":"\(sessionID)","title":"执行任务：x",
          "status":"RUNNING","runState":"RUNNING","workspace":{"id":"w","name":"orbit"},"model":"Opus 5.5",
          "numTurns":3,"updatedAt":"2026-09-23T12:59:50.000Z","projectId":null}}
        """)
        let runningContent = OrbitLinkCardContent.preview(ref(.session, sessionUUID, .pageURL(url)),
                                                          running, host: host, now: now)
        XCTAssertEqual(runningContent.sessionGlyph?.label, "Running")
        XCTAssertEqual(runningContent.sessionGlyph?.tone, .brand)
        XCTAssertNil(runningContent.lines[0].badge)
        XCTAssertEqual(runningContent.lines[0].text, "orbit · Opus 5.5 · 3 turns · just now")

        // Watching is a word the glyph already has for a parked session on live watches.
        let watching = try preview("""
        {"kind":"session","id":"\(sessionID)","state":"ok","session":{"id":"\(sessionID)","title":"t",
          "status":"AWAITING_INPUT","runState":"AWAITING_INPUT",
          "watching":{"active":1,"paused":0,"targets":7},"numTurns":0,"updatedAt":"2026-09-23T12:00:00.000Z"}}
        """)
        let watchingContent = OrbitLinkCardContent.preview(ref(.session, sessionUUID, .pageURL(url)),
                                                           watching, host: host, now: now)
        XCTAssertEqual(watchingContent.sessionGlyph?.label, "Watching 7 targets")
    }

    /// A project: the lanes, the stalled line, and who coordinates it — with and without one.
    func testTheProjectCard() throws {
        let coordinator = """
        {"id":"\(sessionID)","title":"Codex 多账户","status":"AWAITING_INPUT","runState":"AWAITING_INPUT",
         "workspace":{"id":"w","name":"orbit"},"numTurns":240,
         "lastTurnAt":"2026-09-23T12:30:00.000Z","updatedAt":"2026-09-23T12:30:00.000Z",
         "projectId":"\(projectID)"}
        """
        let json = """
        {"kind":"project","id":"\(projectID)","state":"ok","project":{
          "title":"Codex 多账户：一台机器上登录多个 Codex","status":"OPEN","total":8,
          "buckets":{"running":0,"ready":1,"blocked":0,"awaitingVerification":0,"done":7,"failed":0,"cancelled":0},
          "coordinatorSessionId":"\(sessionID)","coordinator":\(coordinator)}}
        """
        let url = "https://orbitd.io/projects/\(projectID)"
        let content = OrbitLinkCardContent.preview(ref(.project, projectUUID, .pageURL(url)),
                                                   try preview(json), host: host, now: now)
        XCTAssertEqual(content.title, "Codex 多账户：一台机器上登录多个 Codex")
        XCTAssertEqual(content.meter, [.init(role: .done, fraction: 7.0 / 8.0),
                                       .init(role: .ready, fraction: 1.0 / 8.0)])
        XCTAssertEqual(content.lines[0].text, "Done 7 / 8 · Open 1")
        XCTAssertEqual(content.lines[1].text, "1 task is ready, but nothing is running.")
        XCTAssertEqual(content.lines[1].isWarning, true)
        XCTAssertEqual(content.lines[1].glyph, .warning)
        XCTAssertEqual(content.foot?.text, "Coordinator · Waiting for your reply")
        XCTAssertEqual(content.foot?.time, "30m ago")

        // Ready work with something already running is not a stall, and a project with no
        // coordinator session draws no foot at all.
        let busy = try preview("""
        {"kind":"project","id":"\(projectID)","state":"ok","project":{"title":"P","status":"OPEN","total":4,
          "buckets":{"running":2,"ready":2,"blocked":0,"awaitingVerification":0,"done":0,"failed":0,"cancelled":0},
          "coordinatorSessionId":null,"coordinator":null}}
        """)
        let busyContent = OrbitLinkCardContent.preview(ref(.project, projectUUID, .pageURL(url)),
                                                       busy, host: host, now: now)
        XCTAssertEqual(busyContent.lines.count, 1)
        XCTAssertEqual(busyContent.lines[0].text, "Done 0 / 4 · Open 4 · Running 2")
        XCTAssertNil(busyContent.foot)
        XCTAssertEqual(busyContent.meter, [.init(role: .ready, fraction: 0.5)])

        // One ready task is one task, in the web's own sentence.
        let one = try preview("""
        {"kind":"project","id":"\(projectID)","state":"ok","project":{"title":"P","status":"OPEN","total":3,
          "buckets":{"running":0,"ready":1,"blocked":1,"awaitingVerification":0,"done":1,"failed":0,"cancelled":0}}}
        """)
        let oneContent = OrbitLinkCardContent.preview(ref(.project, projectUUID, .pageURL(url)),
                                                      one, host: host, now: now)
        XCTAssertEqual(oneContent.lines[0].text, "Done 1 / 3 · Open 2")
        XCTAssertEqual(oneContent.lines[1].text, "1 task is ready, but nothing is running.")
    }

    /// A task list: the same meter and the same progress line, from the list's own tallies.
    func testTheListCard() throws {
        let json = """
        {"kind":"list","id":"\(listID)","state":"ok","list":{
          "title":"FineWeb Parquet 文件下载（手动启动）",
          "counts":{"total":27468,"open":27350,"inProgress":0,"done":117,"failed":1,"cancelled":0,
                    "running":0,"queued":0,"runnable":27350}}}
        """
        let url = "https://orbitd.io/lists/\(listID)"
        let content = OrbitLinkCardContent.preview(ref(.list, listUUID, .pageURL(url)),
                                                   try preview(json), host: host, now: now)
        XCTAssertEqual(content.title, "FineWeb Parquet 文件下载（手动启动）")
        XCTAssertEqual(content.lines[0].text, "Done 117 / 27,468 · Open 27,350 · Failed 1")
        XCTAssertNil(content.foot)
        XCTAssertEqual(content.meter.count, 2)
        XCTAssertEqual(content.meter[0].role, .done)
        XCTAssertEqual(content.meter[1].role, .failed)
        XCTAssertEqual(content.meter[1].fraction, 1.0 / 27468.0)
        // Nothing has failed: the count that is zero is not drawn.
        let clean = try preview("""
        {"kind":"list","id":"\(listID)","state":"ok","list":{"title":"L",
          "counts":{"total":3,"open":1,"inProgress":1,"done":2,"failed":0,"cancelled":0,"running":1,"queued":1}}}
        """)
        let cleanContent = OrbitLinkCardContent.preview(ref(.list, listUUID, .pageURL(url)),
                                                        clean, host: host, now: now)
        XCTAssertEqual(cleanContent.lines[0].text, "Done 2 / 3 · Open 2 · Running 1 · Queued 1")
    }

    /// A wiki entry: its kind beside the type, its trust as the badge, its one sentence, what it
    /// stands on and whether that still holds — and, once agents no longer get it, the line that says
    /// so. The ids are the shared fixture's (`orbit-wiki:` cases), the entry the push block names.
    func testTheWikiCard() throws {
        let wikiID = "34UDFnrgM4q5oGQloG3uq"
        let wikiUUID = "01a0d1f2-3a44-7c11-9b02-5f6e7d8c9a10"
        let reference = ref(.wiki, wikiUUID, .reference("orbit-wiki:\(wikiID)"))
        let json = """
        {"kind":"wiki","id":"\(wikiID)","state":"ok","wiki":{
          "spaceId":"34UAbCdEfGhIjKlMnOpQr","spaceSlug":"orbit","kind":"principle",
          "title":"A clock never starts agent work",
          "summary":"Work starts from a committed fact (evidence revised, a receipt), never from a timer.",
          "trust":"owner","status":"active","anchorState":"verified",
          "anchorCheckedRef":"4db4f9f0a1b2c3d4e5f60718293a4b5c6d7e8f90",
          "anchor":{"type":"symbol","path":"src/runner-go/mcp.go","symbol":"askBeforeCreate"}}}
        """
        let answer = try preview(json)
        XCTAssertEqual(answer.wiki?.spaceSlug, "orbit")
        let content = OrbitLinkCardContent.preview(reference, answer, host: host, now: now)
        XCTAssertEqual(content.state, .ready)
        XCTAssertEqual(content.typeName, "Wiki · Principle")
        XCTAssertEqual(content.wikiTrust, .owner)
        XCTAssertEqual(content.title, "A clock never starts agent work")
        XCTAssertEqual(content.lines.map(\.text), [
            "Work starts from a committed fact (evidence revised, a receipt), never from a timer.",
            "src/runner-go/mcp.go · askBeforeCreate",
        ])
        XCTAssertEqual(content.lines[1].anchorMark, WikiAnchorMark(word: "4db4f9f", tone: .green))
        XCTAssertFalse(content.lines[1].isWarning)
        // Its hint is the reference as written: the id alone names no page to imitate.
        XCTAssertEqual(content.path, "orbit-wiki:\(wikiID)")

        // Retired, anchored code gone, nothing on file: the card still reads, and says all three.
        let retired = try preview("""
        {"kind":"wiki","id":"\(wikiID)","state":"ok","wiki":{"spaceId":"s","spaceSlug":"orbit",
          "kind":"pitfall","title":"t","summary":"","trust":"confirmed","status":"retired",
          "anchorState":"missing","anchorCheckedRef":null,"anchor":null}}
        """)
        let retiredContent = OrbitLinkCardContent.preview(reference, retired, host: host, now: now)
        XCTAssertEqual(retiredContent.typeName, "Wiki · Pitfall")
        XCTAssertEqual(retiredContent.lines.map(\.text), ["No anchor", "no longer sent to agents"])
        XCTAssertEqual(retiredContent.lines[0].anchorMark, WikiAnchorMark(word: "Missing", tone: .red))
        XCTAssertTrue(retiredContent.lines[0].isWarning)
        XCTAssertEqual(retiredContent.lines[1].glyph, .warning)

        // Nothing has re-checked it yet: the anchor line says the anchor, and no mark either way.
        let unchecked = try preview("""
        {"kind":"wiki","id":"\(wikiID)","state":"ok","wiki":{"spaceSlug":"orbit","kind":"a-kind-from-later",
          "title":"t","summary":"s","trust":"a-trust-from-later","status":"active","anchorState":"unchecked",
          "anchor":{"type":"commit","sha":"1125c445a0000000000000000000000000000000"}}}
        """)
        let uncheckedContent = OrbitLinkCardContent.preview(reference, unchecked, host: host, now: now)
        XCTAssertEqual(uncheckedContent.lines.map(\.text), ["s", "1125c44"])
        XCTAssertNil(uncheckedContent.lines[1].anchorMark)
        XCTAssertEqual(unchecked.wiki?.kind, .unknown, "a kind this build has never heard of")
        XCTAssertEqual(uncheckedContent.typeName, "Wiki", "and the card says only what it knows")
        XCTAssertEqual(unchecked.wiki?.trust, .unknown)

        // Loading, and never coming: the reference is the hint, as it is while it reads.
        XCTAssertEqual(OrbitLinkCardContent.loading(reference, host: host).path, "orbit-wiki:\(wikiID)")
        let gone = try preview("""
        {"kind":"wiki","id":"\(wikiID)","state":"unavailable"}
        """)
        let goneContent = OrbitLinkCardContent.preview(reference, gone, host: host, now: now)
        XCTAssertEqual(goneContent.state, .unavailable)
        XCTAssertEqual(goneContent.typeName, "Wiki")
    }

    /// The two states a card can be in with nothing to show: still reading, and never coming.
    func testTheLoadingAndUnavailableCards() throws {
        let url = "https://orbitd.io/tasks/\(goneID)"
        let loading = OrbitLinkCardContent.loading(ref(.task, taskUUID, .pageURL(url)), host: host)
        XCTAssertEqual(loading.state, .loading)
        XCTAssertNil(loading.title)
        XCTAssertTrue(loading.lines.isEmpty)
        XCTAssertEqual(loading.path, "orbitd.io/tasks/\(goneID)")

        let unavailable = try preview("""
        {"kind":"task","id":"\(goneID)","state":"unavailable"}
        """)
        let content = OrbitLinkCardContent.preview(ref(.task, taskUUID, .pageURL(url)), unavailable,
                                                   host: host, now: now)
        XCTAssertEqual(content.state, .unavailable)
        XCTAssertEqual(content.title, "Not available")
        XCTAssertEqual(content.lines.map(\.text), ["Deleted, or not in this account."])
        XCTAssertEqual(content.path, "orbitd.io/tasks/\(goneID)")
        XCTAssertNil(content.pill)
        XCTAssertNil(content.sessionGlyph)

        // A reference knows its own spelling of the path even though it carries no URL.
        let reference = OrbitLinkCardContent.loading(
            ref(.list, listUUID, .reference("orbit-list:\(listID)")), host: host)
        XCTAssertEqual(reference.path, "orbitd.io/lists/\(listID)")
        XCTAssertEqual(OrbitLinkCardContent.loading(ref(.list, listUUID, .reference("orbit-list:\(listID)")),
                                                    host: "https://orbitd.io/").path,
                       "orbitd.io/lists/\(listID)")
        // An `ok` answer missing the object it promised draws the unavailable card rather than a
        // half-drawn one.
        let empty = try preview("""
        {"kind":"project","id":"\(projectID)","state":"ok"}
        """)
        XCTAssertEqual(OrbitLinkCardContent.preview(ref(.project, projectUUID, .pageURL(url)), empty,
                                                    host: host, now: now).state,
                       .unavailable)
    }

    // MARK: where a tap goes

    // `OrbitLinkDestination` — the four kinds, what a project with no coordinator does, and the task
    // start card's project name going through the same rule — is asserted in
    // `OrbitLinkDestinationTests`. It moved there because it is the one home for where a tap goes;
    // this file is about which links become cards and what those cards say.

    // MARK: the wire

    /// The four payloads, and the one answer that describes nothing.
    func testDecodingTheWire() throws {
        let session = try preview("""
        {"kind":"session","id":"\(sessionID)","state":"ok","session":{
          "id":"\(sessionID)","title":"执行任务：x","status":"AWAITING_INPUT","runState":"AWAITING_INPUT",
          "sessionState":"AWAITING_INPUT","lifecycleState":"OPEN","endReason":null,"error":null,
          "retryAt":null,"engineTurnActive":false,"pendingApprovals":0,"waitingKind":null,
          "runningBgCount":0,"runningBgJobCount":0,"watching":{"active":1,"paused":2,"targets":3},
          "workspace":{"id":"w","name":"orbit"},"model":"Opus 5.5","numTurns":240,
          "createdAt":"2026-09-22T10:00:00.000Z","lastTurnAt":"2026-09-23T12:30:00.000Z",
          "updatedAt":"2026-09-23T12:30:00.000Z","projectId":"\(projectID)","projectTitle":"p"}}
        """)
        XCTAssertEqual(session.state, .ok)
        XCTAssertEqual(session.kind, .session)
        XCTAssertEqual(session.id, sessionID)
        XCTAssertEqual(session.session?.title, "执行任务：x")
        XCTAssertEqual(session.session?.effectiveRunState, .awaitingInput)
        XCTAssertEqual(session.session?.numTurns, 240)
        XCTAssertEqual(session.session?.workspace?.name, "orbit")
        XCTAssertEqual(session.session?.projectId, projectID)
        XCTAssertEqual(session.session?.lastActivityAt, "2026-09-23T12:30:00.000Z")
        XCTAssertEqual(session.session?.watchingLabel, "Watching 3 targets")
        XCTAssertNil(session.task)
        XCTAssertNil(session.project)
        XCTAssertNil(session.list)

        let task = try preview("""
        {"kind":"task","id":"\(taskID)","state":"ok","task":{"title":"t","status":"IN_PROGRESS",
          "running":true,"queued":false,"assignee":{"id":"w","name":"orbit"},"runs":3,
          "lastRun":{"status":"RUNNING","runState":"RUNNING","numTurns":12,"endedAt":null},
          "project":{"id":"\(projectID)","title":"p"},"updatedAt":"2026-09-23T12:00:00.000Z"}}
        """)
        XCTAssertEqual(task.task?.lastRun?.effectiveRunState, .running)
        XCTAssertEqual(task.task?.lastRun?.numTurns, 12)
        XCTAssertNil(task.task?.lastRun?.endedAt)
        XCTAssertEqual(task.task?.lastActivityAt, "2026-09-23T12:00:00.000Z",
                       "a run that has not ended leaves the task's own clock to date the card")

        let project = try preview("""
        {"kind":"project","id":"\(projectID)","state":"ok","project":{"title":"p","status":"OPEN","total":8,
          "buckets":{"running":1,"ready":2,"blocked":3,"awaitingVerification":4,"done":5,"failed":6,"cancelled":7},
          "coordinatorSessionId":"\(sessionID)","coordinator":null}}
        """)
        XCTAssertEqual(project.project?.total, 8)
        XCTAssertEqual(project.project?.buckets?.ready, 2)
        XCTAssertEqual(project.project?.coordinatorSessionId, sessionID)
        XCTAssertNil(project.project?.coordinator)

        let list = try preview("""
        {"kind":"list","id":"\(listID)","state":"ok","list":{"title":"FineWeb","counts":{
          "total":27468,"open":27350,"inProgress":0,"done":117,"failed":1,"cancelled":0,
          "running":0,"queued":0,"runnable":27350}}}
        """)
        XCTAssertEqual(list.list?.counts?.total, 27468)
        XCTAssertEqual(list.list?.counts?.inProgress, 0)

        // The unavailable answer is a fact about the object, and the only one the server gives: the
        // same answer for another account's, a deleted one, and one that never existed.
        let unavailable = try preview("""
        {"kind":"task","id":"\(goneID)","state":"unavailable"}
        """)
        XCTAssertEqual(unavailable.state, .unavailable)
        XCTAssertEqual(unavailable.kind, .task)
        XCTAssertEqual(unavailable.id, goneID)
        XCTAssertNil(unavailable.task)

        // The retry rule a card inherits from the row: a failure the server is about to undo is
        // not a red one.
        let retrying = try preview("""
        {"kind":"session","id":"\(sessionID)","state":"ok","session":{"id":"\(sessionID)","title":"t",
          "status":"FAILED","runState":"FAILED","retryAt":"2026-09-23T12:59:40.000Z"}}
        """)
        XCTAssertEqual(retrying.session?.retryPending(now: now), true)
        XCTAssertEqual(OrbitLinkCardContent.preview(ref(.session, sessionUUID, .reference("orbit-session:\(sessionID)")),
                                                    retrying, host: host, now: now).sessionGlyph?.tone,
                       .neutral)
    }

    // MARK: the store

    func testTheStoreReadsOnceAndRemembers() async throws {
        let stub = StubPreviews()
        let store = OrbitLinkPreviewStore(client: stub)

        let refs = [ref(.task, taskUUID, .pageURL("https://orbitd.io/tasks/\(taskID)")),
                    ref(.task, taskID, .reference("orbit-task:\(taskID)")),
                    ref(.project, projectUUID, .pageURL("https://orbitd.io/projects/\(projectID)"))]
        let first = await store.previews(for: refs)
        let sent = await stub.requests
        XCTAssertEqual(sent.count, 1, "one request for the whole batch")
        XCTAssertEqual(sent[0].map(\.id), [taskUUID, projectUUID],
                       "the two spellings of one task are asked for once, in the canonical spelling")
        XCTAssertEqual(first.count, 2, "and they are one object")
        XCTAssertEqual(first[OrbitLinkTarget(kind: .task, id: taskID).key]?.kind, .task)
        XCTAssertEqual(first[OrbitLinkTarget(kind: .project, id: projectUUID).key]?.kind, .project)

        // The second read is answered from what the first one learned.
        let second = await store.previews(for: refs)
        let stillOnce = await stub.requests
        XCTAssertEqual(stillOnce.count, 1, "a known link costs no request")
        XCTAssertEqual(second.count, 2)
        let remembered = await store.cachedPreview(for: OrbitLinkTarget(kind: .task, id: taskUUID))
        XCTAssertEqual(remembered?.id, taskID)
    }

    func testTheStoreBatchesToTheEndpointLimit() async {
        let stub = StubPreviews()
        let store = OrbitLinkPreviewStore(client: stub, maxRefs: 2)
        let refs = (0..<5).map { index in
            ref(.task, "01a0cca7-8609-70ed-a0e2-d4b55b832b\(String(format: "%02d", index))",
                .reference("orbit-task:\(index)"))
        }
        _ = await store.previews(for: refs)
        let sent = await stub.requests
        // The batches are read concurrently, so which of them the stub records first is not a fact
        // about the rule — how many refs each one carried is.
        XCTAssertEqual(sent.map(\.count).sorted(), [1, 2, 2],
                       "at most maxRefs refs per request, and no request for nothing")
        XCTAssertEqual(sent.flatMap { $0 }.count, 5, "every link is asked for exactly once")
    }

    func testTheStoreHoldsOneFlightPerObject() async {
        let stub = StubPreviews()
        await stub.setDelay(0.2)
        let store = OrbitLinkPreviewStore(client: stub)
        let link = ref(.task, taskUUID, .pageURL("https://orbitd.io/tasks/\(taskID)"))

        async let one = store.previews(for: [link])
        async let two = store.previews(for: [link])
        let (a, b) = await (one, two)
        let sent = await stub.requests
        XCTAssertEqual(sent.count, 1, "two readers of one link share its flight")
        XCTAssertEqual(a.count, 1)
        XCTAssertEqual(b.count, 1)
    }

    func testTheStoreDoesNotRememberAFailure() async {
        let stub = StubPreviews()
        await stub.setFailing(true)
        let store = OrbitLinkPreviewStore(client: stub)
        let link = ref(.task, taskUUID, .pageURL("https://orbitd.io/tasks/\(taskID)"))
        let failed = await store.previews(for: [link])
        XCTAssertTrue(failed.isEmpty, "a read that threw answers nothing, so its card keeps loading")
        let nothing = await store.cachedPreview(for: OrbitLinkTarget(kind: .task, id: taskUUID))
        XCTAssertNil(nothing)

        await stub.setFailing(false)
        let retried = await store.previews(for: [link])
        let afterRetry = await stub.requests
        XCTAssertEqual(afterRetry.count, 2, "the next refresh asks again")
        XCTAssertEqual(retried.count, 1)

        // What the server answered `unavailable` IS remembered: that is a fact about the object.
        let gone = ref(.task, goneUUID, .pageURL("https://orbitd.io/tasks/\(goneID)"))
        _ = await store.previews(for: [gone])
        let requests = (await stub.requests).count
        _ = await store.previews(for: [gone])
        let afterUnavailable = await stub.requests
        XCTAssertEqual(afterUnavailable.count, requests, "an unavailable answer is an answer")
    }

    /// A screen that stays open passes an age, so a card is a reading of the object as it is now
    /// rather than as it was when the conversation was opened. Nothing polls: the ask that finds the
    /// answer stale is one the screen was making anyway.
    func testTheStoreRereadsWhatHasGoneStale() async {
        let stub = StubPreviews()
        let store = OrbitLinkPreviewStore(client: stub, maxAge: 60)
        let link = ref(.task, taskUUID, .pageURL("https://orbitd.io/tasks/\(taskID)"))

        let readAt = Date()
        let first = await store.previews(for: [link], now: readAt)
        XCTAssertEqual(first.count, 1)

        // Inside its age the answer is still the answer, and asking again costs no request.
        let fresh = readAt.addingTimeInterval(59)
        let cached = await store.cachedPreview(for: OrbitLinkTarget(kind: .task, id: taskUUID), now: fresh)
        XCTAssertNotNil(cached)
        _ = await store.previews(for: [link], now: fresh)
        let freshReads = await stub.requests
        XCTAssertEqual(freshReads.count, 1)

        // Past it the answer is no longer one, so the next ask reads again.
        let expired = readAt.addingTimeInterval(61)
        let stale = await store.cachedPreview(for: OrbitLinkTarget(kind: .task, id: taskUUID), now: expired)
        XCTAssertNil(stale)
        _ = await store.previews(for: [link], now: expired)
        let secondReads = await stub.requests
        XCTAssertEqual(secondReads.count, 2, "a card past its age is read again")
    }

    /// The gone task's canonical id, which the stub answers `unavailable`.
    private let goneUUID = "01a09055-6219-bbbd-7b47-7e4c9e956286"

    /// Records what was asked for, and answers as the control plane would: an object for the ids
    /// this file knows, `unavailable` for the one it does not, and a failure when the test asks for
    /// one. An actor rather than a lock, so nothing is read while it is being written.
    private actor StubPreviews: LinkPreviewClient {
        private(set) var requests: [[LinkPreviewRef]] = []
        private var failing = false
        private var delay: TimeInterval = 0

        func setFailing(_ value: Bool) { failing = value }
        func setDelay(_ value: TimeInterval) { delay = value }

        func fetchLinkPreviews(_ refs: [LinkPreviewRef]) async throws -> [LinkPreview] {
            requests.append(refs)
            let delay = self.delay
            if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            if failing { throw APIError.invalidResponse }
            return refs.map(answer(for:))
        }

        /// The answer spells the id the way the server does — as the public id — whatever spelling
        /// it was asked in. The store must key off the ref it sent, not off what came back: keying
        /// off the answer is how one object becomes two cache entries and a card misses.
        private func answer(for ref: LinkPreviewRef) -> LinkPreview {
            let spelled = PublicID.toPublic(ref.id)
            switch ref.id {
            case "01a09055-6219-bbbd-7b47-7e4c9e956286":
                return LinkPreview(kind: .task, id: spelled, state: .unavailable, session: nil, task: nil,
                                   project: nil, list: nil)
            case "01a0cca0-aeaa-7618-bd5a-caccc089108c":
                return LinkPreview(kind: .project, id: spelled, state: .ok, session: nil, task: nil,
                                   project: LinkPreviewProject(title: "p", status: "OPEN", total: 1,
                                                               buckets: nil, coordinatorSessionId: nil,
                                                               coordinator: nil),
                                   list: nil)
            default:
                return LinkPreview(kind: .task, id: spelled, state: .ok, session: nil,
                                   task: LinkPreviewTask(title: "t", status: "DONE", running: false,
                                                         queued: false, project: nil, assignee: nil,
                                                         runs: 0, lastRun: nil, updatedAt: nil),
                                   project: nil, list: nil)
            }
        }
    }
}
