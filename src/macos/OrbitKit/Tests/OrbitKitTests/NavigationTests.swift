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

    /// A console's "Tasks created here" card on a phone opens its task, its project and its View all
    /// over the console, on the Agents stack — so the back swipe is a pop that lands on the
    /// conversation, and the Tasks and Projects stacks are left exactly as they were. The task page
    /// on top is what the detail store follows while it is up (`taskDetailOnTop`), and the console
    /// under it is not the one streaming until it is on top again.
    func testACardsPagesOpenOverTheConsoleAndBackOutToIt() {
        var nav = NavState(section: .tasks, stacks: [.tasks: [.taskDetail(taskID: "t-elsewhere")]])
        nav.section = .agents
        nav.push(.console(sessionID: "s1", origin: .list))

        for page in [NavNode.taskDetail(taskID: "t1"), .projectDetail(projectID: "p1"),
                     .createdTasks(sessionID: "s1"), .watches, .watchDetail(watchID: "w1"),
                     .console(sessionID: "s2", origin: .conversation)] {
            nav.push(page)
            XCTAssertEqual(nav.path, [.console(sessionID: "s1", origin: .list), page])
            XCTAssertNotEqual(nav.focusedConsoleSessionID, "s1", "the console is under the page, not on screen")
            XCTAssertFalse(nav.atDestinationRoot, "the left edge on the page is a plain back")

            nav.pop()

            XCTAssertEqual(nav.focusedConsoleSessionID, "s1", "the swipe back lands on the conversation")
            XCTAssertEqual(nav.section, .agents, "in the section it was opened from")
        }

        nav.push(.taskDetail(taskID: "t1"))
        XCTAssertEqual(nav.taskDetailOnTop, "t1", "the task page on screen is the one the store follows")
        nav.pop()
        XCTAssertNil(nav.taskDetailOnTop)

        nav.section = .tasks
        XCTAssertEqual(nav.taskDetailOnTop, "t-elsewhere", "the Tasks stack was never touched")
        XCTAssertNil(nav.stacks[.projects], "nor was the Projects stack")
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

    /// The drawer row a screen belongs to. The Agents stack is the workspace's until a project's
    /// sessions page is on it — then it is the project's, with whatever was pushed over that page —
    /// and every other section's stack is the section's own, at any depth.
    func testTheDrawerDestinationIsReadOffTheStack() {
        let address = SessionProjectAddress(projectID: "p1", agentID: "a1", view: .open)
        let folder = SessionFolderAddress(folderID: "f1", agentID: "a1", view: .open)
        var nav = NavState(section: .agents)
        XCTAssertEqual(nav.drawerDestination(agentID: "a1"), .workspace(agentID: "a1"))
        XCTAssertEqual(nav.drawerDestination(agentID: nil), .section(.agents), "no workspace picked yet")

        nav.enterFolder(folder)
        nav.push(.console(sessionID: "s1", origin: .list))
        XCTAssertEqual(nav.drawerDestination(agentID: "a1"), .workspace(agentID: "a1"),
                       "a folder and its consoles are the workspace's")

        nav.popToRoot()
        nav.enterProjectSessions(address)
        XCTAssertEqual(nav.drawerDestination(agentID: "a1"), .project(projectID: "p1"))
        XCTAssertNotEqual(nav.drawerDestination(agentID: "a1"), .workspace(agentID: "a1"),
                          "the workspace row is not the selected one on a project's page")
        nav.push(.console(sessionID: "s1", origin: .list))
        nav.push(.projectDetail(projectID: "p1"))
        XCTAssertEqual(nav.drawerDestination(agentID: "a1"), .project(projectID: "p1"),
                       "a member's console and the project's page pushed over it stay the project's")

        nav.section = .projects
        nav.path = [.projectDetail(projectID: "p1")]
        XCTAssertEqual(nav.drawerDestination(agentID: "a1"), .section(.projects),
                       "a project opened from the Projects list is the Projects row's")
    }

    /// A project's two id spellings are one destination, so its drawer row matches the page whichever
    /// spelling put the page up.
    func testAProjectDestinationIgnoresTheIdsSpelling() {
        let uuid = "8f6c2a52-41a6-4c1e-9d55-2f4f3c9b8a10"
        let publicID = PublicID.toPublic(uuid)
        XCTAssertNotEqual(publicID, uuid)
        XCTAssertEqual(DrawerDestination.project(projectID: publicID), .project(projectID: uuid))
        XCTAssertEqual(Set([DrawerDestination.project(projectID: publicID), .project(projectID: uuid)]).count, 1)
        XCTAssertNotEqual(DrawerDestination.project(projectID: uuid), .workspace(agentID: uuid))
    }

    /// The left edge opens the drawer on a destination's own page — a section's root or a project's
    /// sessions page — and is the system back-swipe on any page pushed over one.
    func testTheLeftEdgeBelongsToTheDrawerOnlyOnADestinationsOwnPage() {
        var nav = NavState(section: .agents)
        XCTAssertTrue(nav.atDestinationRoot, "the workspace's list")
        nav.push(.console(sessionID: "s1", origin: .list))
        XCTAssertFalse(nav.atDestinationRoot, "a console over it")

        nav.popToRoot()
        nav.enterFolder(SessionFolderAddress(folderID: "f1", agentID: "a1", view: .open))
        XCTAssertFalse(nav.atDestinationRoot, "a folder's page is pushed over the list")
        nav.enterProjectSessions(SessionProjectAddress(projectID: "p1", agentID: "a1", view: .open))
        XCTAssertTrue(nav.atDestinationRoot, "a project's sessions page, wherever it was opened")
        nav.push(.projectDetail(projectID: "p1"))
        XCTAssertFalse(nav.atDestinationRoot, "the project's page pushed over it")
        nav.pop()
        XCTAssertTrue(nav.atDestinationRoot)

        nav.section = .projects
        nav.path = [.projectDetail(projectID: "p1")]
        XCTAssertFalse(nav.atDestinationRoot, "a project's page over the Projects list")
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
        nav.push(.compose(agentID: "a1", folderID: nil))
        XCTAssertNil(nav.focusedConsoleSessionID, "a draft streams nothing")
        XCTAssertFalse(nav.sectionAtRoot)

        nav.replaceTop(with: .console(sessionID: "s1", origin: .list))

        XCTAssertEqual(nav.path.count, 1, "the page you were on is the page you stay on")
        XCTAssertEqual(nav.focusedConsoleSessionID, "s1", "and it streams now")
        XCTAssertEqual(nav.highlightedSessionID, "s1")
        XCTAssertFalse(nav.atDestinationRoot, "a console keeps the system back-swipe")
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

    /// Each single-layer section's selection is the record on top of *its own* stack — Following's
    /// watch, Runners' runner, Admin's account. Nothing else holds it: the three-column list's
    /// highlight and the compact pushed page are that one read, and switching sections shows the new
    /// section's root rather than the other one's record.
    func testEachSingleLayerSectionsSelectionIsTheRecordOnTopOfItsStack() {
        var nav = NavState(section: .following)
        XCTAssertNil(nav.selectedWatchID, "the list page shows no record")
        nav.push(.watchDetail(watchID: "w1"))
        XCTAssertEqual(nav.selectedWatchID, "w1")
        XCTAssertFalse(nav.sectionAtRoot, "a record is a page, so the edge goes to the back-swipe")

        nav.section = .runners
        XCTAssertNil(nav.selectedRunnerID, "Runners shows its own root, not Following's watch")
        nav.push(.runnerDetail(runnerID: "r1"))
        XCTAssertEqual(nav.selectedRunnerID, "r1")

        nav.section = .admin
        XCTAssertNil(nav.selectedUserID)
        XCTAssertTrue(nav.sectionAtRoot)
        nav.push(.userDetail(userID: "u1"))
        XCTAssertEqual(nav.selectedUserID, "u1")

        nav.section = .following
        XCTAssertEqual(nav.selectedWatchID, "w1", "and each section comes back as you left it")
        nav.section = .runners
        XCTAssertEqual(nav.selectedRunnerID, "r1")
        nav.section = .admin
        XCTAssertEqual(nav.selectedUserID, "u1")
    }

    /// The Admin gap, from the value side. Compact Admin had no detail column and no push, so a
    /// selected user went nowhere and the section answered "at root" whatever the selection said.
    /// A user's record is a page of the section's stack now, which is what makes pushing it
    /// expressible — and what hands the left edge back to the system back-swipe while it is up.
    func testTheAdminSectionCanNowPushAUsersRecord() {
        var nav = NavState(section: .admin)
        XCTAssertTrue(nav.sectionAtRoot, "the list page is the root")

        nav.push(.userDetail(userID: "u1"))

        XCTAssertEqual(nav.selectedUserID, "u1", "the account on screen is the account selected")
        XCTAssertFalse(nav.sectionAtRoot, "and the edge now belongs to the back-swipe")

        nav.pop()

        XCTAssertNil(nav.selectedUserID)
        XCTAssertTrue(nav.sectionAtRoot)
        XCTAssertEqual(nav, NavState(section: .admin), "an emptied stack leaves nothing behind")
    }

    /// Settings is the one section that goes genuinely deep — three layers, and until this step the
    /// only stack built from *two* push mechanisms chained: a boolean `navigationDestination
    /// (isPresented:)` for the runners list, then a destination-closure `NavigationLink` for a
    /// runner's record. Both are frames now, so the depth SwiftUI draws and the depth the model holds
    /// are one value, and the left screen edge follows it at every layer rather than only the first.
    func testTheSettingsStackHoldsAllThreeLayers() {
        var nav = NavState(section: .settings)
        XCTAssertEqual(nav.path, [], "the form is the bottom of the stack")
        XCTAssertTrue(nav.sectionAtRoot, "so the drawer's edge gesture is free on it")

        nav.push(.settingsRunners)
        XCTAssertEqual(nav.path, [.settingsRunners], "the runners list is the second layer")
        XCTAssertFalse(nav.sectionAtRoot, "a pushed page owns that edge for the back-swipe")

        nav.push(.runnerDetail(runnerID: "r1"))
        XCTAssertEqual(nav.path.count, 2, "a runner's record is the third layer")
        XCTAssertFalse(nav.sectionAtRoot, "still two deep, so still not at the root")
        // The frame type is shared with the Runners section; what separates the two is the stack it
        // rides — pushing it from Settings must leave Runners' own stack alone.
        XCTAssertNil(nav.stacks[.runners], "Settings' frames are Settings'")

        nav.pop()
        XCTAssertEqual(nav.path, [.settingsRunners], "the first pop lands on the runners list")
        XCTAssertFalse(nav.sectionAtRoot, "which is one deep, not the root")

        nav.pop()
        XCTAssertEqual(nav, NavState(section: .settings), "the second leaves nothing behind")
        XCTAssertTrue(nav.sectionAtRoot)

        nav.pop()
        XCTAssertEqual(nav, NavState(section: .settings), "and the root cannot be popped past")
    }

    /// While Settings is up as a sheet (iOS), its own stack is the one on screen: a push lands there,
    /// and the section underneath — a console, still streaming — is left exactly as it was.
    func testAPushWhileSettingsIsUpLandsOnSettingsOwnStack() {
        var nav = NavState(section: .agents)
        nav.push(.console(sessionID: "s1", origin: .list))
        nav.openSettings()

        nav.push(.settingsRunners)
        nav.push(.runnerDetail(runnerID: "r1"))
        XCTAssertEqual(nav.settingsPath, [.settingsRunners, .runnerDetail(runnerID: "r1")],
                       "the runners list and a runner's record ride Settings' stack")
        XCTAssertEqual(nav.section, .agents, "Settings is over the section, not instead of it")
        XCTAssertEqual(nav.path, [.console(sessionID: "s1", origin: .list)],
                       "the section's own stack is untouched")
        XCTAssertEqual(nav.focusedConsoleSessionID, "s1", "so its console keeps streaming under the sheet")
        XCTAssertNil(nav.stacks[.runners], "and the Runners section's stack is not Settings'")

        // Closed, pushes are the section's again.
        nav.settingsPresented = false
        nav.push(.console(sessionID: "s2", origin: .list))
        XCTAssertEqual(nav.path.count, 2)
        XCTAssertEqual(nav.settingsPath.count, 2, "closing leaves Settings' stack where it was")
    }

    /// Settings opens on its own list, whatever page it was closed on — and opening it again while it
    /// is up changes nothing.
    func testSettingsOpensOnItsOwnList() {
        var nav = NavState(section: .projects)
        nav.openSettings()
        nav.push(.settingsPage(.notifications))
        nav.openSettings()
        XCTAssertEqual(nav.settingsPath, [.settingsPage(.notifications)], "already up: nothing moves")

        nav.settingsPresented = false
        nav.openSettings()
        XCTAssertEqual(nav.settingsPath, [], "reopened: back to the list")
        XCTAssertTrue(nav.settingsPresented)
        XCTAssertNil(nav.stacks[.settings], "an emptied stack drops its key")
    }

    /// Settings' stack is the same key whether it is the section (macOS) or the sheet (iOS), so
    /// `settingsPath` and `path` are one value while Settings is the section.
    func testSettingsPathIsTheSectionsPathWhenSettingsIsTheSection() {
        var nav = NavState(section: .settings)
        nav.push(.settingsPage(.sharedLinks))
        XCTAssertEqual(nav.settingsPath, nav.path)
        nav.settingsPath = []
        XCTAssertEqual(nav, NavState(section: .settings), "an emptied stack leaves nothing behind")
    }

    /// A deep link names a watch by its UUID while the list tags rows by public id, so the frame is
    /// rekeyed in place once the watch is in hand: `replaceTop`, not a second frame stacked over the
    /// first — backing out of a watch must not walk through the same watch twice.
    func testAWatchNamedByUUIDIsRekeyedInPlace() {
        var nav = NavState(section: .following)
        nav.replaceTop(with: .watchDetail(watchID: "7f3c1d2e-0000-4000-8000-000000000000"))
        nav.replaceTop(with: .watchDetail(watchID: "w_public"))

        XCTAssertEqual(nav.path, [.watchDetail(watchID: "w_public")])
        XCTAssertEqual(nav.path.count, 1, "rekeying is not a push")
        XCTAssertEqual(nav.selectedWatchID, "w_public", "the highlight is that same rekeyed frame")
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

        nav.push(.compose(agentID: "a1", folderID: nil))
        XCTAssertNil(nav.focusedConsoleSessionID, "a draft composer is not a console either")
    }

    // MARK: - Tasks
    //
    // This section already had an incident of the kind this project is about: "a deleted task cannot
    // leave compact iOS navigation stuck on a spinner with a non-nil selection". The fix at the time
    // was to clear the detail store by hand, which left the selection and the pushed page free to
    // disagree. These are the same facts for Tasks, read the same way.

    /// What the list highlights is the detail page that is showing. Backing out to the list leaves no
    /// task current, so the row cannot be left drawn as selected with nothing behind it — and the
    /// left screen edge goes back to the drawer gesture with it.
    func testTheTaskListHighlightsTheDetailPageThatIsShowing() {
        var nav = NavState(section: .tasks)
        XCTAssertNil(nav.taskDetailOnTop, "the list page has no task on screen")

        nav.replaceTop(with: .taskDetail(taskID: "t1"))
        XCTAssertEqual(nav.taskDetailOnTop, "t1")
        XCTAssertFalse(nav.sectionAtRoot)

        nav.replaceTop(with: .taskDetail(taskID: "t2"))
        XCTAssertEqual(nav.path.count, 1, "selecting again swaps the page rather than stacking on it")
        XCTAssertEqual(nav.taskDetailOnTop, "t2")

        nav.pop()

        XCTAssertNil(nav.taskDetailOnTop, "no task stays current once the list is back")
        XCTAssertTrue(nav.sectionAtRoot)
        XCTAssertEqual(nav, NavState(section: .tasks), "an emptied stack leaves nothing behind")
    }

    /// Re-opening the same task after backing out. The value the binding receives equals the one it
    /// holds only if a selection is kept beside the stack — which is the dead tap this section's
    /// history predicts, and why there is nowhere left for such a state to live.
    func testReopeningTheSameTaskAfterBackingOutOpensItAgain() {
        var nav = NavState(section: .tasks)
        nav.replaceTop(with: .taskDetail(taskID: "t1"))
        nav.pop()
        nav.replaceTop(with: .taskDetail(taskID: "t1"))

        XCTAssertEqual(nav.path, [.taskDetail(taskID: "t1")])
        XCTAssertEqual(nav.taskDetailOnTop, "t1")
        XCTAssertFalse(nav.sectionAtRoot)
    }

    /// The second page this section pushes: the searchable directory of every named list. It is a
    /// frame, so "the directory is showing" and "a task is selected" cannot both be true, and picking
    /// a list closes it by landing back on the list underneath.
    func testTheTaskListDirectoryIsASecondPageOnTheSameStack() {
        var nav = NavState(section: .tasks)
        nav.push(.taskListsDirectory)

        XCTAssertTrue(nav.taskListsDirectoryOnTop)
        XCTAssertNil(nav.taskDetailOnTop, "the directory is not a task's detail")
        XCTAssertFalse(nav.sectionAtRoot, "a pushed page still owns the screen edge")

        nav.pop()

        XCTAssertFalse(nav.taskListsDirectoryOnTop, "picking a list lands on the list")
        XCTAssertTrue(nav.sectionAtRoot)
        XCTAssertEqual(nav, NavState(section: .tasks), "an emptied stack leaves nothing behind")
    }

    /// A coordinator conversation and its project's page, back and forth on a phone: the title pushes
    /// the project over the conversation, and the project's way back to that conversation is a pop.
    /// Putting the conversation on top again (the old `replaceTop`) left the same conversation twice,
    /// one over the other — a back swipe that seemed to do nothing.
    func testGoingBackToTheConversationUnderAProjectPageIsAPop() {
        var nav = NavState(section: .agents)
        nav.push(.console(sessionID: "34DynS2HpGYT6T1Nf6h3U", origin: .list))

        for _ in 0..<3 {
            nav.push(.projectDetail(projectID: "p1"))
            // The project's press may name the conversation in either spelling.
            XCTAssertTrue(nav.returnToConsole("01a03f47-4af6-753d-9109-a4440b1a71c4"))
            XCTAssertEqual(nav.path, [.console(sessionID: "34DynS2HpGYT6T1Nf6h3U", origin: .list)],
                           "round trips leave one conversation, not a growing stack")
            XCTAssertEqual(nav.focusedConsoleSessionID, "34DynS2HpGYT6T1Nf6h3U", "and it is the one streaming")
        }
    }

    /// Only the conversation directly under the page is gone back to. Another conversation there, one
    /// further down, a page on top that is not over a conversation, or Settings up over the section:
    /// nothing moves, and the caller opens the conversation the way it always has.
    func testOnlyTheConversationDirectlyUnderThePageIsGoneBackTo() {
        var other = NavState(section: .agents)
        other.push(.console(sessionID: "s-other", origin: .list))
        other.push(.projectDetail(projectID: "p1"))

        var deeper = NavState(section: .agents)
        deeper.push(.console(sessionID: "s1", origin: .list))
        deeper.push(.console(sessionID: "s2", origin: .conversation))
        deeper.push(.projectDetail(projectID: "p1"))

        let projects = NavState(section: .projects, stacks: [.projects: [.projectDetail(projectID: "p1")]])

        var settings = NavState(section: .agents)
        settings.push(.console(sessionID: "s1", origin: .list))
        settings.push(.projectDetail(projectID: "p1"))
        settings.openSettings()

        for (label, before, session) in [("another conversation", other, "s1"),
                                          ("one further down", deeper, "s1"),
                                          ("the Projects section", projects, "s1"),
                                          ("Settings up", settings, "s1")] {
            var nav = before
            XCTAssertFalse(nav.returnToConsole(session), label)
            XCTAssertEqual(nav, before, "\(label): nothing moves")
        }
    }

    /// A project's task row opens the task over the project's page on the Projects stack itself —
    /// not in Tasks, whose every-task scope is the tasks outside projects. The project is still the
    /// one showing under it, so the three-column list keeps it selected and the pane can draw the
    /// task over it; and the task is what the task-detail store follows.
    func testATaskOpenedFromAProjectKeepsItsProjectShowingUnderIt() {
        var nav = NavState(section: .projects)
        nav.path = [.projectDetail(projectID: "p1")]
        nav.push(.taskDetail(taskID: "t1"))

        XCTAssertEqual(nav.selectedProjectID, "p1", "the project stays the one showing")
        XCTAssertEqual(nav.projectBeneathTask, "p1")
        XCTAssertEqual(nav.taskDetailOnTop, "t1", "the task is the page on top")
        XCTAssertFalse(nav.atDestinationRoot, "the task page keeps the system back-swipe")

        nav.pop()
        XCTAssertEqual(nav.path, [.projectDetail(projectID: "p1")], "back is the project's page")
        XCTAssertNil(nav.projectBeneathTask)

        // A task with no project under it — the Tasks stack's own — names no project.
        let tasks = NavState(section: .tasks, stacks: [.tasks: [.taskDetail(taskID: "t1")]])
        XCTAssertNil(tasks.selectedProjectID)
        XCTAssertNil(tasks.projectBeneathTask)
    }

    /// The task page's project line, over the page of that project, is a pop: project › task, not
    /// project › task › project on every press. Either spelling of the project's id.
    func testTheTaskPagesProjectLineGoesBackToTheProjectUnderIt() {
        for _ in 0..<3 {
            var nav = NavState(section: .projects)
            nav.path = [.projectDetail(projectID: "34DynS2HpGYT6T1Nf6h3U")]
            nav.push(.taskDetail(taskID: "t1"))
            XCTAssertTrue(nav.returnToProject("01a03f47-4af6-753d-9109-a4440b1a71c4"))
            XCTAssertEqual(nav.path, [.projectDetail(projectID: "34DynS2HpGYT6T1Nf6h3U")])
        }
    }

    /// Only the project directly under the task page is gone back to. Another project there, a task
    /// over a conversation, a project's page with nothing over it, or Settings up over the section:
    /// nothing moves, and the caller opens the project the way it always has.
    func testOnlyTheProjectDirectlyUnderTheTaskIsGoneBackTo() {
        var other = NavState(section: .projects)
        other.path = [.projectDetail(projectID: "p-other")]
        other.push(.taskDetail(taskID: "t1"))

        var console = NavState(section: .agents)
        console.push(.console(sessionID: "s1", origin: .list))
        console.push(.taskDetail(taskID: "t1"))

        let page = NavState(section: .projects, stacks: [.projects: [.projectDetail(projectID: "p1")]])

        var settings = NavState(section: .projects)
        settings.path = [.projectDetail(projectID: "p1")]
        settings.push(.taskDetail(taskID: "t1"))
        settings.openSettings()

        for (label, before) in [("another project", other), ("a task over a conversation", console),
                                ("the project's own page", page), ("Settings up", settings)] {
            var nav = before
            XCTAssertFalse(nav.returnToProject("p1"), label)
            XCTAssertEqual(nav, before, "\(label): nothing moves")
        }
    }

    /// A notification, a link or a dependency jump routes a task into Tasks; when its row says it is
    /// a project's, it moves over that project's page. It comes off the Tasks stack (left there, the
    /// Tasks section would reopen on a project's task over "Tasks outside projects"), and the
    /// Projects stack becomes the pair the project's rows push — whatever that stack held before.
    func testARoutedTaskMovesOverItsProjectsPage() {
        var nav = NavState(section: .tasks, stacks: [
            .tasks: [.taskListsDirectory, .taskDetail(taskID: "34DynS2HpGYT6T1Nf6h3U")],
            .projects: [.projectDetail(projectID: "p-other")],
        ])
        // The route may name the task in either spelling.
        nav.moveTaskOverProject("01a03f47-4af6-753d-9109-a4440b1a71c4", project: "p1")

        XCTAssertEqual(nav.stacks[.tasks], [.taskListsDirectory], "only the task comes off the Tasks stack")
        XCTAssertEqual(nav.stacks[.projects], [.projectDetail(projectID: "p1"),
                                               .taskDetail(taskID: "01a03f47-4af6-753d-9109-a4440b1a71c4")])
        XCTAssertEqual(nav.section, .tasks, "switching sections is the caller's, whose setter syncs the store")

        nav.section = .projects
        XCTAssertEqual(nav.selectedProjectID, "p1", "the project shows under the task")
        XCTAssertEqual(nav.taskDetailOnTop, "01a03f47-4af6-753d-9109-a4440b1a71c4")

        // A Tasks stack holding only that task is emptied, not left as an empty array.
        var alone = NavState(section: .tasks, stacks: [.tasks: [.taskDetail(taskID: "t1")]])
        alone.moveTaskOverProject("t1", project: "p1")
        XCTAssertNil(alone.stacks[.tasks])
        // A Tasks stack whose top is another page is left as it is.
        var other = NavState(section: .tasks, stacks: [.tasks: [.taskDetail(taskID: "t2")]])
        other.moveTaskOverProject("t1", project: "p1")
        XCTAssertEqual(other.stacks[.tasks], [.taskDetail(taskID: "t2")])
    }

    /// Leaving the section and coming back. The directory used to be the one push that did *not*
    /// survive this — `selectedSection`'s `didSet` dropped it by hand, because a boolean cannot ride
    /// a view being rebuilt the way a frame on a stack can. Now Tasks lands where you left it, like
    /// every other section.
    func testTheTaskListDirectorySurvivesLeavingTheSection() {
        var nav = NavState(section: .tasks)
        nav.push(.taskListsDirectory)

        nav.section = .agents
        XCTAssertTrue(nav.sectionAtRoot, "Agents shows its own root")

        nav.section = .tasks

        XCTAssertEqual(nav.path, [.taskListsDirectory], "coming back lands on the page you left")
        XCTAssertFalse(nav.sectionAtRoot, "and the left edge still belongs to that page")
    }

    /// A runner's record pushes two pages of its own — an engine's, its name's — and they are still
    /// that runner's: the three-column list keeps the runner highlighted while one of them fills the
    /// pane, and the back button lands on the record they were pushed from.
    func testARunnersOwnPagesKeepItsRecordSelected() {
        var nav = NavState(section: .runners)
        nav.replaceTop(with: .runnerDetail(runnerID: "r1"))
        nav.push(.runnerEngine(runnerID: "r1", engine: "codex"))
        XCTAssertEqual(nav.selectedRunnerID, "r1", "an engine's page is its runner's")
        XCTAssertFalse(nav.sectionAtRoot)

        nav.pop()
        XCTAssertEqual(nav.path, [.runnerDetail(runnerID: "r1")], "back is the record")
        nav.push(.runnerName(runnerID: "r1"))
        XCTAssertEqual(nav.selectedRunnerID, "r1", "and so is its name's")

        // Picking another runner (`AppModel.selectedRunnerID`'s write) takes the old runner's pages
        // off with its record: the new record is the one page showing, as a route lands.
        nav.popRunnerPages()
        nav.replaceTop(with: .runnerDetail(runnerID: "r2"))
        XCTAssertEqual(nav.selectedRunnerID, "r2")
        XCTAssertEqual(nav.path, [.runnerDetail(runnerID: "r2")], "not r1's record left under r2's")

        // Down to the record and no further: the record is the selection's to clear, not this.
        nav.push(.runnerEngine(runnerID: "r2", engine: "claude"))
        nav.push(.runnerName(runnerID: "r2"))
        nav.popRunnerPages()
        XCTAssertEqual(nav.path, [.runnerDetail(runnerID: "r2")])
        nav.popRunnerPages()
        XCTAssertEqual(nav.path, [.runnerDetail(runnerID: "r2")])
    }

    /// From Settings (iOS) the same two pages ride Settings' own stack, one layer under the record.
    func testARunnersOwnPagesRideSettingsStackWhileItIsUp() {
        var nav = NavState(section: .agents)
        nav.openSettings()
        nav.push(.settingsRunners)
        nav.push(.runnerDetail(runnerID: "r1"))
        nav.push(.runnerEngine(runnerID: "r1", engine: "claude"))
        XCTAssertEqual(nav.settingsPath, [.settingsRunners, .runnerDetail(runnerID: "r1"),
                                          .runnerEngine(runnerID: "r1", engine: "claude")])
        XCTAssertNil(nav.stacks[.runners], "the Runners section's stack is not Settings'")
        XCTAssertNil(nav.stacks[.agents], "nor is the section under the sheet")
    }
}
