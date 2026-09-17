import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shells. These hold the three
/// single-layer sections — Following, Runners, Admin — to the source they now *are*: **each
/// section's stack in `NavState` is the only copy of what is showing**. The compact shell binds a
/// `NavigationStack(path:)` to that stack and every row carries its own destination value; the
/// three-column shells keep their `List(selection:)`, but it is a projection onto the same stack, so
/// selecting swaps the page the detail pane shows.
///
/// This step's one behaviour change is here too: compact Admin had no detail column and no push, so
/// a selected user went nowhere and the section answered "at root" whatever the selection said. The
/// account's record is a page of that section's stack now, and a row tap pushes it. Each check reads
/// the slice of the file it is about, so a match somewhere else can't pass it.
final class FollowingRunnersAdminWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "\(path) wasn't found above this test. If it moved, point this check at its new home — "
                + "don't delete the check."
        }
    }

    /// Found by walking up from this file; never a skip, so the check can't go quiet when a file moves.
    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir.deleteLastPathComponent()
        }
        throw SourceMissing(path: relative)
    }

    private func appSource(_ relative: String) throws -> String {
        try source("src/macos/OrbitApp/Sources/OrbitApp/\(relative)")
    }

    /// From the first `start` through the next `end` after it.
    private func slice(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`")
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    /// The text without its comment lines, which are free to talk about what the code must not do.
    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    /// Each compact section is a `NavigationStack` whose path IS that section's stack, and its rows
    /// push their own destinations onto it. A collapsed `NavigationSplitView` kept only a selection,
    /// and the flat optional it was bound to could outlive the page it named.
    func testTheCompactSectionsAreStacksBoundToTheirOwnStack() throws {
        let shell = try appSource("Views/CompactShell.swift")
        let cases: [(name: String, from: String, to: String, root: String, page: String)] = [
            ("Runners", "case .runners:", "// FOLLOWING", "RunnersListView(rowNavigation: .push)",
             "RunnerDetailView(runnerID: runnerID)"),
            ("Following", "case .following:", "// SKILLS", "FollowingListView(rowNavigation: .push)",
             "WatchDetailView(watchID: watchID)"),
            ("Admin", "case .admin:", "/// The drawer surface color", "AdminUsersView(rowNavigation: .push)",
             "AdminUserDetailView(userID: userID)"),
        ]
        for c in cases {
            let section = code(try slice(shell, from: c.from, to: c.to))
            XCTAssertTrue(section.contains("NavigationStack(path: $model.nav.path)"),
                          "\(c.name): the stack SwiftUI moves is the one NavState keeps for this section")
            XCTAssertTrue(section.contains(c.root), "\(c.name): the section's own list is its root")
            XCTAssertTrue(section.contains("navigationDestination(for: NavNode.self)"),
                          "\(c.name): one page per frame type, keyed by the value that was pushed")
            XCTAssertTrue(section.contains(c.page),
                          "\(c.name): the page a row pushed is the one the record renders from")
            XCTAssertFalse(section.contains("NavigationSplitView"),
                           "\(c.name): a collapsed split cannot push a value, it only ever had a selection")
            XCTAssertFalse(section.contains("navigationDestination(isPresented:"),
                           "\(c.name): no boolean push left on this section's stack")
        }
    }

    /// One row, two containers — for each of the three lists. The row view is built once; what
    /// differs is who moves the screen: the three-column `List`'s selection, or the compact row's own
    /// destination value. Both read the same stack, so neither shape draws a row it cannot open.
    func testEveryListBuildsOneRowAndOnlyTheCompactContainerPushes() throws {
        let cases: [(view: String, start: String, end: String, tag: String, push: String)] = [
            ("Views/FollowingView.swift",
             "@ViewBuilder private func row(_ watch: Watch, now: Date) -> some View {",
             "/// One watch as a Following row", ".tag(watch.id)",
             "Button { model.push(.watchDetail(watchID: watch.id)) } label: {"),
            ("Views/SkillsRunnersView.swift",
             "@ViewBuilder private func row(_ r: Runner) -> some View {",
             "#if os(iOS)", ".tag(r.id)",
             "Button { model.push(.runnerDetail(runnerID: r.id)) } label: {"),
            ("Views/SettingsAdminView.swift",
             "@ViewBuilder private func row(_ u: User) -> some View {",
             "struct AdminUserDetailView: View {", ".tag(u.id)",
             "Button { model.push(.userDetail(userID: u.id)) } label: {"),
        ]
        for c in cases {
            let row = code(try slice(try appSource(c.view), from: c.start, to: c.end))
            let selectionBranch = try XCTUnwrap(row.range(of: "case .selection:"), c.view)
            let pushBranch = try XCTUnwrap(row.range(of: "case .push:"), "\(c.view): the compact branch")
            let tag = try XCTUnwrap(row.range(of: c.tag),
                                    "\(c.view): the three-column row stays tag-driven")
            let pushed = try XCTUnwrap(row.range(of: c.push),
                                       "\(c.view): the compact row carries its destination")
            XCTAssertLessThan(selectionBranch.lowerBound, pushBranch.lowerBound, c.view)
            XCTAssertLessThan(tag.lowerBound, pushBranch.lowerBound,
                              "\(c.view): `.tag` belongs to the selection branch, not the pushing one")
            XCTAssertLessThan(pushBranch.lowerBound, pushed.lowerBound,
                              "\(c.view): and the push belongs to the pushing branch")
            XCTAssertFalse(row.contains("NavigationLink"),
                           "\(c.view): the compact row is not a link — the disclosure indicator a "
                           + "`NavigationLink(value:)` draws cannot be hidden on iOS 17/18, so the "
                           + "row pushes its frame through `AppModel.push` instead")
        }

        // Who gets which shape: each compact section asks for the pushing one, and the three-column
        // shell takes the default — it reaches every list through `SectionContent`, which passes
        // nothing, so those lists keep the `List`'s selection.
        let compact = code(try appSource("Views/CompactShell.swift"))
        for call in ["FollowingListView(rowNavigation: .push)", "RunnersListView(rowNavigation: .push)",
                     "AdminUsersView(rowNavigation: .push)"] {
            XCTAssertTrue(compact.contains(call), "the compact shell pushes rows through \(call)")
        }
        let main = code(try appSource("Views/MainView.swift"))
        XCTAssertFalse(main.contains("rowNavigation:"),
                       "the three-column shell keeps the List's selection")
        XCTAssertTrue(main.contains("FollowingListView()") && main.contains("RunnersListView()")
                        && main.contains("AdminUsersView()"),
                      "reaching each list with its default shape")
    }

    /// Each single-layer section's detail renders the page it was handed, and falls back to the
    /// section's stack when nothing handed it one — which is the three-column shell, where the frame
    /// on the stack and the selection are the same read.
    func testTheDetailRendersThePageItWasPushedWith() throws {
        let following = code(try slice(try appSource("Views/WatchViews.swift"),
                                       from: "struct WatchDetailView: View {",
                                       to: "/// A watch's whole record"))
        XCTAssertTrue(following.contains("var watchID: String? = nil"),
                      "the record to show is the frame the page was pushed with")
        XCTAssertTrue(following.contains("let id = watchID ?? model.selectedWatchID"),
                      "and the three-column detail reads that same frame off the stack")
        // The fallback fetch the deep link depends on: a push can name a watch the list doesn't hold.
        XCTAssertTrue(following.contains("await store.fetch(id)"),
                      "a watch the list doesn't hold is fetched before calling it missing")
        XCTAssertTrue(following.contains("if store.watch(id) == nil { missingID = id }"))

        let runners = code(try slice(try appSource("Views/SkillsRunnersView.swift"),
                                     from: "struct RunnerDetailView: View {",
                                     to: "struct RunnerDetailContent: View {"))
        XCTAssertTrue(runners.contains("var runnerID: String? = nil"))
        XCTAssertTrue(runners.contains("let id = runnerID ?? model.selectedRunnerID"))

        let admin = code(try slice(try appSource("Views/SettingsAdminView.swift"),
                                   from: "struct AdminUserDetailView: View {", to: "struct NewUserSheet: View {"))
        XCTAssertTrue(admin.contains("var userID: String? = nil"))
        XCTAssertTrue(admin.contains("let id = userID ?? model.selectedUserID"))
    }

    /// Every fact these sections read is a read of their stack, and every write is a stack
    /// transition: nothing here keeps a copy that could disagree with what SwiftUI has pushed.
    func testTheModelKeepsNoCopyOfWhatTheseStacksAlreadySay() throws {
        let app = try appSource("AppModel.swift")
        let model = code(app)

        // The projections — the old names, now reads and writes of the section's stack.
        for projection in ["get { nav.selectedWatchID }", "get { nav.selectedRunnerID }",
                           "get { nav.selectedUserID }"] {
            XCTAssertTrue(model.contains(projection), "\(projection)")
        }
        for write in ["nav.replaceTop(with: .watchDetail(watchID: id))",
                      "nav.replaceTop(with: .runnerDetail(runnerID: id))",
                      "nav.replaceTop(with: .userDetail(userID: id))"] {
            XCTAssertTrue(model.contains(write), "selecting writes \(write)")
        }
        // ... and no flat optional left beside them.
        for stored in ["var selectedWatchID: String?\n", "var selectedRunnerID: String?\n",
                       "var selectedUserID: String?\n"] {
            XCTAssertFalse(model.contains(stored),
                           "a flat optional is back beside the stack: \(stored.trimmingCharacters(in: .whitespaces))")
        }

        // At root is an empty stack, for every section that pushes.
        let root = code(try slice(app, from: "var sectionAtRoot: Bool {",
                                  to: "/// ⌘D: complete the open"))
        XCTAssertTrue(root.contains("case .skills, .runners, .following, .admin, .settings: return nav.sectionAtRoot"),
                      "Settings joined the stack-reading arm when both of its pushes became frames")
        XCTAssertFalse(root.contains("case .skills, .admin: return true"),
                       "Admin is no longer unconditionally at its root: it has a page to push")
        XCTAssertFalse(root.contains("selectedRunnerID == nil") || root.contains("selectedWatchID == nil"))

        // The entries. A runner deep link is the same "select this runner" act a row is.
        let route = code(try slice(app, from: "func route(to route: Route) {",
                                   to: "/// Open a watch's record on Following."))
        XCTAssertTrue(route.contains("case .runner(let id):  selectedRunnerID = id"),
                      "the deep link routes through the same projection the list selects through")

        // The watch deep link keeps both halves of its old contract: the frame takes the list's
        // spelling when the list already holds the watch, and an older one it doesn't hold is
        // fetched first — with the write-back guarded to its own section, since that write now lands
        // on whichever stack is showing.
        let watch = code(try slice(app, from: "private func openWatch(_ id: String) {", to: "\n    }"))
        XCTAssertTrue(watch.contains("selectedWatchID = watches?.watch(id)?.id ?? id"),
                      "a push naming a UUID is rekeyed to the list's public id")
        XCTAssertTrue(watch.contains("await watches.fetch(id)"),
                      "and a watch the list doesn't hold is fetched before it can be spelled")
        XCTAssertTrue(watch.contains("self.selectedSection == .following"),
                      "the write-back is guarded to the section whose frame it corrects")
        XCTAssertTrue(watch.contains("self.selectedWatchID = watch.id"),
                      "then the frame takes the spelling, in place")

        // Signing out drops every section's stack, which is where these three now live.
        let reset = code(try slice(app, from: "private func resetNavigation() {",
                                   to: "/// Wire up notifications."))
        XCTAssertTrue(reset.contains("nav = NavState()"))
        for gone in ["selectedWatchID", "selectedRunnerID", "selectedUserID"] {
            XCTAssertFalse(reset.contains(gone), "\(gone) is its stack, cleared by `nav = NavState()`")
        }
    }

    /// The one behaviour change of this step, from the shell's side: compact Admin gets a page to
    /// push, and the section yields the left screen edge to the back-swipe once it is up. The
    /// three-column shell is untouched — it always had the detail, and `MainView` still hands the
    /// same view nothing.
    func testCompactAdminGainsThePageItNeverHad() throws {
        let shell = try appSource("Views/CompactShell.swift")
        let admin = code(try slice(shell, from: "case .admin:", to: "/// The drawer surface color"))
        XCTAssertTrue(admin.contains("NavigationStack(path: $model.nav.path)"),
                      "Admin's record is a frame of its own stack, so the shell can push one")
        XCTAssertTrue(admin.contains("AdminUsersView(rowNavigation: .push)"),
                      "and its rows are the shape that pushes")
        XCTAssertTrue(admin.contains("AdminUserDetailView(userID: userID)"),
                      "the pushed record is the page it lands on")
        // A row tap has somewhere to go now — the gap was that nothing rendered the selection.
        let users = code(try slice(try appSource("Views/SettingsAdminView.swift"),
                                   from: "struct AdminUsersView: View {", to: "struct AdminUserDetailView: View {"))
        XCTAssertTrue(users.contains("Button { model.push(.userDetail(userID: u.id)) } label: {"))
        // Three-column unchanged: same view, still handed nothing by the shell that has the detail.
        let main = code(try appSource("Views/MainView.swift"))
        XCTAssertTrue(main.contains("case .admin:\n            AdminUserDetailView()"),
                      "the three-column detail still reads the account off the stack")
    }
}
