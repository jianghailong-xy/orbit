import Foundation
import XCTest
@testable import OrbitKit

/// The wiki chat's client half holds to the vectors the shared spec runs (docs/wiki-chat-design.md §3–§9, contract
/// `chat`, `docs.versions`): `src/shared/src/wiki-chat.fixture.json` — whose `about` names OrbitKit as its other
/// reader — run through `WikiChatLogic` case by case: what a card shows and offers in each state, the line under an
/// applied card, the round button's look, what adds to the Wiki's waiting count, the attachment lines, and the Docs
/// rows. The closed sets are the shared module's own lists and the contract's.
///
/// Every half is a failure — never an `XCTSkip` — when its counterpart goes missing: a group the fixture no longer
/// holds, a value of a closed set this client cannot decode, a case that reads differently here.
final class WikiChatContractTests: XCTestCase {

    private static let fixturePath = "src/shared/src/wiki-chat.fixture.json"
    private static let sharedPath = "src/shared/src/wikiChat.ts"
    private static let contractPath = "contracts/wiki.contract.json"

    private struct Missing: Error, CustomStringConvertible {
        let file: String
        var description: String {
            "\(file) was not found above this test file. The wiki chat is one half of a pair; if the other half moved, "
                + "move this check with it rather than deleting it."
        }
    }

    private func find(_ relative: String) throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(file: relative)
    }

    // MARK: the fixture's shapes

    private struct CardCase: Decodable {
        let name: String
        let facts: WikiChatDraftFacts
        let kind: WikiChatDraftKind
        let ops: [WikiChatDraftOp]
        let undoable: Bool
        let state: WikiChatDraftState
        let label: String
        let title: String
        let actions: [WikiChatAction]
        let needsYou: Bool
    }

    private struct ResultCase: Decodable {
        let name: String
        let card: WikiChatCard
        let line: String
        let actions: [WikiChatAction]
        let waits: Bool
        let needsYou: Bool
    }

    private struct FabCase: Decodable {
        let name: String
        let chats: [WikiChatFabChat]
        let counts: WikiChatFabCounts
        let state: WikiChatFabState
        let label: String
    }

    private struct WaitingCase: Decodable {
        let name: String
        let cards: [WikiChatCard]
        let chatWaiting: Int
        let banner: String?
    }

    private struct NoteCase: Decodable {
        let name: String
        let note: JSONValue
        let label: String
    }

    private struct ChangeCase: Decodable {
        let name: String
        let change: JSONValue
        let line: String
        let heading: String?
    }

    /// A plan card's face (C12): its change as the card read serves it, and the heading and rows it says.
    private struct PlanFaceCase: Decodable {
        struct Row: Decodable, Equatable { let label: String; let value: String }
        let name: String
        let change: WikiChatPlanChange
        let heading: String
        let rows: [Row]
    }

    private struct Fixture: Decodable {
        let cards: [CardCase]
        let results: [ResultCase]
        let fab: [FabCase]
        let waiting: [WaitingCase]
        let notes: [NoteCase]
        let changes: [ChangeCase]
        let planFaces: [PlanFaceCase]
    }

    private func fixture() throws -> Fixture {
        try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: find(Self.fixturePath)))
    }

    private func contract() throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: find(Self.contractPath)))
    }

    /// `export const NAME = ['a', 'b'] as const;` in the shared module, as its strings.
    private func sharedList(_ name: String) throws -> [String] {
        let source = try String(contentsOf: find(Self.sharedPath), encoding: .utf8)
        let start = try XCTUnwrap(source.range(of: "export const \(name) = ["), "\(Self.sharedPath) no longer declares \(name)")
        let end = try XCTUnwrap(source.range(of: "] as const;", range: start.upperBound..<source.endIndex))
        let body = source[start.upperBound..<end.lowerBound]
        return body.components(separatedBy: ",").compactMap { part in
            let trimmed = part.trimmingCharacters(in: .whitespacesAndNewlines)
            guard trimmed.count >= 2, trimmed.first == "'", trimmed.last == "'" else { return nil }
            return String(trimmed.dropFirst().dropLast())
        }
    }

    private func known<T: CaseIterable & RawRepresentable>(_: T.Type, except unknown: T? = nil) -> [String]
    where T.RawValue == String, T: Equatable {
        T.allCases.filter { $0 != unknown }.map(\.rawValue)
    }

    // MARK: the closed sets

    /// Every closed set this client decodes is the shared module's, value for value and in its order — a value the
    /// server starts sending that this client lacks is a red here, not an `unknown` on the owner's phone.
    func testTheClosedSetsAreTheSharedModules() throws {
        XCTAssertEqual(known(WikiChatDraftKind.self, except: .unknown), try sharedList("WIKI_CHAT_DRAFT_KINDS"))
        XCTAssertEqual(known(WikiChatDraftState.self, except: .unknown), try sharedList("WIKI_CHAT_DRAFT_STATES"))
        XCTAssertEqual(known(WikiChatRewriteResult.self, except: .unknown), try sharedList("WIKI_CHAT_REWRITE_RESULTS"))
        XCTAssertEqual(known(WikiChatPress.self), try sharedList("WIKI_CHAT_PRESSES"))
        XCTAssertEqual(known(WikiChatAction.self), try sharedList("WIKI_CHAT_ACTIONS"))
        XCTAssertEqual(known(WikiChatFabState.self), try sharedList("WIKI_CHAT_FAB_STATES"))
        XCTAssertEqual(known(WikiDocsFollowWaiting.self, except: .unknown), try sharedList("WIKI_DOCS_FOLLOW_WAITING"))
        XCTAssertEqual(known(WikiDocVersionReasonKind.self, except: .unknown), try sharedList("WIKI_DOC_VERSION_REASONS"))
    }

    /// And the contract's: the card states and kinds it defines, the rewrite results, the button's looks, the routes
    /// the presses go to, the rules' numbers, and the four note tags.
    func testTheClosedSetsAreTheContracts() throws {
        let chat = try XCTUnwrap(try contract()["chat"])
        func keys(_ value: JSONValue?) -> Set<String> {
            if case .object(let object)? = value { return Set(object.keys) }
            return []
        }
        func strings(_ value: JSONValue?) -> [String] {
            if case .array(let items)? = value { return items.compactMap(\.stringValue) }
            return []
        }
        XCTAssertEqual(keys(chat["drafts"]?["states"]), Set(known(WikiChatDraftState.self, except: .unknown)))
        XCTAssertEqual(keys(chat["drafts"]?["kinds"]), Set(known(WikiChatDraftKind.self, except: .unknown)))
        XCTAssertEqual(strings(chat["drafts"]?["results"]?["values"]), known(WikiChatRewriteResult.self, except: .unknown))
        XCTAssertEqual(strings(chat["fab"]?["states"]), known(WikiChatFabState.self))
        let routes = chat["routes"]
        for press in WikiChatPress.allCases {
            XCTAssertEqual(routes?[press.rawValue]?.stringValue, "POST /api/wiki/chat-drafts/:id/\(press.rawValue)",
                           "the \(press.rawValue) press's door")
        }
        XCTAssertEqual(routes?["list"]?.stringValue, "GET /api/wiki/spaces/:id/chats")
        XCTAssertEqual(routes?["create"]?.stringValue, "POST /api/wiki/spaces/:id/chats")
        XCTAssertEqual(routes?["drafts"]?.stringValue, "GET /api/wiki/chats/:id/drafts")
        XCTAssertEqual(routes?["draft"]?.stringValue, "GET /api/wiki/chat-drafts/:id")
        XCTAssertEqual(chat["rules"]?["selectionSentencesMax"], .int(WikiChatLogic.selectionSentencesMax))
        XCTAssertEqual(chat["rules"]?["rewritesMax"], .int(WikiChatLogic.rewritesMax))
        XCTAssertEqual(chat["rules"]?["chatsListed"], .int(WikiChatLogic.chatsListed))
        for (kind, tag) in WikiChatLogic.noteTags {
            XCTAssertEqual(chat["notes"]?[kind]?["tag"]?.stringValue, tag, "the \(kind) note's tag")
        }
        // The round button's place and size are the contract's words (design §3).
        let place = try XCTUnwrap(chat["fab"]?["where"]?.stringValue)
        XCTAssertTrue(place.contains("52 across and 24 from the edges on a desktop, 56 and 16 plus the safe area on a phone"), place)
        XCTAssertTrue(place.contains("keeps 88 clear"), place)
        XCTAssertEqual(WikiChatLogic.Fab.wideDiameter, 52)
        XCTAssertEqual(WikiChatLogic.Fab.wideInset, 24)
        XCTAssertEqual(WikiChatLogic.Fab.phoneDiameter, 56)
        XCTAssertEqual(WikiChatLogic.Fab.phoneInset, 16)
        XCTAssertEqual(WikiChatLogic.Fab.footClearance, 88)
        // iOS draws the two-height sheet (C11, design §9).
        XCTAssertTrue(chat["panel"]?["clients"]?.stringValue?.contains("iOS draws a two-height sheet whose half height leaves the page scrollable") == true)
    }

    // MARK: the vectors

    /// The fixture still holds every group this client reads, each with cases.
    func testTheFixtureHoldsItsGroups() throws {
        let cases = try fixture()
        XCTAssertGreaterThanOrEqual(cases.cards.count, 10)
        XCTAssertGreaterThanOrEqual(cases.results.count, 10)
        XCTAssertGreaterThanOrEqual(cases.fab.count, 5)
        XCTAssertGreaterThanOrEqual(cases.waiting.count, 1)
        XCTAssertGreaterThanOrEqual(cases.notes.count, 6)
        XCTAssertGreaterThanOrEqual(cases.changes.count, 5)
        XCTAssertGreaterThanOrEqual(cases.planFaces.count, 3)
        // Every state a card can be in has a case.
        XCTAssertEqual(Set(cases.cards.map(\.state)), Set(WikiChatDraftState.allCases.filter { $0 != .unknown }))
        // Every rewrite result an applied card can show has a case.
        XCTAssertEqual(Set(cases.results.compactMap(\.card.rewrite?.result)),
                       Set(WikiChatRewriteResult.allCases.filter { $0 != .unknown }))
        // And every look of the button.
        XCTAssertEqual(Set(cases.fab.map(\.state)), Set(WikiChatFabState.allCases))
    }

    /// A card in each state: its state from its facts, its label, its status line — an applied card whose challenge
    /// still waits in Review is not confirmed — its buttons, and whether the round button counts it.
    func testEveryCardIsTheFixtures() throws {
        let cards = try fixture().cards
        XCTAssertTrue(cards.contains { WikiChatLogic.appliedInReview($0.state, ops: $0.ops) },
                      "the fixture lost its applied card whose challenge waits in Review")
        for test in cards {
            XCTAssertEqual(WikiChatLogic.draftState(test.facts), test.state, test.name)
            XCTAssertEqual(WikiChatLogic.draftLabel(test.kind, ops: test.ops), test.label, test.name)
            let inReview = WikiChatLogic.appliedInReview(test.state, ops: test.ops)
            XCTAssertEqual(WikiChatLogic.cardTitle(test.state, label: test.label, inReview: inReview), test.title, test.name)
            let card = WikiChatCard(kind: test.kind, state: test.state, undoable: test.undoable)
            XCTAssertEqual(WikiChatLogic.cardActions(card), test.actions, test.name)
            XCTAssertEqual(WikiChatLogic.cardNeedsYou(card), test.needsYou, test.name)
        }
    }

    /// An applied card's rewrite: the line under it, its buttons, and whether it waits on the owner.
    func testEveryResultIsTheFixtures() throws {
        for test in try fixture().results {
            let rewrite = try XCTUnwrap(test.card.rewrite, test.name)
            XCTAssertEqual(WikiChatLogic.resultLine(rewrite), test.line, test.name)
            XCTAssertEqual(WikiChatLogic.cardActions(test.card), test.actions, test.name)
            XCTAssertEqual(WikiChatLogic.rewriteWaits(test.card), test.waits, test.name)
            XCTAssertEqual(WikiChatLogic.cardNeedsYou(test.card), test.needsYou, test.name)
        }
    }

    /// The round button: the three counts over a space's chats, and its look and words from them.
    func testEveryButtonIsTheFixtures() throws {
        for test in try fixture().fab {
            let counts = WikiChatLogic.fabCounts(test.chats)
            XCTAssertEqual(counts, test.counts, test.name)
            let (state, label) = WikiChatLogic.fabState(counts)
            XCTAssertEqual(state, test.state, test.name)
            XCTAssertEqual(label, test.label, test.name)
            XCTAssertEqual(WikiChatLogic.fab(counts).count, state == .needsYou ? counts.needsYou : 0, test.name)
        }
    }

    /// What the chat adds to W: rewrites that wait, never drafts or approvals — and Activity's one line for them.
    func testEveryWaitingCountIsTheFixtures() throws {
        for test in try fixture().waiting {
            XCTAssertEqual(WikiChatLogic.waiting(test.cards), test.chatWaiting, test.name)
            XCTAssertEqual(WikiChatLogic.waitingBanner(test.chatWaiting), test.banner, test.name)
        }
    }

    /// The "Orbit attached:" line of each chat note — and the same note read back off the opening tag the server
    /// writes, attributes escaped as `wikiChatNoteAttribute` escapes them.
    func testEveryAttachmentLineIsTheFixtures() throws {
        for test in try fixture().notes {
            let note = try XCTUnwrap(Self.note(test.note), test.name)
            XCTAssertEqual(WikiChatLogic.noteLabel(note), test.label, test.name)
            let tag = Self.openingTag(test.note)
            XCTAssertEqual(WikiChatLogic.parseNoteTag(tag + "\nbody\n</x>"), note, "\(test.name): \(tag)")
            XCTAssertEqual(describeNote(tag + "\nbody\n" + "</" + Self.tagName(test.note) + ">"), test.label, test.name)
        }
    }

    /// A plan card's face (C12, `wikiChatPlanFace`): the document, what of it changes, and the covers it writes — the
    /// same heading and rows the web draws from the same change.
    func testEveryPlanCardFaceIsTheFixtures() throws {
        for test in try fixture().planFaces {
            let face = WikiChatLogic.planFace(test.change)
            XCTAssertEqual(face.heading, test.heading, test.name)
            XCTAssertEqual(face.rows.map { PlanFaceCase.Row(label: $0.label, value: $0.value) }, test.rows, test.name)
        }
    }

    /// The Docs rows of Activity and See changes' heading.
    func testEveryDocsRowIsTheFixtures() throws {
        for test in try fixture().changes {
            let change = try XCTUnwrap(Self.change(test.change), test.name)
            XCTAssertEqual(WikiChatLogic.changeLine(change), test.line, test.name)
            if let heading = test.heading, case .section(_, let reason, _) = change {
                XCTAssertEqual(WikiChatLogic.versionHeading(reason), heading, test.name)
            }
        }
    }

    // MARK: reading the fixture's values

    private static func text(_ value: JSONValue?) -> String? {
        switch value {
        case .string(let s)?: return s
        case .int(let i)?:    return String(i)
        default:              return nil
        }
    }

    private static func number(_ value: JSONValue?) -> Int? {
        if case .int(let i)? = value { return i }
        return nil
    }

    static func note(_ value: JSONValue) -> WikiChatLogic.Note? {
        switch value["kind"]?.stringValue {
        case "chat":
            return .chat
        case "page":
            switch value["of"]?.stringValue {
            case "doc":   return text(value["doc"]).flatMap { doc in text(value["section"]).map { .pageDoc(doc: doc, section: $0) } }
            case "entry": return text(value["title"]).map { .pageEntry(title: $0) }
            case "plan":  return text(value["doc"]).map { .pagePlan(doc: $0, section: text(value["section"])) }
            default:      return nil
            }
        case "selection":
            guard let doc = text(value["doc"]), let section = text(value["section"]),
                  let sentences = number(value["sentences"]), let sources = number(value["sources"]) else { return nil }
            return .selection(doc: doc, section: section, toSection: text(value["toSection"]), sentences: sentences, sources: sources)
        case "drafts":
            return .drafts(applied: number(value["applied"]) ?? 0, edited: number(value["edited"]) ?? 0,
                           discarded: number(value["discarded"]) ?? 0, undone: number(value["undone"]) ?? 0)
        default:
            return nil
        }
    }

    private static func tagName(_ value: JSONValue) -> String {
        WikiChatLogic.noteTags[value["kind"]?.stringValue ?? ""] ?? "orbit_wiki_unknown"
    }

    /// The opening tag as the server's delivery writes it: `doc`, `section`, `to`, `sentences`, `sources` …, each
    /// value with `&`, `"`, `<` and `>` escaped.
    private static func openingTag(_ value: JSONValue) -> String {
        func attribute(_ name: String, _ raw: String?) -> String? {
            guard let raw else { return nil }
            let escaped = raw.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;")
                .replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
            return "\(name)=\"\(escaped)\""
        }
        var parts: [String?] = []
        switch value["kind"]?.stringValue {
        case "page":
            parts = [attribute("of", text(value["of"])), attribute("doc", text(value["doc"])),
                     attribute("section", text(value["section"])), attribute("title", text(value["title"]))]
        case "selection":
            parts = [attribute("doc", text(value["doc"])), attribute("section", text(value["section"])),
                     attribute("to", text(value["toSection"])), attribute("sentences", text(value["sentences"])),
                     attribute("sources", text(value["sources"]))]
        case "drafts":
            parts = ["applied", "edited", "discarded", "undone"].map { attribute($0, text(value[$0])) }
        default:
            parts = []
        }
        let attributes = parts.compactMap { $0 }
        return "<" + tagName(value) + (attributes.isEmpty ? "" : " " + attributes.joined(separator: " ")) + ">"
    }

    private static func change(_ value: JSONValue) -> WikiChatLogic.DocChange? {
        switch value["kind"]?.stringValue {
        case "left":
            return number(value["left"]).map { .left($0) }
        case "section":
            guard let place = text(value["where"]), let changed = number(value["changed"]),
                  let kind = value["reason"]?["kind"]?.stringValue.flatMap(WikiDocVersionReasonKind.init(rawValue:)) else { return nil }
            let reason = WikiDocVersionReason(kind: kind, title: text(value["reason"]?["title"]), sha: text(value["reason"]?["sha"]),
                                              planVersion: number(value["reason"]?["planVersion"]))
            return .section(place: place, reason: reason, changed: changed)
        default:
            return nil
        }
    }
}
