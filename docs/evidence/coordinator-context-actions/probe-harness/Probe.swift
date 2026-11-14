import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (never merged; see run.sh). One screen per launch, chosen by
// `-shot <name>`, built from the real shared views of src/macos/OrbitApp — the context panel's
// presentation (`ContextWindowDetailPresentation`), the confirm (`CoordinatorHandoffConfirmPresentation`),
// the handoff rows and the successor's note card — fed with board 01–03's fixture data. The panel
// and the confirm are opened by the probe as a press would open them; the conversation around them
// is a stand-in with the board's words.

enum Shot: String, CaseIterable {
    case panelCoordinator, panelRunning, panelOrdinary, confirm
    case writing, handingOver, successor, completed, failed, failedReplace
}

private let project = "Checkout redesign"
private let waits = [
    CoordinatorPendingWait(id: "w1", label: "Fix login redirect reaching Done"),
    CoordinatorPendingWait(id: "w2", label: "Session \u{201C}Payment retries\u{201D} finishing its turn"),
]
private let note = """
## Where things stand
- 4 of 6 tasks done; Fix login redirect in review.
## Agreed with the owner
- Don't merge Payment retries before Friday's release.
## Waiting on
- Evidence for Fix login redirect.
## Next
- Ask for the merge once that evidence is in.
"""

struct ProbeRoot: View {
    let shot: Shot

    var body: some View {
        switch shot {
        case .panelCoordinator:
            frame(status: "Running", transcript: "…Fix login redirect is in review.") {
                ComposerStandIn(pct: 82, tokens: 820_000, actions: actions(running: false, coordinator: true),
                                opens: .panel)
            }
        case .panelRunning:
            frame(status: "Running", transcript: "Working on the retry backoff…") {
                ComposerStandIn(pct: 41, tokens: 410_000, actions: actions(running: true, coordinator: true),
                                opens: .panel)
            }
        case .panelOrdinary:
            frame(status: "Idle", transcript: "…the retry backoff is in.", coordinator: false) {
                ComposerStandIn(pct: 7, tokens: 72_000, actions: actions(running: false, coordinator: false),
                                opens: .panel)
            }
        case .confirm:
            frame(status: "Running", transcript: "…Fix login redirect is in review.") {
                ComposerStandIn(pct: 82, tokens: 820_000, actions: actions(running: false, coordinator: true),
                                opens: .confirm)
            }
        case .writing:
            frame(status: CoordinatorHandoffCopy.badgeHandingOver,
                  transcript: "…Fix login redirect is in review; I'm waiting on its evidence before asking you about the merge.") {
                CoordinatorHandoffStatusView(row: .writing(startedAt: Date().addingTimeInterval(-24))) { _ in }
                    .padding(.bottom, 8)
                CoordinatorHandoffLockedComposer()
            }
        case .handingOver:
            frame(status: CoordinatorHandoffCopy.badgeHandingOver,
                  transcript: "…Fix login redirect is in review; I'm waiting on its evidence before asking you about the merge.") {
                CoordinatorHandoffStatusView(row: .handingOver) { _ in }
                    .padding(.bottom, 8)
                CoordinatorHandoffLockedComposer()
            }
        case .successor:
            frame(status: "Running", transcript: nil, top: AnyView(VStack(alignment: .leading, spacing: 12) {
                CoordinatorHandoffNoteCardView(received: SessionCoordinatorHandoffReceived(
                    handoffFromSessionId: "s-old", note: note,
                    handedOverAt: ISO8601DateFormatter().string(from: Date()), movedWaits: waits)) {}
                Text("Picked up from the handoff. I re-read the project and its tasks — it matches: 4 of 6 done, one in review…")
                    .font(.orbitProse)
            })) {
                ComposerStandIn(pct: 3, tokens: 30_000, actions: ContextActions(), opens: nil)
            }
        case .completed:
            frame(status: "Completed", transcript: "…Ask for the merge once that evidence is in.") {
                CoordinatorHandedOverBanner {}
            }
        case .failed:
            frame(status: "Idle", transcript: "…Fix login redirect is in review.") {
                CoordinatorHandoffStatusView(row: .failed(reason: CoordinatorHandoffCopy.failureSentence(.turnFailed),
                                                          actions: [.retry, .skip, .cancel])) { _ in }
                    .padding(.bottom, 8)
                ComposerStandIn(pct: 82, tokens: 820_000, actions: ContextActions(), opens: nil)
            }
        case .failedReplace:
            frame(status: "Completed", transcript: "…Fix login redirect is in review.") {
                CoordinatorHandoffStatusView(row: .failed(reason: CoordinatorHandoffCopy.failureSentence(.replaceFailed),
                                                          actions: [.skip])) { _ in }
                    .padding(.bottom, 8)
                ComposerStandIn(pct: 82, tokens: 820_000, actions: ContextActions(), opens: nil)
            }
        }
    }

    private func actions(running: Bool, coordinator: Bool) -> ContextActions {
        ContextActions(offersCompact: true,
                       compactEnabled: CoordinatorContextActions.compactEnabled(running: running),
                       offersNewCoordinator: coordinator, running: running, projectTitle: project,
                       pendingWaits: { waits })
    }

    private func frame<Band: View>(status: String, transcript: String?, top: AnyView? = nil,
                                   coordinator: Bool = true,
                                   @ViewBuilder band: () -> Band) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(coordinator ? project : "Retry backoff").font(.headline)
                if coordinator {
                    Text("Coordinator").font(.orbitMeta.weight(.semibold))
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Capsule().fill(Color.purple.opacity(0.14)))
                        .foregroundStyle(.purple)
                }
                Spacer()
                Text(status).font(.orbitLabel).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let top { top }
                    if let transcript { Text(transcript).font(.orbitProse).foregroundStyle(.secondary) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
            }
            VStack(spacing: 0, content: band)
                .padding(.horizontal, 12)
                .padding(.bottom, 12)
        }
    }
}

enum Opens { case panel, confirm }

/// The composer's card with its footer: the model, the plan gauge and the context ring, which
/// carries the real context presentation and confirm — opened by the probe as a tap would.
struct ComposerStandIn: View {
    let pct: Int
    let tokens: Int
    let actions: ContextActions
    let opens: Opens?
    @State private var showPanel = false
    @State private var confirmWaits: [CoordinatorPendingWait]?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Message…").font(.orbitProse).foregroundStyle(.secondary)
            HStack(spacing: 10) {
                Spacer()
                Text("Opus 5.5").fontWeight(.semibold) + Text(" Default").foregroundStyle(.secondary)
                Text("79%").foregroundStyle(.secondary)
                Button { showPanel.toggle() } label: {
                    HStack(spacing: 5) {
                        ZStack {
                            Circle().stroke(.quaternary, lineWidth: 2.5)
                            Circle().trim(from: 0, to: CGFloat(pct) / 100)
                                .stroke(pct >= 90 ? Color.red : pct >= 75 ? Color.orange : Color.accentColor,
                                        style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                                .rotationEffect(.degrees(-90))
                        }
                        .frame(width: 14, height: 14)
                        Text("\(pct)%").foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(.plain)
                .modifier(ContextWindowDetailPresentation(
                    isPresented: $showPanel, tokens: tokens, window: 1_000_000, pct: pct, known: true,
                    actions: actions,
                    startNewCoordinator: {
                        showPanel = false
                        Task { confirmWaits = await actions.pendingWaits() }
                    }))
                .modifier(CoordinatorHandoffConfirmPresentation(waits: $confirmWaits, actions: actions))
                Image(systemName: "arrow.up.circle.fill").font(.title2).foregroundStyle(Color.accentColor)
            }
            .font(.orbitListSubtitle)
        }
        .padding(14)
        .composerBandCard(cornerRadius: 24)
        .task {
            try? await Task.sleep(for: .seconds(1.5))
            switch opens {
            case .panel: showPanel = true
            case .confirm: confirmWaits = waits
            case nil: break
            }
        }
    }
}

var probeShot: Shot {
    let args = ProcessInfo.processInfo.arguments
    if let i = args.firstIndex(of: "-shot"), args.count > i + 1, let shot = Shot(rawValue: args[i + 1]) {
        return shot
    }
    return .panelCoordinator
}

#if os(macOS)
@main
struct CoordinatorContextMacProbe: App {
    var body: some Scene {
        WindowGroup {
            ProbeRoot(shot: probeShot)
                .frame(width: 620, height: 560)
                .background(WindowPlacer())
        }
        .windowResizability(.contentSize)
    }
}

/// Puts the window where run.sh photographs: its top-left at (60, 60) from the screen's top-left.
struct WindowPlacer: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            guard let window = view.window, let screen = window.screen ?? NSScreen.main else { return }
            let top = screen.frame.maxY - 60
            window.setFrameTopLeftPoint(NSPoint(x: screen.frame.minX + 60, y: top))
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        return view
    }
    func updateNSView(_ nsView: NSView, context: Context) {}
}
#else
@main
struct CoordinatorContextProbe: App {
    var body: some Scene {
        WindowGroup { ProbeRoot(shot: probeShot) }
    }
}
#endif
