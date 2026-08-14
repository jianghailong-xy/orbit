#if os(iOS)
import SwiftUI
import UIKit
import OrbitKit

/// The cross-session **needs you** bar: one amber line under the nav bar saying that a session
/// somewhere else is blocked on an approval, and taking you straight there.
///
/// A blocked session is stopped work, not an unread message — there are rarely more than one or two,
/// and the job is to unblock it and get back out. So this is deliberately *one* signal with a
/// destination, rather than a trail of counts down the drawer's machine → agent tree: the app knows
/// where the thing is, so finding it shouldn't be the user's job. The drawer's per-agent badge stays
/// as the quiet answer to "which workspace", and nothing else repeats this fact.
///
/// Mounted with `.safeAreaInset(edge: .top)` so it sits below the nav bar and above the screen's own
/// content, leaving the console's bottom bands (background tray / worktree bar / composer) untouched.
/// With nothing waiting the body is empty, which insets by zero — the bar is absent from the layout
/// rather than present at zero height.
struct NeedsYouBannerView: View {
    @Environment(AppModel.self) private var model
    /// The session on screen, left out of the count — its own approval card already renders inline at
    /// the tail of its transcript, so a bar pointing at it would point at itself. nil from a list,
    /// which shows no one session.
    var excluding: String?

    var body: some View {
        if let banner = model.needsYouBanner(excluding: excluding) {
            Button {
                model.openNeedsYouSession(banner.target)
            } label: {
                HStack(spacing: 9) {
                    // The same 7pt amber dot the session lists use for "needs you", so the state is
                    // said in one visual language app-wide (see `SessionLiveIndicator`).
                    Circle()
                        .fill(.orange)
                        .frame(width: 7, height: 7)
                    Text(banner.text)
                        // Label-primary, NOT amber: amber text on the amber wash is the usual
                        // legibility trap, and it reads worst in dark mode where the wash is
                        // strongest. The tint and the dot carry the tone on their own.
                        .foregroundStyle(.primary)
                        .font(.orbitControl)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.forward")
                        .font(.orbitMeta)
                        .foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 9)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(needsYouTint)
                // Hairline below only — the nav bar draws its own above.
                .overlay(alignment: .bottom) { Divider() }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(banner.text)
            .accessibilityHint("Opens the session waiting on you")
        }
    }
}

/// The bar's wash. Deliberately no pulse, no spring, no shimmer anywhere on this view: an approval
/// can sit unanswered for hours, above a transcript somebody is reading.
///
/// Dark needs the stronger tint — 12% systemOrange all but disappears on black — so the two are
/// resolved from the trait rather than from one flat opacity, matching how `CompactShell` builds its
/// drawer surfaces.
private let needsYouTint = Color(uiColor: UIColor { trait in
    UIColor.systemOrange.withAlphaComponent(trait.userInterfaceStyle == .dark ? 0.20 : 0.12)
})
#endif
