import AppKit

/// The menu-bar item's glyph: an agent head (rounded square, two eyes cut out) whose antenna ends in
/// a four-point sparkle. Design: docs/mocks/macos-menubar-icon/03-board.html, candidate 10.
///
/// Drawn in code rather than loaded from an asset: the macOS app ships no compiled asset catalog
/// (see `VectorMark`). The drawing handler re-runs at each backing scale, so it stays sharp on 1x and
/// Retina screens, and `isTemplate` lets the menu bar tint it for light and dark bars.
enum MenuBarIcon {
    static let image: NSImage = {
        // 17 pt matches the neighbouring menu-bar marks (Claude 16 pt, ChatGPT 17 pt of ink).
        let side: CGFloat = 17
        let image = NSImage(size: NSSize(width: side, height: side), flipped: true) { _ in
            // Artwork is laid out in a 64-unit box, y down, as on the board.
            let s = side / 64
            func r(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> NSRect {
                NSRect(x: x * s, y: y * s, width: w * s, height: h * s)
            }
            NSColor.black.setFill()

            // Head with the eyes knocked out (even-odd: the inner rounded rects become holes).
            let head = NSBezierPath(roundedRect: r(5, 20, 54, 43), xRadius: 15 * s, yRadius: 15 * s)
            head.append(NSBezierPath(roundedRect: r(17.5, 31, 10, 17), xRadius: 5 * s, yRadius: 5 * s))
            head.append(NSBezierPath(roundedRect: r(36.5, 31, 10, 17), xRadius: 5 * s, yRadius: 5 * s))
            head.windingRule = .evenOdd
            head.fill()

            // Antenna stem.
            NSBezierPath(rect: r(29.8, 13, 4.4, 8)).fill()

            // Sparkle at the tip: four quadratic curves bowing toward the centre, as cubics.
            let cx: CGFloat = 32, cy: CGFloat = 9.5, R: CGFloat = 9.5, k: CGFloat = 1.6
            func p(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: x * s, y: y * s) }
            let tips = [p(cx, cy - R), p(cx + R, cy), p(cx, cy + R), p(cx - R, cy)]
            let controls = [p(cx + k, cy - k), p(cx + k, cy + k), p(cx - k, cy + k), p(cx - k, cy - k)]
            let spark = NSBezierPath()
            spark.move(to: tips[0])
            for i in 0..<4 {
                let a = tips[i], q = controls[i], b = tips[(i + 1) % 4]
                spark.curve(to: b,
                            controlPoint1: NSPoint(x: a.x + 2 / 3 * (q.x - a.x), y: a.y + 2 / 3 * (q.y - a.y)),
                            controlPoint2: NSPoint(x: b.x + 2 / 3 * (q.x - b.x), y: b.y + 2 / 3 * (q.y - b.y)))
            }
            spark.close()
            spark.fill()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Orbit"
        return image
    }()
}
