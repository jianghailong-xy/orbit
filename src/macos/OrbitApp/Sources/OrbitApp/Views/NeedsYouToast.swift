#if os(iOS)
import SwiftUI
import OrbitKit

/// One notice that a conversation has just started waiting on you (the owner, 2026-11-15,
/// `docs/mocks/needs-you-capsule/12-once`): drawn by the toast host, in the toasts' own column, glass
/// and motion, above the other toasts. It says which conversation and what it waits on, once — how
/// many wait is the lists' to say (a row's mark, the drawer's badges, the count on ☰). A press opens
/// the conversation at that card; a flick up sends it away; it goes on its own after six seconds.
///
/// It replaced a resident needs-you bar ("2 sessions need you") that each page mounted for itself:
/// "if it is a toast, it is a notice that happened once" (the owner, the same day).
struct NeedsYouToastCard: View {
    @Environment(AppModel.self) private var model
    let notice: NeedsYouToast
    /// An iPad's wide shell: a merge into main opens in its session column.
    var projectInColumn = false
    @State private var lift: CGFloat = 0

    var body: some View {
        Button {
            PlatformHaptics.tap()
            model.openNeedsYouToast(notice, projectInColumn: projectInColumn)
        } label: {
            HStack(spacing: 12) {
                // The Landing head's circle (`ProjectLandingRow.mark`): the one place the amber is.
                Image(systemName: notice.glyph.symbol)
                    .font(.orbitControl)
                    .foregroundStyle(.orange)
                    .frame(width: 38, height: 38)
                    .background(Color.orange.opacity(0.15), in: Circle())
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(notice.title)
                        .font(.orbitSubtext.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Text(notice.line)
                        .font(.orbitSubtext)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 12)
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // The commit toast's glass (`toastGlass`), ringed amber for what waits on you.
        .needsYouToastGlass(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(Color.orange.opacity(0.7), lineWidth: 1.5)
                .allowsHitTesting(false)
        }
        .offset(y: lift)
        .simultaneousGesture(
            DragGesture(minimumDistance: 10, coordinateSpace: .global)
                .onChanged { lift = min(0, $0.translation.height) }
                .onEnded { value in
                    if value.translation.height < -24 || value.predictedEndTranslation.height < -60 {
                        model.dismissNeedsYouToast(notice.id)
                    } else {
                        withAnimation(.snappy) { lift = 0 }
                    }
                }
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(notice.title), \(notice.line)")
        .accessibilityHint(notice.terminal != nil ? Terminals.needsYouHint
                          : notice.ownerItem == nil ? "Opens the session waiting on you"
                                                    : "Opens the card waiting on you")
        .accessibilityAction(named: "Dismiss") { model.dismissNeedsYouToast(notice.id) }
        .accessibilityIdentifier("needs-you-toast")
    }
}

/// "and 2 more", under the third notice when more started waiting at once.
struct NeedsYouToastMore: View {
    let count: Int

    var body: some View {
        Text("and \(count) more")
            .font(.orbitLabel.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .needsYouToastGlass(Capsule())
    }
}

extension NeedsYouGlyph {
    /// The SF Symbol for each mark, filled where the symbol has a fill, as the Landing head's are.
    var symbol: String {
        switch self {
        case .merge: return "arrow.triangle.merge"
        case .question: return "questionmark.bubble.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .pause: return "pause.fill"
        case .hand: return "hand.raised.fill"
        // A terminal asking to be approved — the same mark the Mac list's Needs you line draws.
        case .terminal: return "terminal"
        }
    }
}

private extension View {
    /// The toast host's surface (`toastGlass`): on iOS 26 Liquid Glass and nothing around it; before
    /// it, the regular material with a hairline edge and a soft shadow.
    @ViewBuilder func needsYouToastGlass<S: InsettableShape>(_ shape: S) -> some View {
        if #available(iOS 26.0, *) {
            glassEffect(.regular, in: shape)
        } else {
            background {
                shape.fill(.regularMaterial)
                    .overlay(shape.strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.7))
                    .shadow(color: .black.opacity(0.16), radius: 12, y: 4)
            }
        }
    }
}
#endif
