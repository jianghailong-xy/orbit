import XCTest

/// EVIDENCE ONLY — the one thing a probe app cannot do for itself: a real finger. The app's
/// `swipe` script waits for a drag to arrive and carries on after it; this test is what delivers
/// the drag, so the trace has a gesture in it rather than only programmatic scrolls (a programmatic
/// `setContentOffset` reports no scroll phase at all — the first run of this probe proved that, and
/// left the question of what a finger reports open).
final class ProbeUITests: XCTestCase {
    func testTheReaderScrollsBackWhileTheReplyStreams() throws {
        let app = XCUIApplication()
        app.launchEnvironment["PROBE_VARIANT"] = "swipe"
        app.launch()

        // The app waits for the gesture at its end, not the other way round, so this only has to be
        // inside the app's window (its streaming phase runs for several seconds). Slow enough that
        // the drag covers real distance: a flick would be one momentum burst and nothing else.
        Thread.sleep(forTimeInterval: 5)
        // A finger travelling DOWN the screen: the content follows it down and the reader goes back
        // to earlier rows — a falling offset, which is the only direction the tail rule can un-pin on.
        app.swipeDown(velocity: .slow)
        // Long enough for the app to see the drag, let the coast die, re-pin the way the disc does,
        // fold the reasoning row, and write its trace — and longer still if it never sees a gesture.
        Thread.sleep(forTimeInterval: 20)
    }
}
