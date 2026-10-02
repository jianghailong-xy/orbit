import SwiftUI
#if os(iOS)
import Observation
import UIKit
import OrbitKit
#endif

/// One action a session row offers on a swipe, described once so the system's `.swipeActions`
/// buttons, the iOS 26 circles and the context menu's items are all drawn from the same list.
struct RowSwipeAction: Identifiable {
    let title: String
    let systemImage: String
    let tint: Color
    var role: ButtonRole?
    var isEnabled = true
    let perform: () -> Void

    var id: String { title }
}

#if os(iOS)
/// The list's half of the circle swipe: which row is open — opening another closes it, and while
/// one is open a tap on any row only closes it, as the system's swipe does — and where it and the
/// list are, so the row above it can drop its separator and a row can tell how far its cell reaches
/// past it. Handed to the rows by `rowSwipeList`.
@Observable final class RowSwipeState {
    var openID: AnyHashable?
    /// The open row, unslid, in the window.
    var openFrame: CGRect = .zero
    var listFrame: CGRect = .zero
}

extension View {
    /// Make this list the home of its rows' circle swipe actions (see `RowSwipeState`).
    func rowSwipeList(_ state: RowSwipeState) -> some View {
        environment(state)
            .background {
                GeometryReader { proxy in
                    Color.clear.onChange(of: proxy.frame(in: .global), initial: true) { _, frame in
                        state.listFrame = frame
                    }
                }
            }
    }

    /// The row's swipe actions as circles (see `CircleSwipeRow`). Each side lists its actions from
    /// the screen edge inward, as `.swipeActions` does: the first is outermost, and on the leading
    /// side it is the one a full swipe performs.
    @available(iOS 26.0, *)
    func circleSwipeActions(id: AnyHashable, leading: [RowSwipeAction], trailing: [RowSwipeAction],
                            leadingFullSwipe: Bool) -> some View {
        modifier(CircleSwipeRow(id: id, leading: leading, trailing: trailing,
                                leadingFullSwipe: leadingFullSwipe))
    }
}

/// iOS 26 draws a row's `.swipeActions` buttons itself, 60pt wide and as tall as the row leaves
/// under their titles, so a ~75pt session row gets 60×47 squashed capsules, and no API reshapes
/// them. This draws the same slots with a round button in each — measured off the owner's
/// screenshots of the system's: 60pt slots 10pt apart and 10pt from the screen edge, the row slid
/// 10pt clear of the last one as a rounded card filling its cell, and under each a 47pt circle of
/// the action's colour over its 13pt title. As the row slides, each button grows in from a dot in
/// its own slot, the outermost first, and shrinks away the same way as the row shuts — the system's
/// own swipe, as Notes shows it, recorded frame by frame. Where the row goes under the finger, where
/// it settles and how far each button has grown is `RowSwipeGeometry`.
@available(iOS 26.0, *)
private struct CircleSwipeRow: ViewModifier {
    let id: AnyHashable
    let leading: [RowSwipeAction]
    let trailing: [RowSwipeAction]
    let leadingFullSwipe: Bool

    @Environment(RowSwipeState.self) private var shared: RowSwipeState?
    /// How far the row is slid: positive shows the leading buttons, negative the trailing.
    @State private var offset: CGFloat = 0
    /// `offset` when the finger came down; nil while no finger is on the row.
    @State private var dragStart: CGFloat?
    /// The row, unslid, in the window.
    @State private var frame: CGRect = .zero
    /// Each button's slot width (wider than `slot` for a long title), by action.
    @State private var slotWidths: [String: CGFloat] = [:]
    /// The side whose buttons are drawn: the one the row is slid toward, kept until it has shut so
    /// the buttons can shrink away with it.
    @State private var shownSide: HorizontalEdge?

    /// The list's top and bottom row inset, which the row now carries itself so its card can fill
    /// the cell; the row stands as tall as it did (75.3pt for a session row, measured on an iOS 26.5
    /// simulator against the system's own inset).
    private static let rowInset: CGFloat = 15
    private static let diameter: CGFloat = 47
    private static let slot = CGFloat(RowSwipeGeometry.slot)
    private static let gap = CGFloat(RowSwipeGeometry.gap)
    private static let cardRadius: CGFloat = 24
    /// The list's separator, as iOS 26 draws it under a plain row: 1pt, across the row's content.
    private static let separator: CGFloat = 1

    private func slots(of actions: [RowSwipeAction]) -> [Double] {
        actions.map { Double(slotWidths[$0.id] ?? Self.slot) }
    }

    private var geometry: RowSwipeGeometry {
        RowSwipeGeometry(leadingWidth: RowSwipeGeometry.openWidth(slots: slots(of: leading)),
                         trailingWidth: RowSwipeGeometry.openWidth(slots: slots(of: trailing)),
                         rowWidth: frame.width + bleed.leading + bleed.trailing,
                         leadingFullSwipe: leadingFullSwipe && leading.first?.isEnabled == true)
    }

    /// Held past the full-swipe point: letting go now runs the first leading action.
    private var armed: Bool { dragStart != nil && geometry.isFullSwipe(offset) }

    /// This row is the list's open one (or, outside a `rowSwipeList`, is slid at all).
    private var isOpen: Bool { shared.map { $0.openID == id } ?? (offset != 0) }

    /// The list's open row sits right under this one, so this row's separator runs along its top.
    private var isAboveOpen: Bool {
        guard let shared, shared.openID != nil, shared.openID != id else { return false }
        return abs(shared.openFrame.minY - frame.maxY) < 1
    }

    /// How far the cell reaches past the row on each side — the list's own side insets (16 or 20pt
    /// by device, and the safe area in landscape), which the card and the buttons cover too.
    private var bleed: (leading: CGFloat, trailing: CGFloat) {
        guard let list = shared?.listFrame, list.width > 0, frame.width > 0 else { return (16, 16) }
        return (max(0, frame.minX - list.minX), max(0, list.maxX - frame.maxX))
    }

    func body(content: Content) -> some View {
        content
            .accessibilityActions {
                ForEach(leading + trailing) { action in
                    if action.isEnabled { Button(action.title, role: action.role, action: action.perform) }
                }
            }
            .padding(.vertical, Self.rowInset)
            .background { if offset != 0 { card } }
            .overlay { if offset != 0 || shared?.openID != nil { closer } }
            .offset(x: offset)
            .overlay(alignment: .bottom) {
                if !isOpen && !isAboveOpen {
                    Rectangle().fill(Color(uiColor: .separator)).frame(height: Self.separator)
                }
            }
            .background { buttons }
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { now in
                // The list moved under an open row — it scrolled — so the row shuts, as the system's does.
                if now.minY != frame.minY, offset != 0, dragStart == nil { settle(.closed) }
                frame = now
            }
            .listRowInsets(.vertical, 0)
            // The row draws its separator itself (the overlay above): the system's swiped row hides
            // the separators either side of it, and the list's own, turned off as a row opened, was
            // taken up only some of the time and not always given back when it shut (iOS 26.5
            // simulator).
            .listRowSeparator(.hidden)
            .gesture(SidewaysPan(began: began, moved: moved, ended: ended))
            .onChange(of: shared?.openID) { _, open in
                if open != id, offset != 0, dragStart == nil { settle(.closed) }
            }
            .onDisappear {
                offset = 0
                dragStart = nil
                shownSide = nil
                if shared?.openID == id { shared?.openID = nil }
            }
            .sensoryFeedback(.impact(weight: .medium), trigger: armed) { _, now in now }
    }

    /// The slid row: the whole cell, rounded, behind the row's own content.
    private var card: some View {
        RoundedRectangle(cornerRadius: Self.cardRadius, style: .continuous)
            .fill(Color(uiColor: .systemGray5))
            .padding(.leading, -bleed.leading)
            .padding(.trailing, -bleed.trailing)
    }

    /// While any row is open, a tap on a row only closes it, so the tap that puts the buttons away
    /// never opens a session.
    private var closer: some View {
        Color.clear
            .contentShape(Rectangle())
            .onTapGesture {
                if offset != 0 { settle(.closed) } else { shared?.openID = nil }
            }
    }

    /// Both sides' buttons, pinned to the cell's edges under the row; a side shows only while the
    /// row is slid its way.
    private var buttons: some View {
        HStack(spacing: 0) {
            side(leading, edge: .leading)
            Spacer(minLength: 0)
            side(trailing, edge: .trailing)
        }
        .padding(.leading, -bleed.leading)
        .padding(.trailing, -bleed.trailing)
    }

    /// One side's buttons, left to right, with the gap at either end that `RowSwipeGeometry.openWidth`
    /// counts. Its slots are laid out, hidden, even while the row is shut, so each slot's width is
    /// known before the first swipe; the buttons themselves exist only while the side is shown, so a
    /// shut row offers no stray buttons to VoiceOver or to a tap. `actions` run from the screen edge
    /// inward, so the trailing side lays them out reversed.
    private func side(_ actions: [RowSwipeAction], edge: HorizontalEdge) -> some View {
        let laidOut: [RowSwipeAction] = edge == .leading ? actions : actions.reversed()
        let widths = slots(of: actions)
        return slotRow(laidOut) { action in
            circleFace(action)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { slotWidths[action.id] = $0 }
        }
        .hidden()
        .accessibilityHidden(true)
        .overlay {
            if shownSide == edge {
                slotRow(laidOut) { action in
                    let index = actions.firstIndex { $0.id == action.id } ?? 0
                    circle(action, reveal: RowSwipeGeometry.reveal(of: index, slots: widths,
                                                                   revealed: Double(abs(offset))))
                }
                .allowsHitTesting(dragStart == nil)
            }
        }
    }

    private func slotRow<Slot: View>(_ actions: [RowSwipeAction],
                                     @ViewBuilder _ slot: @escaping (RowSwipeAction) -> Slot) -> some View {
        HStack(spacing: Self.gap) {
            ForEach(actions) { slot($0) }
        }
        .padding(.horizontal, Self.gap)
        .fixedSize()
    }

    /// A button, grown in as far as `reveal` says: the circle and its title scale together about the
    /// middle of the pair, and fade in a little ahead of their size.
    private func circle(_ action: RowSwipeAction, reveal: Double) -> some View {
        // Held past the full-swipe point, the button that will run grows a little and its
        // neighbours step aside.
        let fullSwipeTarget = armed && action.id == leading.first?.id
        return Button {
            settle(.closed)
            action.perform()
        } label: {
            circleFace(action, grown: fullSwipeTarget)
        }
        .buttonStyle(CirclePress())
        .disabled(!action.isEnabled)
        .accessibilityLabel(action.title)
        .scaleEffect(max(reveal, 0.01))   // never a singular transform
        .opacity(armed && !fullSwipeTarget ? 0 : RowSwipeGeometry.revealOpacity(reveal))
        .animation(.snappy(duration: 0.2), value: armed)
    }

    /// A button's face: the circle of its colour with its symbol, over its title.
    private func circleFace(_ action: RowSwipeAction, grown: Bool = false) -> some View {
        VStack(spacing: 4) {
            Image(systemName: action.systemImage)
                .symbolVariant(.fill)
                .font(.orbitSwipeGlyph)
                .foregroundStyle(.white)
                .frame(width: Self.diameter, height: Self.diameter)
                .background(action.tint, in: Circle())
                .scaleEffect(grown ? 1.12 : 1)
                // The button speaks its title; the symbol's own label would add to it ("Selected"
                // for the checkmark circle).
                .accessibilityHidden(true)
            Text(action.title)
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(minWidth: Self.slot)
    }

    private func began() {
        dragStart = offset
        claimOpen()   // shuts whichever row was open
    }

    private func claimOpen() {
        shared?.openFrame = frame
        if shared?.openID != id { shared?.openID = id }
    }

    private func moved(_ dx: CGFloat) {
        guard let dragStart else { return }
        offset = geometry.dragged(dragStart + dx)
        if offset != 0 { shownSide = offset > 0 ? .leading : .trailing }
    }

    private func ended(_ dx: CGFloat, _ velocity: CGFloat) {
        guard let start = dragStart else { return }
        let lifted = geometry.dragged(start + dx)
        dragStart = nil
        settle(geometry.rest(offset: lifted, velocity: velocity))
    }

    private func settle(_ rest: RowSwipeGeometry.Rest) {
        let target = geometry.offset(at: rest)
        switch rest {
        case .leading, .trailing:
            claimOpen()
            shownSide = rest == .leading ? .leading : .trailing
            withAnimation(.snappy) { offset = target }
        case .closed:
            if shared?.openID == id { shared?.openID = nil }
            withAnimation(.snappy) { offset = 0 } completion: {
                if offset == 0 { shownSide = nil }
            }
        case .fullSwipe:
            if shared?.openID == id { shared?.openID = nil }
            let action = leading[0]
            withAnimation(.snappy(duration: 0.25)) { offset = target } completion: {
                action.perform()
                // A completed or reopened row leaves the list; one that stays (the request failed)
                // comes back once the list has had its chance to drop it.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    withAnimation(.snappy) { offset = 0 } completion: {
                        if offset == 0 { shownSide = nil }
                    }
                }
            }
        }
    }
}

/// A circle that dims and shrinks a touch under the finger, and fades when its action is off.
private struct CirclePress: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.4)
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .animation(.snappy(duration: 0.15), value: configuration.isPressed)
    }
}

/// A sideways drag on a row, as a UIKit pan so it can decline to start on anything that moves more
/// up or down than across: the list keeps every vertical scroll, and a swipe that does start takes
/// the touch from the row's tap and the list's scroll, the way the system's swipe does.
@available(iOS 18.0, *)
private struct SidewaysPan: UIGestureRecognizerRepresentable {
    let began: () -> Void
    let moved: (CGFloat) -> Void
    let ended: (_ translation: CGFloat, _ velocity: CGFloat) -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let pan = UIPanGestureRecognizer()
        pan.delegate = context.coordinator
        return pan
    }

    func handleUIGestureRecognizerAction(_ pan: UIPanGestureRecognizer, context: Context) {
        let dx = pan.translation(in: nil).x
        switch pan.state {
        case .began:
            began()
            moved(dx)
        case .changed:
            moved(dx)
        case .ended, .cancelled:
            ended(dx, pan.velocity(in: nil).x)
        default:
            break
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            guard let pan = recognizer as? UIPanGestureRecognizer else { return false }
            let velocity = pan.velocity(in: nil)
            return abs(velocity.x) > abs(velocity.y)
        }
    }
}
#endif
