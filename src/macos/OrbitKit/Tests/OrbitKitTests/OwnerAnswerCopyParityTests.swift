import Foundation
import XCTest
@testable import OrbitKit

/// The two clients read one `ownerAnswer` payload the same way and draw the same line from it, and
/// this is the tripwire that keeps them doing it.
///
/// `OwnerAnswer.swift` is a hand-copy of the browser's reading of the payload (`lib/ownerAnswer.ts`)
/// and of the line it draws (`OwnerAnswerLine.tsx`). Neither end compiles the other, and the shared
/// declaration both read (`@orbit/shared`'s `project-progress.ts`) holds them together only by being
/// copied — so a sentence reworded at one end is one screen disagreeing with the other about the same
/// turn. Shaped after `OpenItemDeliveryCopyParityTests`, including the part that matters most: a
/// missing counterpart is a FAILURE and never an `XCTSkip`.
final class OwnerAnswerCopyParityTests: XCTestCase {

    private static let webReader = "src/web/src/lib/ownerAnswer.ts"
    private static let webLine = "src/web/src/components/OwnerAnswerLine.tsx"
    private static let webEvidence = "src/web/src/components/EvidenceDecisionCard.tsx"
    private static let webTranscript = "src/web/src/components/Transcript.tsx"
    private static let shared = "src/shared/src/project-progress.ts"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case missing(String)
        case notDeclared(what: String, file: String)

        var description: String {
            switch self {
            case .noRepo:
                return "\(OwnerAnswerCopyParityTests.webReader) was not found above this test file. "
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

    private func assertBuilt(_ source: String, _ value: String, _ what: String, _ file: String,
                             line: UInt = #line) {
        XCTAssertTrue(source.contains(value),
                      "\(what) drifted: \(file) no longer builds \(value.debugDescription)",
                      file: #filePath, line: line)
    }

    private let card = OwnerAnswer(itemId: "01a0d6a9-d763-70e1-b4cf-8793e971b511", kind: .coordinatorQuestion,
                                   sessionId: "01a0d6a9-d763-70e1-b4cf-8793e971b512",
                                   deliveredAt: "2026-10-09T00:29:37.104Z")

    // MARK: the payload

    /// Every field of the card goes by the same name on both ends, in the same order.
    func testEveryFieldOfTheCardIsCalledWhatTheSharedDeclarationCallsIt() throws {
        let shared = try flat(Self.shared)
        let body = try section(shared, from: "export interface OwnerAnswerCard {", to: "\n}", Self.shared)
        let re = try NSRegularExpression(pattern: "(?m)^  (\\w+):")
        let theirs = re.matches(in: body, range: NSRange(body.startIndex..., in: body)).compactMap {
            Range($0.range(at: 1), in: body).map { String(body[$0]) }
        }
        let mine = Mirror(reflecting: card).children.compactMap(\.label)
        XCTAssertFalse(theirs.isEmpty, "no field of the interface was captured — the check is asleep")
        XCTAssertEqual(mine, theirs, "OwnerAnswerCard's fields drifted — first is this client's, second \(Self.shared)'s")
        for kind in OwnerAnswer.Kind.allCases {
            assertBuilt(body, "'\(kind.rawValue)'", "the kinds a card can be", Self.shared)
        }
    }

    /// What makes a payload a card at all. A payload that is not one must parse as NOTHING at either
    /// end: that is what keeps every answer stored before this existed drawn as it always was.
    func testTheReaderRequiresTheSameFieldsAndTheSameKinds() throws {
        let web = try flat(Self.webReader)
        assertBuilt(web, "(payload as { ownerAnswer?: unknown } | null)?.ownerAnswer", "the key it is read from", Self.webReader)
        assertBuilt(web, "if (!raw || typeof raw !== 'object') return null;", "a payload that is not a card", Self.webReader)
        assertBuilt(web, "typeof card.itemId !== 'string' || card.itemId === ''", "the item, required", Self.webReader)
        assertBuilt(web, "typeof card.sessionId !== 'string' || card.sessionId === ''", "the conversation, required", Self.webReader)
        assertBuilt(web, "typeof card.deliveredAt !== 'string' || Number.isNaN(Date.parse(card.deliveredAt))",
                    "a moment that reads as one, required", Self.webReader)
        let kinds = OwnerAnswer.Kind.allCases
            .map { "card.kind !== '\($0.rawValue)'" }
            .joined(separator: " && ")
        assertBuilt(web, "(\(kinds))", "the kinds a card can be, in this client's order", Self.webReader)
    }

    // MARK: the line

    /// One line in both clients: what a version handed to its coordinator says, on the receipt clock.
    func testTheLineIsTheWebLineWordForWord() throws {
        let line = try flat(Self.webLine)
        assertBuilt(line, "{sentToCoordinatorLine(card.deliveredAt)}", "the line's words", Self.webLine)
        assertBuilt(line, "export const OWNER_ANSWER_TOLD = '\(OwnerAnswerCard.told)'", "the heading over the words",
                    Self.webLine)
        assertBuilt(line, ">\(OwnerAnswerCard.undelivered)<", "what an unconfirmed answer says", Self.webLine)

        // And what that function says: this end's line, rendered, with the web's interpolations put back.
        let evidence = try flat(Self.webEvidence)
        assertBuilt(evidence, "export const EVIDENCE_DECISION_SENT_TO_COORDINATOR = '\(EvidenceDecisions.sentToCoordinator)'",
                    "the line's opening words", Self.webEvidence)
        let rendered = OwnerAnswerCard.line(card)
        let template = rendered
            .replacingOccurrences(of: EvidenceDecisions.sentToCoordinator, with: "${EVIDENCE_DECISION_SENT_TO_COORDINATOR}")
            .replacingOccurrences(of: EvidenceDecisions.receiptTime(card.deliveredAt),
                                  with: "${decisionReceiptTime(deliveredAt, now)}")
        assertBuilt(evidence, "`\(template)`", "the line", Self.webEvidence)
    }

    /// The browser draws the line from the card, in the transcript's own dispatch, as this end does.
    func testTheWebTranscriptDrawsTheLineFromTheCard() throws {
        let transcript = try flat(Self.webTranscript)
        assertBuilt(transcript, "const ownerAnswer = parseOwnerAnswer(p) ?? undefined;", "the card read off the echo",
                    Self.webTranscript)
        assertBuilt(transcript, "if (node.ownerAnswer) {", "the line's branch", Self.webTranscript)
        assertBuilt(transcript, "<OwnerAnswerLine", "the line", Self.webTranscript)
    }
}
