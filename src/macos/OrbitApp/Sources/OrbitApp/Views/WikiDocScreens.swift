import SwiftUI
import OrbitKit

// The screens of the Wiki's documents and its plan (criterion 10 revised, criterion 11): each reads
// `AppModel.wiki`, mounts one of `WikiDocView.swift`'s or `WikiPlanView.swift`'s pages over what it read, and
// decides where a press goes — pushed onto the Wiki section's stack, which the three-column shells' detail
// pane shows the top of. The pages themselves know neither.

extension AppModel {
    /// The workspace the space's maintenance runs in, as this client holds it.
    private var wikiMaintenanceAgent: Agent? { wikiMaintenanceAgent(of: wiki?.currentSpace) }

    private func wikiMaintenanceAgent(of space: WikiSpace?) -> Agent? {
        guard let id = space?.settings?.maintenance?.workspaceId else { return nil }
        return agents?.items.first { PublicID.storageKey($0.id) == PublicID.storageKey(id) }
    }

    /// The runner a plan job would run on: the maintenance workspace's.
    var wikiMaintenanceRunnerID: String? { wikiMaintenanceAgent?.runnerId }

    /// Whether that runner is online — nil when unknown. A job whose run has not started on a runner that is
    /// offline is held (owner's call 2026-09-29), as the web's `useWikiMaintenanceWhere` reads it.
    var wikiMaintenanceRunnerOnline: Bool? { wikiMaintenanceRunnerOnline(of: wiki?.currentSpace) }

    /// The same of any space: Activity says what waits in the other spaces' plans too.
    func wikiMaintenanceRunnerOnline(of space: WikiSpace?) -> Bool? {
        guard let runner = wikiMaintenanceAgent(of: space)?.runnerId, let online = agents?.runnerOnline else { return nil }
        return online.first { PublicID.storageKey($0.key) == PublicID.storageKey(runner) }?.value
    }

    /// Where a draft runs: `orbit · wikova`, the workspace and its runner.
    var wikiMaintenanceWhere: String? {
        guard let agent = wikiMaintenanceAgent else { return nil }
        return WikiModeLogic.workspaceLabel(name: agent.name, runner: agent.runnerId.flatMap { agents?.runnerNames[$0] })
    }

    /// On what: the provider the space's maintenance is pinned to.
    var wikiMaintenanceProvider: String? { wiki?.currentSpace?.settings?.maintenance?.provider }
}

// MARK: - a document

/// One document of the confirmed plan, read by its slug; a 404 is a document the plan does not have.
struct WikiDocScreen: View {
    @Environment(AppModel.self) private var model
    let address: WikiDocAddress

    @State private var contentsShown = false

    var body: some View {
        if let wiki = model.wiki {
            Group {
                if let doc = wiki.docs[address.slug] {
                    WikiDocPage(doc: doc, github: WikiDocLogic.githubRepo(wiki.currentSpace?.repoUrlNorm), written: written(wiki),
                                summaries: summaries(wiki), section: address.section, actions: actions)
                } else if wiki.missingDocs.contains(address.slug) {
                    ContentUnavailableView(WikiCopy.title, systemImage: AppSection.wiki.systemImage,
                                           description: Text("That document is not in this space’s plan."))
                } else if wiki.failedDocs.contains(address.slug) {
                    ContentUnavailableView {
                        Label("The document couldn't be loaded", systemImage: AppSection.wiki.systemImage)
                    } description: {
                        Text("Check the connection, then try again.")
                    } actions: {
                        Button("Retry") { Task { await wiki.loadDoc(address.slug) } }
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .task {
                await wiki.loadDoc(address.slug)
                await wiki.loadDocsDirectory()
                if wiki.entries.isEmpty { await wiki.loadEntries() }
            }
            .refreshable { await wiki.loadDoc(address.slug) }
            .sheet(isPresented: $contentsShown) {
                WikiContentsScreen(at: .doc(slug: address.slug)) { pick in wikiGo(model, pick) }
            }
        } else {
            ProgressView()
        }
    }

    /// How many of the plan's documents are written, for a document not written yet.
    private func written(_ wiki: WikiModel) -> (written: Int, total: Int)? {
        guard let directory = wiki.docsDirectory, directory.plan != nil, let docs = directory.docs else { return nil }
        return (docs.written, docs.total)
    }

    /// The space's newest entries, by id: the summaries under the entries the quotes came through.
    private func summaries(_ wiki: WikiModel) -> [String: String] {
        var out: [String: String] = [:]
        for entry in wiki.entries { if let summary = entry.summary { out[PublicID.storageKey(entry.id)] = summary } }
        return out
    }

    private var actions: WikiDocActions {
        WikiDocActions(
            openEntry: { id in model.push(.wikiEntry(entryID: id)) },
            openDoc: { slug in model.push(.wikiDoc(slug: slug, section: nil)) },
            openBrowse: { model.push(.wikiBrowse) },
            openContents: { contentsShown = true },
            openSource: { target in open(target) })
    }

    /// A footnote's one button: the session at the quoted record (the deep link criterion 10 rests on),
    /// the task, the session, the project — or the repository's host, at the commit the run read it at.
    private func open(_ target: WikiDocLogic.OpenTarget) {
        switch target {
        case .sessionRecord(let session, let record):
            if !model.openOrbitLink(SessionRecordLink.url(session: session, record: record)) {
                model.open(.session(id: PublicID.toPublic(session)))
            }
        case .task(let id):     model.open(.task(id: PublicID.toPublic(id)))
        case .session(let id):  model.open(.session(id: PublicID.toPublic(id)))
        case .project(let id):  model.open(.project(id: PublicID.toPublic(id)))
        case .external(let url): model.openExternal(url)
        }
    }
}

// MARK: - the plan

/// What an Edit sheet is open on: a document, or one of its sections.
private struct WikiPlanEditTarget: Identifiable, Equatable {
    let slug: String
    let section: Int?
    var id: String { "\(slug):\(section.map(String.init) ?? "-")" }
}

/// The plan page, a document of it, or a section of that, over the model's plan read — and every write the
/// owner makes from them: Draft plan, Redraft…, Confirm plan, Edit, and a change's Accept and Reject.
struct WikiPlanScreen: View {
    @Environment(AppModel.self) private var model
    let address: WikiPlanAddress

    @State private var contentsShown = false
    @State private var redrafting = false
    @State private var editing: WikiPlanEditTarget?
    @State private var refused: [String: [WikiPlanGateError]] = [:]
    @State private var notice: String?
    @State private var noticeTitle = WikiCopy.planDraftFailed

    var body: some View {
        if let wiki = model.wiki {
            content(wiki)
                .task {
                    await wiki.loadPlan()
                    await wiki.loadDocsDirectory()
                    await wiki.loadSystemModel()
                    if let version = address.version { await wiki.loadPlanVersion(version) }
                }
                .refreshable { await wiki.loadPlan() }
                .sheet(isPresented: $contentsShown) {
                    WikiContentsScreen(at: .plan) { pick in wikiGo(model, pick) }
                }
                .sheet(isPresented: $redrafting) { redraftSheet(wiki) }
                .sheet(item: $editing) { target in editSheet(wiki, target) }
                .alert(noticeTitle, isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
                    Button("OK", role: .cancel) { notice = nil }
                } message: {
                    Text(notice ?? "")
                }
        } else {
            ProgressView()
        }
    }

    @ViewBuilder
    private func content(_ wiki: WikiModel) -> some View {
        if let state = wiki.plan {
            let shown = self.shown(state, wiki)
            if let slug = address.doc {
                if let shown, let doc = shown.docs.first(where: { $0.slug == slug }) {
                    let canEdit = (shown.status == .draft || shown.status == .confirmed)
                        && WikiPlanLogic.newest(state)?.version == shown.version && doc.stored != nil
                    if let index = address.section {
                        if index < doc.sections.count {
                            WikiPlanSectionPage(shown: shown, doc: doc, index: index, canEdit: canEdit, actions: actions(wiki))
                        } else {
                            ContentUnavailableView(WikiPlanCopy.title, systemImage: "list.bullet.rectangle",
                                                   description: Text("That section is not in this document."))
                        }
                    } else {
                        WikiPlanDocPage(shown: shown, doc: doc, base: WikiPlanLogic.base(of: shown, in: state), canEdit: canEdit,
                                        actions: actions(wiki))
                    }
                } else if shown == nil {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ContentUnavailableView(WikiPlanCopy.title, systemImage: "list.bullet.rectangle",
                                           description: Text("That document is not in this version of the plan."))
                }
            } else {
                page(state, shown: shown, wiki)
            }
        } else if wiki.planMissing {
            ContentUnavailableView(WikiPlanCopy.title, systemImage: "list.bullet.rectangle", description: Text(WikiPlanCopy.none))
        } else if wiki.planState.lastLoadFailed {
            ContentUnavailableView {
                Label("The plan couldn't be loaded", systemImage: "list.bullet.rectangle")
            } description: {
                Text("Check the connection, then try again.")
            } actions: {
                Button("Retry") { Task { await wiki.loadPlan() } }
            }
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func page(_ state: WikiPlanState, shown: WikiPlanLogic.Shown?, _ wiki: WikiModel) -> some View {
        let failed = WikiPlanLogic.failedJob(state)
        let inForce = shown?.status == .confirmed && state.confirmed?.version == shown?.version
        let online = model.wikiMaintenanceRunnerOnline
        let card = WikiPlanLogic.jobCard(state.job, now: Date(), runnerOnline: online, failed: shown?.status == .failed ? failed : nil,
                                         inForce: inForce, directory: wiki.docsDirectory)
        let rows = WikiPlanLogic.versionRows(wiki.planVersions, failed: failed.map { job -> (version: Int, at: String?) in
            (WikiPlanLogic.nextVersion(state), job.endedAt)
        })
        return WikiPlanPage(state: state, shown: shown, base: shown.flatMap { WikiPlanLogic.base(of: $0, in: state) }, versions: rows,
                            jobCard: card, written: written(wiki), whereItRuns: model.wikiMaintenanceWhere,
                            provider: model.wikiMaintenanceProvider, serverExecutes: wiki.serverExecutes,
                            busy: wiki.busy, refused: refused, actions: actions(wiki))
    }

    /// The version asked for, as the web's page reads it: none is the one shown first; a failed draft's
    /// number is its draft; the draft and the version in force are the read's own; any other is read whole.
    private func shown(_ state: WikiPlanState, _ wiki: WikiModel) -> WikiPlanLogic.Shown? {
        guard let asked = address.version else { return WikiPlanLogic.defaultShown(state) }
        if let failed = WikiPlanLogic.failedJob(state), asked == WikiPlanLogic.nextVersion(state) {
            return WikiPlanLogic.fromFailedJob(failed, number: asked, baseVersion: WikiPlanLogic.newest(state)?.version)
        }
        if let draft = state.draft, draft.version == asked { return WikiPlanLogic.fromVersion(draft) }
        if let confirmed = state.confirmed, confirmed.version == asked { return WikiPlanLogic.fromVersion(confirmed) }
        return wiki.planVersionReads[asked].map(WikiPlanLogic.fromVersion)
    }

    private func written(_ wiki: WikiModel) -> (written: Int, total: Int)? {
        guard let directory = wiki.docsDirectory, directory.plan != nil, let docs = directory.docs else { return nil }
        return (docs.written, docs.total)
    }

    private func actions(_ wiki: WikiModel) -> WikiPlanActions {
        WikiPlanActions(
            draft: { Task { _ = await redraft(wiki, nil) } },
            redraft: { redrafting = true },
            confirm: { version in Task { await confirm(wiki, version) } },
            pickVersion: { version in model.nav.replaceTop(with: .wikiPlan(version: version)) },
            openDoc: { slug in model.push(.wikiPlanDoc(slug: slug, version: address.version)) },
            openSection: { slug, index in model.push(.wikiPlanSection(slug: slug, index: index, version: address.version)) },
            editDoc: { slug in editing = WikiPlanEditTarget(slug: slug, section: nil) },
            editSection: { slug, index in editing = WikiPlanEditTarget(slug: slug, section: index) },
            accept: { proposal, edit in Task { await accept(wiki, proposal, edit: edit) } },
            reject: { proposal in Task { await reject(wiki, proposal) } },
            openRun: { id in model.openFromConversation(.session(PublicID.toPublic(id)), overConsole: false) },
            openSettings: { model.push(.wikiSettings) },
            openRunners: { if let runner = model.wikiMaintenanceRunnerID { model.route(to: .runner(runner)) } },
            openContents: { contentsShown = true },
            openEntry: { id in model.push(.wikiEntry(entryID: id)) })
    }

    // MARK: the writes

    /// Draft plan, or Redraft… with the owner's words. True once the server took it.
    private func redraft(_ wiki: WikiModel, _ words: String?, failure: String = WikiCopy.planDraftFailed) async -> Bool {
        let answer = await wiki.redraftPlan(instructions: words)
        if let refusal = answer.refusal {
            noticeTitle = failure
            notice = refusal
            return false
        }
        model.showToast(answer.created ? WikiPlanCopy.redraftAsked : WikiPlanCopy.redraftAlready)
        return true
    }

    private func confirm(_ wiki: WikiModel, _ version: Int) async {
        switch await wiki.confirmPlan(version: version) {
        case .done(let confirmed):
            model.showToast(WikiPlanCopy.confirmed(confirmed))
            if address.version != nil && address.doc == nil { model.nav.replaceTop(with: .wikiPlan(version: nil)) }
        case .refused(let errors):
            noticeTitle = WikiCopy.planConfirmFailed
            notice = errors.map { "\($0.path) \($0.message)" }.joined(separator: "\n")
        case .failed(let message):
            noticeTitle = WikiCopy.planConfirmFailed
            notice = message
        }
    }

    /// Accept: with no other draft waiting, one press accepts and confirms — two requests, the second only
    /// once the gate passed the first; with a draft waiting, it adds the change to a new draft. Edit accepts
    /// only, and opens the new draft's document to edit.
    private func accept(_ wiki: WikiModel, _ proposal: WikiPlanProposal, edit: Bool) async {
        guard let state = wiki.plan else { return }
        refused[proposal.id] = nil
        let answer = await wiki.acceptPlanProposal(proposal.id, confirm: WikiPlanLogic.acceptConfirms(state) && !edit)
        switch answer.accepted {
        case .done(let version):
            model.showToast(answer.confirmed ? WikiPlanCopy.confirmed(version) : WikiPlanCopy.changeAdded(version))
            if address.version != nil && address.doc == nil { model.nav.replaceTop(with: .wikiPlan(version: nil)) }
            if edit, let slug = proposal.change?.doc.slug { editing = WikiPlanEditTarget(slug: slug, section: nil) }
        case .refused(let errors):
            refused[proposal.id] = errors
        case .failed(let message):
            noticeTitle = edit ? WikiCopy.changeEditFailed : WikiCopy.changeAcceptFailed
            notice = message
        }
    }

    private func reject(_ wiki: WikiModel, _ proposal: WikiPlanProposal) async {
        if let message = await wiki.rejectPlanProposal(proposal.id) {
            noticeTitle = WikiCopy.changeRejectFailed
            notice = message
        } else {
            model.showToast(WikiPlanCopy.changeRejected)
        }
    }

    /// An edit, in the draft's shape. Nil once the server took it, else what to show in the sheet.
    private func save(_ wiki: WikiModel, _ request: WikiPlanEditRequest) async -> [String]? {
        switch await wiki.editPlan(request) {
        case .done(let version):
            model.showToast(WikiPlanCopy.draftSaved(version))
            return nil
        case .refused(let errors):
            return errors.map { "\($0.path) \($0.message)" }
        case .failed(let message):
            return [message]
        }
    }

    // MARK: the sheets

    @ViewBuilder
    private func redraftSheet(_ wiki: WikiModel) -> some View {
        let newest = wiki.plan.flatMap(WikiPlanLogic.newest)
        let protected = newest.map { WikiPlanLogic.fromVersion($0).docs.filter(\.protected).map(\.number) } ?? []
        WikiPlanRedraftSheet(note: WikiPlanCopy.redraftNote(provider: model.wikiMaintenanceProvider,
                                                            from: newest.map { version -> (version: Int, inForce: Bool) in
                                                                (version.version, version.status == .confirmed)
                                                            }),
                             protectedDocs: protected) { words in await redraft(wiki, words, failure: WikiCopy.planRedraftFailed) }
    }

    /// Edit a document, or one of its sections, of the newest version — the draft waiting, else the one in force.
    @ViewBuilder
    private func editSheet(_ wiki: WikiModel, _ target: WikiPlanEditTarget) -> some View {
        if let state = wiki.plan, let newest = WikiPlanLogic.newest(state),
           let doc = WikiPlanLogic.fromVersion(newest).docs.first(where: { $0.slug == target.slug }), let stored = doc.stored {
            let next = WikiPlanLogic.nextVersion(state)
            if let index = target.section, let sections = stored.sections, index < sections.count {
                WikiPlanSectionEditSheet(index: index, stored: sections[index], nextVersion: next) { form in
                    await save(wiki, WikiPlanLogic.sectionEditBody(version: newest.version, slug: stored.slug, section: sections[index], form: form))
                }
            } else {
                WikiPlanEditSheet(number: doc.number, stored: stored, nextVersion: next) { input in
                    await save(wiki, WikiPlanEditRequest(baseVersion: newest.version, docSlug: stored.slug, doc: input))
                }
            }
        }
    }
}
