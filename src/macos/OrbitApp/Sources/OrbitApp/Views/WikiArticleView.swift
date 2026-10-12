import SwiftUI
import OrbitKit

// The Wiki's articles (criterion 10, mocks 12 ③, 14, 16): the Contents sheet, a topic's article with
// its footnotes and its entries, Browse by category and the A–Z index — drawn from what the server
// said and nothing else. Each page takes its reads and a set of actions; where a press goes is decided
// by the screen that mounts it (`WikiScreens.swift`), so a page draws the same in the app, in a
// three-column shell and in a screenshot probe.
//
// The sections are the web phone's, block for block and in its order (`WikiArticlePage.tsx`,
// `WikiDirectory.tsx`, `WikiBrowsePage.tsx`, `WikiIndexPage.tsx`); every word and count is
// `WikiArticleCopy` / `WikiArticleLogic`, which `WikiArticlesCopyParityTests` holds to the web's.

// MARK: - the Contents sheet

/// Where a row of the Contents sheet goes.
enum WikiContentsPick: Equatable {
    case home, browse, index
    /// The plan page (criterion 11), the sheet's fourth row.
    case plan
    case article(topic: String, part: Int)
    /// A document of the confirmed plan, at one of its sections when `section` is a key.
    case doc(slug: String, section: String?)
}

/// The directory as a sheet (mock 12 ③; by the plan since criterion 10's second revision, mock 26 ②): its
/// rows (`WikiContentsRows`) over the page it was opened from, which is lit. The web phone's left drawer, as a
/// sheet — the left edge's swipe already opens the app's drawer.
struct WikiContentsSheet: View {
    let groups: [WikiArticleLogic.DirectoryGroup]
    let at: WikiContentsAt
    /// The confirmed plan's categories and documents: when there are any, the sheet lists them instead.
    var docGroups: [WikiDocLogic.DirectoryGroup] = []
    /// What of the plan waits on the owner (`WikiPlanLogic.pending`).
    var planPending = 0
    let pick: (WikiContentsPick) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                WikiContentsRows(groups: groups, at: at, docGroups: docGroups, planPending: planPending, pick: choose)
            }
            .listStyle(.plain)
            .navigationTitle(WikiArticleCopy.contents)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close")
                }
            }
        }
    }

    private func choose(_ destination: WikiContentsPick) {
        dismiss()
        pick(destination)
    }
}

/// The directory's rows: Home, Browse by category, the A–Z index and the Plan — with the amber count of what of
/// it waits on the owner — then the confirmed plan's categories and documents, or, before a plan is confirmed,
/// every category's topics with the entries each one's article was written from. The phone's Contents sheet
/// lists them, and the iPad's and the Mac's middle column is them (design §12.3, mock 32).
struct WikiContentsRows: View {
    let groups: [WikiArticleLogic.DirectoryGroup]
    /// The row of the page on show, lit; nil lights none (Activity, Review, the settings).
    let at: WikiContentsAt?
    /// The confirmed plan's categories and documents: when there are any, they are listed instead.
    var docGroups: [WikiDocLogic.DirectoryGroup] = []
    /// What of the plan waits on the owner (`WikiPlanLogic.pending`).
    var planPending = 0
    let pick: (WikiContentsPick) -> Void

    var body: some View {
        Section {
            row(WikiArticleCopy.home, glyph: "house", lit: at == .home) { pick(.home) }
            row(WikiArticleCopy.browse, glyph: "square.grid.2x2", lit: at == .browse) { pick(.browse) }
            row(WikiArticleCopy.azIndex, glyph: "textformat.abc", lit: at == .index) { pick(.index) }
            planRow
        }
        if !docGroups.isEmpty {
            WikiDocContentsRows(groups: docGroups, open: openDoc) { destination in pick(destination) }
        }
        // The topic articles' groups, before a plan is confirmed; the screen passes none after.
        ForEach(groups) { group in
            Section {
                // The category's name as the section's first row: a plain list pins its
                // headers, and on iOS 26 a pinned header has no backing.
                Text(group.title)
                    .font(.orbitSubtext.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .listRowSeparator(.hidden)
                ForEach(group.topics) { topic in
                    topicRow(topic)
                }
            }
        }
    }

    /// The document whose page is on show.
    private var openDoc: String? {
        if case .doc(let slug)? = at { return slug }
        return nil
    }

    /// Plan, with the amber count of what of it waits on the owner — the system's badge style.
    private var planRow: some View {
        Button { pick(.plan) } label: {
            HStack(spacing: 12) {
                Image(systemName: "list.bullet.rectangle")
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 24)
                Text(WikiDocCopy.plan)
                    .font(.orbitProse.weight(at == .plan ? .semibold : .regular))
                    .foregroundStyle(at == .plan ? Color.accentColor : Color.primary)
                Spacer(minLength: 0)
                if planPending > 0 {
                    Text("\(planPending)")
                        .font(.orbitLabel.weight(.semibold).monospacedDigit())
                        .foregroundStyle(.white)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(Color.orange, in: Capsule())
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(at == .plan ? Color.accentColor.opacity(0.10) : Color.clear)
    }

    @ViewBuilder
    private func topicRow(_ topic: WikiArticleLogic.DirectoryTopic) -> some View {
        let open: Int? = {
            if case .article(let slug, let part)? = at, slug == topic.slug { return part }
            return nil
        }()
        Button { pick(.article(topic: topic.slug, part: 0)) } label: {
            HStack(spacing: 10) {
                Text(topic.title)
                    .font(.orbitProse.weight(open != nil ? .semibold : .regular))
                    .foregroundStyle(open == 0 ? Color.accentColor : Color.primary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if let count = topic.count {
                    Text(WikiArticleCopy.count(count))
                        .font(.orbitSubtext.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                Image(systemName: open != nil && !topic.parts.isEmpty ? "chevron.down" : "chevron.forward")
                    .font(.orbitMeta.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(open == 0 ? Color.accentColor.opacity(0.10) : Color.clear)
        if let open {
            ForEach(topic.parts) { part in
                Button { pick(.article(topic: topic.slug, part: part.part)) } label: {
                    Text(part.title)
                        .font(.orbitSubtext.weight(part.part == open ? .semibold : .regular))
                        .foregroundStyle(part.part == open ? Color.accentColor : Color.primary)
                        .lineLimit(1)
                        .padding(.leading, 16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .listRowBackground(part.part == open ? Color.accentColor.opacity(0.10) : Color.clear)
            }
        }
    }

    private func row(_ title: String, glyph: String, lit: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: glyph)
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 24)
                Text(title)
                    .font(.orbitProse.weight(lit ? .semibold : .regular))
                    .foregroundStyle(lit ? Color.accentColor : Color.primary)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(lit ? Color.accentColor.opacity(0.10) : Color.clear)
    }
}

// MARK: - one article

/// Where a press on an article's page goes.
struct WikiArticleActions {
    var openEntry: (String) -> Void = { _ in }
    var openArticle: (String, Int) -> Void = { _, _ in }
    var openBrowse: () -> Void = {}
    var openContents: () -> Void = {}
    /// A footnote's card opened: the screen reads the entry, for what backs it and its anchor.
    var readEntry: (String) -> Void = { _ in }
}

/// A footnote number the reader opened, and the sentence it hangs off.
struct WikiOpenNote: Identifiable, Equatable {
    let n: Int
    let block: Int
    let sentence: Int
    var id: String { "\(block).\(sentence).\(n)" }
}

/// One of a topic's articles (mock 14): the crumb, the title, the tags, when and from what it was
/// written, the text with a superscript footnote after every sentence, the footnotes, then the
/// topic's entries by kind — `WikiArticleLogic.Section`'s order, which is the web phone's.
struct WikiArticlePage: View {
    let article: WikiArticle
    /// The entries it was written from, as its read carries them; nil while they are on their way.
    let entries: [WikiEntry]?
    /// What a footnote's entry has behind it, once its card has read it.
    var detail: (String) -> WikiEntryDetail? = { _ in nil }
    var actions = WikiArticleActions()

    @State private var open: WikiOpenNote?
    @State private var expanded: Set<String> = []

    /// How many rows a kind group shows before `Show N more` — the topic page's number.
    private static let shownPerGroup = 4

    private var notes: [Int: WikiArticleFootnote] {
        Dictionary(article.footnotes.map { ($0.n, $0) }, uniquingKeysWith: { first, _ in first })
    }

    var body: some View {
        List {
            ForEach(WikiArticleLogic.Section.allCases, id: \.self) { section in
                self.section(section)
            }
        }
        .listStyle(.plain)
        .navigationTitle("")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(action: actions.openContents) { Image(systemName: "list.bullet") }
                    .accessibilityLabel(WikiArticleCopy.contents)
            }
        }
        // A footnote is a link inside the text; its press opens the entry's card rather than a URL.
        .environment(\.openURL, OpenURLAction { url in
            guard let note = Self.note(from: url) else { return .systemAction }
            open = note
            return .handled
        })
        .sheet(item: $open) { note in
            if let footnote = notes[note.n] {
                WikiFootnoteCard(footnote: footnote, detail: footnote.entry.flatMap { detail($0.id) }) { id in
                    open = nil
                    actions.openEntry(id)
                }
                .presentationDetents([.medium])
                .task { if let entry = footnote.entry { actions.readEntry(entry.id) } }
            }
        }
    }

    @ViewBuilder
    private func section(_ section: WikiArticleLogic.Section) -> some View {
        switch section {
        case .crumb:
            crumb
        case .title:
            Text(article.title ?? article.topic.title ?? article.topic.slug)
                .font(.title.bold())
                .fixedSize(horizontal: false, vertical: true)
                .listRowSeparator(.hidden)
                .accessibilityAddTraits(.isHeader)
        case .tags:
            WikiTagFlow(tags: tags)
                .listRowSeparator(.hidden)
        case .updated:
            Text(WikiArticleCopy.updated(generatedAt: article.generatedAt, ref: article.ref,
                                         entryCount: article.entryCount ?? 0))
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .listRowSeparator(.hidden)
        case .body:
            ForEach(Array(article.blocks.enumerated()), id: \.offset) { index, block in
                VStack(alignment: .leading, spacing: 8) {
                    if let heading = block.heading, !heading.isEmpty {
                        Text(heading)
                            .font(.title3.bold())
                            .padding(.top, 10)
                    }
                    Text(paragraph(block, index: index))
                        .font(.orbitProse)
                        .lineSpacing(6)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .listRowSeparator(.hidden)
            }
        case .footnotes:
            header(WikiArticleCopy.footnotes, hint: WikiArticleCopy.entriesCited(article.footnotes.count))
            ForEach(article.footnotes, id: \.n) { footnote in footnoteRow(footnote) }
        case .entries:
            let held = entries ?? []
            header(WikiArticleCopy.entries, hint: WikiArticleCopy.entriesHint(article.entryIds?.count ?? held.count))
            if entries != nil && held.isEmpty {
                Text(WikiArticleCopy.noTopicEntries)
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
            }
            ForEach(WikiArticleLogic.entryGroups(held, cited: article.footnotes.map(\.entryId))) { group in
                entryGroup(group)
            }
        }
    }

    /// `Wiki · Clients & UI · UI 设计`: the topic's own article is one press away from a subtopic's.
    private var crumb: some View {
        let parts = [WikiCopy.title, article.topic.categoryTitle, article.topic.title ?? article.topic.slug]
            .compactMap { $0 }
        return Button {
            if article.part > 0 { actions.openArticle(article.topic.slug, 0) }
        } label: {
            Text(parts.joined(separator: " · "))
                .font(.orbitLabel)
                .foregroundStyle(Color.accentColor)
                .lineLimit(1)
        }
        .buttonStyle(.plain)
        .listRowSeparator(.hidden)
    }

    private var tags: [WikiTag] {
        var out: [WikiTag] = []
        if let category = article.topic.categoryTitle { out.append(WikiTag(text: category, category: true)) }
        out.append(WikiTag(text: article.topic.title ?? article.topic.slug, category: false))
        for tag in WikiArticleLogic.kindTags((entries ?? []).map(\.kind)) {
            out.append(WikiTag(text: tag, category: false))
        }
        return out
    }

    /// One block's sentences as one paragraph, each followed by its footnote numbers — superscript
    /// links the page's `openURL` answers — and the sentence whose number is open tinted.
    private func paragraph(_ block: WikiArticleBlock, index: Int) -> AttributedString {
        var out = AttributedString()
        for (s, sentence) in block.sentences.enumerated() {
            var words = AttributedString()
            for segment in WikiArticleLogic.segments(sentence.text) {
                var run = AttributedString(segment.text)
                switch segment.kind {
                case .code:   run.inlinePresentationIntent = .code
                case .strong: run.inlinePresentationIntent = .stronglyEmphasized
                case .text:   break
                }
                words += run
            }
            if open?.block == index && open?.sentence == s {
                words[AttributeScopes.SwiftUIAttributes.BackgroundColorAttribute.self] = Color.accentColor.opacity(0.14)
            }
            out += words
            for n in sentence.notes {
                var mark = AttributedString(WikiArticleCopy.noteLabel(n))
                mark.link = Self.url(n: n, block: index, sentence: s)
                mark[AttributeScopes.SwiftUIAttributes.FontAttribute.self] = Font.orbitMeta
                mark[AttributeScopes.SwiftUIAttributes.BaselineOffsetAttribute.self] = 6
                out += mark
            }
            out += AttributedString(" ")
        }
        return out
    }

    private static func url(n: Int, block: Int, sentence: Int) -> URL? {
        URL(string: "orbit-footnote://note?n=\(n)&block=\(block)&sentence=\(sentence)")
    }

    private static func note(from url: URL) -> WikiOpenNote? {
        guard url.scheme == "orbit-footnote",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        func value(_ name: String) -> Int? { items.first { $0.name == name }?.value.flatMap(Int.init) }
        guard let n = value("n"), let block = value("block"), let sentence = value("sentence") else { return nil }
        return WikiOpenNote(n: n, block: block, sentence: sentence)
    }

    private func header(_ title: String, hint: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(title)
                .font(.orbitSubtext.weight(.bold))
                .foregroundStyle(Color.primary)
            Text(hint)
                .font(.orbitLabel)
                .foregroundStyle(Color.secondary)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.top, 18)
        .listRowSeparator(.hidden)
    }

    /// `1.  改 UI 先给效果图…` over `Convention · Confirmed`: the footnote list's row, which opens the entry.
    private func footnoteRow(_ footnote: WikiArticleFootnote) -> some View {
        Button {
            if let entry = footnote.entry { actions.openEntry(entry.id) }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("\(footnote.n).")
                    .font(.orbitSubtext.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 22, alignment: .leading)
                VStack(alignment: .leading, spacing: 3) {
                    if let entry = footnote.entry {
                        Text(entry.title ?? entry.id)
                            .font(.orbitProse)
                            .foregroundStyle(Color.primary)
                            .lineLimit(1)
                        HStack(spacing: 6) {
                            Text(WikiCopy.kindLabel(entry.kind ?? .unknown) + " ·")
                                .font(.orbitListSubtitle)
                                .foregroundStyle(.secondary)
                            if let trust = entry.trust, trust != .unknown {
                                WikiBadge(text: WikiCopy.trustLabel(trust), tone: WikiLogic.trustTone(trust))
                            }
                        }
                    } else {
                        Text(WikiArticleCopy.footnoteGone)
                            .font(.orbitProse)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(footnote.entry == nil)
    }

    /// One kind group: its heading, the rows it shows, and `Show N more`.
    @ViewBuilder
    private func entryGroup(_ group: WikiArticleLogic.EntryGroup) -> some View {
        let all = expanded.contains(group.title)
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(group.title)
                .font(.orbitSubtext.weight(.semibold))
            Text("\(group.entries.count)")
                .font(.orbitLabel.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(group.note)
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.top, 10)
        .listRowSeparator(.hidden)
        ForEach(all ? group.entries : Array(group.entries.prefix(Self.shownPerGroup))) { entry in
            Button { actions.openEntry(entry.id) } label: {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(entry.displayTitle)
                            .font(.orbitProse)
                            .strikethrough(entry.isEnded)
                            .foregroundStyle(entry.isEnded ? Color.secondary : Color.primary)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        if let trust = entry.trust, trust != .unknown, !entry.isEnded {
                            WikiBadge(text: WikiCopy.trustLabel(trust), tone: WikiLogic.trustTone(trust))
                        }
                    }
                    if let summary = entry.summary, !summary.isEmpty {
                        Text(summary)
                            .font(.orbitListSubtitle)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        if group.entries.count > Self.shownPerGroup {
            Button(all ? WikiArticleCopy.showLess : WikiArticleCopy.showMore(group.entries.count - Self.shownPerGroup)) {
                if all { expanded.remove(group.title) } else { expanded.insert(group.title) }
            }
            .font(.orbitSubtext)
            .listRowSeparator(.hidden)
        }
    }
}

/// The entry a footnote names, as a card (mock 14 ②): its number, kind and mark, its title and a few
/// lines of its summary, what backs it and where its anchor was last checked — read when the card
/// opens — and Open entry across the bottom.
struct WikiFootnoteCard: View {
    let footnote: WikiArticleFootnote
    let detail: WikiEntryDetail?
    let openEntry: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Text(WikiArticleCopy.noteLabel(footnote.n))
                    .font(.orbitLabel.weight(.semibold).monospacedDigit())
                    .foregroundStyle(Color.accentColor)
                if let entry = footnote.entry {
                    Image(systemName: WikiGlyph.kind(entry.kind))
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                    Text(WikiCopy.kindLabel(entry.kind ?? .unknown))
                        .font(.orbitLabel.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    if let trust = entry.trust, trust != .unknown {
                        WikiBadge(text: WikiCopy.trustLabel(trust), tone: WikiLogic.trustTone(trust))
                    }
                } else {
                    Spacer(minLength: 0)
                }
            }
            if let entry = footnote.entry {
                Text(entry.title ?? entry.id)
                    .font(.title3.bold())
                    .fixedSize(horizontal: false, vertical: true)
                if let summary = entry.summary, !summary.isEmpty {
                    Text(summary)
                        .font(.orbitSubtext)
                        .foregroundStyle(.secondary)
                        .lineLimit(4)
                }
                footLine
                Button { openEntry(entry.id) } label: {
                    Text(WikiArticleCopy.openEntry)
                        .frame(maxWidth: .infinity, minHeight: 34)
                }
                .buttonStyle(.borderedProminent)
                .padding(.top, 8)
            } else {
                Text(WikiArticleCopy.footnoteGone)
                    .font(.orbitSubtext)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(20)
    }

    /// `8 sources · 5 sessions · ✓ 1588c3b`, once the entry has been read.
    @ViewBuilder private var footLine: some View {
        if let detail {
            let counts = WikiArticleLogic.sourceCounts(detail.sources)
            HStack(spacing: 6) {
                Text(WikiArticleCopy.sourcesLine(sources: counts.sources, sessions: counts.sessions))
                if let mark = WikiLogic.anchorMark(state: detail.entry.anchorState, checkedRef: detail.entry.anchorCheckedRef) {
                    Text("·")
                    if mark.tone == .green { Image(systemName: "checkmark") }
                    Text(mark.word)
                        .foregroundStyle(WikiPalette.color(mark.tone))
                }
            }
            .font(.orbitLabel)
            .foregroundStyle(.secondary)
        }
    }
}

/// One of an article's tags: its category (tinted), its topic, a kind's count.
struct WikiTag: Hashable {
    let text: String
    let category: Bool
}

/// The tags, wrapping onto as many lines as they take.
struct WikiTagFlow: View {
    let tags: [WikiTag]

    var body: some View {
        WikiFlowLayout(spacing: 6) {
            ForEach(tags, id: \.self) { tag in
                Text(tag.text)
                    .font(.orbitLabel.weight(.medium))
                    .lineLimit(1)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 3)
                    .foregroundStyle(tag.category ? Color.accentColor : Color.primary)
                    .background((tag.category ? Color.accentColor : Color.secondary).opacity(0.12), in: Capsule())
            }
        }
    }
}

/// Left to right, then onto the next line — the web's `flex-wrap` for a row of capsules.
struct WikiFlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var line: CGFloat = 0
        var widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width {
                y += line + spacing
                x = 0
                line = 0
            }
            x += size.width + spacing
            line = max(line, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: proposal.width ?? widest, height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var line: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX {
                y += line + spacing
                x = bounds.minX
                line = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
}

// MARK: - Browse by category

/// Every category, its topics and each topic's subtopic articles (mock 16 ①). A topic's name opens
/// its own article; its chevron opens the subtopic articles under it, one topic at a time.
struct WikiBrowsePage: View {
    let categories: [WikiArticleLogic.BrowseCategory]
    var actions = WikiArticleActions()

    @State private var open: Set<String> = []
    @State private var all: Set<String> = []

    var body: some View {
        let totals = WikiArticleLogic.browseTotals(categories)
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(WikiArticleCopy.browse)
                        .font(.largeTitle.bold())
                        .accessibilityAddTraits(.isHeader)
                    Text(WikiArticleCopy.browseSummary(articles: totals.articles, topics: totals.topics, entries: totals.entries))
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                }
                .listRowSeparator(.hidden)
                if totals.articles == 0 {
                    Text(WikiArticleCopy.noArticles)
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(categories) { category in
                Section {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(category.title)
                            .font(.orbitSubtext.weight(.bold))
                        Text(WikiArticleCopy.categorySummary(topics: category.topics, articles: category.articles,
                                                             entries: category.entries))
                            .font(.orbitLabel)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .padding(.top, 12)
                    .listRowSeparator(.hidden)
                    ForEach(category.rows) { row in topic(row) }
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle("")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(action: actions.openContents) { Image(systemName: "list.bullet") }
                    .accessibilityLabel(WikiArticleCopy.contents)
            }
        }
    }

    @ViewBuilder
    private func topic(_ row: WikiArticleLogic.BrowseTopic) -> some View {
        let expanded = open.contains(row.slug)
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Button { actions.openArticle(row.slug, 0) } label: {
                    Text(row.title)
                        .font(.orbitProse)
                        .foregroundStyle(row.hasArticle ? Color.accentColor : Color.primary)
                        .lineLimit(1)
                }
                .buttonStyle(.borderless)
                .disabled(!row.hasArticle)
                if row.hasArticle {
                    Text(WikiArticleCopy.browseTopicLine(entries: row.entries, articles: row.articles))
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                if !row.parts.isEmpty {
                    Button {
                        if expanded { open.remove(row.slug) } else { open.insert(row.slug) }
                    } label: {
                        Image(systemName: expanded ? "chevron.down" : "chevron.forward")
                            .font(.orbitMeta.weight(.semibold))
                            .foregroundStyle(.tertiary)
                            .frame(minWidth: 28, minHeight: 28)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(row.title)
                }
            }
            if let description = row.description, !description.isEmpty {
                Text(description)
                    .font(.orbitListSubtitle)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        if expanded {
            let showAll = all.contains(row.slug)
            let parts = showAll ? row.parts : Array(row.parts.prefix(WikiArticleLogic.browseShown))
            ForEach(parts, id: \.part) { part in
                Button { actions.openArticle(row.slug, part.part) } label: {
                    HStack(spacing: 8) {
                        Text(part.title ?? "")
                            .font(.orbitProse)
                            .foregroundStyle(Color.primary)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        Text(WikiArticleCopy.count(part.entryCount ?? 0))
                            .font(.orbitLabel.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    .padding(.leading, 16)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            if row.parts.count > parts.count {
                Button(WikiArticleCopy.moreArticles(row.parts.count - parts.count)) { all.insert(row.slug) }
                    .font(.orbitSubtext)
                    .padding(.leading, 16)
            }
        }
    }
}

// MARK: - the A–Z index

/// Every article by title under its letter (mock 16 ②): a Chinese title by its first character's
/// pinyin (`WikiArticleLogic.indexInitial`), with the system's section index down the side.
struct WikiIndexPage: View {
    let groups: [WikiArticleLogic.IndexGroup]
    let count: Int
    var actions = WikiArticleActions()

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(WikiArticleCopy.azIndex)
                        .font(.largeTitle.bold())
                        .accessibilityAddTraits(.isHeader)
                    Text(WikiArticleCopy.indexSummary(count))
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                }
                .listRowSeparator(.hidden)
                if count == 0 {
                    Text(WikiArticleCopy.noArticles)
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(groups) { group in
                Section {
                    // The letter as the section's first row, on the grouped band's grey — a plain
                    // list's pinned header has no backing on iOS 26.
                    Text(group.letter)
                        .font(.orbitSubtext.weight(.semibold))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .listRowBackground(Color.secondary.opacity(0.10))
                    ForEach(group.items, id: \.rowID) { item in
                        Button { actions.openArticle(item.topic.slug, item.part) } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(item.title ?? "")
                                    .font(.orbitProse.weight(item.part == 0 ? .semibold : .regular))
                                    .foregroundStyle(Color.primary)
                                    .lineLimit(1)
                                Text(WikiArticleLogic.indexMeta(item))
                                    .font(.orbitListSubtitle)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .modifier(WikiSectionIndexLabel(letter: group.letter))
            }
        }
        .listStyle(.plain)
        .modifier(WikiSectionIndexShown())
        .navigationTitle("")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(action: actions.openContents) { Image(systemName: "list.bullet") }
                    .accessibilityLabel(WikiArticleCopy.contents)
            }
        }
    }
}

/// The letter a section answers to in the system's section index (iOS 26); nothing before it.
private struct WikiSectionIndexLabel: ViewModifier {
    let letter: String

    func body(content: Content) -> some View {
        #if os(iOS)
        if #available(iOS 26.0, *) {
            content.sectionIndexLabel(Text(letter))
        } else {
            content
        }
        #else
        content
        #endif
    }
}

/// The section index down the list's side, where the system has one (iOS 26).
private struct WikiSectionIndexShown: ViewModifier {
    func body(content: Content) -> some View {
        #if os(iOS)
        if #available(iOS 26.0, *) {
            content.listSectionIndexVisibility(.visible)
        } else {
            content
        }
        #else
        content
        #endif
    }
}

private extension WikiArticleIndex.Item {
    /// One article's place in the index: its topic and its part.
    var rowID: String { "\(topic.slug):\(part)" }
}
