import SwiftUI
import OrbitKit

// The Wiki section's screens: each reads `AppModel.wiki`, mounts one of `WikiView.swift`'s pages over
// what it read, and decides where a press goes — pushed onto the section's stack on a phone, selected
// into the detail pane on the three-column shells. The pages themselves know neither.

/// The Wiki section's home (design §12.3.1): the content of the space the reader opened — on a phone the
/// section's root, on the three-column shells the detail pane's whenever nothing is opened over it, beside the
/// directory column. Its head is drawn at once from the spaces list the drawer has read; its line and documents
/// once the home's own reads are in, the plan's read beside them.
struct WikiHomeView: View {
    @Environment(AppModel.self) private var model
    /// How rows navigate: the three-column shells select, the compact stack pushes.
    var rowNavigation: SessionRowNavigation = .selection

    @State private var contentsShown = false
    /// When the reader last looked, read as the home opens, before its look moves it: what the dots mark.
    @State private var seen: Double?

    var body: some View {
        if let wiki = model.wiki {
            Group {
                if let space = wiki.currentSpace {
                    // Until the home's first read for this space is in, the line and the documents are grey bars.
                    let loading = wiki.homeLoading
                    WikiHomePage(space: space, spaces: wiki.spaces, principles: WikiLogic.principles(wiki.principles),
                                 line: WikiLogic.homeLine(docs: wiki.docsDirectory, articles: wiki.directory, loading: loading),
                                 documents: WikiLogic.homeDocuments(docs: wiki.docsDirectory, articles: wiki.directory,
                                                                    loading: loading,
                                                                    maintenance: space.settings?.maintenance?.enabled == true,
                                                                    seen: seen),
                                 seen: seen, failed: loading && wiki.homeState.lastLoadFailed, waiting: wiki.waiting,
                                 besideContents: rowNavigation == .selection, actions: actions(wiki))
                } else {
                    WikiHomePlaceholder(wiki: wiki, state: wiki.spacesState) { await wiki.loadSpaces() }
                }
            }
            // The space on screen, read and looked at: as the home opens, and again when another is picked.
            .task(id: wiki.currentSpace?.slug) {
                guard let slug = wiki.currentSpace?.slug else {
                    // Opened before the drawer read the spaces: the head waits for them, then this runs again.
                    await wiki.loadSpaces()
                    return
                }
                // What came after the reader's last look is new, and this look moves the stamp (design §12.3.2,
                // the web home's `readWikiSeen`, then `moveWikiSeen`).
                seen = wiki.seen(slug)
                wiki.moveSeen(slug)
                await load(wiki)
            }
            .refreshable { await load(wiki) }
            .sheet(isPresented: $contentsShown) {
                WikiContentsScreen(at: .home) { pick in go(pick) }
            }
        } else {
            ProgressView()
        }
    }

    /// The home's reads, and the plan's beside them — the count on the Contents' Plan row — through a task
    /// handle, not `async let` (d22b276cc).
    private func load(_ wiki: WikiModel) async {
        let planRead = Task { await wiki.loadPlan() }
        defer { planRead.cancel() }
        await wiki.loadHome()
        await planRead.value
    }

    /// Where a Contents row goes: the home is where the reader already is; the rest open as pages.
    private func go(_ pick: WikiContentsPick) {
        switch pick {
        case .home:                         break
        case .browse:                       open(.wikiBrowse)
        case .index:                        open(.wikiIndex)
        case .plan:                         open(.wikiPlan(version: nil))
        case .article(let topic, let part): open(.wikiArticle(topic: topic, part: part))
        case .doc(let slug, let section):   open(.wikiDoc(slug: slug, section: section))
        }
    }

    private func actions(_ wiki: WikiModel) -> WikiHomeActions {
        WikiHomeActions(
            openEntry: { id in open(.wikiEntry(entryID: id)) },
            // The home reads the space picked as its task's id changes.
            pickSpace: { slug in wiki.selectedSlug = slug },
            search: { query in await wiki.search(query) },
            openSettings: { open(.wikiSettings) },
            openContents: { contentsShown = true },
            openActivity: { open(.wikiActivity) },
            openDoc: { slug in go(.doc(slug: slug, section: nil)) },
            openArticle: { topic in go(.article(topic: topic, part: 0)) },
            openBrowse: { go(.browse) },
            openIndex: { go(.index) },
            retry: { Task { await load(wiki) } })
    }

    /// A phone pushes the page; the three-column shells put it in the detail pane beside the directory.
    private func open(_ node: NavNode) {
        switch rowNavigation {
        case .push:      model.push(node)
        case .selection: model.nav.replaceTop(with: node)
        }
    }
}

/// What stands where the home page — or Activity — would be: a spinner, the reason it could not be read,
/// or — only after a read that succeeded — that there is no space yet, or that the wiki is off for this
/// account.
struct WikiHomePlaceholder: View {
    let wiki: WikiModel
    /// The read the page waits on: the spaces list, for the home's head; Activity's own.
    let state: ListLoadState
    let retry: () async -> Void

    var body: some View {
        if wiki.disabled {
            WikiDisabledNote()
        } else if state.lastLoadFailed {
            ContentUnavailableView {
                Label("The wiki couldn't be loaded", systemImage: AppSection.wiki.systemImage)
            } description: {
                Text("Check the connection, then try again.")
            } actions: {
                Button("Retry") { Task { await retry() } }
            }
        } else if wiki.spacesState.hasLoaded && wiki.spaces.isEmpty {
            ContentUnavailableView(WikiCopy.title, systemImage: AppSection.wiki.systemImage,
                                   description: Text(WikiCopy.noSpaces))
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// The Wiki section's detail on the three-column shells: whichever page is on top of its stack, and with
/// nothing opened over it the space's home — Home lit in the directory column beside it (mock 32).
struct WikiDetailPane: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let id = model.selectedWikiEntryID {
            WikiEntryView(entryID: id).id(id)
        } else if model.nav.wikiReviewOnTop {
            WikiReviewView()
        } else if model.nav.wikiActivityOnTop {
            WikiActivityView()
        } else if model.nav.wikiSettingsOnTop {
            WikiSettingsView()
        } else if let run = model.nav.selectedWikiRunID {
            WikiRunView(changesetID: run).id(run)
        } else if let article = model.nav.selectedWikiArticle {
            WikiArticleScreen(address: article).id(article)
        } else if model.nav.wikiBrowseOnTop {
            WikiBrowseScreen()
        } else if model.nav.wikiIndexOnTop {
            WikiIndexScreen()
        } else if let doc = model.nav.selectedWikiDoc {
            WikiDocScreen(address: doc).id(doc)
        } else if let plan = model.nav.selectedWikiPlan {
            WikiPlanScreen(address: plan).id(plan)
        } else if model.wiki?.disabled == true {
            WikiDisabledNote()
        } else {
            WikiHomeView(rowNavigation: .selection)
        }
    }
}

/// The Wiki section reached on an account the server has not switched the wiki on for — a link, or a
/// section kept from before: the web page's own sentence, not a failure to retry.
struct WikiDisabledNote: View {
    var body: some View {
        ContentUnavailableView(WikiCopy.title, systemImage: AppSection.wiki.systemImage,
                               description: Text(WikiCopy.disabledNote))
    }
}

// MARK: - the articles

/// The Contents sheet over the model's directory, read when it opens.
struct WikiContentsScreen: View {
    @Environment(AppModel.self) private var model
    let at: WikiContentsAt
    let pick: (WikiContentsPick) -> Void

    var body: some View {
        if let wiki = model.wiki {
            // A space with a confirmed plan reads by its documents; before one, by its topic articles.
            let docGroups = WikiDocLogic.readsByDocs(wiki.docsDirectory) ? wiki.docsDirectory.map(WikiDocLogic.directoryGroups) ?? [] : []
            WikiContentsSheet(groups: docGroups.isEmpty ? wiki.directory.map(WikiArticleLogic.directoryGroups) ?? [] : [], at: at,
                              docGroups: docGroups,
                              planPending: wiki.plan.map { WikiPlanLogic.pending($0, runnerOnline: model.wikiMaintenanceRunnerOnline) } ?? 0,
                              pick: pick)
                .task {
                    await wiki.loadDocsDirectory()
                    await wiki.loadDirectory()
                    await wiki.loadPlan()
                }
        } else {
            ProgressView()
        }
    }
}

/// The article and document pages push what they open onto the section's stack; Contents' Home goes back
/// to the root.
@MainActor func wikiGo(_ model: AppModel, _ pick: WikiContentsPick) {
    switch pick {
    case .home:                         model.nav.popToRoot()
    case .browse:                       model.push(.wikiBrowse)
    case .index:                        model.push(.wikiIndex)
    case .plan:                         model.push(.wikiPlan(version: nil))
    case .article(let topic, let part): model.push(.wikiArticle(topic: topic, part: part))
    case .doc(let slug, let section):   model.push(.wikiDoc(slug: slug, section: section))
    }
}

/// One of a topic's articles, or — while the topic has none — its entries alone.
struct WikiArticleScreen: View {
    @Environment(AppModel.self) private var model
    let address: WikiArticleAddress

    @State private var contentsShown = false

    var body: some View {
        if let wiki = model.wiki {
            Group {
                if let article = wiki.articles[address] {
                    // The entries it was written from, as its read carries them; an older server's
                    // read carries none, and the topic's own entries stand in.
                    WikiArticlePage(article: article, entries: article.entries ?? wiki.topicEntries[address.topic],
                                    detail: { id in wiki.detail(id) }, actions: actions(wiki))
                } else if wiki.missingArticles.contains(address) {
                    WikiTopicEntriesPage(title: topicTitle(wiki), entries: wiki.topicEntries[address.topic] ?? [],
                                         actions: actions(wiki))
                } else if wiki.failedArticles.contains(address) {
                    ContentUnavailableView {
                        Label("The article couldn't be loaded", systemImage: AppSection.wiki.systemImage)
                    } description: {
                        Text("Check the connection, then try again.")
                    } actions: {
                        Button("Retry") { Task { await wiki.loadArticle(address) } }
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .task {
                await wiki.loadArticle(address)
                if wiki.missingArticles.contains(address) && wiki.directory == nil { await wiki.loadDirectory() }
            }
            .refreshable { await wiki.loadArticle(address) }
            .sheet(isPresented: $contentsShown) {
                WikiContentsScreen(at: .article(topic: address.topic, part: address.part)) { pick in wikiGo(model, pick) }
            }
        } else {
            ProgressView()
        }
    }

    /// The topic's name, as the directory has it; its slug before the directory is read.
    private func topicTitle(_ wiki: WikiModel) -> String {
        let groups = wiki.directory.map(WikiArticleLogic.directoryGroups) ?? []
        for group in groups {
            if let topic = group.topics.first(where: { $0.slug == address.topic }) { return topic.title }
        }
        return address.topic
    }

    private func actions(_ wiki: WikiModel) -> WikiArticleActions {
        WikiArticleActions(
            openEntry: { id in model.push(.wikiEntry(entryID: id)) },
            openArticle: { topic, part in model.push(.wikiArticle(topic: topic, part: part)) },
            openBrowse: { model.push(.wikiBrowse) },
            openContents: { contentsShown = true },
            readEntry: { id in Task { await wiki.loadEntry(id) } })
    }
}

/// A topic with no article yet: its entries by kind, and why there is no text over them.
struct WikiTopicEntriesPage: View {
    let title: String
    let entries: [WikiEntry]
    var actions = WikiArticleActions()

    var body: some View {
        List {
            Section {
                Text(title)
                    .font(.title.bold())
                    .listRowSeparator(.hidden)
                Text(WikiArticleCopy.noArticleYet)
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .listRowSeparator(.hidden)
            }
            ForEach(WikiArticleLogic.entryGroups(entries, cited: [])) { group in
                Section(group.title) {
                    ForEach(group.entries) { entry in
                        Button { actions.openEntry(entry.id) } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(entry.displayTitle)
                                    .font(.orbitProse)
                                    .foregroundStyle(Color.primary)
                                    .lineLimit(1)
                                Spacer(minLength: 8)
                                if let trust = entry.trust, trust != .unknown {
                                    WikiBadge(text: WikiCopy.trustLabel(trust), tone: WikiLogic.trustTone(trust))
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .listStyle(.plain)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(action: actions.openContents) { Image(systemName: "list.bullet") }
                    .accessibilityLabel(WikiArticleCopy.contents)
            }
        }
    }
}

/// Browse by category over the model's directory.
struct WikiBrowseScreen: View {
    @Environment(AppModel.self) private var model
    @State private var contentsShown = false

    var body: some View {
        if let wiki = model.wiki {
            Group {
                if let directory = wiki.docsDirectory, WikiDocLogic.readsByDocs(directory) {
                    WikiDocsBrowsePage(directory: directory,
                                       actions: WikiDocActions(openDoc: { slug in model.push(.wikiDoc(slug: slug, section: nil)) },
                                                               openContents: { contentsShown = true }),
                                       openSection: { slug, key in model.push(.wikiDoc(slug: slug, section: key)) })
                } else {
                    WikiBrowsePage(categories: wiki.directory.map(WikiArticleLogic.browseCategories) ?? [],
                                   actions: WikiArticleActions(
                                       openArticle: { topic, part in model.push(.wikiArticle(topic: topic, part: part)) },
                                       openContents: { contentsShown = true }))
                }
            }
            .task {
                await wiki.loadDocsDirectory()
                await wiki.loadDirectory()
            }
            .refreshable {
                await wiki.loadDocsDirectory()
                await wiki.loadDirectory()
            }
            .sheet(isPresented: $contentsShown) {
                WikiContentsScreen(at: .browse) { pick in wikiGo(model, pick) }
            }
        } else {
            ProgressView()
        }
    }
}

/// The A–Z index over the model's index read.
struct WikiIndexScreen: View {
    @Environment(AppModel.self) private var model
    @State private var contentsShown = false

    var body: some View {
        if let wiki = model.wiki {
            Group {
                if let index = wiki.docIndex, index.plan != nil {
                    WikiDocsIndexPage(items: index.items,
                                      actions: WikiDocActions(openDoc: { slug in model.push(.wikiDoc(slug: slug, section: nil)) },
                                                              openContents: { contentsShown = true }),
                                      openSection: { slug, key in model.push(.wikiDoc(slug: slug, section: key)) })
                } else {
                    let items = wiki.articleIndex?.items ?? []
                    WikiIndexPage(groups: WikiArticleLogic.indexGroups(items), count: items.count,
                                  actions: WikiArticleActions(
                                      openArticle: { topic, part in model.push(.wikiArticle(topic: topic, part: part)) },
                                      openContents: { contentsShown = true }))
                }
            }
            .task {
                await wiki.loadDocIndex()
                await wiki.loadArticleIndex()
            }
            .refreshable {
                await wiki.loadDocIndex()
                await wiki.loadArticleIndex()
            }
            .sheet(isPresented: $contentsShown) {
                WikiContentsScreen(at: .index) { pick in wikiGo(model, pick) }
            }
        } else {
            ProgressView()
        }
    }
}

// MARK: - one entry

/// One entry's page, and the three forms its actions open.
struct WikiEntryView: View {
    @Environment(AppModel.self) private var model
    let entryID: String

    private enum Form: Identifiable {
        case edit, supersede
        var id: Self { self }
    }

    @State private var form: Form?
    @State private var retiring = false
    @State private var reason = ""
    @State private var notice: String?
    @State private var noticeTitle = WikiCopy.entrySaveFailed

    var body: some View {
        if let wiki = model.wiki {
            TimelineView(.periodic(from: .now, by: 60)) { context in
                if wiki.disabled {
                    WikiDisabledNote()
                } else if let detail = wiki.detail(entryID) {
                    WikiEntryPage(detail: detail, now: context.date,
                                  sessionTitle: { id in
                                      Self.card(.session, id).flatMap(title(of:))
                                          ?? model.session(id: PublicID.toPublic(id))?.title
                                  },
                                  sourceTitle: { source in Self.card(for: source).flatMap(title(of:)) },
                                  busy: wiki.busy, actions: actions(wiki, detail))
                } else if wiki.isMissing(entryID) {
                    ContentUnavailableView(WikiCopy.noEntrySelected, systemImage: AppSection.wiki.systemImage)
                } else if wiki.loadFailed(entryID) {
                    ContentUnavailableView {
                        Label("The entry couldn't be loaded", systemImage: AppSection.wiki.systemImage)
                    } description: {
                        Text("Check the connection, then try again.")
                    } actions: {
                        Button("Retry") { Task { await wiki.loadEntry(entryID) } }
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .task { await wiki.loadEntry(entryID) }
            .refreshable { await wiki.loadEntry(entryID) }
            // The cards this page names are asked for whenever what it names changes — on the first
            // read and after every re-read — in one batch.
            .task(id: wiki.detail(entryID)) { noteCards(wiki) }
            .onAppear { wiki.entryAppeared(entryID) }
            .onDisappear { wiki.entryDisappeared(entryID) }
            .sheet(item: $form) { form in
                if let detail = wiki.detail(entryID) {
                    WikiEntryForm(mode: form == .edit ? .edit : .supersede, entry: detail.entry) { title, summary in
                        let answer = form == .edit
                            ? await wiki.edit(detail.entry, title: title, summary: summary)
                            : await wiki.supersede(detail.entry, title: title, summary: summary)
                        finish(answer, done: form == .edit ? WikiCopy.saved : WikiCopy.superseded,
                               failure: form == .edit ? WikiCopy.entrySaveFailed : WikiCopy.entrySupersedeFailed)
                        return answer == nil
                    }
                }
            }
            .alert(WikiCopy.retire, isPresented: $retiring) {
                TextField(WikiCopy.reasonPlaceholder, text: $reason)
                Button("Cancel", role: .cancel) { reason = "" }
                Button(WikiCopy.retireConfirm, role: .destructive) {
                    let why = reason.trimmingCharacters(in: .whitespacesAndNewlines)
                    reason = ""
                    guard let entry = wiki.detail(entryID)?.entry, !why.isEmpty else { return }
                    Task { finish(await wiki.retire(entry, reason: why), done: WikiCopy.retired, failure: WikiCopy.entryRetireFailed) }
                }
                // A retirement says why, as the web's does: no reason, no Retire.
                .disabled(reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            } message: {
                Text(WikiCopy.retireNote)
            }
            .alert(noticeTitle, isPresented: Binding(get: { notice != nil },
                                                          set: { if !$0 { notice = nil } })) {
                Button("OK", role: .cancel) { notice = nil }
            } message: {
                Text(notice ?? "")
            }
        } else {
            ProgressView()
        }
    }

    private func actions(_ wiki: WikiModel, _ detail: WikiEntryDetail) -> WikiEntryActions {
        WikiEntryActions(
            edit: { form = .edit },
            supersede: { form = .supersede },
            retire: { retiring = true },
            copyLink: { copyLink(wiki, detail.entry) },
            openSession: { id in model.openFromConversation(.session(PublicID.toPublic(id)), overConsole: false) },
            openTask: { id in model.route(to: .task(PublicID.toPublic(id))) },
            confirm: {
                Task { finish(await wiki.confirm(detail.entry), done: WikiModeCopy.confirmed, failure: WikiCopy.entryConfirmFailed) }
            },
            reject: { reason in
                Task { finish(await wiki.reject(detail.entry.id, reason: reason), done: WikiModeCopy.rejected, failure: WikiCopy.entryRejectFailed) }
            })
    }

    // MARK: the titles a card read gives

    /// The task or session a source cites, as an Orbit link — the two kinds the web draws as the
    /// conversation's own link cards. A turn names its session.
    private static func card(for source: WikiSource) -> OrbitLinkRef? {
        guard let ref = source.ref else { return nil }
        switch source.kind {
        case .task?: return card(.task, ref)
        case .turn?: return source.locator?["turnId"] == nil ? nil : card(.session, ref)
        default:     return nil
        }
    }

    private static func card(_ kind: OrbitLinkKind, _ id: String) -> OrbitLinkRef? {
        guard let uuid = PublicID.toUUID(id) else { return nil }
        return OrbitLinkRef(target: OrbitLinkTarget(kind: kind, id: uuid),
                            source: .reference("orbit-\(kind.rawValue):\(PublicID.toPublic(uuid))"))
    }

    /// The title its card read gave, once one has.
    private func title(of ref: OrbitLinkRef) -> String? {
        guard let content = model.linkCards?.content(for: ref), content.state == .ready else { return nil }
        return content.title
    }

    /// Ask the app's one card store for the objects this page names — one batched read, the one the
    /// web's page makes (`link-previews`), and nothing re-read that is still current.
    private func noteCards(_ wiki: WikiModel) {
        guard let detail = wiki.detail(entryID) else { return }
        let sources = detail.sources.compactMap(Self.card(for:))
        let sessions = detail.exposure.compactMap(\.sessionId).compactMap { Self.card(.session, $0) }
        model.linkCards?.note(sources + sessions)
    }

    /// The entry's page on the web — `/wiki/<space>/e/<id>` — the drawer's own Copy link.
    private func copyLink(_ wiki: WikiModel, _ entry: WikiEntry) {
        let slug = wiki.spaces.first { PublicID.storageKey($0.id) == PublicID.storageKey(entry.spaceId ?? "") }?.slug
            ?? wiki.currentSpace?.slug
        guard let baseURL = model.baseURL,
              let url = OrbitLinkParser.pageURL(for: OrbitLinkTarget(kind: .wiki, id: entry.id),
                                                baseURL: baseURL, wikiSpaceSlug: slug) else { return }
        PlatformPasteboard.copyString(url.absoluteString)
        model.showToast(WikiCopy.linkCopied)
    }

    private func finish(_ answer: String?, done: String, failure: String) {
        if let answer {
            noticeTitle = failure
            notice = answer
        } else {
            model.showToast(done)
        }
    }
}

/// Edit or Supersede: the title and the one-line summary, and what the write does.
private struct WikiEntryForm: View {
    enum Mode { case edit, supersede }

    let mode: Mode
    let entry: WikiEntry
    /// The write; true when it landed and the form can close.
    let submit: (String, String) async -> Bool

    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var summary: String
    @State private var saving = false

    init(mode: Mode, entry: WikiEntry, submit: @escaping (String, String) async -> Bool) {
        self.mode = mode
        self.entry = entry
        self.submit = submit
        _title = State(initialValue: entry.title ?? "")
        _summary = State(initialValue: entry.summary ?? "")
    }

    private var blank: Bool {
        title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(WikiCopy.titlePlaceholder, text: $title)
                    TextField(WikiCopy.summaryPlaceholder, text: $summary, axis: .vertical)
                        .lineLimit(2...5)
                } footer: {
                    Text(mode == .edit ? WikiCopy.editNote : WikiCopy.supersedeNote)
                }
            }
            .navigationTitle(mode == .edit ? WikiCopy.edit : WikiCopy.supersede)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(mode == .edit ? WikiCopy.save : WikiCopy.supersedeConfirm) {
                        saving = true
                        let newTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
                        let newSummary = summary.trimmingCharacters(in: .whitespacesAndNewlines)
                        Task {
                            let landed = await submit(newTitle, newSummary)
                            saving = false
                            if landed { dismiss() }
                        }
                    }
                    .disabled(blank || saving)
                }
            }
        }
    }
}

// MARK: - Review

/// Review: every space's proposals waiting for the owner, one card at a time.
struct WikiReviewView: View {
    @Environment(AppModel.self) private var model

    @State private var editing: WikiLogic.ReviewCard?
    /// A challenge whose Amend form is open.
    @State private var amending: WikiLogic.ReviewCard?
    @State private var notice: String?

    var body: some View {
        if let wiki = model.wiki {
            TimelineView(.periodic(from: .now, by: 60)) { context in
                if wiki.reviewState.hasLoaded || !wiki.review.isEmpty {
                    WikiReviewPage(cards: wiki.reviewCards,
                                   entry: { id in wiki.detail(id)?.entry },
                                   now: context.date, busy: wiki.busy, actions: actions(wiki))
                } else if wiki.reviewState.lastLoadFailed {
                    ContentUnavailableView {
                        Label("Review couldn't be loaded", systemImage: AppSection.wiki.systemImage)
                    } actions: {
                        Button("Retry") { Task { await wiki.loadReview() } }
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .task { await wiki.loadReview() }
            // The entries the waiting ops name — an amend's "before", a retire's title — read as the
            // queue changes, not only when the page first appears.
            .task(id: wiki.review.map(\.id)) { await wiki.loadEntriesNamed(by: wiki.reviewCards) }
            .refreshable { await wiki.loadReview() }
            .sheet(item: $editing) { card in
                WikiProposalForm(card: card, entry: card.op.entryId.flatMap { wiki.detail($0)?.entry }) { edited in
                    let answer = await wiki.decide(card, .edit, edited: edited)
                    finish(answer, card: card, action: .edit, renamed: edited.title)
                    return answer == nil
                }
            }
            .sheet(item: $amending) { card in
                if let entry = card.op.entryId.flatMap({ wiki.detail($0)?.entry }) {
                    WikiChallengeAmendForm(entry: entry) { edited in
                        let answer = await wiki.decide(card, .amend, edited: edited)
                        finish(answer, card: card, action: .amend, renamed: edited.title)
                        return answer == nil
                    }
                }
            }
            .alert(WikiCopy.decideFailed, isPresented: Binding(get: { notice != nil },
                                                          set: { if !$0 { notice = nil } })) {
                Button("OK", role: .cancel) { notice = nil }
            } message: {
                Text(notice ?? "")
            }
        } else {
            ProgressView()
        }
    }

    private func actions(_ wiki: WikiModel) -> WikiReviewActions {
        WikiReviewActions(
            decide: { card, action, reason in
                Task {
                    let answer = await wiki.decide(card, action, reason: reason)
                    finish(answer, card: card, action: action)
                }
            },
            edit: { card in editing = card },
            openSession: { id in model.openFromConversation(.session(PublicID.toPublic(id)), overConsole: false) },
            amend: { card in amending = card })
    }

    /// A refusal opens the alert with the server's reason. An answer that landed floats its outcome
    /// in the answer's own words, with the entry it was about under it — by then the pager has moved
    /// on to the next card, so a bare "Decided" named neither. An edit names the entry by the title
    /// the owner gave it.
    private func finish(_ answer: String?, card: WikiLogic.ReviewCard, action: WikiDecideAction,
                        renamed: String? = nil) {
        if let answer {
            notice = answer
        } else {
            let entry = card.op.entryId.flatMap { model.wiki?.detail($0)?.entry }
            model.showToast(WikiLogic.decidedToast(op: card.op.op, action: action),
                            subtitle: renamed ?? WikiLogic.knownTitle(card, entry: entry))
        }
    }
}

/// A challenge's Amend: the owner's version of the entry it names — its title and one line — written
/// as the owner's revision; the anchors are checked again (contract `anchorRules.verify.answers.amend`).
/// Only what changed is sent, and with nothing changed the answer waits: an Amend that changes nothing
/// is a Re-confirm.
private struct WikiChallengeAmendForm: View {
    let entry: WikiEntry
    let submit: (WikiEntryChanges) async -> Bool

    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var summary: String
    @State private var saving = false

    init(entry: WikiEntry, submit: @escaping (WikiEntryChanges) async -> Bool) {
        self.entry = entry
        self.submit = submit
        _title = State(initialValue: entry.title ?? "")
        _summary = State(initialValue: entry.summary ?? "")
    }

    private var changes: WikiEntryChanges {
        let newTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let newSummary = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        return WikiEntryChanges(
            title: newTitle != (entry.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines) ? newTitle : nil,
            summary: newSummary != (entry.summary ?? "").trimmingCharacters(in: .whitespacesAndNewlines) ? newSummary : nil)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(WikiCopy.titlePlaceholder, text: $title)
                    TextField(WikiCopy.summaryPlaceholder, text: $summary, axis: .vertical)
                        .lineLimit(2...5)
                } footer: {
                    Text(WikiModeCopy.amendNote)
                }
            }
            .navigationTitle(WikiModeCopy.amend)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(WikiModeCopy.cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(WikiModeCopy.amend) {
                        saving = true
                        let edited = changes
                        Task {
                            let landed = await submit(edited)
                            saving = false
                            if landed { dismiss() }
                        }
                    }
                    .disabled(saving || (changes.title == nil && changes.summary == nil)
                              || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

/// Edit on a Review card: the owner's version of the proposal's title and one line, accepted as
/// theirs. For an amendment the other changes it proposed ride along untouched.
private struct WikiProposalForm: View {
    let card: WikiLogic.ReviewCard
    let entry: WikiEntry?
    let submit: (WikiEntryChanges) async -> Bool

    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var summary: String
    @State private var saving = false

    init(card: WikiLogic.ReviewCard, entry: WikiEntry?, submit: @escaping (WikiEntryChanges) async -> Bool) {
        self.card = card
        self.entry = entry
        self.submit = submit
        let payload = card.op.payload
        let draft = payload?["entry"] ?? payload?["changes"]
        _title = State(initialValue: draft?["title"]?.stringValue ?? entry?.title ?? "")
        _summary = State(initialValue: draft?["summary"]?.stringValue ?? entry?.summary ?? "")
    }

    /// The owner's version: an add or a supersede merges it over the draft on the server; an amend's
    /// version replaces the proposed changes, so the ones this form does not show are carried over.
    private var edited: WikiEntryChanges {
        var changes = WikiEntryChanges(title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                                       summary: summary.trimmingCharacters(in: .whitespacesAndNewlines))
        if card.op.op == .amend, let proposed = card.op.payload?["changes"] {
            changes.fields = proposed["fields"]
            if case .array(let topics)? = proposed["topics"] { changes.topics = topics.compactMap(\.stringValue) }
            if case .array(let aliases)? = proposed["aliases"] { changes.aliases = aliases.compactMap(\.stringValue) }
            // As written, not as echoed: the server's copy carries keys an anchor is refused with.
            if case .array(let anchors)? = proposed["anchors"] { changes.anchors = anchors.map(WikiLogic.anchorInput) }
        }
        return changes
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(WikiCopy.titlePlaceholder, text: $title)
                    TextField(WikiCopy.summaryPlaceholder, text: $summary, axis: .vertical)
                        .lineLimit(2...5)
                } footer: {
                    Text(WikiCopy.acceptNote)
                }
            }
            .navigationTitle(WikiCopy.reviewEdit)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(WikiCopy.accept) {
                        saving = true
                        let version = edited
                        Task {
                            let landed = await submit(version)
                            saving = false
                            if landed { dismiss() }
                        }
                    }
                    .disabled(saving || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}
