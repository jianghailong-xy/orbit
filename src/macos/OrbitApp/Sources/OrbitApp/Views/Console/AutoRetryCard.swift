import SwiftUI
import OrbitKit

/// A failure that fixes itself, in the transcript: a spent account quota, or the provider briefly
/// unable to answer. The runtime reports both as ordinary assistant text ("You've hit your session
/// limit · resets 6:20pm", "API Error: 529"), which reads like the agent's own reply — so this card
/// replaces it with what is actually happening: the message goes out again by itself, here is when,
/// and here is how to take over.
///
/// Every decision (wording, which controls, escalate or stay neutral) is `AutoRetryLogic`, unit
/// tested on Linux; this only renders it. Web parity: `AutoRetryCard` in Transcript.tsx.
struct AutoRetryCardView: View {
    let console: ConsoleModel
    let notice: AutoRetryNotice

    var body: some View {
        content
            // The armed retry is a fact about the session, not the transcript, and the poll behind
            // it goes quiet exactly when a turn settles (see `WorktreeModel.startPolling`) — so the
            // card asks for it once, when it appears. Outside `content` so switching to the ticking
            // form when a retry turns up doesn't re-run the fetch.
            .task { if !notice.stale { await console.refreshRetryState() } }
    }

    @ViewBuilder
    private var content: some View {
        // A second hand only where there is one to move. A settled card, and a live one with
        // nothing armed, are static text — and a transcript can hold many of those, so ticking them
        // all once a second would be a battery cost with nothing on screen to show for it.
        if notice.stale || console.armedRetryAt == nil {
            card(now: Date())
        } else {
            TimelineView(.periodic(from: .now, by: 1)) { ctx in card(now: ctx.date) }
        }
    }

    @ViewBuilder
    private func card(now: Date) -> some View {
        // Read once per render: this body re-runs every second while a retry counts down, and
        // `lastUserMessageText` walks the transcript backwards to find it.
        let retryText = console.lastUserMessageText
        let s = AutoRetryLogic.state(notice: notice,
                                     live: !notice.stale,
                                     retryAt: console.armedRetryAt,
                                     attempts: console.retryAttempts,
                                     provider: console.provider,
                                     runnerName: console.runnerName,
                                     hasRetryText: !retryText.isEmpty,
                                     now: now)
        VStack(alignment: .leading, spacing: 8) {
            Label(s.title, systemImage: s.needsYou ? "exclamationmark.triangle.fill" : "clock.fill")
                .foregroundStyle(s.needsYou ? Color.orange : Color.secondary)
                .font(.orbitProse.bold())
            Text(s.body).font(.orbitLabel).foregroundStyle(.secondary)
            if s.showsMessage {
                Text(notice.message)
                    .font(.orbitLabel).foregroundStyle(.secondary).textSelection(.enabled)
            }
            if let countdown = s.countdown { whenRow(s, countdown: countdown, now: now) }
            if s.showsAutoRow { autoRow(s) }
            if s.firing {
                Label("Retrying — re-sending your message…", systemImage: "arrow.clockwise")
                    .font(.orbitLabel).foregroundStyle(.secondary)
            }
            if let title = s.retryNowTitle { retryRow(s, title: title, retryText: retryText) }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(s.needsYou ? Color.orange.opacity(0.08) : Color.secondary.opacity(0.08),
                    in: RoundedRectangle(cornerRadius: 10))
    }

    /// A quota leads with the absolute moment its window resets — a time the reader may need to
    /// plan around — with the countdown beside it. A provider error's couple of minutes are the
    /// whole story.
    private func whenRow(_ s: AutoRetryLogic.State, countdown: String, now: Date) -> some View {
        Group {
            if s.showsResetAt, let at = console.armedRetryAt {
                Text("Resets ") + Text(Self.resetAt(at, now: now)).bold() + Text(" · \(countdown)")
            } else {
                Text("Retrying ") + Text(countdown).bold()
            }
        }
        .font(.orbitLabel)
    }

    /// A real two-state switch: off is rendered, not implied by the row disappearing, so the state
    /// the user just chose stays legible instead of vanishing with the control that set it.
    private func autoRow(_ s: AutoRetryLogic.State) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(s.autoLabel).font(.orbitLabel)
                Text(s.autoDetail).font(.orbitMeta).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Toggle("Auto-retry", isOn: Binding(
                get: { s.armed },
                set: { on in
                    guard !on || s.rearmAt != nil else { return }
                    Task { await console.setAutoRetry(armedAt: on ? s.rearmAt : nil) }
                }))
                .labelsHidden()
                .toggleStyle(.switch)
        }
    }

    private func retryRow(_ s: AutoRetryLogic.State, title: String, retryText: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            // Quoted for the same reason as the sign-in card's: by now it has scrolled away, and on
            // a first-turn limit it was never in the transcript at all. When the bubble is the line
            // directly above, it is neither — see `AutoRetryNotice.afterUserMsg`.
            if s.quotesRetryText {
                Text("Will re-send:").font(.orbitMeta).foregroundStyle(.secondary)
                Text(retryText)
                    .font(.orbitLabel).foregroundStyle(.secondary).lineLimit(2)
                    .padding(.horizontal, 8).padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
            }
            Button(title) { Task { await console.retryLastMessage() } }
                .buttonStyle(.bordered)
                .disabled(console.sending)
            if let note = s.retryNowNote {
                Text(note).font(.orbitMeta).foregroundStyle(.secondary)
            }
        }
    }

    // Built once and reused: a formatter allocation spins up an ICU date parser, and this sits
    // inside a view that re-renders every second while a retry counts down.
    private static let time: DateFormatter = {
        let f = DateFormatter()
        f.timeStyle = .short
        f.dateStyle = .none
        return f
    }()
    private static let dayAndTime: DateFormatter = {
        let f = DateFormatter()
        f.timeStyle = .short
        f.dateStyle = .medium
        return f
    }()

    /// "6:20 PM" today, "Aug 6, 2026 at 1:00 PM" beyond it — a bare time on another day misleads.
    private static func resetAt(_ at: Date, now: Date) -> String {
        Calendar.current.isDate(at, inSameDayAs: now) ? time.string(from: at) : dayAndTime.string(from: at)
    }
}
