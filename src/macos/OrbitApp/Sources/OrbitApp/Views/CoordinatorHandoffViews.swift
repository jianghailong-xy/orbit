import SwiftUI
import OrbitKit

// Start a new coordinator, after the context panel's press (docs/coordinator-handoff.md): the
// confirm (board 02 ①, macOS; the phone's is a system Alert, board 03 iOS 2), what the outgoing
// coordinator's conversation shows while it hands over (② ④ ⑤), and the note card its successor
// opens with (③). The words are OrbitKit's (`CoordinatorHandoffCopy`).

/// One action row of the context panel: an icon in a tile, a title and what it does. Accent-tinted
/// when `emphasized` (Compact from 75%, board 01 ①); greyed out when disabled.
struct ContextActionRow: View {
    let systemImage: String
    let title: String
    let detail: String
    var emphasized = false
    var enabled = true
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: systemImage)
                    .font(.orbitLabel.weight(.semibold))
                    .foregroundStyle(emphasized ? Color.accentColor : Color.secondary)
                    .frame(width: 24, height: 24)
                    .background(RoundedRectangle(cornerRadius: 6)
                        .fill(emphasized ? Color.accentColor.opacity(0.14) : Color.secondary.opacity(0.12)))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.orbitSubtext.weight(.semibold))
                    Text(detail).font(.orbitLabel).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: 8)
                .fill(Color.primary.opacity(enabled && (hovering || (emphasized && !hovering)) ? 0.06 : 0)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
        .onHover { hovering = $0 }
    }
}

/// The two symbols the context panel's rows carry (boards 01 and 03).
enum ContextActionSymbol {
    static let compact = "arrow.down.and.line.horizontal.and.arrow.up"
    static let newCoordinator = "arrow.right.to.line"
}

/// The confirm a press on Start a new coordinator opens on the Mac (board 02 ①): what will happen,
/// the note it writes and the waits that move (each named, a paused one saying so), then Cancel and
/// Hand over.
struct CoordinatorHandoffConfirmView: View {
    let projectTitle: String
    let running: Bool
    let waits: [CoordinatorPendingWait]
    let onCancel: () -> Void
    let onHandOver: () -> Void

    /// The body with the project's name in bold, where the copy puts it.
    private var bodyText: AttributedString {
        let marker = "\u{1}"
        let whole = running ? CoordinatorHandoffCopy.confirmBodyWhileRunning(marker)
                            : CoordinatorHandoffCopy.confirmBody(marker)
        let parts = whole.components(separatedBy: marker)
        var text = AttributedString(parts.first ?? "")
        var name = AttributedString(projectTitle)
        name.inlinePresentationIntent = .stronglyEmphasized
        text += name
        text += AttributedString(parts.dropFirst().joined(separator: projectTitle))
        return text
    }

    private var waitNames: String {
        waits.map { $0.label + ($0.paused ? CoordinatorHandoffCopy.pausedSuffix : "") }
            .joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(CoordinatorHandoffCopy.confirmTitle).font(.headline)
            Text(bodyText)
                .font(.orbitSubtext).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 10) {
                fact(symbol: "doc.text", title: CoordinatorHandoffCopy.noteRowTitle,
                     detail: CoordinatorHandoffCopy.noteRowDetail)
                // No waits, no row (the copy's own rule).
                if !waits.isEmpty {
                    fact(symbol: "timer", title: CoordinatorHandoffCopy.waitsRowTitle(waits.count),
                         detail: waitNames)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.08)))
            HStack {
                Spacer()
                Button(CoordinatorHandoffCopy.cancel, role: .cancel, action: onCancel)
                    .keyboardShortcut(.cancelAction)
                Button(CoordinatorHandoffCopy.handOver, action: onHandOver)
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
            }
            .controlSize(.large)
        }
        .padding(22)
        .frame(width: 380)
        .accessibilityIdentifier("coordinator-handoff-confirm")
    }

    private func fact(symbol: String, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: symbol).font(.orbitLabel).foregroundStyle(.secondary).frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.orbitLabel.weight(.semibold))
                Text(detail).font(.orbitLabel).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// What the outgoing coordinator's conversation shows above its composer while it hands over
/// (board 02 ② and ⑤): the note being written, with its clock and the two ways out; the handover
/// itself; or the failure, with what can still be done.
struct CoordinatorHandoffStatusView: View {
    let row: CoordinatorHandoffRow
    let onAction: (CoordinatorHandoffAction) -> Void

    var body: some View {
        switch row {
        case .writing(let startedAt):
            box(tint: .accentColor) {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(CoordinatorHandoffCopy.writing).foregroundStyle(Color.accentColor)
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(CoordinatorHandoffRow.clock(since: startedAt, now: context.date))
                            .monospacedDigit().foregroundStyle(.secondary)
                    }
                }
                buttons([(.skip, CoordinatorHandoffCopy.skipNote), (.cancel, CoordinatorHandoffCopy.cancelHandover)])
            }
        case .handingOver:
            box(tint: .accentColor) {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(CoordinatorHandoffCopy.handingOver).foregroundStyle(Color.accentColor)
                }
            }
        case .failed(let reason, let actions):
            box(tint: .red) {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.red)
                    Text(reason).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                }
                buttons(actions.map { ($0, CoordinatorHandoffRow.label($0)) })
            }
        case .completed:
            EmptyView()   // drawn in the composer's place (`CoordinatorHandedOverBanner`)
        }
    }

    private func box<Content: View>(tint: Color, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8, content: content)
            .font(.orbitSubtext)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10).fill(tint.opacity(0.08)))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(tint.opacity(0.18)))
            .accessibilityIdentifier("coordinator-handoff-status")
    }

    private func buttons(_ presses: [(CoordinatorHandoffAction, String)]) -> some View {
        // Wraps on a phone, where three presses do not fit one line (board 02 ⑤).
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { ForEach(presses, id: \.0) { press($0.0, $0.1) } }
            VStack(alignment: .leading, spacing: 8) { ForEach(presses, id: \.0) { press($0.0, $0.1) } }
        }
        .padding(.leading, 24)
    }

    private func press(_ action: CoordinatorHandoffAction, _ label: String) -> some View {
        Button(label) { onAction(action) }
            .buttonStyle(.bordered)
            .controlSize(.small)
    }
}

/// The composer while the note is written and the handover runs: nothing can be sent into a
/// conversation that is handing itself over (board 02 ②).
struct CoordinatorHandoffLockedComposer: View {
    var body: some View {
        Text(CoordinatorHandoffCopy.handingOver)
            .italic()
            .font(.orbitProse)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .composerBandCard(cornerRadius: 24)
            .accessibilityIdentifier("coordinator-handoff-locked-composer")
    }
}

/// In the composer's place once the conversation handed over (board 02 ④): where the project went
/// on, one press away — so nobody keeps typing into the old coordinator.
struct CoordinatorHandedOverBanner: View {
    let onOpen: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.right.circle.fill").foregroundStyle(.orange)
            Text(CoordinatorHandoffCopy.handedOver).font(.orbitSubtext)
            Spacer(minLength: 8)
            Button(CoordinatorHandoffCopy.openIt, action: onOpen)
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .composerBandCard(cornerRadius: 12)
        .accessibilityIdentifier("coordinator-handed-over")
    }
}

/// The successor's first row (board 02 ③): the note the previous coordinator wrote, in its four
/// sections, with a link back to it — then the waits that moved here.
struct CoordinatorHandoffNoteCardView: View {
    let received: SessionCoordinatorHandoffReceived
    let onOpenPrevious: () -> Void
    @State private var showingWaits = false

    private var time: String {
        guard let date = RelativeTime.parse(received.handedOverAt) else { return "" }
        return date.formatted(date: .omitted, time: .shortened)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 0) {
                header
                if let note = received.note, !note.isEmpty {
                    Divider()
                    sections(CoordinatorHandoffNote.parse(note))
                        .padding(14)
                }
            }
            .background(RoundedRectangle(cornerRadius: 10).fill(Color.secondary.opacity(0.05)))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.secondary.opacity(0.2)))
            if !received.movedWaits.isEmpty { waitsChip }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("coordinator-handoff-note")
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: ContextActionSymbol.newCoordinator).foregroundStyle(.secondary)
            // "Handoff from the previous coordinator · 3:42 PM", the last three words the link.
            let title = CoordinatorHandoffCopy.noteCardTitle
            let link = "the previous coordinator"
            let lead = title.hasSuffix(link) ? String(title.dropLast(link.count)) : title + " "
            let first = lead.split(separator: " ", maxSplits: 1).map(String.init)
            HStack(spacing: 0) {
                Text(first.first ?? "").fontWeight(.semibold)
                Text(" " + (first.count > 1 ? first[1] : "")).foregroundStyle(.secondary)
                Button(link, action: onOpenPrevious).buttonStyle(.plain).foregroundStyle(Color.accentColor)
                if !time.isEmpty { Text(" · \(time)").foregroundStyle(.secondary) }
            }
            .font(.orbitSubtext)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private func sections(_ note: CoordinatorHandoffNote) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if !note.preamble.isEmpty {
                Text(note.preamble).font(.orbitSubtext).textSelection(.enabled)
            }
            ForEach(Array(note.sections.enumerated()), id: \.offset) { _, section in
                VStack(alignment: .leading, spacing: 4) {
                    Text(section.title).font(.orbitLabel.weight(.semibold))
                    ForEach(Array(section.items.enumerated()), id: \.offset) { _, item in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text("•").foregroundStyle(.secondary)
                            Text(item).fixedSize(horizontal: false, vertical: true)
                        }
                        .font(.orbitSubtext)
                        .textSelection(.enabled)
                    }
                }
            }
        }
    }

    private var waitsChip: some View {
        Button { showingWaits.toggle() } label: {
            HStack(spacing: 5) {
                Image(systemName: "timer")
                Text(CoordinatorHandoffCopy.waitsMovedHere(received.movedWaits.count))
            }
            .font(.orbitLabel)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Capsule().fill(Color.secondary.opacity(0.1)))
        }
        .buttonStyle(.plain)
        .popover(isPresented: $showingWaits) {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(received.movedWaits) { wait in
                    Text(wait.label + (wait.paused ? CoordinatorHandoffCopy.pausedSuffix : ""))
                        .font(.orbitLabel)
                }
            }
            .padding(14)
            .presentationCompactAdaptation(.popover)
        }
    }
}
