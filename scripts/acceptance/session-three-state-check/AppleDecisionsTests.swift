import Foundation
import XCTest
@testable import OrbitKit

// Copy to src/macos/OrbitKit/Tests/OrbitKitTests/ of the checkout under test and run with FIXTURE=<fixture.json> OUT=<result.json>.
final class AppleDecisionsTests: XCTestCase {
    func testWriteDecisions() throws {
        let env = ProcessInfo.processInfo.environment
        let rows = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: env["FIXTURE"]!))) as! [[String: Any]]
        var out: [[String: Any]] = []
        for r in rows {
            let payload = r["payload"] as! [String: Any]
            let data = try JSONSerialization.data(withJSONObject: payload)
            let s = try JSONDecoder().decode(Session.self, from: data)
            var caps: SessionCapabilities? = nil
            if let c = payload["capabilities"] { caps = try JSONDecoder().decode(SessionCapabilities.self, from: JSONSerialization.data(withJSONObject: c)) }
            let status = s.effectiveRunStatus
            let blocked = ComposerLogic.availability(status: status, capabilities: caps) == .blocked
            let resume = ComposerLogic.shouldResume(status: status, released: s.released, capabilities: caps)
            let send = blocked ? "BLOCK" : (resume ? "RESUME" : "SEND")
            out.append(["name": r["name"]!, "newFields": r["newFields"]!, "send": send,
                        "waitOver": s.isReleased, "run": ShareMarkdown.runLabel(try JSONDecoder().decode(SessionRef.self, from: data)), "word": SessionHeader.headerWord(for: s)])
        }
        try JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: env["OUT"]!))
    }
}
