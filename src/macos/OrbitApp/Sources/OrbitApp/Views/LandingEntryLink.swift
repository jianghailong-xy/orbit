import SwiftUI
import OrbitKit

/// The landing a code session's work fed, at that session's own bottom (owner 2026-10-19, board v4
/// 06 e): a derived label, not a turn — the source session did the work, the platform lands it, and
/// the label opens the landing session where every attempt is read. Absent from a session that
/// produced no landing work, and from a server that predates the field.
struct SourceLandingChip: View {
    let console: ConsoleModel
    @Environment(\.openURL) private var openURL

    private var label: SourceLandingLabel? {
        SessionProjectLandings.sourceLabel(console.worktree.detail?.sourceLanding)
    }

    private var sessionID: String? {
        console.worktree.detail?.sourceLanding?.landingSessionId
    }

    /// The worktree card says the landing itself where there is one (board
    /// docs/mocks/session-landing-slot-ios); this chip stands only for a session without it.
    private var carriedByWorktreeBar: Bool {
        let d = console.worktree.detail
        return WorktreeBarLogic.carriesSourceLanding(isolationStatus: d?.isolationStatus, branch: d?.branch)
    }

    var body: some View {
        if !carriedByWorktreeBar, let label, let sessionID, !sessionID.isEmpty {
            Button {
                PlatformHaptics.tap()
                if let url = URL(string: "orbit-session:\(PublicID.toPublic(sessionID))") {
                    openURL(url)
                }
            } label: {
                HStack(spacing: 4) {
                    if label.tone == "run" {
                        Image(systemName: "arrow.triangle.2.circlepath")
                            .accessibilityHidden(true)
                    }
                    Text("\(label.text) ›")
                }
                .font(.orbitLabel.weight(.semibold))
                .foregroundStyle(ink(label.tone))
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(ink(label.tone).opacity(0.12), in: Capsule())
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, .composerBandGap)
            .task { await console.worktree.loadDetail() }
        }
    }

    private func ink(_ tone: String) -> Color {
        switch tone {
        case "run": return .accentColor
        case "landed": return .green
        case "failed": return .orange
        default: return .secondary
        }
    }
}

/// An open landing as the worktree card's second row (board docs/mocks/session-landing-slot-ios):
/// queued is a still clock on grey, an attempt at work a spinner on blue, a stopped one amber. The
/// whole row opens the landing session, where every attempt is read and a stopped one is dealt with.
struct SourceLandingRow: View {
    let slot: SourceLandingSlot
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 6) {
                Group {
                    switch slot.kind {
                    case .running: ProgressView().controlSize(.small)
                    case .stopped: Image(systemName: "exclamationmark.triangle")
                    default: Image(systemName: "clock")
                    }
                }
                .font(.orbitMeta.weight(.semibold))
                .frame(width: 16)
                Text(slot.text)
                    .font(.orbitLabel.weight(.semibold))
                    .lineLimit(1)
                    .layoutPriority(1)
                if let into = slot.into {
                    Text("· \(into)")
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 4)
                Text("Open ›")
                    .font(.orbitLabel.weight(.semibold))
                    .foregroundStyle(slot.kind == .queued ? Color.accentColor : ink)
                    .fixedSize()
            }
            .foregroundStyle(ink)
            .padding(.horizontal, 10)
            .frame(minHeight: 30)
            .background(fill, in: RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens the landing")
    }

    private var ink: Color {
        switch slot.kind {
        case .running: return .accentColor
        case .stopped: return .orange
        default: return .primary
        }
    }

    private var fill: Color {
        switch slot.kind {
        case .running: return Color.accentColor.opacity(0.1)
        case .stopped: return Color.orange.opacity(0.12)
        default: return Color.primary.opacity(0.05)
        }
    }
}

/// "Open landing ›" — the explicit way into the landing session a piece of work belongs to (contract
/// §2.9 LS6, owner 2026-10-19: 方案 A). The presses main already had are untouched: a Landing card
/// and a Work overview card still open the jobs in flight, and a job's row still opens its task.
/// This is the one thing said in words, drawn beside them.
///
/// On a server that names no landing session the same slot says so in grey, and nothing presses: the
/// reader learns why the way in is missing rather than hunting for it.
struct LandingEntryLink: View {
    let entry: LandingEntry
    /// The quieter size a job row or a card foot wears.
    var compact = true
    @Environment(\.openURL) private var openURL

    var body: some View {
        switch entry {
        case .link(let sessionID):
            Button {
                PlatformHaptics.tap()
                if let url = URL(string: "orbit-session:\(PublicID.toPublic(sessionID))") {
                    openURL(url)
                }
            } label: {
                HStack(spacing: 2) {
                    Text(LandingPageCopy.openLanding)
                    Image(systemName: "chevron.right")
                }
            }
            .font(compact ? .orbitLabel.weight(.semibold) : .orbitLabel)
            .buttonStyle(.plain)
            .foregroundStyle(Color.accentColor)
            .accessibilityLabel(LandingPageCopy.openLanding)
        case .noPage:
            Text(LandingPageCopy.noLandingPage)
                .font(.orbitMeta)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
