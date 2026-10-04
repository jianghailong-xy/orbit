import Foundation
import XCTest
@testable import OrbitKit

/// Android and OrbitKit consume the same synthetic wire corpus, with independent reducers.
final class RealtimeRecoveryFixtureTests: XCTestCase {
    private struct Corpus: Decodable { let cases: [Case] }
    private struct Case: Decodable {
        let name: String
        let events: [RunEvent]
        let expected: Expected
    }
    private struct Expected: Decodable {
        let maxSeq: Int
        let messages: [String]
        let tools: [String]
        let draft: String
    }

    func testSharedRecoveryCorpus() throws {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        var source: URL?
        for _ in 0..<12 {
            let candidate = directory.appendingPathComponent("src/shared/src/realtime-recovery.fixture.json")
            if FileManager.default.fileExists(atPath: candidate.path) { source = candidate; break }
            directory.deleteLastPathComponent()
        }
        let corpus = try JSONDecoder().decode(Corpus.self, from: Data(contentsOf: XCTUnwrap(source)))
        for test in corpus.cases {
            var reducer = TranscriptReducer()
            for event in test.events { reducer.apply(event) }
            let state = reducer.state
            let messages: [String] = state.items.compactMap { item in
                if let user = item.asUser { return "user:" + user.text }
                if let assistant = item.asAssistant, assistant.isFinalized { return "assistant:" + assistant.displayText }
                return nil
            }
            let tools = state.items.compactMap { item -> String? in
                guard let tool = item.asTool, let result = tool.result else { return nil }
                return tool.id + ":" + result
            }
            let draft = state.items.compactMap { $0.asAssistant }
                .filter { !$0.isFinalized }.map(\.displayText).joined()
            XCTAssertEqual(state.maxSeq, test.expected.maxSeq, test.name)
            XCTAssertEqual(messages, test.expected.messages, test.name)
            XCTAssertEqual(tools, test.expected.tools, test.name)
            XCTAssertEqual(draft, test.expected.draft, test.name)
        }
    }
}
