import Foundation
import Observation
import OrbitKit

/// The account's wiki, behind the Wiki section, the drawer's Wiki row and every entry page. Owned by
/// `AppModel` and rebuilt per instance, like the other section stores.
///
/// Refetched rather than patched: `wiki.changed` names a space and nothing else (contract
/// `realtime.redaction`), so a nudge re-reads what is loaded — the spaces list (the drawer's amber
/// number), the home page on screen, Review, and the entry pages kept — and so does every write this
/// client makes. Nothing depends on the event arriving: the pages also re-read when they appear.
@MainActor
@Observable
final class WikiModel {
    /// Every space, by slug, each with the proposals waiting in it.
    private(set) var spaces: [WikiSpace] = []
    private(set) var spacesState = ListLoadState()
    /// The server said the wiki is not switched on for this account (404 WIKI_DISABLED): an answer,
    /// not a failure — the drawer draws no Wiki row, and the section says why.
    private(set) var disabled = false
    /// The home's content (design §12.3.1): every principle of the space on screen, read by kind — its
    /// documents and topic articles are `docsDirectory` and `directory` — and the space all of it was read
    /// for. Until that is the space on screen the home draws grey bars (`homeLoading`).
    private(set) var principles: [WikiEntry] = []
    private(set) var homeSpaceID: String?
    private(set) var homeState = ListLoadState()
    /// What Activity draws of the space on screen (design §12.3.2), once all five of its reads are in.
    private(set) var activity: WikiHomeContent?
    private(set) var activityState = ListLoadState()
    /// Every changeset with an op still waiting, across the spaces — the queue Review pages through.
    private(set) var review: [WikiChangeset] = []
    private(set) var reviewState = ListLoadState()
    /// Ops answered here whose answer has landed but whose queue has not been read back yet: Review
    /// leaves them out at once, so the pager moves on while the reads that follow a write run.
    private(set) var answered: Set<String> = []
    /// The entry pages read so far, the ones the server would not show, and the ones whose last read
    /// failed with nothing in hand.
    private(set) var details: [String: WikiEntryDetail] = [:]
    private(set) var missing: Set<String> = []
    private(set) var failed: Set<String> = []
    /// A write in flight, so its controls do not take a second press.
    private(set) var busy = false
    /// The space on screen's articles (criterion 10): its category directory, its A–Z index, the
    /// articles read so far and the ones it has none of yet, and each read topic's entries — all of
    /// the space `articlesSpaceID` names, and dropped when another space is picked.
    private(set) var directory: WikiArticleDirectory?
    private(set) var directoryState = ListLoadState()
    private(set) var articleIndex: WikiArticleIndex?
    private(set) var articleIndexState = ListLoadState()
    private(set) var articles: [WikiArticleAddress: WikiArticle] = [:]
    private(set) var missingArticles: Set<WikiArticleAddress> = []
    private(set) var failedArticles: Set<WikiArticleAddress> = []
    private(set) var topicEntries: [String: [WikiEntry]] = [:]
    /// The run pages read so far, each by its own read (`GET /wiki/changesets/:id`), and the ones the
    /// server does not know — by storage key.
    private(set) var runs: [String: WikiChangesetView] = [:]
    private(set) var missingRuns: Set<String> = []
    /// The space on screen's documents (criterion 10 revised): the confirmed plan's directory, the
    /// documents read so far and the ones its plan does not have, and the A–Z index — of the same space
    /// the articles are, and dropped with them when another space is picked.
    private(set) var docsDirectory: WikiDocsDirectory?
    private(set) var docs: [String: WikiDoc] = [:]
    /// The space's newest entries, as many as one read answers (200): the summaries under the entries a
    /// document's quotes came through.
    private(set) var entries: [WikiEntry] = []
    private(set) var missingDocs: Set<String> = []
    private(set) var failedDocs: Set<String> = []
    private(set) var docIndex: WikiDocsIndex?
    /// The space's plan (criterion 11): the version in force, the draft waiting, the proposals, the job —
    /// read on the owner's door only. `planMissing` is a server from before the plan, which has none.
    private(set) var plan: WikiPlanState?
    private(set) var planState = ListLoadState()
    private(set) var planMissing = false
    /// Every version, newest first (the version menu), and the older ones read whole when picked.
    private(set) var planVersions: [WikiPlanVersionSummary] = []
    private(set) var planVersionReads: [Int: WikiPlanVersion] = [:]
    /// The plans of the other spaces where something waits on the owner (`planWaiting`), by space id:
    /// Activity's banners for them (design §12.3.3). Read for Activity, and only those.
    private(set) var otherPlans: [String: WikiPlanState] = [:]
    @ObservationIgnored private var otherPlansRead = false
    /// The space on screen's server runs and their calls (`GET /wiki/spaces/:id/jobs`, P9): Activity's Runs band and a
    /// run's page. Nil until read, and from a control plane that predates the read.
    private(set) var jobs: WikiJobsRead?
    /// The deployment's System model, and whether the server executes this account's wiki (`GET /wiki/system-model`):
    /// what the settings page reads to name the model instead of a provider. Nil until read, and from an older
    /// control plane — which runs nothing on the server.
    private(set) var systemModel: WikiSystemModelStatus?

    private let api: APIClient
    @ObservationIgnored private var nudgeTask: Task<Void, Never>?
    /// The entry pages on screen, by how many views show each — what a nudge re-reads. A page off
    /// screen is read again when it next appears.
    @ObservationIgnored private var onScreen: [String: Int] = [:]

    /// The space the home page shows, by slug — the one picked, or opened by the rule (`open(fromWorkspace:)`),
    /// kept across launches as the last one looked at (`orbit.wiki.space`, design §12.3.4).
    var selectedSlug: String? {
        didSet {
            guard selectedSlug != oldValue else { return }
            UserDefaults.standard.set(selectedSlug, forKey: Self.spaceKey)
        }
    }
    private static let spaceKey = "orbit.wiki.space"

    init(baseURL: URL, tokenStore: TokenStore) {
        api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
        selectedSlug = UserDefaults.standard.string(forKey: Self.spaceKey)
    }

    /// The drawer's amber number — the iPad sidebar's, and the bar's Activity badge: what waits on the owner
    /// across every space, each space's proposals and what its plan waits for, as the web sidebar counts it.
    var waiting: Int { WikiSpaceLogic.waiting(spaces) }

    /// Whether the drawer — and the iPad sidebar, the same rail — draws the Wiki row at all.
    var shown: Bool { WikiLogic.shown(spacesState, disabled: disabled) }

    /// Whether the home's content is still on its first read for the space on screen: its head is drawn from
    /// the spaces list at once, its line and documents as grey bars until then (mock 31 ⑦). A read the home
    /// already has stays drawn while it is read again.
    var homeLoading: Bool { homeSpaceID == nil || homeSpaceID != currentSpace?.id }

    /// The space the pages are about: the one picked or opened, else the one the Wiki opens by its rule.
    var currentSpace: WikiSpace? {
        spaces.first { $0.slug == selectedSlug }
            ?? WikiSpaceLogic.defaultSpace(spaces, workspaceID: fromWorkspaceID, lastSlug: nil)
    }

    /// The workspace the reader was in when they last came into the Wiki (design §12.3.4).
    private(set) var fromWorkspaceID: String?
    /// The reader came into the Wiki: the space it opens is chosen once the spaces are in.
    @ObservationIgnored private var choosing = false

    /// The reader comes into the Wiki from `workspaceID` — nil from a page of no workspace: it opens the space
    /// bound to that workspace, else the one last looked at, else the one with the most documents written
    /// (`WikiSpaceLogic.defaultSpace`), as `/wiki` does on the web. Chosen now, or once the spaces read answers.
    func open(fromWorkspace workspaceID: String?) {
        fromWorkspaceID = workspaceID
        choosing = true
        chooseSpace()
    }

    private func chooseSpace() {
        guard choosing, spacesState.hasLoaded else { return }
        choosing = false
        if let space = WikiSpaceLogic.defaultSpace(spaces, workspaceID: fromWorkspaceID, lastSlug: selectedSlug) {
            selectedSlug = space.slug
        }
    }

    // MARK: since the reader last looked

    /// What each space's stamp said before this run of the app last moved it.
    @ObservationIgnored private var seenLog = WikiSeenLog()

    /// When the reader last looked at the space `slug` (seconds since 1970, 0 for never), as the home reads it
    /// as it opens — before its own look moves it (the web home's `readWikiSeen`).
    func seen(_ slug: String) -> Double {
        UserDefaults.standard.double(forKey: WikiSeenLog.key(space: slug))
    }

    /// When the reader last looked at the space `slug`, as Activity reads it: from before the home moved it as
    /// it opened (`WikiSeenLog`, the web's `readWikiSeenBefore`).
    func seenBefore(_ slug: String) -> Double {
        let key = WikiSeenLog.key(space: slug)
        return seenLog.seenBefore(key, stored: UserDefaults.standard.double(forKey: key))
    }

    /// The reader looks at the space `slug` now — the home as it opens, and Activity (`moveWikiSeen`).
    func moveSeen(_ slug: String, at date: Date = Date()) {
        let key = WikiSeenLog.key(space: slug)
        let now = date.timeIntervalSince1970
        seenLog.move(key, at: now, stored: UserDefaults.standard.double(forKey: key))
        UserDefaults.standard.set(now, forKey: key)
    }

    /// The pending ops Review pages through.
    var reviewCards: [WikiLogic.ReviewCard] {
        WikiLogic.reviewCards(review).filter { !answered.contains($0.op.id) }
    }

    @ObservationIgnored private var articlesSpaceID: String?

    /// An entry page by either spelling of its id.
    func detail(_ id: String) -> WikiEntryDetail? {
        details[PublicID.storageKey(id)]
    }

    func isMissing(_ id: String) -> Bool { missing.contains(PublicID.storageKey(id)) }

    func loadFailed(_ id: String) -> Bool { failed.contains(PublicID.storageKey(id)) }

    func entryAppeared(_ id: String) { onScreen[PublicID.storageKey(id), default: 0] += 1 }

    func entryDisappeared(_ id: String) {
        let key = PublicID.storageKey(id)
        guard let count = onScreen[key] else { return }
        onScreen[key] = count > 1 ? count - 1 : nil
    }

    // MARK: reads

    func loadSpaces() async {
        spacesState.begin()
        do {
            let list = try await api.wikiSpaces()
            if list != spaces { spaces = list }
            disabled = false
            spacesState.succeed()
            chooseSpace()
        } catch let error where WikiLogic.isDisabled(error) {
            disabled = true
            if !spaces.isEmpty { spaces = [] }
            spacesState.succeed()
        } catch {
            spacesState.fail()
        }
    }

    /// The home's content (design §12.3.1), side by side: the principles by kind, the confirmed plan's
    /// documents and the topic articles the home lists before a plan — and the spaces list again, for the
    /// head's numbers. The head needs none of them: it is the spaces list the drawer has already read, and
    /// only a page opened before that read waits for it here.
    func loadHome() async {
        if !spacesState.hasLoaded { await loadSpaces() }
        guard let space = articlesSpace() else {
            if spacesState.lastLoadFailed { homeState.fail() } else { homeState.succeed() }
            return
        }
        homeState.begin()
        // Side by side through task handles, not `async let`: iOS 27's concurrency runtime can abort
        // while tearing down several async-let results in one continuation (d22b276cc).
        let spacesRead = Task { await loadSpaces() }
        // The principles read their own kind: out of the newest 200 entries of every kind, a space of
        // thousands had none of its principles left to show.
        let principlesRead = Task {
            try await api.wikiEntries(spaceID: space.id, kind: .principle, limit: WikiLogic.principlesRead)
        }
        let docsRead = Task { try await api.wikiDocs(spaceID: space.id) }
        let articlesRead = Task { try await api.wikiArticleDirectory(spaceID: space.id) }
        defer {
            spacesRead.cancel()
            principlesRead.cancel()
            docsRead.cancel()
            articlesRead.cancel()
        }
        do {
            let docs = try await docsRead.value
            // The topic articles are what the home lists only before a plan is confirmed.
            let articles: WikiArticleDirectory?
            if WikiDocLogic.readsByDocs(docs) {
                articles = try? await articlesRead.value
            } else {
                articles = try await articlesRead.value
            }
            // Without its principles the home still draws its documents; the ones it had stay.
            let principles = try? await principlesRead.value
            // Another space was picked while this one was reading: its own read owns the page.
            if articlesSpaceID == space.id {
                if docs != docsDirectory { docsDirectory = docs }
                if let articles {
                    if articles != directory { directory = articles }
                    directoryState.succeed()
                }
                if let principles, principles != self.principles { self.principles = principles }
                homeSpaceID = space.id
                homeState.succeed()
            }
        } catch {
            if articlesSpaceID == space.id { homeState.fail() }
        }
        // The head's numbers, read beside the content and never cut short by it.
        await spacesRead.value
    }

    /// What Activity draws (design §12.3.2): the space with its usage window, its newest entries, its newest
    /// decisions by kind, the timeline and its health, side by side — and then each run Recently changed
    /// folds, by its own read.
    func loadActivity() async {
        activityState.begin()
        await loadSpaces()
        guard let space = currentSpace else {
            activity = nil
            if spacesState.lastLoadFailed { activityState.fail() } else { activityState.succeed() }
            return
        }
        // Side by side through task handles, not `async let`: iOS 27's concurrency runtime can abort
        // while tearing down several async-let results in one continuation (d22b276cc).
        let documentRead = Task { try await api.wikiSpace(space.id) }
        let entriesRead = Task { try await api.wikiEntries(spaceID: space.id) }
        // Recent decisions read their own kind: out of the newest 200 entries of every kind, a space of
        // thousands had none of its decisions left to show.
        let decisionsRead = Task {
            try await api.wikiEntries(spaceID: space.id, kind: .decision, limit: WikiHomeContent.recentDecisionCount)
        }
        let timelineRead = Task { try await api.wikiTimeline(spaceID: space.id) }
        let healthRead = Task { try await api.wikiHealth(spaceID: space.id) }
        defer {
            documentRead.cancel()
            entriesRead.cancel()
            decisionsRead.cancel()
            timelineRead.cancel()
            healthRead.cancel()
        }
        do {
            let document = try await documentRead.value
            let entries = try await entriesRead.value
            let decisions = try await decisionsRead.value
            // The timeline is one band of five; the page still draws without it.
            let timeline = try? await timelineRead.value
            // The status line's count and maintenance part (criterion 5); without it the line says what
            // the entries read here count, and nothing of maintenance.
            let health = try? await healthRead.value
            // Every item names its changeset: the runs among the rows are read by their ids, whether or
            // not anything of them still waits in Review. A run whose read failed keeps its row.
            let base = WikiHomeContent(space: document, spaces: spaces, entries: entries,
                                       decisions: decisions, timeline: timeline?.items ?? [])
            let runs = await readRuns(base.recentRunIDs)
            // Another space was picked while this one was reading: its own read owns the page.
            guard currentSpace?.id == space.id else { return }
            let content = WikiHomeContent(space: base.space, spaces: base.spaces, entries: base.entries,
                                          decisions: base.decisionEntries, timeline: base.timeline, runs: runs,
                                          health: health)
            if content != activity { activity = content }
            activityState.succeed()
        } catch {
            guard currentSpace?.id == space.id else { return }
            activityState.fail()
        }
    }

    /// The server's runs of the space on screen (contract `jobs.read`): newest first, each with its newest calls. A
    /// server from before the read answers 404, which reads as none — Activity then draws no Runs band.
    func loadJobs() async {
        guard let space = currentSpace else {
            jobs = nil
            return
        }
        do {
            let read = try await api.wikiJobs(spaceID: space.id)
            // Another space was picked while this one was reading: its own read owns the band.
            guard currentSpace?.id == space.id else { return }
            if read != jobs { jobs = read }
        } catch APIError.http(let status, _) where status == 404 {
            if currentSpace?.id == space.id { jobs = nil }
        } catch {
            // Keep what is on screen; the next pass reads it again.
        }
    }

    /// The space on screen's runs, when the read in hand is that space's.
    var currentJobs: [WikiJob]? {
        guard let jobs, let space = currentSpace, PublicID.storageKey(jobs.spaceId) == PublicID.storageKey(space.id) else { return nil }
        return jobs.jobs
    }

    /// One of the space on screen's runs, by its id.
    func job(_ id: String) -> WikiJob? {
        currentJobs?.first { PublicID.storageKey($0.id) == PublicID.storageKey(id) }
    }

    /// Whether a run of the space on screen is still on its way: what the Runs band and a run's page read again for.
    var jobsUnderWay: Bool {
        (currentJobs ?? []).contains { $0.state == .queued || $0.state == .running || $0.state == .waiting }
    }

    /// The deployment's System model and the executor switch as it stands for this account (contract `systemModel.read`).
    func loadSystemModel() async {
        do {
            let read = try await api.wikiSystemModel()
            if read != systemModel { systemModel = read }
        } catch APIError.http(let status, _) where status == 404 {
            systemModel = nil
        } catch {
            // Keep what is on screen.
        }
    }

    /// The System model while the server executes this account's wiki: what the settings page draws instead of the
    /// provider. Nil under runner, and before the read is in.
    var serverModel: WikiSystemModelStatus? {
        systemModel?.executor?.serverExecutes == true ? systemModel : nil
    }

    /// Whether the server executes this account's wiki (contract `jobs.executor.read`): the plan's empty card
    /// names the System model instead of the provider while it does. False under runner, and before the read is in.
    var serverExecutes: Bool {
        systemModel?.executor?.serverExecutes == true
    }

    /// Every space's queue, which is what the drawer's number and the banner count.
    func loadReview() async {
        reviewState.begin()
        do {
            let queue = try await api.wikiReview()
            if queue != review { review = queue }
            reviewState.succeed()
        } catch {
            reviewState.fail()
        }
    }

    /// One entry's page. A 404 is an entry the server will not show — deleted, or not this account's;
    /// any other failure keeps what is on screen, and says so only when there is nothing on screen. A
    /// 404 WIKI_DISABLED is the wiki off for this account, which a link from a conversation can land on.
    func loadEntry(_ id: String) async {
        let key = PublicID.storageKey(id)
        do {
            let detail = try await api.wikiEntry(id)
            missing.remove(key)
            failed.remove(key)
            if details[key] != detail { details[key] = detail }
        } catch let error where WikiLogic.isDisabled(error) {
            disabled = true
        } catch APIError.http(let status, _) where status == 404 {
            missing.insert(key)
        } catch {
            failed.insert(key)
        }
    }

    // MARK: the articles

    /// The space the article reads are of, forgetting what another space's pages read.
    private func articlesSpace() -> WikiSpace? {
        guard let space = currentSpace else { return nil }
        if articlesSpaceID != space.id {
            articlesSpaceID = space.id
            directory = nil
            directoryState = ListLoadState()
            articleIndex = nil
            articleIndexState = ListLoadState()
            articles = [:]
            missingArticles = []
            failedArticles = []
            topicEntries = [:]
            docsDirectory = nil
            docs = [:]
            missingDocs = []
            failedDocs = []
            docIndex = nil
            entries = []
            principles = []
            homeSpaceID = nil
            homeState = ListLoadState()
            plan = nil
            planState = ListLoadState()
            planMissing = false
            planVersions = []
            planVersionReads = [:]
        }
        return space
    }

    /// The category directory — the Contents sheet and Browse by category.
    func loadDirectory() async {
        if spaces.isEmpty { await loadSpaces() }
        guard let space = articlesSpace() else { return }
        directoryState.begin()
        do {
            let read = try await api.wikiArticleDirectory(spaceID: space.id)
            guard articlesSpaceID == space.id else { return }
            if read != directory { directory = read }
            directoryState.succeed()
        } catch {
            directoryState.fail()
        }
    }

    /// Every article A to Z.
    func loadArticleIndex() async {
        if spaces.isEmpty { await loadSpaces() }
        guard let space = articlesSpace() else { return }
        articleIndexState.begin()
        do {
            let read = try await api.wikiArticleIndex(spaceID: space.id)
            guard articlesSpaceID == space.id else { return }
            if read != articleIndex { articleIndex = read }
            articleIndexState.succeed()
        } catch {
            articleIndexState.fail()
        }
    }

    /// One article, and the entries of its topic. A 404 is a topic with no such article yet — its
    /// page is then the topic's entries alone.
    func loadArticle(_ address: WikiArticleAddress) async {
        if spaces.isEmpty { await loadSpaces() }
        guard let space = articlesSpace() else { return }
        await loadTopicEntries(address.topic, space: space)
        do {
            let read = try await api.wikiArticle(spaceID: space.id, slug: address.topic, part: address.part)
            guard articlesSpaceID == space.id else { return }
            missingArticles.remove(address)
            failedArticles.remove(address)
            if articles[address] != read { articles[address] = read }
        } catch APIError.http(let status, _) where status == 404 {
            missingArticles.insert(address)
        } catch {
            failedArticles.insert(address)
        }
    }

    private func loadTopicEntries(_ slug: String, space: WikiSpace) async {
        guard let read = try? await api.wikiTopic(spaceID: space.id, slug: slug), articlesSpaceID == space.id else { return }
        let entries = read.entries ?? []
        if topicEntries[slug] != entries { topicEntries[slug] = entries }
    }

    /// The entries a query finds in the space on screen.
    func search(_ query: String) async -> [WikiSearchHit] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        return (try? await api.wikiSearch(trimmed, spaceID: currentSpace?.id))?.hits ?? []
    }

    /// `wiki.changed` arrived, or a write landed: re-read what is loaded, once for a burst.
    func nudge() {
        guard nudgeTask == nil else { return }
        nudgeTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard let self else { return }
            self.nudgeTask = nil
            await self.reloadLoaded()
        }
    }

    /// What is loaded, read again — what the control plane's reconnect asks for too. Of the entry pages,
    /// only the ones on screen: the others are read when they next appear.
    func reloadLoaded() async {
        if homeSpaceID != nil || homeState.hasLoaded {
            await loadHome()
        } else {
            await loadSpaces()
        }
        if activity != nil || activityState.hasLoaded { await loadActivity() }
        if directory != nil { await loadDirectory() }
        if articleIndex != nil { await loadArticleIndex() }
        for address in Array(articles.keys) { await loadArticle(address) }
        if docsDirectory != nil { await loadDocsDirectory() }
        if docIndex != nil { await loadDocIndex() }
        if !entries.isEmpty { await loadEntries() }
        for slug in Array(docs.keys) { await loadDoc(slug) }
        if plan != nil || planState.hasLoaded { await loadPlan() }
        if otherPlansRead { await loadOtherPlans() }
        for key in Array(runs.keys) { await loadRun(key) }
        if reviewState.hasLoaded { await loadReview() }
        for key in Array(onScreen.keys) { await loadEntry(key) }
    }

    // MARK: the documents (criterion 10 revised)

    /// The confirmed plan's directory — the Contents sheet, Browse and the plan page's documents. With no
    /// plan confirmed its `plan` is nil, and the Wiki reads by topic as it did.
    func loadDocsDirectory() async {
        if spaces.isEmpty { await loadSpaces() }
        guard let space = articlesSpace() else { return }
        guard let read = try? await api.wikiDocs(spaceID: space.id), articlesSpaceID == space.id else { return }
        if read != docsDirectory { docsDirectory = read }
    }

    /// One document. A 404 is a document the confirmed plan does not have.
    func loadDoc(_ slug: String) async {
        if spaces.isEmpty { await loadSpaces() }
        guard let space = articlesSpace() else { return }
        do {
            let read = try await api.wikiDoc(spaceID: space.id, slug: slug)
            guard articlesSpaceID == space.id else { return }
            missingDocs.remove(slug)
            failedDocs.remove(slug)
            if docs[slug] != read { docs[slug] = read }
        } catch APIError.http(let status, _) where status == 404 {
            missingDocs.insert(slug)
        } catch {
            failedDocs.insert(slug)
        }
    }

    /// Every document and every section title no other document shares, A to Z.
    func loadDocIndex() async {
        if spaces.isEmpty { await loadSpaces() }
        guard let space = articlesSpace() else { return }
        guard let read = try? await api.wikiDocIndex(spaceID: space.id), articlesSpaceID == space.id else { return }
        if read != docIndex { docIndex = read }
    }

    /// The space's newest entries, for the summaries a document's page shows under its entries.
    func loadEntries() async {
        if spaces.isEmpty { await loadSpaces() }
        guard let space = articlesSpace() else { return }
        guard let read = try? await api.wikiEntries(spaceID: space.id), articlesSpaceID == space.id else { return }
        if read != entries { entries = read }
    }

    // MARK: the plan (criterion 11) — the owner's door only

    /// The plan, its versions and the directory its documents are written into, side by side.
    func loadPlan() async {
        if spaces.isEmpty { await loadSpaces() }
        guard let space = articlesSpace() else { return }
        planState.begin()
        // Beside the plan through a task handle, not `async let` (d22b276cc).
        let versionsRead = Task { try await api.wikiPlanVersions(spaceID: space.id) }
        defer { versionsRead.cancel() }
        do {
            let read = try await api.wikiPlan(spaceID: space.id)
            guard articlesSpaceID == space.id else { return }
            planMissing = false
            if read != plan { plan = read }
            planState.succeed()
        } catch APIError.http(let status, _) where status == 404 {
            guard articlesSpaceID == space.id else { return }
            planMissing = true
            plan = nil
            planState.succeed()
        } catch {
            planState.fail()
        }
        if let versions = try? await versionsRead.value, articlesSpaceID == space.id, versions.versions != planVersions {
            planVersions = versions.versions
        }
    }

    /// The plans of the other spaces where something waits (`planWaiting`), side by side: Activity says what
    /// waits in each. A read that fails leaves that space's banners out.
    func loadOtherPlans() async {
        if spaces.isEmpty { await loadSpaces() }
        let current = currentSpace?.id
        let waiting = spaces.filter { $0.id != current && ($0.planWaiting ?? 0) > 0 }
        let api = self.api
        let read = await withTaskGroup(of: (String, WikiPlanState?).self) { group in
            for space in waiting {
                group.addTask { (space.id, try? await api.wikiPlan(spaceID: space.id)) }
            }
            var plans: [String: WikiPlanState] = [:]
            for await (id, plan) in group { if let plan { plans[id] = plan } }
            return plans
        }
        otherPlansRead = true
        if read != otherPlans { otherPlans = read }
    }

    /// One older version, read whole when the version menu picks it.
    func loadPlanVersion(_ version: Int) async {
        guard let space = articlesSpace(), planVersionReads[version] == nil,
              let read = try? await api.wikiPlanVersion(spaceID: space.id, version: version), articlesSpaceID == space.id else { return }
        planVersionReads[version] = read
    }

    /// What a plan write came to: done, refused by the gate with every error, or refused otherwise.
    enum PlanWrite: Equatable {
        case done(version: Int)
        case refused([WikiPlanGateError])
        case failed(String)
    }

    /// Draft plan, or Redraft… with the owner's words: a task of the maintenance list. Nil on success
    /// (with whether a job was made, or one already on its way answered), else the sentence to show.
    func redraftPlan(instructions: String?) async -> (created: Bool, refusal: String?) {
        guard let space = currentSpace else { return (false, WikiCopy.noSpaces) }
        busy = true
        defer { busy = false }
        do {
            let answer = try await api.redraftWikiPlan(spaceID: space.id, instructions: instructions)
            await loadPlan()
            return (answer.created, nil)
        } catch {
            await loadPlan()
            return (false, Self.refusal(error))
        }
    }

    /// Confirm plan: the draft becomes the version in force, and its documents are written.
    func confirmPlan(version: Int) async -> PlanWrite {
        await planWrite { space in try await self.api.confirmWikiPlan(spaceID: space.id, version: version) }
    }

    /// Edit: one document or section as the owner rewrote it, in the draft's shape — a new draft.
    func editPlan(_ request: WikiPlanEditRequest) async -> PlanWrite {
        await planWrite { space in try await self.api.editWikiPlan(spaceID: space.id, request) }
    }

    /// Reject a change a maintenance run proposed: the plan is as it was.
    func rejectPlanProposal(_ id: String) async -> String? {
        busy = true
        defer { busy = false }
        do {
            _ = try await api.decideWikiPlanProposal(id, WikiPlanDecideRequest(action: .reject))
            await loadPlan()
            return nil
        } catch {
            await loadPlan()
            return Self.refusal(error)
        }
    }

    /// Accept a change: the server applies it to the newest version and puts the result through the gate —
    /// a new draft. With no other draft waiting (`confirm`) that draft is confirmed at once: two requests,
    /// the second only once the first came back with a draft the gate passed. A refusal of the first
    /// leaves the plan as it was, and its errors are the answer; nothing is confirmed.
    func acceptPlanProposal(_ id: String, confirm: Bool) async -> (accepted: PlanWrite, confirmed: Bool) {
        guard let space = currentSpace else { return (.failed(WikiCopy.noSpaces), false) }
        busy = true
        defer { busy = false }
        let draft: WikiPlanVersion
        do {
            let decided = try await api.decideWikiPlanProposal(id, WikiPlanDecideRequest(action: .accept))
            guard let made = decided.draft else {
                await loadPlan()
                return (.failed(APIClient.failureReason(APIError.invalidResponse)), false)
            }
            draft = made
        } catch {
            await loadPlan()
            if let errors = WikiPlanLogic.gateErrors(error) { return (.refused(errors), false) }
            return (.failed(Self.refusal(error)), false)
        }
        guard confirm else {
            await loadPlan()
            return (.done(version: draft.version), false)
        }
        do {
            let confirmed = try await api.confirmWikiPlan(spaceID: space.id, version: draft.version)
            await loadPlan()
            await loadDocsDirectory()
            return (.done(version: confirmed.version), true)
        } catch {
            // The change is in a draft that waits for Confirm plan: what the page then shows.
            await loadPlan()
            if let errors = WikiPlanLogic.gateErrors(error) { return (.refused(errors), false) }
            return (.failed(Self.refusal(error)), false)
        }
    }

    private func planWrite(_ write: (WikiSpace) async throws -> WikiPlanVersion) async -> PlanWrite {
        guard let space = currentSpace else { return .failed(WikiCopy.noSpaces) }
        busy = true
        defer { busy = false }
        do {
            let version = try await write(space)
            await loadPlan()
            await loadDocsDirectory()
            return .done(version: version.version)
        } catch {
            await loadPlan()
            if let errors = WikiPlanLogic.gateErrors(error) { return .refused(errors) }
            return .failed(Self.refusal(error))
        }
    }

    // MARK: Review

    /// The owner's answer to one pending op. Nil on success, else the sentence to show.
    ///
    /// Returns as soon as the answer lands, not after the three reads a write is followed by: the
    /// caller's toast used to wait on all four requests and arrive seconds late, often on whatever
    /// page the owner had moved to by then. The card leaves the queue at once (`answered`) and the
    /// reads catch the queue, the drawer's count and the home page up behind it.
    ///
    /// Landing is not the same as applying: the server answers 200 for an op it could not apply too,
    /// recording `conflict` or `withdrawn` on it, and the answer is read for that. Such an answer is a
    /// refusal like any other — the card is not answered here, and the queue is read again.
    func decide(_ card: WikiLogic.ReviewCard, _ action: WikiDecideAction,
                reason: WikiRejectReason? = nil, edited: WikiEntryChanges? = nil) async -> String? {
        busy = true
        defer { busy = false }
        let answer: WikiChangeset
        do {
            answer = try await api.decideWikiChangeset(
                card.changeset.id,
                WikiDecideRequest(decisions: [WikiDecision(opId: card.op.id, action: action,
                                                           edited: edited, reason: reason)]))
        } catch {
            await reloadAfterWrite()
            return Self.refusal(error)
        }
        if let refusal = WikiLogic.decisionRefusal(WikiLogic.recordedDecision(answer, opID: card.op.id),
                                                   op: card.op.op, action: action) {
            await reloadAfterWrite()
            return refusal
        }
        answered.insert(card.op.id)
        Task { [weak self] in
            guard let self else { return }
            await self.reloadAfterWrite()
            // Only what the server no longer lists as waiting comes off the list; an op a failed
            // read left behind stays hidden rather than coming back as if unanswered.
            self.answered.formIntersection(WikiLogic.reviewCards(self.review).map(\.op.id))
        }
        return nil
    }

    /// The entry an op names, for the cards that are about an existing entry (an amend, a retire).
    func loadEntriesNamed(by cards: [WikiLogic.ReviewCard]) async {
        for card in cards {
            guard let id = card.op.entryId, detail(id) == nil, !isMissing(id) else { continue }
            await loadEntry(id)
        }
    }

    // MARK: Wiki settings

    /// The owner's settings for one space — its review mode, Automatic's spot checks, maintenance —
    /// written at once. Nil on success, else the sentence to show.
    func updateSpace(_ space: WikiSpace, _ update: WikiSpaceUpdate) async -> String? {
        busy = true
        defer { busy = false }
        do {
            _ = try await api.updateWikiSpace(space.id, update)
            await reloadAfterWrite()
            return nil
        } catch {
            await loadSpaces()
            return Self.refusal(error)
        }
    }

    // MARK: an entry a review mode applied

    /// Confirm: the entry becomes Confirmed and is pushed from then on.
    func confirm(_ entry: WikiEntry) async -> String? {
        await answer(entry.id) { try await self.api.confirmWikiEntry(entry.id) }
    }

    /// Reject, with one of Review's four reasons: the entry ends as rejected.
    func reject(_ entryID: String, reason: WikiRejectReason) async -> String? {
        await answer(entryID) { try await self.api.rejectWikiEntry(entryID, reason: reason) }
    }

    private func answer(_ entryID: String, _ write: () async throws -> Void) async -> String? {
        busy = true
        defer { busy = false }
        do {
            try await write()
            await reloadAfterWrite()
            await loadEntry(entryID)
            return nil
        } catch {
            await loadEntry(entryID)
            return Self.refusal(error)
        }
    }

    // MARK: one run

    /// Runs by their own reads, side by side; one whose read fails is left out.
    private func readRuns(_ ids: [String]) async -> [WikiChangesetView] {
        let api = self.api
        return await withTaskGroup(of: (Int, WikiChangesetView?).self) { group in
            for (index, id) in ids.enumerated() {
                group.addTask { (index, try? await api.wikiChangeset(id)) }
            }
            var read: [(Int, WikiChangesetView)] = []
            for await (index, view) in group { if let view { read.append((index, view)) } }
            return read.sorted { $0.0 < $1.0 }.map(\.1)
        }
    }

    /// A run by either spelling of its id: its page's own read, else the one Activity read.
    func run(_ id: String) -> WikiChangesetView? {
        runs[PublicID.storageKey(id)] ?? activity?.run(id)
    }

    /// Whether the server does not know the run: another account's, or none at all.
    func isMissingRun(_ id: String) -> Bool { missingRuns.contains(PublicID.storageKey(id)) }

    /// One run's page, read by its id (`GET /wiki/changesets/:id`), whatever of it waits in Review.
    func loadRun(_ id: String) async {
        let key = PublicID.storageKey(id)
        do {
            let read = try await api.wikiChangeset(id)
            missingRuns.remove(key)
            if runs[key] != read { runs[key] = read }
        } catch APIError.http(let status, _) where status == 404 {
            missingRuns.insert(key)
        } catch {
            // Keep what is on screen; the next nudge reads it again.
        }
    }

    /// Revert run: every op its review mode applied that nobody has answered, taken back at once.
    func revert(_ run: WikiChangesetView) async -> String? {
        busy = true
        defer { busy = false }
        do {
            _ = try await api.revertWikiChangeset(run.id)
            await reloadAfterWrite()
            await loadRun(run.id)
            return nil
        } catch {
            return Self.refusal(error)
        }
    }

    // MARK: the owner's own writes, from an entry's page

    /// Edit: the title and the one-line summary, as an amend that applies at once.
    func edit(_ entry: WikiEntry, title: String, summary: String) async -> String? {
        await write(entry, .amend(entryId: entry.id, baseRevision: entry.currentRevision ?? 1,
                                  changes: WikiEntryChanges(title: title, summary: summary)),
                    rationale: WikiCopy.editedRationale(entry.displayTitle), key: "wiki-edit")
    }

    /// Supersede: a replacement with the entry's kind, fields, topics, aliases and anchors, under a
    /// new title and summary; the entry points at it from then on.
    func supersede(_ entry: WikiEntry, title: String, summary: String) async -> String? {
        var draft: [String: JSONValue] = [
            "kind": .string((entry.kind ?? .unknown).rawValue),
            "title": .string(title),
            "summary": .string(summary),
            "fields": entry.fields ?? .object([:]),
            "topics": .array((entry.topics ?? []).map(JSONValue.string)),
            "aliases": .array((entry.aliases ?? []).map(JSONValue.string)),
        ]
        // An anchor's last check is the server's, never a proposer's: it goes back without it.
        draft["anchors"] = .array((entry.anchors ?? []).map(Self.anchorInput))
        return await write(entry, .supersede(entryId: entry.id, baseRevision: entry.currentRevision ?? 1,
                                             entry: .object(draft)),
                           rationale: WikiCopy.replacedRationale(entry.displayTitle), key: "wiki-supersede")
    }

    /// Retire: agents stop getting it; it stays in History.
    func retire(_ entry: WikiEntry, reason: String) async -> String? {
        await write(entry, .retire(entryId: entry.id, baseRevision: entry.currentRevision ?? 1, reason: reason),
                    rationale: WikiCopy.retiredRationale(entry.displayTitle), key: "wiki-retire")
    }

    /// One owner write, with the rationale it is recorded under and an idempotency key of its own, so
    /// a resend of the same press is one write. Nil on success, else the sentence to show.
    private func write(_ entry: WikiEntry, _ op: WikiOwnerOp, rationale: String, key: String) async -> String? {
        guard let spaceID = entry.spaceId ?? currentSpace?.id else { return WikiCopy.noSpaces }
        busy = true
        defer { busy = false }
        do {
            let result = try await api.submitWikiChangeset(
                spaceID: spaceID,
                WikiChangesetRequest(ops: [op], rationale: rationale,
                                     idempotencyKey: "\(key):\(UUID().uuidString.lowercased())"))
            await reloadAfterWrite()
            await loadEntry(entry.id)
            let refusal = result.ops?.compactMap { $0.reasons?.first?.message }.first
            return refusal
        } catch {
            await loadEntry(entry.id)
            return Self.refusal(error)
        }
    }

    /// What the server said when it refused a write — its own sentence, as the web shows it — or
    /// the readable reason when the request failed without a server message.
    private static func refusal(_ error: Error) -> String {
        if case APIError.http(_, let body?) = error, let data = body.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let message = object["message"] as? String, !message.isEmpty {
            return message
        }
        return APIClient.failureReason(error)
    }

    private func reloadAfterWrite() async {
        await loadSpaces()
        if reviewState.hasLoaded { await loadReview() }
        if homeState.hasLoaded { await loadHome() }
        if activityState.hasLoaded { await loadActivity() }
    }

    /// An anchor as a proposer writes it: every key but `check`.
    private static func anchorInput(_ anchor: WikiAnchor) -> JSONValue {
        var object: [String: JSONValue] = [:]
        if let type = anchor.type { object["type"] = .string(type.rawValue) }
        let texts: [(String, String?)] = [("path", anchor.path), ("symbol", anchor.symbol),
                                          ("regionSha256", anchor.regionSha256), ("sha", anchor.sha),
                                          ("criterionId", anchor.criterionId),
                                          ("semanticHash", anchor.semanticHash),
                                          ("contentHash", anchor.contentHash), ("command", anchor.command),
                                          ("ref", anchor.ref)]
        for (key, value) in texts { if let value { object[key] = .string(value) } }
        if let exit = anchor.expectedExit { object["expectedExit"] = .int(exit) }
        return .object(object)
    }
}
