import Foundation
import XCTest
@testable import OrbitKit

/// The console's Watching strip is a hand-copy of the browser's (`lib/watches.ts`'s `STRIP_*`
/// constants, drawn by `WatchRelations.tsx`'s `SessionWatchStrip`), and the Stop warning the strip
/// sends people to the detail page for is a hand-copy of `WatchCard.tsx`'s. The two clients share no
/// compiler, so a sentence reworded at one end simply never appears at the other — and the strip is
/// the one place both say the same thing above a composer, so a drift is one session reading two
/// different things about the same wait.
///
/// Shaped after `WatchWakeCopyParityTests`, including the part that matters most: a missing
/// counterpart is a FAILURE and never an `XCTSkip`. A check that quietly opts out reports green on
/// exactly the day the thing it watches goes missing.
final class WatchStripCopyParityTests: XCTestCase {

    private static let webWatches = "src/web/src/lib/watches.ts"
    private static let webRelations = "src/web/src/components/WatchRelations.tsx"
    private static let webCard = "src/web/src/components/WatchCard.tsx"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case missing(String)
        case notDeclared(what: String, file: String)

        var description: String {
            switch self {
            case .noRepo:
                return "\(WatchStripCopyParityTests.webWatches) was not found above this test file. "
                    + "OrbitKit's Watching strip is one half of a pair; if the web half moved, move "
                    + "this check with it rather than deleting it."
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
    /// waiting session won't be resumed" — is written in double quotes at the other end.
    private func flat(_ relative: String) throws -> String {
        let url = try repoRoot().appendingPathComponent(relative)
        guard FileManager.default.fileExists(atPath: url.path) else { throw ParityError.missing(relative) }
        return try String(contentsOf: url, encoding: .utf8)
            .replacingOccurrences(of: "['\"`]\\s*\\+\\s*['\"`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "=\\s*\\n\\s*(['\"])", with: "= $1", options: .regularExpression)
    }

    /// The one capture of `pattern`, or a failure naming what went missing rather than a green run
    /// comparing this end against nothing. `group` is for patterns whose group 1 is not the value —
    /// e.g. a backreferenced opening quote.
    private func capture(_ source: String, _ pattern: String, _ what: String,
                         _ file: String, group: Int = 1) throws -> String {
        let re = try NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators])
        guard let match = re.firstMatch(in: source, range: NSRange(source.startIndex..., in: source)),
              match.numberOfRanges > group, let range = Range(match.range(at: group), in: source) else {
            throw ParityError.notDeclared(what: what, file: file)
        }
        return String(source[range])
    }

    /// Every capture of `pattern`, in source order.
    private func captures(_ source: String, _ pattern: String) throws -> [String] {
        let re = try NSRegularExpression(pattern: pattern)
        return re.matches(in: source, range: NSRange(source.startIndex..., in: source)).compactMap {
            guard $0.numberOfRanges > 1, let range = Range($0.range(at: 1), in: source) else { return nil }
            return String(source[range])
        }
    }

    /// The strip's own words, declaration for declaration: the fixed title, the ways out, and the
    /// words the opened sentences are built from. Both ends compute the line from the same two
    /// shapes — `WatchSessionSummary.lineTarget` and the web's `single` — and
    /// `WatchWakeCopyParityTests` holds those together; this holds the words the strip is made of,
    /// and the fixture tests below hold the sentences built from them.
    func testTheStripsWordsAreTheBrowsersDeclarations() throws {
        let lib = try flat(Self.webWatches)
        let pairs: [(what: String, declaration: String, mine: String)] = [
            ("the strip's title", "STRIP_LABEL", WatchProjection.stripLabel),
            ("the way to the Following page", "STRIP_MANAGE", WatchProjection.stripManage),
            ("the way to a lone task", "STRIP_OPEN_TASK", WatchProjection.stripOpenTask),
            ("the way to a lone session", "STRIP_OPEN_SESSION", WatchProjection.stripOpenSession),
            ("the sentence's opening", "STRIP_RESUMES", WatchProjection.stripResumes),
            ("a paused watch's opening", "STRIP_PAUSED", WatchProjection.stripPaused),
            ("a condition neither end reads", "STRIP_UNREAD", WatchProjection.stripUnread),
            ("the unchecked line's opening", "STRIP_NOT_CHECKED", WatchProjection.stripNotChecked),
            ("the unchecked line's reason", "STRIP_MAY_BE_LATE", WatchProjection.stripMayBeLate),
        ]
        for pair in pairs {
            let web = try capture(lib, "const \(pair.declaration) = '(.+?)';", pair.what, Self.webWatches)
            XCTAssertEqual(pair.mine, web,
                           "\(pair.what) drifted — first is this client's, second is "
                               + "\(pair.declaration) in \(Self.webWatches).")
        }
    }

    /// The sentence borrows each leaf's verbs from the browser's `LEAF_COPY` — the words its cards
    /// and editor say a condition in — so the strip reads a leaf the way the rest of the page does.
    func testTheSentencesVerbsAreTheBrowsersLeafCopy() throws {
        let lib = try flat(Self.webWatches)
        for leaf in WatchLeaf.allCases where leaf != .unknown {
            let entry = try capture(lib, "\\n  \(leaf.rawValue): \\{(.+?)\\n  \\},", "LEAF_COPY.\(leaf.rawValue)",
                                    Self.webWatches)
            let one = try capture(entry, "one: '(.+?)',", "LEAF_COPY.\(leaf.rawValue).one", Self.webWatches)
            let many = try capture(entry, "many: '(.+?)',", "LEAF_COPY.\(leaf.rawValue).many", Self.webWatches)
            XCTAssertEqual(WatchProjection.stripVerb(leaf, many: false), one, "\(leaf.rawValue), of one target")
            XCTAssertEqual(WatchProjection.stripVerb(leaf, many: true), many, "\(leaf.rawValue), of several")
        }
    }

    // MARK: the sentences both ends are proved against

    private static let fixturePath = "src/shared/src/watch-strip.fixture.json"

    private struct Fixture: Decodable {
        struct Sentence: Decodable {
            let `case`: String
            let state: String
            let predicate: AnyJSON
            let targets: [String]
            let expiresAt: String
            let sentence: String
        }
        struct Stale: Decodable {
            let `case`: String
            let state: String
            let lastEvaluatedAt: String?
            let createdAt: String
            let line: String?
        }
        struct Count: Decodable {
            struct Target: Decodable {
                let kind: String
                let status: WatchTargetStatus?
            }
            let `case`: String
            let targets: [Target]
            let line: String
        }
        let now: String
        let sentences: [Sentence]
        let stale: [Stale]
        let counts: [Count]
        let sessionWords: [String: String]
    }

    /// Any JSON value, kept as the Foundation object the watch fixture is built from.
    private struct AnyJSON: Decodable {
        let value: Any
        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let object = try? c.decode([String: AnyJSON].self) {
                value = object.mapValues(\.value)
            } else if let array = try? c.decode([AnyJSON].self) {
                value = array.map(\.value)
            } else if let string = try? c.decode(String.self) {
                value = string
            } else if let number = try? c.decode(Int.self) {
                value = number
            } else {
                value = NSNull()
            }
        }
    }

    private func fixture() throws -> Fixture {
        let url = try repoRoot().appendingPathComponent(Self.fixturePath)
        guard FileManager.default.fileExists(atPath: url.path) else { throw ParityError.missing(Self.fixturePath) }
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    private func date(_ iso: String) throws -> Date {
        try XCTUnwrap(RelativeTime.parse(iso), iso)
    }

    func testEachWatchsSentenceIsTheFixtures() throws {
        let f = try fixture()
        let now = try date(f.now)
        XCTAssertGreaterThan(f.sentences.count, 10)
        for c in f.sentences {
            let targets: [[String: Any]] = c.targets.enumerated().map { index, spec in
                let parts = spec.split(separator: ":").map(String.init)
                return WatchFixture.target("T\(index)", kind: parts[0], state: parts.count > 1 ? parts[1] : "OBSERVED")
            }
            let predicate = try XCTUnwrap(c.predicate.value as? [String: Any], c.case)
            let watch = WatchFixture.watch(state: c.state, predicate: predicate, targets: targets, expiresAt: c.expiresAt)
            XCTAssertEqual(WatchProjection.stripSentence(for: watch, now: now), c.sentence, c.case)
        }
    }

    func testTheUncheckedLineIsTheFixtures() throws {
        let f = try fixture()
        let now = try date(f.now)
        for c in f.stale {
            let watch = WatchFixture.watch(state: c.state, lastEvaluatedAt: c.lastEvaluatedAt, createdAt: c.createdAt)
            XCTAssertEqual(WatchProjection.stripStaleLine(for: watch, now: now), c.line, c.case)
        }
    }

    func testTheLinesSentenceOverSeveralTargetsIsTheFixtures() throws {
        let f = try fixture()
        for c in f.counts {
            let targets: [[String: Any]] = c.targets.enumerated().map { index, target in
                var object = WatchFixture.target("T\(index)", kind: target.kind)
                if let status = target.status {
                    object["targetStatus"] = ["status": status.status, "running": status.running, "queued": status.queued]
                }
                return object
            }
            // One watch over them all, so the line counts every one of them.
            let summary = try XCTUnwrap(WatchSessionSummary(sessionID: "S1",
                                                            watches: [WatchFixture.watch(targets: targets)]))
            XCTAssertEqual(summary.lineParts.map(\.text).joined(separator: SessionCreatedTasksCopy.separator),
                           c.line, c.case)
        }
    }

    func testASessionTargetsWordIsItsHeadersGlyphs() throws {
        let f = try fixture()
        let states: [SessionRunState] = [.queued, .running, .awaitingInput, .interrupted, .succeeded, .failed, .ended]
        XCTAssertEqual(Set(f.sessionWords.keys), Set(states.map(\.rawValue)),
                       "every run state a session can be in has a word, and no other")
        for (state, word) in f.sessionWords {
            let target = WatchFixture.watch(targets: [{
                var object = WatchFixture.target("S0", kind: "SESSION")
                object["targetStatus"] = ["status": state, "running": false, "queued": false]
                return object
            }()]).targets[0]
            XCTAssertEqual(WatchProjection.stripGlyph(target)?.label, word, state)
        }
    }

    /// What Stop costs, said before it happens, on both ends' detail views. CANCELLED is the one end
    /// nobody is told about (contract §3), so the warning names the consequence the person would
    /// otherwise assume — the web's `WatchControls` and this client's detail toolbar read the same
    /// two sentences.
    func testWhatStopCostsIsSaidInTheBrowsersWords() throws {
        let card = try flat(Self.webCard)
        let pairs: [(declaration: String, watch: Watch)] = [
            ("STOP_WARNING_RESUME", WatchFixture.watch(action: "RESUME_SESSION")),
            ("STOP_WARNING_NOTIFY", WatchFixture.watch(action: "NOTIFY_USER")),
        ]
        for pair in pairs {
            // A backreference to the opening quote: these sentences contain apostrophes, and a
            // character class would stop at the one inside "won't".
            let web = try capture(card, "const \(pair.declaration) = ([\"'])(.+?)\\1;",
                                  pair.declaration, Self.webCard, group: 2)
            XCTAssertEqual(WatchProjection.stopWarning(for: pair.watch), web,
                           "the warning for a \(pair.watch.action.rawValue) watch drifted — first "
                               + "is WatchProjection.stopWarning, second is \(pair.declaration) in "
                               + "\(Self.webCard).")
        }
    }

    /// The word the console header says over a session a watch will bring back — the strip's own
    /// heading, counted out over what is being watched.
    ///
    /// This is the drift that made the pair worth extending: this client has read such a session as
    /// Watching since `SessionHeader.statusWord`, while the browser went on saying "Waiting for your
    /// reply" over the same session, because nothing compared the two ends' headers. Its words are
    /// `WATCHING_WORDS` in the browser; this end builds them in `WatchSessionSummary.word`, so what
    /// is compared here is what this client actually says and not a second copy of the literals.
    func testTheHeaderWordForASessionParkedOnAWatchIsTheBrowsersWord() throws {
        let lib = try flat(Self.webWatches)
        let one = try capture(lib, "target: '(.+?)',", "the header's word for one target", Self.webWatches)
        let many = try capture(lib, "targets: '(.+?)',", "the header's word for several targets", Self.webWatches)
        let paused = try capture(lib, "paused: '(.+?)',", "the header's word for a paused wait", Self.webWatches)
        let pausedMany = try capture(lib, "pausedMany: '(.+?)',", "the header's words for several paused waits",
                                     Self.webWatches)

        XCTAssertEqual(WatchProjection.watchingLabel(targets: 1), "\(WatchProjection.stripLabel) 1 \(one)",
                       "the word over a session watching one target drifted from \(Self.webWatches).")
        XCTAssertEqual(WatchProjection.watchingLabel(targets: 7), "\(WatchProjection.stripLabel) 7 \(many)",
                       "the word over a session watching several targets drifted from \(Self.webWatches).")

        let onePaused = try XCTUnwrap(WatchSessionSummary(
            sessionID: "S1", watches: [WatchFixture.watch(id: "W1", state: "PAUSED")]))
        XCTAssertEqual(onePaused.word, paused, "the word over a session whose one watch is paused drifted.")
        let twoPaused = try XCTUnwrap(WatchSessionSummary(sessionID: "S1", watches: [
            WatchFixture.watch(id: "W1", state: "PAUSED"),
            WatchFixture.watch(id: "W2", state: "PAUSED"),
        ]))
        XCTAssertEqual(twoPaused.word, "2 \(pausedMany)", "the word over a session whose watches are all paused drifted.")
    }
}
