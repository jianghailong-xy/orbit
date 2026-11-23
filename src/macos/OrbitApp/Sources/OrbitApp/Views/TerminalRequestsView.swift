import SwiftUI
import OrbitKit

// Where a terminal asking to be approved is drawn (docs/mocks/waiting-on-you-removal/02-terminal-
// approvals.html): Machines & models' Needs you section holds every machine's cards; each machine's
// own page draws its own under the title; the session list's Needs you line points at the section.
// The card and what its buttons do are main's `TerminalApproveCard`, unchanged.

/// Keeps a terminal-request surface current: reads the requests every 20 s, as the web does, and
/// redraws at the next deadline so a card folds when its request expires rather than at a later read
/// (board ② choice 4). The `now` it binds is what the surface filters against.
struct TerminalRequestsCurrent: ViewModifier {
    @Environment(AppModel.self) private var model
    @Binding var now: Date

    func body(content: Content) -> some View {
        content
            .task {
                await model.ownerRequests?.loadTerminalRequests()
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(20))
                    if Task.isCancelled { return }
                    await model.ownerRequests?.loadTerminalRequests()
                    now = Date()
                }
            }
            .task(id: deadline) {
                guard let deadline else { return }
                try? await Task.sleep(for: .seconds(max(0.05, deadline.timeIntervalSinceNow + 0.05)))
                if !Task.isCancelled { now = Date() }
            }
    }

    private var deadline: Date? {
        Terminals.nextDeadline(model.ownerRequests?.terminalRequests ?? [], after: now)
    }
}

/// The cards themselves, oldest first: a `ForEach` for the section that holds them.
struct TerminalRequestCards: View {
    let model: OwnerRequestsModel
    let requests: [TerminalRequest]
    /// The card a press on the needs-you line or the push opened.
    var lit: String? = nil
    var onSaid: (String) -> Void = { _ in }

    var body: some View {
        ForEach(requests) { request in
            TerminalApproveCard(model: model, request: request, lit: request.id == lit, onSaid: onSaid)
                .listRowInsets(EdgeInsets(top: 6, leading: 0, bottom: 6, trailing: 0))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
        }
    }
}

/// A machine's page: "Terminals to approve", the cards for this machine only, and the note that a
/// request lasts ten minutes. Nothing at all when none waits — no heading over an empty section.
struct TerminalRequestsSection: View {
    @Environment(AppModel.self) private var model
    let runnerID: String
    /// The page's own notice, for "Terminal approved" / "Terminal denied".
    var onSaid: (String) -> Void = { _ in }
    @State private var now = Date()

    var body: some View {
        Group {
            if let owner = model.ownerRequests, !requests(owner).isEmpty {
                Section {
                    TerminalRequestCards(model: owner, requests: requests(owner),
                                         onSaid: onSaid)
                } header: {
                    RunnerSectionHeader(Terminals.toApprove, trailing: Terminals.requestLasts)
                }
            }
        }
        .modifier(TerminalRequestsCurrent(now: $now))
    }

    private func requests(_ owner: OwnerRequestsModel) -> [TerminalRequest] {
        Terminals.requests(Terminals.liveRequests(owner.terminalRequests, now: now), on: runnerID)
    }
}

/// The Mac's session list line (board ③): there is no capsule here, so a Needs you section at the
/// top of the list says what waits, in the capsule's own words and mark. A press opens Settings ›
/// Machines & models on its Needs you section.
struct TerminalNeedsYouRow: View {
    let line: TerminalNeedsYou
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 8) {
                Image(systemName: "terminal")
                    .font(.orbitLabel)
                    .foregroundStyle(RunnerInk.amber)
                    .frame(width: 20)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(line.text)
                            .font(.orbitSubtext.weight(.semibold))
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        if let age = RelativeTime.elapsed(line.since) {
                            Text(age)
                                .font(.orbitMeta)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Text(line.detail)
                        .font(.orbitListSubtitle)
                        .foregroundStyle(RunnerInk.amber)
                        .lineLimit(1)
                }
            }
            .padding(.leading, 16)
            .padding(.trailing, 16)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("terminal-needs-you")
    }
}
