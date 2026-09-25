import SwiftUI
import OrbitKit
#if os(iOS)
import UIKit
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
    var openReview: () -> Void = {}
    var pickSpace: (String) -> Void = { _ in }
    var search: (String) async -> [WikiSearchHit] = { _ in [] }
}

/// One space's home: the large title with the space beside it, the search under the title, the
/// status line, the amber banner that leads to Review, then Principles, Topics, Recent decisions,
/// Recently changed and Agents used the wiki.
struct WikiHomePage: View {
    let content: WikiHomeContent
    var now: Date = Date()
    var actions = WikiHomeActions()

    @State private var query = ""
    @State private var hits: [WikiSearchHit] = []
    @State private var searched = ""
    /// The page's own header carries the title; the bar takes it once the header scrolls away, which
    /// is the system's large title collapsing into the bar.
    @State private var headerOnScreen = true

    private var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        List {
            Section {
                header
                    .onAppear { headerOnScreen = true }
                    .onDisappear { headerOnScreen = false }
            }
            .listRowSeparator(.hidden)
            ForEach(WikiLogic.HomeBand.allCases, id: \.self) { band in
                if band == .search || !searching {
                    self.band(band)
                }
            }
            if searching { results }
        }
        .listStyle(.plain)
        .navigationTitle(headerOnScreen ? "" : WikiCopy.title)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
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

    /// Title and space on one row (the web's page head), and the status line under them.
    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 10) {
                Text(WikiCopy.title)
                    .font(.largeTitle.bold())
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                spacePicker
            }
            Text(content.statusLine)
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 4)
    }

    /// The space as a capsule beside the title: a menu of every space, the current one ticked, each
    /// with the repository it describes under its name.
    private var spacePicker: some View {
        Menu {
            ForEach(content.spaces) { space in
                Button {
                    actions.pickSpace(space.slug)
                } label: {
                    Label {
                        Text(space.slug)
                        if let repo = space.repoUrlNorm { Text(repo) }
                    } icon: {
                        if space.id == content.space.id { Image(systemName: "checkmark") }
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(content.space.slug)
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
        .accessibilityValue(content.space.slug)
    }

    // MARK: the bands

    @ViewBuilder
    private func band(_ band: WikiLogic.HomeBand) -> some View {
        switch band {
        case .search:
            searchField
                .listRowSeparator(.hidden)
        case .reviewBanner:
            if content.proposals > 0 {
                reviewBanner
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
            }
        case .principles:
            Section {
                if content.principles.isEmpty {
                    empty(WikiCopy.noEntries)
                } else {
                    ForEach(content.principles) { entry in
                        entryRow(entry, detail: entry.summary, time: entry.validFrom)
                    }
                }
            } header: {
                bandHeader(WikiCopy.principles, count: content.principles.count,
                           badge: content.principlesAllOwner ? WikiCopy.trustLabel(.owner) : nil)
            }
        case .topics:
            Section {
                if content.topics.isEmpty {
                    empty(WikiCopy.noTopics)
                } else {
                    ForEach(content.topics) { topic in topicRow(topic) }
                }
            } header: {
                bandHeader(WikiCopy.topics, count: content.topics.count)
            }
        case .recentDecisions:
            Section {
                if content.recentDecisions.isEmpty {
                    empty(WikiCopy.noDecisions)
                } else {
                    ForEach(content.recentDecisions) { entry in decisionRow(entry) }
                }
            } header: {
                bandHeader(WikiCopy.recentDecisions, count: content.recentDecisions.count)
            }
        case .recentlyChanged:
            Section {
                if content.recentlyChanged.isEmpty {
                    empty(WikiCopy.noChanges)
                } else {
                    ForEach(content.recentlyChanged) { item in changeRow(item) }
                }
            } header: {
                bandHeader(WikiCopy.recentlyChanged)
            }
        case .agentsUsed:
            Section {
                usage
            } header: {
                bandHeader(WikiCopy.agentsUsed, hint: WikiCopy.agentsUsedHint)
            }
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

    /// The proposals waiting, in the needs-you bar's shape: an amber wash, the amber dot, the words
    /// in the label colour and a chevron — the whole bar one press into Review. The number is the
    /// drawer row's and Review's own.
    private var reviewBanner: some View {
        Button(action: actions.openReview) {
            HStack(spacing: 9) {
                Circle().fill(.orange).frame(width: 7, height: 7)
                Text(WikiCopy.proposalsToReview(content.proposals))
                    .font(.orbitControl)
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Image(systemName: "chevron.forward")
                    .font(.orbitMeta)
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(wikiAmberWash)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(WikiCopy.proposalsToReview(content.proposals))
    }

    // MARK: rows

    private func bandHeader(_ title: String, count: Int? = nil, badge: String? = nil,
                            hint: String? = nil) -> some View {
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
            Spacer(minLength: 0)
        }
        .textCase(nil)
    }

    private func empty(_ text: String) -> some View {
        Text(text)
            .font(.orbitLabel)
            .foregroundStyle(.secondary)
    }

    /// A row that opens an entry: its title and when, then one line under it.
    private func entryRow(_ entry: WikiEntry, detail: String?, time: String?) -> some View {
        Button { actions.openEntry(entry.id) } label: {
            WikiRowLabel(title: entry.displayTitle, time: time.flatMap { RelativeTime.format($0, now: now) },
                         detail: detail, struck: entry.isEnded)
        }
        .buttonStyle(.plain)
    }

    /// A topic: its name and how many entries carry it, then what its newest entry is and who made it
    /// so. A topic has no page of its own here, so the row opens that newest entry.
    private func topicRow(_ topic: WikiLogic.TopicSummary) -> some View {
        let latest = topic.latest
        let verb = latest.map { WikiLogic.entryVerb($0, loaded: content.loadedIDs) }
        return Button {
            if let latest { actions.openEntry(latest.id) }
        } label: {
            WikiRowLabel(title: WikiLogic.topicTitle(topic.slug), count: topic.count,
                         time: latest?.validFrom.flatMap { RelativeTime.format($0, now: now) },
                         detail: [verb, latest?.displayTitle].compactMap { $0 }.joined(separator: " · "))
        }
        .buttonStyle(.plain)
    }

    /// A decision, ADR-style: its title and the day it was decided, then whether it is in force.
    private func decisionRow(_ entry: WikiEntry) -> some View {
        let status = entry.status.map(WikiCopy.statusLabel) ?? ""
        let line = [status, entry.summary ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
        return Button { actions.openEntry(entry.id) } label: {
            WikiRowLabel(title: entry.displayTitle, time: entry.validFrom.flatMap(WikiDate.monthDay),
                         detail: line, struck: entry.isEnded)
        }
        .buttonStyle(.plain)
    }

    /// One change: the entry, when, and what happened to it — the same verbs as an entry's History.
    private func changeRow(_ item: WikiTimelineItem) -> some View {
        let ended = item.status == .retired || item.status == .superseded || item.status == .rejected
        let kind = item.kind.map(WikiCopy.kindLabel) ?? ""
        let line = [WikiLogic.changeVerb(item), kind].filter { !$0.isEmpty }.joined(separator: " · ")
        return Button {
            if let id = item.entryId { actions.openEntry(id) }
        } label: {
            WikiRowLabel(title: item.title ?? "—", time: item.at.flatMap { RelativeTime.format($0, now: now) },
                         detail: line, note: WikiLogic.changeNote(item), struck: ended)
        }
        .buttonStyle(.plain)
        .disabled(item.entryId == nil)
    }

    /// The week's use: how many sessions were handed the wiki and how many searches it answered,
    /// then the entries used most.
    @ViewBuilder private var usage: some View {
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

    // MARK: search

    @ViewBuilder private var results: some View {
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

/// A home-page row: a title (struck through once agents no longer get it) with a count and a time on
/// its right, and a secondary line under it — the session list's compact row.
private struct WikiRowLabel: View {
    let title: String
    var count: Int? = nil
    var time: String? = nil
    var detail: String? = nil
    var note: String? = nil
    var struck = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(title)
                    .font(.orbitProse)
                    .strikethrough(struck)
                    .foregroundStyle(struck ? Color.secondary : Color.primary)
                    .lineLimit(1)
                if let count {
                    Text("\(count)").font(.orbitLabel).foregroundStyle(Color.secondary)
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
}

/// One entry, as an inset-grouped page: the head (kind and topics, title, trust, anchor, pinned),
/// then Details, Sources, Anchors, Where it's used and History. Edit and the ⋯ menu (Supersede…,
/// Retire…, Copy link) are the bar's trailing controls.
struct WikiEntryPage: View {
    let detail: WikiEntryDetail
    var now: Date = Date()
    /// A session's title, when this client holds one; the row falls back to the id.
    var sessionTitle: (String) -> String? = { _ in nil }
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
                Text(WikiCopy.anchorsNote)
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
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: WikiGlyph.source(source.kind))
                    .font(.orbitMeta)
                    .foregroundStyle(Color.accentColor)
                Text(source.kind == .turn ? "Session" : WikiLogic.sourceWord(source.kind))
                    .font(.orbitLabel.weight(.semibold))
                Text(WikiLogic.sourceRef(source))
                    .font(.orbitMonoFine)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
                if opens {
                    Image(systemName: "chevron.forward").font(.orbitMeta).foregroundStyle(.tertiary)
                }
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
        if detail.exposure.isEmpty {
            Text(WikiCopy.noUseYet).font(.orbitLabel).foregroundStyle(.secondary)
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
    private var tainted: Bool { op.tainted == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            head
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
            if !isRetire {
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

    private var anchorLines: [String] {
        guard case .array(let anchors)? = op.payload?["entry"]?["anchors"] ?? op.payload?["changes"]?["anchors"]
        else { return [] }
        return anchors.map { anchor in
            WikiLogic.anchorLabel(WikiAnchor(type: anchor["type"]?.stringValue.flatMap(WikiAnchorType.init(rawValue:)),
                                             path: anchor["path"]?.stringValue,
                                             symbol: anchor["symbol"]?.stringValue,
                                             sha: anchor["sha"]?.stringValue,
                                             command: anchor["command"]?.stringValue,
                                             ref: anchor["ref"]?.stringValue))
        }
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
                Text(line)
                    .font(mono ? .orbitMono : .orbitProse)
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

/// The amber wash the needs-you bar wears — stronger in dark mode, where 12% all but disappears.
#if os(iOS)
let wikiAmberWash = Color(uiColor: UIColor { trait in
    UIColor.systemOrange.withAlphaComponent(trait.userInterfaceStyle == .dark ? 0.20 : 0.12)
})
#else
let wikiAmberWash = Color.orange.opacity(0.14)
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
