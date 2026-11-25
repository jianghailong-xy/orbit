import Foundation
import XCTest
@testable import OrbitKit

// Copy to src/macos/OrbitKit/Tests/OrbitKitTests/ of the checkout under test and run with ROWS=<rows.json> OUT=<result.json>.
// Mac and iPhone share OrbitKit's two functions; the phone row draws `phoneRowMarks` of them (AgentsView), the Mac row all
// of them (AgentSessionRow). Each payload kind is decoded as the type the app decodes it as.
final class AppleDisplayTests: XCTestCase {
    private static let now = Date(timeIntervalSince1970: 1_795_000_000)

    func testWriteDisplay() throws {
        let env = ProcessInfo.processInfo.environment
        let rows = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: env["ROWS"]!))) as! [[String: Any]]
        var out: [[String: Any]] = []
        for r in rows {
            let kind = r["kind"] as! String
            var payload = r["payload"] as! [String: Any]
            // session.ended names its session `sessionId`; its facts are read here under the ref's `id`.
            if kind == "sessionEnded", payload["id"] == nil { payload["id"] = payload["sessionId"] ?? "s" }
            let data = try JSONSerialization.data(withJSONObject: payload)
            var row: [String: Any] = ["id": r["id"]!, "client": "apple"]
            do { try fill(&row, kind: kind, data: data) } catch { row["error"] = "\(error)" }
            out.append(row)
        }
        try JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: env["OUT"]!))
    }

    private func put(_ row: inout [String: Any], _ facts: SessionDisplayFacts) {
        let state = SessionDisplay.state(facts)
        let marks = SessionDisplay.marks(facts)
        row["state"] = state?.word ?? NSNull()
        row["marks"] = marks.map { $0.map(\.word) } ?? NSNull()
        if let marks {
            let phone = SessionDisplay.phoneRowMarks(marks)
            row["phoneMarks"] = phone.shown.map(\.word) + (phone.more.map { [$0] } ?? [])
        }
        if let state { row["drawnIcon"] = state.glyph.label }
    }

    /// "Ana · Idle · Finished · Completed" -> the state and the marks it writes after the owner.
    private func parsed(_ line: String, owner: String) -> [String: Any] {
        var parts = line.components(separatedBy: " \u{00B7} ")
        if parts.first == owner { parts.removeFirst() }
        return ["state": parts.first ?? "", "marks": parts.dropFirst().filter { $0 != "Completed" }]
    }

    private func fill(_ row: inout [String: Any], kind: String, data: Data) throws {
        let d = JSONDecoder()
        var surfaces: [String: String] = [:]
        switch kind {
        case "fixture", "listRow", "detail":
            let s = try d.decode(Session.self, from: data)
            put(&row, s.displayFacts)
            surfaces["header"] = SessionHeader.headerWord(for: s, now: Self.now)
            surfaces["rowValue"] = SessionDisplay.state(s.displayFacts).map { SessionDisplay.spoken($0, SessionDisplay.marks(s.displayFacts) ?? []) }
                ?? SessionHeader.statusWord(for: s, now: Self.now)
            let run = try d.decode(SessionRef.self, from: data)
            surfaces["runBadge"] = ShareMarkdown.runLabel(run)
            surfaces["markdownRun"] = surfaces["runBadge"]
            let section = SessionTimeGrouping.sections([s], now: Self.now).map(\.title)
            row["group"] = ["needsYou": section.contains("Needs you"), "working": section.contains("Working")]
        case "taskRun", "sessionSummary", "sessionEnded":
            let run = try d.decode(SessionRef.self, from: data)
            put(&row, run.displayFacts)
            surfaces["runBadge"] = ShareMarkdown.runLabel(run)
        case "linkPreview":
            let preview = try d.decode(LinkPreviewSession.self, from: data)
            put(&row, preview.displayFacts)
            let ref = OrbitLinkRef(target: OrbitLinkTarget(kind: .session, id: "s"), source: .reference("orbit-session:s"))
            let card = OrbitLinkCardContent.preview(ref, LinkPreview(kind: .session, id: "s", state: .ok, session: preview,
                                                                    task: nil, project: nil, list: nil),
                                                    host: "orbitd.io", now: Self.now)
            surfaces["linkCard"] = (card.sessionGlyph.map(\.label) ?? "") + card.sessionMarks.map { " · " + $0.word }.joined()
        case "guestRow":
            let g = try d.decode(GuestSessionSummary.self, from: data)
            put(&row, g.state.displayFacts)
            // The Shared with me row's second line, as MainView / CompactShell draw it: "Ana · Idle · Finished".
            let line = SharedWithMe.subtitle(g)
            surfaces["sharedWithMe"] = line
            row["drawn"] = ["sharedWithMe": parsed(line, owner: g.ownerName)]
        case "sharedHead":
            let g = try d.decode(GuestSession.self, from: data)
            put(&row, g.state.displayFacts)
            // The guest head (GuestSessionView.headBadges): the state pill and the marks from the two functions, else the old pill.
            let state = SessionDisplay.state(g.state.displayFacts)
            let marks = SessionDisplay.marks(g.state.displayFacts) ?? []
            let word = state?.word ?? g.state.word
            surfaces["sharedPage"] = ([word] + marks.map(\.word)).joined(separator: " · ")
            row["drawn"] = ["sharedHead": ["state": word, "marks": marks.map(\.word)]]
        case "searchHit":
            let hit = try d.decode(SessionSearchHit.self, from: data)
            put(&row, hit.displayFacts)
            // SessionSearchRow: the glyph's label, then the marks.
            let word = (SessionDisplay.state(hit.displayFacts)?.glyph ?? SessionStatusGlyph.make(runState: hit.effectiveRunState)).label
            let marks = (SessionDisplay.marks(hit.displayFacts) ?? []).map(\.word)
            surfaces["search"] = ([word] + marks).joined(separator: " · ")
            row["drawn"] = ["search": ["state": word, "marks": marks]]
        default:
            XCTFail("unknown kind \(kind)")
        }
        row["surfaces"] = surfaces
    }
}
