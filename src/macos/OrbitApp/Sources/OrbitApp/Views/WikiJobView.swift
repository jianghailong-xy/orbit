import SwiftUI
import OrbitKit

// A server run's page and its row on Activity's Runs band (design §2.2, mock 35 ④⑤, P9) — the web's
// `WikiRunsCard.tsx`, which unfolds the same log inside its card: what kind of run, where it stands, how far it
// got and where it waits, then each model call — how long it waited and ran, what it spent and how it failed. A
// server run has no task and no session, so this page is its detail, and nothing on it links to one. Every word is
// `WikiRunsCopy`'s; `WikiServerExecutionCopyParityTests` holds them to the web's.

/// A run's mark: green done, amber waiting, red failed, a spinner while it runs, grey cancelled.
struct WikiRunMark: View {
    let mark: WikiRunRow.Mark

    var body: some View {
        switch mark {
        case .spin:
            ProgressView().controlSize(.mini)
        case .ok, .warn, .error, .none:
            Circle().fill(colour).frame(width: 8, height: 8)
        }
    }

    private var colour: Color {
        switch mark {
        case .ok: return .green
        case .warn: return .orange
        case .error: return .red
        case .spin, .none: return Color.secondary.opacity(0.45)
        }
    }
}

/// A run's state and the sentence after it, the state in semibold and its tone — amber while it waits, red when it
/// broke — as the web's row bolds it.
func wikiRunStateLine(_ row: WikiRunRow, font: Font) -> AttributedString {
    typealias Colour = AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute
    var line = AttributedString(row.state)
    line[AttributeScopes.SwiftUIAttributes.FontAttribute.self] = font.weight(.semibold)
    switch row.tone {
    case .warn: line[Colour.self] = Color.orange
    case .error: line[Colour.self] = Color.red
    case .plain: line[Colour.self] = Color.primary
    case .muted: break
    }
    if !row.text.isEmpty { line += AttributedString(" · \(row.text)") }
    return line
}

/// One run on Activity's Runs band: its kind and when on the first line, its state and the sentence after it under them.
struct WikiRunListRow: View {
    let row: WikiRunRow

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            WikiRunMark(mark: row.mark).frame(width: 12)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(row.kind)
                        .font(.orbitProse)
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Text(row.when).font(.orbitLabel).foregroundStyle(Color.secondary).fixedSize()
                }
                Text(wikiRunStateLine(row, font: .orbitListSubtitle))
                    .font(.orbitListSubtitle)
                    .foregroundStyle(Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// The System model as the Runs band's head and the settings page say it: its name, and its state in its colour.
struct WikiModelStateText: View {
    let model: WikiSystemModelStatus

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text("●").font(.orbitMeta)
            Text(WikiRunsCopy.modelState(model.state))
        }
        .foregroundStyle(colour)
    }

    private var colour: Color {
        switch WikiRunsLogic.modelTone(model.state) {
        case .up: return .green
        case .warn: return .orange
        case .error: return .red
        }
    }
}

/// One call of a run's log: the step and unit with its state on the first line, how long it waited and ran and its
/// tokens under them, and the error of a call that failed or waits again.
struct WikiCallListRow: View {
    let row: WikiCallRow

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(row.call)
                    .font(.orbitMono)
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 8)
                Text(row.state).font(.orbitLabel).foregroundStyle(colour).fixedSize()
            }
            if !row.line.isEmpty || row.retries != nil {
                Text([row.retries, row.line.isEmpty ? nil : row.line].compactMap { $0 }.joined(separator: " · "))
                    .font(.orbitLabel)
                    .foregroundStyle(Color.secondary)
            }
            if let error = row.error {
                Text(error)
                    .font(.orbitLabel)
                    .foregroundStyle(Color.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var colour: Color {
        switch row.tone {
        case .ok: return .green
        case .warn: return .orange
        case .error: return .red
        case .run: return .accentColor
        case .muted: return .secondary
        }
    }
}

/// A run's page: where it stands, the line under its log, then its calls.
struct WikiJobPage: View {
    let job: WikiJob
    var now: Date = Date()

    var body: some View {
        let row = WikiRunsLogic.row(job, now: now)
        List {
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Text(wikiRunStateLine(row, font: .orbitProse))
                        .font(.orbitProse)
                        .foregroundStyle(Color.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(row.when).font(.orbitLabel).foregroundStyle(Color.secondary)
                }
                Text(WikiRunsLogic.foot(job)).font(.orbitLabel).foregroundStyle(Color.secondary)
            }
            if !job.requests.isEmpty {
                Section {
                    ForEach(job.requests) { call in
                        WikiCallListRow(row: WikiRunsLogic.callRow(call, now: now))
                    }
                } header: {
                    HStack(spacing: 6) {
                        Text(WikiRunsCopy.callsTitle)
                        Text("\(job.calls.total)").foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle(row.kind)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}

/// The screen: one of the space's runs, read again every few seconds while it is on its way.
struct WikiJobView: View {
    @Environment(AppModel.self) private var model
    let jobID: String

    var body: some View {
        if let wiki = model.wiki {
            Group {
                if let job = wiki.job(jobID) {
                    TimelineView(.periodic(from: .now, by: 5)) { context in
                        WikiJobPage(job: job, now: context.date)
                    }
                } else {
                    ProgressView()
                }
            }
            .task(id: jobID) {
                await wiki.loadJobs()
                while !Task.isCancelled, wiki.jobsUnderWay {
                    try? await Task.sleep(for: .seconds(5))
                    await wiki.loadJobs()
                }
            }
            .refreshable { await wiki.loadJobs() }
        } else {
            ProgressView()
        }
    }
}
