import SwiftUI
import UIKit
import Observation
import OrbitKit

// A screenshot of the app's OWN needs-you bar, on an iPhone simulator, for the four owner items
// (docs/project-integration-line-contract.md §7.6 V13).
//
// `run.sh` copies `NeedsYouBannerView.swift` — the app's file, verbatim — into this target, so what
// is drawn below is the view the app draws, not a re-drawing of it. The only stand-in is the model
// it reads: the app's `AppModel` is an @Observable over the network, the console registry and the
// keychain, and the bar touches three members of it. This one answers those three — and answers
// `needsYouBanner(excluding:)` by calling the SAME `NeedsYouLogic.banner` the app calls — so the
// words and the order the bar shows are derived exactly as they are in the app, from a fixture.
//
// Taps do nothing here: the destination is a console card, which is not what this is showing.

/// The three members of `AppModel` the bar reads, answered from a fixture — and answered the way
/// the app answers them: the snapshot is narrowed by `SessionGrouping.group(list).needsYou` first
/// (`AppModel.applySessionSnapshot`, the line the server's count feeds), and only then does the bar
/// derive from it. Skipping that step would draw a bar for a row the app would never put in the
/// bucket, which is exactly the mistake one of these frames exists to disprove.
@Observable
final class AppModel {
    let sessions: [Session]

    init(_ sessions: [Session]) { self.sessions = sessions }

    var waiting: [Session] { SessionGrouping.group(sessions).needsYou }

    func needsYouBanner(excluding focused: String?) -> NeedsYouBanner? {
        NeedsYouLogic.banner(waiting: waiting, excluding: focused)
    }

    func openNeedsYouSession(_ s: Session) {}
    func openNeedsYouItem(_ s: Session, _ item: SessionOwnerItem) {}
}

@main
struct ProbeApp: App {
    var body: some Scene {
        WindowGroup { ProbeRoot() }
    }
}

/// One of the four, as the server puts it on a session row: an item on the project's coordinator
/// conversation, which is where its card is drawn and what a press opens.
private func ownerItemSession(_ kind: OwnerItemKind, project: String, since: String) -> Session {
    Session(id: "coordinator-\(project)", title: "Project coordinator", status: .awaitingInput,
            agentId: "orbit", assignedRunnerId: "runner",
            pendingApprovals: 1,
            ownerItems: [SessionOwnerItem(itemId: "item-\(kind.rawValue)", kind: kind,
                                          title: "Waiting on you", since: since)],
            branch: nil, updatedAt: nil,
            projectId: "project-\(project)", projectTitle: project,
            // No `agent:` — `SessionAgentRef`'s memberwise init is internal to OrbitKit, and the bar
            // reads the PROJECT's name for an owner item, not the agent's.
            lastTurnAt: since)
}

/// A conversation the coordinator is working through itself: one of its own exceptions, no item on
/// the owner. It must draw no bar at all — that is the half of "which four" that is easy to lose.
private func coordinatorHandling() -> Session {
    Session(id: "coordinator-handling", title: "Project coordinator", status: .awaitingInput,
            agentId: "orbit", assignedRunnerId: "runner",
            pendingApprovals: 0, ownerItems: [],
            branch: nil, updatedAt: nil,
            projectId: "project-bg", projectTitle: "后台作业生命周期",
            lastTurnAt: "2026-09-19T02:00:00Z")
}

struct ProbeRoot: View {
    private let shot: String = {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-shot"), i + 1 < args.count else { return "list" }
        return args[i + 1]
    }()

    private var dark: Bool { shot.hasSuffix("dark") }

    var body: some View {
        Group {
            if shot.hasPrefix("list") { workspaceList } else { theFour }
        }
        .preferredColorScheme(dark ? .dark : .light)
    }

    // MARK: the frame from effect image 1's iOS half

    /// The bar where the app puts it: under the title of the list it is drawn above. The chrome and
    /// the two rows below it are the probe's — they are the frame the effect image puts the bar in,
    /// not a claim about the list. The BAR is the app's own view.
    private var workspaceList: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Workspaces").font(.title3.weight(.semibold))
                Spacer()
                Image(systemName: "ellipsis.circle").font(.title3).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 6)

            NeedsYouBannerView(excluding: nil)
                .environment(AppModel([ownerItemSession(.promotionApproval,
                                                        project: "后台作业生命周期",
                                                        since: "2026-09-19T00:30:00Z")]))

            VStack(alignment: .leading, spacing: 18) {
                row("wikova", "3 running · 1 needs you")
                row("workstation", "idle")
                row("longdeMac-mini", "1 running")
            }
            .padding(.horizontal, 16)
            .padding(.top, 16)
            Spacer()
        }
        .background(Color(uiColor: .systemBackground))
    }

    private func row(_ name: String, _ subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(name).font(.body)
            Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
        }
    }

    // MARK: the four, and the one that is not

    private var theFour: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Text("The four owner items — the needs-you bar")
                    .font(.headline)

                entry(.promotionApproval, "M-T2 · the merge to confirm", project: "后台作业生命周期")
                entry(.coordinatorQuestion, "R9 · the coordinator's question", project: "Orbit 原生 Watch")
                entry(.escalated, "X-E1 · the exception that became yours", project: "集成线验收")
                entry(.fusePaused, "F-T1 · the pause only the owner can lift", project: "集成线验收")

                VStack(alignment: .leading, spacing: 8) {
                    Text("Not one of them: an exception the coordinator is handling")
                        .font(.footnote).foregroundStyle(.secondary)
                    // The same view with nothing waiting draws nothing at all — no bar, not an
                    // empty one — which is what makes the four above it a rule and not a style.
                    NeedsYouBannerView(excluding: nil)
                        .environment(AppModel([coordinatorHandling()]))
                    Text("(nothing above this line — the coordinator has it)")
                        .font(.caption).foregroundStyle(.tertiary)
                }
            }
            .padding(16)
        }
    }

    /// One kind, with the words the bar shows printed above it as the probe's own label, and the
    /// project it names coming through the item's session.
    private func entry(_ kind: OwnerItemKind, _ what: String, project: String) -> some View {
        let model = AppModel([ownerItemSession(kind, project: project, since: "2026-09-19T00:30:00Z")])
        let text = NeedsYouLogic.banner(waiting: model.waiting)?.text ?? "(no bar)"
        return VStack(alignment: .leading, spacing: 6) {
            Text(what).font(.footnote).foregroundStyle(.secondary)
            Text("bar says: “\(text)”").font(.caption).foregroundStyle(.tertiary)
            NeedsYouBannerView(excluding: nil).environment(model)
        }
    }
}
