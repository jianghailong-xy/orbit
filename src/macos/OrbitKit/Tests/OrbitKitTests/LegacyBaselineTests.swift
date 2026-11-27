import Foundation
import XCTest
@testable import OrbitKit

/// Today's drawn state on Mac and iPhone with the session facts absent (an older server): the glyph and word of the session
/// row, the header word, the task panel's run label and the section a row lands in, for every fixture row of
/// scripts/acceptance/session-three-state-check, against legacy-baseline.apple.json (recorded before any display change).
/// UPDATE_BASELINE=<file> writes the file instead of comparing.
final class LegacyBaselineTests: XCTestCase {
    private let dir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("scripts/acceptance/session-three-state-check")

    private func measure() throws -> [String: Any] {
        let now = Date(timeIntervalSince1970: 1_795_000_000)
        let rows = try JSONSerialization.jsonObject(with: Data(contentsOf: dir.appendingPathComponent("fixture.json"))) as! [[String: Any]]
        var out: [[String: Any]] = []
        for r in rows where (r["newFields"] as! Bool) == false {
            let payload = r["payload"] as! [String: Any]
            let data = try JSONSerialization.data(withJSONObject: payload)
            let s = try JSONDecoder().decode(Session.self, from: data)
            let glyph = SessionStatusGlyph.make(for: s, now: now)
            let shape: String
            switch glyph.shape {
            case .spinner: shape = "spinner"
            case .symbol(let name): shape = name
            }
            let section = SessionTimeGrouping.sections([s], now: now).first?.title ?? ""
            out.append(["name": r["name"]!, "icon": shape, "tone": glyph.tone.rawValue, "glyphLabel": glyph.label,
                        "word": SessionHeader.statusWord(for: s, now: now),
                        "runBadge": ShareMarkdown.runLabel(try JSONDecoder().decode(SessionRef.self, from: data)),
                        "needsYouGroup": section == "Needs you", "workingGroup": section == "Working"])
        }
        return ["rows": out]
    }

    func testDrawsTodaysIconAndWordForEveryFixtureRowWithTheFactsAbsent() throws {
        let got = try measure()
        let gotData = try JSONSerialization.data(withJSONObject: got, options: [.prettyPrinted, .sortedKeys])
        if let out = ProcessInfo.processInfo.environment["UPDATE_BASELINE"] {
            try (gotData + Data("\n".utf8)).write(to: URL(fileURLWithPath: out))
            return
        }
        let want = try JSONSerialization.jsonObject(with: Data(contentsOf: dir.appendingPathComponent("legacy-baseline.apple.json"))) as! NSDictionary
        XCTAssertEqual(try JSONSerialization.jsonObject(with: gotData) as! NSDictionary, want)
    }
}
