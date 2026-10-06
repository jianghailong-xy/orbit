import SwiftUI
import OrbitKit
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

// The Wiki's three pages — the home page, one entry, and Review — drawn from what the server said and
// nothing else. Each page takes its reads and a set of actions; where a press goes is decided by the
// screen that mounts it (`WikiScreens.swift`), so a page draws the same in the app, in a three-column
// shell and in a screenshot probe.
//
// The bands, sections and cards are the web phone's, block for block and in its order (mocks 06–09,
// `WikiHome.tsx`, `WikiEntryDrawer.tsx`, `WikiReviewPage.tsx`), and every word is `WikiCopy`'s — which
// `WikiCopyParityTests` looks up in the web source. The order itself is `WikiLogic.HomeBand` and
// `WikiLogic.EntrySection`, which the pages iterate rather than restate.

// MARK: - the home page

/// Where a press on the home page goes.
struct WikiHomeActions {
    var openEntry: (String) -> Void = { _ in }
    var pickSpace: (String) -> Void = { _ in }
    var search: (String) async -> [WikiSearchHit] = { _ in [] }
    /// The space's Wiki settings: the gear in the bar (mock 12 ①), Manage spaces, and a new space's Set up
    /// maintenance (mock 31 ⑥).
    var openSettings: () -> Void = {}
    /// The Contents sheet — the directory — from the list button in the bar (mock 30 ③).
    var openContents: () -> Void = {}
    /// Activity, from the bar's history mark (design §12.3.2).
    var openActivity: () -> Void = {}
    /// A document's page (mock 24), from its row, or from a folded row's titles.
    var openDoc: (String) -> Void = { _ in }
    /// A topic's article, before a plan is confirmed.
    var openArticle: (String) -> Void = { _ in }
    /// Browse by category and the A–Z index, at the foot (mock 31 ①).
    var openBrowse: () -> Void = {}
    var openIndex: () -> Void = {}
    /// The home's first read again, after it failed.
    var retry: () -> Void = {}
}

/// One space's home (design §12.3.1, mocks 30 ③, 31 ① ③ ⑥ ⑦): the large title with the space beside it, the
/// line that says what the space holds, the search, the principles when there are any, then the documents —
/// each category a group of cards on the grouped background, each written document its number, title and two
/// lines of lead, what is not written yet folded into one row — and Browse by category · A–Z index at the
/// foot. Its bands are `WikiLogic.HomeBand`'s, in their order. How the wiki is kept is Activity's, behind the
/// bar's history mark with what waits on the owner on it.
///
/// WHAT IS KNOWN IS DRAWN AT ONCE: the head is the spaces list the drawer has already read; the line and the
/// documents are grey bars (`.redacted`) until the home's own first read is in.
///
/// BESIDE THE DIRECTORY — the iPad's and the Mac's middle column (mock 32) — the page has no head: the title
/// and the space head that column, which also holds Browse and the A–Z index, and the bar needs no Contents.
struct WikiHomePage: View {
    /// The space on screen and every space: the head, from the spaces list.
    let space: WikiSpace
    let spaces: [WikiSpace]
    /// The space's principles, oldest recorded first (`WikiLogic.principles`).
    var principles: [WikiEntry] = []
    /// The line under the head (`WikiLogic.homeLine`): nil, a grey bar, while the first read is out.
    var line: String? = nil
    var documents: WikiLogic.HomeDocuments = .loading
    /// When the reader last looked (`WikiSeenLog`): what the principles' blue dots mark; nil marks none.
    var seen: Double? = nil
    /// The first read failed: said where the documents would be, with Retry.
    var failed = false
    /// What waits on the owner across every space — the drawer's number — on the bar's Activity button.
    var waiting = 0
    /// Drawn beside the directory column: no head, no Contents in the bar, no foot.
    var besideContents = false
    var actions = WikiHomeActions()

    @State private var query = ""
    @State private var hits: [WikiSearchHit] = []
    @State private var searched = ""
    /// The page's own header carries the title; the bar takes it once the header scrolls away, which
    /// is the system's large title collapsing into the bar.
    @State private var headerOnScreen = true
    /// Every principle, past the first three (`All N ›`).
    @State private var allPrinciples = false
    /// The categories whose documents not written yet are listed, their folded row opened.
    @State private var unfolded: Set<String> = []

    private var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

    /// The bands that ride under the head on the page's own background, the way the web's frame draws them
    /// over the home: the line and the search. The rest are the home's cards.
    private static let underHead: Set<WikiLogic.HomeBand> = [.state, .search]

    var body: some View {
        List {
            Section {
                if !besideContents {
                    header
                        .onAppear { headerOnScreen = true }
                        .onDisappear { headerOnScreen = false }
                        .wikiHomeOnBackground()
                }
                ForEach(WikiLogic.HomeBand.allCases.filter { Self.underHead.contains($0) }, id: \.self) { band in
                    self.band(band)
                }
            }
            if searching {
                results
            } else {
                ForEach(WikiLogic.HomeBand.allCases.filter { !Self.underHead.contains($0) }, id: \.self) { band in
                    self.band(band)
                }
            }
        }
        .wikiHomeListStyle()
        .navigationTitle(besideContents || headerOnScreen ? "" : WikiCopy.title)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            // The bar's actions, in the web head's order — Contents, Activity, Settings; icons all
            // (design §12.3.1). Activity wears the drawer's orange number: what waits on the owner. Beside the
            // directory column there is no Contents to open.
            ToolbarItemGroup(placement: .primaryAction) {
                if !besideContents {
                    Button(action: actions.openContents) {
                        Image(systemName: "list.bullet")
                    }
                    .accessibilityLabel(WikiArticleCopy.contents)
                }
                Button(action: actions.openActivity) {
                    WikiActivityGlyph(waiting: waiting)
                }
                .accessibilityLabel(WikiCopy.activity)
                .accessibilityValue(waiting > 0 ? WikiCopy.waitingOnYou(waiting) : "")
                Button(action: actions.openSettings) {
                    Image(systemName: "gearshape")
                }
                .accessibilityLabel(WikiModeCopy.settings)
            }
        }
        .task(id: query) {
            let text = query
            guard !text.trimmingCharacters(in: .whitespaces).isEmpty else {
                hits = []
                searched = ""
                return
            }
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
            let found = await actions.search(text)
            guard !Task.isCancelled else { return }
            hits = found
            searched = text
        }
    }

    // MARK: header

    /// The title and the space on one row — the web's page head.
    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            Text(WikiCopy.title)
                .font(.largeTitle.bold())
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            WikiSpacePicker(space: space, spaces: spaces, pick: actions.pickSpace, manage: actions.openSettings)
        }
        .padding(.top, 4)
    }

    // MARK: the bands

    @ViewBuilder
    private func band(_ band: WikiLogic.HomeBand) -> some View {
        switch band {
        case .state:
            stateLine
                .wikiHomeOnBackground()
        case .search:
            searchField
                .wikiHomeOnBackground()
        case .principles:
            if !principles.isEmpty { principlesBand }
        case .documents:
            documentsBand
        case .more:
            if documents.listed && !besideContents { more }
        }
    }

    /// What the space holds (`35 documents · 5 written`), or a grey bar in its place while the first read is out.
    @ViewBuilder private var stateLine: some View {
        if let line {
            Text(line)
                .font(.orbitSubtext)
                .foregroundStyle(.secondary)
        } else {
            Text(WikiDocCopy.docsWritten(total: 35, written: 5))
                .font(.orbitSubtext)
                .redacted(reason: .placeholder)
                .accessibilityHidden(true)
        }
    }

    /// The search under the title — the web phone's search line, and the owner's call for iOS
    /// (2026-09-25): under the title, never at the bottom of the screen.
    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField(WikiCopy.searchPlaceholder, text: $query)
                .textFieldStyle(.plain)
                .font(.orbitControl)
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                .submitLabel(.search)
                #endif
            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    /// The principles (mock 31 ③): the owner's, the first three a title a row with its day, then `All N ›`.
    private var principlesBand: some View {
        Section {
            ForEach(allPrinciples ? principles : Array(principles.prefix(WikiLogic.principlesShown))) { entry in
                WikiDocRow(mark: .pin, title: entry.displayTitle,
                           fresh: seen.map { WikiSeenLog.isNew(entry.validFrom, seen: $0) } ?? false,
                           end: WikiLogic.shortDay(entry.validFrom) ?? "") {
                    actions.openEntry(entry.id)
                }
            }
        } header: {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(WikiCopy.principles)
                    .font(.orbitSubtext.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text("\(principles.count)")
                    .font(.orbitSubtext.monospacedDigit())
                    .foregroundStyle(.secondary)
                WikiBadge(text: WikiCopy.trustLabel(.owner), tone: .owner)
                Spacer(minLength: 8)
                if !allPrinciples && principles.count > WikiLogic.principlesShown {
                    Button(WikiCopy.allPrinciples(principles.count)) { allPrinciples = true }
                        .font(.orbitSubtext)
                        .buttonStyle(.borderless)
                }
            }
            .textCase(nil)
        }
    }

    /// The documents by category (mock 30 ③), the topic articles before a plan, a new space's card (mock 31 ⑥),
    /// or grey bars while the first read is out (mock 31 ⑦).
    @ViewBuilder private var documentsBand: some View {
        switch documents {
        case .loading:
            if failed { failure } else { skeleton }
        case .categories(let categories):
            ForEach(categories) { category in self.category(category) }
        case .topics(let groups):
            ForEach(groups) { group in topics(group) }
        case .newSpace:
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(WikiDocCopy.noDocumentsNote)
                        .font(.orbitSubtext)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Button(WikiPlanCopy.setUp, action: actions.openSettings)
                        .font(.orbitSubtext.weight(.semibold))
                        .buttonStyle(.borderless)
                }
                .padding(.vertical, 4)
            }
        case .nothing:
            EmptyView()
        }
    }

    /// One category: its written documents with their leads, then one row for the rest — `+3 not written yet`,
    /// or `3 documents · Not written yet` when none is — which opens to their titles in grey (mock 26 ②).
    private func category(_ category: WikiDocLogic.HomeCategory) -> some View {
        let open = unfolded.contains(category.key)
        return Section {
            ForEach(category.written) { doc in
                WikiDocRow(mark: .number(doc.number), title: doc.title, line: doc.lead, lead: true, fresh: doc.fresh) {
                    actions.openDoc(doc.slug)
                }
            }
            if let folded = WikiDocLogic.notWrittenRow(category) {
                WikiDocFoldedRow(text: folded, open: open) { fold(category.key) }
                if open {
                    ForEach(category.notWritten) { doc in
                        WikiDocRow(mark: .number(doc.number), title: doc.title, line: WikiDocCopy.notWrittenShort, muted: true) {
                            actions.openDoc(doc.slug)
                        }
                    }
                }
            }
        } header: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("\(category.number)")
                    .font(.orbitSubtext.monospacedDigit())
                    .foregroundStyle(.secondary)
                Text(category.title)
                    .font(.orbitSubtext.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .textCase(nil)
        }
    }

    /// A folded row pressed: its titles listed, or folded away again.
    private func fold(_ key: String) {
        if unfolded.contains(key) {
            unfolded.remove(key)
        } else {
            unfolded.insert(key)
        }
    }

    /// Before a plan is confirmed: a category of the directory, each topic's article a title a row.
    private func topics(_ group: WikiArticleLogic.DirectoryGroup) -> some View {
        Section {
            ForEach(group.topics) { topic in
                WikiDocRow(mark: nil, title: topic.title) { actions.openArticle(topic.slug) }
            }
        } header: {
            Text(group.title)
                .font(.orbitSubtext.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(nil)
        }
    }

    /// The documents' first read (mock 31 ⑦): a category's bar, then four documents' — number, title, two lines.
    private static let skeletonRows = [
        ("Product and capabilities", "Orbit is a self-hosted control room for coding agents that run on machines of your own."),
        ("System architecture and data flow", "The server keeps the intent and the history; registered runners run the agents."),
        ("Task lifecycle and its dependencies", "A task is a durable unit of queued work a runner claims and reports back on."),
        ("Session runs and recovery", "A session is a resumable conversation of many turns on one runner and one runtime."),
    ]

    private var skeleton: some View {
        Section {
            ForEach(Self.skeletonRows.indices, id: \.self) { index in
                WikiDocRow(mark: .number("0.0"), title: Self.skeletonRows[index].0, line: Self.skeletonRows[index].1,
                           lead: true, end: "") {}
            }
        } header: {
            Text("0  Product overview")
                .font(.orbitSubtext.weight(.semibold))
                .textCase(nil)
        }
        .redacted(reason: .placeholder)
        .disabled(true)
        .accessibilityHidden(true)
    }

    /// The first read failed, and nothing of it is in hand.
    private var failure: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text("The wiki couldn't be loaded")
                    .font(.orbitSubtext.weight(.semibold))
                Text("Check the connection, then try again.")
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                Button("Retry", action: actions.retry)
                    .buttonStyle(.borderless)
            }
            .padding(.vertical, 4)
        }
    }

    /// The ways to everything else (mock 31 ①): Browse by category · A–Z index.
    private var more: some View {
        Section {
            HStack(spacing: 18) {
                Button(action: actions.openBrowse) {
                    Label(WikiArticleCopy.browse, systemImage: "square.grid.2x2")
                }
                Button(action: actions.openIndex) {
                    Label(WikiArticleCopy.azIndex, systemImage: "textformat.abc")
                }
                Spacer(minLength: 0)
            }
            .font(.orbitSubtext)
            .buttonStyle(.borderless)
            .wikiHomeOnBackground()
        }
    }

    // MARK: search

    @ViewBuilder private var results: some View {
        Section {
            if hits.isEmpty && searched == query && !query.isEmpty {
                ContentUnavailableView.search(text: query)
                    .listRowSeparator(.hidden)
            } else {
                ForEach(hits) { hit in
                    Button { actions.openEntry(hit.id) } label: {
                        WikiRowLabel(title: hit.title ?? hit.id,
                                     detail: [hit.kind.map(WikiCopy.kindLabel) ?? "", hit.summary ?? ""]
                                        .filter { !$0.isEmpty }.joined(separator: " · "))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

/// The space beside the title, by the name a reader knows it by (design §12.3.4, mock 31 ④) — the home's head
/// on a phone, the directory column's beside it. With one space it is a grey label and no control: no chevron,
/// no menu. With several, a menu of every space, the current one ticked — a toggle per space, whose tick a menu
/// draws in its own column, its name the title and the repository and documents the line under it — what waits
/// in each in the row's icon cell, and Manage spaces at the foot, into Wiki settings.
struct WikiSpacePicker: View {
    let space: WikiSpace
    let spaces: [WikiSpace]
    var pick: (String) -> Void = { _ in }
    var manage: () -> Void = {}

    var body: some View {
        let names = WikiSpaceLogic.names(spaces)
        let name = names[space.id] ?? space.title ?? space.slug
        if spaces.count < 2 {
            Text(name)
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Color.primary.opacity(0.07), in: Capsule())
                .accessibilityLabel(WikiCopy.spacePickerHint)
                .accessibilityValue(name)
        } else {
            Menu {
                ForEach(WikiSpaceLogic.menuRows(spaces, names: names)) { row in
                    Toggle(isOn: Binding(get: { row.id == space.id },
                                         set: { if $0 { pick(row.slug) } })) {
                        // The name with its icon cell, then the line under it: a menu takes the Text
                        // after the Label as the row's subtitle (inside the Label it drops it).
                        Label {
                            Text(row.name)
                        } icon: {
                            if wikiMenuIconsDrawAmber, let symbol = row.waitingSymbol { wikiAmberSymbol(symbol) }
                        }
                        Text(row.subtitle(sayWaiting: !wikiMenuIconsDrawAmber))
                    }
                }
                Divider()
                Button(action: manage) {
                    Label(WikiCopy.manageSpaces, systemImage: "gearshape")
                }
            } label: {
                HStack(spacing: 4) {
                    Text(name)
                        .font(.orbitLabel.weight(.semibold))
                        .lineLimit(1)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.orbitMeta.weight(.semibold))
                }
                .foregroundStyle(Color.primary)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Color.primary.opacity(0.07), in: Capsule())
            }
            .accessibilityLabel(WikiCopy.spacePickerHint)
            .accessibilityValue(name)
        }
    }
}

private extension View {
    /// A row of the home that stands on the page's background rather than in a card: the head, the line, the
    /// search and the foot.
    func wikiHomeOnBackground() -> some View {
        self.listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
    }

    /// The categories as groups of cards on the grouped background (mock 30 ③) on iOS, close together; the
    /// platform's inset list on macOS.
    @ViewBuilder func wikiHomeListStyle() -> some View {
        #if os(iOS)
        self.listStyle(.insetGrouped)
            .listSectionSpacing(.compact)
        #else
        self.listStyle(.inset)
        #endif
    }
}

/// Where a press on a management band's row goes: an entry's page, or a run's.
struct WikiBandActions {
    var openEntry: (String) -> Void = { _ in }
    var openRun: (String) -> Void = { _ in }
}

/// The management bands' rows (design §12.3.2): a band's heading, a decision, a change or a run of
/// Recently changed, and the week's use — the home's until its content takes their place, and
/// Activity's, which marks with a blue dot what came after the reader last looked.
struct WikiBandRows {
    let content: WikiHomeContent
    var now: Date = Date()
    var actions = WikiBandActions()

    /// A band's heading, as the first row of its band rather than a section header: a plain list pins
    /// its section headers, and on iOS 26 a pinned header has no backing, so it drew over the rows
    /// scrolling under it. The mock's headings scroll with their bands. `new` is Activity's line beside
    /// Recently changed — `4 new since you last looked` — in the blue of the dots it counts.
    func bandHeader(_ title: String, count: Int? = nil, badge: String? = nil,
                    hint: String? = nil, new: String? = nil) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(title)
                .font(.orbitSubtext.weight(.bold))
                .foregroundStyle(Color.primary)
            if let count {
                Text("\(count)")
                    .font(.orbitLabel.weight(.semibold))
                    .foregroundStyle(Color.secondary)
            }
            if let badge { WikiBadge(text: badge, tone: .owner) }
            if let hint {
                Text(hint).font(.orbitLabel).foregroundStyle(Color.secondary)
            }
            if let new {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text("●").font(.orbitMeta)
                    Text(new).font(.orbitLabel.weight(.semibold))
                }
                .foregroundStyle(WikiPalette.color(.blue))
            }
            Spacer(minLength: 0)
        }
        .padding(.top, 14)
        .listRowSeparator(.hidden)
    }

    func empty(_ text: String) -> some View {
        Text(text)
            .font(.orbitLabel)
            .foregroundStyle(.secondary)
    }

    /// A decision, ADR-style: its title and the day it was decided, then whether it is in force.
    func decisionRow(_ entry: WikiEntry) -> some View {
        let status = entry.status.map(WikiCopy.statusLabel) ?? ""
        let line = [status, entry.summary ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
        return Button { actions.openEntry(entry.id) } label: {
            WikiRowLabel(title: entry.displayTitle, time: entry.validFrom.flatMap(WikiDate.monthDay),
                         detail: line, struck: entry.isEnded)
        }
        .buttonStyle(.plain)
    }

    /// One change: the entry, when, and what happened to it — the same verbs as an entry's History —
    /// with the mark a review mode applied it with. `new` is Activity's: whether it came after the reader
    /// last looked, a blue dot or a grey one; the home draws none.
    func changeRow(_ item: WikiTimelineItem, new: Bool? = nil) -> some View {
        let ended = item.status == .retired || item.status == .superseded || item.status == .rejected
        let kind = item.kind.map(WikiCopy.kindLabel) ?? ""
        let line = [WikiLogic.changeVerb(item), kind].filter { !$0.isEmpty }.joined(separator: " · ")
        let marked = item.appliedByMode != nil && !ended && (item.trust == .auto || item.trust == .unreviewed)
        return Button {
            if let id = item.entryId { actions.openEntry(id) }
        } label: {
            WikiRowLabel(title: item.title ?? "—", time: item.at.flatMap { RelativeTime.format($0, now: now) },
                         detail: line, note: WikiLogic.changeNote(item), struck: ended,
                         mark: marked ? item.trust : nil, dot: new.map(Self.newDot))
        }
        .buttonStyle(.plain)
        .disabled(item.entryId == nil)
    }

    /// One run: who it was and when, then what it applied and with which marks (mock 12 ②). The row
    /// is the way in; Revert run… is on the run's own page. What it counts is the run's own read, which
    /// the home reads for every run it folds; until that answers, the changes the feed holds of it.
    func runRow(_ changesetId: String, origin: WikiChangesetOrigin?, at: String?, changes: Int,
                new: Bool? = nil) -> some View {
        let summary = content.run(changesetId).map(WikiModeLogic.runSummary)
        let line = ([WikiModeCopy.appliedChanges(summary?.applied ?? changes)] + (summary.map(WikiModeLogic.runCounts) ?? []))
            .joined(separator: " · ")
        return Button {
            actions.openRun(changesetId)
        } label: {
            WikiRowLabel(title: WikiModeCopy.originWord(origin),
                         time: at.flatMap { RelativeTime.format($0, now: now) }, detail: line,
                         dot: new.map(Self.newDot))
        }
        .buttonStyle(.plain)
    }

    /// The week's use: how many sessions were handed the wiki and how many searches it answered,
    /// then the entries used most.
    @ViewBuilder var usage: some View {
        if content.usedThisWeek, let usage = content.space.usage {
            HStack(spacing: 18) {
                stat(usage.sessionsPushed ?? 0, WikiCopy.sessionsReceived)
                stat(usage.searches ?? 0, WikiCopy.searches)
                Spacer(minLength: 0)
            }
            ForEach(content.mostUsed) { used in
                Button { actions.openEntry(used.entryId) } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(used.title ?? used.entryId)
                            .font(.orbitProse)
                            .foregroundStyle(Color.primary)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        Text("\(used.total ?? 0)×")
                            .font(.orbitLabel.monospacedDigit())
                            .foregroundStyle(Color.secondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        } else {
            empty(WikiCopy.noAgentsYet)
        }
    }

    private func stat(_ value: Int, _ label: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Text("\(value)").font(.orbitSubtext.weight(.semibold).monospacedDigit())
            Text(label).font(.orbitLabel).foregroundStyle(.secondary)
        }
    }

    /// Blue for what came after the reader last looked, grey for what came before.
    private static func newDot(_ new: Bool) -> Color {
        new ? WikiPalette.color(.blue) : Color.secondary.opacity(0.5)
    }
}

/// A band's row: a title (struck through once agents no longer get it) with a time on its right,
/// and a secondary line under it — the session list's compact row — with Activity's dot before the
/// title when it has one.
private struct WikiRowLabel: View {
    let title: String
    var time: String? = nil
    var detail: String? = nil
    var note: String? = nil
    var struck = false
    /// The mark a review mode applied it with: Auto or Unreviewed, in the lists' own badge.
    var mark: WikiTrust? = nil
    /// Activity's dot: whether the row came after the reader last looked.
    var dot: Color? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if let dot {
                    Text("●").font(.orbitMeta).foregroundStyle(dot)
                }
                Text(title)
                    .font(.orbitProse)
                    .strikethrough(struck)
                    .foregroundStyle(struck ? Color.secondary : Color.primary)
                    .lineLimit(1)
                if let mark {
                    WikiBadge(text: WikiCopy.trustLabel(mark), tone: WikiLogic.trustTone(mark))
                }
                Spacer(minLength: 8)
                if let time {
                    Text(time).font(.orbitLabel).foregroundStyle(Color.secondary).fixedSize()
                }
            }
            if let detail, !detail.isEmpty {
                Text(detail)
                    .font(.orbitListSubtitle)
                    .foregroundStyle(Color.secondary)
                    .lineLimit(1)
            }
            if let note, !note.isEmpty {
                Text(note)
                    .font(.orbitLabel)
                    .foregroundStyle(Color.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

// MARK: - one entry

/// Where a press on an entry's page goes.
struct WikiEntryActions {
    var edit: () -> Void = {}
    var supersede: () -> Void = {}
    var retire: () -> Void = {}
    var copyLink: () -> Void = {}
    var openSession: (String) -> Void = { _ in }
    var openTask: (String) -> Void = { _ in }
    /// The owner's answers to what a review mode applied: Confirm, and Reject with its reason.
    var confirm: () -> Void = {}
    var reject: (WikiRejectReason) -> Void = { _ in }
}

/// One entry, as an inset-grouped page: the head (kind and topics, title, trust, anchor, pinned),
/// then Details, Sources, Anchors, Where it's used and History. Edit and the ⋯ menu (Supersede…,
/// Retire…, Copy link) are the bar's trailing controls.
struct WikiEntryPage: View {
    let detail: WikiEntryDetail
    var now: Date = Date()
    /// A session's title, when this client holds one; the row falls back to the id.
    var sessionTitle: (String) -> String? = { _ in nil }
    /// The title of the task or session a source cites, once its card has been read — the web draws
    /// those two as the conversation's own link cards; anything else is its word and its record.
    var sourceTitle: (WikiSource) -> String? = { _ in nil }
    var busy = false
    var actions = WikiEntryActions()

    private var entry: WikiEntry { detail.entry }

    var body: some View {
        List {
            Section { head }
            ForEach(WikiLogic.EntrySection.allCases, id: \.self) { section in
                self.section(section)
            }
        }
        .wikiEntryListStyle()
        .navigationTitle("")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button(WikiCopy.edit, action: actions.edit)
                    .disabled(busy)
                Menu {
                    Button(action: actions.supersede) {
                        Label(WikiCopy.supersede, systemImage: "arrow.left.arrow.right")
                    }
                    Button(role: .destructive, action: actions.retire) {
                        Label(WikiCopy.retire, systemImage: "trash")
                    }
                    Divider()
                    Button(action: actions.copyLink) {
                        Label(WikiCopy.copyLink, systemImage: "link")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .accessibilityLabel("More actions")
                .disabled(busy)
            }
        }
    }

    // MARK: head

    private var head: some View {
        VStack(alignment: .leading, spacing: 8) {
            kindLine
            Text(entry.displayTitle)
                .font(.title2.bold())
                .strikethrough(entry.isEnded)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            chips
            // What a review mode applied: the owner's two answers under the head, then what its mark
            // means for agents (mock 18 ①③) — Edit and ⋯ stay in the bar.
            if WikiModeLogic.answerable(status: entry.status, trust: entry.trust) {
                answers
                    .padding(.top, 4)
            }
            if let banner = WikiModeLogic.banner(status: entry.status, trust: entry.trust, tainted: entry.tainted == true) {
                markBar(banner)
            }
        }
        .padding(.vertical, 4)
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4))
    }

    /// The kind and the topics it is filed under, as the web drawer's first line says them.
    private var kindLine: some View {
        let kind = entry.kind.map(WikiCopy.kindLabel) ?? ""
        let topics = (entry.topics ?? []).joined(separator: " · ")
        return HStack(spacing: 5) {
            Image(systemName: WikiGlyph.kind(entry.kind))
                .foregroundStyle(WikiGlyph.kindTone(entry.kind))
            Text(kind).fontWeight(.semibold)
            if !topics.isEmpty {
                Text("· \(topics)").foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .font(.orbitLabel)
    }

    /// Trust, the anchor's last check, and whether it is pinned or rests on the web.
    private var chips: some View {
        HStack(spacing: 6) {
            if let trust = entry.trust, trust != .unknown {
                WikiBadge(text: WikiCopy.trustLabel(trust), tone: WikiLogic.trustTone(trust),
                          symbol: trust == .confirmed ? "checkmark" : nil)
            }
            if let mark = WikiLogic.anchorMark(state: entry.anchorState, checkedRef: entry.anchorCheckedRef) {
                WikiBadge(text: mark.word, tone: mark.tone,
                          symbol: mark.tone == .green ? "checkmark" : "exclamationmark.triangle")
            }
            if entry.pinned == true { WikiBadge(text: WikiCopy.pinned, tone: .muted) }
            if entry.tainted == true { WikiBadge(text: WikiCopy.webDerived, tone: .amber) }
        }
    }

    /// Confirm (for what agents are not sent yet) and Reject ▾, two large buttons side by side.
    private var answers: some View {
        HStack(spacing: 10) {
            if WikiModeLogic.canConfirm(status: entry.status, trust: entry.trust) {
                Button(action: actions.confirm) {
                    Label(WikiModeCopy.confirm, systemImage: "checkmark")
                        .frame(maxWidth: .infinity, minHeight: 32)
                }
                .buttonStyle(.borderedProminent)
            }
            Menu {
                // The four reasons, headed by where the reason goes (mock 18 ②).
                Section(WikiModeCopy.rejectOnRecord) {
                    ForEach(WikiRejectReason.allCases, id: \.self) { reason in
                        Button(WikiCopy.rejectReasonLabel(reason)) { actions.reject(reason) }
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Text(WikiCopy.reject)
                    Image(systemName: "chevron.down").font(.orbitMeta.weight(.semibold))
                }
                .frame(maxWidth: .infinity, minHeight: 32)
            }
            .buttonStyle(.bordered)
            .tint(.red)
        }
        .disabled(busy)
    }

    /// The bar under the head: the mark's word and what it means, then who checked it — the verdict the
    /// current revision was applied on, which the entry's read carries — and who applied it.
    private func markBar(_ banner: WikiModeLogic.Banner) -> some View {
        let current = detail.history.max { ($0.revision ?? 0) < ($1.revision ?? 0) }
        let verification = detail.verification
        let line = WikiModeLogic.checkedLine(verdict: verification?.verdict, model: verification?.model,
                                             tainted: entry.tainted == true,
                                             who: current.map { Self.historyWord($0.authorKind) },
                                             when: current?.createdAt.flatMap { RelativeTime.format($0, now: now) })
        return HStack(alignment: .top, spacing: 8) {
            Image(systemName: banner.tone == .amber ? "globe" : banner.tone == .green ? "checkmark.circle" : "info.circle")
                .foregroundStyle(WikiPalette.color(banner.tone))
            VStack(alignment: .leading, spacing: 3) {
                (Text(banner.lead).bold().foregroundColor(WikiPalette.color(banner.tone)) + Text(" · " + banner.text))
                    .font(.orbitLabel)
                    .fixedSize(horizontal: false, vertical: true)
                if !line.isEmpty {
                    Text(line)
                        .font(.orbitMeta)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(banner.tone == .amber ? AnyShapeStyle(wikiAmberWash)
                        : AnyShapeStyle(WikiPalette.color(banner.tone).opacity(banner.tone == .muted ? 0.08 : 0.12)),
                    in: RoundedRectangle(cornerRadius: 10))
    }

    /// Who wrote a revision, in the History section's own words.
    private static func historyWord(_ kind: WikiAuthorKind?) -> String {
        switch kind {
        case .owner?:       return WikiCopy.historyConfirmedBy
        case .maintenance?: return WikiCopy.historyMaintenance
        case .system?:      return WikiCopy.historySystem
        default:            return WikiCopy.historyProposedBy
        }
    }

    // MARK: sections

    @ViewBuilder
    private func section(_ section: WikiLogic.EntrySection) -> some View {
        switch section {
        case .details:
            Section {
                let rows = WikiLogic.fieldRows(kind: entry.kind, fields: entry.fields)
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in fieldRow(row) }
            } header: {
                Text(section.title)
            }
        case .sources:
            Section {
                if detail.sources.isEmpty {
                    Text(WikiCopy.noSources).font(.orbitLabel).foregroundStyle(.secondary)
                } else {
                    ForEach(detail.sources) { source in sourceRow(source) }
                }
            } header: {
                countedHeader(section.title, detail.sources.count)
            }
        case .anchors:
            Section {
                let anchors = entry.anchors ?? []
                if anchors.isEmpty {
                    Text(WikiCopy.noAnchors).font(.orbitLabel).foregroundStyle(.secondary)
                } else {
                    ForEach(Array(anchors.enumerated()), id: \.offset) { _, anchor in anchorRow(anchor) }
                }
            } header: {
                countedHeader(section.title, entry.anchors?.count ?? 0)
            } footer: {
                // What re-checks the anchors, said only when there are some to re-check.
                if !(entry.anchors ?? []).isEmpty { Text(WikiCopy.anchorsNote) }
            }
        case .whereUsed:
            Section {
                whereUsed
            } header: {
                Text(section.title)
            }
        case .history:
            Section {
                if detail.history.isEmpty {
                    Text(WikiCopy.noHistory).font(.orbitLabel).foregroundStyle(.secondary)
                } else {
                    ForEach(Array(detail.history.enumerated()), id: \.offset) { index, revision in
                        historyRow(revision, next: index == 0 ? detail.history.dropFirst().first : nil)
                    }
                }
            } header: {
                Text(section.title)
            }
        }
    }

    private func countedHeader(_ title: String, _ count: Int) -> some View {
        HStack(spacing: 6) {
            Text(title)
            Text("\(count)").foregroundStyle(.secondary)
        }
    }

    /// One field: its label above the value, the way the web drawer draws it on a phone.
    private func fieldRow(_ row: WikiFieldRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(row.label)
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
            ForEach(Array(row.lines.enumerated()), id: \.offset) { _, line in
                Text(line)
                    .font(.orbitProse)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
        .padding(.vertical, 2)
    }

    /// A source: the record it cites, and the quote it was cited for with whether the server found
    /// the quote in that record. A task or a session opens.
    private func sourceRow(_ source: WikiSource) -> some View {
        let opens = source.kind == .task || (source.kind == .turn && source.locator?["turnId"] != nil)
        let title = sourceTitle(source)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: WikiGlyph.source(source.kind))
                    .font(.orbitMeta)
                    .foregroundStyle(Color.accentColor)
                // A turn is shown as the session it is in when it names one, as the web's card does.
                Text(source.kind == .turn && opens ? OrbitLinkCopy.typeName(.session) : WikiLogic.sourceWord(source.kind))
                    .font(.orbitLabel.weight(.semibold))
                if title == nil {
                    Text(WikiLogic.sourceRef(source))
                        .font(.orbitMonoFine)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 0)
                if opens {
                    Image(systemName: "chevron.forward").font(.orbitMeta).foregroundStyle(.tertiary)
                }
            }
            if let title {
                Text(title)
                    .font(.orbitProse.weight(.semibold))
                    .foregroundStyle(opens ? Color.accentColor : Color.primary)
                    .lineLimit(3)
            }
            if let quote = source.quote, !quote.isEmpty {
                Text(quote)
                    .font(.orbitMono)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
                Text(source.quoteVerified == true ? WikiCopy.quoteVerified : WikiCopy.quoteUnverified)
                    .font(.orbitMeta.weight(.semibold))
                    .foregroundStyle(source.quoteVerified == true ? Color.green : Color.secondary)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .onTapGesture {
            guard let ref = source.ref else { return }
            if source.kind == .task { actions.openTask(ref) }
            if source.kind == .turn, opens { actions.openSession(ref) }
        }
    }

    /// An anchor: what it names, and its last check.
    private func anchorRow(_ anchor: WikiAnchor) -> some View {
        let mark = WikiLogic.anchorStateMark(anchor)
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "scope").font(.orbitMeta).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text(WikiLogic.anchorLabel(anchor))
                    .font(.orbitMono)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                WikiMarkText(mark: mark)
            }
        }
    }

    /// Where it's used: how many sessions this week were handed it and how often it was fetched, then
    /// the sessions themselves.
    @ViewBuilder private var whereUsed: some View {
        // The push leaves an Unreviewed entry out, so the section says so first (mock 18 ①).
        if let note = WikiModeLogic.whereUsedNote(status: entry.status, trust: entry.trust) {
            Text(note).font(.orbitLabel).foregroundStyle(.secondary)
        }
        if detail.exposure.isEmpty {
            if WikiModeLogic.whereUsedNote(status: entry.status, trust: entry.trust) == nil {
                Text(WikiCopy.noUseYet).font(.orbitLabel).foregroundStyle(.secondary)
            }
        } else {
            let pushed = Set(detail.exposure.filter { $0.channel == .push }.compactMap(\.sessionId)).count
            let fetched = detail.exposure.filter { $0.channel == .get }.count
            Text(WikiCopy.pushedTo(sessions: pushed, fetched: fetched))
                .font(.orbitSubtext)
            ForEach(Array(detail.exposure.prefix(3).enumerated()), id: \.offset) { _, row in
                exposureRow(row)
            }
        }
    }

    private func exposureRow(_ row: WikiExposure) -> some View {
        let id = row.sessionId
        let title = id.flatMap(sessionTitle) ?? id.map { "Session \($0.prefix(8))" } ?? "A session without an id"
        let how = row.channel == .push ? WikiCopy.pushedAtStart : "wiki_get"
        let when = row.at.flatMap { RelativeTime.format($0, now: now) }
        return Button {
            if let id { actions.openSession(id) }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.orbitProse).foregroundStyle(Color.primary).lineLimit(1)
                    Text([how, when].compactMap { $0 }.joined(separator: " · "))
                        .font(.orbitLabel)
                        .foregroundStyle(Color.secondary)
                }
                Spacer(minLength: 8)
                WikiBadge(text: row.channel == .push ? WikiCopy.pushedBadge : WikiCopy.fetchedBadge,
                          tone: .muted)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(id == nil)
    }

    /// One revision: its number, who wrote it, and when — the newest with the way back to the one
    /// before it.
    private func historyRow(_ revision: WikiRevision, next: WikiRevision?) -> some View {
        let word: String
        switch revision.authorKind {
        case .owner?:       word = WikiCopy.historyConfirmedBy
        case .maintenance?: word = WikiCopy.historyMaintenance
        case .system?:      word = WikiCopy.historySystem
        default:            word = WikiCopy.historyProposedBy
        }
        let number = revision.revision ?? 0
        var meta = revision.createdAt.flatMap { RelativeTime.format($0, now: now) } ?? ""
        if let older = next?.revision {
            meta += " · " + WikiCopy.compareWith(older)
        }
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(WikiCopy.revision(number))
                .font(.orbitMonoFine.weight(.semibold))
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Color.primary.opacity(0.07), in: Capsule())
            VStack(alignment: .leading, spacing: 2) {
                Text(word).font(.orbitProse.weight(.semibold))
                if !meta.isEmpty {
                    Text(meta).font(.orbitLabel).foregroundStyle(.secondary)
                }
            }
        }
    }
}

// MARK: - Review

/// Where a press on Review goes.
struct WikiReviewActions {
    var decide: (WikiLogic.ReviewCard, WikiDecideAction, WikiRejectReason?) -> Void = { _, _, _ in }
    var edit: (WikiLogic.ReviewCard) -> Void = { _ in }
    var openSession: (String) -> Void = { _ in }
    /// A challenge's Amend: the owner's version of the entry it names.
    var amend: (WikiLogic.ReviewCard) -> Void = { _ in }
}

/// Review: the proposals waiting for the owner, one card at a time with its position ("1 of 3"),
/// filtered by the tabs, and what applies without asking under them. A card's answers stack full
/// width with Accept on top — the approval cards' own `ApprovalActions`, the owner's call
/// (2026-09-25): the same component in the same order on every client.
struct WikiReviewPage: View {
    let cards: [WikiLogic.ReviewCard]
    /// The entry a card names, once it has been read.
    var entry: (String) -> WikiEntry? = { _ in nil }
    var now: Date = Date()
    var busy = false
    var actions = WikiReviewActions()

    @State private var tab: WikiLogic.ReviewTab = .all
    /// Kept across a decision and a tab change, and clamped to the queue that is there — the web
    /// phone pager's rule — rather than sent back to the first card.
    @State private var index = 0

    private var shown: [WikiLogic.ReviewCard] { WikiLogic.cards(cards, in: tab) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Picker(WikiCopy.reviewTitle, selection: $tab) {
                    ForEach(WikiLogic.ReviewTab.allCases, id: \.self) { tab in
                        Text(WikiLogic.tabLabel(tab, cards: cards)).tag(tab)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()

                let visible = shown
                if let at = WikiLogic.clampedIndex(index, count: visible.count) {
                    if visible.count > 1 { pager(at: at, count: visible.count) }
                    WikiReviewCard(card: visible[at], entry: namedEntry(visible[at]), now: now,
                                   busy: busy, actions: actions)
                        .id(visible[at].id)
                } else {
                    Text(WikiCopy.noReview)
                        .font(.orbitSubtext)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, 28)
                }
                autoAccept
            }
            .padding(16)
        }
        .navigationTitle(WikiCopy.reviewTitle)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .principal) { titleBlock }
        }
    }

    /// The entry an op is about — an amend's, a supersede's or a retire's target; an add names none.
    private func namedEntry(_ card: WikiLogic.ReviewCard) -> WikiEntry? {
        card.op.entryId.flatMap(entry)
    }

    /// "Review" over how many proposals from how many sessions, and how old the oldest is.
    private var titleBlock: some View {
        let subtitle: String
        if cards.isEmpty {
            subtitle = WikiCopy.noReview
        } else {
            var line = WikiCopy.proposalsFrom(cards.count, sessions: WikiLogic.proposingSessions(cards))
            if let oldest = WikiLogic.oldestProposal(cards), let ago = RelativeTime.format(oldest, now: now) {
                line += " · " + WikiCopy.oldest(ago)
            }
            subtitle = line
        }
        return VStack(spacing: 1) {
            Text(WikiCopy.reviewTitle).font(.headline)
            Text(subtitle).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }
    }

    /// One card at a time: where this one is in the queue, and the way to the ones either side.
    private func pager(at: Int, count: Int) -> some View {
        HStack {
            Button {
                index = max(0, at - 1)
            } label: {
                Label(WikiCopy.previous, systemImage: "chevron.backward")
            }
            .disabled(at == 0)
            Spacer()
            Text(WikiCopy.ofCount(at + 1, count))
                .font(.orbitLabel.weight(.semibold).monospacedDigit())
                .foregroundStyle(.secondary)
            Spacer()
            Button {
                index = min(count - 1, at + 1)
            } label: {
                Label(WikiCopy.next, systemImage: "chevron.forward")
                    .labelStyle(WikiTrailingIconLabelStyle())
            }
            .disabled(at >= count - 1)
        }
        .font(.orbitLabel)
        .buttonStyle(.borderless)
    }

    /// What applies without asking, and what always asks.
    private var autoAccept: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(WikiCopy.autoAccept).font(.orbitSubtext.weight(.bold))
            Text(WikiCopy.autoAcceptHint).font(.orbitLabel).foregroundStyle(.secondary)
            autoRow(WikiCopy.reinforce, WikiCopy.reinforceNote)
            autoRow(WikiCopy.challenge, WikiCopy.challengeNote)
            (Text(WikiCopy.alwaysAsks).bold() + Text(" · " + WikiCopy.alwaysAsksNote))
                .font(.orbitLabel)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10))
        }
        .padding(14)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 14))
    }

    private func autoRow(_ title: String, _ note: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "checkmark").font(.orbitLabel.weight(.semibold)).foregroundStyle(.green)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.orbitSubtext.weight(.semibold))
                Text(note).font(.orbitLabel).foregroundStyle(.secondary)
            }
        }
    }
}

/// One pending proposal: what it is and who proposed it, the warning a web-derived one carries, its
/// title and content, what it cites and stands on, what it resembles, and the answers.
struct WikiReviewCard: View {
    let card: WikiLogic.ReviewCard
    let entry: WikiEntry?
    var now: Date = Date()
    var busy = false
    var actions = WikiReviewActions()

    private var op: WikiChangesetOp { card.op }
    private var isRetire: Bool { op.op == .retire }
    /// A challenge is answered about the entry it names: Re-confirm, Amend or Retire.
    private var isChallenge: Bool { op.op == .challenge }
    private var tainted: Bool { op.tainted == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            head
            if isChallenge { challengeLine }
            if tainted { webDerivedWarning }
            Text(isRetire ? "Retire “\(WikiLogic.cardTitle(card, entry: entry))”"
                          : WikiLogic.cardTitle(card, entry: entry))
                .font(.title3.bold())
                .fixedSize(horizontal: false, vertical: true)
            if isRetire { retireFields } else { content }
            ApprovalActions {
                if isRetire {
                    Button { actions.decide(card, .accept, nil) } label: {
                        Text(WikiCopy.reviewRetire).approvalActionLabel()
                    }
                    .buttonStyle(.borderedProminent)
                    Button { actions.decide(card, .reject, .notTrue) } label: {
                        Text(WikiCopy.keep).approvalActionLabel()
                    }
                    .buttonStyle(.bordered)
                } else if isChallenge {
                    Button { actions.decide(card, .reconfirm, nil) } label: {
                        Text(WikiModeCopy.reconfirm).approvalActionLabel()
                    }
                    .buttonStyle(.borderedProminent)
                    Button { actions.amend(card) } label: {
                        Text(WikiModeCopy.amend).approvalActionLabel()
                    }
                    .buttonStyle(.bordered)
                    .disabled(entry == nil)
                    Button { actions.decide(card, .retire, nil) } label: {
                        Text(WikiModeCopy.retire).approvalActionLabel()
                    }
                    .buttonStyle(.bordered)
                } else {
                    Button { actions.decide(card, .accept, nil) } label: {
                        Text(WikiCopy.accept).approvalActionLabel()
                    }
                    .buttonStyle(.borderedProminent)
                    Button { actions.edit(card) } label: {
                        Text(WikiCopy.reviewEdit).approvalActionLabel()
                    }
                    .buttonStyle(.bordered)
                    Menu {
                        // The four reasons, headed by where the reason goes (mock 09 ③).
                        Section(WikiCopy.rejectReasonFoot) {
                            ForEach(WikiRejectReason.allCases, id: \.self) { reason in
                                Button(WikiCopy.rejectReasonLabel(reason)) { actions.decide(card, .reject, reason) }
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Text(WikiCopy.reject)
                            Image(systemName: "chevron.down").font(.orbitMeta.weight(.semibold))
                        }
                        .approvalActionLabel()
                    }
                    .buttonStyle(.bordered)
                }
            }
            .disabled(busy)
            if isChallenge {
                Text(WikiModeCopy.challengeWaits)
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
            } else if !isRetire {
                Text(tainted ? WikiCopy.webDerivedNote : WikiCopy.acceptNote)
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 14))
        .overlay { RoundedRectangle(cornerRadius: 14).strokeBorder(Color.primary.opacity(0.08)) }
    }

    /// The op's chip and the kind, then who proposed it and when.
    private var head: some View {
        let kind = WikiLogic.cardKind(card, entry: entry).map(WikiCopy.kindLabel) ?? ""
        let when = card.changeset.createdAt.flatMap { RelativeTime.format($0, now: now) }
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(WikiLogic.cardChip(op.op))
                    .font(.orbitMonoFine.weight(.bold))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .foregroundStyle(Color.accentColor)
                    .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 4))
                Text(kind.isEmpty ? WikiCopy.entryWord : kind).font(.orbitLabel.weight(.semibold))
            }
            HStack(spacing: 4) {
                Text(WikiCopy.proposedBy).foregroundStyle(.secondary)
                if let session = card.changeset.sessionId {
                    Button(WikiLogic.proposedBy(card.changeset)) { actions.openSession(session) }
                        .buttonStyle(.borderless)
                        .lineLimit(1)
                } else {
                    Text(WikiLogic.proposedBy(card.changeset)).foregroundStyle(.secondary)
                }
                if let when { Text("· \(when)").foregroundStyle(.secondary) }
            }
            .font(.orbitLabel)
        }
    }

    /// What a challenge is about, in the amber a Web-derived card wears: each anchor that broke — path,
    /// symbol or commit, changed or missing — and the commit of main it was checked on; a challenge
    /// about something else says its own reason.
    private var challengeLine: some View {
        let broken = WikiModeLogic.brokenAnchors(entry?.anchors)
        let ref = WikiModeLogic.challengeRef(entry?.anchors)
        var text = Text("")
        if broken.isEmpty {
            text = Text(WikiModeCopy.challenged).bold()
                + Text(" · " + (op.payload?["reason"]?.stringValue ?? WikiModeCopy.challengeWaits))
        } else {
            for (index, anchor) in broken.enumerated() {
                if index > 0 { text = text + Text("; ") }
                text = text + Text(anchor.state == .changed ? "Changed" : "Missing").bold() + Text(" · " + anchor.label)
            }
            if let ref { text = text + Text(" · " + WikiModeCopy.checkedOnMain(ref)).foregroundColor(.secondary) }
        }
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "scope").foregroundStyle(.orange)
            text
                .font(.orbitLabel)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(wikiAmberWash, in: RoundedRectangle(cornerRadius: 10))
    }

    private var webDerivedWarning: some View {
        (Text(WikiCopy.webDerived).bold() + Text(" · " + WikiCopy.webDerivedWarning))
            .font(.orbitLabel)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(wikiAmberWash, in: RoundedRectangle(cornerRadius: 10))
    }

    /// A retire: why, what backs it, and what happens after.
    private var retireFields: some View {
        VStack(alignment: .leading, spacing: 10) {
            labelled(WikiCopy.reasonLabel, [op.payload?["reason"]?.stringValue ?? "—"])
            labelled(WikiCopy.evidenceLabel, sourceLines.isEmpty ? ["—"] : sourceLines)
            labelled(WikiCopy.afterLabel, [WikiCopy.afterRetire])
        }
    }

    /// Anything else: an amendment's diff, or the proposal's fields; then its sources, anchors and
    /// the entries it resembles.
    private var content: some View {
        VStack(alignment: .leading, spacing: 10) {
            let hunks = WikiLogic.changesDiff(before: entryContent, changes: op.payload?["changes"])
            if !hunks.isEmpty {
                ForEach(Array(hunks.enumerated()), id: \.offset) { _, hunk in diff(hunk) }
            } else {
                let fields = op.payload?["entry"]?["fields"] ?? entry?.fields
                let rows = WikiLogic.fieldRows(kind: WikiLogic.cardKind(card, entry: entry), fields: fields)
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in labelled(row.label, row.lines) }
            }
            labelled(WikiCopy.sources, sourceLines.isEmpty ? ["—"] : sourceLines)
            labelled(WikiCopy.anchors, anchorLines.isEmpty ? ["—"] : anchorLines, mono: true)
            similar
        }
    }

    /// The named entry's current content, as a diff reads its "before".
    private var entryContent: JSONValue? {
        guard let entry else { return nil }
        var object: [String: JSONValue] = [:]
        if let title = entry.title { object["title"] = .string(title) }
        if let summary = entry.summary { object["summary"] = .string(summary) }
        if let fields = entry.fields { object["fields"] = fields }
        if let topics = entry.topics { object["topics"] = .array(topics.map(JSONValue.string)) }
        if let aliases = entry.aliases { object["aliases"] = .array(aliases.map(JSONValue.string)) }
        if let anchors = entry.anchors, let data = try? JSONEncoder().encode(anchors),
           let value = try? JSONDecoder().decode(JSONValue.self, from: data) {
            object["anchors"] = value
        }
        return .object(object)
    }

    /// The quotes the proposal cites, each the way the web lists it — the quote, then that it has not
    /// been checked yet (the check happens when the proposal is recorded, not on this read).
    private var sourceLines: [String] {
        guard case .array(let sources)? = op.payload?["sources"] else { return [] }
        return sources.compactMap { source in
            let word = WikiLogic.sourceWord(source["kind"]?.stringValue.flatMap(WikiSourceKind.init(rawValue:)))
            guard let quote = source["quote"]?.stringValue, !quote.isEmpty else { return word.isEmpty ? nil : word }
            return "“\(quote)” — \(word) · \(WikiCopy.quoteUnverified)"
        }
    }

    /// The draft's anchors, or the ones the named entry already stands on.
    private var anchorLines: [String] {
        WikiLogic.reviewAnchorLines(draft: op.payload?["entry"], fallback: entry?.anchors)
    }

    /// What the proposal resembles, and the note that says none.
    private var similar: some View {
        let matches = op.similar ?? []
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(WikiCopy.similarEntries).font(.orbitLabel.weight(.semibold))
                if matches.isEmpty {
                    Text(WikiCopy.similarNone).font(.orbitLabel).foregroundStyle(.secondary)
                }
            }
            ForEach(matches) { match in
                Text([match.title ?? match.id, match.kind.map(WikiCopy.kindLabel) ?? ""]
                        .filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func labelled(_ label: String, _ lines: [String], mono: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.orbitLabel).foregroundStyle(.secondary)
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                // The dash that says "none" is a word, not code, whatever the row holds.
                Text(line)
                    .font(mono && line != "—" ? .orbitMono : .orbitProse)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// One field's red and green lines.
    private func diff(_ hunk: WikiDiffHunk) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(hunk.label).font(.orbitLabel).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                    Text("\(line.sign.rawValue) \(line.text)")
                        .font(.orbitDiffLine)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background((line.sign == .added ? Color.green : Color.red).opacity(0.12))
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }
}

// MARK: - marks

/// A toned capsule: a trust, an anchor's check, pinned.
struct WikiBadge: View {
    let text: String
    let tone: WikiTone
    var symbol: String? = nil

    var body: some View {
        HStack(spacing: 3) {
            if let symbol { Image(systemName: symbol).font(.orbitMeta.weight(.bold)) }
            Text(text).font(.orbitMeta.weight(.semibold)).lineLimit(1)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 2)
        // The owner's badge is the dark one, in either appearance: the label colour behind the page's.
        .foregroundStyle(tone == .owner ? AnyShapeStyle(.background) : AnyShapeStyle(WikiPalette.color(tone)))
        .background(tone == .owner ? Color.primary : WikiPalette.color(tone).opacity(0.14), in: Capsule())
        .fixedSize()
    }
}

/// An anchor's state as a line of its own: the mark's word in its tone.
private struct WikiMarkText: View {
    let mark: WikiAnchorMark

    var body: some View {
        HStack(spacing: 3) {
            if mark.tone == .green { Image(systemName: "checkmark").font(.orbitMeta.weight(.bold)) }
            Text(mark.word).font(.orbitMeta.weight(.semibold))
        }
        .foregroundStyle(WikiPalette.color(mark.tone))
    }
}

enum WikiPalette {
    static func color(_ tone: WikiTone) -> Color {
        switch tone {
        case .owner: return .primary
        case .blue:  return .accentColor
        case .muted: return .secondary
        case .green: return .green
        case .amber: return .orange
        case .red:   return .red
        }
    }
}

enum WikiGlyph {
    /// A kind's glyph: the web's kind icons, in SF Symbols.
    static func kind(_ kind: WikiEntryKind?) -> String {
        switch kind {
        case .principle?:  return "pin"
        case .convention?: return "ruler"
        case .decision?:   return "signpost.right"
        case .pitfall?:    return "exclamationmark.triangle"
        case .recipe?:     return "list.number"
        case .concept?:    return "book"
        default:           return "doc.text"
        }
    }

    static func kindTone(_ kind: WikiEntryKind?) -> Color {
        kind == .pitfall ? .orange : .secondary
    }

    static func source(_ kind: WikiSourceKind?) -> String {
        switch kind {
        case .turn?:         return "bubble.left"
        case .task?:         return "checkmark.square"
        case .commit?:       return "arrow.triangle.branch"
        case .mergeReceipt?: return "arrow.triangle.merge"
        case .toolCall?:     return "wrench.and.screwdriver"
        default:             return "doc.text"
        }
    }
}

/// A decision's date as the day it was decided (`9/25`), the way the lists date things older than a
/// week — a decision log is read by day, not by hours ago.
enum WikiDate {
    static func monthDay(_ iso: String) -> String? {
        guard let date = RelativeTime.parse(iso) else { return nil }
        let parts = Calendar(identifier: .gregorian).dateComponents(in: TimeZone.current, from: date)
        guard let month = parts.month, let day = parts.day else { return nil }
        return "\(month)/\(day)"
    }
}

/// A label with its icon after the title: `Next ›`.
private struct WikiTrailingIconLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.title
            configuration.icon
        }
    }
}

/// Where the status line's two links lead: the line opens them itself (`openURL` on the header).
let wikiStatusSettingsURL = URL(string: "orbit-wiki-status://settings")!
let wikiStatusRunURL = URL(string: "orbit-wiki-status://run")!

/// The status line under the title (mocks 12 ①, ④), one wrapping text: each part behind its `·`, amber
/// while a maintenance run waits and red when it broke — the dot before the words, as the session list's
/// status dots are — a green ✓ after a run that succeeded, and Set up and View run as links in the tint.
/// The parts are `WikiHealthLogic`'s, which the web's status row draws too; a phone has no spinner, as
/// mock 12 has none.
func wikiStatusText(_ parts: [WikiStatusPart]) -> AttributedString {
    typealias Colour = AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute
    var line = AttributedString()
    for (index, part) in parts.enumerated() {
        if index > 0 { line += AttributedString(" · ") }
        let colour = wikiStatusColour(part.tone)
        // No-break spaces keep the dot on the line of the words it colours, and the ✓ on the line of the
        // success it marks: a wrapped line never ends on a lone dot or starts with a lone check.
        if part.mark == .dot {
            var dot = AttributedString("●\u{00A0}")
            if let colour { dot[Colour.self] = colour }
            line += dot
        }
        var words = AttributedString(part.text)
        if let colour { words[Colour.self] = colour }
        if part.strong { words[AttributeScopes.SwiftUIAttributes.FontAttribute.self] = Font.orbitLabel.weight(.semibold) }
        switch part.link {
        case .settings: words.link = wikiStatusSettingsURL
        case .run: words.link = wikiStatusRunURL
        case .none: break
        }
        line += words
        if part.mark == .check {
            var check = AttributedString("\u{00A0}✓")
            check[Colour.self] = Color.green
            line += check
        }
    }
    return line
}

/// A part's colour: amber while a run waits, red when it broke; the line's own grey otherwise.
private func wikiStatusColour(_ tone: WikiStatusPart.Tone) -> Color? {
    switch tone {
    case .warn: return Color.orange
    case .error: return Color.red
    case .muted, .plain: return nil
    }
}

/// The amber wash the needs-you bar wears — stronger in dark mode, where 12% all but disappears.
#if os(iOS)
let wikiAmberWash = Color(uiColor: UIColor { trait in
    UIColor.systemOrange.withAlphaComponent(trait.userInterfaceStyle == .dark ? 0.20 : 0.12)
})
#else
let wikiAmberWash = Color.orange.opacity(0.14)
#endif

/// The bar's way into Activity (design §12.3.2): the history mark, with the drawer's orange number in its
/// corner — what waits on the owner across every space — and nothing at zero.
struct WikiActivityGlyph: View {
    let waiting: Int

    var body: some View {
        Image(systemName: "clock.arrow.circlepath")
            .overlay(alignment: .topTrailing) {
                if waiting > 0 {
                    Text("\(waiting)")
                        .font(.orbitMeta.weight(.semibold).monospacedDigit())
                        .foregroundStyle(.white)
                        .padding(.horizontal, 4)
                        .frame(minWidth: 16, minHeight: 16)
                        .background(Color.orange, in: Capsule())
                        .fixedSize()
                        .offset(x: 8, y: -7)
                }
            }
    }
}

/// Whether a system menu draws a row's icon in the icon's own colours: the space picker's amber number
/// (design §12.3.4). Where it does not, the number is said at the end of the row's line instead, in the web
/// option's words (`· 2 waiting`).
let wikiMenuIconsDrawAmber = true

/// A numbered circle in amber, as a menu row's icon — an image the menu keeps in its own colours.
@ViewBuilder func wikiAmberSymbol(_ name: String) -> some View {
    #if os(iOS)
    if let image = UIImage(systemName: name)?.withTintColor(.systemOrange, renderingMode: .alwaysOriginal) {
        Image(uiImage: image)
    }
    #else
    if let image = wikiAmberImage(name) {
        Image(nsImage: image)
    }
    #endif
}

#if os(macOS)
private func wikiAmberImage(_ name: String) -> NSImage? {
    guard let image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
        .withSymbolConfiguration(NSImage.SymbolConfiguration(paletteColors: [.systemOrange])) else { return nil }
    image.isTemplate = false
    return image
}
#endif

private extension View {
    /// Grouped cards on iOS, the platform's inset list on macOS — the project page's shape.
    @ViewBuilder func wikiEntryListStyle() -> some View {
        #if os(iOS)
        self.listStyle(.insetGrouped)
        #else
        self.listStyle(.inset)
        #endif
    }
}
