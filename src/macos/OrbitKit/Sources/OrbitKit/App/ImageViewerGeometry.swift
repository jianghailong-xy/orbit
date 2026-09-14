import Foundation

/// Geometry for the iOS full-screen image viewer, kept out of the view because only this package
/// builds and tests on Linux.
///
/// At zoom 1 an image is aspect-fit — except a long one, a screenshot of a whole page, which fills the
/// width instead: fitted whole it would be a sliver down the middle of the screen. What overflows is
/// scrolled through, starting at the top.
///
/// Offsets are the image centre's displacement from the viewport centre in points, as SwiftUI's
/// `.offset` takes them. The viewer draws the current page at `restOffsetY` plus a pan, so a pan of zero
/// is where the page rests: centred, or top edge at the top for a long image.
public struct ImageViewerGeometry: Equatable, Sendable {
    public let imageWidth: Double
    public let imageHeight: Double
    public let viewportWidth: Double
    public let viewportHeight: Double

    public init(imageWidth: Double, imageHeight: Double, viewportWidth: Double, viewportHeight: Double) {
        self.imageWidth = imageWidth
        self.imageHeight = imageHeight
        self.viewportWidth = viewportWidth
        self.viewportHeight = viewportHeight
    }

    /// Longer, for its width, than the screen is — measured against the screen's long side over its
    /// short side rather than the viewport as it stands, because turned to landscape an ordinary photo
    /// is taller than the viewport's shape too, and should still just fit.
    public var fillsWidth: Bool {
        guard imageWidth > 0, imageHeight > 0, viewportWidth > 0, viewportHeight > 0 else { return false }
        return imageHeight * min(viewportWidth, viewportHeight) > max(viewportWidth, viewportHeight) * imageWidth
    }

    /// The image's size at zoom 1. Zero until both sizes are known — bytes not decoded yet, or a
    /// viewport not laid out.
    public var restWidth: Double { imageWidth * restScale }
    public var restHeight: Double { imageHeight * restScale }

    /// How far a long image scrolls: its rest height past the viewport. Zero when it fits — including
    /// overflow under a point, which is an image cut to the screen's own shape, off by rounding.
    public var travel: Double {
        let overflow = restHeight - viewportHeight
        return overflow >= 1 ? overflow : 0
    }

    /// The offset that puts the image's top edge at the top of the viewport; zero (centred) when it fits.
    public var restOffsetY: Double { travel / 2 }

    /// A scroll pan held to the image: 0 shows its top, `-travel` its bottom.
    public func clampedScroll(_ y: Double) -> Double {
        min(0, max(-travel, y))
    }

    /// A scroll pan under the finger, giving a little past either end instead of stopping dead — the
    /// way a scroll view bounces.
    public func rubberBanded(_ y: Double) -> Double {
        if y > 0 { return y * Self.resistance }
        if y < -travel { return -travel + (y + travel) * Self.resistance }
        return y
    }

    /// The pan once zoom goes from `scale` to `newScale`, keeping the point at the centre of the
    /// viewport where it is. Back at zoom 1 there is nothing to pan sideways, and a long image stays
    /// inside its scroll range.
    public func pan(x: Double, y: Double, rescaledFrom scale: Double, to newScale: Double) -> (x: Double, y: Double) {
        guard scale > 0 else { return (0, 0) }
        let k = newScale / scale
        let rescaledY = (restOffsetY + y) * k - restOffsetY
        return newScale > 1 ? (x * k, rescaledY) : (0, clampedScroll(rescaledY))
    }

    private var restScale: Double {
        guard imageWidth > 0, imageHeight > 0, viewportWidth > 0, viewportHeight > 0 else { return 0 }
        let widthScale = viewportWidth / imageWidth
        return fillsWidth ? widthScale : min(widthScale, viewportHeight / imageHeight)
    }

    /// How much of a drag past an end still moves the image; the viewer's paging edge uses the same.
    private static let resistance = 0.35
}
