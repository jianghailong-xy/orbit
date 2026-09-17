import Foundation
import XCTest
@testable import OrbitKit

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shells. These hold the Settings
/// section to the source it now *is*: **the section's stack in `NavState` is the only copy of how
/// deep Settings is**.
///
/// Settings is the app's deepest stack — the form → the runners list → a runner's record — and it was
/// the last place two push mechanisms were chained on one stack: a boolean
/// `navigationDestination(isPresented:)` for the list, and a destination-closure `NavigationLink` for
/// the record. Every push is a `NavNode` frame now, so the back button, the left screen edge and
/// `sectionAtRoot` all read the one value the shell moves. Each check reads the slice of the file it
/// is about, so a match somewhere else can't pass it.
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

    /// Settings now fills both columns of the split shell, like every other section: its categories
    /// in the middle one, whichever is current in the pane beside it. What stood in that pane before
    /// was `ContentUnavailableView` — a sentence occupying the larger half of the screen to say the
    /// content is in the smaller half, while the whole form crowded into that smaller half.
    func testTheIPadSettingsFillsBothColumns() throws {
        let main = code(try appSource("Views/MainView.swift"))
        let content = try slice(main, from: "struct SectionContent: View {",
                                to: "struct SectionDetail: View {")
        let detail = try slice(main, from: "struct SectionDetail: View {",
                               to: "struct ComingSoon: View {")

        XCTAssertTrue(content.contains("SettingsCategoryList()"),
                      "the middle column lists the categories")
        XCTAssertTrue(detail.contains("SettingsDetail()"),
                      "and the pane beside it renders the current one")
        // Skills keeps the placeholder: it is a browse-only list with nothing to select into, which
        // is what that branch was always for. Splitting it out is the point — the two sections were
        // sharing an arm for different reasons.
        XCTAssertTrue(detail.contains("case .skills:"), "Skills keeps its own arm")
        XCTAssertFalse(detail.contains("case .skills, .settings:"),
                       "Settings no longer shares the single-pane placeholder")
    }

    /// Every shell that wants the whole form still gets it from a no-argument initializer — the
    /// category is an opt-in for the one shell that has a column to put the list in.
    func testTheWholeFormRemainsTheDefault() throws {
        let settings = code(try appSource("Views/SettingsAdminView.swift"))
        XCTAssertTrue(settings.contains("var category: SettingsCategory? = nil"),
                      "whole-form mode is the default, so SettingsView() keeps meaning the form")
        let compact = code(try appSource("Views/CompactShell.swift"))
        XCTAssertTrue(compact.contains("SettingsView().drawerToggle(open: openDrawer)"),
                      "the iPhone drawer still renders the entire form")
    }

    /// The column's rows are labelled with the form's own section headings. Renaming a `Section`
    /// without renaming its category would leave the list naming a heading that no longer exists —
    /// and nothing else would catch it, since the two live in different modules.
    func testEachCategoryNamesASectionTheFormActuallyRenders() throws {
        let settings = code(try appSource("Views/SettingsAdminView.swift"))
        for category in SettingsCategory.allCases {
            XCTAssertTrue(settings.contains("Section(\"\(category.title)\")"),
                          "the form renders no Section(\"\(category.title)\") for .\(category.rawValue)")
        }
    }

    /// The categories gate their sections; whole-form mode must still emit all of them.
    func testEachSectionIsGatedOnItsOwnCategory() throws {
        let settings = code(try appSource("Views/SettingsAdminView.swift"))
        for category in SettingsCategory.allCases {
            XCTAssertTrue(settings.contains("if shows(.\(category.rawValue))"),
                          "Section \(category.title) is not gated on .\(category.rawValue)")
        }
        XCTAssertTrue(settings.contains("category == nil || category == c"),
                      "whole-form mode shows every section")
    }

    /// The compact Settings section moves a `NavigationStack` whose path IS the section's stack, so
    /// both of its pushes — and the pops that come back from them — are writes to the same value the
    /// model reads. A bare `NavigationStack` here kept the depth in a flag beside it.
    func testTheCompactSettingsSectionIsAStackBoundToTheSectionsStack() throws {
        let shell = try appSource("Views/CompactShell.swift")
        let settings = code(try slice(shell, from: "case .settings:", to: "case .admin:"))

        XCTAssertTrue(settings.contains("NavigationStack(path: $model.nav.path)"),
                      "the stack SwiftUI moves is the one NavState keeps for Settings")
        XCTAssertTrue(settings.contains("SettingsView().drawerToggle(open: openDrawer)"),
                      "the form is the section's root, and the only page the section itself owns")
        XCTAssertFalse(settings.contains("navigationDestination(isPresented:"),
                       "no boolean push left on Settings' stack")
        XCTAssertFalse(settings.contains("settingsShowingRunners"),
                       "and nothing outside the stack tracks how deep it is")
    }

    /// The two pages the form pushes, as frames. Both destinations are registered on the form itself
    /// because iPad regular pushes the same two pages from it — the registration has to be part of the
    /// *outer* modifier chain, not of a `Section`, or the push from within the list couldn't resolve.
    func testTheSettingsFormRegistersTheTwoPagesItPushes() throws {
        let view = try appSource("Views/SettingsAdminView.swift")
        let form = try slice(view, from: "struct SettingsView: View {", to: "// MARK: - Admin")
        // Anchored on the modifier chain's own indentation, so the slice only matches a registration
        // applied to the Form — one buried inside a `Section` would neither resolve nor be found here.
        let destinations = code(try slice(form, from: "\n        .navigationDestination(for: NavNode.self)",
                                          to: ".orbitRevealSurface()"))

        let list = try XCTUnwrap(destinations.range(of: "case .settingsRunners:"),
                                 "the runners list is a page of this stack")
        let record = try XCTUnwrap(destinations.range(of: "case .runnerDetail(let runnerID):"),
                                   "and a runner's record is the layer below it")
        XCTAssertTrue(destinations.contains("RunnersSettingsList()"),
                      "the second layer is what Settings' own row pushes")
        XCTAssertTrue(destinations.contains("RunnerDetailView(runnerID: runnerID)"),
                      "the third is the same record page the Runners section pushes")
        XCTAssertLessThan(list.lowerBound, record.lowerBound,
                          "both cases in one switch, in the order the stack pushes them")
        XCTAssertTrue(destinations.contains("EmptyView()"),
                      "another section's frame rides that section's stack, not this one")

        // Applied to the Form, after the form's own content — an outer modifier, not a row.
        let lastRow = try XCTUnwrap(form.range(of: "Section(\"Change password\")"), "the form's last row")
        let registration = try XCTUnwrap(form.range(of: ".navigationDestination(for: NavNode.self)"),
                                         "the form registers the destinations")
        XCTAssertLessThan(lastRow.lowerBound, registration.lowerBound,
                          "the registration is part of the form's modifier chain, not of a Section")
    }

    /// The row that used to open a page with a closure — the last `NavigationLink { }` on a navigation
    /// stack in this app — carries the same `runnerDetail` frame the Runners section's rows do. One
    /// frame type, two stacks: the section you are in is what decides where it lands.
    func testTheRunnersListInsideSettingsPushesTheSameFrameTheRunnersSectionDoes() throws {
        let runners = try appSource("Views/SkillsRunnersView.swift")
        let settingsList = code(try slice(runners, from: "struct RunnersSettingsList: View {",
                                          to: "/// How a `RunnersModel` list shows its load outcome"))
        XCTAssertTrue(settingsList.contains("Button { model.push(.runnerDetail(runnerID: r.id)) } label: {"),
                      "the row carries its destination and pushes it by hand, like the Runners section's")
        XCTAssertFalse(settingsList.contains("NavigationLink"),
                       "and is not a link — a disclosure indicator here would be the odd one out "
                       + "against the section's identical list")
        XCTAssertFalse(settingsList.contains("NavigationLink {"),
                       "a destination closure can only ever be this one page")

        let shell = code(try slice(try appSource("Views/CompactShell.swift"), from: "case .runners:",
                                   to: "// FOLLOWING"))
        XCTAssertTrue(shell.contains("case .runnerDetail(let runnerID): RunnerDetailView(runnerID: runnerID)"),
                      "the Runners section renders that same frame — the reuse is the frame type")
    }

    /// The one row that keeps the platform's disclosure indicator, deliberately. Every *list* row
    /// pushes its frame by hand now (see `AppModel.push`) because that arrow cannot be hidden on
    /// iOS 17/18 — but the `Runners` row of Settings' own form sits directly above the Admin row,
    /// which carries a hand-drawn `chevron.forward` because it switches section rather than
    /// pushing. A pair with one arrow and one without reads worse than two arrows, so this row
    /// stays a `NavigationLink(value:)` and keeps drawing one. Pinned here so a later sweep that
    /// "unifies the spelling" has to argue with it rather than quietly take the arrow away.
    func testTheSettingsFormsOwnRunnersRowKeepsThePlatformArrow() throws {
        let form = code(try slice(try appSource("Views/SettingsAdminView.swift"),
                                  from: "struct SettingsView: View {", to: "// MARK: - Admin"))
        XCTAssertTrue(form.contains("NavigationLink(value: NavNode.settingsRunners)"),
                      "the form's Runners row is the one push left as a link, and its arrow is kept")
        XCTAssertTrue(form.contains("Image(systemName: \"chevron.forward\")"),
                      "beside the section-switching Admin row that draws its own")
    }

    /// What the acceptance for this step greps for: the flag is gone from the whole app, not just from
    /// the two files that used to name it. The form's push and the shell's depth are one stack now, so
    /// there is no second copy left to keep in step — including in the `selectedSection` `didSet`,
    /// which had to register this push by hand.
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
