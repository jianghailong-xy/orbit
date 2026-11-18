import Foundation
import XCTest
@testable import OrbitKit

/// iOS/macOS failure lines are the web's and Android's (docs/ux/translation-failure-policy.html, frame 7's B column).
///
/// `src/shared/src/translation-failure-lines.fixture.json` is the contract: translationFailureLines.spec.ts holds it to the
/// board and proves the web's table against it, Android's TranslationFailureLinesParityTest its copy, and this proves
/// `TranslationCopy.sendFailed(_:httpStatus:answer:)` against the same file: every reason (and HTTP status) on a held message
/// and on a card answer, the generic line for none, NO_KEY or a reason this build does not know, and the composer tag.
/// A missing fixture is a failure, never a skip.
final class TranslationFailureLinesParityTests: XCTestCase {
    private static let fixturePath = "src/shared/src/translation-failure-lines.fixture.json"

    private struct Fixture: Decodable {
        struct Case: Decodable { let name: String; let reason: String?; let httpStatus: Int?; let message: String; let answer: String }
        let unavailableTag: String
        let cases: [Case]
    }

    private func fixture() throws -> Fixture {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(Self.fixturePath)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: candidate))
            }
            dir = dir.deletingLastPathComponent()
        }
        XCTFail("\(Self.fixturePath) was not found above this test file; if it moved, move this check with it.")
        throw CocoaError(.fileNoSuchFile)
    }

    func testEveryCaseDrawsTheFixturesSentence() throws {
        let f = try fixture()
        XCTAssertGreaterThan(f.cases.count, 10, "the fixture lost its cases")
        for c in f.cases {
            // As the wire reads it: a reason this build does not know is no reason.
            let reason = c.reason.flatMap(TranslationFailureReason.init(rawValue:))
            XCTAssertEqual(TranslationCopy.sendFailed(reason, httpStatus: c.httpStatus), c.message, "\(c.name) on a held message")
            XCTAssertEqual(TranslationCopy.sendFailed(reason, httpStatus: c.httpStatus, answer: true), c.answer,
                           "\(c.name) on a card answer")
        }
        XCTAssertEqual(Set(f.cases.compactMap { $0.reason.flatMap(TranslationFailureReason.init(rawValue:)) }),
                       Set(TranslationFailureReason.allCases))
    }

    func testTheComposerTagIsTheFixtures() throws {
        let f = try fixture()
        XCTAssertEqual(TranslationCopy.unavailableTag, f.unavailableTag)
        XCTAssertEqual(TranslationLanguage.zhHans.tag(to: .en, unavailable: true), "Chinese → English · \(f.unavailableTag)")
    }
}
