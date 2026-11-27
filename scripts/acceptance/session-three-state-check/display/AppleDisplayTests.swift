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
        // The list row of each case, which a `session.updated` summary is folded into.
        let listRows = Dictionary(uniqueKeysWithValues: rows.filter { $0["kind"] as! String == "listRow" }
            .map { ($0["name"] as! String, $0["payload"] as! [String: Any]) })
        for r in rows {
            let kind = r["kind"] as! String
            let payload = r["payload"] as! [String: Any]
            let data = try JSONSerialization.data(withJSONObject: payload)
            var row: [String: Any] = ["id": r["id"]!, "client": "apple"]
            do {
                switch kind {
                case "sessionSummary": try fillSummary(&row, summary: payload, listRow: listRows[r["name"] as! String]!, starting: true)
                case "sessionSummaryCleared": try fillSummary(&row, summary: payload, listRow: listRows[r["name"] as! String]!, starting: false)
                // `session.ended` only takes the row off the Open list (ControlEventRoute `.sessionLeft`): nothing reads its facts.
                case "sessionEnded": row["notRead"] = "the row leaves the list"
                default: try fill(&row, kind: kind, data: data)
                }
            } catch { row["error"] = "\(error)" }
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

    /// `session.updated` as the Open list takes it (OpenRowChange.merging), the summary folded into the held row. `starting`:
    /// the held row was listed before any background work showed (no `activity`, no `runningBgCount`), so the summary has to
    /// add the mark. Otherwise the held row is the case as listed and the summary says the work ended, so it has to clear it.
    /// A summary that asks for a snapshot instead is read from the next list, so it says nothing of its own.
    private func fillSummary(_ row: inout [String: Any], summary: [String: Any], listRow: [String: Any], starting: Bool) throws {
        var before = listRow
        if starting {
            before["activity"] = nil
            before["runningBgCount"] = 0
        }
        var event = summary
        event["id"] = event["id"] ?? before["id"]
        let held = try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: before))
        let update = try JSONDecoder().decode(ControlSessionSummary.self, from: JSONSerialization.data(withJSONObject: event))
        switch OpenRowChange.merging(update, into: [held]) {
        case .replace(_, let merged): put(&row, merged.displayFacts)
        case .unchanged: put(&row, held.displayFacts)
        case .needsSnapshot: row["notRead"] = "the list is read again"
        }
    }

    /// "Ana · Idle · Finished · Completed" -> the state and the marks it writes after the owner.
    private func parsed(_ line: String, owner: String) -> [String: Any] {
        var parts = line.components(separatedBy: " \u{00B7} ")
        if parts.first == owner { parts.removeFirst() }
        return ["state": parts.first ?? "", "marks": parts.dropFirst().filter { $0 != "Completed" }]
    }

    /// "Idle · Finished" -> the state and the marks.
    private func split(_ text: String) -> [String: Any] {
        let parts = text.components(separatedBy: " \u{00B7} ")
        return ["state": parts.first ?? "", "marks": Array(parts.dropFirst())]
    }

    /// "- Idle · Finished · Nov 24 · orbit-ws01" -> "Idle · Finished".
    private func runsLine(_ line: String) -> String {
        String(line.dropFirst(2)).components(separatedBy: " \u{00B7} ").dropLast(2).joined(separator: " \u{00B7} ")
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
        case "taskRun":
            let run = try d.decode(SessionRef.self, from: data)
            put(&row, run.displayFacts)
            surfaces["runBadge"] = ShareMarkdown.runLabel(run)
            // Copy as Markdown, the whole builder: the task's Runs line for this run.
            var listed = try JSONSerialization.jsonObject(with: data) as! [String: Any]
            listed["createdAt"] = nil
            listed["agent"] = ["id": "w", "name": "orbit-ws01"]
            let taskData = try JSONSerialization.data(withJSONObject: ["id": "t", "title": "T", "status": "IN_PROGRESS", "sessions": [listed]])
            let markdown = ShareMarkdown.task(try d.decode(TaskItem.self, from: taskData), link: "https://orbit/t") { _ in "Nov 24" }
            surfaces["markdownRun"] = markdown.split(separator: "\n").map(String.init)
                .first { $0.hasPrefix("- ") && $0.hasSuffix("orbit-ws01") } ?? "(no Runs line)"
            row["drawn"] = ["taskRun": split(surfaces["runBadge"]!), "markdown": split(runsLine(surfaces["markdownRun"]!))]
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
