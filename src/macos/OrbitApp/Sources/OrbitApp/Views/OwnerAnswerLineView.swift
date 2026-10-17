import SwiftUI
import OrbitKit

/// The owner's answer handed to the coordinator, drawn as one line — "Sent to the coordinator · 08:29"
/// — instead of the owner's own bubble (design: docs/mocks/coordinator-question-answered, step 4).
///
/// The owner already reads what they answered on the question's own card. The turn under it is the
/// platform handing that answer on, in words written for the AGENT — the question replayed in full,
/// the answer, an ISO moment — and it used to be drawn as the owner's bubble: the question asked a
/// second time, in the reader's name. What the reader needs from it is that it was sent and when; the
/// words stay one tap away, in a sheet, for whoever wants to check what the coordinator read.
///
/// The pill a merge's record is drawn as (`PromotionReceiptLine`), saying what a version handed to
/// its coordinator says (`SentToCoordinatorLine`) on the same clock. Its sheet is hosted by the
/// console (`openOwnerAnswer`), as the receipt's is, so a recycled row cannot dismiss it. Web parity:
/// `OwnerAnswerLine.tsx`, every word from OrbitKit's `OwnerAnswerCard`, which
/// `OwnerAnswerCopyParityTests` holds to the web's.
struct OwnerAnswerLineView: View {
    @Environment(\.openOwnerAnswer) private var openTold
    let card: OwnerAnswer
    /// The words the agent was handed, verbatim — what the line opens to.
    let text: String
    var undelivered: Bool = false
    /// Whatever else the same turn's note carried, as its own folded entry under the words in the
    /// sheet: nobody typed this turn, so it never goes back into a bubble in the reader's name.
    var attached: (kind: String, text: String)?
    /// Withdraws an answer still queued behind the running turn; nil once a runner has taken it.
    var onCancelQueued: (() -> Void)?

    private var queued: Bool { onCancelQueued != nil }

    var body: some View {
        VStack(spacing: 4) {
            Button { openTold(OwnerAnswerTold(card: card, text: text, attached: attached)) } label: {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.right").accessibilityHidden(true)
                    Text(OwnerAnswerCard.line(card)).lineLimit(2).multilineTextAlignment(.leading)
                    Image(systemName: "chevron.right").font(.orbitMeta.weight(.semibold))
                }
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Color.secondary.opacity(0.1), in: Capsule())
                // Dashed while it still waits on the queue, as every queued card is.
                .overlay {
                    if queued {
                        Capsule().strokeBorder(Color.secondary.opacity(0.35),
                                               style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                    }
                }
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens what the coordinator was told")
            if undelivered {
                // Amber, not red: the turn was handed to a session that has not confirmed it.
                Text(OwnerAnswerCard.undelivered).font(.orbitMeta).foregroundStyle(.orange)
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
}

/// The words behind one answer's line, opened from it.
struct OwnerAnswerTold: Identifiable {
    let card: OwnerAnswer
    let text: String
    let attached: (kind: String, text: String)?
    var id: String { "\(card.itemId):\(card.sessionId)" }
}

private struct OpenOwnerAnswerKey: EnvironmentKey {
    static let defaultValue: (OwnerAnswerTold) -> Void = { _ in }
}

extension EnvironmentValues {
    /// Opens the words an answer's line stands for, in a sheet the console hosts.
    var openOwnerAnswer: (OwnerAnswerTold) -> Void {
        get { self[OpenOwnerAnswerKey.self] }
        set { self[OpenOwnerAnswerKey.self] = newValue }
    }
}

/// What the coordinator was told: the line it was sent as, then the words verbatim.
struct OwnerAnswerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let told: OwnerAnswerTold

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: ApprovalMetrics.spacing) {
                    Text(OwnerAnswerCard.line(told.card))
                        .font(.orbitLabel).foregroundStyle(.secondary)
                    Text(told.text)
                        .font(.orbitMono)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let attached = told.attached { AttachedNoteEntry(attached: attached) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
            }
            .navigationTitle(OwnerAnswerCard.told)
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
