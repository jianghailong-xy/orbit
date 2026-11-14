import SwiftUI
import OrbitKit

// A session held by its runner's self-update (queuedReason `runner_updating`), drawn as board 5 of
// docs/mocks/runner-update-drain draws it on a phone: the queued page — why, the turns it waits for
// and how long — while the conversation is empty, and otherwise `Queued · runner updating` on the
// foot row of the reader's last message. The words are `RunnerUpdating`'s, which are the web's
// (`runnerSlots.ts`). Both offer Later (`RunnerUpdateLaterControl`) and, for a runner that declares
// `self-update-now/v1`, Update Now… (`RunnerUpdateNowControl`) for the session's runner (board 5).
// A runner that is stopping rather than updating (docs/mocks/runner-stopping) says "stopping" and
// offers neither: it has no release to postpone or install.

/// What the foot-row tag needs: which bubble carries it, the session it explains and its runner.
struct RunnerUpdatingFoot: Equatable {
    let bubbleID: String
    let session: Session
    let machine: String?
    /// The runner Later postpones; nil until the console has read it, which draws no Later.
    var runnerID: String? = nil
}

private struct RunnerUpdatingFootKey: EnvironmentKey {
    static let defaultValue: RunnerUpdatingFoot? = nil
}

extension EnvironmentValues {
    /// Set by `TranscriptView` while the session is held by its runner's update.
    var runnerUpdatingFoot: RunnerUpdatingFoot? {
        get { self[RunnerUpdatingFootKey.self] }
        set { self[RunnerUpdatingFootKey.self] = newValue }
    }
}

/// The queued page (web `RunnerUpdatingQueued`): the title, the explanation with the turns it waits
/// for as links, and the wait, which moves once a minute.
struct RunnerUpdatingQueuedView: View {
    let session: Session
    let machine: String?
    var runnerID: String? = nil
    var onOpenSession: (String) -> Void = { _ in }
    /// The turns' links, which the page opens in place rather than handing to the system.
    private static let turnScheme = "orbit-turn:"

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            VStack(spacing: 10) {
                Text(RunnerUpdating.title(session))
                    .font(.headline)
                Text(description)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .environment(\.openURL, OpenURLAction { url in
                        let link = url.absoluteString
                        // The only links in this text are the turns: nothing here leaves the app.
                        guard link.hasPrefix(Self.turnScheme) else { return .discarded }
                        onOpenSession(String(link.dropFirst(Self.turnScheme.count)))
                        return .handled
                    })
                if let waited = RunnerUpdating.waited(session, now: context.date) {
                    Text(waited).font(.footnote).foregroundStyle(.tertiary)
                }
                if let runnerID, !RunnerUpdating.stopping(session) {
                    RunnerUpdateLaterControl(runnerID: runnerID, version: session.queuedRunnerUpdate?.targetVersion,
                                             machine: machine)
                        .padding(.top, 8)
                    RunnerUpdateNowControl(runnerID: runnerID, machine: machine)
                }
            }
            .padding(.horizontal, 32)
            .frame(maxWidth: 420)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("runner-updating-queued")
    }

    /// The parts as one text, each turn a link the page opens in place.
    private var description: AttributedString {
        var out = AttributedString()
        for part in RunnerUpdating.description(session, machine: machine) {
            switch part {
            case .text(let words):
                out += AttributedString(words)
            case .turn(let id, let title):
                var link = AttributedString(title)
                link.link = URL(string: Self.turnScheme + id)
                out += link
            }
        }
        return out
    }
}

/// The foot-row tag under the message the update holds (web `RunnerUpdatingTag`): `Queued · runner
/// updating`, the reason underlined because a press opens why.
struct RunnerUpdatingTagView: View {
    let foot: RunnerUpdatingFoot
    @State private var open = false

    var body: some View {
        HStack(spacing: 4) {
            Text(RunnerUpdating.queuedWord)
            Text("·")
            Button { open = true } label: {
                Text(RunnerUpdating.tag(foot.session))
                    .underline(pattern: .dot)
            }
            .buttonStyle(.plain)
            .popover(isPresented: $open) { pop }
        }
        .font(.orbitMeta)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("runner-updating-tag")
    }

    private var pop: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            VStack(alignment: .leading, spacing: 6) {
                Text(RunnerUpdating.title(foot.session)).font(.headline)
                Text(RunnerUpdating.messageText(foot.session, machine: foot.machine))
                    .font(.callout)
                if let waited = RunnerUpdating.waited(foot.session, now: context.date) {
                    Text("\(waited).").font(.callout).foregroundStyle(.secondary)
                }
                if let runnerID = foot.runnerID, !RunnerUpdating.stopping(foot.session) {
                    RunnerUpdateLaterControl(runnerID: runnerID,
                                             version: foot.session.queuedRunnerUpdate?.targetVersion,
                                             machine: foot.machine)
                        .padding(.top, 4)
                    RunnerUpdateNowControl(runnerID: runnerID, machine: foot.machine)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(idealWidth: 300, maxWidth: 320, alignment: .leading)
            .padding(14)
        }
        .presentationCompactAdaptation(.popover)
    }
}
