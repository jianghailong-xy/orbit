import SwiftUI
import OrbitKit

/// Observe again's question (§10.8): the door requires a reason, so the press asks for it in place —
/// the shape `Mark as handled`'s panel has on the same card — and says what an observation does
/// before anything is sent. Every word is `ExceptionCards`, the browser's own (`OBSERVE_MODAL_*`).
///
/// Its own view rather than a second field inside the exception card, which takes text in exactly
/// one place (its ending's reason): this is a different question, sent to a different door.
///
/// The draft is cleared only when the door took it, and the panel closes with it; a refusal leaves
/// both where they were, under the console's line saying what the server answered.
struct ObserveAgainPanel: View {
    let console: ConsoleModel
    /// The card's own in-flight flag: one press at a time across every door on the card.
    @Binding var sending: Bool
    let onClose: () -> Void
    @State private var reason = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(ExceptionCards.observeTitle)
                .font(.orbitProse.weight(.semibold))
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(ExceptionCards.observeBody)
                .font(.orbitLabel).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            TextField(ExceptionCards.observeReason, text: $reason, axis: .vertical)
                .lineLimit(2...5)
                .font(.orbitProse)
                .textFieldStyle(.roundedBorder)
                .disabled(sending)
                // The door's own ceiling, so nothing the reader types is taken and then refused.
                .onChange(of: reason) { _, typed in
                    if typed.count > ExceptionCards.observeMaxLength {
                        reason = String(typed.prefix(ExceptionCards.observeMaxLength))
                    }
                }
            HStack(spacing: 8) {
                Button {
                    onClose()
                } label: {
                    Text("Back").approvalActionLabel()
                }
                .buttonStyle(.bordered)
                .disabled(sending)
                Button {
                    observe()
                } label: {
                    Text(ExceptionCards.observeAgain).approvalActionLabel()
                }
                .buttonStyle(.borderedProminent)
                .disabled(sending || ExceptionCards.observeRequest(reason) == nil)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8).strokeBorder(Color.primary.opacity(0.12))
        }
    }

    /// The press holds the door's own line — a blank reason is not a press — and goes through the
    /// console, which owns the credential and re-reads the items: the observation then shows itself
    /// as the card's Handling row.
    private func observe() {
        guard !sending, ExceptionCards.observeRequest(reason) != nil else { return }
        PlatformHaptics.tap()
        sending = true
        Task {
            if await console.observeIntegration(reason: reason) {
                reason = ""
                onClose()
            }
            sending = false
        }
    }
}
