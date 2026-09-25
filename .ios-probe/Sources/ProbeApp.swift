import SwiftUI
import OrbitKit

/// The Work overview card's landing row, as iOS draws it — the app's own `ProjectLandingRow`, with
/// fixtures built through the app's own `ProjectPage.landingLine`.
///
/// The two states are the ones the mock was approved in: the platform checking a landing
/// (`◌ Landing <task> · checking · 1m 20s`) and the same job waiting its turn (`queued · 0m 40s`).
/// The clock is read at a FIXED instant rather than at the moment of capture, so the screenshot
/// carries the numbers the mock approved instead of however long the simulator took to launch —
/// exactly what the web probe does. One case is drawn per launch (`PROBE_CASE`), so the row is at
/// the top of the shot rather than scrolled past.
///
/// The row above the cells and the hairline between them are the app's own composition: a `Section`
/// of a `.insetGrouped` `List`, which is what the page draws. The cells below the row are PROBE
/// FURNITURE: their words come from the app's own `ProjectPage.overviewCells`, but the drawing is a
/// plain label/value/footnote with no glyph marks — so this screenshot is evidence about the ROW,
/// and not about the cells, which this change does not touch.
@main
struct LandingProbeApp: App {
    var body: some Scene {
        WindowGroup { ProbeRoot() }
    }
}

/// The instant every clock is read at, and the instants the two jobs started.
///
/// Through the app's own `RelativeTime.parse`, which reads both spellings the server sends — a bare
/// `ISO8601DateFormatter()` defaults to `.withInternetDateTime` WITHOUT fractional seconds, and the
/// force-unwrap of its nil answer crashed this probe on launch the first time round.
private let frozen = RelativeTime.parse("2026-09-25T14:00:00.000Z")!

private func at(_ secondsBeforeFrozen: TimeInterval) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: frozen.addingTimeInterval(-secondsBeforeFrozen))
}

/// The project's own numbers, as the web probe reads them from the database: nothing else on the
/// card moves while a landing is in flight.
private let buckets = ProjectPanoramaBuckets(
    running: 0, ready: 1, blocked: 3, awaitingVerification: 0, done: 7, failed: 0, cancelled: 0,
    integrating: 1, onIntegrationLine: 0, onUpstream: 1, doneNotIntegrated: 6, waitingForLanding: 0)

private let taskTitle = "T2 wiki 契约、迁移与共享类型，并把设计文档和效果图带进仓库"

/// One case: what it is called on the section header, and the line the app's own fold answers —
/// nil for the case where nothing is landing, which is what the card's own guard refuses to draw.
private struct Case: Identifiable {
    let id: String
    let line: ProjectPage.LandingLine?
}

private func view(integrating: Int, queued: Int, title: String?, state: String,
                  secondsAgo: TimeInterval) -> ProjectPage.LandingLine {
    ProjectPage.landingLine(
        ProjectIntegrationView(
            line: .projectBranch, ref: "project/34Uty9dJvewpbDwMZDIkZ", upstreamRef: "main",
            commitsAheadOfUpstream: 1, integratingCount: integrating, queuedCount: queued,
            mergeCheckOnTip: "PASSING",
            inFlight: .init(taskTitle: title, state: state, startedAt: at(secondsAgo))),
        now: frozen)!
}

private let cases: [Case] = [
    Case(id: "checking",
         line: view(integrating: 1, queued: 0, title: taskTitle, state: "RUNNING", secondsAgo: 80)),
    Case(id: "queued",
         line: view(integrating: 0, queued: 1, title: taskTitle, state: "QUEUED", secondsAgo: 40)),
    Case(id: "multi",
         line: view(integrating: 2, queued: 1, title: taskTitle, state: "RUNNING", secondsAgo: 80)),
    Case(id: "untitled",
         line: view(integrating: 1, queued: 0, title: nil, state: "RUNNING", secondsAgo: 80)),
    // Nothing in flight: `ProjectPage.landingLine` answers nil and the card draws no row at all.
    // The section still draws, with the cells under it and no separator above them.
    Case(id: "none", line: ProjectPage.landingLine(ProjectIntegrationView(), now: frozen)),
]

private let selected = ProcessInfo.processInfo.environment["PROBE_CASE"] ?? "checking"

private struct ProbeRoot: View {
    var body: some View {
        List {
            ForEach(cases.filter { $0.id == selected }) { item in
                Section {
                    // The card's own guard, one line: `if let integration = store.integration,
                    // integration.inFlight != nil` — a nil line draws nothing here either.
                    if let line = item.line {
                        ProjectLandingRow(line: line)
                    }
                    probeCells
                } header: {
                    Text("\(item.id) · \(item.id == "none" ? "nothing in flight — no row" : "clock read at 2026-09-25T14:00:00Z")")
                        .font(.orbitLabel)
                }
            }
            Section {
                Text("The row is drawn from `ProjectPage.landingLine`, which answers nil for a "
                     + "project whose `inFlight` is nil; the card's guard then draws nothing, and "
                     + "the hairline under it is not there to be seen either.")
                    .font(.orbitMeta)
                    .foregroundStyle(.secondary)
            } header: {
                Text("About the \"none\" case").font(.orbitLabel)
            }
        }
        .listStyle(.insetGrouped)
    }

    /// The six lanes the card draws, with the app's own words for them.
    private var probeCells: some View {
        let cells = ProjectPage.overviewCells(buckets, taskCount: 11, line: .projectBranch)
        return LazyVGrid(columns: [GridItem(.flexible(), alignment: .topLeading),
                                   GridItem(.flexible(), alignment: .topLeading)],
                         alignment: .leading, spacing: 14) {
            ForEach(cells) { cell in
                VStack(alignment: .leading, spacing: 2) {
                    Text(cell.label).font(.orbitLabel)
                    Text("\(cell.value)").font(.title2.weight(.bold)).monospacedDigit()
                    Text(cell.footnote).font(.orbitMeta).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}
