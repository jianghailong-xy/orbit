import SwiftUI
import OrbitKit

/// The messages the reader sent that nothing has read yet, one row each, as the composer band's card
/// nearest the composer (docs/mocks/steer-tray, decided 2026-10-16; web parity: `PendingTray.tsx`).
/// They are not part of the conversation until the engine reads them (`TranscriptState.unreadSteers`),
/// so what is still open about each — where it is going, how far it got, the way to take it back — is
/// said here, where the next one is being typed.
///
/// A row is headed into the turn running now (a steer: ↳) or queued for the next one. A queued row on
/// an engine that takes a message mid-turn offers Steer, which sends it into the current turn.
/// Withdraw takes a row back and its words return to the composer under any draft. What a row cannot
/// do — a Codex steer cannot be given back once Codex has it — it does not offer.
struct PendingTrayView: View {
    let console: ConsoleModel
    let rows: [PendingTrayRow]
    /// Under the rows, why none of them can go into the turn running now — an engine that takes no
    /// message mid-turn (Cursor CLI's would stop the turn), said only while one is waiting for the
    /// next turn (board iOS 5 ⑤, web `PendingTray`'s `note`).
    var note: String? = nil

    var body: some View {
        if !rows.isEmpty {
            VStack(spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    if index > 0 { Divider().padding(.leading, 38) }
                    PendingTrayRowView(row: row,
                                       onSteer: { Task { await console.steerQueued(row.bubble) } },
                                       onWithdraw: { withdraw(row) })
                }
                if let note, rows.contains(where: { $0.heading == .nextTurn }) {
                    Divider().padding(.leading, 38)
                    Text(note)
                        .font(.orbitMeta)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.leading, 38)
                        .padding(.trailing, 12)
                        .padding(.vertical, 8)
                }
            }
            .composerBandCard(cornerRadius: 12)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Messages not read yet")
            .padding(.bottom, .composerBandGap)
        }
    }

    /// A steer — on its way into the turn, whoever holds it — is taken back by its own door; a message
    /// queued for the next turn by the queue's Cancel. Both hand the words back under the draft.
    private func withdraw(_ row: PendingTrayRow) {
        if row.bubble.steer {
            Task { await console.withdrawSteer(row.bubble) }
        } else {
            Task { await console.cancelQueued(row.bubble) }
        }
    }
}

private struct PendingTrayRowView: View {
    let row: PendingTrayRow
    let onSteer: () -> Void
    let onWithdraw: () -> Void
    /// One line, so a long message does not push the composer up the screen; pressed, the words open
    /// in place.
    @State private var open = false

    private var intoTurn: Bool { row.heading == .currentTurn }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: intoTurn ? "arrow.turn.down.right" : "text.line.last.and.arrowtriangle.forward")
                .font(.orbitLabel)
                .foregroundStyle(intoTurn ? Color.accentColor : Color.secondary)
                .frame(width: 16)
                .accessibilityLabel(intoTurn ? "Into the current turn" : "Queued for the next turn")
            if let image = row.bubble.attachments.first(where: \.isImage) {
                TrayThumb(attachment: image)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(row.text)
                    .font(row.bubble.shell ? .orbitMono : .orbitControl)
                    .foregroundStyle(row.bubble.text.isEmpty ? Color.secondary : Color.primary)
                    .lineLimit(open ? nil : 1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                    .onTapGesture { open.toggle() }
                Text(row.state)
                    .font(.orbitMeta)
                    .foregroundStyle(.secondary)
            }
            .opacity(row.busy ? 0.5 : 1)
            if !row.busy {
                if row.offersSteer {
                    Button(action: onSteer) {
                        Label("Steer", systemImage: "arrow.turn.down.right")
                            .font(.orbitLabel)
                    }
                    .buttonStyle(.borderless)
                    .help("Send into the current turn now")
                }
                if row.offersWithdraw {
                    Button(action: onWithdraw) {
                        Image(systemName: "trash")
                            .font(.orbitLabel)
                            .frame(width: 28, height: 28)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
                    .help("Withdraw — back to the composer")
                    .accessibilityLabel("Withdraw")
                }
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
    }
}

/// A row's picture, at the size of a line of text.
private struct TrayThumb: View {
    let attachment: TurnAttachment
    @Environment(AttachmentImageStore.self) private var store

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 6)
        Group {
            if let image = store.image(for: attachment.id) {
                Image(platformImage: image).resizable().scaledToFill()
            } else {
                Color.clear
            }
        }
        .frame(width: 26, height: 26)
        .background(.quaternary, in: shape)
        .clipShape(shape)
        .overlay { shape.strokeBorder(.primary.opacity(0.08)) }
        .loadsAttachmentImage(attachment.id, from: store)
    }
}
