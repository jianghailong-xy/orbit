import Foundation
import XCTest
@testable import OrbitKit

/// The rewrite cards (`wiki-chat-views.fixture.json`, written by `wiki-chat-drafts.pg.spec.ts` from the drafts read route) and the
/// contents note (`wiki-chat.server-payloads.json`, written by `wiki-chat.pg.spec.ts` with WIKI_CHAT_PAYLOADS set), drawn from
/// what the apiserver built, not by hand.
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

    /// A card from `wiki-chat-views.fixture.json`, which `wiki-chat-drafts.pg.spec.ts` writes from the drafts read route.
    private func card(_ name: String) throws -> WikiChatDraftView {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("src/shared/src/wiki-chat-views.fixture.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                let top = try JSONSerialization.jsonObject(with: Data(contentsOf: candidate)) as! [String: Any]
                guard let one = (top["views"] as? [String: Any])?[name] else { throw Missing(what: "view \(name)") }
                return try JSONDecoder().decode(WikiChatDraftView.self, from: JSONSerialization.data(withJSONObject: one))
            }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(what: "src/shared/src/wiki-chat-views.fixture.json")
    }

    func testAnAutoWrittenCardWhileItsRewriteRuns() throws {
        let look = WikiChatLogic.cardLook(try card("autoRewriting"))
        XCTAssertEqual(look.title, "Rewritten from main")
        XCTAssertEqual(look.tone, .green)
        XCTAssertEqual(look.actions, [.undo])
        XCTAssertNil(look.note)
    }

    func testAnAutoWrittenCardOnceItsRewriteSettled() throws {
        let view = try card("autoUpdated")
        let look = WikiChatLogic.cardLook(view)
        XCTAssertEqual(look.title, "Rewritten from main")
        XCTAssertEqual(look.actions, [.undo])
        let result = try XCTUnwrap(WikiChatLogic.resultLook(view))
        XCTAssertEqual(result.tone, .ok)
        XCTAssertFalse(result.line.isEmpty)
    }

    func testHeldCardsSayWhyAndOfferApplyAndDiscard() throws {
        let web = WikiChatLogic.cardLook(try card("heldWeb"))
        XCTAssertEqual(web.title, "Draft · Rewrite from main")
        XCTAssertEqual(web.note, "Apply to write: this chat read web content")
        XCTAssertEqual(web.actions, [.apply, .discard])
        let budget = WikiChatLogic.cardLook(try card("heldBudget"))
        XCTAssertEqual(budget.note, "Apply to write: today's automatic rewrites are used up")
        XCTAssertEqual(budget.actions, [.apply, .discard])
    }

    func testTheDeliveredContentsBlockIsLabelledWikiContents() throws {
        let text = String(decoding: try raw("chat.delivered.contents"), as: UTF8.self)
        let block = try XCTUnwrap(text.components(separatedBy: "\n\n").first { $0.hasPrefix("<orbit_wiki_contents") })
        let note = try XCTUnwrap(WikiChatLogic.parseNoteTag(block))
        XCTAssertEqual(WikiChatLogic.noteLabel(note), "Wiki contents")
    }

    /// The turn the server delivered with the owner's words: split where the recorded note begins, the note is named by
    /// `describeNote` as web names it ("Wiki contents" first), and a turn with typed words stays the owner's bubble —
    /// the generic Orbit line is only for a turn with nothing typed (`OrbitEvent.draws`), as on web.
    func testTheDeliveredTurnSplitsIntoTheOwnersWordsAndANoteNamedWikiContents() throws {
        let text = String(decoding: try raw("chat.delivered.contents"), as: UTF8.self)
        let start = try XCTUnwrap(text.range(of: "\n\n<orbit_wiki_chat>"))
        let note = String(text[start.lowerBound...])
        let split = try XCTUnwrap(splitRecordedNote(text, note: note))
        XCTAssertEqual(split.text, String(text[..<start.lowerBound]))
        XCTAssertTrue(split.text.hasPrefix("Is the lease really ninety seconds?"))
        XCTAssertTrue(describeNote(split.note).hasPrefix("Wiki contents"), describeNote(split.note))
        XCTAssertFalse(OrbitEvent.draws(text: split.text, note: split.note))
        XCTAssertTrue(OrbitEvent.draws(text: "", note: split.note))
        XCTAssertTrue(OrbitEvent.name(split.note).hasPrefix("Wiki contents"))
    }
}
