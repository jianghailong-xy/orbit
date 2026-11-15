import SwiftUI
import OrbitKit

/// A turn the control plane opened because a SubAgent ended (OrbitKit's `SubagentFinishedText.parse`),
/// drawn as one event line in the agent's stream in the grammar a background job's news uses
/// (`BackgroundWakeCardView`) — not as the reader's own bubble carrying the raw block under
/// "Orbit attached: context", which is what it was: a message nobody typed, signed with the reader's
/// name, its protocol sentences for the agent on show.
///
/// The ✦ is the SubAgent card's own mark and purple, so the line reads back to the card that started
/// it. What it handed back stays out of the fold — it is what the agent goes on from — three lines of
/// it as Markdown, with Show full result. A run that did not finish turns the line red and says why.
/// The run, where its card is, who queued it and what the agent read open beneath. The sentences the
/// block closes on are the agent's: they are only in "What the agent read".
///
/// Web parity: `SubagentFinishedCard.tsx`, in OrbitKit's `SubagentFinishedCard` words, which
/// `SubagentFinishedCopyParityTests` holds to the web's (board docs/mocks/subagent-finished-line).
struct SubagentFinishedLineView: View {
    let wake: SubagentFinished
    var ts: String?
    var undelivered: Bool = false
    /// Whatever else the same note carried, as its own folded entry.
    var attached: (kind: String, text: String)?
    /// Cancels a wake that is still queued; nil once a runner has taken it, and on a steer.
    var onCancelQueued: (() -> Void)?
    /// How far a wake written into the running turn has got (`BackgroundWakeCard.steerState`).
    var steerState: String?
    /// Still waiting for a runner: drawn dashed, as a queued background wake is.
    var queued: Bool = false

    @Environment(\.subagentCardLinks) private var cardLinks
    @State private var open = false
    @State private var showingRaw = false

    private var several: Bool { wake.runs.count > 1 }
    private var lone: SubagentFinishedRun? { several ? nil : wake.runs.first }
    private var failed: Bool { SubagentFinishedCard.isFailed(wake) }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            line
            if open { fold }
            if let lone {
                SubagentRunOutcome(run: lone)
            } else {
                runs
            }
            if undelivered {
                Text(BackgroundWakeCard.undelivered)
                    .font(.orbitMeta).foregroundStyle(.orange)
                    .padding(.leading, 20)
            }
            if let steerState {
                // A steer's progress, in the words and tone its bubble uses (`UserBubbleView`).
                Text(steerState)
                    .font(.orbitMeta).foregroundStyle(.secondary)
                    .padding(.leading, 20)
            }
            if let onCancelQueued {
                HStack(spacing: 8) {
                    QueuedWord()
                    Button("Cancel") { onCancelQueued() }
                        .buttonStyle(.plain).font(.orbitMeta).foregroundStyle(.tint)
                        .contentShape(Rectangle())
                }
                .padding(.leading, 20)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("subagent-finished-line")
    }

    /// Everything on one line when it fits; on a phone, the name and the closing metadata each take
    /// a line under the title (`BackgroundWakeCardView.line`).
    private var line: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                mark
                title
                if let name = SubagentFinishedCard.lineName(wake) { nameText(name).fixedSize() }
                closing
            }
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    mark
                    title
                }
                if let name = SubagentFinishedCard.lineName(wake) {
                    nameText(name).lineLimit(1).truncationMode(.tail).padding(.leading, 20)
                }
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    closing
                }
                .padding(.leading, 20)
            }
        }
        .font(.orbitLabel)
        .padding(.horizontal, 4).padding(.vertical, 3)
        .overlay {
            if queued {
                RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(Color.secondary.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { withAnimation(.easeOut(duration: 0.15)) { open.toggle() } }
    }

    /// The SubAgent card's ✦, purple while it finished and red where it did not.
    private var mark: some View {
        Text("✦")
            .font(.orbitMeta)
            .foregroundStyle(failed ? Color.red : Color.purple)
            .frame(width: 14)
    }

    private var title: some View {
        Text(SubagentFinishedCard.title(wake))
            .foregroundStyle(failed ? Color.red : Color.secondary)
            .lineLimit(1)
            .fixedSize()
    }

    private func nameText(_ name: String) -> some View {
        Text(name).font(.orbitLabel).foregroundStyle(Color.primary.opacity(0.75))
    }

    @ViewBuilder
    private var closing: some View {
        SubagentStatusChip(text: SubagentFinishedCard.status(wake), failed: failed)
        if let ts, let when = RelativeTime.format(ts) {
            Text(when).font(.orbitMeta).foregroundStyle(Color.secondary).fixedSize()
        }
        Text(SubagentFinishedCard.details)
            .font(.orbitMeta).foregroundStyle(Color.secondary).fixedSize()
        Image(systemName: "chevron.right")
            .font(.orbitMeta.weight(.semibold)).foregroundStyle(.tertiary)
            .rotationEffect(.degrees(open ? 90 : 0))
    }

    /// The run, its card, the uncommitted changes, who queued it, and what the agent read.
    private var fold: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(wake.runs, id: \.runId) { run in runMeta(run) }
            Text(SubagentFinishedCard.changes)
                .font(.orbitMeta).foregroundStyle(Color.secondary)
            Text(SubagentFinishedCard.queuedBy)
                .font(.orbitMeta).foregroundStyle(Color.secondary)
            raw
            if let attached { AttachedNoteEntry(attached: attached) }
        }
        .padding(.leading, 10)
        .overlay(alignment: .leading) {
            Rectangle().fill(Color.secondary.opacity(0.25)).frame(width: 2)
        }
        .padding(.leading, 20)
    }

    /// `Run 34y5Nxcq… · ↑ Its SubAgent card` — the link only where the card is in the transcript the
    /// console holds: a link to a card that is not loaded would go nowhere.
    private func runMeta(_ run: SubagentFinishedRun) -> some View {
        let card = cardLinks?.find(run.runId)
        return HStack(alignment: .firstTextBaseline, spacing: 4) {
            if several {
                Text("\(run.description) ·").font(.orbitMeta).foregroundStyle(Color.primary.opacity(0.75))
            }
            Text(SubagentFinishedCard.run).font(.orbitMeta).foregroundStyle(Color.secondary)
            Text(run.runId).font(.orbitMonoFine).foregroundStyle(Color.secondary).textSelection(.enabled)
            if let card, let cardLinks {
                Text("·").font(.orbitMeta).foregroundStyle(Color.secondary)
                Button(SubagentFinishedCard.cardLink) { cardLinks.reveal(card) }
                    .buttonStyle(.plain).font(.orbitMeta).foregroundStyle(.tint)
            }
        }
    }

    /// What the agent read, exactly as it read it — one more tap away and folded by default.
    private var raw: some View {
        DisclosureGroup(isExpanded: $showingRaw) {
            Text(wake.text)
                .font(.orbitMono)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 4)
        } label: {
            Text(SubagentFinishedCard.rawSummary)
                .font(.orbitMeta)
                .foregroundStyle(.secondary)
        }
    }

    /// Several runs: each one's mark, name and end, and one line of what it handed back.
    private var runs: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(wake.runs, id: \.runId) { run in
                let ok = SubagentFinishedCard.isOk(run)
                let empty = run.result.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: ok ? "checkmark" : "xmark")
                            .font(.orbitMeta.weight(.semibold))
                            .foregroundStyle(ok ? Color.green : Color.red)
                            .frame(width: 14)
                        Text(run.description)
                            .font(.orbitLabel)
                            .foregroundStyle(ok ? Color.primary : Color.red)
                            .fixedSize(horizontal: false, vertical: true)
                        SubagentStatusChip(text: SubagentFinishedCard.runStatus(run), failed: !ok)
                    }
                    inlineMarkdown(SubagentFinishedCard.runLine(run))
                        .font(.orbitMeta)
                        .italic(empty && run.reason == nil)
                        .foregroundStyle(empty && run.reason != nil ? Color.red : Color.secondary)
                        .lineLimit(1).truncationMode(.tail)
                        .padding(.leading, 20)
                }
            }
        }
        .modifier(SubagentOutcomeBox(failed: false))
    }
}

/// Under a lone run's line: why it ended if it did not finish, then what it handed back.
private struct SubagentRunOutcome: View {
    let run: SubagentFinishedRun

    var body: some View {
        let ok = SubagentFinishedCard.isOk(run)
        if !(ok && run.result.isEmpty) {
            VStack(alignment: .leading, spacing: 4) {
                if let reason = run.reason {
                    Text(reason)
                        .font(.orbitSubtext).foregroundStyle(Color.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if run.result.isEmpty {
                    Text(SubagentFinishedCard.noResult)
                        .font(.orbitSubtext).italic().foregroundStyle(Color.secondary)
                } else {
                    SubagentResultPreview(text: run.result)
                }
            }
            .modifier(SubagentOutcomeBox(failed: !ok))
        }
    }
}

/// A run's result as Markdown, three lines of it until the reader asks for the rest. Whether three
/// lines hold all of it is measured, so a short result offers nothing to open (web: `ResultPreview`).
private struct SubagentResultPreview: View {
    let text: String
    @State private var open = false
    @State private var clamped: CGFloat = 0
    @State private var whole: CGFloat = 0

    private var fits: Bool { whole > 0 && whole <= clamped + 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if open {
                MarkdownView(source: text)
                    .font(.orbitSubtext)
                    .textSelection(.enabled)
            } else {
                inlineMarkdown(text)
                    .font(.orbitSubtext)
                    .foregroundStyle(Color.primary)
                    .lineLimit(SubagentFinishedCard.previewLines)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { clamped = $0 }
                    .background(alignment: .topLeading) {
                        // The same words unclamped, never shown: how tall all of it would be.
                        inlineMarkdown(text)
                            .font(.orbitSubtext)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .hidden()
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { whole = $0 }
                    }
            }
            if open || !fits {
                Button {
                    withAnimation(.easeOut(duration: 0.15)) { open.toggle() }
                } label: {
                    HStack(spacing: 4) {
                        Text(open ? SubagentFinishedCard.showLess : SubagentFinishedCard.showFullResult)
                        Image(systemName: open ? "chevron.up" : "chevron.down").font(.orbitMeta)
                    }
                }
                .buttonStyle(.plain).font(.orbitMeta).foregroundStyle(.tint)
            }
        }
    }
}

/// The chip a line or a run closes on: grey, or red for a run that did not finish.
private struct SubagentStatusChip: View {
    let text: String
    let failed: Bool

    var body: some View {
        Text(text)
            .font(.orbitMonoFine)
            .foregroundStyle(failed ? Color.red : Color.secondary)
            .fixedSize()
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background((failed ? Color.red : Color.gray).opacity(failed ? 0.1 : 0.14),
                        in: RoundedRectangle(cornerRadius: 4))
    }
}

/// The sunken box a result sits in, hung off a rule: purple where it finished, red where it did not.
private struct SubagentOutcomeBox: ViewModifier {
    let failed: Bool

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 12).padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 6))
            .overlay(alignment: .leading) {
                Rectangle().fill(failed ? Color.red : Color.purple.opacity(0.45)).frame(width: 2)
            }
            .padding(.leading, 22)
    }
}

/// Where a SubAgent's line finds the card it was started from: the console's `delegate` call whose
/// result names the run, and the scroll to it (`ConsoleModel.revealAgent`). Nil where no console sets it.
struct SubagentCardLinks {
    let find: @MainActor (String) -> String?
    let reveal: @MainActor (String) -> Void
}

private struct SubagentCardLinksKey: EnvironmentKey {
    static let defaultValue: SubagentCardLinks? = nil
}

extension EnvironmentValues {
    var subagentCardLinks: SubagentCardLinks? {
        get { self[SubagentCardLinksKey.self] }
        set { self[SubagentCardLinksKey.self] = newValue }
    }
}
