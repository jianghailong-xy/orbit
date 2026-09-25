import Foundation
import XCTest
@testable import OrbitKit

/// The two clients say the same words about an Orbit link card, and this is the tripwire that keeps
/// them doing it.
///
/// `OrbitLinkCard.swift` draws one card in four contents; the browser draws the same four in
/// `components/OrbitLinkCard.tsx`, and every sentence it can say is an exported constant there for
/// exactly this reason. The two share no compiler, so a sentence reworded at one end would simply
/// never appear at the other — and a card is where that costs most: the same task described in two
/// vocabularies, one line apart, in the same conversation.
///
/// What the fixture pair (`OrbitLinkTests` here, `lib/orbitLink.test.ts` on the web) keeps to each
/// other is *which* links become cards and where a card stands. This file is about what the card
/// says once it is there.
///
/// Shaped after `TaskStartCopyParityTests`, including the part that matters most: a missing
/// counterpart is a FAILURE and never an `XCTSkip`. A check that quietly opts out reports green on
/// exactly the day the thing it watches goes missing.
final class OrbitLinkCopyParityTests: XCTestCase {

    private static let webCard = "src/web/src/components/OrbitLinkCard.tsx"
    private static let webProjectPage = "src/web/src/components/ProjectPanoramaHeader.tsx"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case missing(String)
        case notDeclared(what: String, file: String)

        var description: String {
            switch self {
            case .noRepo:
                return "\(OrbitLinkCopyParityTests.webCard) was not found above this test file. "
                    + "OrbitKit's link card is one half of a pair; if the web half moved, move this "
                    + "check with it rather than deleting it."
            case .missing(let path):
                return "\(path) was not found. Either it moved — then point this check at its new "
                    + "home — or it is gone, and this client is now mirroring something that no "
                    + "longer exists."
            case .notDeclared(let what, let file):
                return "\(what) was not found in \(file). Either it was renamed — then rename it "
                    + "here too, which is what this check is for — or it is gone."
            }
        }
    }

    /// The repo root, found by walking up from this file until the web's card is under foot. Not a
    /// fixed number of `..` hops: how deep this file sits is not the thing being asserted.
    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.webCard).path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        // Deliberately a failure and not an `XCTSkip`, for the reason in the type's note above.
        throw ParityError.noRepo
    }

    private func read(_ relative: String) throws -> String {
        let url = try repoRoot().appendingPathComponent(relative)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw ParityError.missing(relative)
        }
        return try String(contentsOf: url, encoding: .utf8)
    }

    /// A web source with its string literals put back together — where TypeScript wraps a sentence
    /// is a formatting decision, the words are the contract.
    private func flat(_ relative: String) throws -> String {
        try read(relative)
            .replacingOccurrences(of: "['\"`]\\s*\\+\\s*['\"`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "=\\s*\\n\\s*(['\"`/])", with: "= $1", options: .regularExpression)
    }

    /// From one marker to the next occurrence of another, so a match elsewhere in the file cannot
    /// answer for the stretch being asserted about.
    private func section(_ source: String, from: String, to: String, _ file: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw ParityError.notDeclared(what: "\(from) … \(to)", file: file)
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    /// Every capture of `pattern`, in source order.
    private func captures(_ source: String, _ pattern: String) throws -> [String] {
        let re = try NSRegularExpression(pattern: pattern)
        return re.matches(in: source, range: NSRange(source.startIndex..., in: source)).compactMap {
            guard $0.numberOfRanges > 1, let range = Range($0.range(at: 1), in: source) else { return nil }
            return String(source[range])
        }
    }

    /// A named constant, anchored on its declaration — not on the sentence, which a comment alone
    /// could satisfy.
    private func assertDeclares(_ source: String, _ name: String, _ value: String,
                                line: UInt = #line) {
        let quoted = "'\(value.replacingOccurrences(of: "'", with: "\\'"))'"
        XCTAssertTrue(source.contains("\(name) = \(quoted)"),
                      "\(name) drifted: the web no longer declares it as \(quoted)",
                      file: #filePath, line: line)
    }

    /// A sentence the web builds around a value of its own. Anchored on the whole expression, so a
    /// reworded literal or a reordered part reds here.
    private func assertBuilds(_ source: String, _ expression: String, _ what: String,
                              line: UInt = #line) {
        XCTAssertTrue(source.contains(expression),
                      "\(what) drifted: the web no longer builds \(expression.debugDescription)",
                      file: #filePath, line: line)
    }

    // MARK: the words

    /// Every sentence the two ends compare, in one table — the same shape `OrbitLinkCopy` is
    /// declared in, so a constant added at either end without its counterpart is one line short
    /// here.
    func testTheWordsAreTheWebsWords() throws {
        let web = try flat(Self.webCard)
        let pairs: [(String, String)] = [
            ("ORBIT_LINK_NOT_AVAILABLE", OrbitLinkCopy.notAvailable),
            ("ORBIT_LINK_UNAVAILABLE_REASON", OrbitLinkCopy.unavailableReason),
            ("ORBIT_LINK_SEPARATOR", OrbitLinkCopy.separator),
            ("ORBIT_LINK_UNASSIGNED", OrbitLinkCopy.unassigned),
            ("ORBIT_LINK_NEVER_RUN", OrbitLinkCopy.neverRun),
            ("ORBIT_LINK_COORDINATOR", OrbitLinkCopy.coordinator),
            ("ORBIT_LINK_DONE_LABEL", OrbitLinkCopy.doneLabel),
            ("ORBIT_LINK_OPEN_LABEL", OrbitLinkCopy.openLabel),
            ("ORBIT_LINK_RUNNING_LABEL", OrbitLinkCopy.runningLabel),
            ("ORBIT_LINK_QUEUED_LABEL", OrbitLinkCopy.queuedLabel),
            ("ORBIT_LINK_FAILED_LABEL", OrbitLinkCopy.failedLabel),
        ]
        for (name, word) in pairs {
            assertDeclares(web, name, word)
        }
        // The two states a card can be in with nothing to show, said outright.
        XCTAssertEqual(OrbitLinkCopy.notAvailable, "Not available")
        XCTAssertEqual(OrbitLinkCopy.unavailableReason, "Deleted, or not in this account.")
    }

    /// The name a card puts on its first row, per kind. A kind renamed at one end would name the
    /// same object two things.
    func testTheTypeNamesAreTheWebsTypeNames() throws {
        let web = try flat(Self.webCard)
        let declared = try section(web, from: "export const ORBIT_LINK_TYPE_NAMES", to: "\n};",
                                   Self.webCard)
        let theirs = try captures(declared, "\\w+: '([^']*)'")
        let mine = [OrbitLinkKind.task, .session, .project, .list, .wiki].map(OrbitLinkCopy.typeName)
        XCTAssertEqual(theirs, mine,
                       "the type names drifted — first is the web's, second is this client's, and "
                           + "both are read in the same order")
    }

    /// A wiki card's words: the kind beside the type ("Wiki · Principle"), the line an entry with no
    /// anchor says, and the one a retired or superseded entry says — each the browser's own, and the
    /// kind's word the Wiki pages' (`WIKI_KIND_LABELS`), so a card and the page it leads to cannot
    /// name one kind two ways.
    func testTheWikiCardsWordsAreTheWebsWords() throws {
        let web = try flat(Self.webCard)
        assertDeclares(web, "ORBIT_LINK_NO_ANCHOR", OrbitLinkCopy.noAnchor)
        XCTAssertEqual(OrbitLinkCopy.typeName(.wiki, wikiKind: .principle), "Wiki · Principle")
        XCTAssertEqual(OrbitLinkCopy.typeName(.wiki, wikiKind: nil), "Wiki")
        XCTAssertEqual(OrbitLinkCopy.typeName(.task, wikiKind: .pitfall), "Task",
                       "only a wiki card carries an entry's kind")
        assertBuilds(web, "return entry === '' ? ORBIT_LINK_TYPE_NAMES.wiki : "
                     + "`${ORBIT_LINK_TYPE_NAMES.wiki}${ORBIT_LINK_SEPARATOR}${entry}`;",
                     "the wiki card's first row")
        assertBuilds(web, "lines.push({ text: WIKI_NO_LONGER_PUSHED, glyph: <WarningOutlined />, isWarning: true });",
                     "the line a card for an entry agents no longer get says")
        assertBuilds(web, "if (entry.status !== 'active')", "when that line is drawn")
        assertBuilds(web, "text: anchorLabel ?? ORBIT_LINK_NO_ANCHOR,", "the anchor line")
    }

    // MARK: the sentences built around values

    /// `Done 7 / 8 · Open 1 · Failed 1` — the tasks page's line, the same parts in the same order
    /// and left out at the same counts. macOS says it through `progressLine`, the browser through
    /// `orbitLinkProgressLine`, and a reader comparing the two cards would see the difference.
    func testTheProgressLineIsCountedTheSameWay() throws {
        let web = try flat(Self.webCard)
        XCTAssertEqual(OrbitLinkCopy.progressLine(done: 7, total: 8, open: 1), "Done 7 / 8 · Open 1")
        XCTAssertEqual(OrbitLinkCopy.progressLine(done: 117, total: 27_468, open: 27_350, failed: 1),
                       "Done 117 / 27,468 · Open 27,350 · Failed 1")
        assertBuilds(web,
                     "`${ORBIT_LINK_DONE_LABEL} ${orbitLinkNumber(counts.done)} / "
                     + "${orbitLinkNumber(counts.total)}`",
                     "the Done part of the progress line")
        assertBuilds(web, "`${ORBIT_LINK_OPEN_LABEL} ${orbitLinkNumber(counts.open)}`",
                     "the Open part of the progress line")
        assertBuilds(web, "parts.join(ORBIT_LINK_SEPARATOR)", "what parts the progress line")
        // A count nobody has is not drawn — the same three guards, for the same reason.
        assertBuilds(web, "if (counts.running) parts.push(`${ORBIT_LINK_RUNNING_LABEL} "
                     + "${orbitLinkNumber(counts.running)}`)", "the Running part")
        assertBuilds(web, "if (counts.queued) parts.push(`${ORBIT_LINK_QUEUED_LABEL} "
                     + "${orbitLinkNumber(counts.queued)}`)", "the Queued part")
        assertBuilds(web, "if (counts.failed) parts.push(`${ORBIT_LINK_FAILED_LABEL} "
                     + "${orbitLinkNumber(counts.failed)}`)", "the Failed part")
        // Thousands are grouped the one way both ends group them: this client writes the separator
        // itself rather than trusting a host locale, and the browser asks for `en-US` by name.
        XCTAssertEqual(OrbitLinkCopy.number(27_468), "27,468")
        assertBuilds(web, "value.toLocaleString('en-US')", "what groups a count")
    }

    /// The stalled line is the project page's own sentence, word for word, on both ends — and the
    /// web card says the same sentence its project page does.
    func testTheStalledLineIsTheProjectsOwnSentence() throws {
        let web = try flat(Self.webCard)
        XCTAssertEqual(OrbitLinkCopy.stalled(ready: 1), "1 task is ready, but nothing is running.")
        XCTAssertEqual(OrbitLinkCopy.stalled(ready: 3), "3 tasks are ready, but nothing is running.")
        assertBuilds(web, "`${orbitLinkNumber(ready)} ${noun} ready, but nothing is running.`",
                     "the stalled sentence")
        assertBuilds(web, "const noun = ready === 1 ? 'task is' : 'tasks are';",
                     "the number in the stalled sentence")
        // The page the sentence came from still says it.
        let page = try flat(Self.webProjectPage)
        XCTAssertTrue(page.contains("ready, but nothing is running."),
                      "\(Self.webProjectPage) no longer carries the sentence the card copies")
    }

    /// A task's runs, its turns, and how its newest run came out — the three counts a task card
    /// shares with the native one.
    func testTheRunsTurnsAndLastRunAreTheWebsWords() throws {
        let web = try flat(Self.webCard)
        XCTAssertEqual(OrbitLinkCopy.runs(0), "never run")
        XCTAssertEqual(OrbitLinkCopy.runs(1), "1 run")
        XCTAssertEqual(OrbitLinkCopy.runs(2), "2 runs")
        assertBuilds(web, "if (count === 0) return ORBIT_LINK_NEVER_RUN;", "a task nothing has run")
        assertBuilds(web, "count === 1 ? '1 run' : `${orbitLinkNumber(count)} runs`",
                     "how runs are counted")

        XCTAssertEqual(OrbitLinkCopy.turns(1), "1 turn")
        XCTAssertEqual(OrbitLinkCopy.turns(240), "240 turns")
        assertBuilds(web, "count === 1 ? '1 turn' : `${orbitLinkNumber(count)} turns`",
                     "how turns are counted")

        XCTAssertEqual(OrbitLinkCopy.lastRun("Succeeded", turns: 93), "last Succeeded, 93 turns")
        XCTAssertEqual(OrbitLinkCopy.lastRun("Failed", turns: 0), "last Failed")
        assertBuilds(web, "turns > 0 ? `last ${word}, ${orbitLinkTurns(turns)}` : `last ${word}`",
                     "how a task's newest run is said")
    }

    /// The words a card does NOT write: a session's status is the page's own, handed to the card
    /// rather than invented in it. Both ends ask; neither spells out a status vocabulary of its own.
    func testTheSessionWordComesFromThePageOnBothEnds() throws {
        let web = try flat(Self.webCard)
        assertBuilds(web, "stateWord(session)", "the session's state word, asked for by the card")
        assertBuilds(web, "stateWord(task.lastRun)", "a task's last run, in the same vocabulary")
        XCTAssertEqual(OrbitLinkCopy.coordinator, "Coordinator")
        assertBuilds(web, "session.projectId ? ORBIT_LINK_COORDINATOR : undefined",
                     "the badge a coordinating session wears")
    }
}
