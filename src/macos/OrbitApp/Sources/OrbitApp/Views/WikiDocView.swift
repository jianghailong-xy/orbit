import SwiftUI
import OrbitKit

// The Wiki's documents (criterion 10 revised 2026-09-28, mocks 24, 26 ②, 28): one document of the plan
// the owner confirmed — its reader and scope, its sections with a superscript footnote after each sourced
// sentence and a mark after each that is not, its footnotes and the entries its quotes came through — and
// Browse by category and the A–Z index by document. Drawn from what the server said and nothing else;
// where a press goes is decided by the screen that mounts the page (`WikiScreens.swift`).
//
// The blocks are the web phone's, block for block and in its order (`WikiDocPage.tsx`, `WikiBrowsePage.tsx`,
// `WikiIndexPage.tsx`); every word and count is `WikiDocCopy` / `WikiDocLogic`, which `WikiDocsCopyParityTests`
// holds to the web's.

// MARK: - one document

/// Where a press on a document's page goes.
struct WikiDocActions {
    var openEntry: (String) -> Void = { _ in }
    var openDoc: (String) -> Void = { _ in }
    var openBrowse: () -> Void = {}
    var openContents: () -> Void = {}
    /// A footnote's one button: the session at that record, the task, the project, or the repository's host.
    var openSource: (WikiDocLogic.OpenTarget) -> Void = { _ in }
}

/// A footnote the reader opened, from a sentence or from the list.
struct WikiDocOpenNote: Identifiable, Equatable {
    let n: Int
    var id: Int { n }
}

/// A marked sentence the reader tapped: where it is, for its bubble.
struct WikiDocOpenMark: Identifiable, Equatable {
    let section: String
    let block: Int
    let sentence: Int
    var id: String { "\(section).\(block).\(sentence)" }
}

/// One document (mock 24): the crumb, the title, the tags, when and from what it was written, the banner of
/// a document past the threshold, the reader and scope, the text section by section, the footnotes, and the
/// entries its quotes came through — `WikiDocLogic.Section`'s order, which is the web phone's.
struct WikiDocPage: View {
    let doc: WikiDoc
    /// The space's repository on GitHub, when it is there: where a code or design-doc footnote opens.
    let github: String?
    /// How many of the plan's documents are written, for a document not written yet.
    let written: (written: Int, total: Int)?
    /// The space's entries, when read: the summaries of the ones the quotes came through.
    var summaries: [String: String] = [:]
    /// A section to open at, from the directory or the index.
    var section: String?
    var actions = WikiDocActions()

    @State private var openNote: WikiDocOpenNote?
    @State private var openMark: WikiDocOpenMark?
    @State private var scopeOpen = false
    @State private var allFootnotes = false
    @State private var expanded: Set<String> = []
    @State private var nextMark = 0

    private var notes: [Int: WikiDocFootnote] {
        Dictionary((doc.footnotes ?? []).map { ($0.n, $0) }, uniquingKeysWith: { first, _ in first })
    }

    /// Every marked sentence's row, in the text's order: where Next marked › goes.
    private var markedRows: [String] {
        (doc.sections ?? []).flatMap { section in
            (section.blocks ?? []).enumerated().compactMap { b, block in
                (block.sentences ?? []).contains { WikiDocLogic.mark($0) != nil } ? "\(section.key).\(b)" : nil
            }
        }
    }

    var body: some View {
        ScrollViewReader { proxy in
            List {
                ForEach(WikiDocLogic.Section.allCases, id: \.self) { section in
                    self.section(section, proxy: proxy)
                }
            }
            .listStyle(.plain)
            .task(id: section) {
                guard let section else { return }
                try? await Task.sleep(nanoseconds: 300_000_000)
                proxy.scrollTo("sec-\(section)", anchor: .top)
            }
        }
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
        // A footnote number and a mark's label are links inside the text; a press opens its card or its bubble.
        .environment(\.openURL, OpenURLAction { url in
            if let n = Self.note(from: url) {
                openNote = WikiDocOpenNote(n: n)
                return .handled
            }
            if let mark = Self.mark(from: url) {
                openMark = mark
                return .handled
            }
            return .systemAction
        })
        .sheet(item: $openNote) { opened in
            if let footnote = notes[opened.n] {
                WikiDocFootnoteSheet(footnote: footnote, entry: footnote.viaEntryId.flatMap { id in doc.entries?.first { $0.id == id } },
                                     github: github) { target in
                    openNote = nil
                    actions.openSource(target)
                } openEntry: { id in
                    openNote = nil
                    actions.openEntry(id)
                }
                .presentationDetents([.medium, .large])
            }
        }
        .sheet(item: $openMark) { mark in
            if let note = markNote(mark) {
                WikiDocMarkBubble(note: note) { n in
                    openMark = nil
                    openNote = WikiDocOpenNote(n: n)
                } openEntry: { id in
                    openMark = nil
                    actions.openEntry(id)
                }
                .presentationDetents([.height(220), .medium])
            }
        }
    }

    @ViewBuilder
    private func section(_ section: WikiDocLogic.Section, proxy: ScrollViewProxy) -> some View {
        switch section {
        case .crumb:
            Button(action: actions.openBrowse) {
                Text([WikiCopy.title, doc.category?.title].compactMap { $0 }.joined(separator: " · "))
                    .font(.orbitLabel)
                    .foregroundStyle(Color.accentColor)
                    .lineLimit(1)
            }
            .buttonStyle(.plain)
            .listRowSeparator(.hidden)
        case .title:
            Text(doc.title)
                .font(.title.bold())
                .fixedSize(horizontal: false, vertical: true)
                .listRowSeparator(.hidden)
                .accessibilityAddTraits(.isHeader)
        case .tags:
            WikiTagFlow(tags: [WikiTag(text: doc.category?.title ?? doc.category?.key ?? "", category: true)]
                + WikiDocLogic.tags(doc).map { WikiTag(text: $0, category: false) })
                .listRowSeparator(.hidden)
        case .updated:
            updated
                .listRowSeparator(.hidden)
        case .review:
            if doc.status == .needsReview {
                reviewBanner(proxy: proxy)
                    .listRowSeparator(.hidden)
            }
        case .scope:
            scope
                .listRowSeparator(.hidden)
        case .body:
            ForEach(doc.sections ?? [], id: \.key) { section in
                sectionHeading(section)
                    .id("sec-\(section.key)")
                if section.written == false {
                    Text(WikiDocCopy.sectionNotWritten)
                        .font(.orbitSubtext)
                        .foregroundStyle(.secondary)
                        .listRowSeparator(.hidden)
                } else {
                    ForEach(Array((section.blocks ?? []).enumerated()), id: \.offset) { b, block in
                        blockView(block, section: section, index: b)
                            .id("\(section.key).\(b)")
                            .listRowSeparator(.hidden)
                    }
                }
            }
        case .footnotes:
            if let footnotes = doc.footnotes, !footnotes.isEmpty {
                header(WikiDocCopy.footnotes, hint: WikiDocLogic.footnotesSummary(footnotes))
                let shown = allFootnotes ? footnotes : Array(footnotes.prefix(WikiDocCopy.footnotesShown))
                ForEach(shown, id: \.n) { footnote in footnoteRow(footnote) }
                if footnotes.count > shown.count {
                    Button(WikiArticleCopy.showMore(footnotes.count - shown.count)) { allFootnotes = true }
                        .font(.orbitSubtext)
                        .listRowSeparator(.hidden)
                }
            }
        case .entries:
            if let entries = doc.entries, !entries.isEmpty {
                header(WikiDocCopy.entries, hint: WikiDocCopy.entriesHint(entries.count))
                ForEach(WikiDocLogic.entryGroups(entries)) { group in entryGroup(group) }
            }
        }
    }

    // MARK: the head

    @ViewBuilder
    private var updated: some View {
        if doc.written {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(WikiDocLogic.updatedParts(doc).joined(separator: " · "))
                    .foregroundStyle(.secondary)
                if let warn = WikiDocLogic.updatedWarn(doc) {
                    Text("· \(warn)").foregroundStyle(.orange)
                }
            }
            .font(.orbitLabel)
            .fixedSize(horizontal: false, vertical: true)
        } else {
            (Text(WikiDocCopy.notWritten).bold() + Text(" ")
                + Text(WikiDocLogic.notWrittenNote(written: written?.written, total: written?.total)))
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// The banner over a document past the threshold (mock 24 ①): how many, why, the legend, Next marked ›.
    private func reviewBanner(proxy: ScrollViewProxy) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 8) {
                (Text(WikiDocCopy.needsReview).bold().foregroundColor(.orange) + Text(" · ") + Text(WikiDocLogic.needsReviewText(doc)))
                    .font(.orbitSubtext)
                    .fixedSize(horizontal: false, vertical: true)
                WikiFlowLayout(spacing: 8) {
                    ForEach(WikiDocLogic.legend(doc), id: \.mark) { item in
                        HStack(spacing: 4) {
                            WikiDocMarkLabel(mark: item.mark)
                            Text(WikiArticleCopy.count(item.count))
                                .font(.orbitLabel)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Button(WikiDocCopy.nextMarked) {
                        let rows = markedRows
                        guard !rows.isEmpty else { return }
                        let row = rows[nextMark % rows.count]
                        nextMark += 1
                        withAnimation { proxy.scrollTo(row, anchor: .center) }
                    }
                    .font(.orbitLabel)
                    .buttonStyle(.borderless)
                }
            }
        }
        .padding(12)
        .background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    /// The reader and scope (mock 24 ①): the question, then the three fields folded into one row on a phone.
    private var scope: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(WikiDocCopy.question)
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
            Text(doc.question ?? "")
                .font(.orbitSubtext.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            Divider()
            Button {
                withAnimation { scopeOpen.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Text(WikiDocCopy.scopeFolded)
                        .font(.orbitSubtext)
                        .foregroundStyle(Color.primary)
                    Text(WikiDocLogic.scopeCounts(doc))
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 4)
                    Image(systemName: scopeOpen ? "chevron.up" : "chevron.down")
                        .font(.orbitMeta)
                        .foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if scopeOpen {
                field(WikiDocCopy.writtenFor, doc.audience ?? [])
                field(WikiDocCopy.covers, doc.scopeIn ?? [])
                if let out = doc.scopeOut, !out.isEmpty {
                    Text(WikiDocCopy.notCovered)
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                    ForEach(Array(out.enumerated()), id: \.offset) { _, line in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text("•")
                            Text(line.text)
                                .fixedSize(horizontal: false, vertical: true)
                            ForEach(line.docs ?? [], id: \.slug) { target in
                                Button(WikiDocLogic.scopeTarget(target)) { actions.openDoc(target.slug) }
                                    .buttonStyle(.borderless)
                            }
                        }
                        .font(.orbitSubtext)
                    }
                }
            }
        }
        .padding(12)
        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func field(_ title: String, _ lines: [String]) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("•")
                    Text(line).fixedSize(horizontal: false, vertical: true)
                }
                .font(.orbitSubtext)
            }
        }
    }

    // MARK: the text

    /// `1 会话运行模型与长连接：总览`, with Rewrite pending beside a section a withdrawal left waiting.
    private func sectionHeading(_ section: WikiDocSection) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("\(section.number ?? 0)")
                .foregroundStyle(.secondary)
            Text(section.title)
            if section.stale == true {
                Label(WikiDocCopy.rewritePending, systemImage: "arrow.triangle.2.circlepath")
                    .font(.orbitMeta.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(Color.secondary.opacity(0.12), in: Capsule())
            }
        }
        .font(.title3.bold())
        .padding(.top, 14)
        .listRowSeparator(.hidden)
        .accessibilityAddTraits(.isHeader)
    }

    @ViewBuilder
    private func blockView(_ block: WikiDocBlock, section: WikiDocSection, index: Int) -> some View {
        switch block.kind {
        case .heading:
            Text(block.text ?? "")
                .font(.headline)
                .padding(.top, 6)
        case .code:
            ScrollView(.horizontal, showsIndicators: false) {
                Text(block.text ?? "")
                    .font(.system(.footnote, design: .monospaced))
                    .fixedSize()
                    .padding(10)
            }
            .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        case .item:
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("•")
                Text(paragraph(block, section: section, index: index))
                    .lineSpacing(5)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .font(.orbitProse)
        default:
            Text(paragraph(block, section: section, index: index))
                .font(.orbitProse)
                .lineSpacing(6)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// One block's sentences as one paragraph: each sentence's words, its mark after it when it wears one
    /// — a link the page's `openURL` answers with the mark's bubble — and its footnote numbers, superscript
    /// links that open their cards. A footnote that did not check is red.
    private func paragraph(_ block: WikiDocBlock, section: WikiDocSection, index: Int) -> AttributedString {
        var out = AttributedString()
        for (s, sentence) in (block.sentences ?? []).enumerated() {
            let mark = WikiDocLogic.mark(sentence)
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
            switch mark {
            case .unsourced?:
                words[AttributeScopes.SwiftUIAttributes.BackgroundColorAttribute.self] = Color.orange.opacity(0.14)
            case .unverified?:
                words[AttributeScopes.SwiftUIAttributes.UnderlineStyleAttribute.self] = Text.LineStyle(pattern: .solid, color: Color.red)
            case .withdrawn?:
                words[AttributeScopes.SwiftUIAttributes.StrikethroughStyleAttribute.self] = Text.LineStyle(pattern: .solid, color: Color.secondary)
                words[AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute.self] = Color.secondary
            case nil:
                break
            }
            if openNote.map({ sentence.notes?.contains($0.n) ?? false }) ?? false {
                words[AttributeScopes.SwiftUIAttributes.BackgroundColorAttribute.self] = Color.accentColor.opacity(0.14)
            }
            out += words
            for n in sentence.notes ?? [] {
                var number = AttributedString(WikiDocCopy.noteLabel(n))
                number.link = Self.url(n: n)
                number[AttributeScopes.SwiftUIAttributes.FontAttribute.self] = Font.orbitMeta
                number[AttributeScopes.SwiftUIAttributes.BaselineOffsetAttribute.self] = 6
                if let note = notes[n], note.verdict != .verified {
                    number[AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute.self] = Color.red
                }
                out += number
            }
            if let mark {
                var label = AttributedString(" \(mark.label) ")
                label.link = Self.url(mark: WikiDocOpenMark(section: section.key, block: index, sentence: s))
                label[AttributeScopes.SwiftUIAttributes.FontAttribute.self] = Font.orbitMeta.weight(.semibold)
                label[AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute.self] = WikiDocMarkLabel.color(mark)
                label[AttributeScopes.SwiftUIAttributes.BackgroundColorAttribute.self] = WikiDocMarkLabel.color(mark).opacity(0.14)
                out += AttributedString(" ")
                out += label
            }
            out += AttributedString(" ")
        }
        return out
    }

    private func markNote(_ mark: WikiDocOpenMark) -> WikiDocLogic.MarkNote? {
        guard let section = doc.sections?.first(where: { $0.key == mark.section }),
              let blocks = section.blocks, mark.block < blocks.count,
              let sentences = blocks[mark.block].sentences, mark.sentence < sentences.count else { return nil }
        return WikiDocLogic.markNote(sentences[mark.sentence], section: section, doc: doc)
    }

    private static func url(n: Int) -> URL? { URL(string: "orbit-footnote://note?n=\(n)") }

    private static func url(mark: WikiDocOpenMark) -> URL? {
        var parts = URLComponents()
        parts.scheme = "orbit-mark"
        parts.host = "mark"
        parts.queryItems = [URLQueryItem(name: "section", value: mark.section), URLQueryItem(name: "block", value: String(mark.block)),
                            URLQueryItem(name: "sentence", value: String(mark.sentence))]
        return parts.url
    }

    private static func note(from url: URL) -> Int? {
        guard url.scheme == "orbit-footnote",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        return items.first { $0.name == "n" }?.value.flatMap(Int.init)
    }

    private static func mark(from url: URL) -> WikiDocOpenMark? {
        guard url.scheme == "orbit-mark",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        guard let section = value("section"), let block = value("block").flatMap(Int.init),
              let sentence = value("sentence").flatMap(Int.init) else { return nil }
        return WikiDocOpenMark(section: section, block: block, sentence: sentence)
    }

    // MARK: the footnotes and the entries

    private func header(_ title: String, hint: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(title)
                .font(.orbitSubtext.weight(.bold))
            Text(hint)
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.top, 18)
        .listRowSeparator(.hidden)
    }

    /// `9.  Code  src/…/realtime.service.ts · RealtimeService.waitForInbox  ✓` over its words and what they came through.
    private func footnoteRow(_ footnote: WikiDocFootnote) -> some View {
        let entry = footnote.viaEntryId.flatMap { id in doc.entries?.first { $0.id == id } }
        let checked = footnote.verdict == .verified
        return Button { openNote = WikiDocOpenNote(n: footnote.n) } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("\(footnote.n).")
                    .font(.orbitSubtext.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 26, alignment: .leading)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(WikiDocCopy.footnoteKind(footnote.kind))
                            .font(.orbitMeta.weight(.medium))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .foregroundStyle(footnote.kind.opensAtASessionRecord ? Color.accentColor : Color.secondary)
                            .background((footnote.kind.opensAtASessionRecord ? Color.accentColor : Color.secondary).opacity(0.12),
                                        in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                        Text(WikiDocLogic.footnoteWhere(footnote))
                            .font(WikiDocLogic.isRepo(footnote) ? .system(.footnote, design: .monospaced) : .orbitSubtext)
                            .foregroundStyle(Color.primary)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Text(WikiDocCopy.verdictList(footnote.verdict))
                            .font(.orbitLabel)
                            .foregroundStyle(checked ? Color.green : Color.red)
                            .lineLimit(1)
                    }
                    Text(footnote.quote.map(WikiDocLogic.quoted) ?? WikiDocCopy.noQuoteGiven)
                        .font(.orbitListSubtitle)
                        .strikethrough(footnote.verdict == .notFound)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    if let entry {
                        Text("via \(entry.title)\(WikiDocLogic.viaEntryStatus(entry).map { " · \($0)" } ?? "")")
                            .font(.orbitMeta)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// One kind group: its heading, the rows it shows on a phone, and `Show N more`.
    @ViewBuilder
    private func entryGroup(_ group: WikiDocLogic.EntryGroup) -> some View {
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
        ForEach(all ? group.entries : Array(group.entries.prefix(WikiDocCopy.groupShownPhone)), id: \.id) { entry in
            entryRow(entry)
        }
        if group.entries.count > WikiDocCopy.groupShownPhone && !all {
            Button(WikiArticleCopy.showMore(group.entries.count - WikiDocCopy.groupShownPhone)) { expanded.insert(group.title) }
                .font(.orbitSubtext)
                .listRowSeparator(.hidden)
        }
    }

    /// An entry: its title and the footnotes it carried, its mark, and its summary — or, for one that left
    /// the wiki, what became of it and of its sentences.
    private func entryRow(_ entry: WikiDocViaEntry) -> some View {
        let gone = entry.status == .rejected || entry.status == .retired || entry.status == .superseded
        let line = gone ? WikiDocLogic.viaEntryNote(entry, doc: doc) : summaries[PublicID.storageKey(entry.id)]
        return Button { actions.openEntry(entry.id) } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(entry.title)
                        .font(.orbitProse)
                        .strikethrough(gone)
                        .foregroundStyle(gone ? Color.secondary : Color.primary)
                        .lineLimit(1)
                    Text((entry.notes ?? []).map(WikiDocCopy.noteLabel).joined())
                        .font(.orbitMeta)
                        .foregroundStyle(Color.accentColor)
                    Spacer(minLength: 8)
                    if gone, let status = entry.status {
                        WikiBadge(text: WikiCopy.statusLabel(status), tone: .muted)
                    } else if let trust = entry.trust, trust != .unknown {
                        WikiBadge(text: WikiCopy.trustLabel(trust), tone: WikiLogic.trustTone(trust))
                    }
                }
                if let line, !line.isEmpty {
                    Text(line)
                        .font(.orbitListSubtitle)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// A mark's label: No source (amber), Not verified (red), Withdrawn (grey).
struct WikiDocMarkLabel: View {
    let mark: WikiDocLogic.Mark

    static func color(_ mark: WikiDocLogic.Mark) -> Color {
        switch mark {
        case .unsourced: return .orange
        case .unverified: return .red
        case .withdrawn: return .secondary
        }
    }

    var body: some View {
        Text(mark.label)
            .font(.orbitMeta.weight(.semibold))
            .foregroundStyle(Self.color(mark))
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(Self.color(mark).opacity(0.14), in: RoundedRectangle(cornerRadius: 4, style: .continuous))
    }
}

/// What a marked sentence's mark means (mock 24 ②): the web's hover note, as a bubble.
struct WikiDocMarkBubble: View {
    let note: WikiDocLogic.MarkNote
    let openFootnote: (Int) -> Void
    let openEntry: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            (Text(note.title).bold() + Text(" ") + Text(note.text))
                .font(.orbitSubtext)
                .fixedSize(horizontal: false, vertical: true)
            if let see = note.see {
                Button(WikiDocCopy.seeFootnote(see)) { openFootnote(see) }
                    .font(.orbitSubtext)
                    .buttonStyle(.borderless)
            }
            if let entry = note.entryId {
                Button(WikiDocCopy.openTheEntry) { openEntry(entry) }
                    .font(.orbitSubtext)
                    .buttonStyle(.borderless)
            }
            Spacer(minLength: 0)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A footnote's card as a sheet (mock 24 ③④; owner's call 2026-09-29): its number, the kind of original
/// and whose words, whether the quote checked; the words, or the lines with the quoted one lit; what went
/// wrong; where the original is; the entry it came through as one row; and one button, which opens the
/// original — `WikiDocLogic.CardPart`'s order.
struct WikiDocFootnoteSheet: View {
    let footnote: WikiDocFootnote
    let entry: WikiDocViaEntry?
    let github: String?
    let openSource: (WikiDocLogic.OpenTarget) -> Void
    let openEntry: (String) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(WikiDocLogic.CardPart.allCases, id: \.self) { part in
                    self.part(part)
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private func part(_ part: WikiDocLogic.CardPart) -> some View {
        switch part {
        case .head:
            HStack(spacing: 6) {
                Text(WikiDocCopy.noteLabel(footnote.n))
                    .font(.orbitLabel.weight(.semibold).monospacedDigit())
                    .foregroundStyle(Color.accentColor)
                Image(systemName: Self.glyph(footnote.kind))
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                Text(WikiDocCopy.footnoteKind(footnote.kind))
                    .font(.orbitLabel.weight(.semibold))
                if let sub = WikiDocLogic.subLabel(footnote) {
                    Text("· \(sub)")
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Text(WikiDocCopy.verdictCard(footnote.verdict))
                    .font(.orbitLabel.weight(.semibold))
                    .foregroundStyle(footnote.verdict == .verified ? Color.green : Color.red)
            }
        case .quote:
            let excerpt = footnote.kind != .designDoc && WikiDocLogic.isRepo(footnote) && footnote.excerpt != nil
                ? WikiDocLogic.excerptLines(footnote, shown: WikiDocCopy.excerptLinesPhone) : nil
            if let excerpt {
                VStack(alignment: .leading, spacing: 0) {
                    ScrollView(.horizontal, showsIndicators: false) {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(excerpt.lines) { line in
                                HStack(spacing: 10) {
                                    Text("\(line.n)")
                                        .foregroundStyle(line.quoted ? Color.green : Color.secondary)
                                        .frame(minWidth: 30, alignment: .trailing)
                                    Text(line.text)
                                        .lineLimit(1)
                                        .fixedSize()
                                }
                                .padding(.vertical, 1)
                                .background(line.quoted ? Color.green.opacity(0.12) : Color.clear)
                            }
                        }
                        .font(.system(.caption, design: .monospaced))
                        .padding(10)
                    }
                    if excerpt.more > 0 {
                        Text(WikiDocCopy.moreLines(excerpt.more))
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .padding([.horizontal, .bottom], 10)
                    }
                }
                .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            } else if let quote = footnote.quote {
                Text(WikiDocLogic.quoted(quote))
                    .font(.orbitProse)
                    .strikethrough(footnote.verdict == .notFound)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
        case .problem:
            if let problem = WikiDocLogic.footnoteProblem(footnote) {
                Text(problem)
                    .font(.orbitSubtext)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .place:
            Text(WikiDocLogic.footnotePlace(footnote))
                .font(WikiDocLogic.isRepo(footnote) ? .system(.footnote, design: .monospaced) : .orbitSubtext)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        case .via:
            if let entry {
                Button { openEntry(entry.id) } label: {
                    HStack(spacing: 6) {
                        Text(WikiDocCopy.viaEntry)
                            .font(.orbitLabel)
                            .foregroundStyle(.secondary)
                        Image(systemName: WikiGlyph.kind(entry.kind))
                            .font(.orbitLabel)
                            .foregroundStyle(.secondary)
                        Text(entry.title)
                            .font(.orbitSubtext.weight(.semibold))
                            .foregroundStyle(Color.primary)
                            .lineLimit(1)
                        Spacer(minLength: 6)
                        if let trust = entry.trust, trust != .unknown {
                            WikiBadge(text: WikiCopy.trustLabel(trust), tone: WikiLogic.trustTone(trust))
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        case .open:
            if let open = WikiDocLogic.footnoteOpen(footnote, github: github) {
                Button { openSource(open.target) } label: {
                    Text(open.label)
                        .frame(maxWidth: .infinity, minHeight: 34)
                }
                .buttonStyle(.borderedProminent)
                .padding(.top, 4)
            }
        }
    }

    /// The kind's glyph: a page for a design doc or a contract, brackets for code, a bubble for a session.
    static func glyph(_ kind: WikiDocFootnoteKind) -> String {
        switch kind {
        case .designDoc, .contract: return "doc.text"
        case .code: return "chevron.left.forwardslash.chevron.right"
        case .turn, .event, .toolCall: return "bubble.left"
        case .taskComment: return "text.bubble"
        default: return "doc.plaintext"
        }
    }
}

// MARK: - the Contents sheet's documents

/// The Contents sheet's rows for a space that reads by its documents (mock 26 ②): the plan's categories,
/// each with its documents — an amber dot for one past the threshold, grey for one not written yet — and
/// the open one's sections under it.
struct WikiDocContentsRows: View {
    let groups: [WikiDocLogic.DirectoryGroup]
    let open: String?
    let pick: (WikiContentsPick) -> Void

    var body: some View {
        ForEach(groups) { group in
            Section {
                Text(group.title)
                    .font(.orbitSubtext.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .listRowSeparator(.hidden)
                ForEach(group.docs) { doc in
                    Button { pick(.doc(slug: doc.slug, section: nil)) } label: {
                        HStack(spacing: 10) {
                            Text(doc.number)
                                .font(.orbitSubtext.monospacedDigit())
                                .foregroundStyle(.secondary)
                            Text(doc.title)
                                .font(.orbitProse.weight(doc.slug == open ? .semibold : .regular))
                                .foregroundStyle(doc.slug == open ? Color.accentColor : doc.written ? Color.primary : Color.secondary)
                                .lineLimit(1)
                            Spacer(minLength: 8)
                            if doc.needsReview {
                                Circle().fill(.orange).frame(width: 7, height: 7)
                                    .accessibilityLabel(WikiDocCopy.needsReview)
                            }
                            Image(systemName: doc.slug == open ? "chevron.down" : "chevron.forward")
                                .font(.orbitMeta.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(doc.slug == open ? Color.accentColor.opacity(0.10) : Color.clear)
                    if doc.slug == open {
                        ForEach(doc.sections) { section in
                            Button { pick(.doc(slug: doc.slug, section: section.key)) } label: {
                                HStack(spacing: 8) {
                                    Text("\(section.number)")
                                        .foregroundStyle(.secondary)
                                    Text(section.title)
                                        .foregroundStyle(section.written ? Color.primary : Color.secondary)
                                        .lineLimit(1)
                                }
                                .font(.orbitSubtext)
                                .padding(.leading, 28)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Browse by category, by document

/// Browse by document (mock 28 ①): the plan's categories — what each answers — its documents with the
/// reader's question and their state, and each document's sections, one document open at a time.
struct WikiDocsBrowsePage: View {
    let directory: WikiDocsDirectory
    var actions = WikiDocActions()
    /// A document's page at one of its sections.
    var openSection: (String, String) -> Void = { _, _ in }

    @State private var open: String?
    @State private var all: Set<String> = []

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(WikiArticleCopy.browse)
                        .font(.largeTitle.bold())
                        .accessibilityAddTraits(.isHeader)
                    Text(WikiDocLogic.browseSummary(directory).joined(separator: " · "))
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                }
                .listRowSeparator(.hidden)
            }
            ForEach(directory.categories.filter { !($0.docs ?? []).isEmpty }, id: \.key) { category in
                Section {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(category.number ?? 0) \(category.title)")
                            .font(.orbitSubtext.weight(.bold))
                        Text(WikiDocLogic.categoryLine(category))
                            .font(.orbitLabel)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .padding(.top, 12)
                    .listRowSeparator(.hidden)
                    if let question = category.question, !question.isEmpty {
                        Text(question)
                            .font(.orbitListSubtitle)
                            .foregroundStyle(.secondary)
                            .listRowSeparator(.hidden)
                    }
                    ForEach(category.docs ?? [], id: \.slug) { doc in docRow(doc) }
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
    private func docRow(_ doc: WikiDocsDirectory.Doc) -> some View {
        let expanded = open == doc.slug
        let line = WikiDocLogic.docLine(doc)
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Button { actions.openDoc(doc.slug) } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(doc.number ?? "")
                            .font(.orbitSubtext.monospacedDigit())
                            .foregroundStyle(.secondary)
                        Text(doc.title)
                            .font(.orbitProse)
                            .foregroundStyle(Color.accentColor)
                            .lineLimit(2)
                    }
                }
                .buttonStyle(.borderless)
                Spacer(minLength: 4)
                Text(line.sections)
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                if let state = line.state {
                    Text(state.text)
                        .font(.orbitLabel)
                        .foregroundStyle(state == .needsReview ? Color.orange : Color.secondary)
                }
                if !(doc.sections ?? []).isEmpty {
                    Button {
                        open = expanded ? nil : doc.slug
                    } label: {
                        Image(systemName: expanded ? "chevron.down" : "chevron.forward")
                            .font(.orbitMeta.weight(.semibold))
                            .foregroundStyle(.tertiary)
                            .frame(minWidth: 28, minHeight: 28)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(doc.title)
                }
            }
            if let question = doc.question, !question.isEmpty {
                Text(question)
                    .font(.orbitListSubtitle)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        if expanded {
            let sections = doc.sections ?? []
            let shown = all.contains(doc.slug) ? sections : Array(sections.prefix(WikiDocCopy.browseSectionsShownPhone))
            ForEach(shown, id: \.key) { section in
                Button { openSection(doc.slug, section.key) } label: {
                    HStack(spacing: 8) {
                        Text("\(section.number ?? 0)")
                            .foregroundStyle(.secondary)
                        Text(section.title)
                            .foregroundStyle(section.written == false ? Color.secondary : Color.primary)
                            .lineLimit(1)
                    }
                    .font(.orbitProse)
                    .padding(.leading, 16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            if sections.count > shown.count {
                Button(WikiDocCopy.moreSections(sections.count - shown.count)) { all.insert(doc.slug) }
                    .font(.orbitSubtext)
                    .padding(.leading, 16)
            }
        }
    }
}

// MARK: - the A–Z index, by document

/// Every document and every section title no other document shares, under its letter (mock 28 ②): a
/// document in bold with its number and category, a section with where it is — and the system's section
/// index down the side.
struct WikiDocsIndexPage: View {
    let items: [WikiDocsIndex.Item]
    var actions = WikiDocActions()
    var openSection: (String, String) -> Void = { _, _ in }

    var body: some View {
        let groups = WikiDocLogic.indexGroups(items)
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(WikiArticleCopy.azIndex)
                        .font(.largeTitle.bold())
                        .accessibilityAddTraits(.isHeader)
                    Text(WikiDocLogic.indexSummary(items))
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                }
                .listRowSeparator(.hidden)
            }
            ForEach(groups) { group in
                Section {
                    Text(group.letter)
                        .font(.orbitSubtext.weight(.semibold))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .listRowBackground(Color.secondary.opacity(0.10))
                    ForEach(group.items) { item in
                        Button {
                            if let key = item.sectionKey, item.kind == "section" { openSection(item.docSlug, key) } else { actions.openDoc(item.docSlug) }
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(item.title)
                                    .font(.orbitProse.weight(item.kind == "doc" ? .semibold : .regular))
                                    .foregroundStyle(Color.primary)
                                    .lineLimit(1)
                                Text(WikiDocLogic.indexMeta(item))
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
                .modifier(WikiDocIndexLetter(letter: group.letter))
            }
        }
        .listStyle(.plain)
        .modifier(WikiDocIndexShown())
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
private struct WikiDocIndexLetter: ViewModifier {
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
private struct WikiDocIndexShown: ViewModifier {
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
