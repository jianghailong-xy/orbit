import Foundation

/// Where a swiped session row goes under the finger and when it is let go, kept out of the view
/// because only this package builds and tests on Linux.
///
/// iOS 26 draws a row's `.swipeActions` buttons itself, 60pt wide and as tall as the row leaves
/// under their titles, so a ~75pt session row gets 60×47 squashed capsules (measured on the owner's
/// iPhone). The app draws the same slots with a round button in each instead (`CircleSwipeRow`),
/// and this is the behaviour that drawing has to reproduce.
///
/// Offsets are the row's horizontal displacement in points, as SwiftUI's `.offset` takes them:
/// positive slides the row right to show the leading actions, negative left to show the trailing
/// ones. A side's width is how far the row slides to show all of its buttons, margins included
/// (`openWidth`); zero when that side has none.
public struct RowSwipeGeometry: Equatable, Sendable {
    public let leadingWidth: Double
    public let trailingWidth: Double
    /// The cell's width, which a full swipe is measured against.
    public let rowWidth: Double
    /// Whether a long swipe right performs the first leading action, as `allowsFullSwipe` did.
    public let leadingFullSwipe: Bool

    public init(leadingWidth: Double, trailingWidth: Double, rowWidth: Double, leadingFullSwipe: Bool) {
        self.leadingWidth = leadingWidth
        self.trailingWidth = trailingWidth
        self.rowWidth = rowWidth
        self.leadingFullSwipe = leadingFullSwipe
    }

    /// Where a let-go row comes to rest.
    public enum Rest: Equatable, Sendable {
        case closed
        case leading
        case trailing
        /// Slid all the way across: the first leading action runs.
        case fullSwipe
    }

    /// The system's slot: each button sits in one this wide (wider only for a title that needs it),
    /// `gap` from the screen edge, from its neighbour and from the slid row.
    public static let slot = 60.0
    public static let gap = 10.0

    /// How far a row slides to show buttons in slots this wide: the gap at the screen edge, between
    /// slots and before the row. Two 60pt slots make 150, three make 220.
    public static func openWidth(slots: [Double]) -> Double {
        guard !slots.isEmpty else { return 0 }
        return slots.reduce(0, +) + gap * Double(slots.count + 1)
    }

    /// How far a side's button has grown in, 0 to 1, with the row slid `revealed` points: button
    /// `index`, counted from the screen edge inward, grows from a dot over the last `growth` points
    /// before its slot is clear of the row — so the outermost comes first and each next one follows,
    /// and the same distance shrinks them away as the row shuts. Measured off the system's own swipe
    /// (iOS 26.5 simulator): a lone Delete is first seen 55pt out at a fifth of its size and is
    /// whole at 80, where its slot clears; the second leading button is not yet out at 103.
    public static func reveal(of index: Int, slots: [Double], revealed: Double) -> Double {
        guard index >= 0, index < slots.count else { return 0 }
        let clear = openWidth(slots: Array(slots.prefix(index + 1)))
        return min(1, max(0, (revealed - (clear - growth)) / growth))
    }

    /// How a grown-in fraction shows: the button is drawn at that scale, and fades in a little ahead
    /// of it, as the system's does (about a third opaque at a fifth of its size).
    public static func revealOpacity(_ reveal: Double) -> Double {
        reveal <= 0 ? 0 : min(1, 0.15 + 0.85 * reveal)
    }

    /// The distance over which a button grows in.
    public static let growth = 30.0

    /// The offset for a finger that has moved the row to `raw`: one-to-one up to either side's
    /// width, and past it only grudgingly, the way a scroll view gives past its end — except toward
    /// a full swipe, which follows the finger. A side with no buttons gives only that little.
    public func dragged(_ raw: Double) -> Double {
        if raw > leadingWidth {
            if leadingFullSwipe && leadingWidth > 0 { return raw }
            return leadingWidth + (raw - leadingWidth) * Self.resistance
        }
        if raw < -trailingWidth {
            return -trailingWidth + (raw + trailingWidth) * Self.resistance
        }
        return raw
    }

    /// Past this, letting go performs the first leading action: over halfway across the row, and
    /// never before a slot's width beyond the open buttons.
    public var fullSwipePoint: Double {
        max(leadingWidth + Self.slot, rowWidth * 0.6)
    }

    public func isFullSwipe(_ offset: Double) -> Bool {
        leadingFullSwipe && leadingWidth > 0 && offset >= fullSwipePoint
    }

    /// Where the row settles when the finger lifts at `offset`, moving at `velocity` points per
    /// second: open if it was more than half way out or flicked outward, shut if it was flicked
    /// back or barely moved.
    public func rest(offset: Double, velocity: Double) -> Rest {
        if isFullSwipe(offset) { return .fullSwipe }
        if offset > 0, leadingWidth > 0 {
            if velocity > Self.flick { return .leading }
            if velocity < -Self.flick { return .closed }
            return offset > leadingWidth / 2 ? .leading : .closed
        }
        if offset < 0, trailingWidth > 0 {
            if velocity < -Self.flick { return .trailing }
            if velocity > Self.flick { return .closed }
            return -offset > trailingWidth / 2 ? .trailing : .closed
        }
        return .closed
    }

    /// The offset a rest is drawn at; a full swipe carries the row off the screen.
    public func offset(at rest: Rest) -> Double {
        switch rest {
        case .closed: return 0
        case .leading: return leadingWidth
        case .trailing: return -trailingWidth
        case .fullSwipe: return rowWidth
        }
    }

    /// How much of a drag past a side's width still moves the row.
    private static let resistance = 0.3
    /// A lift faster than this decides the rest by its direction alone.
    private static let flick = 400.0
}
