import Foundation
import XCTest
@testable import OrbitKit

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shells. These hold Settings to
/// the source it now *is*: **on iOS a sheet over the section you are in, with a stack of its own in
/// `NavState`**, and on macOS the one grouped form it always was.
///
/// Settings used to be a section on iOS — the drawer's gear switched to it, so closing it meant
/// opening the drawer again, and the regular-width iPad split its form into category columns. It is
/// ChatGPT's shape now: a sheet whose list names each thing and where it stands, every page one push
/// deeper. Its stack is still a `NavNode` stack in `NavState` (Settings' own), so the back button and
/// every push read the one value the sheet moves. Each check reads the slice of the file it is
/// about, so a match somewhere else can't pass it.
final class SettingsStackWiringTests: XCTestCase {
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

    /// Every Swift file of the app, unedited — the acceptance grep reads the raw text, comments
    /// included, so this does too.
    private func appSources() throws -> [(path: String, text: String)] {
        let relative = "src/macos/OrbitApp/Sources/OrbitApp"
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let root = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: root.path) {
                let walk = try XCTUnwrap(FileManager.default.enumerator(at: root,
                                                                        includingPropertiesForKeys: nil))
                var files: [(path: String, text: String)] = []
                for case let url as URL in walk where url.pathExtension == "swift" {
                    files.append((url.path, try String(contentsOf: url, encoding: .utf8)))
                }
                XCTAssertFalse(files.isEmpty, "the app source tree listed no Swift files")
                return files
            }
            dir.deleteLastPathComponent()
        }
        throw SourceMissing(path: relative)
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

    /// Choosing Settings on iOS presents it; it never becomes the section. The two ways in — the
    /// drawer's gear on iPhone, the sidebar's row on iPad — both raise the sheet, and the section
    /// switch itself stays what it was (`NavigationEntrancesWiringTests` holds it to that).
    func testSettingsIsASheetOverTheSectionOnIOS() throws {
        let root = code(try source("src/ios/Sources/OrbitiOSApp.swift"))
        XCTAssertTrue(root.contains(".settingsSheet(model)"),
                      "the sheet hangs off the signed-in root, so both shells share it")

        let compact = code(try appSource("Views/CompactShell.swift"))
        XCTAssertTrue(compact.contains("model.settingsPresented = true"), "the drawer's gear opens it")
        XCTAssertFalse(compact.contains("model.selectedSection = .settings"), "rather than switching to it")
        let arm = try slice(compact, from: "case .settings:", to: "case .admin:")
        XCTAssertTrue(arm.contains("EmptyView()"), "and the section has nothing of its own to draw")
        XCTAssertFalse(arm.contains("NavigationStack"), "no second stack for a section that is never shown")

        let main = code(try appSource("Views/MainView.swift"))
        let sidebar = try slice(main, from: "private var selection: Binding<SidebarSelection?> {",
                                to: "case .section(let s):")
        let guardRange = try XCTUnwrap(sidebar.range(of: "#if os(iOS)"), "the sidebar's interception is iOS-only")
        let present = try XCTUnwrap(sidebar.range(of: "case .section(.settings):\n                    model.settingsPresented = true"),
                                    "choosing Settings in the iPad sidebar raises the sheet")
        XCTAssertLessThan(guardRange.lowerBound, present.lowerBound)
        let content = try slice(main, from: "struct SectionContent: View {", to: "struct SectionDetail: View {")
        let contentArm = try slice(content, from: "case .settings:", to: "case .admin:")
        XCTAssertTrue(contentArm.contains("EmptyView()") && contentArm.contains("SettingsView()"),
                      "the iPad column is empty; macOS keeps the whole form in it")
    }

    /// A link or a notification goes somewhere the sheet would cover — and while it is up a push
    /// lands on Settings' stack, not the route's — so the sheet goes down before anything moves.
    func testARouteClosesSettingsBeforeItMoves() throws {
        let app = code(try appSource("AppModel.swift"))
        let route = try slice(app, from: "func route(to route: Route) {", to: "switch route {")
        let close = try XCTUnwrap(route.range(of: "settingsPresented = false"))
        let move = try XCTUnwrap(route.range(of: "selectedSection = AppSection.forRoute(route)"))
        XCTAssertLessThan(close.lowerBound, move.lowerBound)
    }

    /// The sheet moves a `NavigationStack` whose path IS Settings' stack in `NavState`, and registers
    /// every frame that stack carries on its root — the runners list and a runner's record, the
    /// `SettingsPage`s, and an account's record under Admin.
    func testTheSheetsStackIsSettingsOwnStack() throws {
        let sheet = code(try slice(try appSource("Views/SettingsSheet.swift"),
                                   from: "struct SettingsSheet: View {", to: "/// The page a `SettingsPage` frame names."))
        XCTAssertTrue(sheet.contains("NavigationStack(path: $model.nav.settingsPath)"),
                      "the stack SwiftUI moves is the one NavState keeps for Settings")
        XCTAssertFalse(sheet.contains("navigationDestination(isPresented:"), "no boolean push")
        let destinations = try slice(sheet, from: ".navigationDestination(for: NavNode.self)",
                                     to: "default:                          EmptyView()")
        for frame in ["case .settingsRunners:            RunnersSettingsList()",
                      "case .runnerDetail(let runnerID): RunnerDetailView(runnerID: runnerID)",
                      "case .settingsPage(let page):     SettingsPageView(page: page)",
                      "case .userDetail(let userID):     AdminUserDetailView(userID: userID)"] {
            XCTAssertTrue(destinations.contains(frame), "the sheet renders \(frame)")
        }
    }

    /// Every page the list can open has a view. Adding a `SettingsPage` without one would push a
    /// frame onto a blank screen, and nothing but this would say so.
    func testEveryPageHasItsView() throws {
        let pages = code(try slice(try appSource("Views/SettingsSheet.swift"),
                                   from: "private struct SettingsPageView: View {", to: "// MARK: - The list"))
        for page in SettingsPage.allCases {
            XCTAssertTrue(pages.contains("case .\(page.rawValue):"), "no view for .\(page.rawValue)")
        }
        XCTAssertTrue(pages.contains("AdminUsersView(rowNavigation: .push)"),
                      "Admin is the same list its section shows, pushing onto the stack on screen")
    }

    /// The list draws `SettingsHome` — its groups, in order, and each group's rows — and has a
    /// drawing for every row there is.
    func testTheListDrawsSettingsHome() throws {
        let list = code(try slice(try appSource("Views/SettingsSheet.swift"),
                                  from: "struct SettingsHomeView: View {", to: "private struct SettingsRowLabel: View {"))
        XCTAssertTrue(list.contains("ForEach(SettingsHome.Group.allCases, id: \\.self)"))
        XCTAssertTrue(list.contains("SettingsHome.rows(group, isAdmin: isAdmin)"))
        XCTAssertTrue(list.contains("SettingsHeader(SettingsHome.header(group))"))
        let rows = try slice(list, from: "@ViewBuilder private func row(_ row: SettingsHome.Row) -> some View {",
                             to: "private var runnersValue: String? {")
        for row in SettingsHome.Row.allCases {
            XCTAssertTrue(rows.contains(".\(row.rawValue)"), "the list has no drawing for .\(row.rawValue)")
        }
        // A form row that opens a page is a link, and draws the platform's arrow — the settings
        // shape, where every row that goes somewhere says so.
        XCTAssertTrue(rows.contains("NavigationLink(value: NavNode.settingsRunners)"))
        XCTAssertTrue(rows.contains("NavigationLink(value: NavNode.settingsPage(page))"))
        // Session orchestration is one switch for the whole account, so its row is the switch, and
        // it is written the moment it flips.
        XCTAssertTrue(rows.contains("Toggle(isOn: $orchestration) { label }"))
        XCTAssertTrue(list.contains("UpdatePreferencesRequest(enableOrchestration: value)"))
        // Signing out asks first.
        XCTAssertTrue(list.contains("Button(role: .destructive) { confirmingSignOut = true }"))
        XCTAssertTrue(list.contains("Button(SettingsCopy.signOut, role: .destructive) { model.logout() }"))
    }

    /// The runners list the sheet pushes carries the same `runnerDetail` frame the Runners section's
    /// rows do, pushed by hand through `AppModel.push` — which lands on Settings' stack while the
    /// sheet is up. One frame type, two stacks: the stack on screen is what decides where it lands.
    func testTheRunnersListInsideSettingsPushesTheSameFrameTheRunnersSectionDoes() throws {
        let runners = try appSource("Views/SkillsRunnersView.swift")
        let settingsList = code(try slice(runners, from: "struct RunnersSettingsList: View {",
                                          to: "/// How a `RunnersModel` list shows its load outcome"))
        XCTAssertTrue(settingsList.contains("Button { model.push(.runnerDetail(runnerID: r.id)) } label: {"),
                      "the row carries its destination and pushes it by hand, like the Runners section's")
        XCTAssertFalse(settingsList.contains("NavigationLink"),
                       "and is not a link — a disclosure indicator here would be the odd one out "
                       + "against the section's identical list")

        let shell = code(try slice(try appSource("Views/CompactShell.swift"), from: "case .runners:",
                                   to: "// FOLLOWING"))
        XCTAssertTrue(shell.contains("case .runnerDetail(let runnerID): RunnerDetailView(runnerID: runnerID)"),
                      "the Runners section renders that same frame — the reuse is the frame type")
    }

    /// macOS keeps its one grouped form — in the Settings window and the main window's column — and
    /// nothing on iOS reaches it any more.
    func testMacOSKeepsTheWholeForm() throws {
        let form = code(try slice(try appSource("Views/SettingsAdminView.swift"),
                                  from: "#if os(macOS)\n/// macOS Settings", to: "// MARK: - Admin"))
        for section in ["Account", "Preferences", "Session orchestration", "Change password", "Updates"] {
            XCTAssertTrue(form.contains("Section(\"\(section)\")"), "the form lost its \(section) section")
        }
        XCTAssertTrue(form.contains("#endif"), "and the whole of it is macOS's")
        XCTAssertFalse(form.contains("var category:"), "no categories: nothing splits the form now")
    }

    /// The regular-width iPad's category columns went with the section: Settings is the same sheet
    /// there, so nothing may still name them.
    func testNothingNamesTheRetiredColumns() throws {
        for file in try appSources() {
            let text = code(file.text)
            for retired in ["SettingsCategoryList", "SettingsDetail()", "settingsCategory", "SettingsCategory"] {
                XCTAssertFalse(text.contains(retired), "\(file.path) still names \(retired)")
            }
        }
    }

    /// What the acceptance for the stack step greps for: the flag is gone from the whole app, not
    /// just from the two files that used to name it — and Settings' root is still an empty stack.
    func testTheSettingsPushHasNoFlagLeftAnywhereInTheApp() throws {
        for file in try appSources() {
            XCTAssertFalse(file.text.contains("settingsShowingRunners"),
                           "\(file.path) still names the flag Settings' stack replaced")
        }

        let app = try appSource("AppModel.swift")
        let root = code(try slice(app, from: "var sectionAtRoot: Bool {", to: "/// ⌘D: complete the open"))
        XCTAssertTrue(root.contains("case .skills, .runners, .following, .admin, .settings: return nav.sectionAtRoot"),
                      "at root is an empty stack for Settings too")
        XCTAssertFalse(root.contains("case .settings:"),
                       "Settings no longer answers from a flag of its own")
    }
}
