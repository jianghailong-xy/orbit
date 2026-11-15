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
/// NOT IN A CONVERSATION (the owner, 2026-11-15, `docs/mocks/needs-you-capsule/07-console-one-capsule`)
/// -------------------------------------------------------------------------------------------
/// A conversation shows only what waits in it, and says that in the capsule in its nav bar
/// (`TranscriptView.waitingCapsule`, from `ConsoleModel.waitingBelow`), where the bar used to point
/// down into the transcript. What waits elsewhere is this bar's, on the lists and pages around them.
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
/// Mounted at the top of the Sessions list and, from the shell, over pages with none of their own.
/// With nothing waiting the body is empty — the bar is absent rather than present at zero height.
///
/// FLOATING, NOT A STRIP (the owner, 2026-11-15, `docs/mocks/needs-you-capsule/04-floating`)
/// ------------------------------------------------------------------------------------------
/// The inset only keeps the list's first row and the pull's spinner clear while the list rests. The
/// capsule stands on nothing but its own glass, so the rows scroll on behind it as they do behind
/// the nav bar's glass buttons; several waiting show as a deck under it. Unfolded, the capsules after
/// the first hang over the page instead of pushing it down, so the inset never changes
/// height and nothing under a finger moves.
///
/// AND IT IS WHERE AN APPROVAL ARRIVES (`docs/mocks/needs-you-capsule/05-one-surface`)
/// --------------------------------------------------------------------------------
/// An approval landing while the app is open used to be an amber card of its own beside this bar.
/// Now the bar says it (`NeedsYouBanner.arriving`): the push's line and an amber ring for six seconds,
/// a press going straight to it, then the count again. Pages with no bar of their own carry this
/// same view over the page (`needsYouOverPage`).
struct NeedsYouBannerView: View {
    @Environment(AppModel.self) private var model
    /// The session on screen, left out of the cross-session count — its own approval card already
    /// renders inline at the tail of its transcript, so a bar pointing at it would point at itself.
    /// nil from a list, which shows no one session.
    var excluding: String?
    /// Whether a project's sessions page opens in this shell's session column (an iPad's wide
    /// shell) rather than as a page of its own — where the merge into main's card is.
    var projectInColumn = false
    /// Mounted over a list or a page rather than a conversation: it floats there on every system,
    /// with the rows going on behind it (see `surface`).
    var overList = false
    /// The bar's own width, for the margin that lines it up with the nav bar's buttons.
    @State private var width: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Unfolded to one capsule per waiting conversation. Folds again after a press goes somewhere,
    /// so the page it is left on is as it was.
    @State private var unfolded = false
    /// The first card's height, which the unfolded stack hangs below.
    @State private var firstHeight: CGFloat = NeedsYouBannerView.cardHeight

    var body: some View {
        let banner = model.needsYouBanner(excluding: excluding)
        content(banner)
            // ④ It drops in from behind the nav bar and lifts away again (the owner, 2026-11-15,
            // docs/mocks/needs-you-capsule/08-motion), rather than appearing on the spot.
            .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(duration: 0.3, bounce: 0),
                       value: banner != nil)
    }

    @ViewBuilder private func content(_ banner: NeedsYouBanner?) -> some View {
        if let banner {
            // Several waiting, unfolded (the owner, 2026-11-13, option B of
            // docs/mocks/needs-you-capsule/03-expand.html): one card per conversation, the first
            // the one the folded bar names and where the folded bar stood, carrying the ↑ that folds
            // them back. The rest hang over the page (04-floating) — on no scrim since 11-15 (10-glass:
            // the page under them stays usable) — sliding out from
            // under the first (08-motion ①) and back under it to fold (②).
            // An arrival never unfolds: its press goes to the newcomer.
            let several = banner.count > 1 && !banner.arriving
            let entries = several ? model.needsYouEntries(excluding: excluding) : []
            let stacked = unfolded && entries.count > 1
            // At most five; the last says "+N" for the ones behind it, as the folded bar does.
            let shown = Array(entries.prefix(NeedsYouLogic.unfoldedLimit))
            chrome(deck: banner.count > 1) {
                Group {
                    if stacked {
                        bar(entries[0], more: 0, fold: { setUnfolded(false) })
                    } else {
                        // No chevron: the whole card is the press, as the nav bar's question
                        // capsule is — and where it goes is somewhere else, which the words already
                        // say. With more than one waiting the press unfolds them instead, and the
                        // deck under it says so.
                        bar(text: banner.text, detail: banner.detail, since: banner.since, more: banner.more,
                            glyph: banner.glyph,
                            hint: several ? "Shows all \(banner.count) waiting on you" : hint(for: banner),
                            deck: banner.count > 1, arriving: banner.arriving) {
                            if several { setUnfolded(true) } else { open(banner) }
                        }
                        .swipesAway { model.dismissNeedsYou() }
                    }
                }
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { firstHeight = $0 }
                // Behind the first card, so the rest come out from under it; hung a card and a gap
                // below its top. (An alignment guide on this background was ignored on the phone:
                // the stack sat behind the first card, unseen — the 11-15 probe's frames.)
                .background(alignment: .top) {
                    if stacked {
                        VStack(spacing: Self.stackGap) {
                            ForEach(Array(shown.enumerated().dropFirst()), id: \.element.target.id) { index, entry in
                                bar(entry, more: index == shown.count - 1 ? entries.count - shown.count : 0)
                                    .transition(fromUnder(index))
                            }
                        }
                        .fixedSize(horizontal: false, vertical: true)
                        .offset(y: firstHeight + Self.stackGap)
                    }
                }
            }
            .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
        }
    }

    /// Each card after the first comes out from under the one above it — from under the first,
    /// a card's height and a gap per place — a touch smaller and clear, one after another (08-motion
    /// ①); folding takes the same way back. With reduced motion, a fade.
    private func fromUnder(_ index: Int) -> AnyTransition {
        guard !reduceMotion else { return .opacity }
        return AnyTransition.offset(y: -CGFloat(index) * (Self.cardHeight + Self.stackGap))
            .combined(with: .scale(scale: 0.96, anchor: .top))
            .combined(with: .opacity)
            .animation(.spring(duration: 0.32, bounce: 0.15).delay(Double(index - 1) * 0.04))
    }

    /// The card's height, as iOS's own notifications are (09-height): two 15pt lines in 13pt of air.
    static let cardHeight: CGFloat = 70
    /// Between the unfolded cards.
    private static let stackGap: CGFloat = 8
    /// The card's corners, as a notification's.
    static let cardCorner: CGFloat = 24

    /// One conversation's capsule in the unfolded stack: it opens its own.
    private func bar(_ entry: NeedsYouBanner, more: Int, fold: (() -> Void)? = nil) -> some View {
        bar(text: entry.text, detail: entry.detail, since: entry.since, more: more,
            glyph: entry.glyph, hint: hint(for: entry), fold: fold) {
            open(entry)
        }
    }

    private func setUnfolded(_ value: Bool) {
        withAnimation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(duration: 0.32, bounce: 0.15)) {
            unfolded = value
        }
    }

    private func hint(for entry: NeedsYouBanner) -> String {
        entry.ownerItem == nil ? "Opens the session waiting on you" : "Opens the card waiting on you"
    }

    /// One of the five owner items opens the CARD it names, inside the project's coordinator
    /// conversation; everything else opens the session, as it always did.
    private func open(_ entry: NeedsYouBanner) {
        unfolded = false
        if let item = entry.ownerItem {
            model.openNeedsYouItem(entry.target, item, projectInColumn: projectInColumn)
        } else {
            model.openNeedsYouSession(entry.target)
        }
    }

    /// One capsule, whichever fact it is carrying: the two differ in their words, their mark and
    /// which way a chevron points, and in nothing else — it is one signal, and a second style for it
    /// would read as a second kind of thing. `deck` draws the two edges under it that say a press
    /// shows them all; `arriving` rings it amber while it says an approval that has just come;
    /// `fold` is the ↑ on the first capsule of the unfolded stack, a press of its own.
    private func bar(text: String, detail: String?, since: String?, more: Int, glyph: NeedsYouGlyph,
                     hint: String, deck: Bool = false, arriving: Bool = false,
                     fold: (() -> Void)? = nil, action: @escaping () -> Void) -> some View {
        HStack(spacing: 0) {
            Button {
                // A press here moves the reader somewhere. The tap feedback is the same one the cards
                // give, so "I pressed it" is answered before the scroll starts.
                PlatformHaptics.tap()
                action()
            } label: {
                HStack(spacing: 12) {
                    // The Landing head's circle (`ProjectLandingRow.mark`): the one place the amber is.
                    // Never on the words — amber text on an amber wash was the legibility trap of the
                    // band this replaced. 38pt, as a notification's icon (09-height).
                    Image(systemName: glyph.symbol)
                        .font(.orbitControl)
                        .foregroundStyle(.orange)
                        .frame(width: 38, height: 38)
                        .background(Color.orange.opacity(0.15), in: Circle())
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 1) {
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
                                .font(.orbitSubtext)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
                // A notification's proportions (the owner, 2026-11-15, 09-height): 14pt in, 13pt
                // above and below two 15pt lines — about 70pt, as iOS's own.
                .padding(.leading, 14)
                .padding(.trailing, fold == nil ? 16 : 0)
                .padding(.vertical, 13)
                .frame(minHeight: Self.cardHeight)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel([text, detail, more > 0 ? "+\(more)" : nil].compactMap { $0 }.joined(separator: ", "))
            .accessibilityHint(hint)
            // Android's `needs-you-bar` tag: a session row can carry the same words.
            .accessibilityIdentifier("needs-you-bar")
            if let fold {
                Button {
                    PlatformHaptics.tap()
                    fold()
                } label: {
                    Image(systemName: "chevron.up")
                        .font(.orbitLabel.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.trailing, 4)
                .accessibilityLabel("Collapse")
            }
        }
        .needsYouCapsule()
        .overlay {
            // An approval that has just arrived: the amber it came in with, round the glass
            // rather than over it, for the seconds the bar says it.
            // It breathes once as it comes in (08-motion ④), then holds; always drawn, so the
            // change of `arriving` is what the breath runs on.
            Self.card.strokeBorder(Color.orange.opacity(0.75), lineWidth: 1.5)
                .shadow(color: .orange.opacity(0.35), radius: 6)
                .phaseAnimator(reduceMotion ? [1.0] : [1.0, 0.35, 1.0], trigger: arriving) { ring, glow in
                    ring.opacity(arriving ? glow : 0)
                } animation: { _ in .easeInOut(duration: 0.3) }
                .allowsHitTesting(false)
        }
        .animation(.easeInOut(duration: 0.3), value: arriving)
        .background(alignment: .top) { if deck { deckEdges } }
    }

    /// The card's shape: a notification's continuous corners.
    static let card = RoundedRectangle(cornerRadius: cardCorner, style: .continuous)

    /// Several waiting: two edges of the cards behind this one, showing under it as a stack of
    /// notifications does — 7 and 13pt below, standing in 12 and 26pt from its ends.
    private var deckEdges: some View {
        ZStack(alignment: .top) {
            Self.card.fill(.thinMaterial).opacity(0.7)
                .overlay(Self.card.strokeBorder(Color.primary.opacity(0.1), lineWidth: 0.5))
                .padding(.horizontal, 26)
                .offset(y: Self.deckReach)
            Self.card.fill(.regularMaterial)
                .overlay(Self.card.strokeBorder(Color.primary.opacity(0.12), lineWidth: 0.5))
                .padding(.horizontal, 12)
                .offset(y: 7)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// How far the deck shows below the capsule; the bar keeps this much room under it while
    /// several are waiting, folded or not, so unfolding never moves the page.
    private static let deckReach: CGFloat = 13

    /// Where the bar stands: in from the edges by the margin the nav bar sets its own buttons in —
    /// UIKit's 20pt on a Plus- or Max-width phone, 16pt below that — so a capsule's ends line up
    /// under the back button and ⋯ (measured on the owner's 440pt phone: 20–64 and 376–420).
    private func chrome<Content: View>(deck: Bool, @ViewBuilder _ content: () -> Content) -> some View {
        content()
            .padding(.horizontal, width >= 414 ? 20 : 16)
            .padding(.bottom, deck ? Self.deckReach : 0)
            .padding(.bottom, 6)
            .frame(maxWidth: .infinity)
            .background {
                GeometryReader { proxy in
                    Color.clear
                        .onAppear { width = proxy.size.width }
                        .onChange(of: proxy.size.width) { _, now in width = now }
                }
            }
            .background { surface }
    }

    /// Nothing under it where it floats — over the Sessions list (04-floating: the rows go on behind
    /// it, under the nav bar's own soft edge) and over a page.
    @ViewBuilder private var surface: some View {
        if overList {
            Color.clear
        } else {
            Color(uiColor: .systemBackground)
        }
    }
}

extension View {
    /// The needs-you bar over a page that has none of its own — Tasks, Projects, the Wiki, a page
    /// pushed over a list — floating under the nav bar and covering the page rather than moving it,
    /// where the amber approval card used to come down (the owner, 2026-11-15,
    /// `docs/mocks/needs-you-capsule/05-one-surface`). Attach once at a shell's root; `wide` is the
    /// iPad's three columns, where it stands at a capsule's width.
    func needsYouOverPage(wide: Bool) -> some View { modifier(NeedsYouOverPage(wide: wide)) }
}

private struct NeedsYouOverPage: ViewModifier {
    @Environment(AppModel.self) private var model
    let wide: Bool

    func body(content: Content) -> some View {
        let shows = model.pageHasNoNeedsYouBar(wide: wide) && model.needsYouBanner(excluding: nil) != nil
        content
            .overlay(alignment: .top) {
                if shows {
                    // Under an inline nav bar: 44pt of bar and the 10pt the lists leave above it.
                    NeedsYouBannerView(excluding: nil, overList: true)
                        .frame(maxWidth: wide ? 440 : .infinity)
                        .padding(.top, 54)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.snappy, value: shows)
            // The tap the amber card came in with, wherever the bar that says it is.
            .sensoryFeedback(.warning, trigger: model.needsYouArrival) { _, new in new != nil }
    }
}

/// Pushed up, the bar goes away (the owner, 2026-11-15, `docs/mocks/needs-you-capsule/06-list-floats`):
/// it follows the finger up and fades, and past half its height — or flicked — it is put away until
/// something new is waiting (`AppModel.dismissNeedsYou`); short of that it springs back. A tap is
/// still the press, and a sideways or downward drag does nothing.
private struct SwipeAway: ViewModifier {
    let dismiss: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var lift: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .offset(y: lift)
            // Going, it shrinks a little as it rises (08-motion ③).
            .scaleEffect(1 - min(0.08, -lift / 1000), anchor: .top)
            .opacity(1 - min(0.8, Double(-lift) / 60))
            .gesture(
                DragGesture(minimumDistance: 10)
                    .onChanged { value in
                        guard abs(value.translation.height) > abs(value.translation.width) else { return }
                        lift = min(0, value.translation.height)
                    }
                    .onEnded { value in
                        let away = value.translation.height < -22 || value.predictedEndTranslation.height < -60
                        if away {
                            PlatformHaptics.tap()
                            // On up and away, and only then is it put away — the list closes the
                            // room it kept once the card has gone (the first row's own animation).
                            // Not set back: the card leaves with it.
                            withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .spring(duration: 0.3, bounce: 0)) {
                                lift = -80
                            } completion: { dismiss() }
                        } else {
                            withAnimation(.spring(duration: 0.3)) { lift = 0 }
                        }
                    }
            )
            .accessibilityAction(named: "Dismiss") { dismiss() }
    }
}

private extension View {
    func swipesAway(_ dismiss: @escaping () -> Void) -> some View { modifier(SwipeAway(dismiss: dismiss)) }
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

extension NeedsYouGlyph {
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
    /// The card's surface, the commit toast's own (`ToastHost.toastGlass`; the owner, 2026-11-15):
    /// on iOS 26 Liquid Glass and nothing around it — a shadow laid outside the glass drew it as a flat
    /// slab (beta.8) — and before it the regular material with a hairline edge and a soft shadow.
    @ViewBuilder func needsYouCapsule() -> some View {
        if #available(iOS 26.0, *) {
            glassEffect(.regular, in: NeedsYouBannerView.card)
        } else {
            background {
                NeedsYouBannerView.card.fill(.regularMaterial)
                    .overlay(NeedsYouBannerView.card.strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.7))
                    .shadow(color: .black.opacity(0.16), radius: 12, y: 4)
            }
        }
    }
}
#endif
