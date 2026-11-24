import Foundation
import XCTest
@testable import OrbitKit

/// The rewrite cards and the contents note, drawn from what the apiserver built: `src/shared/src/wiki-chat.server-payloads.json`
/// is written by `wiki-chat-drafts.pg.spec.ts` and `wiki-chat.pg.spec.ts` (run with WIKI_CHAT_PAYLOADS set), not by hand.
final class WikiChatServerPayloadTests: XCTestCase {

    private struct Missing: Error { let what: String }

    private func payloadsData() throws -> Data {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("src/shared/src/wiki-chat.server-payloads.json")
            if FileManager.default.fileExists(atPath: candidate.path) { return try Data(contentsOf: candidate) }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(what: "src/shared/src/wiki-chat.server-payloads.json")
    }

    private func raw(_ name: String) throws -> Data {
        let top = try JSONSerialization.jsonObject(with: payloadsData()) as! [String: Any]
        let all = top["captures"] as! [String: Any]
        guard let one = all[name] else { throw Missing(what: "captured payload \(name)") }
        if let s = one as? String { return Data(s.utf8) }
        return try JSONSerialization.data(withJSONObject: one)
    }

    private func card(_ name: String) throws -> WikiChatDraftView {
        try JSONDecoder().decode(WikiChatDraftView.self, from: raw(name))
    }

    func testAnAutoWrittenCardWhileItsRewriteRuns() throws {
        let look = WikiChatLogic.cardLook(try card("drafts.rewritten.rewriting"))
        XCTAssertEqual(look.title, "Rewritten from main")
        XCTAssertEqual(look.tone, .green)
        XCTAssertEqual(look.actions, [.undo])
        XCTAssertNil(look.note)
    }

    func testAnAutoWrittenCardOnceItsRewriteSettled() throws {
        let view = try card("drafts.rewritten.settled")
        let look = WikiChatLogic.cardLook(view)
        XCTAssertEqual(look.title, "Rewritten from main")
        XCTAssertEqual(look.actions, [.undo])
        let result = try XCTUnwrap(WikiChatLogic.resultLook(view))
        XCTAssertEqual(result.tone, .ok)
        XCTAssertFalse(result.line.isEmpty)
    }

    func testHeldCardsSayWhyAndOfferApplyAndDiscard() throws {
        let web = WikiChatLogic.cardLook(try card("drafts.held.web"))
        XCTAssertEqual(web.title, "Draft · Rewrite from main")
        XCTAssertEqual(web.note, "Apply to write: this chat read web content")
        XCTAssertEqual(web.actions, [.apply, .discard])
        let budget = WikiChatLogic.cardLook(try card("drafts.held.budget"))
        XCTAssertEqual(budget.note, "Apply to write: today's automatic rewrites are used up")
        XCTAssertEqual(budget.actions, [.apply, .discard])
        let draft = WikiChatLogic.cardLook(try card("drafts.held.draft"))
        XCTAssertEqual(draft.note, "Written once you apply or discard the draft that rewrites the same section")
        XCTAssertEqual(draft.actions, [.apply, .discard])
    }

    func testTheDeliveredContentsBlockIsLabelledWikiContents() throws {
        let text = String(decoding: try raw("chat.delivered.contents"), as: UTF8.self)
        let block = try XCTUnwrap(text.components(separatedBy: "\n\n").first { $0.hasPrefix("<orbit_wiki_contents") })
        let note = try XCTUnwrap(WikiChatLogic.parseNoteTag(block))
        XCTAssertEqual(WikiChatLogic.noteLabel(note), "Wiki contents")
    }
}
