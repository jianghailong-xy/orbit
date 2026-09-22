import XCTest

/// EVIDENCE ONLY — the one thing a probe app cannot do for itself: a real finger. The app's
/// `swipe` script waits for a drag to arrive and carries on after it; this test is what delivers
/// the drag, so the trace has a gesture in it rather than only programmatic scrolls (a programmatic
/// `setContentOffset` reports no scroll phase at all — the first run of this probe proved that, and
/// left the question of what a finger reports open).
///
/// The first attempt's timing was wrong in a way worth keeping: XCUITest waits for the app to go
/// idle before synthesizing, and this app never does (its script is streaming), so the swipe landed
/// 13 seconds in rather than the 5 its own sleep asked for. The app now opens a window and waits
/// for the gesture instead of meeting it on a schedule, which is why both sides can be vague here.
final class ProbeUITests: XCTestCase {
    func testTheReaderScrollsBackWhileTheReplyStreams() throws {
        let app = XCUIApplication()
        app.launchEnvironment["PROBE_VARIANT"] = "swipe"
        app.launch()

        Thread.sleep(forTimeInterval: 4)
        // A finger travelling DOWN the screen: the content follows it down and the reader goes back
        // to earlier rows — a falling offset, which is the only direction the tail rule can un-pin on.
        app.swipeDown(velocity: .slow)
        // A second one in case the first landed before the app had started streaming, or was eaten by
        // the launch. Harmless if the app has already moved on: its report is written by then.
        Thread.sleep(forTimeInterval: 6)
        app.swipeDown(velocity: .slow)

        // Long enough for the app to see a drag, let the coast die, re-pin the way the disc does,
        // fold the reasoning row with the answer's first row, and write its trace.
        Thread.sleep(forTimeInterval: 25)
    }
}
