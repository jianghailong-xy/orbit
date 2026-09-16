import XCTest
@testable import OrbitKit

/// The net that is missing today. The navigation containers — `NavigationSplitView`,
/// `NavigationStack`, `List(selection:)` — have no test in this suite, and all three CI gates stop
/// at "it compiles", so nothing catches a navigation regression. These checks are writable at all
/// only because the facts they assert now live in a value: today they live half in SwiftUI's private
/// stack and half in flat optionals that can disagree with it.
final class NavigationTests: XCTestCase {

    /// THE BUG, as a test. Today: back out to the list and `selectedAgentSessionID` stays set, so the
    /// row keeps its highlight, tapping it writes the id the binding already holds, SwiftUI reads
    /// that as no change — and the row can't be opened until the selection moves elsewhere.
    /// Here the highlight is read off the stack, so "highlighted while the list is showing" has no
    /// representation.
    func testBackingOutToTheListCannotLeaveARowHighlighted() {
        var nav = NavState(section: .agents)
        nav.push(.console(sessionID: "s1", origin: .list))
        XCTAssertEqual(nav.highlightedSessionID, "s1")
        XCTAssertFalse(nav.sectionAtRoot)

        nav.pop()

        XCTAssertNil(nav.highlightedSessionID, "no row is current once the list is back")
        XCTAssertTrue(nav.sectionAtRoot, "and the left edge goes back to the drawer gesture")
        XCTAssertNil(nav.focusedConsoleSessionID, "and nothing is left streaming")
        XCTAssertEqual(nav, NavState(section: .agents), "an emptied stack leaves nothing behind")
    }

    /// Re-opening the same session after backing out — the dead tap today, since the value the
    /// binding receives equals the one it holds.
    func testReopeningTheSameSessionAfterBackingOutEntersItAgain() {
        var nav = NavState(section: .agents)
        nav.push(.console(sessionID: "s1", origin: .list))
        nav.pop()
        nav.push(.console(sessionID: "s1", origin: .list))

        XCTAssertEqual(nav.path, [.console(sessionID: "s1", origin: .list)])
        XCTAssertEqual(nav.highlightedSessionID, "s1")
        XCTAssertEqual(nav.focusedConsoleSessionID, "s1")
        XCTAssertFalse(nav.sectionAtRoot)
    }

    /// Leaving a section and coming back. Today the compact shell destroys the stack while the flat
    /// selection survives it, and `selectedSection`'s `didSet` has to drop each section's pushes by
    /// hand — a list maintained in a comment that the type system never checks.
    func testEachSectionKeepsItsOwnStackAcrossASwitch() {
        var nav = NavState(section: .agents)
        nav.push(.console(sessionID: "s1", origin: .list))

        nav.section = .tasks
        XCTAssertTrue(nav.sectionAtRoot, "Tasks shows its own root, not whatever Agents had pushed")
        XCTAssertNil(nav.focusedConsoleSessionID, "and the Agents console stops streaming")
        XCTAssertNil(nav.highlightedSessionID)

        nav.push(.taskDetail(taskID: "t1"))
        nav.section = .agents
        XCTAssertEqual(nav.path, [.console(sessionID: "s1", origin: .list)],
                       "Agents comes back exactly as you left it")
        XCTAssertEqual(nav.highlightedSessionID, "s1")

        nav.section = .tasks
        XCTAssertEqual(nav.path, [.taskDetail(taskID: "t1")], "and so does Tasks")
    }

    /// Where a console came from rides the frame that needs it, replacing the shadow variable and
    /// its "set this *before* the selection" convention.
    func testAConsoleCarriesHowItWasOpened() {
        var nav = NavState(section: .agents)
        nav.push(.console(sessionID: "s1", origin: .drawer))
        XCTAssertTrue(nav.consoleFromRecents, "a drawer-opened console yields the edge to the drawer")

        nav.pop()
        XCTAssertFalse(nav.consoleFromRecents, "the list page has no console to yield anything")

        nav.push(.console(sessionID: "s1", origin: .list))
        XCTAssertFalse(nav.consoleFromRecents,
                       "the same session opened from the list keeps the system back-swipe")
    }

    /// A three-column shell means "replace what the detail pane shows", not "go deeper" — which is
    /// what lets one state drive both shell shapes without either knowing which one it is.
    func testSelectingInAThreeColumnShellReplacesTheTopInsteadOfDeepening() {
        var nav = NavState(section: .agents)
        nav.replaceTop(with: .console(sessionID: "s1", origin: .list))
        XCTAssertEqual(nav.path.count, 1, "selecting with nothing shown fills the detail pane")

        nav.replaceTop(with: .console(sessionID: "s2", origin: .list))
        XCTAssertEqual(nav.path.count, 1, "selecting again swaps it rather than stacking on it")
        XCTAssertEqual(nav.highlightedSessionID, "s2")
        XCTAssertEqual(nav.focusedConsoleSessionID, "s2")
    }

    /// The draft's page becomes the console's page. Both shells render the frame on the stack, so the
    /// composer a session was created from is *replaced* — one frame, no pop and no push — which is
    /// what the compact shell's local `@State` copy of the created session used to do by hand while a
    /// second mechanism pushed the split's detail over it.
    func testADraftIsReplacedInPlaceByTheConsoleItCreated() {
        var nav = NavState(section: .agents)
        nav.push(.compose(agentID: "a1"))
        XCTAssertNil(nav.focusedConsoleSessionID, "a draft streams nothing")
        XCTAssertFalse(nav.sectionAtRoot)

        nav.replaceTop(with: .console(sessionID: "s1", origin: .list))

        XCTAssertEqual(nav.path.count, 1, "the page you were on is the page you stay on")
        XCTAssertEqual(nav.focusedConsoleSessionID, "s1", "and it streams now")
        XCTAssertEqual(nav.highlightedSessionID, "s1")
        XCTAssertFalse(nav.consoleFromRecents, "a console you created is not one you came back to")
    }

    /// A session that is completed / trashed / purged takes its console off the stack — wherever on
    /// the stack it is. This is the one edit that replaced three hand-cleared fields (the selection,
    /// the Recents marker, and the compose page's in-place console), each of which named the same
    /// session in a different place.
    func testASessionThatGoesAwayTakesItsConsoleOffTheStack() {
        var nav = NavState(section: .agents)
        nav.push(.console(sessionID: "s1", origin: .list))
        nav.push(.console(sessionID: "s2", origin: .list))

        nav.removeConsole("s1")

        XCTAssertEqual(nav.path, [.console(sessionID: "s2", origin: .list)],
                       "a buried console goes without disturbing what is on top")

        nav.removeConsole("s2")
        XCTAssertTrue(nav.sectionAtRoot, "and the list is back")
        XCTAssertNil(nav.highlightedSessionID)
        XCTAssertNil(nav.focusedConsoleSessionID)
        XCTAssertEqual(nav, NavState(section: .agents), "nothing left behind")
    }

    /// The stack is a *binding*: a `NavigationStack(path:)` writes back into it — the back button,
    /// the edge swipe, a row's own link. What it writes back for a popped root is an empty array, so
    /// that has to normalize to "no stack" like every other transition, or two states showing the
    /// same screens stop comparing equal (and the key sits there empty forever).
    func testWhatTheShellWritesBackIntoAnEmptiedPathLeavesNothingBehind() {
        var nav = NavState(section: .agents)
        nav.path = [.console(sessionID: "s1", origin: .list)]
        XCTAssertEqual(nav.stacks[.agents], [.console(sessionID: "s1", origin: .list)])

        nav.path = []

        XCTAssertNil(nav.stacks[.agents], "an emptied stack drops its key")
        XCTAssertEqual(nav, NavState(section: .agents))
        XCTAssertTrue(nav.sectionAtRoot)
    }

    /// The needs-you banner excludes "the console you can already see" and the SSE focus streams it.
    /// Both read this, so on a list page — where no console is on screen — it has to be nil, or the
    /// banner silently drops a session that is waiting for you and its stream outlives its console.
    func testNothingIsFocusedWhileAListIsShowing() {
        var nav = NavState(section: .agents)
        XCTAssertNil(nav.focusedConsoleSessionID, "the list page focuses no console")

        nav.push(.console(sessionID: "s1", origin: .list))
        XCTAssertEqual(nav.focusedConsoleSessionID, "s1", "excluded from the banner while you see it")

        nav.popToRoot()
        XCTAssertNil(nav.focusedConsoleSessionID, "listed again the moment you back out")

        nav.push(.compose(agentID: "a1"))
        XCTAssertNil(nav.focusedConsoleSessionID, "a draft composer is not a console either")
    }
}
