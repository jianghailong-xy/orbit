#if os(iOS)
import SwiftUI
import UIKit
import OrbitKit

/// The **needs you** bar: one amber line under the nav bar saying that something is waiting on the
/// person reading, and taking them straight to it.
///
/// A blocked session is stopped work, not an unread message — there are rarely more than one or two,
/// and the job is to unblock it and get back out. So this is deliberately *one* signal with a
/// destination, rather than a trail of counts down the drawer's machine → agent tree: the app knows
/// where the thing is, so finding it shouldn't be the user's job. The drawer's per-agent badge stays
/// as the quiet answer to "which workspace", and nothing else repeats this fact.
///
/// IT NOW ALSO POINTS DOWN, INSIDE THE SESSION YOU ARE READING
/// -----------------------------------------------------------
/// The bar used to have nothing to say about the session on screen, and the reason written here was
/// that "its own approval card already renders inline at the tail of its transcript, so a bar
/// pointing at it would point at itself". That reason belongs to an APPROVAL: it stops the turn, so
/// nothing can arrive below it and it cannot leave the screen. The two cards a project's ruler is
/// decided from stop nothing — the coordinator keeps working and its messages push them up — so a
/// question delivered forty messages ago is off-screen and unfindable, which is precisely what this
/// bar exists to fix. So it stays, says what is below rather than where to go, and a press scrolls.
///
/// The in-conversation question WINS when both exist. Not because it is more urgent — a session
/// blocked elsewhere is stopped work — but because the bar can only carry one destination, this
/// one's destination is already on screen, and the other signal is still on every list, every other
/// console and the drawer's own badge. Leaving the conversation to find it would also lose the
/// reader's place in the one they are in.
///
/// Mounted with `.safeAreaInset(edge: .top)` so it sits below the nav bar and above the screen's own
/// content, leaving the console's bottom bands (background tray / worktree bar / composer) untouched.
/// With nothing waiting the body is empty, which insets by zero — the bar is absent from the layout
/// rather than present at zero height.
struct NeedsYouBannerView: View {
    @Environment(AppModel.self) private var model
    /// The session on screen, left out of the cross-session count — its own approval card already
    /// renders inline at the tail of its transcript, so a bar pointing at it would point at itself.
    /// nil from a list, which shows no one session.
    var excluding: String?
    /// Questions in THIS conversation that stop no turn, if any. Nil from a list, and from a console
    /// holding none.
    var below: OpenQuestionsBelow? = nil
    /// Where a press goes when the bar is pointing down: the console scrolls to that row.
    var onOpenBelow: ((String) -> Void)? = nil

    var body: some View {
        if let below {
            bar(text: below.text,
                chevron: "chevron.down",
                hint: "Scrolls to the question waiting in this conversation") {
                onOpenBelow?(below.rowID)
            }
        } else if let banner = model.needsYouBanner(excluding: excluding) {
            bar(text: banner.text,
                chevron: "chevron.forward",
                hint: "Opens the session waiting on you") {
                model.openNeedsYouSession(banner.target)
            }
        }
    }

    /// One bar, whichever fact it is carrying: the two differ in their words and in which way the
    /// chevron points, and in nothing else — it is one signal, and a second style for it would read
    /// as a second kind of thing.
    private func bar(text: String, chevron: String, hint: String,
                     action: @escaping () -> Void) -> some View {
        Button {
            // A press here moves the reader somewhere. The tap feedback is the same one the cards
            // give, so "I pressed it" is answered before the scroll starts.
            PlatformHaptics.tap()
            action()
        } label: {
            HStack(spacing: 9) {
                // The same 7pt amber dot the session lists use for "needs you", so the state is
                // said in one visual language app-wide (see `SessionLiveIndicator`).
                Circle()
                    .fill(.orange)
                    .frame(width: 7, height: 7)
                Text(text)
                    // Label-primary, NOT amber: amber text on the amber wash is the usual
                    // legibility trap, and it reads worst in dark mode where the wash is
                    // strongest. The tint and the dot carry the tone on their own.
                    .foregroundStyle(.primary)
                    .font(.orbitControl)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Image(systemName: chevron)
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
        .accessibilityLabel(text)
        .accessibilityHint(hint)
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
