import SwiftUI
import OrbitKit

/// The two turns a confirmation review puts into a conversation, drawn as the cards they are rather
/// than as the reader's own bubble (docs/owner-confirmation-review-contract.md §2 D7, §8 B6) — web's
/// `ConfirmationReviewTurnCards.tsx`. Nobody typed either: the words are a block Orbit wrote for the
/// agent, which rides at the foot as the control plane's note (`attached`).
///
///  - In the REVIEWER's conversation, `Review requested`: which task's report it is asked to review,
///    by when, and the way onto the run that reported (`Open task session`).
///  - In the RUN's conversation, `Sent back by the reviewer`: who sent the report back, why, and each
///    problem — the reviewer's words under the reviewer's name, never the owner's.
///
/// Built like `ProjectStartedCardView`, which sits in the same place for the same reason.
struct ReviewRequestedCardView: View {
    let card: ConfirmationReviewRequestCard
    var ts: String?
    var undelivered: Bool = false
    var attached: (kind: String, text: String)?
    /// Withdraws the turn while it is still queued; nil once a runner has taken it.
    var onCancelQueued: (() -> Void)?

    @Environment(\.openURL) private var openURL

    private var queued: Bool { onCancelQueued != nil }
    private var tone: Color { .accentColor }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "checklist")
                    .font(.orbitMeta).foregroundStyle(tone)
                Text(OwnerConfirmations.reviewRequested)
                    .font(.orbitLabel.weight(.semibold)).foregroundStyle(tone)
                    .lineLimit(1)
                Spacer(minLength: 6)
            }
            if let url = ConfirmationReviewTurnLinks.task(card.taskId) {
                Button { openURL(url) } label: {
                    Text(card.title)
                        .font(.orbitProse.weight(.semibold))
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain).foregroundStyle(.tint)
            } else {
                Text(card.title)
                    .font(.orbitProse.weight(.semibold))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let due = OwnerConfirmations.receiptTime(card.dueAt) {
                Text(OwnerConfirmations.reviewDue(due))
                    .font(.orbitSubtext).foregroundStyle(.secondary)
            }
            if let url = ConfirmationReviewTurnLinks.session(card.runSessionId) {
                Button { openURL(url) } label: {
                    Text(OwnerConfirmations.openTaskSession)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
            if undelivered {
                Text(SessionMessageCard.undelivered)
                    .font(.orbitMeta).foregroundStyle(.orange)
            }
            if let attached { AttachedNoteEntry(attached: attached) }
            if let onCancelQueued { ReviewTurnQueuedFoot(cancel: onCancelQueued) }
        }
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

struct SentBackByReviewerCardView: View {
    let card: ConfirmationReturnCard
    var ts: String?
    var undelivered: Bool = false
    var attached: (kind: String, text: String)?
    var onCancelQueued: (() -> Void)?

    @Environment(\.openURL) private var openURL

    private var queued: Bool { onCancelQueued != nil }
    /// Something is wrong with the work: the amber of a thing to fix, not the brand of a notice.
    private var tone: Color { .orange }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.uturn.backward")
                    .font(.orbitMeta).foregroundStyle(tone)
                Text(OwnerConfirmations.sentBackByReviewer)
                    .font(.orbitLabel.weight(.semibold)).foregroundStyle(tone)
                    .lineLimit(1)
                Spacer(minLength: 6)
                if let ts, let time = OwnerConfirmations.receiptTime(ts) {
                    Text(time).font(.orbitMeta).foregroundStyle(.secondary)
                }
            }
            let reviewer = OwnerConfirmations.reviewerName(card.reviewerTitle)
            if let url = ConfirmationReviewTurnLinks.session(card.reviewerSessionId) {
                Button { openURL(url) } label: {
                    Text(reviewer)
                        .font(.orbitProse.weight(.semibold))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain).foregroundStyle(.tint)
            } else {
                Text(reviewer)
                    .font(.orbitProse.weight(.semibold))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !card.reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text("“\(card.reason)”")
                    .font(.orbitProse)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            ForEach(Array(card.problems.enumerated()), id: \.offset) { _, problem in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(OwnerConfirmations.reviewProblem)
                        .font(.orbitLabel).foregroundStyle(tone)
                        .frame(width: 64, alignment: .leading)
                    Text(problem.text)
                        .font(.orbitSubtext)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            if undelivered {
                Text(SessionMessageCard.undelivered)
                    .font(.orbitMeta).foregroundStyle(.orange)
            }
            if let attached { AttachedNoteEntry(attached: attached) }
            if let onCancelQueued { ReviewTurnQueuedFoot(cancel: onCancelQueued) }
        }
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

/// The queue's own line at a card's foot, in the words a queued message already uses.
private struct ReviewTurnQueuedFoot: View {
    let cancel: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Text("Queued").font(.orbitMeta).foregroundStyle(.secondary)
            Button("Cancel") { cancel() }
                .buttonStyle(.plain)
                .font(.orbitMeta)
                .foregroundStyle(.tint)
                .contentShape(Rectangle())
        }
    }
}
