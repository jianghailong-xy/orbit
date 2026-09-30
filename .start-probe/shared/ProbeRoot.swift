import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md). One conversation per launch — `-screen start`,
// `start-nocheck`, `change`, and the two states a press leaves, `started` and `confirmed` — drawn by
// the app's own cards (Generated/Cards.swift, cut verbatim out of ApprovalCards.swift, and
// Generated/ProjectStartedCardView.swift) over the mocks' data. The header's subtitle is OrbitKit's
// own `SessionHeader.subtitle` for the coordinator session's row; the bubbles are plain text.

enum ProbeLaunch {
    static var arguments: [String] { ProcessInfo.processInfo.arguments }

    static func value(_ flag: String) -> String? {
        guard let at = arguments.firstIndex(of: flag), at + 1 < arguments.count else { return nil }
        return arguments[at + 1]
    }

    static var screen: String { value("-screen") ?? "start" }
    static var dark: Bool { arguments.contains("-dark") }
    /// Open scrolled to the end — the macOS window is one screen tall, and this is its second.
    static var bottom: Bool { arguments.contains("-bottom") }

    @MainActor
    static func console() -> ConsoleModel {
        switch screen {
        case "start-nocheck": return ConsoleModel(stage: .start, mergeCheck: nil)
        case "start-main":
            // The owner picked Directly into main on the card: the draft the console keeps.
            let console = ConsoleModel(stage: .start)
            if let row = console.startRequestRow {
                var draft = console.startDraft(for: row)
                draft.line = .main
                console.setStartDraft(draft, for: row.itemId)
            }
            return console
        case "started": return ConsoleModel(stage: .started)
        case "change": return ConsoleModel(stage: .change)
        case "confirmed": return ConsoleModel(stage: .confirmed)
        default: return ConsoleModel(stage: .start)
        }
    }
}

struct ProbeRoot: View {
    @State private var console = ProbeLaunch.console()

    var body: some View {
        if ProbeLaunch.screen == "menus" {
            MenuExperiment()
        } else {
            root
        }
    }

    @ViewBuilder
    private var root: some View {
        #if os(iOS)
        NavigationStack {
            conversation
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .principal) { header }
                }
        }
        .preferredColorScheme(ProbeLaunch.dark ? .dark : .light)
        #else
        VStack(spacing: 0) {
            header.padding(.vertical, 8)
            Divider()
            conversation
        }
        .preferredColorScheme(ProbeLaunch.dark ? .dark : .light)
        #endif
    }

    /// The session's own title and subtitle, as the console header says them: "Ready to start ·
    /// Open · just now" while the start card waits, "Running · Open · just now" once it is answered.
    private var header: some View {
        VStack(spacing: 1) {
            Text(ProbeData.title).font(.headline).lineLimit(1)
            Text(SessionHeader.subtitle(for: session) ?? "")
                .font(.caption).foregroundStyle(.secondary)
                .accessibilityIdentifier("probe-subtitle")
        }
    }

    private var session: Session {
        // Only the start request is counted on the row; the change card does not hold the project
        // up, and its row reads as the running conversation it is (the mock's header).
        let waiting = console.stage == .start
        return Session(id: "coordinator", title: ProbeData.title,
                       status: waiting ? .awaitingInput : .running,
                       runState: waiting ? .awaitingInput : .running, lifecycleState: .open,
                       agentId: nil, assignedRunnerId: nil,
                       pendingApprovals: waiting ? 1 : 0,
                       waitingKind: waiting ? .startRequest : nil,
                       branch: nil, updatedAt: nil, lastTurnAt: ProbeData.iso(-5))
    }

    private var conversation: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                switch console.stage {
                case .start:
                    bubble(ProbeData.coordinatorAsks)
                    StartProjectCardView(console: console, itemID: ProbeData.itemID)
                case .started:
                    if let record = console.startedRecord {
                        AcceptanceConfirmationReceiptCard(confirmed: record,
                                                          changed: console.confirmedChanges(record))
                    }
                    if let card = console.startedCard {
                        ProjectStartedCardView(card: card, text: "(what the coordinator was told)",
                                               ts: ProbeData.iso(-3))
                    }
                    bubble(ProbeData.coordinatorStarted)
                case .change:
                    bubble(ProbeData.coordinatorChanged)
                    CriteriaChangeCardView(console: console)
                case .confirmed:
                    bubble(ProbeData.coordinatorChanged).opacity(0.55)
                    if let record = console.confirmedRecord {
                        AcceptanceConfirmationReceiptCard(confirmed: record,
                                                          changed: console.confirmedChanges(record))
                    }
                    bubble(ProbeData.coordinatorConfirmed)
                }
                // What the presses would have handed on, for the report — tiny and at the end.
                probeNote("probe-composer", console.composerPlaceholder.map { "composer asks: \($0)" })
                probeNote("probe-tasks", console.tasksOpened ? "Tasks created here: opened" : nil)
                probeNote("probe-body", console.sentBody.map { "POST /projects/:id/start \($0)" })
            }
            .padding(16)
        }
        .defaultScrollAnchor(ProbeLaunch.bottom ? .bottom : .top)
    }

    private func bubble(_ text: String) -> some View {
        Text(text)
            .font(.body)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func probeNote(_ id: String, _ text: String?) -> some View {
        if let text {
            Text(text)
                .font(.caption2).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier(id)
        }
    }
}
