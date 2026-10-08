package io.orbitd.android.wiki

import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.DataKind
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiError
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/** A read whose failure leaves its part out, without swallowing cancellation as `runCatching` would. */
internal suspend fun <T> optional(read: suspend () -> T): T? = try { read() }
    catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }

/** OrbitKit `ListLoadState`: in flight, answered at least once, and whether the latest answer failed. */
internal data class LoadState(val loading: Boolean = false, val hasLoaded: Boolean = false, val lastLoadFailed: Boolean = false) {
    fun begin() = copy(loading = true)
    fun succeed() = LoadState(loading = false, hasLoaded = true, lastLoadFailed = false)
    fun fail() = copy(loading = false, lastLoadFailed = true)
}

/** OrbitKit `LoadFailureLogic.presentation`: never "empty" before an answer, never a stale empty after a failure. */
internal enum class LoadPresentation { LOADING, FAILED, EMPTY, CONTENT, CONTENT_WITH_ERROR }
internal fun presentation(state: LoadState, isEmpty: Boolean): LoadPresentation = when {
    !isEmpty -> if (state.lastLoadFailed) LoadPresentation.CONTENT_WITH_ERROR else LoadPresentation.CONTENT
    state.lastLoadFailed -> if (state.loading) LoadPresentation.LOADING else LoadPresentation.FAILED
    state.hasLoaded -> LoadPresentation.EMPTY
    else -> LoadPresentation.LOADING
}

internal data class WikiArticleAddress(val topic: String, val part: Int)

/** What a write came to after the page or sheet that asked for it had gone (a link, the drawer, Back): said once at the
 * top of the next Wiki page. While the asker is there it hears the answer itself, as on iOS. */
internal data class WikiNotice(val text: String, val refused: Boolean, val serial: Long)

/** Everything the Wiki pages draw from — iOS `WikiModel`'s stored properties, as one value. */
internal data class WikiState(
    val spaces: List<WikiSpace> = emptyList(), val spacesState: LoadState = LoadState(),
    val home: WikiHomeContent? = null, val homeState: LoadState = LoadState(),
    val review: List<WikiChangeset> = emptyList(), val reviewState: LoadState = LoadState(), val answered: Set<String> = emptySet(),
    val details: Map<String, WikiEntryDetail> = emptyMap(), val missing: Set<String> = emptySet(), val failed: Set<String> = emptySet(),
    val busy: Boolean = false,
    val directory: WikiArticleDirectory? = null, val directoryState: LoadState = LoadState(),
    val articleIndex: WikiArticleIndex? = null, val articleIndexState: LoadState = LoadState(),
    val articles: Map<WikiArticleAddress, WikiArticle> = emptyMap(), val missingArticles: Set<WikiArticleAddress> = emptySet(),
    val failedArticles: Set<WikiArticleAddress> = emptySet(), val topicEntries: Map<String, List<WikiEntry>> = emptyMap(),
    val runs: Map<String, WikiChangesetView> = emptyMap(), val missingRuns: Set<String> = emptySet(),
    val docsDirectory: WikiDocsDirectory? = null, val docs: Map<String, WikiDoc> = emptyMap(), val missingDocs: Set<String> = emptySet(),
    val failedDocs: Set<String> = emptySet(), val docIndex: WikiDocsIndex? = null,
    val plan: WikiPlanState? = null, val planState: LoadState = LoadState(), val planMissing: Boolean = false,
    val planVersions: List<WikiPlanVersionSummary> = emptyList(), val planVersionReads: Map<Int, WikiPlanVersion> = emptyMap(),
    /** The deployment's System model and the executor switch for this account (P9): what the settings page and the
     * plan's copy read while the server executes the account's wiki. */
    val systemModel: WikiSystemModelStatus? = null,
    /** The space on screen's server runs, and the space they were read for (P9). */
    val jobs: WikiJobsRead? = null,
    val selectedSlug: String? = null,
    /** The titles the link-preview cards gave the tasks and sessions a page names, by `kind:key` (iOS `model.linkCards`). */
    val linkTitles: Map<String, String> = emptyMap(),
    val notice: WikiNotice? = null,
) {
    fun linkTitle(kind: String, id: String): String? = linkTitles["$kind:${wikiKey(id)}"]
    /** The space the home page is about: the one picked, else the first by slug. */
    val currentSpace: WikiSpace? get() = spaces.firstOrNull { it.slug == selectedSlug } ?: spaces.firstOrNull()
    val proposalsToReview: Int get() = WikiLogic.proposalsToReview(spaces)
    val reviewCards: List<WikiLogic.ReviewCard> get() = WikiLogic.reviewCards(review).filter { it.op.id !in answered }
    fun detail(id: String) = details[wikiKey(id)]
    fun isMissing(id: String) = wikiKey(id) in missing
    fun loadFailed(id: String) = wikiKey(id) in failed
    fun run(id: String): WikiChangesetView? = runs[wikiKey(id)] ?: home?.run(id)
    fun isMissingRun(id: String) = wikiKey(id) in missingRuns
    /** Whether the server runs this account's wiki (contract `jobs.executor.read`): nil/absent reads as runner. */
    val serverExecutes: Boolean get() = systemModel?.executor?.serverExecutes == true
    /** The space on screen's server runs, when the read in hand is that space's. */
    val currentJobs: List<WikiJob>? get() = jobs?.takeIf { sameWikiId(it.spaceId, currentSpace?.id) }?.jobs
    fun job(id: String): WikiJob? = currentJobs?.firstOrNull { sameWikiId(it.id, id) }
    /** Whether a run of the space on screen is still on its way: what the run page reads again for. */
    val jobsUnderWay: Boolean get() = currentJobs.orEmpty().any { it.state == "queued" || it.state == "running" || it.state == "waiting" }
}

/** The account's wiki behind every Wiki page, rebuilt per signed-in handle (iOS `WikiModel`). Refetched
 * rather than patched: a nudge re-reads what is loaded, and so does every write this client makes. Each read lands
 * only while it is the newest one asked for its part, and the owner's writes run on the store's own scope to their
 * answer, whatever happens to the page that asked. */
internal class WikiStore(private val auth: AuthSession, val handle: SessionHandle, private val scope: CoroutineScope,
    val client: WikiClient = WikiClient(auth, handle)) {
    private val mutable = MutableStateFlow(WikiState())
    val state: StateFlow<WikiState> = mutable.asStateFlow()
    private var articlesSpaceId: String? = null
    private val onScreen = mutableMapOf<String, Int>()
    private fun set(change: (WikiState) -> WikiState) = mutable.update(change)
    private val current get() = mutable.value
    /** The newest read asked for, by part: an answer to an older one is dropped (a write asks again, so it outdates them). */
    private val reads = ConcurrentHashMap<String, Long>()
    private val notices = AtomicLong()
    /** Nudges waiting: one re-read at a time, and a nudge that comes while one runs gets one more after it. */
    private val nudges = Channel<Unit>(Channel.CONFLATED)

    init {
        scope.launch {
            val saved = optional { auth.readData(handle, DataKind.CACHE, SPACE_KEY)?.decodeToString() }
            if (saved != null && current.selectedSlug == null) set { it.copy(selectedSlug = saved) }
        }
        scope.launch {
            for (signal in nudges) {
                delay(NUDGE_DELAY_MS)
                // What came during the wait is covered by the re-read about to start.
                nudges.tryReceive()
                if (live()) optional { reloadLoaded() }
            }
        }
    }

    /** A read of [part] is asked for; it may land only while it stays the newest one. */
    private fun ask(part: String): Long = reads.merge(part, 1L, Long::plus)!!
    private fun newest(part: String, ticket: Long) = reads[part] == ticket
    /** A write changed what these parts read: whatever is already on its way for them is older than the write. */
    private fun outdate(vararg parts: String) { parts.forEach(::ask) }

    /** Whether this store still speaks for the signed-in account; another account's pages are never drawn. */
    fun live() = (auth.state.value as? AuthState.SignedIn)?.handle === handle

    fun select(slug: String) {
        if (current.selectedSlug == slug) return
        set { it.copy(selectedSlug = slug) }
        scope.launch { optional { auth.writeData(handle, DataKind.CACHE, SPACE_KEY, slug.encodeToByteArray()) } }
    }

    fun entryAppeared(id: String) { onScreen[wikiKey(id)] = (onScreen[wikiKey(id)] ?: 0) + 1 }
    fun entryDisappeared(id: String) {
        val key = wikiKey(id); val count = onScreen[key] ?: return
        if (count > 1) onScreen[key] = count - 1 else onScreen.remove(key)
    }

    // MARK: reads

    suspend fun loadSpaces() {
        val ticket = ask(SPACES)
        set { it.copy(spacesState = it.spacesState.begin()) }
        try {
            val list = client.spaces()
            if (newest(SPACES, ticket)) set { it.copy(spaces = list, spacesState = it.spacesState.succeed()) }
        } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) {
            if (newest(SPACES, ticket)) set { it.copy(spacesState = it.spacesState.fail()) }
        }
    }

    /** The spaces, then the four reads the home page is drawn from, side by side — and each run Recently changed folds. */
    suspend fun loadHome() = supervisorScope {
        val ticket = ask(HOME)
        set { it.copy(homeState = it.homeState.begin()) }
        loadSpaces()
        val space = current.currentSpace
        if (space == null) {
            set { it.copy(home = null, homeState = if (it.spacesState.lastLoadFailed) it.homeState.fail() else it.homeState.succeed()) }
            return@supervisorScope
        }
        val document = async { client.space(space.id) }
        val entries = async { client.entries(space.id) }
        val timeline = async { optional { client.timeline(space.id) } }
        val health = async { optional { client.health(space.id) } }
        val jobs = async { optional { client.jobs(space.id) } }
        try {
            val base = WikiHomeContent(document.await(), current.spaces, entries.await(), timeline.await()?.items.orEmpty(), space.pendingOps ?: 0)
            val runs = base.recentRunIds.map { id -> async { optional { client.changeset(id) } } }.mapNotNull { it.await() }
            val healthRead = health.await()
            val jobsRead = jobs.await()?.takeIf { sameWikiId(it.spaceId, space.id) }
            if (current.currentSpace?.id != space.id || !newest(HOME, ticket)) return@supervisorScope
            set { it.copy(home = base.copy(runs = runs, health = healthRead), jobs = jobsRead, homeState = it.homeState.succeed()) }
        } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) {
            document.cancel(); entries.cancel(); timeline.cancel(); health.cancel(); jobs.cancel()
            if (current.currentSpace?.id == space.id && newest(HOME, ticket)) set { it.copy(homeState = it.homeState.fail()) }
        }
    }

    /** The deployment's System model and the executor switch as it stands for this account (contract `systemModel.read`,
     * P9). A server older than the read answers 404, which reads as none — the pages then draw what they always did. */
    suspend fun loadSystemModel() {
        try {
            val read = client.systemModel()
            set { it.copy(systemModel = read) }
        } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) {
            if (error is ApiError && error.status == 404) set { it.copy(systemModel = null) }
            // Any other failure keeps what is on screen; the next pass reads it again.
        }
    }

    /** The space on screen's server runs, newest first, each with its newest calls (contract `jobs.read`, P9). A
     * server from before the read answers 404, which reads as none — the Runs band is then drawn only when the server
     * executes the account's wiki. */
    suspend fun loadJobs() {
        if (current.spaces.isEmpty()) loadSpaces()
        val space = current.currentSpace
        if (space == null) { set { it.copy(jobs = null) }; return }
        val ticket = ask(JOBS)
        try {
            val read = client.jobs(space.id)
            if (current.currentSpace?.id == space.id && newest(JOBS, ticket)) set { it.copy(jobs = read) }
        } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) {
            if (error is ApiError && error.status == 404 && current.currentSpace?.id == space.id && newest(JOBS, ticket)) set { it.copy(jobs = null) }
            // Any other failure keeps what is on screen; the next pass reads it again.
        }
    }

    suspend fun loadReview() {
        val ticket = ask(REVIEW)
        set { it.copy(reviewState = it.reviewState.begin()) }
        try {
            val queue = client.review()
            if (newest(REVIEW, ticket)) set { it.copy(review = queue, reviewState = it.reviewState.succeed()) }
        } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) {
            if (newest(REVIEW, ticket)) set { it.copy(reviewState = it.reviewState.fail()) }
        }
    }

    /** A 404 is an entry the server will not show — deleted, or not this account's (`WikiModel.loadEntry`). */
    suspend fun loadEntry(id: String) {
        val key = wikiKey(id)
        val ticket = ask("$ENTRY$key")
        try {
            val detail = client.entry(id)
            if (newest("$ENTRY$key", ticket)) set { it.copy(details = it.details + (key to detail), missing = it.missing - key, failed = it.failed - key) }
        } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) {
            if (!newest("$ENTRY$key", ticket)) return
            // A 404 is an entry the server will not show — deleted, or not this account's: what was shown of it goes;
            // any other failure keeps what is on screen, and says so only when there is nothing on screen
            // (`WikiModel.loadEntry`).
            if (error is ApiError && error.status == 404) set { it.copy(missing = it.missing + key, details = it.details - key) }
            else set { it.copy(failed = it.failed + key) }
        }
    }

    /** Ask for the cards of the objects a page names — one batched read, nothing re-read that is already held
     * (iOS `WikiEntryView.noteCards` over the app's card store). A failed read leaves the rows on their ids. */
    suspend fun noteLinkCards(refs: List<Pair<String, String>>) {
        val wanted = refs.distinctBy { (kind, id) -> "$kind:${wikiKey(id)}" }
            .filter { (kind, id) -> current.linkTitle(kind, id) == null }
        wanted.chunked(50).forEach { batch ->
            val answers = optional { client.linkPreviews(batch) } ?: return@forEach
            // One preview per ref, in the order they were asked for.
            val titles = batch.zip(answers).mapNotNull { (ref, preview) ->
                if (preview["state"].text() != "ok") return@mapNotNull null
                val title = preview[ref.first]["title"].text()?.takeIf { it.isNotBlank() } ?: wikiPublicId(ref.second)
                "${ref.first}:${wikiKey(ref.second)}" to title
            }
            if (titles.isNotEmpty()) set { it.copy(linkTitles = it.linkTitles + titles) }
        }
    }

    /** The space the article reads are of, forgetting what another space's pages read. */
    private fun articlesSpace(): WikiSpace? {
        val space = current.currentSpace ?: return null
        if (articlesSpaceId != space.id) {
            articlesSpaceId = space.id
            set { it.copy(directory = null, directoryState = LoadState(), articleIndex = null, articleIndexState = LoadState(),
                articles = emptyMap(), missingArticles = emptySet(), failedArticles = emptySet(), topicEntries = emptyMap(),
                docsDirectory = null, docs = emptyMap(), missingDocs = emptySet(), failedDocs = emptySet(), docIndex = null,
                plan = null, planState = LoadState(), planMissing = false, planVersions = emptyList(), planVersionReads = emptyMap()) }
        }
        return space
    }

    suspend fun loadDirectory() {
        if (current.spaces.isEmpty()) loadSpaces()
        val space = articlesSpace() ?: return
        set { it.copy(directoryState = it.directoryState.begin()) }
        try {
            val read = client.articleDirectory(space.id)
            if (articlesSpaceId == space.id) set { it.copy(directory = read, directoryState = it.directoryState.succeed()) }
        } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { set { it.copy(directoryState = it.directoryState.fail()) } }
    }

    suspend fun loadArticleIndex() {
        if (current.spaces.isEmpty()) loadSpaces()
        val space = articlesSpace() ?: return
        set { it.copy(articleIndexState = it.articleIndexState.begin()) }
        try {
            val read = client.articleIndex(space.id)
            if (articlesSpaceId == space.id) set { it.copy(articleIndex = read, articleIndexState = it.articleIndexState.succeed()) }
        } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { set { it.copy(articleIndexState = it.articleIndexState.fail()) } }
    }

    /** One article, and the entries of its topic. A 404 is a topic with no such article yet. */
    suspend fun loadArticle(address: WikiArticleAddress) {
        if (current.spaces.isEmpty()) loadSpaces()
        val space = articlesSpace() ?: return
        optional { client.topic(space.id, address.topic) }?.let { read ->
            if (articlesSpaceId == space.id) set { it.copy(topicEntries = it.topicEntries + (address.topic to read.entries.orEmpty())) }
        }
        try {
            val read = client.article(space.id, address.topic, address.part)
            if (articlesSpaceId == space.id) set { it.copy(articles = it.articles + (address to read),
                missingArticles = it.missingArticles - address, failedArticles = it.failedArticles - address) }
        } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) {
            if (error is ApiError && error.status == 404) set { it.copy(missingArticles = it.missingArticles + address) }
            else set { it.copy(failedArticles = it.failedArticles + address) }
        }
    }

    /** The entries a query finds in the space on screen. */
    suspend fun search(query: String): List<WikiSearchHit> {
        val trimmed = query.trim()
        if (trimmed.isEmpty()) return emptyList()
        return client.search(trimmed, current.currentSpace?.id).hits.orEmpty()
    }

    /** `wiki.changed` arrived, or the stream reconnected: re-read what is loaded, once for a burst, never two at once. */
    fun nudge() { nudges.trySend(Unit) }

    suspend fun reloadLoaded() {
        val s = current
        if (s.home != null || s.homeState.hasLoaded) loadHome() else loadSpaces()
        if (current.directory != null) loadDirectory()
        if (current.articleIndex != null) loadArticleIndex()
        current.articles.keys.toList().forEach { loadArticle(it) }
        if (current.docsDirectory != null) loadDocsDirectory()
        if (current.docIndex != null) loadDocIndex()
        current.docs.keys.toList().forEach { loadDoc(it) }
        if (current.plan != null || current.planState.hasLoaded) loadPlan()
        if (current.jobs != null) loadJobs()
        current.runs.keys.toList().forEach { loadRun(it) }
        if (current.reviewState.hasLoaded) loadReview()
        onScreen.keys.toList().forEach { loadEntry(it) }
    }

    // MARK: the documents

    suspend fun loadDocsDirectory() {
        if (current.spaces.isEmpty()) loadSpaces()
        val space = articlesSpace() ?: return
        val ticket = ask(DOCS)
        val read = optional { client.docs(space.id) } ?: return
        if (articlesSpaceId == space.id && newest(DOCS, ticket)) set { it.copy(docsDirectory = read) }
    }

    /** A 404 is a document the confirmed plan does not have. */
    suspend fun loadDoc(slug: String) {
        if (current.spaces.isEmpty()) loadSpaces()
        val space = articlesSpace() ?: return
        try {
            val read = client.doc(space.id, slug)
            if (articlesSpaceId == space.id) set { it.copy(docs = it.docs + (slug to read), missingDocs = it.missingDocs - slug, failedDocs = it.failedDocs - slug) }
        } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) {
            if (error is ApiError && error.status == 404) set { it.copy(missingDocs = it.missingDocs + slug) }
            else set { it.copy(failedDocs = it.failedDocs + slug) }
        }
    }

    suspend fun loadDocIndex() {
        if (current.spaces.isEmpty()) loadSpaces()
        val space = articlesSpace() ?: return
        val read = optional { client.docIndex(space.id) } ?: return
        if (articlesSpaceId == space.id) set { it.copy(docIndex = read) }
    }

    // MARK: the plan — the owner's door only

    suspend fun loadPlan() = supervisorScope {
        if (current.spaces.isEmpty()) loadSpaces()
        val space = articlesSpace() ?: return@supervisorScope
        val ticket = ask(PLAN)
        fun landing() = articlesSpaceId == space.id && newest(PLAN, ticket)
        set { it.copy(planState = it.planState.begin()) }
        val versions = async { optional { client.planVersions(space.id) } }
        try {
            val read = client.plan(space.id)
            if (landing()) set { it.copy(planMissing = false, plan = read, planState = it.planState.succeed()) }
        } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) {
            if (error is ApiError && error.status == 404) {
                if (landing()) set { it.copy(planMissing = true, plan = null, planState = it.planState.succeed()) }
            } else if (landing()) set { it.copy(planState = it.planState.fail()) }
        }
        versions.await()?.let { read -> if (landing()) set { it.copy(planVersions = read.versions) } }
    }

    suspend fun loadPlanVersion(version: Int) {
        val space = articlesSpace() ?: return
        if (current.planVersionReads[version] != null) return
        val read = optional { client.planVersion(space.id, version) } ?: return
        if (articlesSpaceId == space.id) set { it.copy(planVersionReads = it.planVersionReads + (version to read)) }
    }

    sealed interface PlanWrite {
        data class Done(val version: Int) : PlanWrite
        data class Refused(val errors: List<WikiPlanGateError>) : PlanWrite
        data class Failed(val message: String) : PlanWrite
        /** Accept's first write went through — the change is in draft [version] — and the confirm after it did not. */
        data class AcceptedNotConfirmed(val version: Int, val why: String) : PlanWrite
    }

    /** Draft plan, or Redraft… with the owner's words. Nil refusal on success, with whether a job was made. */
    suspend fun redraftPlan(instructions: String?): Pair<Boolean, String?> {
        val space = current.currentSpace ?: return false to WikiCopy.refused
        return owned({ (created, refusal) -> notice(refusal, if (created) WikiPlanCopy.redraftAsked else WikiPlanCopy.redraftAlready, WikiPlanCopy.title) }) {
            try { val created = client.redraftPlan(space.id, instructions); outdate(PLAN); loadPlan(); created to null }
            catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { loadPlan(); false to wikiRefusal(error) }
        }
    }
    suspend fun confirmPlan(version: Int) = planWrite(WikiPlanCopy::confirmed) { client.confirmPlan(it.id, version) }
    suspend fun editPlan(body: JsonObject) = planWrite(WikiPlanCopy::draftSaved) { client.editPlan(it.id, body) }
    suspend fun rejectPlanProposal(id: String): String? = owned({ refusal -> notice(refusal, WikiPlanCopy.changeRejected, WikiPlanCopy.title) }) {
        try { client.decidePlanProposal(id, accept = false); outdate(PLAN); loadPlan(); null }
        catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { loadPlan(); wikiRefusal(error) }
    }
    /** Accept: a new draft over the newest version; with no other draft waiting it is confirmed at once. Both writes
     * run to their answers together, so a page that goes between them never leaves the draft half done unsaid. */
    suspend fun acceptPlanProposal(id: String, confirm: Boolean): Pair<PlanWrite, Boolean> {
        val space = current.currentSpace ?: return PlanWrite.Failed(WikiCopy.refused) to false
        return owned({ (write, confirmed) -> planNotice(write, if (confirmed) WikiPlanCopy::confirmed else WikiPlanCopy::changeAdded) }) {
            val draft = try {
                client.decidePlanProposal(id, accept = true) ?: run { loadPlan(); return@owned PlanWrite.Failed(WikiCopy.refused) to false }
            } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) {
                loadPlan()
                return@owned (wikiGateErrors(error)?.let { PlanWrite.Refused(it) } ?: PlanWrite.Failed(wikiRefusal(error))) to false
            }
            outdate(PLAN, DOCS)
            if (!confirm) { loadPlan(); return@owned PlanWrite.Done(draft.version) to false }
            try {
                val confirmed = client.confirmPlan(space.id, draft.version)
                loadPlan(); loadDocsDirectory()
                PlanWrite.Done(confirmed.version) to true
            } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) {
                loadPlan()
                val why = wikiGateErrors(error)?.joinToString("\n") { "${it.path} ${it.message}" } ?: wikiRefusal(error)
                PlanWrite.AcceptedNotConfirmed(draft.version, why) to false
            }
        }
    }
    private suspend fun planWrite(done: (Int) -> String, write: suspend (WikiSpace) -> WikiPlanVersion): PlanWrite {
        val space = current.currentSpace ?: return PlanWrite.Failed(WikiCopy.refused)
        return owned({ answer: PlanWrite -> planNotice(answer, done) }) {
            try { val version = write(space); outdate(PLAN, DOCS); loadPlan(); loadDocsDirectory(); PlanWrite.Done(version.version) }
            catch (cancel: CancellationException) { throw cancel } catch (error: Exception) {
                loadPlan(); wikiGateErrors(error)?.let { PlanWrite.Refused(it) } ?: PlanWrite.Failed(wikiRefusal(error))
            }
        }
    }
    private fun planNotice(write: PlanWrite, done: (Int) -> String): WikiNotice = when (write) {
        is PlanWrite.Done -> notice(null, done(write.version), WikiPlanCopy.title)
        is PlanWrite.Refused -> notice(write.errors.joinToString("\n") { "${it.path} ${it.message}" }, "", WikiPlanCopy.title)
        is PlanWrite.Failed -> notice(write.message, "", WikiPlanCopy.title)
        is PlanWrite.AcceptedNotConfirmed -> notice(WikiPlanCopy.acceptedNotConfirmed(write.version, write.why), "", WikiPlanCopy.title)
    }

    // MARK: Review

    /** The owner's answer to one pending op. Nil on success, else the sentence to show. The decide's answer says
     * what the server recorded for the op: `conflict` (the entry moved past it, or is no longer active) and
     * `withdrawn` applied nothing, and say so — but a challenge's Retire is recorded `withdrawn` when it went
     * through (see [WikiLogic.decisionRefusal]). An op that went through leaves the queue at once (`answered`),
     * and the reads catch the queue, the drawer's count and the home page up behind it. */
    suspend fun decide(card: WikiLogic.ReviewCard, action: String, reason: String? = null,
        edited: JsonObject? = null): String? {
        val subject = WikiLogic.knownTitle(card, card.op.entryId?.let { current.detail(it)?.entry })
        return owned({ refusal -> notice(refusal, WikiLogic.decidedToast(card.op.op, action), subject) }) {
            val refusal = try {
                val answer = client.decide(card.changeset.id, card.op.id, action, edited, reason)
                outdate(REVIEW, SPACES, HOME)
                WikiLogic.decisionRefusal(WikiLogic.recordedDecision(answer, card.op.id), card.op.op, action)
            } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { reloadAfterWrite(); return@owned wikiRefusal(error) }
            if (refusal != null) { reloadAfterWrite(); return@owned refusal }
            set { it.copy(answered = it.answered + card.op.id) }
            scope.launch {
                optional { reloadAfterWrite() }
                // Only what the server no longer lists as waiting comes off the list.
                val waiting = WikiLogic.reviewCards(current.review).map { it.op.id }.toSet()
                set { it.copy(answered = it.answered.intersect(waiting)) }
            }
            null
        }
    }

    /** The entry an op names, for the cards that are about an existing entry. */
    suspend fun loadEntriesNamed(cards: List<WikiLogic.ReviewCard>) {
        cards.forEach { card ->
            val id = card.op.entryId ?: return@forEach
            if (current.detail(id) == null && !current.isMissing(id)) loadEntry(id)
        }
    }

    // MARK: Wiki settings

    suspend fun updateSpace(space: WikiSpace, update: JsonObject): String? = owned({ refusal -> notice(refusal, WikiCopy.settingsSaved, space.slug) }) {
        try { client.updateSpace(space.id, update); outdate(SPACES, HOME); reloadAfterWrite(); null }
        catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { loadSpaces(); wikiRefusal(error) }
    }

    // MARK: an entry a review mode applied

    suspend fun confirm(entry: WikiEntry): String? = answer(entry.id, WikiModeCopy.confirmed, entry.displayTitle) { client.confirmEntry(entry.id) }
    suspend fun reject(entryId: String, reason: String): String? {
        require(reason in WikiCopy.rejectReasons)
        return answer(entryId, WikiModeCopy.rejected, current.detail(entryId)?.entry?.displayTitle) { client.rejectEntry(entryId, reason) }
    }
    private suspend fun answer(entryId: String, done: String, subject: String?, write: suspend () -> Unit): String? =
        owned({ refusal -> notice(refusal, done, subject) }) {
            try { write(); outdate("$ENTRY${wikiKey(entryId)}", SPACES, HOME, REVIEW); reloadAfterWrite(); loadEntry(entryId); null }
            catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { loadEntry(entryId); wikiRefusal(error) }
        }

    // MARK: one run

    suspend fun loadRun(id: String) {
        val key = wikiKey(id)
        val ticket = ask("$RUN$key")
        try {
            val read = client.changeset(id)
            if (newest("$RUN$key", ticket)) set { it.copy(runs = it.runs + (key to read), missingRuns = it.missingRuns - key) }
        } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) {
            if (error is ApiError && error.status == 404 && newest("$RUN$key", ticket)) set { it.copy(missingRuns = it.missingRuns + key) }
        }
    }
    suspend fun revert(run: WikiChangesetView): String? = owned({ refusal -> notice(refusal, WikiModeCopy.reverted, WikiModeCopy.maintenanceName) }) {
        try { client.revert(run.id); outdate("$RUN${wikiKey(run.id)}", SPACES, HOME, REVIEW); reloadAfterWrite(); loadRun(run.id); null }
        catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { wikiRefusal(error) }
    }

    // MARK: the owner's own writes, from an entry's page

    suspend fun edit(entry: WikiEntry, title: String, summary: String) = write(entry, buildJsonObject {
        put("op", JsonPrimitive("amend")); put("entryId", JsonPrimitive(entry.id))
        put("baseRevision", JsonPrimitive(entry.currentRevision ?: 1))
        put("changes", buildJsonObject {
            put("title", JsonPrimitive(title)); put("summary", JsonPrimitive(summary)) })
    }, WikiCopy.editedRationale(entry.displayTitle), "wiki-edit", WikiCopy.saved)

    /** A replacement with the entry's kind, fields, topics, aliases and anchors, under a new title and summary. */
    suspend fun supersede(entry: WikiEntry, title: String, summary: String) = write(entry, wikiSupersedeOp(entry, title, summary),
        WikiCopy.replacedRationale(entry.displayTitle), "wiki-supersede", WikiCopy.superseded)

    suspend fun retire(entry: WikiEntry, reason: String) = write(entry, buildJsonObject {
        put("op", JsonPrimitive("retire")); put("entryId", JsonPrimitive(entry.id))
        put("baseRevision", JsonPrimitive(entry.currentRevision ?: 1)); put("reason", JsonPrimitive(reason))
    }, WikiCopy.retiredRationale(entry.displayTitle), "wiki-retire", WikiCopy.retired)

    /** One owner write with an idempotency key of its own, so a resend of the same press is one write. */
    private suspend fun write(entry: WikiEntry, op: JsonObject, rationale: String, key: String, done: String): String? {
        val spaceId = entry.spaceId ?: current.currentSpace?.id ?: return WikiCopy.refused
        return owned({ refusal -> notice(refusal, done, entry.displayTitle) }) {
            try {
                val result = client.submit(spaceId, op, rationale, "$key:${UUID.randomUUID().toString().lowercase()}")
                outdate("$ENTRY${wikiKey(entry.id)}", SPACES, HOME, REVIEW)
                reloadAfterWrite(); loadEntry(entry.id)
                result.ops?.firstNotNullOfOrNull { it.reasons?.firstOrNull()?.message }
            } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { loadEntry(entry.id); wikiRefusal(error) }
        }
    }

    private suspend fun reloadAfterWrite() {
        loadSpaces()
        if (current.reviewState.hasLoaded) loadReview()
        if (current.homeState.hasLoaded) loadHome()
    }

    /** A write in flight, so its controls do not take a second press. */
    private suspend fun <T> busy(work: suspend () -> T): T {
        set { it.copy(busy = true) }
        try { return work() } finally { set { it.copy(busy = false) } }
    }

    /** One owner write, run on the store's own scope to its answer: the page or sheet that asked may go — Back, a link,
     * the drawer — and A03's AuthSession, which cancels a request whose caller is cancelled, is never asked to. When
     * nobody is left to hear the answer, [said] words it for the next Wiki page. */
    private suspend fun <T> owned(said: (T) -> WikiNotice?, work: suspend () -> T): T {
        val write = scope.async { busy(work) }
        try { return write.await() } catch (cancel: CancellationException) {
            write.invokeOnCompletion { failure -> if (failure == null) said(write.getCompleted())?.let { notice -> set { it.copy(notice = notice) } } }
            throw cancel
        }
    }
    private fun notice(refusal: String?, done: String, subject: String?) =
        if (refusal == null) WikiNotice(WikiCopy.landed(done, subject), refused = false, notices.incrementAndGet())
        else WikiNotice(WikiCopy.refusedFor(subject, refusal), refused = true, notices.incrementAndGet())
    /** The banner was read: it goes, and a later write's takes its place. */
    fun dismissNotice(serial: Long) = set { if (it.notice?.serial == serial) it.copy(notice = null) else it }

    companion object {
        private const val SPACE_KEY = "wiki-selected-space"
        const val NUDGE_DELAY_MS = 500L
        private const val SPACES = "spaces"
        private const val HOME = "home"
        private const val REVIEW = "review"
        private const val PLAN = "plan"
        private const val DOCS = "docs"
        private const val JOBS = "jobs"
        private const val ENTRY = "entry:"
        private const val RUN = "run:"
        private var shared: WikiStore? = null
        /** One store per signed-in handle; another account's store is dropped with its handle. */
        fun of(auth: AuthSession, handle: SessionHandle, scope: CoroutineScope): WikiStore {
            shared?.takeIf { it.handle === handle }?.let { return it }
            return WikiStore(auth, handle, scope).also { shared = it }
        }
    }
}

/** An anchor as a proposer writes it: every key but `check`. */
internal fun wikiAnchorInput(anchor: WikiAnchor): JsonObject = buildJsonObject {
    anchor.type?.let { put("type", JsonPrimitive(it)) }
    listOf("path" to anchor.path, "symbol" to anchor.symbol, "regionSha256" to anchor.regionSha256, "sha" to anchor.sha,
        "criterionId" to anchor.criterionId, "semanticHash" to anchor.semanticHash, "contentHash" to anchor.contentHash,
        "command" to anchor.command, "ref" to anchor.ref).forEach { (key, value) -> value?.let { put(key, JsonPrimitive(it)) } }
    anchor.expectedExit?.let { put("expectedExit", JsonPrimitive(it)) }
}

internal fun wikiSupersedeOp(entry: WikiEntry, title: String, summary: String) = buildJsonObject {
    put("op", JsonPrimitive("supersede")); put("entryId", JsonPrimitive(entry.id))
    put("baseRevision", JsonPrimitive(entry.currentRevision ?: 1))
    put("entry", buildJsonObject {
        put("kind", JsonPrimitive(entry.kind ?: "unknown"))
        put("title", JsonPrimitive(title)); put("summary", JsonPrimitive(summary))
        put("fields", entry.fields ?: JsonObject(emptyMap()))
        put("topics", JsonArray(entry.topics.orEmpty().map(::jsonText)))
        put("aliases", JsonArray(entry.aliases.orEmpty().map(::jsonText)))
        put("anchors", JsonArray(entry.anchors.orEmpty().map(::wikiAnchorInput)))
    })
}
private fun jsonText(value: String) = JsonPrimitive(value)
