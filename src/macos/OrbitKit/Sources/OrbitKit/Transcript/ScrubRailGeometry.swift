import Foundation

/// Geometry for the large-output viewer's scrub rail — the handle on the right edge that makes a
/// 15k-line tool result reachable without flicking through it.
///
/// Two conversions, kept out of the view because only this package builds and tests on Linux:
///
///   • offset ↔ progress — where the viewport sits in the scroll range, as 0…1.
///   • progress ↔ handle — where the handle draws, and what a finger on the rail means. The handle
///     has height, so its top edge travels `trackHeight - thumbHeight` rather than the whole track,
///     and a drag puts the handle's *centre* under the finger.
public struct ScrubRailGeometry: Equatable, Sendable {
    public let trackHeight: Double
    public let thumbHeight: Double

    public init(trackHeight: Double, thumbHeight: Double) {
        self.trackHeight = trackHeight
        self.thumbHeight = thumbHeight
    }

    /// How far the handle's top edge can move. Zero once the handle fills the track.
    public var travel: Double { max(0, trackHeight - thumbHeight) }

    /// Top edge of the handle for a 0…1 position.
    public func thumbTop(forProgress progress: Double) -> Double {
        travel * Self.clamped(progress)
    }

    /// The position a finger `y` points down the track means, measured to the handle's centre so
    /// the handle stays under the finger instead of jumping by half its height.
    public func progress(forThumbCenter y: Double) -> Double {
        guard travel > 0 else { return 0 }
        return Self.clamped((y - thumbHeight / 2) / travel)
    }

    /// Where a scroll view sits in its own range, as 0…1. Content that has nowhere to scroll — it
    /// fits the viewport, or its height has not been measured yet — reads as the top.
    public static func progress(offset: Double, minOffset: Double, maxOffset: Double) -> Double {
        let range = maxOffset - minOffset
        guard range > 0 else { return 0 }
        return clamped((offset - minOffset) / range)
    }

    /// The vertical content offset a 0…1 position asks for.
    public static func offset(forProgress progress: Double,
                              minOffset: Double,
                              maxOffset: Double) -> Double {
        guard maxOffset > minOffset else { return minOffset }
        return minOffset + (maxOffset - minOffset) * clamped(progress)
    }

    /// Clamps to 0…1, and treats a non-finite input as the top: a rail laid out at zero size hands
    /// back a NaN division, and a NaN content offset would scroll the text view nowhere at all.
    private static func clamped(_ value: Double) -> Double {
        value.isFinite ? min(1, max(0, value)) : 0
    }
}
