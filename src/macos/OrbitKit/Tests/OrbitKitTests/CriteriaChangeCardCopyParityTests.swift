import Foundation
import XCTest
@testable import OrbitKit

/// The two clients say the same words on "Confirm the new criteria?", and this is the tripwire that
/// keeps them saying them.
///
/// The browser declares the card's sentences in `lib/projectStart.ts` and draws them in
/// `CriteriaChangeCard.tsx`; this client holds the same sentences by hand (`CriteriaChanges`). They
/// share no compiler, so this reads the other end's source — every sentence compared whole, with
/// sentinels put back as the web template's own interpolations — and a counterpart it cannot find is
/// a FAILURE, never an `XCTSkip`.
///
/// One thing this end says that the browser says only to a screen reader, deliberately: the head
/// over the list. The browser labels the list `What changed` for assistive technology; a phone draws
/// it as the card's section head, with how many rows it holds, the way the start card's own heads
/// count theirs (`CriteriaChanges.whatChangedHead`) — which is what the phone mock of the card
/// draws. The words are the same constant.
final class CriteriaChangeCardCopyParityTests: XCTestCase {

    private static let words = "src/web/src/lib/projectStart.ts"
    private static let card = "src/web/src/components/CriteriaChangeCard.tsx"

    private static let title = "Aurora"
    private static let seal = "qqqqzzzzqqqq"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case missing(String)
        var description: String {
            switch self {
            case .noRepo:
                return "\(CriteriaChangeCardCopyParityTests.words) was not found above this test "
                    + "file. The native change card is one half of a pair; if the web half moved, "
                    + "move this check with it rather than deleting it."
            case .missing(let relative):
                return "\(relative) was not found. If it moved, move this check with it rather than "
                    + "deleting it."
            }
        }
    }

    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.words).path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        throw ParityError.noRepo
    }

    /// One web source with its string literals put back together, for
    /// `StartProjectCardCopyParityTests.flat`'s reason.
    private func flat(_ relative: String) throws -> String {
        let url = try repoRoot().appendingPathComponent(relative)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw ParityError.missing(relative)
        }
        return try String(contentsOf: url, encoding: .utf8)
            .replacingOccurrences(of: "['`]\\s*\\+\\s*['`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "=\\s*\\n\\s*'", with: "= '", options: .regularExpression)
    }

    /// One web source as it is, for what the joining above would damage: a mark spelled `'+'` is
    /// exactly the shape it takes out.
    private func raw(_ relative: String) throws -> String {
        let url = try repoRoot().appendingPathComponent(relative)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw ParityError.missing(relative)
        }
        return try String(contentsOf: url, encoding: .utf8)
    }

    private func assertDeclares(_ web: String, _ name: String, _ value: String,
                                file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(web.contains("export const \(name) = '\(value)'"),
                      "\(name) drifted: the web no longer declares it as \(value.debugDescription)",
                      file: file, line: line)
    }

    private func assertSentence(_ web: String, _ rendered: String, _ values: [(String, String)],
                                _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        let template = values.reduce(rendered) { text, pair in
            text.replacingOccurrences(of: pair.0, with: pair.1)
        }
        XCTAssertTrue(web.contains("`\(template)`") || web.contains("`\(template)'"),
                      "\(what) drifted: the web no longer contains `\(template)`",
                      file: file, line: line)
    }

    // MARK: the card

    func testTheCardsFixedWordsMatchTheWeb() throws {
        let web = try flat(Self.words)
        assertDeclares(web, "CRITERIA_CHANGE_TITLE", CriteriaChanges.title)
        assertDeclares(web, "CRITERIA_CHANGE_WHAT_CHANGED", CriteriaChanges.whatChanged)
        assertDeclares(web, "CRITERIA_CHANGE_NEW", CriteriaChanges.newKind)
        assertDeclares(web, "CRITERIA_CHANGE_STRICTER", CriteriaChanges.stricterKind)
        assertDeclares(web, "CRITERIA_CHANGE_REVISED", CriteriaChanges.revisedKind)
        assertDeclares(web, "CRITERIA_CHANGE_RUNNING", CriteriaChanges.running)
        assertDeclares(web, "CRITERIA_CHANGE_EXPLAINS", CriteriaChanges.explains)
        assertDeclares(web, "CRITERIA_CHANGE_CHAT_PLACEHOLDER", CriteriaChanges.chatPlaceholder)
    }

    func testTheSentencesWithANumberInThemMatchTheWebWhole() throws {
        let web = try flat(Self.words)
        assertSentence(web, CriteriaChanges.was("METHOD"), [("METHOD", "${method}")],
                       "the check a stricter criterion replaced")
        assertSentence(web, CriteriaChanges.kind(23, "KIND"), [("23", "${ordinal}"), ("KIND", "${kind}")],
                       "which criterion, and what happened to it")
        assertSentence(web, CriteriaChanges.meta(projectTitle: Self.title, confirmedCount: 23,
                                                 count: 29, seal: Self.seal),
                       [(Self.title, "${projectTitle}"), (CriteriaChanges.running, "${CRITERIA_CHANGE_RUNNING}"),
                        ("23", "${confirmedCount}"), ("29", "${count}"), (Self.seal, "${seal}")],
                       "the meta line")
        assertSentence(web, CriteriaChanges.showAll(23), [("23", "${count}")], "the toggle to the whole set")
        assertSentence(web, CriteriaChanges.confirmLabel(23),
                       [("23", "${count}"), ("criteria", "${count === 1 ? 'criterion' : 'criteria'}")],
                       "the action")
        XCTAssertEqual(CriteriaChanges.confirmLabel(1), "Confirm 1 criterion")
    }

    /// The line under the list — the ones that read as confirmed, by number, and the ones that are
    /// gone, counted — and what a press confirmed, counted for its receipt.
    func testTheCountedLinesAreBuiltFromTheWebsWords() throws {
        let web = try flat(Self.words)
        XCTAssertTrue(web.contains("`${ordinals.join(', ')} unchanged`"),
                      "the web no longer numbers the unchanged criteria the way this end does")
        XCTAssertTrue(web.contains("`${removed} removed`"))
        XCTAssertTrue(web.contains("return [same, gone].filter(Boolean).join(' · ');"))
        XCTAssertEqual(CriteriaChanges.unchanged([1, 3, 4], removed: 1), "1, 3, 4 unchanged · 1 removed")

        XCTAssertTrue(web.contains("`${changes.added} new`"))
        XCTAssertTrue(web.contains("`${changes.stricter} stricter`"))
        XCTAssertTrue(web.contains("`${changes.revised} changed`"))
        XCTAssertTrue(web.contains("`${changes.removed} removed`"))
        XCTAssertTrue(web.contains("].filter(Boolean).join(', ');"),
                      "the web no longer joins what a press confirmed with ', '")
        XCTAssertEqual(CriteriaChanges.summary(added: 1, stricter: 1, revised: 1, removed: 1),
                       "1 new, 1 stricter, 1 changed, 1 removed")
    }

    /// The marks each row carries, in the order the rows are listed: new, stricter, changed.
    func testTheMarksAndTheOrderOfTheRowsAreTheWebs() throws {
        let card = try raw(Self.card)
        let new = try XCTUnwrap(card.range(of: "mark: '\(CriteriaChanges.Row.Mark.new.rawValue)'"),
                                "the web no longer marks a new criterion `+`")
        let stricter = try XCTUnwrap(card.range(of: "mark: '\(CriteriaChanges.Row.Mark.stricter.rawValue)'"),
                                     "the web no longer marks a stricter check `↑`")
        let revised = try XCTUnwrap(card.range(of: "mark: '\(CriteriaChanges.Row.Mark.revised.rawValue)'"),
                                    "the web no longer marks a changed criterion `~`")
        XCTAssertLessThan(new.lowerBound, stricter.lowerBound)
        XCTAssertLessThan(stricter.lowerBound, revised.lowerBound)
        // The stricter row's words are its check now, with the one it replaced under it.
        XCTAssertTrue(card.contains("text: change.verificationMethod,"))
        XCTAssertTrue(card.contains("was: criteriaChangeWas(change.confirmedVerificationMethod),"))
        // And the second action is the word the other composer handoffs share.
        XCTAssertTrue(card.contains("{OWNER_SEND_BACK_ACTION}"))
        // A refused press is said in the confirmation card's words at both ends.
        XCTAssertTrue(card.contains("title={CONFIRMATION_NOT_RECORDED}"))
    }
}
