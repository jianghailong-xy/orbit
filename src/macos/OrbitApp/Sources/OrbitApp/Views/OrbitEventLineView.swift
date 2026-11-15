import SwiftUI
import OrbitKit

/// A turn Orbit opened whose note is a block no dedicated line knows (OrbitKit's `OrbitEvent`), drawn as
/// one event line in the agent's stream in the grammar a background job's news uses
/// (`BackgroundWakeCardView`): a neutral ⊕, "From Orbit", the block's name, when, and "Details" opening
/// the raw blocks the agent read. Never the reader's own bubble (owner rule 2026-11-16), no anchor for
/// the sticky bar, and never handed back to the composer.
///
/// Web parity: `OrbitEventLine.tsx`, in `OrbitEvent`'s words, which `OrbitEventCopyParityTests` holds
/// to the web's.
struct OrbitEventLineView: View {
    let note: String
    var ts: String?
    var undelivered: Bool = false
    /// How far a turn written into the running turn has got (`BackgroundWakeCard.steerState`).
    var steerState: String?

    @State private var open = false
    // The web opens the raw blocks with the fold: they are all there is to see.
    @State private var showingRaw = true

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            line
            if open { fold }
            if undelivered {
                Text(BackgroundWakeCard.undelivered)
                    .font(.orbitMeta).foregroundStyle(.orange)
                    .padding(.leading, 20)
            }
            if let steerState {
                Text(steerState)
                    .font(.orbitMeta).foregroundStyle(.secondary)
                    .padding(.leading, 20)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("orbit-event-line")
    }

    private var line: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                mark
                title
                nameText.fixedSize()
                closing
            }
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    mark
                    title
                }
                nameText.lineLimit(1).truncationMode(.tail).padding(.leading, 20)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    closing
                }
                .padding(.leading, 20)
            }
        }
        .font(.orbitLabel)
        .padding(.horizontal, 4).padding(.vertical, 3)
        .contentShape(Rectangle())
        .onTapGesture { withAnimation(.easeOut(duration: 0.15)) { open.toggle() } }
    }

    private var mark: some View {
        Text(OrbitEvent.mark)
            .font(.orbitMeta)
            .foregroundStyle(Color.secondary)
            .frame(width: 14)
    }

    private var title: some View {
        Text(OrbitEvent.title)
            .foregroundStyle(Color.secondary)
            .lineLimit(1)
            .fixedSize()
    }

    private var nameText: some View {
        Text(OrbitEvent.name(note)).font(.orbitLabel).foregroundStyle(Color.primary.opacity(0.75))
    }

    @ViewBuilder
    private var closing: some View {
        if let ts, let when = RelativeTime.format(ts) {
            Text(when).font(.orbitMeta).foregroundStyle(Color.secondary).fixedSize()
        }
        Text(OrbitEvent.details)
            .font(.orbitMeta).foregroundStyle(Color.secondary).fixedSize()
        Image(systemName: "chevron.right")
            .font(.orbitMeta.weight(.semibold)).foregroundStyle(.tertiary)
            .rotationEffect(.degrees(open ? 90 : 0))
    }

    /// What the agent read, exactly as it read it. A plain toggle rather than a `DisclosureGroup`: one that
    /// starts expanded draws no content inside the Mac transcript's list.
    private var fold: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(.easeOut(duration: 0.15)) { showingRaw.toggle() }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.right")
                        .font(.orbitMeta.weight(.semibold)).foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(showingRaw ? 90 : 0))
                    Text(OrbitEvent.whatTheAgentRead)
                        .font(.orbitMeta)
                        .foregroundStyle(.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if showingRaw {
                Text(note)
                    .font(.orbitMono)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.leading, 10)
        .overlay(alignment: .leading) {
            Rectangle().fill(Color.secondary.opacity(0.25)).frame(width: 2)
        }
        .padding(.leading, 20)
    }
}
