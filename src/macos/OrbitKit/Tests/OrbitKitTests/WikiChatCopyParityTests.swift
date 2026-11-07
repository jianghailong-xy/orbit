import Foundation
import XCTest
@testable import OrbitKit

/// The wiki chat says on iOS and macOS what it says on the web (CLAUDE.md §5, the project's instructions: new
/// sentences are defined in `src/web/src/lib/wikiChat.ts`, and Swift's `WikiChatCopy` mirrors them).
///
/// Three halves, each a failure — never an `XCTSkip` — when its counterpart goes missing:
/// - every sentence of the contract's `chat.copy` (the shared `WIKI_CHAT_COPY`, which `wikiChatContract.spec.ts`
///   holds to the contract and the web lib takes its words from) is in `WikiChatCopy.contract` under its key, word
///   for word, and every key there is one of the contract's;
/// - every `WIKI_*` string the web lib exports — its own, and the ones it takes from the shared copy — is in
///   `WikiChatCopy.web` under its name, word for word, and every name there is one the web lib still exports; an
///   export in a form this test cannot read is a failure too, never passed over;
/// - the web lib's sentence-making functions (`wikiChatRemove`, `wikiChatCapped`, `wikiChatOffline`,
///   `wikiChatPressError`, `wikiSeeChangesTitle`, `wikiSeeChangesCause`, `wikiEarlierChanges`) and the card face's
///   row labels say what `WikiChatCopy`'s do.
final class WikiChatCopyParityTests: XCTestCase {

    private static let lib = "src/web/src/lib/wikiChat.ts"
    private static let contractPath = "contracts/wiki.contract.json"

    private struct Missing: Error, CustomStringConvertible {
        let file: String
        var description: String {
            "\(file) was not found above this test file. The chat's words are one half of a pair; if the other half "
                + "moved, move this check with it rather than deleting it."
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

    /// The contract's `chat.copy`, flattened to `<group>.<key>`.
    private func contractCopy() throws -> [String: String] {
        let contract = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: find(Self.contractPath)))
        guard case .object(let groups)? = contract["chat"]?["copy"] else {
            XCTFail("\(Self.contractPath) has no chat.copy")
            return [:]
        }
        var flat: [String: String] = [:]
        for (group, value) in groups {
            guard case .object(let sentences) = value else {
                XCTFail("chat.copy.\(group) is not a group of sentences")
                continue
            }
            for (key, sentence) in sentences {
                guard let text = sentence.stringValue else {
                    XCTFail("chat.copy.\(group).\(key) is not a sentence")
                    continue
                }
                flat["\(group).\(key)"] = text
            }
        }
        return flat
    }

    private func webLib() throws -> String {
        try String(contentsOf: find(Self.lib), encoding: .utf8)
    }

    /// A single-quoted TypeScript string's value: `\'` and `\\` read back.
    private static func unquote(_ literal: String) -> String {
        var out = ""
        var escaped = false
        for character in literal {
            if escaped {
                out.append(character)
                escaped = false
            } else if character == "\\" {
                escaped = true
            } else {
                out.append(character)
            }
        }
        return out
    }

    /// Every `export const WIKI_<NAME> = …;` of the web lib whose value is a sentence: a string literal, or one of the
    /// shared copy's (`fab.idle`, `panel.newChat`, `WIKI_CHAT_COPY.card.sources` …), resolved through the contract.
    private func webSentences() throws -> [String: String] {
        let source = try webLib()
        let contract = try contractCopy()
        var found: [String: String] = [:]
        let literal = try NSRegularExpression(pattern: #"export const (WIKI_[A-Z_]+) = '((?:[^'\\]|\\.)*)';"#)
        let alias = try NSRegularExpression(
            pattern: #"export const (WIKI_[A-Z_]+) = (?:WIKI_CHAT_COPY\.)?(fab|panel|card|actions|result|notes)\.(\w+);"#)
        let range = NSRange(source.startIndex..., in: source)
        for match in literal.matches(in: source, range: range) {
            let name = String(source[Range(match.range(at: 1), in: source)!])
            let value = String(source[Range(match.range(at: 2), in: source)!])
            found[name] = Self.unquote(value)
        }
        for match in alias.matches(in: source, range: range) {
            let name = String(source[Range(match.range(at: 1), in: source)!])
            let key = "\(source[Range(match.range(at: 2), in: source)!]).\(source[Range(match.range(at: 3), in: source)!])"
            found[name] = contract[key] ?? "<no \(key) in the contract>"
        }
        return found
    }

    /// The web lib's names that are not sentences: the address keys (`?chat=`, `?chat=new`), and the mark the panel
    /// opens on for the first card that needs the owner.
    private static let notSentences: Set<String> = ["WIKI_CHAT_PARAM", "WIKI_CHAT_NEW_PARAM", "WIKI_CHAT_FOCUS_NEEDS_YOU"]

    /// The web lib's `WIKI_*` exports that are no string at all: a typed table or an object of numbers.
    private static let notStrings: Set<String> = ["WIKI_CHAT_WIDTH", "WIKI_CHAT_NO_ATTACHMENTS", "WIKI_CHAT_ACTION_PRESS"]

    // MARK: the contract's copy

    /// Every sentence of the contract's `chat.copy` is mirrored, under its own key and word for word.
    func testEveryContractSentenceIsMirrored() throws {
        let contract = try contractCopy()
        XCTAssertGreaterThan(contract.count, 100, "the contract's chat.copy lost its groups")
        for (key, sentence) in contract.sorted(by: { $0.key < $1.key }) {
            XCTAssertEqual(WikiChatCopy.contract[key], sentence, "chat.copy.\(key) is not mirrored in WikiChatCopy")
        }
    }

    /// And nothing is mirrored that the contract does not say: a sentence removed there goes here too.
    func testNothingIsMirroredThatTheContractDoesNotSay() throws {
        let contract = try contractCopy()
        for key in WikiChatCopy.contract.keys.sorted() {
            XCTAssertNotNil(contract[key], "WikiChatCopy.contract holds \(key), which the contract's chat.copy no longer has")
        }
    }

    // MARK: the web lib's

    /// Every sentence the web lib exports is mirrored, under its name and word for word — the panel's own names
    /// (`Chats in this space`, `Hide chat` …) and the shared copy's it takes.
    func testEveryWebLibSentenceIsMirrored() throws {
        let web = try webSentences()
        XCTAssertGreaterThanOrEqual(web.count, 20, "\(Self.lib) lost its sentences")
        for (name, sentence) in web.sorted(by: { $0.key < $1.key }) where !Self.notSentences.contains(name) {
            XCTAssertEqual(WikiChatCopy.web[name], sentence, "\(name) (\(Self.lib)) is not mirrored in WikiChatCopy.web")
        }
        for name in WikiChatCopy.web.keys.sorted() {
            XCTAssertNotNil(web[name], "WikiChatCopy.web holds \(name), which \(Self.lib) no longer exports")
        }
    }

    /// Every `WIKI_*` the web lib exports is read above — a literal or an alias of the shared copy — or is named here as
    /// no string: a sentence exported in another form (a template, a call) fails rather than slipping past the mirror.
    func testEveryWebLibExportIsRead() throws {
        let source = try webLib()
        let web = try webSentences()
        let export = try NSRegularExpression(pattern: #"export const (WIKI_[A-Z_]+)\b"#)
        let names = export.matches(in: source, range: NSRange(source.startIndex..., in: source)).map {
            String(source[Range($0.range(at: 1), in: source)!])
        }
        XCTAssertGreaterThanOrEqual(names.count, 40, "\(Self.lib) lost its exports")
        for name in names where !Self.notStrings.contains(name) {
            XCTAssertNotNil(web[name], "\(name) (\(Self.lib)) is exported in a form this test does not read: mirror it in WikiChatCopy.web and read it here")
        }
        for name in Self.notStrings {
            XCTAssertTrue(names.contains(name), "\(name) is no longer exported by \(Self.lib): take it off notStrings")
        }
    }

    /// The address keys are the web's too: a chat not started yet is `new`.
    func testTheNewChatIsTheWebsNew() throws {
        let web = try webSentences()
        XCTAssertEqual(web["WIKI_CHAT_NEW_PARAM"], WikiChatLogic.newChat)
        XCTAssertEqual(web["WIKI_CHAT_PARAM"], "chat")
    }

    /// The sentences the web lib makes from a value, made the same way here.
    func testTheMadeSentencesAreTheWebs() throws {
        let source = try webLib()
        XCTAssertTrue(source.contains("export const wikiChatRemove = (what: string): string => `Remove ${what}`;"),
                      "\(Self.lib) no longer makes Remove <what>")
        XCTAssertEqual(WikiChatCopy.remove("3.1 §3"), "Remove 3.1 §3")
        XCTAssertTrue(source.contains("`The first ${WIKI_CHAT_RULES.selectionSentencesMax} of ${selected} sentences`"),
                      "\(Self.lib) no longer makes the capped quote's words")
        XCTAssertEqual(WikiChatCopy.capped(28), "The first 20 of 28 sentences")
        XCTAssertTrue(source.contains("export const wikiChatOffline = (machine: string): string => fill(panel.offline, { machine });"),
                      "\(Self.lib) no longer fills panel.offline with the machine")
        XCTAssertEqual(WikiChatCopy.offline("HPC"), "HPC is offline. The chat waits for it to come back.")
        // A press refused, failed at the server, or lost (`wikiChatPressError`).
        XCTAssertTrue(source.contains("if (error.status >= 500) return `The server couldn’t take the press (${error.status}). Try again in a moment.`;"),
                      "\(Self.lib) no longer says a server's failed press this way")
        XCTAssertEqual(WikiChatCopy.pressServerFailed(502), "The server couldn’t take the press (502). Try again in a moment.")
        XCTAssertTrue(source.contains("return `${WIKI_CHAT_PRESS_FAILED}: ${error.message.trim()}`;"),
                      "\(Self.lib) no longer puts the server's reason after The card couldn’t be pressed")
        XCTAssertEqual(WikiChatCopy.pressRefused("It changed since"), "The card couldn’t be pressed: It changed since")
        XCTAssertTrue(source.contains("return 'The press didn’t reach the server. Check the connection, then try again.';"),
                      "\(Self.lib) no longer says a lost press this way")
        XCTAssertEqual(WikiChatCopy.pressUnsent, "The press didn’t reach the server. Check the connection, then try again.")
        // See changes' title, its fold and the line over a write.
        XCTAssertTrue(source.contains("export const wikiSeeChangesTitle = (where: string): string => `${WIKI_CHAT_COPY.actions.see_changes} · ${where}`;"),
                      "\(Self.lib) no longer titles See changes with the section")
        XCTAssertEqual(WikiChatCopy.seeChangesTitle("3.1 §3"), "See changes · 3.1 §3")
        XCTAssertTrue(source.contains("export const wikiEarlierChanges = (n: number): string => `Earlier changes (${n})`;"),
                      "\(Self.lib) no longer folds the earlier versions this way")
        XCTAssertEqual(WikiChatCopy.earlierChanges(2), "Earlier changes (2)")
        XCTAssertTrue(source.contains("`${wikiDocVersionHeading(version.reason)} · ${wikiDocChanged(version.changed)}`"),
                      "\(Self.lib) no longer heads a write with its reason and its count")
        // The card face's own row labels, beside its kind's first field.
        XCTAssertTrue(source.contains("rows.push({ label: 'Why', value: view.rationale.trim() });"),
                      "\(Self.lib) no longer labels the agent's why")
        XCTAssertEqual(WikiChatCopy.faceWhy, "Why")
        XCTAssertTrue(source.contains("rows.push({ label: 'Summary', value: textOf(draft.summary)! });"),
                      "\(Self.lib) no longer labels a draft's summary")
        XCTAssertEqual(WikiChatCopy.faceSummary, "Summary")
    }

    /// The words the web lib's own test pins (`lib/wikiChat.test.ts`, "the words"), said here.
    func testTheWordsTheWebPins() {
        XCTAssertEqual(WikiChatCopy.fabIdle, "Chat")
        XCTAssertEqual(WikiChatCopy.newChat, "New chat")
        XCTAssertEqual(WikiChatCopy.runsIn, "Runs in")
        XCTAssertEqual(WikiChatCopy.ask, "Ask")
        XCTAssertEqual(WikiChatCopy.emptyHint, "Ask about this page, or say what should change.")
        XCTAssertEqual(WikiChatCopy.emptyNote, "Nothing in the wiki changes until you apply it.")
        XCTAssertEqual(WikiChatCopy.noWorktree, "Turn on worktrees for a workspace in this repository to chat here")
        XCTAssertEqual(WikiChatCopy.chooseWorkspace, "Choose where this space's chats run")
        XCTAssertEqual(WikiChatLogic.quoteCounts(sentences: 1, sources: 2), "1 sentence · 2 sources")
        XCTAssertEqual(WikiChatLogic.quoteCounts(sentences: 3, sources: 1), "3 sentences · 1 source")
        XCTAssertEqual(WikiChatLogic.quoteCounts(sentences: 2, sources: 0), "2 sentences")
        XCTAssertEqual(WikiChatLogic.runLine(["orbit-develop", "HPC", "Claude Opus 5.5", "Default"]),
                       "orbit-develop · HPC · Claude Opus 5.5 · Default")
        XCTAssertEqual(WikiChatLogic.runLine(["orbit-develop", nil, "", "Default"]), "orbit-develop · Default")
    }

    /// Each card button's word is the contract's `chat.copy.actions` under the action's own name, and each waiting
    /// reason's is `chat.copy.waiting` under the reason's.
    func testEveryButtonAndReasonHasItsWord() throws {
        let contract = try contractCopy()
        for action in WikiChatAction.allCases {
            XCTAssertEqual(WikiChatCopy.action(action), contract["actions.\(action.rawValue)"], action.rawValue)
        }
        for reason in WikiDocsFollowWaiting.allCases where reason != .unknown {
            XCTAssertEqual(WikiChatCopy.waitingReason(reason), contract["waiting.\(reason.rawValue)"], reason.rawValue)
        }
    }
}
