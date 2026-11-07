import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

/// The wiki chat's client rules on iOS and macOS (docs/wiki-chat-design.md §3–§9, board 42 ⑤), as pure functions: the
/// web lib's own cases (`src/web/src/lib/wikiChat.test.ts`) — which chat the button opens, where a new one runs, the
/// composer's attachments frozen into the message's `wikiContext` — and the native ones: the quote the Ask sheet's
/// tapped sentences make, Updated beside a section, the card a drafting call's answer names, what a card draws, the
/// chat's part of W, and the routes the client calls.
final class WikiChatLogicTests: XCTestCase {

    // MARK: the round button

    /// Four looks read from the three counts, needs you before working before updated (design §3).
    func testTheButtonHasFourLooks() {
        XCTAssertEqual(WikiChatLogic.fab(WikiChatFabCounts()), .init(state: .idle, label: "Chat", count: 0))
        XCTAssertEqual(WikiChatLogic.fab(WikiChatFabCounts(working: true, updated: 2)), .init(state: .working, label: "Working…", count: 0))
        XCTAssertEqual(WikiChatLogic.fab(WikiChatFabCounts(needsYou: 1, working: true, updated: 2)),
                       .init(state: .needsYou, label: "1 needs you", count: 1))
        XCTAssertEqual(WikiChatLogic.fab(WikiChatFabCounts(needsYou: 3)), .init(state: .needsYou, label: "3 need you", count: 3))
        XCTAssertEqual(WikiChatLogic.fab(WikiChatFabCounts(updated: 1)), .init(state: .updated, label: "Wiki updated", count: 0))
        // At rest before the chats are read, and from a server that has none.
        XCTAssertEqual(WikiChatLogic.fab(nil).state, .idle)
        XCTAssertEqual(WikiChatLogic.fab(nil).label, "Chat")
    }

    /// On every page of a space but its Settings, and on none without a space.
    func testTheButtonIsOnEveryPageButSettings() {
        XCTAssertTrue(WikiChatLogic.fabShown(settingsOnTop: false, hasSpace: true))
        XCTAssertFalse(WikiChatLogic.fabShown(settingsOnTop: true, hasSpace: true))
        XCTAssertFalse(WikiChatLogic.fabShown(settingsOnTop: false, hasSpace: false))
    }

    /// The newest chat that needs the owner, else the newest open one, else a new chat.
    func testTheButtonOpensTheChatThatNeedsYou() {
        func row(_ id: String, open: Bool = true, needsYou: Int = 0) -> WikiChatRow {
            WikiChatRow(sessionId: id, title: id, status: "AWAITING_INPUT", open: open, needsYou: needsYou)
        }
        XCTAssertEqual(WikiChatLogic.toOpen([row("a"), row("b", needsYou: 2), row("c", needsYou: 1)]), "b")
        XCTAssertEqual(WikiChatLogic.toOpen([row("a", open: false), row("b"), row("c")]), "b")
        XCTAssertEqual(WikiChatLogic.toOpen([row("a", open: false)]), "new")
        XCTAssertEqual(WikiChatLogic.toOpen([]), "new")
        XCTAssertEqual(WikiChatLogic.toOpen(nil), "new")
    }

    // MARK: where a chat runs (design §5.1)

    private let develop = WikiChatWorkspace(id: "w1", name: "orbit-develop", runner: "HPC", online: true)
    private let mac = WikiChatWorkspace(id: "w2", name: "orbit-mac", runner: "austin", online: false)

    func testWhereAChatRuns() {
        // Chosen the first time, with nothing picked for the owner.
        XCTAssertEqual(WikiChatLogic.runsIn(WikiChatList(spaceId: "s", choices: [develop, mac]), picked: nil),
                       .choose(choices: [develop, mac], again: false))
        XCTAssertEqual(WikiChatLogic.runsIn(WikiChatList(spaceId: "s", choices: [develop, mac]), picked: "w2"),
                       .chosen(workspace: mac, remembered: false, choices: [develop, mac]))
        // Remembered after that, and an offline machine stays the chat's.
        let remembered = WikiChatWorkspace(id: "w2", name: "orbit-mac", runner: "austin", online: false, eligible: true)
        XCTAssertEqual(WikiChatLogic.runsIn(WikiChatList(spaceId: "s", workspace: remembered, choices: [develop, mac]), picked: nil),
                       .chosen(workspace: mac, remembered: true, choices: [develop, mac]))
        // Chosen again when the remembered one no longer qualifies.
        let gone = WikiChatWorkspace(id: "w2", name: "orbit-mac", runner: "austin", online: false, eligible: false)
        XCTAssertEqual(WikiChatLogic.runsIn(WikiChatList(spaceId: "s", workspace: gone, choices: [develop]), picked: nil),
                       .choose(choices: [develop], again: true))
        // Nothing to choose when no workspace runs in worktrees.
        XCTAssertEqual(WikiChatLogic.runsIn(WikiChatList(spaceId: "s"), picked: nil), .noWorktree)
        XCTAssertEqual(WikiChatLogic.runsIn(WikiChatList(spaceId: "s", workspace: gone), picked: nil), .noWorktree)
        XCTAssertEqual(WikiChatLogic.workspaceName(develop), "orbit-develop · HPC")
        XCTAssertEqual(WikiChatLogic.workspaceName(WikiChatWorkspace(id: "w3", name: "notes")), "notes")
    }

    // MARK: the attachments (design §4.2)

    private func page(_ section: String) -> WikiChatLogic.Page {
        .doc(docSlug: "session-runtime", sectionKey: section, label: "3.1 §\(section.dropFirst())")
    }

    private let quote = WikiChatLogic.Quote(docSlug: "session-runtime", sectionKey: "s3", sentenceIds: ["x1", "x2"],
                                            first: "Runner…", sources: 2, selected: 2)

    private func run(_ actions: WikiChatLogic.AttachAction...) -> WikiChatLogic.Attachments {
        actions.reduce(WikiChatLogic.Attachments(), WikiChatLogic.attach)
    }

    func testTheAttachmentsFollowTheReader() {
        let state = run(.follow(page("s1")), .follow(page("s3")))
        XCTAssertEqual(WikiChatLogic.shown(state).page, page("s3"))
        XCTAssertNil(WikiChatLogic.shown(state).quote)
        XCTAssertEqual(WikiChatLogic.context(state), WikiChatContext(page: .doc(docSlug: "session-runtime", sectionKey: "s3")))
    }

    func testAnAskAddsAQuoteANewerAskReplacingIt() {
        let older = WikiChatLogic.Quote(docSlug: "session-runtime", sectionKey: "s3", sentenceIds: ["old"], first: "x",
                                        sources: 0, selected: 1)
        let state = run(.follow(page("s3")), .quote(older), .quote(quote))
        XCTAssertEqual(WikiChatLogic.context(state), WikiChatContext(
            page: .doc(docSlug: "session-runtime", sectionKey: "s3"),
            selection: .init(docSlug: "session-runtime", sectionKey: "s3", sentenceIds: ["x1", "x2"])))
    }

    func testWhatIsNotShownIsNotSent() {
        let crossedPage = run(.follow(page("s3")), .quote(quote), .crossPage)
        XCTAssertNil(WikiChatLogic.shown(crossedPage).page)
        XCTAssertEqual(WikiChatLogic.context(crossedPage),
                       WikiChatContext(selection: .init(docSlug: "session-runtime", sectionKey: "s3", sentenceIds: ["x1", "x2"])))
        // A crossed-out page stays out while the reader moves on, until the message goes.
        XCTAssertNil(WikiChatLogic.shown(WikiChatLogic.attach(crossedPage, .follow(page("s1")))).page)
        let both = WikiChatLogic.attach(crossedPage, .crossQuote)
        XCTAssertNil(WikiChatLogic.shown(both).page)
        XCTAssertNil(WikiChatLogic.shown(both).quote)
        XCTAssertNil(WikiChatLogic.context(both))
    }

    func testTheAttachmentsAreFrozenWhenTheMessageGoes() {
        let before = run(.follow(page("s3")), .quote(quote), .crossPage)
        let sent = WikiChatLogic.context(before)
        let after = run(.follow(page("s3")), .quote(quote), .crossPage, .sent, .follow(page("s1")))
        XCTAssertEqual(sent, WikiChatContext(selection: .init(docSlug: "session-runtime", sectionKey: "s3", sentenceIds: ["x1", "x2"])))
        XCTAssertEqual(WikiChatLogic.shown(after).page, page("s1"))
        XCTAssertNil(WikiChatLogic.shown(after).quote)
    }

    func testAnEntryOrAPlanIsNamedByItsOwnShape() throws {
        let entry = run(.follow(.entry(entryId: "E1", label: "Wakeups are held by the server")))
        XCTAssertEqual(WikiChatLogic.context(entry), WikiChatContext(page: .entry(entryId: "E1")))
        let plan = run(.follow(.plan(docSlug: "session-runtime", label: "3.1")))
        XCTAssertEqual(WikiChatLogic.context(plan), WikiChatContext(page: .plan(docSlug: "session-runtime")))
        // A plan page at one of its document's sections names that section too (C12).
        let section = run(.follow(.plan(docSlug: "session-runtime", label: "3.1 §2", sectionKey: "recovery")))
        XCTAssertEqual(WikiChatLogic.context(section), WikiChatContext(page: .plan(docSlug: "session-runtime", sectionKey: "recovery")))
        XCTAssertEqual(WikiChatLogic.shown(section).page?.label, "3.1 §2")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        XCTAssertEqual(String(decoding: try encoder.encode(WikiChatContext(page: .plan(docSlug: "d", sectionKey: "s2"))), as: UTF8.self),
                       #"{"page":{"docSlug":"d","kind":"plan","sectionKey":"s2"}}"#)
        let read = try JSONDecoder().decode(WikiChatContext.self, from: Data(#"{"page":{"kind":"plan","docSlug":"d","sectionKey":"s2"}}"#.utf8))
        XCTAssertEqual(read, WikiChatContext(page: .plan(docSlug: "d", sectionKey: "s2")))
    }

    /// A plan page attaches its document, and at one of its sections that section, by its key in the plan in force
    /// (C12): the web's `useWikiChatPage`, on a phone and a Mac. A section the plan does not hold attaches the document.
    func testAPlanPageAttachesTheSectionItShows() throws {
        let plan = try JSONDecoder().decode(WikiPlanState.self, from: Data(#"""
        {"confirmed": {"id": "pv4", "version": 4, "status": "confirmed", "docs": [
          {"id": "d1", "category": "runtime", "slug": "sessions-runtime", "title": "Sessions runtime", "sections": [
            {"id": "x1", "key": "turn-delivery", "title": "Turn delivery", "kind": "flow"},
            {"id": "x2", "key": "recovery", "title": "Recovery", "kind": "concepts"}]}]}}
        """#.utf8))
        XCTAssertEqual(WikiChatLogic.planPage(slug: "sessions-runtime", index: 1, number: "3.1", plan: plan),
                       .plan(docSlug: "sessions-runtime", label: "3.1 §2", sectionKey: "recovery"))
        XCTAssertEqual(WikiChatLogic.planPage(slug: "sessions-runtime", index: nil, number: "3.1", plan: plan),
                       .plan(docSlug: "sessions-runtime", label: "3.1"))
        XCTAssertEqual(WikiChatLogic.planPage(slug: "sessions-runtime", index: 7, number: nil, plan: plan),
                       .plan(docSlug: "sessions-runtime", label: "sessions-runtime"))
        XCTAssertEqual(WikiChatLogic.planPage(slug: "sessions-runtime", index: 1, number: "3.1", plan: nil),
                       .plan(docSlug: "sessions-runtime", label: "3.1"), "the plan not read yet: the document alone")
    }

    /// A press the plan's gate refused says its reason and, a line each, every error the gate found (C12).
    func testARefusedPressSaysItsReasonThenEveryErrorOfTheGate() {
        let body = #"{"code":"WIKI_PLAN_GATE","message":"The plan change did not pass the plan's gate (schema): 1 error.","errors":[{"check":"schema","path":"change.doc.sections[1].kind","message":"\"essay\" is not a section kind"}]}"#
        XCTAssertEqual(WikiChatLogic.pressRefusal(APIError.http(status: 422, body: body)),
                       "The card couldn’t be pressed: The plan change did not pass the plan's gate (schema): 1 error.\nchange.doc.sections[1].kind: \"essay\" is not a section kind")
        XCTAssertEqual(WikiChatLogic.pressRefusal(APIError.http(status: 409, body: #"{"message":"It changed since this draft."}"#)),
                       "The card couldn’t be pressed: It changed since this draft.")
    }

    /// The context goes out in the contract's keys and no others (`wikiChatContextErrors` refuses any other), and
    /// reads back as what it was.
    func testTheContextIsEncodedInTheContractsKeys() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let doc = WikiChatContext(page: .doc(docSlug: "sessions-runtime", sectionKey: "turn-delivery"),
                                  selection: .init(docSlug: "sessions-runtime", sectionKey: "turn-delivery", sentenceIds: ["A"]))
        XCTAssertEqual(String(decoding: try encoder.encode(doc), as: UTF8.self),
                       #"{"page":{"docSlug":"sessions-runtime","kind":"doc","sectionKey":"turn-delivery"},"selection":{"docSlug":"sessions-runtime","sectionKey":"turn-delivery","sentenceIds":["A"]}}"#)
        XCTAssertEqual(String(decoding: try encoder.encode(WikiChatContext(page: .entry(entryId: "E1"))), as: UTF8.self),
                       #"{"page":{"entryId":"E1","kind":"entry"}}"#)
        XCTAssertEqual(String(decoding: try encoder.encode(WikiChatContext(page: .plan(docSlug: "d"))), as: UTF8.self),
                       #"{"page":{"docSlug":"d","kind":"plan"}}"#)
        XCTAssertEqual(try JSONDecoder().decode(WikiChatContext.self, from: encoder.encode(doc)), doc)
        // A chat's next message (contract `chat.turns`): the owner's words as typed, queued behind a running turn
        // rather than written into it, and the context beside the words — on the turn door and on the resume
        // door alike, since a chat's next message may revive it.
        let turn = ComposerLogic.makeTurn(clientTurnId: "u-1", text: "这句少了原因", shell: false, attachmentIds: [],
                                          queueForNextTurn: true, wikiContext: WikiChatContext(page: .plan(docSlug: "d")))
        XCTAssertEqual(String(decoding: try encoder.encode(turn), as: UTF8.self),
                       #"{"clientTurnId":"u-1","content":"这句少了原因","intent":"NEXT_TURN","kind":"message","wikiContext":{"page":{"docSlug":"d","kind":"plan"}}}"#)
        let resume = ResumeRequest(clientTurnId: "u-2", content: "再短点", wikiContext: WikiChatContext(page: .plan(docSlug: "d")))
        XCTAssertEqual(String(decoding: try encoder.encode(resume), as: UTF8.self),
                       #"{"clientTurnId":"u-2","content":"再短点","wikiContext":{"page":{"docSlug":"d","kind":"plan"}}}"#)
        // Any other message leaves the field out: a session that is not a chat refuses one.
        let bare = ComposerLogic.makeTurn(clientTurnId: "u-3", text: "hi", shell: false, attachmentIds: [])
        XCTAssertEqual(String(decoding: try encoder.encode(bare), as: UTF8.self),
                       #"{"clientTurnId":"u-3","content":"hi","kind":"message"}"#)
        XCTAssertEqual(String(decoding: try encoder.encode(ResumeRequest(clientTurnId: "u-4", content: "go")), as: UTF8.self),
                       #"{"clientTurnId":"u-4","content":"go"}"#)
    }

    // MARK: Ask on a phone (docs/wiki-comment-to-session-design.md §5)

    private let paragraph = [
        WikiChatLogic.AskSentence(id: "a1", section: "s1", text: "心跳机制用于控制面探测失联的 runner。", notes: []),
        WikiChatLogic.AskSentence(id: "a2", section: "s1", text: "Runner 每 30 秒发送一次心跳。", notes: [5, 12]),
        WikiChatLogic.AskSentence(id: "a3", section: "s1", text: "该机制确保控制面能及时感知 runner 状态变化。", notes: [12, 7]),
    ]

    /// The sentences tapped make the quote, in reading order whatever order they were tapped in, with their sources.
    func testTheTappedSentencesMakeTheQuote() throws {
        let one = try XCTUnwrap(WikiChatLogic.quote(docSlug: "sessions-runtime", order: paragraph, picked: ["a2"]))
        XCTAssertEqual(one, WikiChatLogic.Quote(docSlug: "sessions-runtime", sectionKey: "s1", sentenceIds: ["a2"],
                                                first: "Runner 每 30 秒发送一次心跳。", sources: 2, selected: 1))
        let two = try XCTUnwrap(WikiChatLogic.quote(docSlug: "sessions-runtime", order: paragraph, picked: ["a3", "a1"]))
        XCTAssertEqual(two.sentenceIds, ["a1", "a3"], "a tap picks that sentence and no other between")
        XCTAssertEqual(two.first, "心跳机制用于控制面探测失联的 runner。")
        XCTAssertEqual(two.sources, 2)
        XCTAssertEqual(WikiChatLogic.quoteCounts(sentences: two.sentenceIds.count, sources: two.sources), "2 sentences · 2 sources")
        // None picked, or only a sentence without an id (a server older than the chat): nothing to attach.
        XCTAssertNil(WikiChatLogic.quote(docSlug: "d", order: paragraph, picked: []))
        XCTAssertNil(WikiChatLogic.quote(docSlug: "d", order: [WikiChatLogic.AskSentence(id: "", section: "s", text: "t")], picked: [""]))
    }

    /// At most 20, the first ones, saying how many there were.
    func testTheQuoteIsCappedAtTwenty() throws {
        let long = (1...24).map { WikiChatLogic.AskSentence(id: "b\($0)", section: "s2", text: "Sentence \($0).", notes: [$0]) }
        let quote = try XCTUnwrap(WikiChatLogic.quote(docSlug: "d", order: long, picked: Set(long.map(\.id))))
        XCTAssertEqual(quote.sentenceIds, (1...20).map { "b\($0)" })
        XCTAssertEqual(quote.selected, 24)
        XCTAssertEqual(quote.sources, 20)
        XCTAssertEqual(WikiChatCopy.capped(quote.selected), "The first 20 of 24 sentences")
    }

    // MARK: Updated beside a section

    /// The page chip's section is the lowest heading above the reading line: just above a phone's half sheet, which
    /// covers the lower half (board 42 ⑤); a third of the way down a page shown whole, so a short section at the top of
    /// an iPad's or a Mac's page is the one named, not the next heading down.
    func testTheReadingLineSitsAboveAPhonesSheetAndHighOnAPageShownWhole() {
        XCTAssertEqual(WikiChatLogic.readingLine(underSheet: true), 0.45)
        XCTAssertEqual(WikiChatLogic.readingLine(underSheet: false), 0.3)
        // A Mac's page 625 high from 83: section 3 opened at the top, section 4's heading 210 under it.
        let line = 83 + 625 * WikiChatLogic.readingLine(underSheet: false)
        let tops: [String: Double] = ["s3": 90, "s4": 300]
        XCTAssertEqual(tops.filter { $0.value <= line }.max { $0.value < $1.value }?.key, "s3")
    }

    func testASectionIsUpdatedWhenWrittenSinceTheReaderLooked() throws {
        let decoder = JSONDecoder()
        let change = try decoder.decode(WikiDocSectionChange.self, from: Data(
            #"{"versionId":"V1","reason":{"kind":"chat","title":"Runner 离线判定的原因"},"at":"2026-11-06T08:00:00.000Z","changed":1}"#.utf8))
        let at = try XCTUnwrap(RelativeTime.parse("2026-11-06T08:00:00.000Z")).timeIntervalSince1970
        XCTAssertTrue(WikiChatLogic.sectionUpdated(change, seen: at - 60), "written after the reader last looked")
        XCTAssertFalse(WikiChatLogic.sectionUpdated(change, seen: at + 60), "written before")
        XCTAssertFalse(WikiChatLogic.sectionUpdated(nil, seen: at - 60), "never written again")
        XCTAssertFalse(WikiChatLogic.sectionUpdated(change, seen: 0), "no look to compare with")
        XCTAssertEqual(WikiChatLogic.seenKey(space: "orbit", doc: "sessions-runtime"), "orbit.wiki.seen.orbit.doc.sessions-runtime")
        XCTAssertEqual(WikiChatCopy.sectionUpdated, "Updated")
    }

    // MARK: the card a drafting call names (contract `chat.drafts.toolResult`)

    func testTheCardIsReadOffTheDraftingCallsAnswer() {
        let answer = #"{"status":"draft","draftId":"34dRaFt0000000000001","replayed":false,"ops":[],"similar":[],"rewrites":[]}"#
        XCTAssertEqual(WikiChatLogic.draftID(toolName: "mcp__orbit__wiki_propose", result: answer), "34dRaFt0000000000001")
        XCTAssertEqual(WikiChatLogic.draftID(toolName: "mcp__orbit__wiki_draft", result: answer), "34dRaFt0000000000001")
        XCTAssertNil(WikiChatLogic.draftID(toolName: "orbit.wiki_draft", result: answer), "an Orbit tool is named mcp__<server>__<tool>")
        // An MCP answer as its content blocks.
        let blocks = #"[{"type":"text","text":"{\"status\":\"draft\",\"draftId\":\"D2\"}"}]"#
        XCTAssertEqual(WikiChatLogic.draftID(toolName: "mcp__orbit__wiki_propose", result: blocks), "D2")
        // A dry run makes nothing, a refusal is not a draft, another tool is not a card, and words read only as the
        // runner's own sentence with a whole id in it.
        XCTAssertNil(WikiChatLogic.draftID(toolName: "mcp__orbit__wiki_propose", result: #"{"status":"draft","draftId":null,"dryRun":true}"#))
        XCTAssertNil(WikiChatLogic.draftID(toolName: "mcp__orbit__wiki_propose", result: #"{"status":"refused","reasons":[]}"#))
        XCTAssertNil(WikiChatLogic.draftID(toolName: "mcp__orbit__wiki_get", result: answer))
        XCTAssertNil(WikiChatLogic.draftID(toolName: "mcp__orbit__wiki_propose", result: "Drafted card D3 for you"))
        XCTAssertNil(WikiChatLogic.draftID(toolName: "mcp__orbit__wiki_propose", result: nil))
        XCTAssertTrue(WikiChatLogic.isDraftingCall("mcp__orbit__wiki_propose"))
        XCTAssertFalse(WikiChatLogic.isDraftingCall("Bash"))
    }

    // MARK: what a card draws (board 42 ② ⑤)

    private let addDecision = #"""
    {"id":"D1","sessionId":"S1","kind":"entry","state":"draft","label":"Add decision",
     "rationale":"代码里确实是丢三次，但「为什么」库里没有，是少一条决定。",
     "ops":[{"seq":0,"op":"add","entryId":null,"baseRevision":null,
             "payload":{"op":"add","entry":{"kind":"decision","title":"Runner 离线判定留三次心跳的余量",
                        "fields":{"decision":"连续丢三次心跳才判离线。","context":"要扛住一次网关重启。"}},
                        "sources":[{"kind":"turn","session":"self","quote":"留三次心跳的余量"},
                                   {"kind":"commit","ref":"99cd3c4e1f","locator":{"path":"src/apiserver/src/runner-presence.ts"}}]},
             "similar":[],"tainted":false,"entry":null,"decision":null}],
     "sections":[],"rewrites":[{"doc":"sessions-runtime","key":"turn-delivery","where":"3.1 §3","title":"turn 投递与 inbox 领取"},
                              {"doc":"wiki-runtime","key":"presence","where":"7.1 §2","title":null}],
     "similar":[],"tainted":false,"replaces":null,"replacedBy":null,"decision":null,"decidedAt":null,"undoneAt":null,
     "undoable":false,"changesetId":null,"rewrite":null,"createdAt":"2026-11-06T08:00:00.000Z"}
    """#

    func testACardReadDrawsWhatTheBoardShows() throws {
        let card = try JSONDecoder().decode(WikiChatDraftView.self, from: Data(addDecision.utf8))
        let look = WikiChatLogic.cardLook(card)
        XCTAssertEqual(look.title, "Draft · Add decision")
        XCTAssertEqual(look.actions, [.apply, .edit, .discard])
        XCTAssertEqual(look.tone, .accent)
        let face = WikiChatLogic.cardFace(card)
        XCTAssertEqual(face.heading, "Runner 离线判定留三次心跳的余量")
        // The kind's first field, then the agent's why (the web's `wikiChatCardFace`).
        XCTAssertEqual(face.rows.map(\.label), ["Decision", "Why"])
        XCTAssertEqual(face.rows.first?.value, "连续丢三次心跳才判离线。")
        XCTAssertEqual(face.sources, ["Your message in this chat", "src/apiserver/src/runner-presence.ts · 99cd3c4e1f"])
        XCTAssertEqual(card.rewrites.map(\.place), ["3.1 §3", "7.1 §2"])
        XCTAssertEqual(WikiChatLogic.tone(.applied), .green)
        XCTAssertEqual(WikiChatLogic.tone(.changed), .amber)
        XCTAssertEqual(WikiChatLogic.tone(.replaced), .grey)
    }

    /// An applied card with its rewrite: the line under it, the floating line once the chat is folded, See changes.
    func testAnAppliedCardsRewriteReadsAsTheBoard() throws {
        let json = #"""
        {"id":"D1","sessionId":"S1","kind":"entry","state":"applied","label":"Add decision","ops":[],"rewrites":[],
         "decision":"applied","undoable":true,
         "rewrite":{"jobId":"J1","result":"updated","reason":null,"sha":"7f3e2a1c9b8d","seen":false,"settledAt":"2026-11-06T08:03:00.000Z",
                    "sections":[{"doc":"sessions-runtime","key":"turn-delivery","where":"3.1 §3","result":"updated","changed":1,"versionId":"V1"},
                                {"doc":"wiki-runtime","key":"presence","where":"7.1 §2","result":"same","changed":0,"versionId":null}]}}
        """#
        let card = try JSONDecoder().decode(WikiChatDraftView.self, from: Data(json.utf8))
        let rewrite = try XCTUnwrap(card.rewrite)
        XCTAssertEqual(WikiChatLogic.resultLine(rewrite.card), "Wiki updated · 3.1 §3 — 1 sentence · 7.1 §2 — reads the same")
        XCTAssertEqual(WikiChatLogic.updatedPill(rewrite.card), "Wiki updated · 3.1 §3")
        XCTAssertEqual(WikiChatLogic.cardActions(card.card), [.undo, .openEntry, .seeChanges])
        XCTAssertEqual(WikiChatLogic.fabCounts([WikiChatFabChat(open: true, cards: [card.card])]), WikiChatFabCounts(updated: 1))
        XCTAssertNil(WikiChatLogic.updatedPill(WikiChatCardRewrite(result: .rewriting, sections: [.init(place: "3.1 §3")])))
    }

    /// See changes reads a section's versions: newest first, each its rows against the text that replaced it.
    func testSeeChangesReadsTheVersions() throws {
        let json = #"""
        {"spaceId":"S","slug":"sessions-runtime","key":"turn-delivery","versions":[
          {"id":"V1","reason":{"kind":"chat","title":"Runner 离线判定的原因"},"at":"2026-11-06T08:03:00.000Z",
           "replacedBy":{"kind":"job","jobId":"J1"},"changed":1,
           "rows":[{"op":"same","text":"Runner 每 30 秒发送一次心跳。"},{"op":"added","text":"留三次余量是为了扛住一次网关重启。"}]}]}
        """#
        let read = try JSONDecoder().decode(WikiDocSectionVersions.self, from: Data(json.utf8))
        let version = try XCTUnwrap(read.versions.first)
        XCTAssertEqual(version.rows.map(\.op), [.same, .added])
        XCTAssertEqual(WikiChatLogic.versionHeading(try XCTUnwrap(version.reason)), "After chat Runner 离线判定的原因")
        XCTAssertEqual(WikiChatLogic.changed(version.changed), "1 sentence changed")
    }

    // MARK: what waits on the owner

    /// The chat's part of W is counted on iOS (contract `space.list.chatWaiting`): the drawer, the sidebar and the
    /// Activity badge add it; a server older than it adds nothing.
    func testTheChatsPartIsInW() throws {
        let spaces = [WikiSpace(id: "a", slug: "a", pendingOps: 1, planWaiting: 2, chatWaiting: 2),
                      WikiSpace(id: "b", slug: "b", pendingOps: 3)]
        XCTAssertEqual(WikiSpaceLogic.waitingIn(spaces[0]), 5)
        XCTAssertEqual(WikiSpaceLogic.waiting(spaces), 8)
        XCTAssertEqual(WikiSpaceLogic.chatWaiting(spaces), 2)
        XCTAssertEqual(WikiChatLogic.waitingBanner(WikiSpaceLogic.chatWaiting(spaces)), "2 rewrites need you")
        let read = try JSONDecoder().decode(WikiSpace.self, from: Data(#"{"id":"s","slug":"orbit","pendingOps":0,"planWaiting":0,"chatWaiting":1}"#.utf8))
        XCTAssertEqual(read.chatWaiting, 1)
        XCTAssertEqual(WikiSpaceLogic.waitingIn(read), 1)
    }

    // MARK: the attachment line under a message

    func testTheChatsNotesAreNamedOnTheAttachedLine() {
        let note = "<orbit_wiki_page of=\"doc\" doc=\"3.1\" slug=\"sessions-runtime\" section=\"3\" key=\"turn-delivery\" repoSha=\"7f3e2a1\">\n"
            + "## 3 turn 投递\n</orbit_wiki_page>\n\n"
            + "<orbit_wiki_selection doc=\"3.1\" slug=\"sessions-runtime\" section=\"3\" key=\"turn-delivery\" sentences=\"1\" sources=\"2\" repoSha=\"7f3e2a1\">\n"
            + "Runner 每 30 秒发送一次心跳。\n</orbit_wiki_selection>"
        XCTAssertEqual(describeNote(note), "Wiki page · 3.1 §3, Wiki selection · 3.1 §3 · 1 sentence · 2 sources")
        // A title holding a quote stays one value.
        let entry = "<orbit_wiki_page of=\"entry\" entry=\"E1\" title=\"The &quot;three&quot; heartbeats &amp; why\">\nx\n</orbit_wiki_page>"
        XCTAssertEqual(describeNote(entry), "Wiki entry · The \"three\" heartbeats & why")
        // One whose tag lacks what its line needs is named as any block this does not know.
        XCTAssertEqual(describeNote("<orbit_wiki_selection doc=\"3.1\">\nx\n</orbit_wiki_selection>"), "context")
        XCTAssertNil(WikiChatLogic.parseNoteTag("<orbit_wiki_context entries=\"3\">\nx\n</orbit_wiki_context>"))
    }

    // MARK: the routes

    func testEveryCallHitsTheChatsRoute() async throws {
        let log = ChatRequestLog()
        ChatURLProtocol.handler = { request in
            log.record(request)
            let card = #"{"id":"D1","sessionId":"S1","kind":"entry","state":"applied","label":"Add decision","undoable":true}"#
            switch (request.httpMethod ?? "", request.url?.path ?? "") {
            case ("GET", "/api/wiki/spaces/SP/chats"):
                return (200, #"{"spaceId":"SP","workspace":null,"choices":[{"id":"W1","name":"orbit-develop","runner":"HPC","online":true}],"fab":{"needsYou":1,"working":false,"updated":0},"chats":[{"sessionId":"S1","title":"Runner 离线判定的原因","status":"AWAITING_INPUT","open":true,"createdAt":"","updatedAt":"","drafts":1,"needsYou":1}]}"#)
            case ("POST", "/api/wiki/spaces/SP/chats"):
                return (201, #"{"sessionId":"S2","chat":{"sessionId":"S2","title":"","status":"PENDING","open":true,"createdAt":"","updatedAt":"","drafts":0,"needsYou":0}}"#)
            case ("GET", "/api/wiki/chats/S1/drafts"):
                return (200, #"{"sessionId":"S1","drafts":[\#(card)]}"#)
            case ("GET", "/api/wiki/chat-drafts/D1"):
                return (200, card)
            case ("POST", let path) where path.hasPrefix("/api/wiki/chat-drafts/D1/"):
                return (200, #"{"replayed":false,"draft":\#(card)}"#)
            case ("GET", "/api/wiki/spaces/SP/docs/sessions-runtime/sections/turn-delivery/versions"):
                return (200, #"{"spaceId":"SP","slug":"sessions-runtime","key":"turn-delivery","versions":[]}"#)
            default:
                return (404, "")
            }
        }
        defer { ChatURLProtocol.handler = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ChatURLProtocol.self]
        let api = APIClient(baseURL: URL(string: "https://orbit.test")!, tokenStore: InMemoryTokenStore(),
                            session: URLSession(configuration: configuration))

        let list = try await api.wikiChats(spaceID: "SP")
        XCTAssertEqual(list.fab, WikiChatFabCounts(needsYou: 1))
        XCTAssertEqual(list.chats.first?.title, "Runner 离线判定的原因")
        XCTAssertEqual(WikiChatLogic.toOpen(list.chats), "S1")
        let created = try await api.createWikiChat(spaceID: "SP", WikiChatCreateRequest(
            workspaceId: "W1", content: "这句少了原因", clientTurnId: "u-1",
            wikiContext: WikiChatContext(page: .doc(docSlug: "sessions-runtime", sectionKey: "turn-delivery"))))
        XCTAssertEqual(created.sessionId, "S2")
        let drafts = try await api.wikiChatDrafts(sessionID: "S1")
        XCTAssertEqual(drafts.drafts.map(\.id), ["D1"])
        _ = try await api.wikiChatDraft("D1")
        for press in [WikiChatPress.apply, .discard, .undo, .retry, .seen] {
            let answer = try await api.pressWikiChatDraft("D1", press)
            XCTAssertEqual(answer.draft.state, .applied)
        }
        _ = try await api.editWikiChatDraft("D1", WikiChatEditRequest(ops: [.init(seq: 0, changes: WikiEntryChanges(title: "t"))]))
        _ = try await api.wikiDocSectionVersions(spaceID: "SP", slug: "sessions-runtime", key: "turn-delivery")

        XCTAssertEqual(log.lines, [
            "GET /api/wiki/spaces/SP/chats",
            "POST /api/wiki/spaces/SP/chats",
            "GET /api/wiki/chats/S1/drafts",
            "GET /api/wiki/chat-drafts/D1",
            "POST /api/wiki/chat-drafts/D1/apply",
            "POST /api/wiki/chat-drafts/D1/discard",
            "POST /api/wiki/chat-drafts/D1/undo",
            "POST /api/wiki/chat-drafts/D1/retry",
            "POST /api/wiki/chat-drafts/D1/seen",
            "POST /api/wiki/chat-drafts/D1/edit",
            "GET /api/wiki/spaces/SP/docs/sessions-runtime/sections/turn-delivery/versions",
        ])
        // The create carries the owner's words as typed, the UUID, the workspace and the page — nothing else.
        let create = try XCTUnwrap(log.bodies["POST /api/wiki/spaces/SP/chats"])
        XCTAssertEqual(create["content"], .string("这句少了原因"))
        XCTAssertEqual(create["clientTurnId"], .string("u-1"))
        XCTAssertEqual(create["workspaceId"], .string("W1"))
        XCTAssertEqual(create["wikiContext"]?["page"]?["kind"], .string("doc"))
        XCTAssertNil(create["model"])
        XCTAssertNil(create["permissionMode"])
        let edit = try XCTUnwrap(log.bodies["POST /api/wiki/chat-drafts/D1/edit"])
        guard case .array(let ops)? = edit["ops"], let op = ops.first else { return XCTFail("the edit sent no ops: \(edit)") }
        XCTAssertEqual(op["seq"], .int(0))
        XCTAssertEqual(op["changes"]?["title"], .string("t"))
    }
}

// MARK: - the stub transport

private final class ChatURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) -> (status: Int, body: String))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let result = Self.handler?(request) ?? (status: 500, body: "")
        let response = HTTPURLResponse(url: request.url!, statusCode: result.status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(result.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class ChatRequestLog: @unchecked Sendable {
    private let lock = NSLock()
    private var all: [String] = []
    private var byLine: [String: JSONValue] = [:]

    func record(_ request: URLRequest) {
        guard let url = request.url else { return }
        let line = "\(request.httpMethod ?? "?") \(url.path)"
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                data.append(buffer, count: n)
            }
            stream.close()
            body = data
        }
        lock.lock()
        all.append(line)
        if let body, !body.isEmpty, let value = try? JSONDecoder().decode(JSONValue.self, from: body) { byLine[line] = value }
        lock.unlock()
    }

    var lines: [String] {
        lock.lock()
        defer { lock.unlock() }
        return all
    }

    var bodies: [String: JSONValue] {
        lock.lock()
        defer { lock.unlock() }
        return byLine
    }
}
