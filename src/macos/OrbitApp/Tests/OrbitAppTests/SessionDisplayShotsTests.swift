import AppKit
import SwiftUI
import XCTest
import OrbitKit
@testable import OrbitApp

/// ImageRenderer frames of the approved board's fixture rows (docs/mocks/session-display-three-states) on the Mac, from
/// the real views: the sidebar's `AgentSessionRow` grouped by `SessionTimeGrouping`, the status bar's
/// `SessionHeaderStateLine`, the session link card's `SessionStatusPill` and marks from `OrbitLinkCardContent`, and the
/// shared Markdown Runs line from `ShareMarkdown.runLabel`. Fed the comparison rig's payloads
/// (scripts/acceptance/session-three-state-check/fixture.json) with the session facts and, for the list, without them
/// (an older server). PNGs land in `src/macos/build/evidence/session-display-macos/` (gitignored).
@MainActor
final class SessionDisplayShotsTests: XCTestCase {
    private static let cases = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33, 35]
    private static let titles: [Int: String] = [
        1: "Translate the help pages", 3: "Fix the login redirect", 5: "Tidy the settings page", 7: "Sketch the onboarding flow",
        9: "Task: Add the export button", 11: "Upgrade the date library", 13: "Draft the release notes", 15: "Run the full test suite",
        17: "Clean up old branches", 19: "Index the wiki", 21: "Profile the slow query", 23: "Rename the CLI flags",
        25: "Review the API errors", 27: "Nightly build report", 29: "Split the settings module", 31: "Watch the nightly build",
        33: "Old runner session", 35: "Old runner session (released)",
    ]
    private static let userLines: [Int: String] = [7: "Add a step for the invite.", 11: "Upgrade it and run the tests.",
                                                   25: "Check the 4xx mapping."]
    private static let replies: [Int: String] = [
        5: "Done: the three toggles now share one switch.", 9: "The export button is in, with its test.",
        13: "The notes are in docs/releases.", 21: "The slow part is the join on tags.",
        23: "Renamed, and the old names still work.", 33: "The cache is warm now.", 35: "The cache is warm now.",
    ]
    private static let minutes = [0, 1, 2, 4, 6, 9, 15, 22, 30, 36, 45, 50, 60, 120, 180, 300, 1440, 2880]

    private var root: URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<10 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("src/macos/OrbitApp/Package.swift").path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        return dir
    }

    private var evidenceDir: URL {
        let out = root.appendingPathComponent("src/macos/build/evidence/session-display-macos")
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        return out
    }

    /// The fixture payload of one case (or of its facts-absent twin), shaped as a list row with the board's title,
    /// preview and time.
    private func payload(_ row: Int, facts: Bool, now: Date) throws -> Data {
        let url = root.appendingPathComponent("scripts/acceptance/session-three-state-check/fixture.json")
        let rows = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [[String: Any]]
        var p = rows[(facts ? row : row + 1) - 1]["payload"] as! [String: Any]
        let at = ISO8601DateFormatter().string(from: now.addingTimeInterval(-Double(Self.minutes[Self.cases.firstIndex(of: row)!]) * 60))
        p["id"] = String(format: "S%02d", row)
        p["title"] = Self.titles[row]
        p["agentId"] = "a1"
        p["lastTurnAt"] = at
        p["updatedAt"] = at
        p["createdAt"] = at
        p["lastUserText"] = Self.userLines[row]
        p["lastAssistantText"] = Self.replies[row]
        if p["lifecycleState"] == nil { p["lifecycleState"] = "OPEN" }
        return try JSONSerialization.data(withJSONObject: p)
    }

    private func write<V: View>(_ name: String, _ view: V, width: CGFloat) throws {
        let content = view
            .padding(20)
            .frame(width: width, alignment: .topLeading)
            .background(Color(nsColor: .windowBackgroundColor))
            .environment(\.colorScheme, .light)
        let renderer = ImageRenderer(content: content)
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.nsImage, "ImageRenderer produced no image for \(name)")
        let rep = try XCTUnwrap(NSBitmapImageRep(data: try XCTUnwrap(image.tiffRepresentation)))
        let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
        try png.write(to: evidenceDir.appendingPathComponent("\(name).png"))
        XCTAssertGreaterThan(png.count, 1_000, "\(name) looks empty")
    }

    private func list(facts: Bool) throws {
        let now = Date()
        let sessions = try Self.cases.map { try JSONDecoder().decode(Session.self, from: payload($0, facts: facts, now: now)) }
        let app = AppModel()
        let view = VStack(alignment: .leading, spacing: 0) {
            Text(facts ? "After: the session facts" : "Older server: the facts absent")
                .font(.headline).padding(.bottom, 8)
            ForEach(SessionTimeGrouping.sections(sessions, now: now), id: \.title) { section in
                Text(section.title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    .padding(.top, 10).padding(.bottom, 2).padding(.leading, 16)
                ForEach(section.sessions) { session in
                    AgentSessionRow(session: session)
                    Divider().padding(.leading, 44)
                }
            }
        }
        .environment(app)
        try write(facts ? "mac-list-after" : "mac-list-older-server", view, width: 380)
    }

    func testListWithTheFacts() throws { try list(facts: true) }
    func testListWithTheFactsAbsent() throws { try list(facts: false) }

    /// One line per case: the status bar's header line, the link card's state pill and marks, and the Markdown Runs line.
    func testHeaderLinkCardAndMarkdownWithTheFacts() throws {
        let now = Date()
        let ref = OrbitLinkRef(target: OrbitLinkTarget(kind: .session, id: "s"), source: .reference("orbit-session:s"))
        struct Line: Identifiable {
            let id: Int
            let session: Session
            let card: OrbitLinkCardContent
            let markdown: String
        }
        var lines: [Line] = []
        for row in Self.cases {
            let data = try payload(row, facts: true, now: now)
            let session = try JSONDecoder().decode(Session.self, from: data)
            let preview = try JSONDecoder().decode(LinkPreviewSession.self, from: data)
            let card = OrbitLinkCardContent.preview(ref, LinkPreview(kind: .session, id: "s", state: .ok, session: preview,
                                                                     task: nil, project: nil, list: nil),
                                                    host: "orbitd.io", now: now)
            let run = try JSONDecoder().decode(SessionRef.self, from: data)
            lines.append(Line(id: row, session: session, card: card, markdown: ShareMarkdown.runLabel(run)))
        }
        let view = VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Row · case").frame(width: 230, alignment: .leading)
                Text("Header (status bar)").frame(width: 300, alignment: .leading)
                Text("Link card").frame(width: 220, alignment: .leading)
                Text("Markdown Runs line").frame(width: 260, alignment: .leading)
            }
            .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            ForEach(lines) { line in
                let row = line.id, session = line.session, card = line.card, markdown = line.markdown
                HStack {
                    Text("\(row) · \(Self.titles[row] ?? "")").font(.caption).frame(width: 230, alignment: .leading)
                    Group {
                        if let state = SessionDisplay.state(session.displayFacts),
                           let subtitle = SessionHeader.subtitle(for: session, now: now) {
                            SessionHeaderStateLine(session: session, state: state, subtitle: subtitle,
                                                   word: SessionHeader.headerWord(for: session, now: now))
                        }
                    }
                    .font(.caption).frame(width: 300, alignment: .leading)
                    HStack(spacing: 4) {
                        if let glyph = card.sessionGlyph { SessionStatusPill(glyph: glyph) }
                        SessionMarkPills(marks: card.sessionMarks)
                    }
                    .frame(width: 220, alignment: .leading)
                    Text("- \(markdown) · Nov 24 · orbit-ws01").font(.caption.monospaced())
                        .frame(width: 260, alignment: .leading)
                }
            }
        }
        try write("mac-surfaces-after", view, width: 1080)
    }
}
