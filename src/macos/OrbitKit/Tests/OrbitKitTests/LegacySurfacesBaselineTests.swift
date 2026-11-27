import Foundation
import XCTest
@testable import OrbitKit

/// The surfaces LegacyBaselineTests does not measure, drawn with the session facts absent (an older server): the
/// conversation header's word and subtitle, the session link card's glyph and the search row's glyph, for every
/// facts-absent fixture row of scripts/acceptance/session-three-state-check, against legacy-surfaces.apple.json
/// (recorded on the project branch before the display change). UPDATE_BASELINE=<file> writes the file instead.
final class LegacySurfacesBaselineTests: XCTestCase {
    private let dir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("scripts/acceptance/session-three-state-check")

    private func glyph(_ g: SessionStatusGlyph?) -> [String: Any] {
        guard let g else { return [:] }
        let shape: String
        switch g.shape {
        case .spinner: shape = "spinner"
        case .symbol(let name): shape = name
        }
        return ["icon": shape, "tone": g.tone.rawValue, "label": g.label]
    }

    private func measure() throws -> [String: Any] {
        let now = Date(timeIntervalSince1970: 1_795_000_000)
        let rows = try JSONSerialization.jsonObject(with: Data(contentsOf: dir.appendingPathComponent("fixture.json"))) as! [[String: Any]]
        var out: [[String: Any]] = []
        for r in rows where (r["newFields"] as! Bool) == false {
            let data = try JSONSerialization.data(withJSONObject: r["payload"] as! [String: Any])
            let s = try JSONDecoder().decode(Session.self, from: data)
            let preview = try JSONDecoder().decode(LinkPreviewSession.self, from: data)
            let hit = try JSONDecoder().decode(SessionSearchHit.self, from: data)
            let ref = OrbitLinkRef(target: OrbitLinkTarget(kind: .session, id: "s"), source: .reference("orbit-session:s"))
            let card = OrbitLinkCardContent.preview(ref, LinkPreview(kind: .session, id: "s", state: .ok, session: preview,
                                                                     task: nil, project: nil, list: nil),
                                                    host: "orbitd.io", now: now)
            out.append(["name": r["name"]!,
                        "headerWord": SessionHeader.headerWord(for: s, now: now),
                        "subtitle": SessionHeader.subtitle(for: s, now: now) ?? "",
                        "linkCard": glyph(card.sessionGlyph),
                        "search": glyph(SessionStatusGlyph.make(runState: hit.effectiveRunState))])
        }
        return ["rows": out]
    }

    func testHeaderLinkCardAndSearchDrawTodaysStateForEveryFixtureRowWithTheFactsAbsent() throws {
        let got = try measure()
        let gotData = try JSONSerialization.data(withJSONObject: got, options: [.prettyPrinted, .sortedKeys])
        if let out = ProcessInfo.processInfo.environment["UPDATE_BASELINE"] {
            try (gotData + Data("\n".utf8)).write(to: URL(fileURLWithPath: out))
            return
        }
        let want = try JSONSerialization.jsonObject(with: Data(contentsOf: dir.appendingPathComponent("legacy-surfaces.apple.json"))) as! NSDictionary
        XCTAssertEqual(try JSONSerialization.jsonObject(with: gotData) as! NSDictionary, want)
    }
}
