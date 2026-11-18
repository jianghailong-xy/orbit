import Foundation
import XCTest
@testable import OrbitKit

/// "Show both languages", interleaved (docs/mocks/session-translation/03-interleaved.png): how a reply
/// and its translation pair block by block on iOS and macOS against the web and Android.
/// `src/shared/src/bilingual-pairs.fixture.json` is the contract — @orbit/shared walks it through
/// `bilingualPairs` (translation.spec.ts), Android core through `Translation.bilingualPairs`, and this
/// through `BilingualPairs.pairs`. The file is looked up by walking up from this one, and a missing
/// file is a FAILURE, never an `XCTSkip`.
final class BilingualPairsFixtureTests: XCTestCase {

    private static let fixturePath = "src/shared/src/bilingual-pairs.fixture.json"

    private struct Missing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "\(path) was not found above this test file. It is what this client's interleaved replies are "
                + "proved against — if it moved, point this check at its new home rather than deleting it."
        }
    }

    private struct Fixture: Decodable { let cases: [Case] }
    private struct Case: Decodable {
        let name: String
        let translation: String
        let original: String
        let pairs: [BilingualPairs.Pair]?
    }

    private func cases() throws -> [Case] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(Self.fixturePath)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: candidate)).cases
            }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(path: Self.fixturePath)
    }

    func testEverySharedCasePairsAsTheWebPairsIt() throws {
        let all = try cases()
        XCTAssertFalse(all.isEmpty, "the shared fixture has no cases in it")
        for kind in ["paragraphs", "headings", "nested lists", "code blocks", "merged two paragraphs"] {
            XCTAssertTrue(all.contains { $0.name.contains(kind) }, "the fixture lost its \(kind) case")
        }
        for c in all {
            XCTAssertEqual(BilingualPairs.pairs(c.translation, c.original), c.pairs, c.name)
        }
    }

    func testAReplyPairsOnlyWithBothLanguagesOnAndATranslation() {
        let done = ReplyTranslation(lang: .zhHans, text: "第一段\n\n第二段")
        XCTAssertEqual(SessionTranslation.replyPairs("One\n\nTwo", done, bilingual: true)?.map(\.original), ["One", "Two"])
        XCTAssertNil(SessionTranslation.replyEnglish("One\n\nTwo", done, bilingual: true), "interleaved: no whole English")
        XCTAssertNil(SessionTranslation.replyPairs("One\n\nTwo", done, bilingual: false))
        XCTAssertNil(SessionTranslation.replyPairs("One\n\nTwo", nil, bilingual: true))
        // Merged paragraphs do not pair: the reply is drawn whole, as before.
        let merged = ReplyTranslation(lang: .zhHans, text: "第一段和第二段")
        XCTAssertNil(SessionTranslation.replyPairs("One\n\nTwo", merged, bilingual: true))
        XCTAssertEqual(SessionTranslation.replyEnglish("One\n\nTwo", merged, bilingual: true), "One\n\nTwo")
    }

    func testAnOrderedItemKeepsItsNumber() {
        XCTAssertEqual(BilingualPairs.Pair(kind: .item, depth: 0, marker: "3.", text: "x").number, 3)
        XCTAssertEqual(BilingualPairs.Pair(kind: .item, depth: 0, marker: "12)", text: "x").number, 12)
        XCTAssertNil(BilingualPairs.Pair(kind: .item, depth: 0, marker: "-", text: "x").number)
    }
}
