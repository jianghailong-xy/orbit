import SwiftUI
import OrbitKit

/// Five more of Orbit's own turns, drawn as the cards they are rather than as the reader's bubble or
/// an empty bubble with the block folded under it (docs/mocks/orbit-turn-cards/) — web's
/// `OrbitTurnCards.tsx`. Built like the confirmation-review cards beside them: what happened in one
/// line, links instead of ids, local times, and the block the agent read folded at the foot.
///
///  - `Evidence to review`: a revision handed to the session that dispatched its task.
///  - `Evidence sent back`: a send-back's note handed to the run that submitted the revision.
///  - `Question from a task run` / `Notice from a task run`: a run's question or notify, handed to its
///    project's coordinator. The question card is read-only: the coordinator answers with session_reply.
///  - The opening of a session Orbit opened: one grey row saying why, the brief folded under it.

/// The frame every one of these cards shares: its tint, and a dashed outline while it waits.
private struct OrbitTurnCardFrame: ViewModifier {
    let tone: Color
    let queued: Bool

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tone.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            .overlay(
                RoundedRectangle(cornerRadius: 8).strokeBorder(
                    tone.opacity(0.30),
                    style: StrokeStyle(lineWidth: 1, dash: queued ? [4, 3] : []))
            )
    }
}

/// The card's head: its mark, its name, and the turn's time at the right.
private struct OrbitTurnCardHead: View {
    let symbol: String
    let title: String
    let tone: Color
    let ts: String?

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: symbol).font(.orbitMeta).foregroundStyle(tone)
            Text(title).font(.orbitLabel.weight(.semibold)).foregroundStyle(tone).lineLimit(1)
            Spacer(minLength: 6)
            if let ts, let time = OwnerConfirmations.receiptTime(ts) {
                Text(time).font(.orbitMeta).foregroundStyle(.secondary)
            }
        }
    }
}

/// A title that opens what it names, or plain words where the id names nothing.
private struct OrbitTurnCardLink: View {
    let title: String
    let url: URL?
    var font: Font = .orbitProse.weight(.semibold)

    @Environment(\.openURL) private var openURL

    var body: some View {
        if let url {
            Button { openURL(url) } label: {
                Text(title).font(font)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain).foregroundStyle(.tint)
        } else {
            Text(title).font(font).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// The words the agent read, folded at the card's foot under the name the web gives them.
private struct OrbitTurnCardTold: View {
    let label: String
    let text: String
    @State private var open = false

    var body: some View {
        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            DisclosureGroup(isExpanded: $open) {
                Text(text)
                    .font(.orbitMono)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 4)
            } label: {
                Text(label).font(.orbitMeta).foregroundStyle(.secondary)
            }
        }
    }
}

private struct OrbitTurnCardStateText: View {
    let line: OrbitTurnCardStateLine

    var body: some View {
        Text(line.text)
            .font(.orbitMeta)
            .foregroundStyle(line.tone == .warning ? AnyShapeStyle(.orange)
                : line.tone == .success ? AnyShapeStyle(.green) : AnyShapeStyle(.secondary))
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct OpenTaskSessionButton: View {
    let sessionId: String
    @Environment(\.openURL) private var openURL

    var body: some View {
        if let url = ConfirmationReviewTurnLinks.session(sessionId) {
            Button { openURL(url) } label: { Text(OwnerConfirmations.openTaskSession) }
                .buttonStyle(.bordered)
                .controlSize(.small)
        }
    }
}

private struct UndeliveredLine: View {
    var body: some View {
        Text(SessionMessageCard.undelivered).font(.orbitMeta).foregroundStyle(.orange)
    }
}

struct EvidenceToReviewCardView: View {
    let card: EvidenceReviewCard
    /// The block the session was handed: the turn's note once delivered, its words while queued.
    let told: String
    var ts: String?
    var undelivered: Bool = false
    var onCancelQueued: (() -> Void)?

    @State private var showAll = false

    private var tone: Color { card.state == .open ? .accentColor : .secondary }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            OrbitTurnCardHead(symbol: "doc.text.magnifyingglass", title: OrbitTurnCardCopy.evidenceToReview,
                              tone: tone, ts: ts)
            OrbitTurnCardLink(title: card.title, url: ConfirmationReviewTurnLinks.task(card.taskId))
            Text(OrbitTurnCardCopy.evidenceMeta(card)).font(.orbitSubtext).foregroundStyle(.secondary)
            if let claim = card.claim, !claim.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text(claim)
                        .font(.orbitSubtext)
                        .lineLimit(showAll ? nil : 3)
                        .fixedSize(horizontal: false, vertical: true)
                    Button(showAll ? OrbitTurnCardCopy.showLess : OrbitTurnCardCopy.showAll) { showAll.toggle() }
                        .buttonStyle(.plain).font(.orbitMeta).foregroundStyle(.tint)
                }
                .padding(.leading, 8)
                .overlay(alignment: .leading) { Rectangle().fill(.secondary.opacity(0.3)).frame(width: 2) }
            }
            OrbitTurnCardStateText(line: OrbitTurnCardCopy.evidenceState(card))
            if card.state == .open { OpenTaskSessionButton(sessionId: card.runSessionId) }
            if undelivered { UndeliveredLine() }
            OrbitTurnCardTold(label: OrbitTurnCardCopy.sessionWasTold, text: told)
            if let onCancelQueued { ReviewTurnQueuedFoot(cancel: onCancelQueued) }
        }
        .modifier(OrbitTurnCardFrame(tone: tone, queued: onCancelQueued != nil))
    }
}

struct EvidenceSentBackCardView: View {
    let card: EvidenceSendBackCard
    let text: String
    var ts: String?
    var undelivered: Bool = false
    var attached: (kind: String, text: String)?
    var onCancelQueued: (() -> Void)?

    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            OrbitTurnCardHead(symbol: "arrow.uturn.backward", title: OrbitTurnCardCopy.evidenceSentBack,
                              tone: .orange, ts: ts)
            OrbitTurnCardLink(title: card.title, url: ConfirmationReviewTurnLinks.task(card.taskId))
            HStack(spacing: 0) {
                Text(OrbitTurnCardCopy.sendBackLead(card)).foregroundStyle(.secondary)
                if !card.byOwner, let url = ConfirmationReviewTurnLinks.session(card.bySessionId) {
                    Button { openURL(url) } label: { Text(OrbitTurnCardCopy.sendBackWho(card)) }
                        .buttonStyle(.plain).foregroundStyle(.tint)
                } else {
                    Text(OrbitTurnCardCopy.sendBackWho(card)).foregroundStyle(.secondary)
                }
            }
            .font(.orbitSubtext)
            Text("\u{201C}\(card.note)\u{201D}")
                .font(.orbitProse)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if undelivered { UndeliveredLine() }
            OrbitTurnCardTold(label: OrbitTurnCardCopy.runWasTold, text: text)
            if let attached { AttachedNoteEntry(attached: attached) }
            if let onCancelQueued { ReviewTurnQueuedFoot(cancel: onCancelQueued) }
        }
        .modifier(OrbitTurnCardFrame(tone: .orange, queued: onCancelQueued != nil))
    }
}

struct RunQuestionCardView: View {
    let card: RunQuestionCard
    let told: String
    var ts: String?
    var undelivered: Bool = false
    var onCancelQueued: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            OrbitTurnCardHead(symbol: "questionmark.circle", title: OrbitTurnCardCopy.questionFromTaskRun,
                              tone: .accentColor, ts: ts)
            OrbitTurnCardLink(title: OrbitTurnCardCopy.taskTitle(card.taskTitle),
                              url: ConfirmationReviewTurnLinks.task(card.taskId))
            ForEach(Array(card.questions.enumerated()), id: \.offset) { _, question in
                VStack(alignment: .leading, spacing: 2) {
                    Text(question.question)
                        .font(.orbitSubtext.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    ForEach(Array(card.lines(question).enumerated()), id: \.offset) { _, line in
                        Text(line.text)
                            .font(line.picked ? .orbitSubtext.weight(.semibold) : .orbitSubtext)
                            .foregroundStyle(line.picked ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            OrbitTurnCardStateText(line: OrbitTurnCardCopy.questionState(card))
            if !card.answered { OpenTaskSessionButton(sessionId: card.runSessionId) }
            if undelivered { UndeliveredLine() }
            OrbitTurnCardTold(label: OrbitTurnCardCopy.coordinatorWasTold, text: told)
            if let onCancelQueued { ReviewTurnQueuedFoot(cancel: onCancelQueued) }
        }
        .modifier(OrbitTurnCardFrame(tone: .accentColor, queued: onCancelQueued != nil))
    }
}

struct RunNoticeCardView: View {
    let card: RunNoticeCard
    let told: String
    var ts: String?
    var undelivered: Bool = false
    var onCancelQueued: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            OrbitTurnCardHead(symbol: "bell", title: OrbitTurnCardCopy.noticeFromTaskRun, tone: .secondary, ts: ts)
            OrbitTurnCardLink(title: OrbitTurnCardCopy.taskTitle(card.taskTitle),
                              url: ConfirmationReviewTurnLinks.task(card.taskId))
            Text("\u{201C}\(card.message)\u{201D}")
                .font(.orbitProse)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(OrbitTurnCardCopy.noticeState).font(.orbitMeta).foregroundStyle(.secondary)
            if undelivered { UndeliveredLine() }
            OrbitTurnCardTold(label: OrbitTurnCardCopy.coordinatorWasTold, text: told)
            if let onCancelQueued { ReviewTurnQueuedFoot(cancel: onCancelQueued) }
        }
        .modifier(OrbitTurnCardFrame(tone: .secondary, queued: onCancelQueued != nil))
    }
}

/// Not a card on the reader's side: one full-width grey row saying why Orbit opened this session,
/// with the brief it wrote for the agent folded under it.
struct SessionOpeningRowView: View {
    let card: SessionOpeningCard
    let text: String
    var undelivered: Bool = false
    var onCancelQueued: (() -> Void)?

    @State private var open = false
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "smallcircle.filled.circle").font(.orbitMeta).foregroundStyle(.secondary)
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(card.lead).foregroundStyle(.secondary)
                    if let target = card.linkedTarget {
                        if let url = target.url {
                            Button { openURL(url) } label: { Text(target.title) }
                                .buttonStyle(.plain).foregroundStyle(.tint)
                        } else {
                            Text(target.title)
                        }
                    }
                }
                .font(.orbitSubtext)
                Spacer(minLength: 6)
                if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Button(open ? OrbitTurnCardCopy.hideBrief : OrbitTurnCardCopy.showBrief) { open.toggle() }
                        .buttonStyle(.plain).font(.orbitMeta).foregroundStyle(.secondary)
                }
            }
            if let mention = card.mention, card.kind == .mention, !mention.isEmpty {
                Text("\u{201C}\(mention)\u{201D}")
                    .font(.orbitSubtext)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 8)
                    .overlay(alignment: .leading) { Rectangle().fill(.secondary.opacity(0.3)).frame(width: 2) }
            }
            if open {
                Text(text)
                    .font(.orbitMono)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
            }
            if undelivered { UndeliveredLine() }
            if let onCancelQueued { ReviewTurnQueuedFoot(cancel: onCancelQueued) }
        }
        .modifier(OrbitTurnCardFrame(tone: .secondary, queued: onCancelQueued != nil))
    }
}
