package io.orbitd.android.wiki

import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.DataKind
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiError
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import java.util.UUID

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
    val selectedSlug: String? = null,
) {
    /** The space the home page is about: the one picked, else the first by slug. */
    val currentSpace: WikiSpace? get() = spaces.firstOrNull { it.slug == selectedSlug } ?: spaces.firstOrNull()
    val proposalsToReview: Int get() = WikiLogic.proposalsToReview(spaces)
    val reviewCards: List<WikiLogic.ReviewCard> get() = WikiLogic.reviewCards(review).filter { it.op.id !in answered }
    fun detail(id: String) = details[wikiKey(id)]
    fun isMissing(id: String) = wikiKey(id) in missing
    fun loadFailed(id: String) = wikiKey(id) in failed
    fun run(id: String): WikiChangesetView? = runs[wikiKey(id)] ?: home?.run(id)
    fun isMissingRun(id: String) = wikiKey(id) in missingRuns
}

/** The account's wiki behind every Wiki page, rebuilt per signed-in handle (iOS `WikiModel`). Refetched
 * rather than patched: a nudge re-reads what is loaded, and so does every write this client makes. */
internal class WikiStore(private val auth: AuthSession, val handle: SessionHandle, private val scope: CoroutineScope,
    val client: WikiClient = WikiClient(auth, handle)) {
    private val mutable = MutableStateFlow(WikiState())
    val state: StateFlow<WikiState> = mutable.asStateFlow()
    private var articlesSpaceId: String? = null
    private var nudgeJob: Job? = null
    private val onScreen = mutableMapOf<String, Int>()
    private fun set(change: (WikiState) -> WikiState) = mutable.update(change)
    private val current get() = mutable.value

    init {
        scope.launch {
            val saved = optional { auth.readData(handle, DataKind.CACHE, SPACE_KEY)?.decodeToString() }
            if (saved != null && current.selectedSlug == null) set { it.copy(selectedSlug = saved) }
        }
    }

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
        set { it.copy(spacesState = it.spacesState.begin()) }
        try {
            val list = client.spaces()
            set { it.copy(spaces = list, spacesState = it.spacesState.succeed()) }
        } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) {
            set { it.copy(spacesState = it.spacesState.fail()) }
        }
    }

    /** The spaces, then the four reads the home page is drawn from, side by side — and each run Recently changed folds. */
    suspend fun loadHome() = supervisorScope {
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
        try {
            val base = WikiHomeContent(document.await(), current.spaces, entries.await(), timeline.await()?.items.orEmpty(), space.pendingOps ?: 0)
            val runs = base.recentRunIds.map { id -> async { optional { client.changeset(id) } } }.mapNotNull { it.await() }
            val healthRead = health.await()
            if (current.currentSpace?.id != space.id) return@supervisorScope
            set { it.copy(home = base.copy(runs = runs, health = healthRead), homeState = it.homeState.succeed()) }
        } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) {
            document.cancel(); entries.cancel(); timeline.cancel(); health.cancel()
            if (current.currentSpace?.id == space.id) set { it.copy(homeState = it.homeState.fail()) }
        }
    }

    suspend fun loadReview() {
        set { it.copy(reviewState = it.reviewState.begin()) }
        try {
            val queue = client.review()
            set { it.copy(review = queue, reviewState = it.reviewState.succeed()) }
        } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) {
            set { it.copy(reviewState = it.reviewState.fail()) }
        }
    }

    /** A 404 is an entry the server will not show — deleted, or not this account's (`WikiModel.loadEntry`). */
    suspend fun loadEntry(id: String) {
        val key = wikiKey(id)
        try {
            val detail = client.entry(id)
            set { it.copy(details = it.details + (key to detail), missing = it.missing - key, failed = it.failed - key) }
        } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) {
            // A 404 is an entry the server will not show — deleted, or not this account's; any other failure keeps
            // what is on screen, and says so only when there is nothing on screen (`WikiModel.loadEntry`).
            if (error is ApiError && error.status == 404) set { it.copy(missing = it.missing + key) }
            else set { it.copy(failed = it.failed + key) }
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

    /** The account stream said something changed, or a write landed: re-read what is loaded, once for a burst. */
    fun nudge() {
        if (nudgeJob?.isActive == true) return
        nudgeJob = scope.launch { delay(500); nudgeJob = null; if (live()) optional { reloadLoaded() } }
    }

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
        current.runs.keys.toList().forEach { loadRun(it) }
        if (current.reviewState.hasLoaded) loadReview()
        onScreen.keys.toList().forEach { loadEntry(it) }
    }

    // MARK: the documents

    suspend fun loadDocsDirectory() {
        if (current.spaces.isEmpty()) loadSpaces()
        val space = articlesSpace() ?: return
        val read = optional { client.docs(space.id) } ?: return
        if (articlesSpaceId == space.id) set { it.copy(docsDirectory = read) }
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
        set { it.copy(planState = it.planState.begin()) }
        val versions = async { optional { client.planVersions(space.id) } }
        try {
            val read = client.plan(space.id)
            if (articlesSpaceId == space.id) set { it.copy(planMissing = false, plan = read, planState = it.planState.succeed()) }
        } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) {
            if (error is ApiError && error.status == 404) {
                if (articlesSpaceId == space.id) set { it.copy(planMissing = true, plan = null, planState = it.planState.succeed()) }
            } else set { it.copy(planState = it.planState.fail()) }
        }
        versions.await()?.let { read -> if (articlesSpaceId == space.id) set { it.copy(planVersions = read.versions) } }
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
    }

    /** Draft plan, or Redraft… with the owner's words. Nil refusal on success, with whether a job was made. */
    suspend fun redraftPlan(instructions: String?): Pair<Boolean, String?> {
        val space = current.currentSpace ?: return false to WikiCopy.refused
        return busy {
            try { val created = client.redraftPlan(space.id, instructions); loadPlan(); created to null }
            catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { loadPlan(); false to wikiRefusal(error) }
        }
    }
    suspend fun confirmPlan(version: Int) = planWrite { client.confirmPlan(it.id, version) }
    suspend fun editPlan(body: JsonObject) = planWrite { client.editPlan(it.id, body) }
    suspend fun rejectPlanProposal(id: String): String? = busy {
        try { client.decidePlanProposal(id, accept = false); loadPlan(); null }
        catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { loadPlan(); wikiRefusal(error) }
    }
    /** Accept: a new draft over the newest version; with no other draft waiting it is confirmed at once. */
    suspend fun acceptPlanProposal(id: String, confirm: Boolean): Pair<PlanWrite, Boolean> {
        val space = current.currentSpace ?: return PlanWrite.Failed(WikiCopy.refused) to false
        return busy {
            val draft = try {
                client.decidePlanProposal(id, accept = true) ?: run { loadPlan(); return@busy PlanWrite.Failed(WikiCopy.refused) to false }
            } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) {
                loadPlan()
                return@busy (wikiGateErrors(error)?.let { PlanWrite.Refused(it) } ?: PlanWrite.Failed(wikiRefusal(error))) to false
            }
            if (!confirm) { loadPlan(); return@busy PlanWrite.Done(draft.version) to false }
            try {
                val confirmed = client.confirmPlan(space.id, draft.version)
                loadPlan(); loadDocsDirectory()
                PlanWrite.Done(confirmed.version) to true
            } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) {
                loadPlan()
                (wikiGateErrors(error)?.let { PlanWrite.Refused(it) } ?: PlanWrite.Failed(wikiRefusal(error))) to false
            }
        }
    }
    private suspend fun planWrite(write: suspend (WikiSpace) -> WikiPlanVersion): PlanWrite {
        val space = current.currentSpace ?: return PlanWrite.Failed(WikiCopy.refused)
        return busy {
            try { val version = write(space); loadPlan(); loadDocsDirectory(); PlanWrite.Done(version.version) }
            catch (cancel: CancellationException) { throw cancel } catch (error: Exception) {
                loadPlan(); wikiGateErrors(error)?.let { PlanWrite.Refused(it) } ?: PlanWrite.Failed(wikiRefusal(error))
            }
        }
    }

    // MARK: Review

    /** The owner's answer to one pending op. Nil on success, else the sentence to show. The card leaves the
     * queue at once (`answered`), and the reads catch the queue, the drawer's count and the home page up behind it. */
    suspend fun decide(card: WikiLogic.ReviewCard, action: String, reason: String? = null,
        edited: JsonObject? = null): String? {
        val refusal = scope.async {
            busy {
                try {
                    client.decide(card.changeset.id, card.op.id, action, edited, reason)
                    set { it.copy(answered = it.answered + card.op.id) }
                    null
                } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { reloadAfterWrite(); wikiRefusal(error) }
            }
        }.await()
        if (refusal != null) return refusal
        scope.launch {
            optional { reloadAfterWrite() }
            // Only what the server no longer lists as waiting comes off the list.
            val waiting = WikiLogic.reviewCards(current.review).map { it.op.id }.toSet()
            set { it.copy(answered = it.answered.intersect(waiting)) }
        }
        return null
    }

    /** The entry an op names, for the cards that are about an existing entry. */
    suspend fun loadEntriesNamed(cards: List<WikiLogic.ReviewCard>) {
        cards.forEach { card ->
            val id = card.op.entryId ?: return@forEach
            if (current.detail(id) == null && !current.isMissing(id)) loadEntry(id)
        }
    }

    // MARK: Wiki settings

    suspend fun updateSpace(space: WikiSpace, update: JsonObject): String? = busy {
        try { client.updateSpace(space.id, update); reloadAfterWrite(); null }
        catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { loadSpaces(); wikiRefusal(error) }
    }

    // MARK: an entry a review mode applied

    suspend fun confirm(entry: WikiEntry): String? = answer(entry.id) { client.confirmEntry(entry.id) }
    suspend fun reject(entryId: String, reason: String): String? {
        require(reason in WikiCopy.rejectReasons)
        return answer(entryId) { client.rejectEntry(entryId, reason) }
    }
    private suspend fun answer(entryId: String, write: suspend () -> Unit): String? = busy {
        try { write(); reloadAfterWrite(); loadEntry(entryId); null }
        catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { loadEntry(entryId); wikiRefusal(error) }
    }

    // MARK: one run

    suspend fun loadRun(id: String) {
        val key = wikiKey(id)
        try {
            val read = client.changeset(id)
            set { it.copy(runs = it.runs + (key to read), missingRuns = it.missingRuns - key) }
        } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) {
            if (error is ApiError && error.status == 404) set { it.copy(missingRuns = it.missingRuns + key) }
        }
    }
    suspend fun revert(run: WikiChangesetView): String? = busy {
        try { client.revert(run.id); reloadAfterWrite(); loadRun(run.id); null }
        catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { wikiRefusal(error) }
    }

    // MARK: the owner's own writes, from an entry's page

    suspend fun edit(entry: WikiEntry, title: String, summary: String) = write(entry, buildJsonObject {
        put("op", JsonPrimitive("amend")); put("entryId", JsonPrimitive(entry.id))
        put("baseRevision", JsonPrimitive(entry.currentRevision ?: 1))
        put("changes", buildJsonObject {
            put("title", JsonPrimitive(title)); put("summary", JsonPrimitive(summary)) })
    }, WikiCopy.editedRationale(entry.displayTitle), "wiki-edit")

    /** A replacement with the entry's kind, fields, topics, aliases and anchors, under a new title and summary. */
    suspend fun supersede(entry: WikiEntry, title: String, summary: String) = write(entry, wikiSupersedeOp(entry, title, summary),
        WikiCopy.replacedRationale(entry.displayTitle), "wiki-supersede")

    suspend fun retire(entry: WikiEntry, reason: String) = write(entry, buildJsonObject {
        put("op", JsonPrimitive("retire")); put("entryId", JsonPrimitive(entry.id))
        put("baseRevision", JsonPrimitive(entry.currentRevision ?: 1)); put("reason", JsonPrimitive(reason))
    }, WikiCopy.retiredRationale(entry.displayTitle), "wiki-retire")

    /** One owner write with an idempotency key of its own, so a resend of the same press is one write. */
    private suspend fun write(entry: WikiEntry, op: JsonObject, rationale: String, key: String): String? {
        val spaceId = entry.spaceId ?: current.currentSpace?.id ?: return WikiCopy.refused
        return busy {
            try {
                val result = client.submit(spaceId, op, rationale, "$key:${UUID.randomUUID().toString().lowercase()}")
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

    companion object {
        private const val SPACE_KEY = "wiki-selected-space"
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
