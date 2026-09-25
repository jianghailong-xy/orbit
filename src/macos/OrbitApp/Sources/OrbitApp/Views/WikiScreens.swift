import SwiftUI
import OrbitKit

// The Wiki section's screens: each reads `AppModel.wiki`, mounts one of `WikiView.swift`'s pages over
// what it read, and decides where a press goes — pushed onto the section's stack on a phone, selected
// into the detail pane on the three-column shells. The pages themselves know neither.

/// The Wiki section's root: the home page of the space the owner last picked.
struct WikiHomeView: View {
    @Environment(AppModel.self) private var model
    /// How rows navigate: the three-column shells select, the compact stack pushes.
    var rowNavigation: SessionRowNavigation = .selection

    var body: some View {
        if let wiki = model.wiki {
            TimelineView(.periodic(from: .now, by: 60)) { context in
                if let home = wiki.home {
                    WikiHomePage(content: home, now: context.date, actions: actions(wiki))
                } else {
                    WikiHomePlaceholder(wiki: wiki)
                }
            }
            .task { await wiki.loadHome() }
            .refreshable { await wiki.loadHome() }
        } else {
            ProgressView()
        }
    }

    private func actions(_ wiki: WikiModel) -> WikiHomeActions {
        WikiHomeActions(
            openEntry: { id in open(.wikiEntry(entryID: id)) },
            openReview: { open(.wikiReview) },
            pickSpace: { slug in
                wiki.selectedSlug = slug
                Task { await wiki.loadHome() }
            },
            search: { query in await wiki.search(query) })
    }

    /// A phone pushes the page; the three-column shells put it in the detail pane beside the list.
    private func open(_ node: NavNode) {
        switch rowNavigation {
        case .push:      model.push(node)
        case .selection: model.nav.replaceTop(with: node)
        }
    }
}

/// What stands where the home page would be: a spinner, the reason it could not be read, or — only
/// after a read that succeeded — that there is no space yet.
private struct WikiHomePlaceholder: View {
    let wiki: WikiModel

    var body: some View {
        if wiki.homeState.lastLoadFailed {
            ContentUnavailableView {
                Label("The wiki couldn't be loaded", systemImage: AppSection.wiki.systemImage)
            } description: {
                Text("Check the connection, then try again.")
            } actions: {
                Button("Retry") { Task { await wiki.loadHome() } }
            }
        } else if wiki.homeState.hasLoaded && wiki.spaces.isEmpty {
            ContentUnavailableView(WikiCopy.title, systemImage: AppSection.wiki.systemImage,
                                   description: Text(WikiCopy.noSpaces))
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// The Wiki section's detail on the three-column shells: whichever page is on top of its stack.
struct WikiDetailPane: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let id = model.selectedWikiEntryID {
            WikiEntryView(entryID: id).id(id)
        } else if model.nav.wikiReviewOnTop {
            WikiReviewView()
        } else {
            ContentUnavailableView(WikiCopy.title, systemImage: AppSection.wiki.systemImage,
                                   description: Text("Pick an entry, or open Review."))
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

    var body: some View {
        if let wiki = model.wiki {
            TimelineView(.periodic(from: .now, by: 60)) { context in
                if let detail = wiki.detail(entryID) {
                    WikiEntryPage(detail: detail, now: context.date,
                                  sessionTitle: { model.session(id: PublicID.toPublic($0))?.title },
                                  busy: wiki.busy, actions: actions(wiki, detail))
                } else if wiki.isMissing(entryID) {
                    ContentUnavailableView(WikiCopy.noEntrySelected, systemImage: AppSection.wiki.systemImage)
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .task { await wiki.loadEntry(entryID) }
            .refreshable { await wiki.loadEntry(entryID) }
            .sheet(item: $form) { form in
                if let detail = wiki.detail(entryID) {
                    WikiEntryForm(mode: form == .edit ? .edit : .supersede, entry: detail.entry) { title, summary in
                        let answer = form == .edit
                            ? await wiki.edit(detail.entry, title: title, summary: summary)
                            : await wiki.supersede(detail.entry, title: title, summary: summary)
                        finish(answer, done: form == .edit ? WikiCopy.saved : WikiCopy.superseded)
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
                    Task { finish(await wiki.retire(entry, reason: why), done: WikiCopy.retired) }
                }
            } message: {
                Text(WikiCopy.retireNote)
            }
            .alert(WikiCopy.refused, isPresented: Binding(get: { notice != nil },
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
            openTask: { id in model.route(to: .task(PublicID.toPublic(id))) })
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

    private func finish(_ answer: String?, done: String) {
        if let answer {
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
            .task {
                await wiki.loadReview()
                await wiki.loadEntriesNamed(by: wiki.reviewCards)
            }
            .refreshable { await wiki.loadReview() }
            .sheet(item: $editing) { card in
                WikiProposalForm(card: card, entry: card.op.entryId.flatMap { wiki.detail($0)?.entry }) { edited in
                    let answer = await wiki.decide(card, .edit, edited: edited)
                    finish(answer, done: WikiCopy.decided)
                    return answer == nil
                }
            }
            .alert(WikiCopy.refused, isPresented: Binding(get: { notice != nil },
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
                    finish(answer, done: action == .reject ? WikiCopy.rejected : WikiCopy.decided)
                }
            },
            edit: { card in editing = card },
            openSession: { id in model.openFromConversation(.session(PublicID.toPublic(id)), overConsole: false) })
    }

    private func finish(_ answer: String?, done: String) {
        if let answer {
            notice = answer
        } else {
            model.showToast(done)
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
            if case .array(let anchors)? = proposed["anchors"] { changes.anchors = anchors }
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
