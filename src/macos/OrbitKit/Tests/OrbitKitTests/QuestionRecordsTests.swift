import Foundation
import XCTest
@testable import OrbitKit

/// The answered question card reads one answer the way the browser does.
///
/// `QuestionRecords` is a hand-copy of `@orbit/shared`'s `questionRecord.ts`, and
/// `src/shared/src/question-record.fixture.json` is the contract: the shared spec proves the
/// browser's reader against it, and this proves OrbitKit's against the same file — the outcome of
/// every case, the line the folded card writes for it, a question's opening, and the fixed words.
/// A missing fixture is a FAILURE, never an `XCTSkip`: a check that opts out quietly reports green on
/// exactly the day the thing it watches goes missing.
final class QuestionRecordsTests: XCTestCase {

    private static let fixturePath = "src/shared/src/question-record.fixture.json"

    private struct Fixture: Decodable {
        let copy: [String: String]
        let lead: [Lead]
        let outcome: [Case]
    }
    private struct Lead: Decodable {
        let question: String
        let lead: String
    }
    private struct Case: Decodable {
        let name: String
        let questions: JSONValue
        let result: String?
        let isError: Bool
        let outcome: Outcome?
        let lines: [String?]
    }
    private struct Outcome: Decodable {
        let kind: String
        let answers: [Answer?]?
        let words: String?
    }
    private struct Answer: Decodable {
        let picked: [Int]
        let typed: String?
    }

    private func fixture() throws -> Fixture {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let url = dir.appendingPathComponent(Self.fixturePath)
            if FileManager.default.fileExists(atPath: url.path) {
                return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
            }
            dir = dir.deletingLastPathComponent()
        }
        XCTFail("\(Self.fixturePath) was not found above this test file. The answered question card is "
                + "read the same way on both clients only while both read this file; if it moved, move "
                + "this check with it rather than deleting it.")
        throw CocoaError(.fileNoSuchFile)
    }

    private func expected(_ outcome: Outcome?) -> QuestionOutcome? {
        guard let outcome else { return nil }
        if outcome.kind == "replied" { return .replied(outcome.words ?? "") }
        return .answered((outcome.answers ?? []).map { $0.map { QuestionAnswer(picked: $0.picked, typed: $0.typed) } })
    }

    func testEveryCaseReadsAsTheFixtureSays() throws {
        let cases = try fixture().outcome
        XCTAssertGreaterThan(cases.count, 10)
        for c in cases {
            let questions = Approvals.parseQuestions(from: .object(["questions": c.questions]))
            let outcome = QuestionRecords.outcome(questions: questions, result: c.result, isError: c.isError)
            XCTAssertEqual(outcome, expected(c.outcome), c.name)
            let lines: [String?]
            switch outcome {
            case .answered(let answers)?:
                lines = questions.indices.map { QuestionRecords.answerLine(questions[$0], answers[$0]) }
            case .replied(let words)?:
                lines = [QuestionRecords.replyLine(words)]
            case nil:
                lines = []
            }
            XCTAssertEqual(lines, c.lines, c.name)
        }
    }

    func testOpeningsCollapseAsTheFixtureSays() throws {
        for c in try fixture().lead {
            XCTAssertEqual(QuestionRecords.lead(c.question), c.lead)
        }
    }

    func testWordsAreTheFixtures() throws {
        let copy = try fixture().copy
        XCTAssertEqual(copy, [
            "repliedInChat": QuestionRecords.repliedInChat,
            "yourAnswer": QuestionRecords.yourAnswer,
            "multipleChoice": QuestionRecords.multipleChoice,
        ])
    }
}
