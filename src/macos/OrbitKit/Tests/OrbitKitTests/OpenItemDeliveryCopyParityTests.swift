import Foundation
import XCTest
@testable import OrbitKit

/// The two clients read one `openItemDelivery` payload the same way and say the same words about it,
/// and this is the tripwire that keeps them doing it.
///
/// `OpenItemDelivery.swift` is a hand-copy of the browser's reading of the payload
/// (`lib/openItemDelivery.ts`) and of the card it draws (`OpenItemDeliveryCard.tsx`). The Swift
/// client and the browser bundle share no compiler — and on the shared declaration both read
/// (`@orbit/shared`'s `project-progress.ts`) the two ends agree only by being copied. That is where
/// the drift costs most: a field this end never learned to read is a fact the card is simply missing,
/// and a sentence reworded at one end is one screen disagreeing with the other about the same item.
///
/// Shaped after `ReferencedTaskCopyParityTests` / `BackgroundWakeCopyParityTests`, including the part
/// that matters most: a missing counterpart is a FAILURE and never an `XCTSkip`. A check that quietly
/// opts out reports green on exactly the day the thing it watches goes missing.
final class OpenItemDeliveryCopyParityTests: XCTestCase {

    private static let webReader = "src/web/src/lib/openItemDelivery.ts"
    private static let webCard = "src/web/src/components/OpenItemDeliveryCard.tsx"
    private static let webTranscript = "src/web/src/components/Transcript.tsx"
    private static let shared = "src/shared/src/project-progress.ts"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case missing(String)
        case notDeclared(what: String, file: String)

        var description: String {
            switch self {
            case .noRepo:
                return "\(OpenItemDeliveryCopyParityTests.webReader) was not found above this test "
                    + "file. OrbitKit's reading of the payload is one half of a pair; if the web half "
                    + "moved, move this check with it rather than deleting it."
            case .missing(let path):
                return "\(path) was not found. Either it moved — then point this check at its new "
                    + "home — or it is gone, and this client is now mirroring something that no "
                    + "longer exists."
            case .notDeclared(let what, let file):
                return "\(what) was not found in \(file). Either it was renamed — then rename it here "
                    + "too, which is what this check is for — or it is gone."
            }
        }
    }

    /// The repo root, found by walking up from this file until the web's reader is under foot. Not a
    /// fixed number of `..` hops: how deep this test file sits is not the thing being asserted.
    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.webReader).path) {
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

    /// A web source with its string literals put back together.
    ///
    /// TypeScript wraps a long sentence as `'…' + '…'` across lines and lets a value sit on the line
    /// under its `=`; where those wraps fall is a formatting decision while the words are the
    /// contract.
    private func flat(_ relative: String) throws -> String {
        try read(relative)
            .replacingOccurrences(of: "['\"`]\\s*\\+\\s*['\"`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "=\\s*\\n\\s*(['\"`/])", with: "= $1", options: .regularExpression)
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

    /// Every capture of `pattern`, in source order.
    private func captures(_ source: String, _ pattern: String) throws -> [String] {
        let re = try NSRegularExpression(pattern: pattern)
        return re.matches(in: source, range: NSRange(source.startIndex..., in: source)).compactMap {
            guard $0.numberOfRanges > 1, let range = Range($0.range(at: 1), in: source) else { return nil }
            return String(source[range])
        }
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

    /// A sentence the other end builds around a value of its own, so there is no whole literal to
    /// compare — the words either side of the interpolation are.
    private func assertBuilt(_ source: String, _ value: String, _ what: String, _ file: String,
                             line: UInt = #line) {
        XCTAssertTrue(source.contains(value),
                      "\(what) drifted: \(file) no longer builds \(value.debugDescription)",
                      file: #filePath, line: line)
    }

    /// One delivered card, as the payload reaches the client — the same fixture the decode tests use.
    private func conflictCard() throws -> OpenItemDelivery {
        let json = """
            {"seq": 4, "type": "user", "payload": {"text": "【例外待办】…",
             "openItemDelivery": {"itemId": "0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6d",
              "kind": "INTEGRATION_CONFLICT",
              "title": "Merge conflict: 回填历史 user 事件的 controlPlaneNote",
              "task": {"id": "0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6e", "title": "回填",
                       "sessionId": "0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6f"},
              "files": ["a", "b", "c", "d"], "targetRef": "refs/heads/main",
              "check": null, "errorCode": null, "failure": null,
              "actions": ["OPEN_COORDINATOR", "RETRY", "CANCEL_TASK"],
              "landing": {"receipts": 0, "state": "NOT_KNOWN", "upstream": "main",
                          "integration": "main"}}}}
            """
        let event = try JSONDecoder().decode(RunEvent.self, from: Data(json.utf8))
        return try XCTUnwrap(OpenItemDelivery.parse(event.payload))
    }

    // MARK: the payload's fields

    /// Every field of the card goes by the same name on both ends, in the same order. The two are one
    /// reading of one payload, and a field one end never learned to read is simply blank there.
    func testEveryFieldOfTheCardIsCalledWhatWebCallsIt() throws {
        let shared = try flat(Self.shared)
        let body = try section(shared, from: "export interface OpenItemDeliveryCard {", to: "\n}",
                               Self.shared)
        let theirs = try captures(body, "(?m)^  (\\w+):")
        let mine = Mirror(reflecting: try conflictCard()).children.compactMap(\.label)

        XCTAssertFalse(theirs.isEmpty, "no field of the interface was captured — the check is asleep")
        XCTAssertEqual(mine, theirs,
                       "OpenItemDeliveryCard's fields drifted — first is this client's (in "
                           + "declaration order), second is the interface in \(Self.shared).")
    }

    /// The three keys that make a payload a card at all, and the defaults the rest of the fields take.
    /// A payload with no card must parse as NOTHING at either end: that is what keeps a delivery the
    /// platform recorded nothing beside — every one stored before this existed — drawn as the message
    /// it has always been.
    func testTheReaderRequiresTheSameThreeKeysAndDefaultsTheSameWay() throws {
        let web = try flat(Self.webReader)

        assertBuilt(web, "typeof card.itemId !== 'string' || card.itemId === ''",
                    "the item the card is about, required", Self.webReader)
        assertBuilt(web, "typeof card.kind !== 'string'", "the kind, required", Self.webReader)
        assertBuilt(web, "typeof card.title !== 'string' || card.title === ''",
                    "the title, required", Self.webReader)
        assertBuilt(web, "if (!raw || typeof raw !== 'object') return null;",
                    "a payload that is not a card at all", Self.webReader)
        assertBuilt(web, "typeof card.itemId !== 'string'", "the reader's own refusal", Self.webReader)

        // The defaults: a branch the payload left out is main, an unknown landing state is no landing,
        // and the actions are read as the server's raw values.
        assertBuilt(web, "typeof landing.upstream === 'string' ? landing.upstream : 'main'",
                    "the default upstream branch", Self.webReader)
        assertBuilt(web, "typeof landing.integration === 'string' ? landing.integration : 'main'",
                    "the default integration branch", Self.webReader)
        assertBuilt(web, "state !== 'ON_UPSTREAM' && state !== 'ON_INTEGRATION_LINE' && state !== 'NOT_KNOWN'",
                    "the three landing states", Self.webReader)
        assertBuilt(web, "strings(card.actions) as OpenItemAction[]",
                    "the doors, read as the server's own values", Self.webReader)

        // This end's half of the same two rules.
        XCTAssertNil(OpenItemDelivery.parse(.object(["openItemDelivery": .string("merge")])))
        XCTAssertEqual(OpenItemDeliveryLanding(rawValue: "PROBABLY"), nil)
        XCTAssertEqual(OpenItemDeliveryLanding.allCases.count, 3)
    }

    /// The landing states this client knows are the three the wire spells — the same three the shared
    /// declaration names, since a state one end invents is a landing the other end cannot draw.
    func testTheLandingStatesAreSpelledTheSameOnBothEnds() throws {
        let shared = try flat(Self.shared)
        let declared = try capture(shared, "export type OpenItemDeliveryLanding = (.+?);",
                                   "OpenItemDeliveryLanding", Self.shared)
        let theirs = declared.split(separator: "|").map {
            $0.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "'"))
        }
        XCTAssertEqual(OpenItemDeliveryLanding.allCases.map(\.rawValue), theirs,
                       "the landing states drifted — first is this client's, second is "
                           + "OpenItemDeliveryLanding in \(Self.shared).")
    }

    // MARK: the words the card is drawn in

    /// What is opened, named the way the rest of the product names it.
    func testTheKindLabelsAreTheWebs() throws {
        let web = try flat(Self.webCard)
        let table = try section(web, from: "const KIND_LABEL", to: "\n};", Self.webCard)
        let pairs = try zip(captures(table, "(?m)^  (\\w+):"),
                            captures(table, "(?m)^  \\w+: '([^']*)',")).map { ($0, $1) }
        guard pairs.count == 7 else {
            throw ParityError.notDeclared(what: "the seven kind labels", file: Self.webCard)
        }
        for (kind, label) in pairs {
            let mine = ProjectOpenItemKind(rawValue: kind)
            XCTAssertNotEqual(mine, nil, "\(kind) is in the web's table and not in this client's kind")
            XCTAssertEqual(mine.map(OpenItemDeliveryCard.kindLabel), label,
                           "\(kind)'s label drifted — first is this client's, second is "
                               + "KIND_LABEL in \(Self.webCard).")
        }
        assertBuilt(web, "?? 'Exception item'", "what a kind the table lacks is called",
                    Self.webCard)
        XCTAssertEqual(OpenItemDeliveryCard.kindLabel(.unknown), OpenItemDeliveryCard.header)
    }

    /// The doors, in the web's own words — and the two it deliberately leaves out, which is also
    /// where this client's chips have to stop.
    func testTheDoorLabelsAreTheWebs() throws {
        let web = try flat(Self.webCard)
        let table = try section(web, from: "const ACTION_LABEL", to: "\n};", Self.webCard)
        let pairs = try zip(captures(table, "(?m)^  (\\w+):"),
                            captures(table, "(?m)^  \\w+: '([^']*)',")).map { ($0, $1) }
        guard !pairs.isEmpty else {
            throw ParityError.notDeclared(what: "any door label", file: Self.webCard)
        }
        for (action, label) in pairs {
            XCTAssertEqual(OpenItemDeliveryCard.actionLabels([action]), [label],
                           "\(action)'s label drifted — first is this client's, second is "
                               + "ACTION_LABEL in \(Self.webCard).")
        }
        // The two doors the web leaves unlabelled on purpose: the conversation the card is drawn in,
        // and the session link drawn below it. Neither becomes a chip here either.
        for unlabelled in ["OPEN_COORDINATOR", "OPEN_TASK_SESSION"] {
            XCTAssertFalse(pairs.map(\.0).contains(unlabelled),
                           "\(unlabelled) gained a chip label on the web — check both ends")
            XCTAssertEqual(OpenItemDeliveryCard.actionLabels([unlabelled]), [])
        }
    }

    /// Every other sentence the card is read in: the header, the fold, the two links, the foot, and
    /// the why-line each kind is drawn with.
    func testEverySentenceIsTheWebs() throws {
        let web = try flat(Self.webCard)
        let sentences = [
            OpenItemDeliveryCard.header,
            OpenItemDeliveryCard.doorsLead,
            OpenItemDeliveryCard.openTask,
            OpenItemDeliveryCard.openSession,
            OpenItemDeliveryCard.notification,
            OpenItemDeliveryCard.undelivered,
            OpenItemDeliveryCard.rawSummary,
            "Show fewer files",
            "more files",
        ]
        for sentence in sentences {
            assertBuilt(web, sentence, "the sentence \(sentence.debugDescription)", Self.webCard)
        }
        for how in ["ACCEPTANCE_EXIT_MISMATCH", "RUN_FAILED", "RUNNER_FINALIZED_FAILED",
                    "REAPED_API_ERROR", "ATTEMPT_LOST_RUNNER_OFFLINE",
                    "ATTEMPT_LOST_RUNTIME_NOT_INITIALIZED", "REPORTED_FAILED", nil] as [String?] {
            assertBuilt(web, OpenItemDeliveryCard.how(how),
                        "what \(how ?? "an unrecorded failure") is called", Self.webCard)
        }
        // The sentences built around a value of the other end's: the words either side are what the
        // two ends have to share.
        for run in ["git refused the merge", "; the target branch did not move. "
                    + "The platform will not retry it by itself.",
                    " was declared; the target branch did not move.",
                    "The integration job ended with",
                    "merge receipt", "none naming",
                    "— Orbit cannot tell whether this work has landed.",
                    "— a merge receipt records this work there.",
                    "— a merge receipt records it on the project branch.",
                    " in this chain."] {
            assertBuilt(web, run, "the run \(run.debugDescription)", Self.webCard)
        }
        // And the same runs really are what this end draws.
        let landed = OpenItemDeliveryCard.landingLine(try conflictCard())
        XCTAssertEqual(landed?.text,
                       "No merge receipt for this work — Orbit cannot tell whether it has landed.")
    }

    /// The bar at the top of the console names this turn off the card on both clients — the web
    /// stamps the pair onto the card's root, this client reads it in `StickySummary`.
    func testTheStickyPairIsTheSameOnBothEnds() throws {
        let web = try flat(Self.webCard)
        assertBuilt(web, "data-sticky-label=\"Exception item\"", "the label the bar reads",
                    Self.webCard)
        // The kind, then the title — and the guard that keeps a title already carrying its kind from
        // being prefixed with it a second time. Both ends spell the rule out (`stickyText` here,
        // `stickyText` in the browser): a bar reading "Task failed: Task failed: [WARC]…" is one
        // turn told twice, and a browser that de-duplicated while this end kept both would be two
        // wordings of it.
        assertBuilt(web, "data-sticky-text={stickyText}",
                    "the line under that label", Self.webCard)
        assertBuilt(web,
                    "card.title.toLowerCase().startsWith(label.toLowerCase())",
                    "the browser de-duplicating a title that already opens with its kind", Self.webCard)

        let sticky = OpenItemDeliveryCard.sticky(try conflictCard())
        XCTAssertEqual(sticky.label, OpenItemDeliveryCard.header)
        XCTAssertEqual(sticky.text, "Merge conflict: 回填历史 user 事件的 controlPlaneNote",
                       "this fixture's title already opens with its kind, so it is not prefixed again")
        // And a title that does NOT say it keeps the prefix, so the line still names the kind: the
        // rule drops a repetition, not the label.
        XCTAssertEqual(
            OpenItemDeliveryCard.stickyText(kind: .taskFailed, title: "[WARC] 000_00022 的 WARC 依赖"),
            "Task failed: [WARC] 000_00022 的 WARC 依赖")
        // And where the browser checks it, so does this client: before the wakes, which are read out
        // of the text this card is not.
        let transcript = try flat(Self.webTranscript)
        assertBuilt(transcript, "if (node.itemCard) {",
                    "the item card's precedence in the browser", Self.webTranscript)
    }

    /// The fold the paragraph the agent read stays behind. Its label is the web's, and the paragraph
    /// itself is the turn's own text — never re-derived here.
    func testTheFoldIsTheWebsFold() throws {
        let web = try flat(Self.webCard)
        assertBuilt(web, "<summary>What the coordinator was told</summary>",
                    "the fold the paragraph sits behind", Self.webCard)
        assertBuilt(web, "<pre>{text}</pre>", "what the fold opens to", Self.webCard)
        XCTAssertEqual(OpenItemDeliveryCard.rawSummary, "What the coordinator was told")
    }
}
