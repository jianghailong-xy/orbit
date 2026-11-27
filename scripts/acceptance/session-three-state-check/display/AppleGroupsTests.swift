import Foundation
import XCTest
@testable import OrbitKit

// Needs you / Working membership only: runs unchanged on the tip and on the commit before the display change.
// Copy to src/macos/OrbitKit/Tests/OrbitKitTests/ and run with ROWS=<rows.json> OUT=<result.json>.
final class AppleGroupsTests: XCTestCase {
    func testWriteGroups() throws {
        let env = ProcessInfo.processInfo.environment
        let rows = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: env["ROWS"]!))) as! [[String: Any]]
        var out: [[String: Any]] = []
        for r in rows where ["fixture", "listRow"].contains(r["kind"] as! String) {
            let data = try JSONSerialization.data(withJSONObject: r["payload"] as! [String: Any])
            let s = try JSONDecoder().decode(Session.self, from: data)
            let titles = SessionTimeGrouping.sections([s], now: Date(timeIntervalSince1970: 1_795_000_000)).map(\.title)
            out.append(["id": r["id"]!, "needsYou": titles.contains("Needs you"), "working": titles.contains("Working")])
        }
        try JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: env["OUT"]!))
    }
}
