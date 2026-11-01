import SwiftUI
import OrbitKit

/// A turn Orbit wrote to tell a session about a committed fact — a fact a project's coordinator is
/// told, or the answer to a session's criteria proposal — drawn as one line instead of the owner's own
/// bubble (design: docs/mocks/coordinator-delivery-line/, approved 2026-10-31):
///
///   → Evidence revision 1 submitted: <task> · Sent to the coordinator · 07:30 PM ›
///
/// The words under it are written for the AGENT — a headline, then paragraphs of protocol — and drawn
/// as the owner's bubble they filled a screen with words the owner never wrote. What the reader needs
/// from the turn is what happened and when it was sent; the words stay one tap away, in a sheet, under
/// the heading the owner's answer uses, with the task the fact names linked at their foot.
///
/// The owner's answer's pill (`OwnerAnswerLineView`), dashed while the turn still waits on the queue.
/// The sentence gives way and `Sent to the coordinator · 07:30 PM` never does; on a phone the two take
/// a row each, the sentence first. Its sheet is hosted by the console (`openCoordinatorDelivery`), as
/// the answer's is, so a recycled row cannot dismiss it. Undelivered, it says so and offers nothing to
/// put back in the composer: the words are the platform's. Web parity: `CoordinatorDeliveryLine.tsx`,
/// every word from OrbitKit's `CoordinatorDeliveryCard`, which `CoordinatorDeliveryCopyParityTests`
/// holds to the web's. Where this conversation is not the project's coordinator (`toCoordinator`) — the
/// owner's answer to a criteria proposal a task's run filed — the line, its hint and its sheet say this
/// session instead.
struct CoordinatorDeliveryLineView: View {
    @Environment(\.openCoordinatorDelivery) private var openTold
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var hSize
    #endif
    let card: CoordinatorDelivery
    /// The words the agent was handed, verbatim — what the line opens to.
    let text: String
    var undelivered: Bool = false
    /// Whatever else the same turn's note carried, as its own folded entry under the words in the
    /// sheet: nobody typed this turn, so it never goes back into a bubble in the reader's name.
    var attached: (kind: String, text: String)?
    /// Withdraws a turn still queued behind the running one; nil once a runner has taken it.
    var onCancelQueued: (() -> Void)?

    private var queued: Bool { onCancelQueued != nil }

    /// A row each for the sentence and the time, where the conversation is phone-narrow.
    private var stacked: Bool {
        #if os(iOS)
        return hSize == .compact
        #else
        return false
        #endif
    }

    var body: some View {
        VStack(spacing: 4) {
            Button {
                openTold(CoordinatorDeliveryTold(card: card, text: text, attached: attached))
            } label: {
                // A capsule on one row; a rounded rectangle once the pill holds two. Off a phone the row
                // count is decided by the width (`words`), so the corner is one a single row draws as a capsule.
                if stacked {
                    pill(in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                } else {
                    pill(in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(CoordinatorDeliveryCard.line(card))
            .accessibilityHint(CoordinatorDeliveryCard.openHint(card))
            if undelivered {
                // Amber, not red: the turn was handed to a session that has not confirmed it.
                Text(CoordinatorDeliveryCard.undelivered).font(.orbitMeta).foregroundStyle(.orange)
            }
            if let onCancelQueued {
                HStack(spacing: 8) {
                    Text("Queued").font(.orbitMeta).foregroundStyle(.secondary)
                    Button("Cancel") { onCancelQueued() }
                        .buttonStyle(.plain)
                        .font(.orbitMeta)
                        .foregroundStyle(.tint)
                        .contentShape(Rectangle())
                }
            }
        }
        .frame(maxWidth: .infinity)
    }

    /// The pill's row — the arrow, the words, the chevron — on the owner's answer's grey, dashed while
    /// it still waits on the queue, as every queued card is.
    private func pill<S: InsettableShape>(in shape: S) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.right").accessibilityHidden(true)
            words
            Image(systemName: "chevron.right").font(.orbitMeta.weight(.semibold))
        }
        .font(.orbitLabel)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.secondary.opacity(0.1), in: shape)
        .overlay {
            if queued {
                shape.strokeBorder(Color.secondary.opacity(0.35), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
            }
        }
        .contentShape(shape)
    }

    /// The sentence, which truncates, then `Sent to the coordinator · 07:30 PM`, which does not.
    @ViewBuilder private var words: some View {
        let sentence = CoordinatorDeliveryCard.sentence(card)
        let sent = CoordinatorDeliveryCard.sent(card)
        if stacked {
            twoRows(sentence, sent)
        } else {
            // One row while the sentence keeps room to be read; a column too narrow for that — the Mac console
            // beside the session list, an iPad split — gets the phone's two rows. One row there cut the sentence
            // to its first letter: "E · Sent to the coordinator · 10/31/26, 11:42 PM" (the Mac probe, 2026-11-01).
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 4) {
                    Text(sentence).lineLimit(1).truncationMode(.tail)
                        .frame(minWidth: Self.sentenceFloor, idealWidth: Self.sentenceFloor, alignment: .leading)
                    Text("· \(sent)").lineLimit(1).fixedSize().foregroundStyle(.tertiary)
                        .layoutPriority(1)
                }
                twoRows(sentence, sent)
            }
        }
    }

    /// The least of the sentence one row keeps (its first few words) before the line takes two rows instead.
    private static let sentenceFloor: CGFloat = 160

    private func twoRows(_ sentence: String, _ sent: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(sentence).lineLimit(1).truncationMode(.tail)
            Text(sent).lineLimit(1).foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The words behind one delivery's line, opened from it.
struct CoordinatorDeliveryTold: Identifiable {
    let card: CoordinatorDelivery
    let text: String
    let attached: (kind: String, text: String)?
    var id: String { "\(card.kind.rawValue):\(card.deliveredAt):\(text.hashValue)" }
}

private struct OpenCoordinatorDeliveryKey: EnvironmentKey {
    static let defaultValue: (CoordinatorDeliveryTold) -> Void = { _ in }
}

extension EnvironmentValues {
    /// Opens the words a delivery's line stands for, in a sheet the console hosts.
    var openCoordinatorDelivery: (CoordinatorDeliveryTold) -> Void {
        get { self[OpenCoordinatorDeliveryKey.self] }
        set { self[OpenCoordinatorDeliveryKey.self] = newValue }
    }
}

/// What the coordinator was told — or this session, where it is not the project's coordinator: the line it
/// was sent as, then the words verbatim, then the task the fact names.
struct CoordinatorDeliverySheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    let told: CoordinatorDeliveryTold

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: ApprovalMetrics.spacing) {
                    Text(CoordinatorDeliveryCard.line(told.card))
                        .font(.orbitLabel).foregroundStyle(.secondary)
                    Text(told.text)
                        .font(.orbitMono)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let attached = told.attached { AttachedNoteEntry(attached: attached) }
                    if let url = CoordinatorDeliveryCard.taskLink(told.card) {
                        // Into the app's own `orbit-task:` door, once the sheet is out of the way.
                        Button(CoordinatorDeliveryCard.itsTask) {
                            dismiss()
                            openURL(url)
                        }
                        .buttonStyle(.plain).font(.orbitLabel).foregroundStyle(.tint)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
            }
            .navigationTitle(CoordinatorDeliveryCard.heading(told.card))
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                        .labelStyle(.iconOnly)
                }
            }
        }
        #if os(iOS)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        #else
        .frame(minWidth: 480, minHeight: 360)
        #endif
    }
}
