#if os(iOS)
import SwiftUI
import UIKit
import OrbitKit

/// The **needs you** bar: one capsule under the nav bar saying that something is waiting on the
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
/// bar exists to fix. A press reveals that card and opens its review when available.
///
/// The in-conversation question WINS when both exist. Not because it is more urgent — a session
/// blocked elsewhere is stopped work — but because the bar can only carry one destination, this
/// one's destination is already on screen, and the other signal is still on every list, every other
/// console and the drawer's own badge. Leaving the conversation to find it would also lose the
/// reader's place in the one they are in.
///
/// A CAPSULE, NOT A BAND (the owner, 2026-10-21, board `docs/mocks/needs-you-capsule`)
/// ---------------------------------------------------------------------------------
/// It was a full-width band, washed amber over the bar material that ran on up behind the nav bar:
/// in dark mode the top 154pt read as two slabs, grey and brown, under nav buttons that are glass,
/// and its one line spent most of its width on the kind and truncated the project. Now it is the
/// glass the nav bar's own controls are made of, standing in from the edges as the back button and ⋯
/// do: the amber is the 30pt circle the Landing head marks with (`ProjectLandingRow.mark`), one mark
/// per kind, and the words are two lines — what is waiting, and where — with how long it has waited.
///
/// Mounted at the top of the screen it is about: a conversation's safe-area bar on iOS 26, which the
/// transcript's scroll-edge effect runs on under as it does under the nav bar
/// (`floatsOverTranscript`), and a top inset everywhere else, on the page's own colour so the rows it
/// covers don't read through. With nothing waiting the body is empty, which insets by zero — the bar
/// is absent from the layout rather than present at zero height.
struct NeedsYouBannerView: View {
    @Environment(AppModel.self) private var model
    /// Whether the transcript scrolls on under the bar with the system's scroll-edge effect softening
    /// it (a conversation's safe-area bar, iOS 26). Anywhere else the rows would read through the gap
    /// around the capsule, so it stands on the page's own colour.
    @Environment(\.floatsOverTranscript) private var floats
    /// The session on screen, left out of the cross-session count — its own approval card already
    /// renders inline at the tail of its transcript, so a bar pointing at it would point at itself.
    /// nil from a list, which shows no one session.
    var excluding: String?
    /// Questions in THIS conversation that stop no turn, if any. Nil from a list, and from a console
    /// holding none.
    var below: WaitingBelow? = nil
    /// The console reveals this row and opens its existing review, if it has one.
    var onOpenBelow: ((String) -> Void)? = nil
    /// Whether a project's sessions page opens in this shell's session column (an iPad's wide
    /// shell) rather than as a page of its own — where the merge into main's card is.
    var projectInColumn = false
    /// The bar's own width, for the margin that lines it up with the nav bar's buttons.
    @State private var width: CGFloat = 0

    var body: some View {
        if let below {
            // The chevron points where the words say the card is: a card placed by its own moment
            // can be up the conversation from a reader at the live tail, which is the ordinary case
            // here. Unknown (nothing has reported the reader's place) keeps the old down — the
            // press scrolls to the row either way.
            bar(text: below.text, detail: nil, since: nil, more: 0, glyph: below.glyph,
                chevron: below.side == .above ? "chevron.up" : "chevron.down",
                // "what is waiting", not "the question": the bar counts the exceptions too (an
                // escalation that became the owner's, a pause only they can lift), and a reader
                // told to look for a question finds a card reading "Escalated to you" — the same
                // wrong noun the line above stopped using.
                hint: "Shows what is waiting in this conversation") {
                onOpenBelow?(below.rowID)
            }
        } else if let banner = model.needsYouBanner(excluding: excluding) {
            // No chevron: the whole capsule is the press, as the nav bar's question capsule is — and
            // where it goes is somewhere else, which the words already say.
            bar(text: banner.text, detail: banner.detail, since: banner.since, more: banner.more,
                glyph: banner.glyph, chevron: nil,
                // One of the four owner items opens the CARD it names, inside the project's
                // coordinator conversation; everything else opens the session, as it always did.
                hint: banner.ownerItem == nil
                    ? "Opens the session waiting on you"
                    : "Opens the card waiting on you") {
                if let item = banner.ownerItem {
                    model.openNeedsYouItem(banner.target, item, projectInColumn: projectInColumn)
                } else {
                    model.openNeedsYouSession(banner.target)
                }
            }
        }
    }

    /// One capsule, whichever fact it is carrying: the two differ in their words, their mark and
    /// which way a chevron points, and in nothing else — it is one signal, and a second style for it
    /// would read as a second kind of thing.
    private func bar(text: String, detail: String?, since: String?, more: Int, glyph: NeedsYouGlyph,
                     chevron: String?, hint: String, action: @escaping () -> Void) -> some View {
        Button {
            // A press here moves the reader somewhere. The tap feedback is the same one the cards
            // give, so "I pressed it" is answered before the scroll starts.
            PlatformHaptics.tap()
            action()
        } label: {
            HStack(spacing: 10) {
                // The Landing head's circle (`ProjectLandingRow.mark`): the one place the amber is.
                // Never on the words — amber text on an amber wash was the legibility trap of the
                // band this replaced.
                Image(systemName: glyph.symbol)
                    .font(.orbitGlyph)
                    .foregroundStyle(.orange)
                    .frame(width: 30, height: 30)
                    .background(Color.orange.opacity(0.15), in: Circle())
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(text)
                            .font(.orbitSubtext.weight(.semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        if more > 0 {
                            Text("+\(more)")
                                .font(.orbitMeta.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 6)
                                .background(Color.primary.opacity(0.1), in: Capsule())
                        }
                        if let since { NeedsYouAge(since: since) }
                    }
                    if let detail {
                        Text(detail)
                            .font(.orbitLabel)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                if let chevron {
                    Image(systemName: chevron)
                        .font(.orbitLabel.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
            // Concentric: the circle stands in 7pt from the capsule's round end.
            .padding(.leading, 7)
            .padding(.trailing, 16)
            .padding(.vertical, 5)
            .frame(minHeight: 44)
            .needsYouCapsule()
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel([text, detail, more > 0 ? "+\(more)" : nil].compactMap { $0 }.joined(separator: ", "))
        .accessibilityHint(hint)
        // Android's `needs-you-bar` tag: a session row can carry the same words.
        .accessibilityIdentifier("needs-you-bar")
        // In from the edges by the margin the nav bar sets its own buttons in — UIKit's 20pt on a
        // Plus- or Max-width phone, 16pt below that — so the capsule's ends line up under the back
        // button and ⋯ (measured on the owner's 440pt phone: 20–64 and 376–420).
        .padding(.horizontal, width >= 414 ? 20 : 16)
        .padding(.bottom, 6)
        .frame(maxWidth: .infinity)
        .background {
            GeometryReader { proxy in
                Color.clear
                    .onAppear { width = proxy.size.width }
                    .onChange(of: proxy.size.width) { _, now in width = now }
            }
        }
        .background(floats ? Color.clear : Color(uiColor: .systemBackground))
    }
}

/// How long the thing the bar names has waited — "12m", "2h" — kept current while it sits there.
/// The words of a duration that is still running (`RelativeTime.elapsed`), not of an event.
private struct NeedsYouAge: View {
    let since: String

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            if let age = RelativeTime.elapsed(since, now: context.date) {
                Text(age)
                    .font(.orbitLabel.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private extension NeedsYouGlyph {
    /// The SF Symbol for each mark, filled where the symbol has a fill, as the Landing head's are.
    var symbol: String {
        switch self {
        case .merge: return "arrow.triangle.merge"
        case .question: return "questionmark.bubble.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .pause: return "pause.fill"
        case .hand: return "hand.raised.fill"
        }
    }
}

private extension View {
    /// The capsule's surface: on iOS 26 the glass the nav bar's controls and the question capsule
    /// above the transcript are (`questionGlass`); before it, a raised fill with a hairline, on the
    /// page colour the bar stands on there.
    @ViewBuilder func needsYouCapsule() -> some View {
        if #available(iOS 26.0, *) {
            glassEffect(.regular.interactive(), in: .capsule)
        } else {
            background(Color(uiColor: .secondarySystemBackground), in: Capsule())
                .overlay(Capsule().strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5))
        }
    }
}
#endif
