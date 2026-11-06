import Foundation
import XCTest
@testable import OrbitKit

/// The iPhone's and the Mac's half of a chat's cards, case for case the web's (`src/web/src/lib/wikiChatCards.test.ts`,
/// C9; docs/wiki-chat-design.md §7–§8, contract `chat.drafts`, board 42 ② ③ ④): the card a drafting call names, read
/// from its answer whichever engine recorded it; how each state looks and what it offers; what is on its face; the
/// line under an applied card for every result; what a press that did not go says; Edit's body; and See changes.
final class WikiChatCardLookTests: XCTestCase {

    // MARK: a card, as the owner's door serves it

    private static let base: [String: Any] = [
        "id": "D1", "sessionId": "S1chat", "kind": "entry", "state": "draft", "label": "Add decision",
        "rationale": "To ride out one gateway restart.", "ops": [], "sections": [], "rewrites": [], "similar": [],
        "tainted": false, "replaces": NSNull(), "replacedBy": NSNull(), "decision": NSNull(), "decidedAt": NSNull(),
        "undoneAt": NSNull(), "undoable": false, "changesetId": NSNull(), "rewrite": NSNull(),
        "createdAt": "2026-11-06T10:00:00.000Z",
    ]

    private func card(_ over: [String: Any]) throws -> WikiChatDraftView {
        let merged = Self.base.merging(over) { _, new in new }
        return try JSONDecoder().decode(WikiChatDraftView.self, from: JSONSerialization.data(withJSONObject: merged))
    }

    private func op(_ op: String, entryId: Any = NSNull(), payload: [String: Any] = [:], entry: Any = NSNull(),
                    decision: Any = NSNull()) -> [String: Any] {
        ["seq": 0, "op": op, "entryId": entryId, "baseRevision": NSNull(), "payload": payload, "similar": [],
         "tainted": false, "entry": entry, "decision": decision]
    }

    private func rewrite(_ over: [String: Any] = [:]) -> [String: Any] {
        let sections: [[String: Any]] = [
            ["doc": "sessions-runtime", "key": "turn-delivery", "where": "3.1 §3", "result": NSNull(), "changed": NSNull(), "versionId": NSNull()],
            ["doc": "runner-architecture", "key": "heartbeat", "where": "7.1 §2", "result": NSNull(), "changed": NSNull(), "versionId": NSNull()],
        ]
        let base: [String: Any] = ["jobId": "J1", "result": "rewriting", "reason": NSNull(), "sha": NSNull(),
                                   "sections": sections, "seen": false, "settledAt": NSNull()]
        return base.merging(over) { _, new in new }
    }

    // MARK: the card a drafting call made (contract `chat.drafts.toolResult`)

    private let propose = #"{"changesetId":"","replayed":false,"ops":[{"seq":0,"status":"draft","entryId":null}],"status":"draft","draftId":"34draftA1b2c3d4e5f6g7","similar":[],"rewrites":[]}"#
    private let draft = #"{"status":"draft","draftId":"34draftB1b2c3d4e5f6g7","kind":"rewrite","replayed":false,"rewrites":[]}"#
    private let note = #"{"noted":true,"noteId":"N1","created":true,"readBy":"maintenance","challenged":{"status":"draft","draftId":"34draftC1b2c3d4e5f6g7"}}"#

    private func id(_ result: String?, tool: String = "mcp__orbit__wiki_propose") -> String? {
        WikiChatLogic.draftID(toolName: tool, result: result)
    }

    func testTheAnswerClaudeCodeRecordsAsJSONTextForEachDraftingTool() throws {
        XCTAssertEqual(id(propose), "34draftA1b2c3d4e5f6g7")
        let blocks = String(data: try JSONSerialization.data(withJSONObject: [["type": "text", "text": draft]]), encoding: .utf8)
        XCTAssertEqual(id(blocks, tool: "mcp__orbit__wiki_draft"), "34draftB1b2c3d4e5f6g7")
        XCTAssertEqual(id(note, tool: "mcp__orbit__wiki_note"), "34draftC1b2c3d4e5f6g7")
    }

    func testTheStructuredAnswerAnEnginePassesThroughWithTheMCPWrapper() {
        let wrapper = #"{"content":[{"type":"text","text":"Drafted card 34draftA1b2c3d4e5f6g7 for the owner …"}],"structuredContent":"# + propose + #"}"#
        XCTAssertEqual(id(wrapper), "34draftA1b2c3d4e5f6g7")
        XCTAssertEqual(id(#"{"result":{"structuredContent":"# + draft + #"}}"#, tool: "mcp__orbit__wiki_draft"), "34draftB1b2c3d4e5f6g7")
    }

    func testTheIDTheRunnersOwnSentenceNamesWhenAnEngineHandsTheAgentTextAlone() {
        XCTAssertEqual(id("Drafted card 34draftA1b2c3d4e5f6g7 for the owner of this wiki chat. Nothing in the wiki changed"),
                       "34draftA1b2c3d4e5f6g7")
        XCTAssertEqual(id("This request already made card 34draftB1b2c3d4e5f6g7 under this idempotencyKey"), "34draftB1b2c3d4e5f6g7")
        XCTAssertEqual(id("Noted as N1.\nIn this wiki chat the flag is card 34draftC1b2c3d4e5f6g7, for the owner to apply",
                          tool: "mcp__orbit__wiki_note"), "34draftC1b2c3d4e5f6g7")
    }

    func testTheCardIsKeyedByItsPublicIDWhicheverSpellingTheAnswerUsed() throws {
        let uuid = "0196e000-0000-7000-8000-000000000501"
        let structured = try XCTUnwrap(id(#"{"status":"draft","draftId":"\#(uuid)","kind":"rewrite","replayed":false,"rewrites":[]}"#,
                                          tool: "mcp__orbit__wiki_draft"))
        XCTAssertNotNil(structured.range(of: #"^[0-9A-Za-z]{20,22}$"#, options: .regularExpression), structured)
        XCTAssertEqual(id("Drafted card \(uuid) for the owner of this wiki chat."), structured)
        XCTAssertEqual(id("Drafted card \(structured) for the owner of this wiki chat."), structured)
        XCTAssertEqual(PublicID.storageKey(structured), uuid)
    }

    func testNoCardForADryRunARefusalOrAnyOtherAnswer() {
        XCTAssertNil(id(#"{"changesetId":"","replayed":false,"ops":[],"status":"draft","draftId":null,"dryRun":true}"#))
        XCTAssertNil(id(#"{"changesetId":"C1","replayed":false,"ops":[{"seq":0,"status":"refused","reasons":[]}]}"#))
        XCTAssertNil(id("Dry run in a wiki chat: every op was checked, and NO card was made"))
        XCTAssertNil(id(#"{"noted":true,"noteId":"N1"}"#, tool: "mcp__orbit__wiki_note"))
        XCTAssertNil(id(nil))
        XCTAssertNil(id(propose, tool: "mcp__orbit__wiki_get"), "another tool's answer is no card")
    }

    func testADraftingCallIsToldByItsMCPNameUnderAnyEngineOrByTheCLIDoorInAShell() {
        for name in ["mcp__orbit__wiki_propose", "mcp__orbit__wiki_draft", "mcp__orbit__wiki_note"] {
            XCTAssertTrue(WikiChatLogic.isDraftingCall(name), name)
        }
        for name in ["mcp__orbit__wiki_search", "mcp__orbit__wiki_get", "mcp__orbit__session_create", "Read", "wiki_draft"] {
            XCTAssertFalse(WikiChatLogic.isDraftingCall(name), name)
        }
        XCTAssertTrue(WikiChatLogic.isDraftingCall("Bash", command: "orbit wiki draft --kind rewrite --doc sessions-runtime"))
        XCTAssertTrue(WikiChatLogic.isDraftingCall("Bash", command: "cd x && orbit wiki propose --json < ops.json"))
        XCTAssertFalse(WikiChatLogic.isDraftingCall("Bash", command: "orbit wiki search lease"))
        XCTAssertEqual(WikiChatLogic.draftID(toolName: "Bash", command: "orbit wiki draft --kind rewrite", result: draft),
                       "34draftB1b2c3d4e5f6g7")
    }

    // MARK: how a card looks in each state (design §7.3, board 42 ② ③ ④)

    func testHowACardLooksInEachState() throws {
        let add = [op("add")]
        let cases: [(String, [String: Any], String, WikiChatLogic.Tone, [WikiChatAction], String?, Bool)] = [
            ("draft", ["state": "draft"], "Draft · Add decision", .accent, [.apply, .edit, .discard], nil, false),
            ("replaced", ["state": "replaced"], "Replaced", .grey, [], "A newer draft took over.", true),
            ("changed", ["state": "changed"], "Changed since this draft", .amber, [.redo, .discard], nil, false),
            ("applied", ["state": "applied", "undoable": true], "Applied · Confirmed by you", .green, [.undo, .openEntry], nil, true),
            ("discarded", ["state": "discarded"], "Discarded", .grey, [], nil, true),
            ("not applied", ["state": "not_applied"], "Not applied", .grey, [], nil, true),
            ("undone", ["state": "undone"], "Undone", .grey, [], nil, true),
            ("a rewrite drafted", ["kind": "rewrite", "label": "Rewrite from main", "state": "draft"], "Draft · Rewrite from main",
             .accent, [.rewrite, .discard], nil, false),
            ("a plan change", ["kind": "plan", "label": "Plan change", "state": "draft"], "Draft · Plan change", .accent,
             [.applyRebuild, .openInPlan, .discard], nil, false),
        ]
        for (name, over, title, tone, actions, note, quiet) in cases {
            let look = WikiChatLogic.cardLook(try card(over.merging(["ops": add]) { old, _ in old }))
            XCTAssertEqual(look.title, title, name)
            XCTAssertEqual(look.tone, tone, name)
            XCTAssertEqual(look.actions, actions, name)
            XCTAssertEqual(look.note, note, name)
            XCTAssertEqual(look.quiet, quiet, name)
            XCTAssertFalse(look.inReview, name)
        }
    }

    func testAnAppliedCardWhoseChallengeWaitsInReviewIsInReviewNotConfirmed() throws {
        let pending = try card(["state": "applied", "label": "Challenge entry", "changesetId": "C1",
                                "ops": [op("challenge", entryId: "E1", decision: "pending")]])
        let look = WikiChatLogic.cardLook(pending)
        XCTAssertEqual(look.title, "Applied · In Review")
        XCTAssertNil(look.title.range(of: "confirmed", options: .caseInsensitive))
        XCTAssertEqual(look.tone, .amber)
        XCTAssertEqual(look.note, WikiChatCopy.cardAppliedInReviewNote)
        XCTAssertTrue(look.inReview)
        XCTAssertEqual(look.actions, [.openEntry])
        XCTAssertEqual(WikiChatLogic.inReviewOp(pending)?.entryId, "E1")
        // Answered in Review since: the press stands confirmed.
        let answered = WikiChatLogic.cardLook(try card(["state": "applied", "label": "Challenge entry",
                                                        "ops": [op("challenge", entryId: "E1", decision: "accepted")]]))
        XCTAssertEqual(answered.title, "Applied · Confirmed by you")
        XCTAssertFalse(answered.inReview)
        XCTAssertNil(WikiChatLogic.inReviewOp(try card(["state": "applied", "ops": [op("challenge", decision: "accepted")]])))
    }

    // MARK: what a card is about, on its face

    func testTheFaceHoldsTheEntrysWordsTheWhyTheSourcesAndAnAmendsRedAndGreenLines() throws {
        let face = WikiChatLogic.cardFace(try card(["ops": [op("add", payload: [
            "entry": ["kind": "decision", "title": "Runner offline after three missed heartbeats", "summary": "One line.",
                      "fields": ["decision": "Three missed heartbeats mark a runner offline.", "context": "x"]],
            "sources": [["kind": "turn", "session": "self", "quote": "Keep three."],
                        ["kind": "commit", "ref": "99cd3c4".padding(toLength: 40, withPad: "0", startingAt: 0),
                         "locator": ["path": "src/apiserver/src/runners/runner-presence.ts", "lines": "30-31"]]],
        ])]]))
        XCTAssertEqual(face.heading, "Runner offline after three missed heartbeats")
        XCTAssertEqual(face.rows, [.init(label: "Decision", value: "Three missed heartbeats mark a runner offline."),
                                   .init(label: "Why", value: "To ride out one gateway restart.")])
        XCTAssertEqual(face.sources, ["Your message in this chat", "src/apiserver/src/runners/runner-presence.ts L30-31 · 99cd3c4"])

        let amend = WikiChatLogic.cardFace(try card(["label": "Amend entry", "ops": [op(
            "amend", entryId: "E1",
            payload: ["changes": ["summary": "The nginx config of the time limited the handshake."]],
            entry: ["title": "Why long-poll, not WebSocket", "summary": "The gateway does not support WebSocket."])]]))
        XCTAssertEqual(amend.heading, "Why long-poll, not WebSocket")
        XCTAssertEqual(amend.diff, [.init(added: false, text: "The gateway does not support WebSocket."),
                                    .init(added: true, text: "The nginx config of the time limited the handshake.")])

        let rewriteCard = WikiChatLogic.cardFace(try card(["kind": "rewrite", "rewrites": [
            ["doc": "sessions-runtime", "key": "turn-delivery", "where": "3.1 §3", "title": "Turn delivery"]]]))
        XCTAssertEqual(rewriteCard.heading, "3.1 §3 Turn delivery")
    }

    /// The face's other readings: a kind without its first field shows the summary, several ops a row each, and a
    /// source of another chat, a line number or a bare kind reads as the web's does.
    func testTheFacesOtherReadings() throws {
        let summary = WikiChatLogic.cardFace(try card(["rationale": " ", "ops": [op("add", payload: [
            "entry": ["kind": "concept", "title": "Lease", "summary": "A runner holds a session for a while."]])]]))
        XCTAssertEqual(summary.rows, [.init(label: "Summary", value: "A runner holds a session for a while.")])
        let two = try card(["ops": [op("retire", entryId: "E1", entry: ["title": "Old rule"]),
                                    op("add", payload: ["entry": ["title": "New rule"]])]])
        XCTAssertEqual(WikiChatLogic.cardFace(two).heading, nil)
        XCTAssertEqual(WikiChatLogic.cardFace(two).rows.map(\.label), ["Retire", "Add", "Why"])
        XCTAssertEqual(WikiChatLogic.cardFace(two).rows.map(\.value).prefix(2), ["Old rule", "New rule"])
        let sources = WikiChatLogic.cardFace(try card(["ops": [op("add", payload: ["sources": [
            ["kind": "turn", "session": "S9other"], ["kind": "turn"], ["kind": "doc", "locator": ["path": "README.md", "line": 12]],
            ["kind": "url"], ["kind": "commit", "ref": "abc1234"],
        ]])]])).sources
        XCTAssertEqual(sources, ["turn", "Your message in this chat", "README.md L12", "url", "commit abc1234"])
        XCTAssertEqual(WikiChatLogic.faceLabel("whyNot"), "Why not")
    }

    // MARK: the line under an applied card, for every result (design §8.3)

    func testTheLineUnderAnAppliedCardForEveryResult() throws {
        let cases: [(String, [String: Any], String, WikiChatLogic.ResultTone, Bool, [WikiChatAction])] = [
            ("rewriting, before the job named its commit", [:], "Rewriting 3.1 §3 and 7.1 §2…", .run, false, []),
            ("rewriting from main", ["sha": "7f3e2a1c9b8d"], "Rewriting 3.1 §3 and 7.1 §2 from main@7f3e2a1…", .run, false, []),
            ("held up by maintenance", ["result": "waiting", "reason": "maintenance_running"],
             "Rewrite waiting · Maintenance is running", .amber, true, []),
            ("held up by a setting the owner fixes", ["result": "waiting", "reason": "no_workspace"],
             "Rewrite waiting · Maintenance has no workspace", .amber, true, [.settings]),
            ("updated", ["result": "updated", "sections": [
                ["doc": "sessions-runtime", "key": "turn-delivery", "where": "3.1 §3", "result": "updated", "changed": 1, "versionId": "V1"],
                ["doc": "runner-architecture", "key": "heartbeat", "where": "7.1 §2", "result": "same", "changed": 0, "versionId": NSNull()],
            ]], "Wiki updated · 3.1 §3 — 1 sentence · 7.1 §2 — reads the same", .ok, false, [.seeChanges]),
            ("read the same, not seen", ["result": "same", "sections": [
                ["doc": "sessions-runtime", "key": "turn-delivery", "where": "3.1 §3", "result": "same", "changed": 0, "versionId": "V2"],
            ]], "3.1 §3 — reads the same", .amber, true, [.seeChanges]),
            ("failed", ["result": "failed"], "Rewrite failed", .error, true, [.tryAgain]),
            ("gone from the plan", ["result": "gone", "sections": [
                ["doc": "sessions-runtime", "key": "old", "where": "sessions-runtime §old", "result": "gone", "changed": NSNull(), "versionId": NSNull()],
            ]], "sessions-runtime §old — no longer in the plan", .grey, false, []),
        ]
        for (name, over, line, tone, waits, rewriteActions) in cases {
            let view = try card(["state": "applied", "undoable": true, "rewrite": rewrite(over)])
            let look = try XCTUnwrap(WikiChatLogic.resultLook(view), name)
            XCTAssertEqual(look.line, line, name)
            XCTAssertEqual(look.tone, tone, name)
            XCTAssertEqual(look.waits, waits, name)
            XCTAssertEqual(WikiChatLogic.cardLook(view).rewriteActions, rewriteActions, name)
            XCTAssertEqual(WikiChatLogic.cardLook(view).actions, [.undo, .openEntry], name)
        }
    }

    func testItStopsWaitingOnceSeenDrawsNothingUnappliedAndSettingsOnlyForWhatSettingsFixes() throws {
        func settings(_ reason: String) throws -> [WikiChatAction] {
            WikiChatLogic.cardLook(try card(["state": "applied", "undoable": true,
                                             "rewrite": rewrite(["result": "waiting", "reason": reason])])).rewriteActions
        }
        XCTAssertEqual(WikiChatLogic.resultLook(try card(["state": "applied", "rewrite": rewrite(["result": "same", "seen": true])]))?.waits, false)
        XCTAssertEqual(WikiChatLogic.resultLook(try card(["state": "applied", "rewrite": rewrite(["result": "failed", "seen": true])]))?.waits, false)
        XCTAssertNil(WikiChatLogic.resultLook(try card(["state": "undone", "rewrite": rewrite(["result": "updated"])])))
        XCTAssertNil(WikiChatLogic.resultLook(try card(["state": "applied"])))
        XCTAssertEqual(try settings("no_workspace"), [.settings])
        XCTAssertEqual(try settings("runner_missing"), [.settings])
        XCTAssertEqual(try settings("runner_offline"), [])
        XCTAssertEqual(try settings("maintenance_running"), [])
    }

    func testASettledRewriteIsMarkedSeenOnceOpenedAndOnlyASettledOneNotSeenYet() throws {
        for result in ["updated", "same", "failed"] {
            XCTAssertTrue(WikiChatLogic.needsSeen(try card(["state": "applied", "rewrite": rewrite(["result": result])])), result)
        }
        for result in ["rewriting", "waiting", "gone"] {
            XCTAssertFalse(WikiChatLogic.needsSeen(try card(["state": "applied", "rewrite": rewrite(["result": result])])), result)
        }
        XCTAssertFalse(WikiChatLogic.needsSeen(try card(["state": "applied", "rewrite": rewrite(["result": "same", "seen": true])])))
    }

    /// The sections an open card would rewrite are marked on the page beside the chat; a settled card marks none.
    func testTheSectionsAnOpenCardWouldRewrite() throws {
        let sections: [[String: Any]] = [["doc": "sessions-runtime", "key": "turn-delivery", "where": "3.1 §3", "title": NSNull()]]
        let open = try card(["rewrites": sections])
        let applied = try card(["id": "D2", "state": "applied", "rewrites": [["doc": "wiki-runtime", "key": "x", "where": "7.1 §2", "title": NSNull()]]])
        XCTAssertEqual(WikiChatLogic.wouldRewrite([open, applied]), ["sessions-runtime#turn-delivery"])
    }

    // MARK: what a press that did not go says (`wikiChatPressError`)

    func testAPressRefusedFailedAtTheServerOrLostIsSaidTruthfully() {
        XCTAssertEqual(WikiChatLogic.pressError(APIError.http(status: 409, body: #"{"message":"It changed since this draft. "}"#)),
                       "The card couldn’t be pressed: It changed since this draft.")
        XCTAssertEqual(WikiChatLogic.pressError(APIError.http(status: 502, body: "<html>Bad Gateway</html>")),
                       "The server couldn’t take the press (502). Try again in a moment.")
        XCTAssertEqual(WikiChatLogic.pressError(APIError.http(status: 400, body: nil)), "The card couldn’t be pressed: HTTP 400")
        XCTAssertEqual(WikiChatLogic.pressError(URLError(.notConnectedToInternet)),
                       "The press didn’t reach the server. Check the connection, then try again.")
    }

    // MARK: Edit (design §7.2)

    /// Edit opens on each add, supersede and amend's two lines, and sends only what the owner changed — nothing at all
    /// while nothing changed, which would be Apply.
    func testEditSendsOnlyWhatTheOwnerChanged() throws {
        let view = try card(["ops": [
            op("add", payload: ["entry": ["title": "Lease", "summary": "Held a while."]]),
            ["seq": 1, "op": "amend", "entryId": "E1", "payload": ["changes": ["summary": "Held for 90 s."]],
             "entry": ["title": "Heartbeat", "summary": "Every 30 s."]],
            ["seq": 2, "op": "retire", "entryId": "E2", "payload": [:]],
        ]])
        XCTAssertEqual(WikiChatLogic.editable(view).map(\.seq), [0, 1])
        XCTAssertEqual(WikiChatLogic.editWords(view.ops[0]), .init(title: "Lease", summary: "Held a while."))
        XCTAssertEqual(WikiChatLogic.editWords(view.ops[1]), .init(title: "Heartbeat", summary: "Held for 90 s."))
        var words = Dictionary(uniqueKeysWithValues: WikiChatLogic.editable(view).map { ($0.seq, WikiChatLogic.editWords($0)) })
        XCTAssertEqual(WikiChatLogic.editOps(view, words: words), [])
        words[0]?.title = "  Session lease "
        words[1]?.summary = "Held for 90 s. "
        XCTAssertEqual(WikiChatLogic.editOps(view, words: words),
                       [WikiChatEditRequest.Op(seq: 0, changes: WikiEntryChanges(title: "Session lease"))])
    }

    // MARK: See changes (design §8.4, board 42 ③)

    private func versions() throws -> [WikiDocSectionVersion] {
        let json = #"""
        [{"id":"V3","reason":{"kind":"chat","title":"Runner 离线判定的原因"},"at":"2026-11-06T10:47:00.000Z","changed":1,
          "rows":[{"op":"same","text":"Runner 每 30 秒发送一次心跳。"},{"op":"added","text":"留三次余量是为了扛住一次网关重启。"}]},
         {"id":"V2","reason":{"kind":"maintenance"},"at":"2026-11-05T09:00:00.000Z","changed":0,"rows":[{"op":"same","text":"a"}]},
         {"id":"V1","reason":{"kind":"build","planVersion":3,"sha":"7f3e2a1c9b8d"},"at":"2026-11-04T09:00:00.000Z","changed":2,
          "rows":[{"op":"removed","text":"b"},{"op":"added","text":"c"}]}]
        """#
        return try JSONDecoder().decode([WikiDocSectionVersion].self, from: Data(json.utf8))
    }

    func testSeeChangesOpensOnTheWriteItWasAskedForWithTheEarlierOnesFolded() throws {
        let all = try versions()
        guard case .shown(let current, let earlier) = WikiChatLogic.seeChanges(versions: all, failed: false, versionID: "V2", unchanged: false) else {
            return XCTFail("V2 is kept")
        }
        XCTAssertEqual(current.id, "V2")
        XCTAssertEqual(earlier.map(\.id), ["V1"])
        guard case .shown(let newest, let before) = WikiChatLogic.seeChanges(versions: all, failed: false, versionID: nil, unchanged: false) else {
            return XCTFail("without an id it opens on the newest")
        }
        XCTAssertEqual(newest.id, "V3")
        XCTAssertEqual(before.map(\.id), ["V2", "V1"])
        XCTAssertEqual(WikiChatLogic.seeChanges(versions: all, failed: false, versionID: "V9", unchanged: false), .none)
        XCTAssertEqual(WikiChatLogic.seeChanges(versions: [], failed: false, versionID: nil, unchanged: false), .none)
        XCTAssertEqual(WikiChatLogic.seeChanges(versions: nil, failed: false, versionID: "V3", unchanged: false), .loading)
        XCTAssertEqual(WikiChatLogic.seeChanges(versions: all, failed: true, versionID: "V3", unchanged: false), .failed)
        XCTAssertEqual(WikiChatLogic.seeChanges(versions: nil, failed: false, versionID: nil, unchanged: true), .same,
                       "a section the write left as it was keeps no version: nothing to read")
        XCTAssertEqual(WikiChatLogic.earlierShown, 4)
    }

    func testSeeChangesSaysWhyWhenAndHowManyAndShowsOnlyTheRowsThatChanged() throws {
        let all = try versions()
        let utc = try XCTUnwrap(TimeZone(identifier: "UTC"))
        XCTAssertEqual(WikiChatLogic.seeChangesCause(all[0], timeZone: utc), "After chat Runner 离线判定的原因 · 1 sentence changed · Nov 6, 10:47")
        XCTAssertEqual(WikiChatLogic.seeChangesCause(all[1], timeZone: utc), "After maintenance · reads the same · Nov 5, 09:00")
        XCTAssertEqual(WikiChatLogic.seeChangesCause(all[2], timeZone: utc),
                       "After the build of plan version 3 · 7f3e2a1 · 2 sentences changed · Nov 4, 09:00")
        XCTAssertEqual(WikiChatLogic.changedRows(all[0].rows).map(\.text), ["留三次余量是为了扛住一次网关重启。"])
        XCTAssertEqual(WikiChatLogic.changedRows(all[1].rows), [])
        XCTAssertEqual(WikiChatLogic.changedRows(all[2].rows).map(\.op), [.removed, .added])
    }

    // MARK: a chat that takes no more messages (C8 review)

    func testAChatInTrashOrEndedSaysSoAndOneTheServerRetriesDoesNot() {
        XCTAssertEqual(WikiChatLogic.endedLine(trashed: true, status: .awaitingInput, retryPending: false), WikiChatCopy.trashed)
        XCTAssertEqual(WikiChatLogic.endedLine(trashed: false, status: .succeeded, retryPending: false), WikiChatCopy.ended)
        XCTAssertEqual(WikiChatLogic.endedLine(trashed: false, status: .cancelled, retryPending: false), WikiChatCopy.ended)
        XCTAssertNil(WikiChatLogic.endedLine(trashed: false, status: .failed, retryPending: true), "the server re-sends it")
        for live: RunStatus in [.pending, .running, .awaitingInput, .interrupted] {
            XCTAssertNil(WikiChatLogic.endedLine(trashed: false, status: live, retryPending: false), live.rawValue)
        }
    }
}
