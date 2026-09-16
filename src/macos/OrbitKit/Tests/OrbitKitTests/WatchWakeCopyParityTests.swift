import Foundation
import XCTest
@testable import OrbitKit

/// The two clients say the same words about one watch, and this is the tripwire that keeps them
/// saying them.
///
/// `WatchWake.swift` is a hand-copy of the browser's reading of a wake (`lib/watches.ts`'s
/// `parseWatchWake`) and of the card it draws (`WatchWakeCard.tsx`), and the console's Watching strip
/// is a hand-copy of `WatchCard.tsx` and `WatchRelations.tsx`. The Swift client and the browser bundle
/// share no compiler, so a sentence reworded at one end simply never appears at the other — and the
/// one that matters most here is the reading itself: a head line the server reworded, or a marker
/// only one end knows, turns every wake back into a bubble that looks typed by the user. That was the
/// bug being fixed, so it is the one this check exists to stop coming back.
///
/// Shaped after `CriteriaDecisionCopyParityTests`, including the part that matters most: a missing
/// counterpart is a FAILURE and never an `XCTSkip`. A check that quietly opts out reports green on
/// exactly the day the thing it watches goes missing.
///
/// Deliberately NOT compared, and each for a reason the code gives:
///  - `WatchProjection.metWord`, the verb a LIVE card counts progress in. The browser always says
///    "met" there; this client says what the condition's own leaf says, and two of its session verbs
///    read differently on purpose. `WatchWakeCard.reasonWord` — the words a recorded Match is read
///    back in — IS compared, because that is the same sentence about the same string.
///  - `WatchProjection.condition`, which this client has said its own way since before the card
///    existed and which the Edit sheet's picker and the detail sheet both read.
///  - The changed-target line's middle: the browser prints an id because it has no name to print,
///    while this client names the target it holds. The sentence around it is compared.
final class WatchWakeCopyParityTests: XCTestCase {

    private static let webWatches = "src/web/src/lib/watches.ts"
    private static let webWakeCard = "src/web/src/components/WatchWakeCard.tsx"
    private static let webCard = "src/web/src/components/WatchCard.tsx"
    private static let webRelations = "src/web/src/components/WatchRelations.tsx"
    private static let webWorkspace = "src/web/src/components/WorkspaceView.tsx"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case missing(String)
        case notDeclared(what: String, file: String)

        var description: String {
            switch self {
            case .noRepo:
                return "\(WatchWakeCopyParityTests.webWatches) was not found above this test file. "
                    + "OrbitKit's watch card is one half of a pair; if the web half moved, move this "
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

    /// The repo root, found by walking up from this file until the web's watch reader is under foot.
    /// Not a fixed number of `..` hops: how deep this test file sits is not the thing being asserted.
    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.webWatches).path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        // Deliberately a failure and not an `XCTSkip`, for the reason in the type's note above.
        throw ParityError.noRepo
    }

    /// A web source with its string literals put back together.
    ///
    /// TypeScript wraps a long sentence as `'…' + '…'` across lines and lets a value sit on the line
    /// under its `=`; where those wraps fall is a formatting decision while the words are the
    /// contract. Both quote styles are joined, because a sentence with an apostrophe in it — "the
    /// watch won't send it again" — is written in double quotes at the other end.
    private func flat(_ relative: String) throws -> String {
        let url = try repoRoot().appendingPathComponent(relative)
        guard FileManager.default.fileExists(atPath: url.path) else { throw ParityError.missing(relative) }
        return try String(contentsOf: url, encoding: .utf8)
            .replacingOccurrences(of: "['\"`]\\s*\\+\\s*['\"`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "=\\s*\\n\\s*(['\"])", with: "= $1", options: .regularExpression)
    }

    /// The one capture of `pattern`, or a failure naming what went missing rather than a green run
    /// comparing this end against nothing.
    private func capture(_ source: String, _ pattern: String, _ what: String,
                         _ file: String) throws -> String {
        let re = try NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators])
        guard let match = re.firstMatch(in: source, range: NSRange(source.startIndex..., in: source)),
              match.numberOfRanges > 1, let range = Range(match.range(at: 1), in: source) else {
            throw ParityError.notDeclared(what: what, file: file)
        }
        return String(source[range])
    }

    /// A number the browser declares, as a number — the widths `formatSpan`'s buckets are built
    /// out of, so the expectations below can be derived from them rather than typed out again.
    private func number(_ source: String, _ pattern: String, _ what: String) throws -> Int {
        try XCTUnwrap(Int(try capture(source, pattern, what, Self.webWatches)))
    }

    /// Every capture of `pattern`, in source order.
    private func captures(_ source: String, _ pattern: String) throws -> [String] {
        let re = try NSRegularExpression(pattern: pattern)
        return re.matches(in: source, range: NSRange(source.startIndex..., in: source)).compactMap {
            guard $0.numberOfRanges > 1, let range = Range($0.range(at: 1), in: source) else { return nil }
            return String(source[range])
        }
    }

    /// The other end writes exactly these words, in any of the three quotes it writes strings in.
    /// Anchored on more than the sentence where there is a name to anchor on (`prefix`), because a
    /// check a comment can satisfy is not a check.
    private func assertWritten(_ source: String, prefix: String = "", _ value: String, _ what: String,
                               _ file: String, line: UInt = #line) {
        let written = ["'", "\"", "`"].contains { source.contains("\(prefix)\($0)\(value)\($0)") }
        XCTAssertTrue(written,
                      "\(what) drifted: \(file) no longer writes \(prefix.isEmpty ? "" : prefix)"
                          + "\(value.debugDescription)",
                      file: #filePath, line: line)
    }

    /// The other end renders exactly these words as an element's own text.
    ///
    /// Half the card's sentences are JSX text nodes rather than string literals — `<summary>What the
    /// agent received</summary>` — so there is neither a name nor a quote to anchor on. The anchor is
    /// the markup instead: the text has to sit between a tag's `>` and the next `<` or `{`, which a
    /// sentence quoted in a comment never does. A bare `contains` would let the file's own header
    /// prose satisfy the check, and a check a comment can satisfy is not a check.
    private func assertRendered(_ source: String, _ value: String, _ what: String, _ file: String,
                                line: UInt = #line) {
        let pattern = ">\\s*\(NSRegularExpression.escapedPattern(for: value))\\s*[<{]"
        let re = try? NSRegularExpression(pattern: pattern)
        let found = re?.firstMatch(in: source, range: NSRange(source.startIndex..., in: source)) != nil
        XCTAssertTrue(found,
                      "\(what) drifted: \(file) no longer renders \(value.debugDescription) as an "
                          + "element's own text",
                      file: #filePath, line: line)
    }

    // MARK: reading the turn a watch queued

    /// The grammar of the head line, character for character. This is the pair most expensive to get
    /// wrong: a pattern only the browser knows is a wake this client draws as the user's own message,
    /// UUID, payload and all — which is the screenshot this work started from.
    func testTheWakesGrammarIsTheSameOnBothEnds() throws {
        let web = try flat(Self.webWatches)
        let pattern = try capture(web, "const WAKE_HEAD =\\s*/(.+?)/;", "WAKE_HEAD", Self.webWatches)
        XCTAssertEqual(WatchWakeText.headPattern, pattern,
                       "the wake's head line drifted — first is WatchWakeText.headPattern (this "
                           + "client), second is WAKE_HEAD in \(Self.webWatches). A head only one end "
                           + "matches is a wake that end draws as a message somebody typed.")
        let mark = try capture(web, "const WAKE_MARK =\\s*'(.+?)';", "WAKE_MARK", Self.webWatches)
        XCTAssertEqual(WatchWakeText.mark, mark,
                       "the sentence saying a watch queued the turn drifted — it is the one part of "
                           + "a wake a person cannot accidentally reproduce, so both ends require it.")
    }

    /// The words a recorded Match is read back in — "2 of 2 done". The browser prints these for the
    /// same `reason` string, so a leaf reworded at one end is one wake reading two ways.
    func testAMatchsReasonIsReadInTheSameWords() throws {
        let web = try flat(Self.webWatches)
        for leaf in WatchLeaf.allCases where leaf != .unknown {
            let entry = try capture(web, "\(leaf.rawValue): \\{(.*?)\\}",
                                    "LEAF_COPY.\(leaf.rawValue)", Self.webWatches)
            let met = try capture(entry, "met: '(.*?)'", "LEAF_COPY.\(leaf.rawValue).met", Self.webWatches)
            XCTAssertEqual(WatchWakeCard.reasonWord(leaf), met,
                           "the word \(leaf.rawValue) is counted in drifted — first is "
                               + "WatchWakeCard.reasonWord, second is LEAF_COPY.\(leaf.rawValue).met.")
        }
    }

    // MARK: the card the reading becomes

    func testTheCardsTitlesAndEndsMatchTheWebCard() throws {
        let web = try flat(Self.webWakeCard)
        for kind in WatchWakeKind.allCases {
            assertWritten(web, prefix: "\(kind.rawValue): ", WatchWakeCard.title(kind),
                          "the title of a \(kind.rawValue) wake", Self.webWakeCard)
        }
        // The three ends' sentences: each is the only thing that says this session will not be woken
        // by that watch again.
        for kind in WatchWakeKind.allCases where kind != .matched {
            let wake = WatchWake(watchId: "w", kind: kind, generation: nil, reason: nil, changedTargets: [])
            assertWritten(web, prefix: "\(kind.rawValue): ", WatchWakeCard.why(wake),
                          "what a \(kind.rawValue) wake says happened", Self.webWakeCard)
        }
        let held = WatchWake(watchId: "w", kind: .matched, generation: 1, reason: nil, changedTargets: [])
        assertWritten(web, WatchWakeCard.why(held), "what a Match with no reason says", Self.webWakeCard)
    }

    func testTheCardsOwnLinesMatchTheWebCard() throws {
        let web = try flat(Self.webWakeCard)
        // The provenance line, which is why the card exists: nobody typed this.
        assertRendered(web, WatchWakeCard.meta(WatchWake(watchId: "w", kind: .matched, generation: nil,
                                                         reason: nil, changedTargets: [])),
                       "the line saying nobody typed the turn", Self.webWakeCard)
        assertRendered(web, WatchWakeCard.undelivered, "the undelivered line", Self.webWakeCard)
        assertRendered(web, WatchWakeCard.viewWatch, "the way to the watch", Self.webWakeCard)
        assertRendered(web, WatchWakeCard.rawSummary, "the fold the original text stays behind",
                       Self.webWakeCard)
        // How many targets are named before the card stops counting them out.
        let shown = try capture(web, "const SHOWN_CHANGES = (\\d+)", "SHOWN_CHANGES", Self.webWakeCard)
        XCTAssertEqual(String(WatchWakeCard.shownChanges), shown)
        // The generation seal, and the sentence a changed target ends in.
        XCTAssertTrue(web.contains("generation ${wake.generation}"), "the generation seal drifted")
        XCTAssertTrue(web.contains(" is now ${t.status}"), "what a changed target is now drifted")
    }

    // MARK: the span both the card's EXPIRES row and the strip count off

    /// How long is left, in units. This pair had already drifted: the browser said "3h 20m" and this
    /// client "3h" — one deadline read two ways, on the card's EXPIRES row, in `deadline(for:)` and
    /// on the strip above the composer, which are every place either client prints a span.
    ///
    /// Held to the browser's declaration rather than to a table of strings written out here: the
    /// bucket widths are read out of `formatSpan` and the expectations built from them, so a bucket
    /// widened at that end and not this one fails right here.
    func testASpanIsCountedOffInTheBrowsersUnits() throws {
        let web = try flat(Self.webWatches)
        let body = try capture(web, "export function formatSpan\\(.*?\\{(.*?)\\n\\}", "formatSpan",
                               Self.webWatches)

        // The units, then the order the buckets are tried in.
        for (unit, value) in [("SECOND", "1_000"), ("MINUTE", "60 * SECOND"),
                              ("HOUR", "60 * MINUTE"), ("DAY", "24 * HOUR")] {
            XCTAssertEqual(try capture(web, "const \(unit) = (.+?);", unit, Self.webWatches), value,
                           "the browser's \(unit) is no longer \(value.debugDescription), and this "
                               + "client still counts in it — every span it prints is now off by "
                               + "the difference.")
        }
        XCTAssertEqual(try captures(body, "abs < ([A-Z]+)"), ["MINUTE", "HOUR", "DAY"],
                       "formatSpan's buckets drifted: this client tries seconds, then minutes, then "
                           + "hours, then days, and nothing else.")
        // Each piece, built the browser's way — off the remainder, floored rather than rounded, and
        // never from a negative span.
        for piece in ["Math.max(0, ms)", "Math.floor(abs / SECOND)", "Math.floor(abs / MINUTE)",
                      "Math.floor(abs / HOUR)", "Math.floor((abs % HOUR) / MINUTE)",
                      "Math.floor(abs / DAY)", "Math.floor((abs % DAY) / HOUR)"] {
            XCTAssertTrue(body.contains(piece),
                          "formatSpan no longer computes \(piece.debugDescription), which this "
                              + "client does — the two now round one span to different numbers.")
        }

        // How wide the two compound buckets are, and the least a sub-minute span is ever called.
        let least = try number(body, "Math\\.max\\((\\d+), Math\\.floor\\(abs / SECOND\\)\\)\\}s",
                               "the floor under a span of under a minute")
        let hoursSayingMinutes = try number(
            body, "h < (\\d+) && m > 0 \\? `\\$\\{h\\}h \\$\\{m\\}m` : `\\$\\{h\\}h`",
            "how few hours still get their minutes said")
        let daysSayingHours = try number(
            body, "d < (\\d+) && h > 0 \\? `\\$\\{d\\}d \\$\\{h\\}h` : `\\$\\{d\\}d`",
            "how few days still get their hours said")

        let hour = 3_600, day = 86_400
        XCTAssertEqual(WatchProjection.duration(0), "\(least)s", "a deadline just reached is not 0s")
        XCTAssertEqual(WatchProjection.duration(40), "40s")
        XCTAssertEqual(WatchProjection.duration(12 * 60), "12m")
        XCTAssertEqual(WatchProjection.duration(TimeInterval(hour - 1)), "59m")
        // Inside each compound bucket the smaller unit is said; at its edge it is dropped.
        XCTAssertEqual(WatchProjection.duration(TimeInterval((hoursSayingMinutes - 1) * hour + 20 * 60)),
                       "\(hoursSayingMinutes - 1)h 20m")
        XCTAssertEqual(WatchProjection.duration(TimeInterval(hoursSayingMinutes * hour + 20 * 60)),
                       "\(hoursSayingMinutes)h")
        XCTAssertEqual(WatchProjection.duration(TimeInterval((daysSayingHours - 1) * day + 4 * hour)),
                       "\(daysSayingHours - 1)d 4h")
        XCTAssertEqual(WatchProjection.duration(TimeInterval(daysSayingHours * day + 4 * hour)),
                       "\(daysSayingHours)d")
    }

    // MARK: the strip above the composer

    /// The card's labelled rows. This client had none of them — one headline and one line of
    /// condition — and the two it was missing entirely (what happens when the condition holds, and
    /// when the watch runs out) are exactly what a person above a composer is deciding about.
    func testTheCardsRowLabelsAreTheBrowsersRowLabels() throws {
        let labels = try captures(try flat(Self.webCard), "<dt>(.*?)</dt>")
        guard !labels.isEmpty else {
            throw ParityError.notDeclared(what: "any <dt> label", file: Self.webCard)
        }
        let mine = [WatchRowLabel.watching, WatchRowLabel.progress, WatchRowLabel.updated,
                    WatchRowLabel.then, WatchRowLabel.expires]
        var last = -1
        for label in mine {
            // Written bare, or as one arm of the live/ended ternary the browser picks it with.
            guard let at = labels.firstIndex(where: { $0 == label || $0.contains("'\(label)'") }) else {
                return XCTFail("the \(label) row drifted: \(Self.webCard) no longer labels a row "
                                   + "\(label.debugDescription). Rows this client draws and the "
                                   + "browser doesn't are rows one set of readers can't ask about.")
            }
            XCTAssertGreaterThan(at, last, "the \(label) row moved: the two cards read top to bottom "
                                     + "in different orders, which is the same card twice only to "
                                     + "somebody who never sees both.")
            last = at
        }
        let shown = try capture(try flat(Self.webCard), "const SHOWN_TARGETS = (\\d+)",
                                "SHOWN_TARGETS", Self.webCard)
        XCTAssertEqual(String(WatchProjection.shownTargets), shown)
    }

    /// The line the strip always opens as: the fixed "Watching" title, then what the wait is for —
    /// the one target a lone watch over one names, the threshold a lone watch over several asks
    /// for, or the distinct targets several watches cover — and how far it has got beside the
    /// soonest deadline, "earliest" only when the line speaks for more than one watch.
    func testTheStripsOneLineMatchesTheBrowsers() throws {
        let web = try flat(Self.webRelations)
        // The title is a constant, not a state word: "Watching" alone, with the target beside it.
        XCTAssertTrue(web.contains("className=\"watch-strip-title\">{STRIP_LABEL}"),
                      "the strip's title drifted: \(Self.webRelations) no longer renders it from "
                          + "STRIP_LABEL — first is WatchProjection.stripLabel.")
        // The deadline: "earliest" before it only when the line speaks for several watches. Which
        // watch count the prefix turns on is the point — one watch has exactly one deadline,
        // whatever its middle says, so qualifying it would name a soonest that doesn't exist.
        XCTAssertTrue(web.contains("{waitingOn.length === 1 ? '' : STRIP_EARLIEST}"),
                      "the count line stopped prefixing the soonest deadline with STRIP_EARLIEST, "
                          + "which this client does through WatchProjection.stripEarliest — or it "
                          + "went back to qualifying a lone watch's own single deadline.")
        // The middle: a lone watch's own threshold, or the targets several watches cover.
        XCTAssertTrue(web.contains("thresholdOf(waitingOn[0].predicate, live)"),
                      "the strip's middle stopped reading the lone watch's own threshold — the "
                          + "condition's count, not the target set's, is what the line states.")
        XCTAssertTrue(web.contains("targetNoun(waitingOn, targetCount)"),
                      "how several watches are counted drifted: \(Self.webRelations) no longer "
                          + "counts the distinct targets in the same noun the cards use.")
        // Which shape the line takes: one watch over one live target names it, anything else counts.
        let lone = try XCTUnwrap(WatchSessionSummary(sessionID: "S1", watches: [
            WatchFixture.watch(id: "W1", targets: [WatchFixture.target("T1")]),
        ]))
        XCTAssertNotNil(lone.lineTarget, "a lone watch over one live target names it")
        // One watch over four, and its condition asks for one of them: "4 targets" is what the
        // watch covers, "any 1 of 4 tasks" is what it is waiting for.
        let waitOne = try XCTUnwrap(WatchSessionSummary(sessionID: "S1", watches: [
            WatchFixture.watch(id: "W1", predicate: WatchFixture.any("TASK_TERMINAL"),
                               targets: WatchFixture.tasks(4)),
        ]))
        XCTAssertNil(waitOne.lineTarget, "four targets are counted, not named")
        XCTAssertEqual(waitOne.lineTargetWord, "any 1 of 4 tasks")
        // The same watch asking for all four, and how far it has got: two of them met.
        let waitAll = try XCTUnwrap(WatchSessionSummary(sessionID: "S1", watches: [
            WatchFixture.watch(id: "W1", targets: WatchFixture.tasks(4, met: 2)),
        ]))
        XCTAssertEqual(waitAll.lineTargetWord, "all 4 tasks")
        XCTAssertEqual(waitAll.lineTime(now: WatchFixture.now), "2 met · 1h left")
        // The one condition the two ends say different things about, and why: the browser reads
        // predicateVersion 2, so it states the quorum's own count — "2 of 4 tasks" — while this
        // client reads grammar 1, where a quorum is a term it does not know, and counts the targets
        // instead. Both halves are asserted — the browser's branch here, this client's own word in
        // `SessionWatchingTests` — so neither drifts, and the difference stays the grammar each
        // client reads rather than becoming a copy that happens to agree.
        let webLib = try flat(Self.webWatches)
        XCTAssertTrue(webLib.contains("if (p.kind === 'AT_LEAST') return { needed: Math.min(p.count, of), of };"),
                      "the browser stopped stating an AT_LEAST's own count: \(Self.webWatches) no "
                          + "longer reads the quorum through `thresholdOf`. This client's v1 line "
                          + "still counts the targets instead of naming a requirement it can't read.")
        let quorum = try XCTUnwrap(WatchSessionSummary(sessionID: "S1", watches: [
            WatchFixture.watch(id: "W1", predicate: ["kind": "AT_LEAST", "count": 2,
                                                     "over": "ALL_TARGETS", "leaf": "TASK_TERMINAL"],
                               targets: WatchFixture.tasks(4), predicateVersion: 2),
        ]))
        XCTAssertEqual(quorum.lineTargetWord, "4 tasks", "a condition this client can't read states no threshold")
        let several = try XCTUnwrap(WatchSessionSummary(sessionID: "S1", watches: [
            WatchFixture.watch(id: "W1", targets: [WatchFixture.target("T1"), WatchFixture.target("T2")]),
            WatchFixture.watch(id: "W2", targets: [WatchFixture.target("T2")]),
        ]))
        XCTAssertNil(several.lineTarget)
        XCTAssertEqual(several.lineTargetCount, 2, "T1 and T2, not T1, T2 and T2 again")
        XCTAssertEqual(several.lineTargetWord, "2 tasks")
        // Several watches: the soonest deadline is the only one with a qualifier to earn.
        XCTAssertEqual(several.lineTime(now: WatchFixture.now), "earliest 0 met · 1h left")
    }

    // MARK: the wake that is still queued

    /// Withdrawing a wake is not Cancel, and both ends have to say so in the same words: this is the
    /// one action on either client that destroys something no one can send again.
    func testWithdrawingAQueuedWakeSaysTheSameThingOnBothEnds() throws {
        let web = try flat(Self.webWorkspace)
        assertWritten(web, prefix: "const WAKE_WITHDRAW_CONSEQUENCE = ", WatchWakeQueue.consequence,
                      "what withdrawing a wake costs", Self.webWorkspace)
        assertWritten(web, WatchWakeQueue.status, "the queued wake's status line", Self.webWorkspace)
        assertWritten(web, WatchWakeQueue.withdraw, "the withdraw action", Self.webWorkspace)
        assertWritten(web, WatchWakeQueue.confirmTitle, "what the confirmation asks", Self.webWorkspace)
        assertWritten(web, WatchWakeQueue.keep, "the way out of the confirmation", Self.webWorkspace)
    }
}
