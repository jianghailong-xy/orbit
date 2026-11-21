#if os(macOS)
import Foundation

/// PROBE BRANCH ONLY (`probe/project-row-shell-macos-shots`).
///
/// The screenshot harness in `OrbitAppTests/ProjectRowShellShotsTests.swift` hosts the real lists in
/// a window, but their `SessionDragState` is a private `@State`: there is no way in from outside.
/// This registry publishes each list's state when it appears, so the harness can reproduce exactly
/// what the drop delegate does — `begin`, set `hover` — instead of synthesizing a mouse drag (which
/// this Mac's missing Accessibility/Screen-Recording grants make impossible). It also records the
/// first folder row's frame, so the drag-preview composite knows where to put the pointer over it.
/// Nothing in the app reads this; it holds weak references only.
@MainActor
enum DragShotsProbe {
    private final class Box {
        weak var drag: SessionDragState?
        init(_ drag: SessionDragState) { self.drag = drag }
    }
    private static var boxes: [Box] = []

    static func register(_ drag: SessionDragState) {
        if boxes.contains(where: { $0.drag === drag }) { return }
        boxes.append(Box(drag))
    }

    static func reset() { boxes.removeAll() }

    /// The first folder row's frame in the window's coordinate space (top-left origin), for the
    /// composite's pointer arrow.
    static var folderRowFrame: CGRect?

    /// The pointer state the harness's `NSEvent` swizzle reports, so a driven drag's timer does not
    /// end it on its first tick (the mouse button is really up).
    static var fakeMouseLocation: NSPoint = NSPoint(x: -2000, y: -2000)
    static var fakeButtonDown = false

    /// The list that appeared last — the one the harness just put on screen.
    static var latest: SessionDragState? {
        boxes.last(where: { $0.drag != nil })?.drag
    }
}
#endif
