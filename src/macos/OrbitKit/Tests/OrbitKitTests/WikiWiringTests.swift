import Foundation
import XCTest
@testable import OrbitKit

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shell. These hold the Wiki's
/// wiring to the source instead: the drawer's Wiki row and its amber number, the section's stack on
/// every shell — the phone's, and the wide shells' directory column and detail pane — the home page
/// drawing `WikiLogic.HomeBand` in order, the model's reads side by side without `async let`, the entry
/// page's inset-grouped sections and its actions, Review's answers stacked through `ApprovalActions`
/// with Accept on top, the `wiki.changed` route, and the `orbit-wiki:` card. Each check reads the slice
/// of the file it is about, so a match somewhere else can't pass it.
final class WikiWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "OrbitApp/Sources/OrbitApp/\(path) wasn't found above this test. If it moved, point this check "
                + "at its new home — don't delete the check."
        }
    }

    /// Found by walking up from this file; never a skip, so the check can't go quiet when a file moves.
    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("src/macos/OrbitApp/Sources/OrbitApp")
                .appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
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

    private func assertOrder(_ text: String, _ literals: [String], _ what: String, line: UInt = #line) {
        let positions = literals.map { text.range(of: $0)?.lowerBound }
        XCTAssertFalse(positions.contains(nil),
                       "\(what): missing \(literals.filter { text.range(of: $0) == nil })", line: line)
        let found = positions.compactMap { $0 }
        XCTAssertEqual(found, found.sorted(), "\(what) is no longer in the order \(literals)", line: line)
    }

    // MARK: the drawer

    /// The rail's work rows lead with Projects, Tasks and the Wiki, and the Wiki gets its own row.
    func testTheDrawerDrawsAWikiRowAfterTasks() throws {
        let shell = code(try source("Views/CompactShell.swift"))
        let rail = try slice(shell, from: "ForEach(AppSection.workSections) { section in", to: "workspacesHeader")
        XCTAssertTrue(rail.contains("} else if section == .wiki {\n                        if model.wiki?.shown == true { wikiRow }"),
                      "the Wiki's section is drawn by its own row, and only for an account that has the wiki")
        XCTAssertTrue(shell.contains(".task { await model.wiki?.loadSpaces() }"),
                      "the drawer reads the spaces that its number counts")
    }

    /// The wiki off for this account (404 WIKI_DISABLED on the spaces read) is an answer the model
    /// keeps, not a failure: the drawer — the iPad sidebar is the same rail — draws no Wiki row, and
    /// the section, reached by a link or kept from before, says the web's sentence instead of offering
    /// a retry.
    func testTheWikiOffForThisAccountDrawsNoRowAndSaysWhy() throws {
        let model = code(try source("WikiModel.swift"))
        XCTAssertTrue(model.contains("var shown: Bool { WikiLogic.shown(spacesState, disabled: disabled) }"))
        let spaces = try slice(model, from: "func loadSpaces() async {", to: "func loadHome() async {")
        assertOrder(spaces, ["let list = try await api.wikiSpaces()", "disabled = false", "spacesState.succeed()",
                             "} catch let error where WikiLogic.isDisabled(error) {", "} catch {", "spacesState.fail()"],
                    "the spaces read")
        let answer = try slice(spaces, from: "} catch let error where WikiLogic.isDisabled(error) {", to: "} catch {")
        XCTAssertTrue(answer.contains("disabled = true"))
        XCTAssertTrue(answer.contains("spacesState.succeed()"), "WIKI_DISABLED is an answer, not a failure to retry")
        let entry = try slice(model, from: "func loadEntry(_ id: String) async {", to: "private func articlesSpace()")
        assertOrder(entry, ["} catch let error where WikiLogic.isDisabled(error) {", "disabled = true",
                            "} catch APIError.http(let status, _) where status == 404 {"], "an entry's read")

        let screens = code(try source("Views/WikiScreens.swift"))
        let placeholder = try slice(screens, from: "struct WikiHomePlaceholder: View {",
                                    to: "struct WikiDetailPane: View {")
        assertOrder(placeholder, ["if wiki.disabled {", "WikiDisabledNote()", "} else if state.lastLoadFailed {"],
                    "the home's placeholder")
        let note = try slice(screens, from: "struct WikiDisabledNote: View {", to: "struct WikiContentsScreen: View {")
        XCTAssertTrue(note.contains("description: Text(WikiCopy.disabledNote)"))
        let pane = try slice(screens, from: "struct WikiDetailPane: View {", to: "struct WikiDisabledNote: View {")
        XCTAssertTrue(pane.contains("} else if model.wiki?.disabled == true {\n            WikiDisabledNote()"))
        let entryPage = try slice(screens, from: "struct WikiEntryView: View {", to: ".task { await wiki.loadEntry(entryID) }")
        assertOrder(entryPage, ["if wiki.disabled {", "WikiDisabledNote()", "} else if let detail = wiki.detail(entryID) {"],
                    "an entry's page")
    }

    /// The home's reads side by side through task handles — never `async let`, whose teardown iOS 27 can
    /// abort on (d22b276cc) — the principles by their own kind rather than picked out of the newest 200
    /// entries of every kind, and the plan's read beside them; Activity's five reads the same way, its
    /// decisions by kind; and not one `async let` left anywhere in the model.
    func testTheReadsGoSideBySideWithoutAsyncLet() throws {
        let model = code(try source("WikiModel.swift"))
        XCTAssertFalse(model.contains("async let"), "no sibling async let in the Wiki's model (d22b276cc)")
        let home = try slice(model, from: "func loadHome() async {", to: "func loadActivity() async {")
        for read in ["let spacesRead = Task { await loadSpaces() }",
                     "try await api.wikiEntries(spaceID: space.id, kind: .principle, limit: WikiLogic.principlesRead)",
                     "let docsRead = Task { try await api.wikiDocs(spaceID: space.id) }",
                     "let articlesRead = Task { try await api.wikiArticleDirectory(spaceID: space.id) }"] {
            XCTAssertTrue(home.contains(read), "the home no longer reads \(read)")
        }
        let homeCancels = try slice(home, from: "defer {", to: "}")
        for handle in ["spacesRead", "principlesRead", "docsRead", "articlesRead"] {
            XCTAssertTrue(homeCancels.contains("\(handle).cancel()"), "the home's \(handle) is not cancelled on the way out")
        }
        assertOrder(home, ["if articlesSpaceID == space.id {", "homeSpaceID = space.id", "} catch {", "await spacesRead.value"],
                    "the content stored, then the head's numbers awaited, never cut short")
        let activity = try slice(model, from: "func loadActivity() async {", to: "func loadReview() async {")
        for read in ["let documentRead = Task { try await api.wikiSpace(space.id) }",
                     "let entriesRead = Task { try await api.wikiEntries(spaceID: space.id) }",
                     "try await api.wikiEntries(spaceID: space.id, kind: .decision, limit: WikiHomeContent.recentDecisionCount)",
                     "let timelineRead = Task { try await api.wikiTimeline(spaceID: space.id) }",
                     "let healthRead = Task { try await api.wikiHealth(spaceID: space.id) }"] {
            XCTAssertTrue(activity.contains(read), "Activity no longer reads \(read)")
        }
        let activityCancels = try slice(activity, from: "defer {", to: "}")
        for handle in ["documentRead", "entriesRead", "decisionsRead", "timelineRead", "healthRead"] {
            XCTAssertTrue(activityCancels.contains("\(handle).cancel()"), "Activity's \(handle) is not cancelled on the way out")
        }
        XCTAssertFalse(activity.contains("kind: .principle"), "the principles are the home's, not Activity's")
        let plan = try slice(model, from: "func loadPlan() async {", to: "func loadOtherPlans() async {")
        assertOrder(plan, ["let versionsRead = Task { try await api.wikiPlanVersions(spaceID: space.id) }",
                           "defer { versionsRead.cancel() }", "try? await versionsRead.value"], "the plan's versions beside it")
        // The home screen reads the plan beside the home, the same way.
        let screens = code(try source("Views/WikiScreens.swift"))
        let load = try slice(screens, from: "private func load(_ wiki: WikiModel) async {", to: "private func go(")
        assertOrder(load, ["let planRead = Task { await wiki.loadPlan() }", "defer { planRead.cancel() }",
                           "await wiki.loadHome()", "await planRead.value"], "the home's reads and the plan's")
        XCTAssertFalse(screens.contains("async let"), "no sibling async let in OrbitApp (d22b276cc)")
    }

    /// The amber number is written and said the way the Projects row writes and says its own — the same
    /// font, colour and guard, and "3 waiting on you" — and counts what the web sidebar counts: what waits
    /// on the owner across every space (`WikiSpaceLogic.waiting`).
    func testTheWikiRowsAmberNumberIsWrittenLikeTheProjectsRows() throws {
        let shell = code(try source("Views/CompactShell.swift"))
        let projects = try slice(shell, from: "private var projectsRow: some View {", to: ".drawerRow()")
        let wiki = try slice(shell, from: "private var wikiRow: some View {", to: ".drawerRow()")
        for shared in ["if waiting > 0 {", "Text(\"\\(waiting)\")", ".font(.orbitMeta.weight(.semibold))",
                       ".foregroundStyle(.orange)", "pill(selected: selected)", "HStack(spacing: 12)",
                       ".frame(width: 24)"] {
            XCTAssertTrue(projects.contains(shared), "the Projects row no longer writes \(shared)")
            XCTAssertTrue(wiki.contains(shared), "the Wiki row doesn't write \(shared) as the Projects row does")
        }
        XCTAssertTrue(wiki.contains("let waiting = model.wiki?.waiting ?? 0"))
        XCTAssertTrue(wiki.contains(".accessibilityLabel(WikiCopy.waitingOnYou(waiting))"))
        XCTAssertTrue(projects.contains(".accessibilityLabel(\"\\(waiting) waiting on you\")"),
                      "the Projects row says its own number in the words the Wiki row's are")
        XCTAssertEqual(WikiCopy.waitingOnYou(3), "3 waiting on you")
        XCTAssertTrue(wiki.contains("Image(systemName: AppSection.wiki.systemImage)"))
        XCTAssertTrue(wiki.contains("Text(AppSection.wiki.title)"))
        // A press is the Projects row's own: the section's destination (its root, unless it is the
        // one showing), and the drawer closes.
        XCTAssertTrue(projects.contains("open(.section(.projects))"))
        XCTAssertTrue(wiki.contains("open(.section(.wiki))"), "the row's press")
        let model = code(try source("WikiModel.swift"))
        XCTAssertTrue(model.contains("var waiting: Int { WikiSpaceLogic.waiting(spaces) }"))
        XCTAssertFalse(model.contains("proposalsToReview"), "the drawer no longer counts the proposals alone")
    }

    // MARK: the section

    /// The phone's Wiki stack: the home, then an entry or Review — pushed, never presented beside it.
    func testThePhonesWikiStack() throws {
        let shell = code(try source("Views/CompactShell.swift"))
        let stack = try slice(shell, from: "case .wiki:\n            NavigationStack(path: $model.nav.path) {",
                              to: "default:                      EmptyView()")
        XCTAssertTrue(stack.contains("WikiHomeView(rowNavigation: .push)"))
        XCTAssertTrue(stack.contains(".drawerToggle(open: openDrawer)"))
        XCTAssertTrue(stack.contains("case .wikiEntry(let entryID): WikiEntryView(entryID: entryID)"))
        XCTAssertTrue(stack.contains("case .wikiReview:             WikiReviewView()"))
        XCTAssertTrue(stack.contains("case .wikiActivity:           WikiActivityView()"))
        // An `orbit-wiki:` link in a phone's conversation pushes the entry over it.
        let agents = try slice(shell, from: "case .console(let sessionID, _):", to: "default:                         EmptyView()")
        XCTAssertTrue(agents.contains("case .wikiEntry(let entryID):       WikiEntryView(entryID: entryID)"))
    }

    /// The three-column shells (design §12.3, mock 32): the directory in the list column — the Contents
    /// sheet's rows, the row of the page on show lit — and in the detail pane whichever page is on top, the
    /// space's home when nothing is: no empty "pick something" pane.
    func testTheWideShellsRouteTheWiki() throws {
        let main = code(try source("Views/MainView.swift"))
        let content = try slice(main, from: "struct SectionContent: View {", to: "struct SectionDetail: View {")
        XCTAssertTrue(content.contains("case .wiki:\n            WikiContentsColumn()"))
        let detail = try slice(main, from: "struct SectionDetail: View {", to: "struct ComingSoon: View {")
        XCTAssertTrue(detail.contains("case .wiki:\n            WikiDetailPane()"))
        let pane = code(try slice(try source("Views/WikiScreens.swift"),
                                  from: "struct WikiDetailPane: View {", to: "// MARK: - one entry"))
        assertOrder(pane, ["model.selectedWikiEntryID", "WikiEntryView(entryID: id)", "model.nav.wikiReviewOnTop",
                           "WikiReviewView()", "model.nav.wikiActivityOnTop", "WikiActivityView()",
                           "model.nav.wikiSettingsOnTop", "WikiSettingsView()",
                           "} else if model.wiki?.disabled == true {", "} else {\n            WikiHomeView(rowNavigation: .selection)"],
                    "the detail pane")
        let own = try slice(pane, from: "struct WikiDetailPane: View {", to: "struct WikiDisabledNote: View {")
        XCTAssertFalse(own.contains("ContentUnavailableView"), "the detail pane's default is the home, not an empty state")
        let column = code(try source("Views/WikiContentsColumn.swift"))
        assertOrder(column, ["WikiContentsRows(groups:", "at: model.nav.wikiContentsAt, docGroups: docGroups,",
                             "WikiPlanLogic.pending($0, runnerOnline: model.wikiMaintenanceRunnerOnline)", "pick: select)"],
                    "the directory column's rows")
        let select = try slice(column, from: "private func select(_ pick: WikiContentsPick) {", to: "private func open(")
        assertOrder(select, ["case .home:                         model.nav.popToRoot()",
                             "case .browse:                       open(.wikiBrowse)",
                             "case .index:                        open(.wikiIndex)",
                             "case .plan:                         open(.wikiPlan(version: nil))",
                             "case .article(let topic, let part): open(.wikiArticle(topic: topic, part: part))",
                             "case .doc(let slug, let section):   open(.wikiDoc(slug: slug, section: section))"],
                    "a row's page, into the detail pane")
        let open = try slice(column, from: "private func open(_ node: NavNode) {", to: "\n    }")
        assertOrder(open, ["model.nav.popToRoot()", "model.push(node)"], "in place of whatever was there")
        assertOrder(column, ["WikiSpacePicker(space: space, spaces: wiki.spaces,", "model.nav.popToRoot()",
                             "wiki.selectedSlug = slug", "manage: { open(.wikiSettings) }"], "the column's space")
        // The sheet and the column draw the same rows.
        let article = code(try source("Views/WikiArticleView.swift"))
        let sheet = try slice(article, from: "struct WikiContentsSheet: View {", to: "struct WikiContentsRows: View {")
        XCTAssertTrue(sheet.contains("WikiContentsRows(groups: groups, at: at, docGroups: docGroups, planPending: planPending, pick: choose)"))
        let app = code(try source("AppModel.swift"))
        let projection = try slice(app, from: "var selectedWikiEntryID: String? {", to: "var taskListsDirectoryPresented")
        XCTAssertTrue(projection.contains("get { nav.selectedWikiEntryID }"), "a read of the stack, not a copy")
        XCTAssertTrue(app.contains("case .wiki: return nav.sectionAtRoot"))
    }

    // MARK: the home page

    /// The home page draws `WikiLogic.HomeBand` in its own order (design §12.3.1, mocks 30 ③, 31 ① ③ ⑥ ⑦):
    /// under the head — the large title with the space beside it — the line and the search on the page's
    /// background, then the principles when there are any, the documents as grouped cards in the plan page's
    /// own rows, a category's unwritten documents folded into one row, Browse · A–Z at the foot; grey bars
    /// (`.redacted`) while the first read is out; and nothing of how the wiki is kept.
    func testTheHomePageDrawsTheBandsInOrder() throws {
        let page = code(try slice(try source("Views/WikiView.swift"),
                                  from: "struct WikiHomePage: View {", to: "struct WikiSpacePicker: View {"))
        assertOrder(page, ["ForEach(WikiLogic.HomeBand.allCases.filter { Self.underHead.contains($0) }, id: \\.self) { band in",
                           "ForEach(WikiLogic.HomeBand.allCases.filter { !Self.underHead.contains($0) }, id: \\.self) { band in"],
                    "the head's bands, then the home's")
        XCTAssertTrue(page.contains("private static let underHead: Set<WikiLogic.HomeBand> = [.state, .search]"))
        let bands = try slice(page, from: "private func band(_ band: WikiLogic.HomeBand) -> some View {",
                              to: "private var stateLine: some View {")
        assertOrder(bands, ["case .state:", "case .search:", "case .principles:", "case .documents:", "case .more:"],
                    "the bands' arms")
        XCTAssertTrue(bands.contains("if !principles.isEmpty { principlesBand }"), "no principle, no band")
        XCTAssertTrue(bands.contains("if documents.listed && !besideContents { more }"))
        for gone in ["reviewBanner", "recentDecisions", "recentlyChanged", "agentsUsed", "statusParts", "noPrinciples"] {
            XCTAssertFalse(page.contains(gone), "the home draws \(gone) again: that is Activity's")
        }
        let header = try slice(page, from: "private var header: some View {", to: "private func band(_ band: WikiLogic.HomeBand) -> some View {")
        assertOrder(header, ["Text(WikiCopy.title)", ".font(.largeTitle.bold())",
                             "WikiSpacePicker(space: space, spaces: spaces, pick: actions.pickSpace, manage: actions.openSettings)"],
                    "the header")
        XCTAssertTrue(page.contains("TextField(WikiCopy.searchPlaceholder, text: $query)"))
        XCTAssertTrue(page.contains(".redacted(reason: .placeholder)"), "grey bars while the first read is out")
        // The documents: a category a section, in the plan page's own rows, the rest folded.
        let category = try slice(page, from: "private func category(_ category: WikiDocLogic.HomeCategory) -> some View {",
                                 to: "private func topics(")
        assertOrder(category, ["ForEach(category.written) { doc in",
                               "WikiDocRow(mark: .number(doc.number), title: doc.title, line: doc.lead, lead: true, fresh: doc.fresh)",
                               "if let folded = WikiDocLogic.notWrittenRow(category) {", "WikiDocFoldedRow(text: folded, open: open)",
                               "ForEach(category.notWritten) { doc in", "line: WikiDocCopy.notWrittenShort, muted: true"],
                    "a category")
        let principles = try slice(page, from: "private var principlesBand: some View {", to: "private var documentsBand: some View {")
        assertOrder(principles, ["allPrinciples ? principles : Array(principles.prefix(WikiLogic.principlesShown))",
                                 "WikiDocRow(mark: .pin, title: entry.displayTitle,", "end: WikiLogic.shortDay(entry.validFrom) ?? \"\"",
                                 "Text(WikiCopy.principles)", "WikiBadge(text: WikiCopy.trustLabel(.owner), tone: .owner)",
                                 "WikiCopy.allPrinciples(principles.count)"], "the principles")
        let documents = try slice(page, from: "private var documentsBand: some View {", to: "private func category(")
        assertOrder(documents, ["case .loading:", "if failed { failure } else { skeleton }", "case .categories(let categories):",
                                "case .topics(let groups):", "case .newSpace:", "Text(WikiDocCopy.noDocumentsNote)",
                                "Button(WikiPlanCopy.setUp, action: actions.openSettings)", "case .nothing:"], "the documents band")
        let style = try slice(code(try source("Views/WikiView.swift")), from: "@ViewBuilder func wikiHomeListStyle() -> some View {", to: "#else")
        XCTAssertTrue(style.contains("self.listStyle(.insetGrouped)"), "grouped cards on iOS (mock 30 ③)")
        // The plan page draws its documents in the same row.
        let plan = code(try source("Views/WikiPlanView.swift"))
        let docRow = try slice(plan, from: "private func docRow(_ doc: WikiPlanLogic.ShownDoc, in shown: WikiPlanLogic.Shown) -> some View {",
                               to: "struct WikiDocRow<Extra: View>: View {")
        XCTAssertTrue(docRow.contains("WikiDocRow(mark: .number(doc.number), title: doc.title, line: doc.question, locked: doc.protected,"))
    }

    /// The bar's buttons in the web head's order — Contents, Activity, Settings — and Activity wearing the
    /// drawer's number in orange, said as "N waiting on you"; on a phone it pushes Activity, on the
    /// three-column shells it opens in the detail pane.
    func testTheHomesBarOpensActivityWithTheDrawersNumber() throws {
        let page = code(try slice(try source("Views/WikiView.swift"),
                                  from: "struct WikiHomePage: View {", to: "struct WikiBandActions {"))
        let toolbar = try slice(page, from: ".toolbar {", to: ".task(id: query) {")
        assertOrder(toolbar, ["Button(action: actions.openContents)", "Image(systemName: \"list.bullet\")",
                              "Button(action: actions.openActivity)", "WikiActivityGlyph(waiting: waiting)",
                              ".accessibilityLabel(WikiCopy.activity)",
                              ".accessibilityValue(waiting > 0 ? WikiCopy.waitingOnYou(waiting) : \"\")",
                              "Button(action: actions.openSettings)", "Image(systemName: \"gearshape\")"],
                    "the home's bar")
        let glyph = code(try slice(try source("Views/WikiView.swift"),
                                   from: "struct WikiActivityGlyph: View {", to: "let wikiMenuIconsDrawAmber"))
        assertOrder(glyph, ["Image(systemName: \"clock.arrow.circlepath\")", "if waiting > 0 {", "Text(\"\\(waiting)\")",
                            ".background(Color.orange, in: Capsule())"], "the Activity badge")
        let contents = try slice(toolbar, from: "if !besideContents {", to: "Button(action: actions.openActivity)")
        XCTAssertTrue(contents.contains("Button(action: actions.openContents)"), "beside the directory column, no Contents")
        let screens = code(try source("Views/WikiScreens.swift"))
        let home = try slice(screens, from: "struct WikiHomeView: View {", to: "struct WikiHomePlaceholder: View {")
        XCTAssertTrue(home.contains("waiting: wiki.waiting,"), "the badge is the drawer's number, from the same model")
        XCTAssertTrue(home.contains("besideContents: rowNavigation == .selection,"), "the detail pane's home has no head")
        XCTAssertTrue(home.contains("openActivity: { open(.wikiActivity) },"))
        XCTAssertTrue(home.contains("case .push:      model.push(node)"))
        XCTAssertTrue(home.contains("case .selection: model.nav.replaceTop(with: node)"))
    }

    /// The space beside the title (§12.3.4): one space is its name, a grey label with no chevron and no menu;
    /// several are a menu of toggles — name, then the repository and documents under it, the amber number in
    /// the icon cell — with Manage spaces at the foot, into Wiki settings.
    func testTheSpaceIsALabelAloneAndAPickerAmongSeveral() throws {
        let picker = code(try slice(try source("Views/WikiView.swift"),
                                    from: "struct WikiSpacePicker: View {", to: "private extension View {"))
        XCTAssertTrue(picker.contains("let names = WikiSpaceLogic.names(spaces)"), "the repository's name, not the slug")
        let alone = try slice(picker, from: "if spaces.count < 2 {", to: "} else {")
        XCTAssertTrue(alone.contains("Text(name)"))
        XCTAssertFalse(alone.contains("Menu"), "one space is a label, not a control")
        XCTAssertFalse(alone.contains("chevron"))
        let menu = try slice(picker, from: "} else {", to: "} label: {")
        assertOrder(menu, ["Menu {", "Toggle(isOn: Binding(get: { row.id == space.id },",
                           "pick(row.slug)", "Text(row.name)",
                           "if wikiMenuIconsDrawAmber, let symbol = row.waitingSymbol { wikiAmberSymbol(symbol) }",
                           "Text(row.subtitle(sayWaiting: !wikiMenuIconsDrawAmber))",
                           "Divider()", "Button(action: manage)",
                           "Label(WikiCopy.manageSpaces, systemImage: \"gearshape\")"], "the space menu")
        let amber = code(try source("Views/WikiView.swift"))
        XCTAssertTrue(amber.contains(".withTintColor(.systemOrange, renderingMode: .alwaysOriginal)"),
                      "the number keeps its amber in a menu row's icon cell")
    }

    /// Activity draws `WikiLogic.ActivityBand` in its order under Review's bar — the title and the space's
    /// name — its banners from `WikiSpaceLogic.activityBanners`, and marks what came after the reader last
    /// looked: the stamp read as the page opens, before it moves it, as the home moves it as it opens.
    func testActivityDrawsItsBandsInOrderAndWhatIsNew() throws {
        let view = code(try source("Views/WikiActivityView.swift"))
        let page = try slice(view, from: "struct WikiActivityPage: View {", to: "private struct WikiActivityBannerRow: View {")
        XCTAssertTrue(page.contains("ForEach(WikiLogic.ActivityBand.allCases, id: \\.self) { band in"))
        let bands = try slice(page, from: "private func band(_ band: WikiLogic.ActivityBand) -> some View {",
                              to: "private var newRows: Int")
        assertOrder(bands, ["case .status:", "case .reviewBanner, .planBanners, .otherPlanBanners:",
                            "ForEach(banners.filter { $0.band == band }) { banner in",
                            "case .recentDecisions:", "case .recentlyChanged:",
                            "WikiCopy.newSinceLastLooked(newRows)", "rows.changeRow(item, new: isNew(item.at))",
                            "rows.runRow(changesetId, origin: origin, at: at, changes: items.count, new: isNew(at))",
                            "case .agentsUsed:"], "Activity's bands")
        XCTAssertFalse(bands.contains("principles"), "Principles are content, not Activity")
        assertOrder(page, [".navigationTitle(WikiCopy.activity)", "ToolbarItem(placement: .principal) { titleBlock }",
                           "Text(WikiCopy.activity).font(.headline)", "Text(spaceName).font(.caption2)"], "Review's bar")
        XCTAssertTrue(page.contains("Text(wikiStatusText(content.statusParts(now: now)))"), "the status line")
        let screen = try slice(view, from: "struct WikiActivityView: View {", to: "private func name(of space:")
        assertOrder(screen, [".task(id: wiki.currentSpace?.slug) {", "seen = wiki.seenBefore(slug)", "wiki.moveSeen(slug)",
                             "await wiki.loadOtherPlans()"], "the stamp, read before it moves")
        XCTAssertTrue(view.contains("WikiSpaceLogic.activityBanners(spaces: wiki.spaces, current: space, plans: plans,"))
        XCTAssertTrue(view.contains("case .review:\n            model.push(.wikiReview)"), "the first banner opens Review")
        XCTAssertFalse(view.contains("async let"), "no sibling async let in OrbitApp (d22b276cc)")
        let screens = code(try source("Views/WikiScreens.swift"))
        let home = try slice(screens, from: "struct WikiHomeView: View {", to: "struct WikiHomePlaceholder: View {")
        assertOrder(home, [".task(id: wiki.currentSpace?.slug) {", "seen = wiki.seen(slug)", "wiki.moveSeen(slug)",
                           "await load(wiki)"], "the home reads the stamp, then moves it, as it opens")
        let model = code(try source("WikiModel.swift"))
        let seen = try slice(model, from: "func seenBefore(_ slug: String) -> Double {", to: "func loadSpaces() async {")
        assertOrder(seen, ["WikiSeenLog.key(space: slug)", "seenLog.seenBefore(key, stored: UserDefaults.standard.double(forKey: key))",
                           "func moveSeen(_ slug: String, at date: Date = Date()) {",
                           "seenLog.move(key, at: now, stored: UserDefaults.standard.double(forKey: key))",
                           "UserDefaults.standard.set(now, forKey: key)"], "the stamp in UserDefaults")
        let others = try slice(model, from: "func loadOtherPlans() async {", to: "func loadPlanVersion(")
        XCTAssertFalse(others.contains("async let"), "the other spaces' plans read side by side without async let")
        XCTAssertTrue(others.contains("$0.id != current && ($0.planWaiting ?? 0) > 0"))
    }

    /// Coming into the Wiki from another section opens the space bound to the workspace the reader was in,
    /// else the last one looked at (`orbit.wiki.space`), else the most written — chosen once the spaces are in.
    func testComingIntoTheWikiChoosesItsSpace() throws {
        let app = code(try source("AppModel.swift"))
        let setter = try slice(app, from: "var selectedSection: AppSection {", to: "tasks?.setSectionActive")
        assertOrder(setter, ["if newValue == .wiki && nav.section != .wiki { wiki?.open(fromWorkspace: workspaceInView) }",
                             "nav.section = newValue"], "where the reader came from, read before the switch")
        let inView = try slice(app, from: "private var workspaceInView: String? {", to: "private func coordinatorWorkspaceID(")
        XCTAssertTrue(inView.contains("WikiSpaceLogic.workspaceInView(nav, agentID: selectedAgentID,"))
        let coordinator = try slice(app, from: "private func coordinatorWorkspaceID(ofProject projectID: String) -> String? {",
                                    to: "var atDestinationRoot: Bool")
        assertOrder(coordinator, ["projects?.detail(projectID).document?.coordinatorWorkspaceId",
                                  "$0.projectMembership?.role == .coordinator"], "a project's coordinator workspace")
        let model = code(try source("WikiModel.swift"))
        XCTAssertTrue(model.contains("private static let spaceKey = \"orbit.wiki.space\""))
        let choose = try slice(model, from: "func open(fromWorkspace workspaceID: String?) {", to: "func seenBefore(_ slug: String) -> Double {")
        assertOrder(choose, ["fromWorkspaceID = workspaceID", "choosing = true", "chooseSpace()",
                             "guard choosing, spacesState.hasLoaded else { return }",
                             "WikiSpaceLogic.defaultSpace(spaces, workspaceID: fromWorkspaceID, lastSlug: selectedSlug)",
                             "selectedSlug = space.slug"], "the choice")
        let spaces = try slice(model, from: "func loadSpaces() async {", to: "func loadHome() async {")
        assertOrder(spaces, ["spacesState.succeed()", "chooseSpace()", "} catch let error where WikiLogic.isDisabled(error) {"],
                    "chosen once the spaces read answers")
    }

    /// macOS's source list draws no Wiki row for an account the server has the wiki off for, as the drawer
    /// and the iPad's sidebar draw none — and reads the spaces that say so.
    func testTheMacSidebarDrawsNoWikiRowWithoutTheWiki() throws {
        let main = code(try source("Views/MainView.swift"))
        let sidebar = try slice(main, from: "struct SectionSidebar: View {", to: "struct AccountFooter: View {")
        XCTAssertTrue(sidebar.contains("ForEach(AppSection.visible(isAdmin: isAdmin, wiki: model.wiki?.shown == true)) { section in"))
        XCTAssertTrue(sidebar.contains(".task { await model.wiki?.loadSpaces() }"))
    }

    // MARK: one entry

    /// Inset-grouped, the sections in `WikiLogic.EntrySection` order, and Edit beside a ⋯ menu that
    /// holds Supersede…, Retire… (destructive), then Copy link.
    func testTheEntryPage() throws {
        let view = code(try source("Views/WikiView.swift"))
        let page = code(try slice(try source("Views/WikiView.swift"),
                                  from: "struct WikiEntryPage: View {", to: "// MARK: - Review"))
        XCTAssertTrue(page.contains("ForEach(WikiLogic.EntrySection.allCases, id: \\.self) { section in"))
        XCTAssertTrue(page.contains(".wikiEntryListStyle()"))
        XCTAssertTrue(view.contains("self.listStyle(.insetGrouped)"), "grouped cards on iOS")
        let toolbar = try slice(page, from: ".toolbar {", to: "private var head: some View {")
        assertOrder(toolbar, ["Button(WikiCopy.edit, action: actions.edit)", "Menu {",
                              "Label(WikiCopy.supersede, systemImage:",
                              "Button(role: .destructive, action: actions.retire)",
                              "Label(WikiCopy.retire, systemImage:", "Divider()",
                              "Label(WikiCopy.copyLink, systemImage:", "Image(systemName: \"ellipsis\")"],
                    "the entry's actions")
        let sections = try slice(page, from: "private func section(_ section: WikiLogic.EntrySection) -> some View {",
                                 to: "private func countedHeader")
        assertOrder(sections, ["case .details:", "case .sources:", "case .anchors:", "case .whereUsed:", "case .history:"],
                    "the sections' arms")
        XCTAssertTrue(sections.contains("Text(WikiCopy.anchorsNote)"), "the anchors' footnote")
        // The forms those actions open write through the model, one owner write each.
        let screens = code(try source("Views/WikiScreens.swift"))
        for write in ["await wiki.edit(detail.entry, title: title, summary: summary)",
                      "await wiki.supersede(detail.entry, title: title, summary: summary)",
                      "await wiki.retire(entry, reason: why)"] {
            XCTAssertTrue(screens.contains(write), "the entry page no longer writes \(write)")
        }
    }

    // MARK: Review

    /// One card at a time with its position, and the card's answers through the approval cards' own
    /// stack — `VStack(spacing: 10)` on iOS — Accept first, then Edit, then Reject▾; Retire then Keep.
    func testReviewAnswersThroughApprovalActionsAcceptFirst() throws {
        let approvals = code(try source("Views/ApprovalCards.swift"))
        let stack = try slice(approvals, from: "struct ApprovalActions<Content: View>: View {", to: "#endif")
        XCTAssertTrue(stack.contains("#if os(iOS)\n        VStack(spacing: 10) { content() }"),
                      "ApprovalActions stacks full width on iOS")
        let view = code(try source("Views/WikiView.swift"))
        let card = code(try slice(try source("Views/WikiView.swift"),
                                  from: "struct WikiReviewCard: View {", to: "/// The op's chip and the kind"))
        let answers = try slice(card, from: "ApprovalActions {", to: ".disabled(busy)")
        assertOrder(answers, ["Text(WikiCopy.reviewRetire)", "Text(WikiCopy.keep)",
                              "Text(WikiModeCopy.reconfirm)", "Text(WikiModeCopy.amend)", "Text(WikiModeCopy.retire)",
                              "Text(WikiCopy.accept)", "Text(WikiCopy.reviewEdit)", "Text(WikiCopy.reject)"],
                    "a card's answers — a challenge's between a retirement's and the rest")
        XCTAssertTrue(answers.contains("actions.decide(card, .reject, .notTrue)"), "Keep is a rejection as Not true")
        XCTAssertTrue(answers.contains("Section(WikiCopy.rejectReasonFoot)"))
        XCTAssertTrue(answers.contains("ForEach(WikiRejectReason.allCases, id: \\.self)"))
        XCTAssertEqual(answers.components(separatedBy: ".approvalActionLabel()").count - 1, 8,
                       "every answer spans the card, as the approval cards' do")
        let challenge = try slice(answers, from: "} else if isChallenge {", to: "} else {")
        XCTAssertTrue(challenge.contains("actions.decide(card, .reconfirm, nil)"))
        XCTAssertTrue(challenge.contains("actions.amend(card)"))
        XCTAssertTrue(challenge.contains("actions.decide(card, .retire, nil)"))
        let reconfirm = try slice(challenge, from: "Text(WikiModeCopy.reconfirm)", to: "Text(WikiModeCopy.amend)")
        XCTAssertTrue(reconfirm.contains(".buttonStyle(.borderedProminent)"), "Re-confirm is the one filled answer")
        let accept = try slice(answers, from: "Text(WikiCopy.accept)", to: "Text(WikiCopy.reviewEdit)")
        XCTAssertTrue(accept.contains(".buttonStyle(.borderedProminent)"), "Accept is the one filled answer")
        let page = try slice(view, from: "struct WikiReviewPage: View {", to: "struct WikiReviewCard: View {")
        XCTAssertTrue(page.contains("Text(WikiCopy.ofCount(at + 1, count))"), "1 of N")
        XCTAssertTrue(page.contains(".pickerStyle(.segmented)"))
        XCTAssertTrue(page.contains("WikiLogic.clampedIndex(index, count: visible.count)"))
        let screens = code(try source("Views/WikiScreens.swift"))
        XCTAssertTrue(screens.contains("await wiki.decide(card, action, reason: reason)"))
    }

    /// A decide's answer is read, not dropped. The server answers 200 for an op it could not apply too —
    /// recorded `conflict` (the entry moved past it, or is no longer active) or `withdrawn` — and that
    /// comes back as the refusal: the card is not put in `answered`, the queue is read again, and the
    /// caller says it where it says any refusal, never "Accepted" (`WikiDecisionRefusalTests`).
    func testADecideReadsWhatTheServerRecorded() throws {
        let model = code(try source("WikiModel.swift"))
        let decide = try slice(model, from: "func decide(_ card: WikiLogic.ReviewCard,", to: "func loadEntriesNamed(")
        XCTAssertFalse(decide.contains("_ = try await api.decideWikiChangeset("), "a decide drops the server's answer")
        XCTAssertTrue(decide.contains("answer = try await api.decideWikiChangeset("))
        let refused = try slice(decide, from: "if let refusal = WikiLogic.decisionRefusal(", to: "answered.insert(card.op.id)")
        assertOrder(refused, ["WikiLogic.recordedDecision(answer, opID: card.op.id)", "op: card.op.op, action: action)",
                              "await reloadAfterWrite()", "return refusal", "answered.insert(card.op.id)"],
                    "a refusal the server recorded, ahead of the card leaving the queue")
    }

    /// Edit's form and a challenge's Amend form keep a refusal in the form, beside the words it is about —
    /// one the server recorded as much as one it threw — and float only an answer that landed. The page's
    /// alert is no place for it: the form's sheet is over the page.
    func testReviewsFormsKeepTheirRefusalInTheForm() throws {
        let screens = code(try source("Views/WikiScreens.swift"))
        let view = try slice(screens, from: "struct WikiReviewView: View {", to: "private struct WikiChallengeAmendForm: View {")
        for (sheet, action) in [(".sheet(item: $editing) { card in", ".edit"), (".sheet(item: $amending) { card in", ".amend")] {
            let answer = try slice(view, from: sheet, to: "return answer")
            assertOrder(answer, ["let answer = await wiki.decide(card, \(action), edited: edited)",
                                 "if answer == nil { landed(card, action: \(action), renamed: edited.title) }",
                                 "return answer"], "the \(action) form's answer")
            XCTAssertFalse(answer.contains("finish("), "the \(action) form's refusal goes to the page's alert")
        }
        let amendStart = try XCTUnwrap(screens.range(of: "private struct WikiChallengeAmendForm: View {"))
        let editStart = try XCTUnwrap(screens.range(of: "private struct WikiProposalForm: View {"))
        let forms = ["a challenge's Amend": String(screens[amendStart.lowerBound..<editStart.lowerBound]),
                     "Edit's": String(screens[editStart.lowerBound...])]
        for (name, form) in forms {
            XCTAssertTrue(form.contains("let submit: (WikiEntryChanges) async -> String?"), "\(name) form")
            XCTAssertTrue(form.contains("@State private var refusal: String?"), "\(name) form")
            assertOrder(form, ["if let refusal {", "Text(refusal)", ".foregroundStyle(.red)"], "\(name) form's refusal")
            let submitted = try slice(form, from: "refusal = await submit(", to: "if refusal == nil { dismiss() }")
            XCTAssertTrue(submitted.contains("saving = false"), "\(name) form stays open on a refusal")
        }
    }

    /// Alerts say which write failed, while their message remains the server's reason.
    func testWikiFailureAlertsNameTheActionAndKeepTheReason() throws {
        let settings = code(try source("Views/WikiSettingsView.swift"))
        XCTAssertTrue(settings.contains(".alert(WikiCopy.settingsSaveFailed, isPresented:"))
        XCTAssertTrue(settings.contains("Text(notice ?? \"\")"))

        let run = code(try source("Views/WikiRunView.swift"))
        let revert = try slice(run, from: "if let answer = await wiki.revert(changeset) {", to: "} else {")
        assertOrder(revert, ["noticeTitle = WikiCopy.runRevertFailed", "notice = answer"], "a failed revert")
        let reject = try slice(run, from: "if let answer = await wiki.reject(id, reason: reason) {", to: "} else {")
        assertOrder(reject, ["noticeTitle = WikiCopy.entryRejectFailed", "notice = answer"], "a failed rejection")
        XCTAssertTrue(run.contains(".alert(noticeTitle, isPresented:"))
        XCTAssertTrue(run.contains("Text(notice ?? \"\")"))

        let plan = code(try source("Views/WikiDocScreens.swift"))
        let draft = try slice(plan, from: "private func redraft(", to: "private func confirm(")
        XCTAssertTrue(draft.contains("failure: String = WikiCopy.planDraftFailed"))
        assertOrder(draft, ["noticeTitle = failure", "notice = refusal"], "a failed plan draft")
        XCTAssertTrue(plan.contains("redraft(wiki, words, failure: WikiCopy.planRedraftFailed)"))
        let confirm = try slice(plan, from: "private func confirm(", to: "private func accept(")
        XCTAssertTrue(confirm.contains("noticeTitle = WikiCopy.planConfirmFailed"))
        let accept = try slice(plan, from: "private func accept(", to: "private func reject(")
        XCTAssertTrue(accept.contains("noticeTitle = edit ? WikiCopy.changeEditFailed : WikiCopy.changeAcceptFailed"))
        let changeReject = try slice(plan, from: "private func reject(", to: "private func save(")
        XCTAssertTrue(changeReject.contains("noticeTitle = WikiCopy.changeRejectFailed"))
        XCTAssertTrue(plan.contains(".alert(noticeTitle, isPresented:"))
        XCTAssertTrue(plan.contains("Text(notice ?? \"\")"))

        let screens = code(try source("Views/WikiScreens.swift"))
        let entry = try slice(screens, from: "struct WikiEntryView: View {", to: "private struct WikiEntryForm: View {")
        for title in ["entrySaveFailed", "entrySupersedeFailed", "entryRetireFailed", "entryConfirmFailed", "entryRejectFailed"] {
            XCTAssertTrue(entry.contains("WikiCopy.\(title)"), "the entry's failure lost \(title)")
        }
        XCTAssertTrue(entry.contains(".alert(noticeTitle, isPresented:"))
        assertOrder(entry, ["noticeTitle = failure", "notice = answer"], "an entry's refusal")
        XCTAssertTrue(screens.contains(".alert(WikiCopy.decideFailed, isPresented:"))

        let model = code(try source("WikiModel.swift"))
        let reason = try slice(model, from: "private static func refusal(_ error: Error) -> String {", to: "private func reloadAfterWrite()")
        XCTAssertTrue(reason.contains("return message"), "server words remain the alert's message")
        XCTAssertTrue(reason.contains("return APIClient.failureReason(error)"))
        for file in [settings, run, plan, screens, model] {
            XCTAssertFalse(file.contains("WikiCopy.refused"), "an action still has the generic refusal title")
        }
    }

    // MARK: the event, and the card

    /// `wiki.changed` re-reads the Wiki and nothing else: it has its own arm ahead of the default one
    /// that snapshots the sessions, and the reconnect re-reads the Wiki too.
    func testWikiChangedReReadsTheWikiNotTheSessions() throws {
        let app = code(try source("AppModel.swift"))
        let apply = try slice(app, from: "private func apply(_ ev: ControlEvent) {", to: "private func mergeSessionSummary")
        let arm = try slice(apply, from: "case .wikiChanged:", to: "case .providerChanged:")
        XCTAssertTrue(arm.contains("wiki?.nudge()"))
        XCTAssertFalse(arm.contains("scheduleControlRefresh"), "a wiki event is not a session event")
        let wikiArm = try XCTUnwrap(apply.range(of: "case .wikiChanged:"))
        let defaultArm = try XCTUnwrap(apply.range(of: "default:\n            scheduleControlRefresh()"))
        XCTAssertLessThan(wikiArm.lowerBound, defaultArm.lowerBound)
        let connected = try slice(app, from: "case .connected:", to: "case .event(let ev):")
        XCTAssertTrue(connected.contains("if let wiki { Task { await wiki.reloadLoaded() } }"))
        XCTAssertTrue(app.contains("wiki = WikiModel(baseURL: url, tokenStore: tokenStore)"))
    }

    /// An `orbit-wiki:` card wears the Wiki's book, names the entry's kind beside the type, badges its
    /// trust and marks its anchor; the one door opens the entry's page.
    func testTheWikiLinkCard() throws {
        let view = code(try source("Views/OrbitLinkCardView.swift"))
        XCTAssertTrue(view.contains("case .wiki:    return AppSection.wiki.systemImage"))
        XCTAssertTrue(view.contains("Text(content.typeName)"))
        XCTAssertTrue(view.contains("WikiBadge(text: WikiCopy.trustLabel(trust), tone: WikiLogic.trustTone(trust))"))
        XCTAssertTrue(view.contains("if let mark = line.anchorMark {"))
        let cards = code(try source("OrbitLinkCards.swift"))
        XCTAssertTrue(cards.contains("case .wikiEntry(let id): openWikiEntry(id, overConsole: overConsole)"))
        XCTAssertTrue(cards.contains("wikiSpaceSlug: readings[ref.target.key]?.preview.wiki?.spaceSlug"),
                      "Copy link on a wiki card is the entry's page, which takes its space")
        let app = code(try source("AppModel.swift"))
        let open = try slice(app, from: "func openWikiEntry(_ id: String, overConsole: Bool = false) {", to: "\n    }")
        assertOrder(open, ["if overConsole {", "push(.wikiEntry(entryID: id))", "selectedSection = .wiki",
                           "nav.path = [.wikiEntry(entryID: id)]"], "where a wiki link opens")
    }
}
