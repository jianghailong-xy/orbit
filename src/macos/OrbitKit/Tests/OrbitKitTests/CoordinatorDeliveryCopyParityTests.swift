import Foundation
import XCTest
@testable import OrbitKit

/// The two clients read one `coordinatorDelivery` payload the same way and draw the same line from it,
/// and this is the tripwire that keeps them doing it.
///
/// `CoordinatorDelivery.swift` is a hand-copy of the browser's reading of the payload and of the words
/// it says (`lib/coordinatorDelivery.ts`), and of the line it draws (`CoordinatorDeliveryLine.tsx`).
/// Neither end compiles the other, and the shared declaration both read (`@orbit/shared`'s
/// `project-progress.ts`) holds them together only by being copied — so a sentence reworded at one end
/// is one screen disagreeing with the other about the same turn. Every entry of the web's two tables is
/// compared here, both ways, so a kind added to one end and not the other fails. Shaped after
/// `OwnerAnswerCopyParityTests`, including the part that matters most: a missing counterpart is a
/// FAILURE and never an `XCTSkip`.
final class CoordinatorDeliveryCopyParityTests: XCTestCase {

    private static let webReader = "src/web/src/lib/coordinatorDelivery.ts"
    private static let webLine = "src/web/src/components/CoordinatorDeliveryLine.tsx"
    private static let webOwnerAnswer = "src/web/src/components/OwnerAnswerLine.tsx"
    private static let webTranscript = "src/web/src/components/Transcript.tsx"
    private static let shared = "src/shared/src/project-progress.ts"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case missing(String)
        case notDeclared(what: String, file: String)

        var description: String {
            switch self {
            case .noRepo:
                return "\(CoordinatorDeliveryCopyParityTests.webReader) was not found above this test file. "
                    + "OrbitKit's reading of the payload is one half of a pair; if the web half moved, "
                    + "move this check with it rather than deleting it."
            case .missing(let path):
                return "\(path) was not found. Either it moved — then point this check at its new home "
                    + "— or it is gone, and this client is now mirroring something that no longer exists."
            case .notDeclared(let what, let file):
                return "\(what) was not found in \(file). Either it was renamed — then rename it here "
                    + "too, which is what this check is for — or it is gone."
            }
        }
    }

    /// The repo root, found by walking up from this file until the web's reader is under foot.
    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.webReader).path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        throw ParityError.noRepo
    }

    /// A web source with its string literals put back together: where a long sentence wraps is a
    /// formatting decision, while the words are the contract.
    private func flat(_ relative: String) throws -> String {
        let url = try repoRoot().appendingPathComponent(relative)
        guard FileManager.default.fileExists(atPath: url.path) else { throw ParityError.missing(relative) }
        return try String(contentsOf: url, encoding: .utf8)
            .replacingOccurrences(of: "['\"`]\\s*\\+\\s*['\"`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "=\\s*\\n\\s*(['\"`/])", with: "= $1", options: .regularExpression)
    }

    /// From one marker to the next occurrence of another.
    private func section(_ source: String, from: String, to: String, _ file: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw ParityError.notDeclared(what: "\(from) … \(to)", file: file)
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    /// Every match of a pattern's capture groups, in order.
    private func captures(_ pattern: String, in text: String) throws -> [[String]] {
        let re = try NSRegularExpression(pattern: pattern)
        return re.matches(in: text, range: NSRange(text.startIndex..., in: text)).map { match in
            (1..<match.numberOfRanges).map { i in
                Range(match.range(at: i), in: text).map { String(text[$0]) } ?? ""
            }
        }
    }

    private func assertBuilt(_ source: String, _ value: String, _ what: String, _ file: String,
                             line: UInt = #line) {
        XCTAssertTrue(source.contains(value),
                      "\(what) drifted: \(file) no longer builds \(value.debugDescription)",
                      file: #filePath, line: line)
    }

    private let card = CoordinatorDelivery(
        kind: .evidenceSubmitted,
        task: .init(id: "01a0d6a9-d763-70e1-b4cf-8793e971b513", title: "Fix the claim"),
        revision: 1, count: nil, deliveredAt: "2026-10-31T11:30:00.000Z")

    // MARK: the payload

    /// Every field of the card goes by the same name on both ends, in the same order.
    func testEveryFieldOfTheCardIsCalledWhatTheSharedDeclarationCallsIt() throws {
        let shared = try flat(Self.shared)
        let body = try section(shared, from: "export interface CoordinatorDeliveryCard {", to: "\n}", Self.shared)
        let theirs = try captures("(?m)^  (\\w+):", in: body).map { $0[0] }
        let mine = Mirror(reflecting: card).children.compactMap(\.label)
        XCTAssertFalse(theirs.isEmpty, "no field of the interface was captured — the check is asleep")
        XCTAssertEqual(mine, theirs,
                       "CoordinatorDeliveryCard's fields drifted — first is this client's, second \(Self.shared)'s")
        let task = Mirror(reflecting: try XCTUnwrap(card.task)).children.compactMap(\.label)
        assertBuilt(body, "task: { \(task.map { "\($0): string" }.joined(separator: "; ")) } | null;",
                    "the task a card names", Self.shared)
    }

    /// The kinds a card can be: the shared list, in its order, and not one more or less.
    func testTheKindsAreTheSharedListInItsOrder() throws {
        let shared = try flat(Self.shared)
        let list = try section(shared, from: "export const COORDINATOR_DELIVERY_KINDS = [", to: "] as const;",
                               Self.shared)
        let theirs = try captures("(?m)^  '([A-Z_]+)',$", in: list).map { $0[0] }
        XCTAssertFalse(theirs.isEmpty, "no kind was captured — the check is asleep")
        XCTAssertEqual(CoordinatorDelivery.Kind.allCases.map(\.rawValue), theirs,
                       "the kinds drifted — first is this client's, second \(Self.shared)'s")
    }

    /// What makes a payload a card at all. A payload that is not one must parse as NOTHING at either
    /// end: that is what keeps every delivery stored before this existed drawn as it always was.
    func testTheReaderRequiresWhatTheWebRequires() throws {
        let web = try flat(Self.webReader)
        assertBuilt(web, "(payload as { coordinatorDelivery?: unknown } | null)?.coordinatorDelivery",
                    "the key it is read from", Self.webReader)
        assertBuilt(web, "if (!raw || typeof raw !== 'object') return null;", "a payload that is not a card",
                    Self.webReader)
        assertBuilt(web, "if (!(COORDINATOR_DELIVERY_KINDS as readonly unknown[]).includes(kind)) return null;",
                    "a kind of the shared list, required", Self.webReader)
        assertBuilt(web, "typeof card.deliveredAt !== 'string' || Number.isNaN(Date.parse(card.deliveredAt))",
                    "a moment that reads as one, required", Self.webReader)
        assertBuilt(web, "&& typeof task.id === 'string' && task.id !== ''", "the task's id, not empty",
                    Self.webReader)
        assertBuilt(web, "&& typeof task.title === 'string' && task.title.trim() !== ''", "the task's title, not blank",
                    Self.webReader)
        assertBuilt(web, "typeof value === 'number' && Number.isSafeInteger(value) && value > 0",
                    "a revision or count is a positive whole number", Self.webReader)
        assertBuilt(web, "if (sentence.includes('{task}') && !named) return null;", "a task where the sentence names one",
                    Self.webReader)
        assertBuilt(web, "if (sentence.includes('{revision}') && !positive(card.revision)) return null;",
                    "a revision where the sentence names one", Self.webReader)
        assertBuilt(web, "if (sentence.includes('{count}') && !positive(card.count)) return null;",
                    "a count where the sentence names one", Self.webReader)
        // A field the sentence does not name is left out, as this end leaves it out.
        assertBuilt(web, "task: sentence.includes('{task}') ? named : null,", "an unnamed task left out",
                    Self.webReader)
        assertBuilt(web, "revision: sentence.includes('{revision}') ? card.revision as number : null,",
                    "an unnamed revision left out", Self.webReader)
        assertBuilt(web, "count: sentence.includes('{count}') ? card.count as number : null,",
                    "an unnamed count left out", Self.webReader)
        // Only the server's own false says this conversation is not the coordinator, as this end reads it.
        assertBuilt(web, "toCoordinator: card.toCoordinator !== false,", "who the conversation is to the project",
                    Self.webReader)
    }

    // MARK: the words

    /// Every kind's sentence is the web's, word for word — and the web says no sentence this end lacks.
    func testEverySentenceIsTheWebsWordForWord() throws {
        let web = try flat(Self.webReader)
        let table = try section(web, from: "export const COORDINATOR_DELIVERY_SENTENCES", to: "\n};", Self.webReader)
        var theirs: [String: String] = [:]
        for entry in try captures("(?m)^  ([A-Z_]+): '([^']*)',$", in: table) { theirs[entry[0]] = entry[1] }
        XCTAssertFalse(theirs.isEmpty, "no sentence was captured — the check is asleep")
        var mine: [String: String] = [:]
        for kind in CoordinatorDelivery.Kind.allCases { mine[kind.rawValue] = CoordinatorDeliveryCard.sentence(for: kind) }
        XCTAssertEqual(mine, theirs, "the sentences drifted — first is this client's, second \(Self.webReader)'s")
    }

    /// How a count is said — one, and more than one — is the web's for every kind that counts, and no
    /// kind counts at one end only.
    func testEveryCountIsSaidAsTheWebSaysIt() throws {
        let web = try flat(Self.webReader)
        var words: [String: [String]] = [:]
        for entry in try captures("const ([A-Z_]+) = \\{ one: '([^']*)', many: '([^']*)' \\} as const;", in: web) {
            words[entry[0]] = [entry[1], entry[2]]
        }
        let table = try section(web, from: "export const COORDINATOR_DELIVERY_COUNTS", to: "\n};", Self.webReader)
        var theirs: [String: [String]] = [:]
        for entry in try captures("(?m)^  ([A-Z_]+): ([A-Z_]+),$", in: table) {
            theirs[entry[0]] = try XCTUnwrap(words[entry[1]], "\(entry[1]) is not one of the web's count words")
        }
        XCTAssertFalse(theirs.isEmpty, "no count was captured — the check is asleep")
        var mine: [String: [String]] = [:]
        for kind in CoordinatorDelivery.Kind.allCases {
            if let counted = CoordinatorDeliveryCard.countWords(for: kind) {
                mine[kind.rawValue] = [counted.one, counted.many]
            }
        }
        XCTAssertEqual(mine, theirs, "the count words drifted — first is this client's, second \(Self.webReader)'s")
    }

    /// The sentence is put together the way the web puts it together: the count's `{n}`, then the
    /// revision, the count and the title, each replacing its first placeholder — the title last, so a
    /// title is never read as a pattern.
    func testTheSentenceIsRenderedAsTheWebRendersIt() throws {
        let web = try flat(Self.webReader)
        assertBuilt(web, "(card.count === 1 ? counts.one : counts.many).replace('{n}', String(card.count))",
                    "one, or more than one", Self.webReader)
        let revision = ".replace('{revision}', () => String(card.revision ?? ''))"
        let count = ".replace('{count}', () => count)"
        let title = ".replace('{task}', () => card.task?.title ?? '')"
        for step in [revision, count, title] { assertBuilt(web, step, "a step of the sentence", Self.webReader) }
        if let r = web.range(of: revision), let c = web.range(of: count), let t = web.range(of: title) {
            XCTAssertTrue(r.lowerBound < c.lowerBound && c.lowerBound < t.lowerBound,
                          "the web fills the sentence in another order: the title must go last")
        }
    }

    // MARK: the line

    /// One line in both clients: the sentence, then what a version handed to its coordinator says, on the
    /// receipt clock; opened, the owner's answer's heading over the words, and the task's link at the foot.
    /// Where the conversation is not the project's coordinator, both ends say this session instead.
    func testTheLineIsTheWebLineWordForWord() throws {
        let reader = try flat(Self.webReader)
        assertBuilt(reader, "export const COORDINATOR_DELIVERY_STICKY_LABEL = '\(CoordinatorDeliveryCard.stickyLabel)';",
                    "the sticky bar's label", Self.webReader)
        assertBuilt(reader, "export const COORDINATOR_DELIVERY_ITS_TASK = '\(CoordinatorDeliveryCard.itsTask)';",
                    "the task's link", Self.webReader)
        assertBuilt(reader,
                    "export const COORDINATOR_DELIVERY_SENT_TO_SESSION = '\(CoordinatorDeliveryCard.sentToThisSession)';",
                    "where a reply to a task's run says it went", Self.webReader)
        assertBuilt(reader,
                    "export const COORDINATOR_DELIVERY_SESSION_TOLD = '\(CoordinatorDeliveryCard.toldThisSession)';",
                    "the heading over that reply's words", Self.webReader)

        let line = try flat(Self.webLine)
        assertBuilt(line, "const sentence = coordinatorDeliverySentence(card);", "the line's sentence", Self.webLine)
        assertBuilt(line, "{sentLine(card)}", "the line's time", Self.webLine)
        assertBuilt(line, "? sentToCoordinatorLine(card.deliveredAt)", "the coordinator's time", Self.webLine)
        assertBuilt(line, ": `${COORDINATOR_DELIVERY_SENT_TO_SESSION} · ${decisionReceiptTime(card.deliveredAt)}`;",
                    "this session's time, on the same clock", Self.webLine)
        assertBuilt(line, "{card.toCoordinator ? OWNER_ANSWER_TOLD : COORDINATOR_DELIVERY_SESSION_TOLD}",
                    "the heading over the words", Self.webLine)
        assertBuilt(line, ">\(CoordinatorDeliveryCard.undelivered)<", "what an unconfirmed turn says", Self.webLine)
        assertBuilt(line, "{COORDINATOR_DELIVERY_ITS_TASK}", "the task's link at the foot", Self.webLine)
        // The sticky bar's anchor: the label and the sentence, as `StickySummary` names the turn here.
        assertBuilt(line, "data-sticky-label={COORDINATOR_DELIVERY_STICKY_LABEL}", "the sticky bar's label",
                    Self.webLine)
        assertBuilt(line, "data-sticky-text={sentence}", "the sticky bar's text", Self.webLine)

        let ownerAnswer = try flat(Self.webOwnerAnswer)
        assertBuilt(ownerAnswer, "export const OWNER_ANSWER_TOLD = '\(CoordinatorDeliveryCard.told)'",
                    "the heading over the words", Self.webOwnerAnswer)

        // And what this end says on the line, rendered: the sentence, then the time half.
        let sameDay = try XCTUnwrap(ThinkingSummary.date("2026-10-31T11:45:00.000Z"))
        XCTAssertEqual(CoordinatorDeliveryCard.line(card, now: sameDay),
                       "Evidence revision 1 submitted: Fix the claim · "
                           + "\(EvidenceDecisions.sentToCoordinator) · "
                           + EvidenceDecisions.receiptTime(card.deliveredAt, now: sameDay))
        let run = CoordinatorDelivery(kind: .criteriaRejected, deliveredAt: card.deliveredAt, toCoordinator: false)
        XCTAssertEqual(CoordinatorDeliveryCard.line(run, now: sameDay),
                       "Criteria proposal rejected · \(CoordinatorDeliveryCard.sentToThisSession) · "
                           + EvidenceDecisions.receiptTime(run.deliveredAt, now: sameDay))
        XCTAssertEqual(CoordinatorDeliveryCard.heading(run), CoordinatorDeliveryCard.toldThisSession)
        XCTAssertEqual(CoordinatorDeliveryCard.heading(card), CoordinatorDeliveryCard.told)
    }

    /// The browser draws the line from the card, in the transcript's own dispatch, as this end does.
    func testTheWebTranscriptDrawsTheLineFromTheCard() throws {
        let transcript = try flat(Self.webTranscript)
        assertBuilt(transcript, "const coordinatorDelivery = parseCoordinatorDelivery(p) ?? undefined;",
                    "the card read off the echo", Self.webTranscript)
        assertBuilt(transcript, "if (node.coordinatorDelivery) {", "the line's branch", Self.webTranscript)
        assertBuilt(transcript, "<CoordinatorDeliveryLine", "the line", Self.webTranscript)
        assertBuilt(transcript, "&& !node.coordinatorDelivery", "nobody's own words", Self.webTranscript)
    }
}
