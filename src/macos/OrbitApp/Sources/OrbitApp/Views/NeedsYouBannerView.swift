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
/// (`floatsOverTranscript`), and a top inset over the Sessions list. With nothing waiting the body is
/// empty, which insets by zero — the bar is absent from the layout rather than present at zero height.
///
/// FLOATING, NOT A STRIP (the owner, 2026-11-15, `docs/mocks/needs-you-capsule/04-floating`)
/// ------------------------------------------------------------------------------------------
/// The inset only keeps the list's first row and the pull's spinner clear while the list rests. The
/// capsule stands on nothing and casts a shadow, so the rows scroll on behind it as they do behind
/// the nav bar's glass buttons; several waiting show as a deck under it. Unfolded, the capsules after
/// the first hang over the page on a scrim instead of pushing it down, so the inset never changes
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
    /// Mounted over a list or a page rather than a conversation: it floats there on every system,
    /// with the rows going on behind it (see `surface`).
    var overList = false
    /// The bar's own width, for the margin that lines it up with the nav bar's buttons.
    @State private var width: CGFloat = 0
    @Environment(\.colorScheme) private var scheme
    /// Unfolded to one capsule per waiting conversation. Folds again after a press goes somewhere,
    /// so the page it is left on is as it was.
    @State private var unfolded = false
    /// The clock the terminal line is filtered against, so it leaves at its request's deadline.
    @State private var terminalNow = Date()

    var body: some View {
        Group {
            if let below {
            // The chevron points where the words say the card is: a card placed by its own moment
            // can be up the conversation from a reader at the live tail, which is the ordinary case
            // here. Unknown (nothing has reported the reader's place) keeps the old down — the
            // press scrolls to the row either way.
            chrome {
                bar(text: below.text, detail: nil, since: nil, more: 0, glyph: below.glyph,
                    chevron: below.side == .above ? "chevron.up" : "chevron.down",
                    // "what is waiting", not "the question": the bar counts the exceptions too (an
                    // escalation that became the owner's, a pause only they can lift), and a reader
                    // told to look for a question finds a card reading "Escalated to you" — the same
                    // wrong noun the line above stopped using.
                    hint: "Shows what is waiting in this conversation") {
                    onOpenBelow?(below.rowID)
                }
            }
        } else if let terminal = model.terminalNeedsYou(now: terminalNow) {
            // Terminals asking to be approved lead (docs/mocks/waiting-on-you-removal/02 ③): a
            // request lives ten minutes, and the oldest one's card a press goes to. Everything else
            // waiting is what its "+N" counts and what unfolding shows under it.
            terminalBar(terminal)
        } else if let banner = model.needsYouBanner(excluding: excluding) {
            // Several waiting, unfolded (the owner, 2026-11-13, option B of
            // docs/mocks/needs-you-capsule/03-expand.html): one capsule per conversation, the first
            // the one the folded bar names and where the folded bar stood, carrying the ↑ that folds
            // them back. The rest hang over the page on a scrim (04-floating) rather than pushing it.
            // An arrival never unfolds: its press goes to the newcomer.
            let several = banner.count > 1 && !banner.arriving
            let entries = unfolded && several ? model.needsYouEntries(excluding: excluding) : []
            if entries.count > 1 {
                // At most five; the last says "+N" for the ones behind it, as the folded bar does.
                let shown = Array(entries.prefix(NeedsYouLogic.unfoldedLimit))
                chrome(deck: true) {
                    bar(entries[0], more: 0, fold: { setUnfolded(false) })
                        .overlay(alignment: .top) {
                            VStack(spacing: 6) {
                                ForEach(Array(shown.enumerated().dropFirst()), id: \.element.target.id) { index, entry in
                                    bar(entry, more: index == shown.count - 1 ? entries.count - shown.count : 0)
                                }
                            }
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 44 + 6)
                        }
                } scrim: {
                    scrim
                }
            } else {
                // No chevron: the whole capsule is the press, as the nav bar's question capsule is —
                // and where it goes is somewhere else, which the words already say. With more than
                // one waiting the press unfolds them instead, and the deck under it says so.
                chrome(deck: banner.count > 1) {
                    bar(text: banner.text, detail: banner.detail, since: banner.since, more: banner.more,
                        glyph: banner.glyph, chevron: nil,
                        hint: several ? "Shows all \(banner.count) waiting on you" : hint(for: banner),
                        deck: banner.count > 1, arriving: banner.arriving) {
                        if several { setUnfolded(true) } else { open(banner) }
                    }
                }
            }
        }
        }
        .modifier(TerminalRequestsCurrent(now: $terminalNow))
    }

    /// The folded bar for terminals asking to be approved, with the sessions waiting behind them
    /// unfolded one capsule each: the terminal line first, as the folded bar names it, and its "+N"
    /// is every other thing waiting.
    @ViewBuilder
    private func terminalBar(_ terminal: TerminalNeedsYou) -> some View {
        let sessions = model.needsYouBanner(excluding: excluding)
        let lines = [CapsuleLine(terminal: terminal)]
            + model.needsYouEntries(excluding: excluding).map(CapsuleLine.init(session:))
        // A request lives ten minutes; with more than one thing waiting the press unfolds them.
        let several = lines.count > 1
        if unfolded && several {
            // At most five; the last says "+N" for the ones behind it, as the folded bar does.
            let shown = Array(lines.prefix(NeedsYouLogic.unfoldedLimit))
            chrome(deck: true) {
                lineBar(shown[0], more: 0, fold: { setUnfolded(false) })
                    .overlay(alignment: .top) {
                        VStack(spacing: 6) {
                            ForEach(Array(shown.enumerated().dropFirst()), id: \.element.id) { index, entry in
                                lineBar(entry, more: index == shown.count - 1 ? lines.count - shown.count : 0)
                            }
                        }
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 44 + 6)
                    }
            } scrim: {
                scrim
            }
        } else {
            chrome(deck: several) {
                bar(text: terminal.text, detail: terminal.detail, since: terminal.since,
                    more: sessions?.count ?? 0, glyph: .terminal, chevron: nil,
                    hint: several ? "Shows all \(lines.count) waiting on you" : Terminals.needsYouHint,
                    deck: several) {
                    if several { setUnfolded(true) } else { model.openTerminalNeedsYou(terminal) }
                }
            }
        }
    }

    /// One line of the unfolded terminal stack: the terminal's, or a waiting session's.
    private func lineBar(_ line: CapsuleLine, more: Int, fold: (() -> Void)? = nil) -> some View {
        bar(text: line.text, detail: line.detail, since: line.since, more: more, glyph: line.glyph,
            chevron: nil, hint: line.hint, fold: fold) {
            unfolded = false
            if let terminal = line.terminal {
                model.openTerminalNeedsYou(terminal)
            } else if let session = line.session {
                open(session)
            }
        }
    }

    /// One line of the unfolded terminal stack, either shape.
    private struct CapsuleLine: Identifiable {
        let id: String
        let text: String
        let detail: String?
        let since: String?
        let glyph: NeedsYouGlyph
        let terminal: TerminalNeedsYou?
        let session: NeedsYouBanner?

        init(terminal: TerminalNeedsYou) {
            id = "terminal:\(terminal.oldest.id)"
            text = terminal.text
            detail = terminal.detail
            since = terminal.since
            glyph = .terminal
            self.terminal = terminal
            session = nil
        }

        init(session: NeedsYouBanner) {
            id = session.target.id
            text = session.text
            detail = session.detail
            since = session.since
            glyph = session.glyph
            terminal = nil
            self.session = session
        }

        var hint: String {
            if terminal != nil { return Terminals.needsYouHint }
            return session?.ownerItem == nil ? "Opens the session waiting on you"
                                             : "Opens the card waiting on you"
        }
    }

    /// One conversation's capsule in the unfolded stack: it opens its own.
    private func bar(_ entry: NeedsYouBanner, more: Int, fold: (() -> Void)? = nil) -> some View {
        bar(text: entry.text, detail: entry.detail, since: entry.since, more: more,
            glyph: entry.glyph, chevron: nil, hint: hint(for: entry), fold: fold) {
            open(entry)
        }
    }

    /// Behind the unfolded stack and over everything else on the page: dimmed, and a press anywhere
    /// on it folds the stack rather than reaching the row under it.
    private var scrim: some View {
        Color.black.opacity(scheme == .dark ? 0.55 : 0.18)
            .frame(width: 4000, height: 4000)
            .contentShape(Rectangle())
            .onTapGesture { setUnfolded(false) }
            .accessibilityElement()
            .accessibilityLabel("Collapse")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { setUnfolded(false) }
    }

    private func setUnfolded(_ value: Bool) {
        withAnimation(.easeInOut(duration: 0.25)) { unfolded = value }
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
                     chevron: String?, hint: String, deck: Bool = false, arriving: Bool = false,
                     fold: (() -> Void)? = nil, action: @escaping () -> Void) -> some View {
        HStack(spacing: 0) {
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
                .padding(.trailing, fold == nil ? 16 : 0)
                .padding(.vertical, 5)
                .frame(minHeight: 44)
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
            if arriving {
                Capsule().strokeBorder(Color.orange.opacity(0.75), lineWidth: 1.5)
                    .shadow(color: .orange.opacity(0.35), radius: 6)
                    .allowsHitTesting(false)
            }
        }
        .animation(.easeInOut(duration: 0.3), value: arriving)
        // Lifted off the page: the rows scroll on behind it.
        .shadow(color: .black.opacity(scheme == .dark ? 0.75 : 0.10), radius: 14, y: 10)
        .background(alignment: .top) { if deck { deckEdges } }
    }

    /// Several waiting: two edges of the capsules behind this one, showing under it as a stack of
    /// notifications does — 7 and 13pt below, standing in 12 and 26pt from its ends.
    private var deckEdges: some View {
        ZStack(alignment: .top) {
            Capsule().fill(Color(uiColor: .secondarySystemBackground).opacity(0.7))
                .overlay(Capsule().strokeBorder(Color.primary.opacity(0.1), lineWidth: 0.5))
                .padding(.horizontal, 26)
                .offset(y: Self.deckReach)
            Capsule().fill(Color(uiColor: .secondarySystemBackground))
                .overlay(Capsule().strokeBorder(Color.primary.opacity(0.12), lineWidth: 0.5))
                .padding(.horizontal, 12)
                .offset(y: 7)
        }
        .frame(height: 44)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// How far the deck shows below the capsule; the bar keeps this much room under it while
    /// several are waiting, folded or not, so unfolding never moves the page.
    private static let deckReach: CGFloat = 13

    /// Where the bar stands: in from the edges by the margin the nav bar sets its own buttons in —
    /// UIKit's 20pt on a Plus- or Max-width phone, 16pt below that — so a capsule's ends line up
    /// under the back button and ⋯ (measured on the owner's 440pt phone: 20–64 and 376–420).
    private func chrome<Content: View>(deck: Bool = false, @ViewBuilder _ content: () -> Content) -> some View {
        chrome(deck: deck, content) { EmptyView() }
    }

    private func chrome<Content: View, Scrim: View>(deck: Bool, @ViewBuilder _ content: () -> Content,
                                                    @ViewBuilder scrim: () -> Scrim) -> some View {
        content()
            .padding(.horizontal, width >= 414 ? 20 : 16)
            .padding(.bottom, deck ? Self.deckReach : 0)
            .padding(.bottom, 6)
            // Under the capsules and over the page: the unfolded stack's scrim.
            .background { scrim() }
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

    /// Nothing under it where it floats — over the transcript, over the Sessions list (04-floating:
    /// the rows go on behind it, under the nav bar's own soft edge) and over a page. Only a
    /// conversation before iOS 26, where it is the inset it always was, stands on the page's colour.
    @ViewBuilder private var surface: some View {
        if floats || overList {
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
        case .terminal: return "terminal"
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
