import Foundation
import XCTest
@testable import OrbitKit

/// The owner's "Chat about this" reply to a card is read back the way the browser reads it.
/// `src/shared/src/owner-chat-reply.fixture.json` is the contract: the runner writes it, the shared
/// spec proves the browser's reader against it, and this proves OrbitKit's. A missing fixture is a
/// failure, never a skip.
final class OwnerChatReplyTests: XCTestCase {

    private static let fixturePath = "src/shared/src/owner-chat-reply.fixture.json"

    private struct Fixture: Decodable {
        let writerWords: String
        let cases: [Case]
    }
    private struct Case: Decodable {
        let name: String
        let result: String
        let words: String?
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
        XCTFail("\(Self.fixturePath) was not found above this test file.")
        throw CocoaError(.fileNoSuchFile)
    }

    func testEveryCaseReadsAsTheFixtureSays() throws {
        for c in try fixture().cases {
            XCTAssertEqual(OwnerChatReply.words(c.result), c.words, c.name)
        }
    }

    /// Only Orbit's own calls carry such a reply, and one that failed carries none.
    func testOnlyOrbitsOwnCallsAreRead() throws {
        let reply = try fixture().cases[0].result
        func card(_ name: String, _ status: ToolStatus) -> ToolCard {
            ToolCard(id: "t1", name: name, input: .object([:]), result: reply, status: status)
        }
        XCTAssertNotNil(OwnerChatReply.words(of: card("mcp__orbit__project_create", .ok)))
        XCTAssertNil(OwnerChatReply.words(of: card("Bash", .ok)))
        XCTAssertNil(OwnerChatReply.words(of: card("mcp__orbit__project_create", .error)))
    }
}
