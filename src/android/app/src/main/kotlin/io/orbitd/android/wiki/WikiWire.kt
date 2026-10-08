package io.orbitd.android.wiki

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.navigation.ObjectId
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

// The Wiki's wire types, transcribed from OrbitKit `Models/Wiki*.swift` (the fixed iOS baseline).
// Closed sets stay the raw words the server sent, so a value one release ahead reads as unknown
// instead of failing the page; every field a page draws is optional for the same reason.

/** Either spelling of an id: a UUID or its public form name the same object. */
internal fun wikiKey(id: String?): String = id?.let { ObjectId.canonical(it) ?: it }.orEmpty()
internal fun sameWikiId(a: String?, b: String?) = a != null && b != null && wikiKey(a) == wikiKey(b)

/** OrbitKit `PublicID.toPublic`: a UUID's 16 bytes as Base62, the spelling the deployment's own routes use. */
internal fun wikiPublicId(id: String): String {
    val uuid = ObjectId.canonical(id) ?: return id
    var number = java.math.BigInteger(uuid.replace("-", ""), 16)
    if (number.signum() == 0) return "0"
    val alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    val out = StringBuilder(); val base = java.math.BigInteger.valueOf(62)
    while (number.signum() > 0) { val (q, r) = number.divideAndRemainder(base); out.append(alphabet[r.toInt()]); number = q }
    return out.reverse().toString()
}

internal fun <T> JsonElement?.lenient(serializer: KSerializer<T>): T? =
    this?.takeIf { it !is JsonNull }?.let { runCatching { Wire.json.decodeFromJsonElement(serializer, it) }.getOrNull() }
internal fun JsonElement?.text(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
internal fun JsonElement?.integer(): Int? = (this as? JsonPrimitive)?.takeIf { !it.isString }?.let { it.intOrNull ?: it.doubleOrNull?.takeIf { d -> d == Math.floor(d) }?.toInt() }
internal fun JsonElement?.bool(): Boolean? = (this as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
internal operator fun JsonElement?.get(key: String): JsonElement? = (this as? JsonObject)?.get(key)

// MARK: an anchor

@Serializable
data class WikiAnchorCheck(val state: String? = null, val ref: String? = null, val at: String? = null)

@Serializable
data class WikiAnchor(
    val type: String? = null, val path: String? = null, val symbol: String? = null, val regionSha256: String? = null,
    val sha: String? = null, val criterionId: String? = null, val semanticHash: String? = null, val contentHash: String? = null,
    val command: String? = null, val expectedExit: Int? = null, val ref: String? = null, val check: WikiAnchorCheck? = null,
)

// MARK: a space

/** Contract `space.settings.maintenance`; a key left out reads as its default, a null look-back is all history. */
data class WikiMaintenanceSettings(val enabled: Boolean, val workspaceId: String?, val provider: String,
    val dailyRunLimit: Int, val lookbackDays: Int?, val listId: String?) {
    companion object {
        val default = WikiMaintenanceSettings(false, null, "local-vllm", 8, 14, null)
        val dailyRunLimitRange = 1..48
        val lookbackDaysRange = 0..365
        fun read(element: JsonElement?): WikiMaintenanceSettings? {
            val c = element as? JsonObject ?: return null
            val limit = c["dailyRunLimit"].integer()?.takeIf { it in dailyRunLimitRange }
            val lookback = if (c.containsKey("lookbackDays") && c["lookbackDays"] is JsonNull) null
                else c["lookbackDays"].integer()?.takeIf { it in lookbackDaysRange } ?: default.lookbackDays
            return WikiMaintenanceSettings(c["enabled"].bool() ?: default.enabled, c["workspaceId"].text(),
                c["provider"].text() ?: default.provider, limit ?: default.dailyRunLimit, lookback, c["listId"].text())
        }
    }
}

@Serializable
data class WikiSpaceSettings(
    val push: Boolean? = null, val autoAcceptReinforce: Boolean? = null,
    @kotlinx.serialization.SerialName("maintenance") val maintenanceJson: JsonElement? = null,
    val reviewMode: String? = null, val automaticSpotChecks: Boolean? = null,
    val reviewModeChangedAt: String? = null, val reviewModeChangedBy: String? = null,
) {
    val maintenance: WikiMaintenanceSettings? get() = WikiMaintenanceSettings.read(maintenanceJson)
}

@Serializable
data class WikiUsageEntry(val entryId: String, val title: String? = null, val total: Int? = null, val pushed: Int? = null,
    val searched: Int? = null, val fetched: Int? = null)

@Serializable
data class WikiUsage(val days: Int? = null, val sessionsPushed: Int? = null, val searches: Int? = null, val gets: Int? = null,
    val entries: List<WikiUsageEntry>? = null)

@Serializable
data class WikiSpace(
    val id: String, val slug: String, val title: String? = null, val repoUrlNorm: String? = null, val rootCommitSha: String? = null,
    val settings: WikiSpaceSettings? = null, val createdAt: String? = null, val updatedAt: String? = null,
    val pendingOps: Int? = null, val usage: WikiUsage? = null,
    /** What of the space's plan waits on the owner (`planWaiting`, c6e66aaef): the drawer's number counts it beside the
     * proposals. Absent from an older server, which then counts the proposals alone. */
    val planWaiting: Int? = null,
    /** The live workspaces bound to the space, in bind order: the space the Wiki opens from one of them. */
    val workspaceIds: List<String>? = null,
    /** The confirmed plan's documents and how many are written; null while the space has no confirmed plan. */
    val docs: WikiDocsDirectory.Counts? = null,
)

// MARK: an entry

@Serializable
data class WikiEntry(
    val id: String, val spaceId: String? = null, val kind: String? = null, val status: String? = null, val trust: String? = null,
    val currentRevision: Int? = null, val title: String? = null, val summary: String? = null, val fields: JsonElement? = null,
    val topics: List<String>? = null, val aliases: List<String>? = null, val anchors: List<WikiAnchor>? = null,
    val anchorState: String? = null, val anchorCheckedRef: String? = null, val anchorCheckedAt: String? = null,
    val tainted: Boolean? = null, val challenged: Boolean? = null, val unsupported: Boolean? = null, val pinned: Boolean? = null,
    val supersedesId: String? = null, val supersededById: String? = null, val validFrom: String? = null, val validTo: String? = null,
    val recordedAt: String? = null, val retiredAt: String? = null,
) {
    /** The title, or the id when the server sent none: a blank row reads as broken. */
    val displayTitle: String get() = title?.takeIf { it.isNotBlank() } ?: id
    /** Whether agents are still handed it. A retired, superseded or rejected entry still reads. */
    val isEnded: Boolean get() = status == "retired" || status == "superseded" || status == "rejected"
}

@Serializable
data class WikiSource(val id: String, val kind: String? = null, val ref: String? = null, val locator: JsonElement? = null,
    val quote: String? = null, val quoteVerified: Boolean? = null, val state: String? = null, val tainted: Boolean? = null,
    val createdAt: String? = null)

@Serializable
data class WikiRevision(val id: String, val revision: Int? = null, val title: String? = null, val summary: String? = null,
    val authorKind: String? = null, val authorSessionId: String? = null, val changesetOpId: String? = null, val createdAt: String? = null)

@Serializable
data class WikiExposure(val sessionId: String? = null, val entryId: String? = null, val revision: Int? = null,
    val channel: String? = null, val at: String? = null)

@Serializable
data class WikiOpVerification(val verdict: String? = null, val reason: String? = null, val model: String? = null,
    val at: String? = null, val duplicateOf: String? = null, val evidence: String? = null)

/** `GET /wiki/entries/:id?include=sources,history,exposure`: the entry's fields at the top level, and its lists. */
data class WikiEntryDetail(val entry: WikiEntry, val sources: List<WikiSource> = emptyList(),
    val history: List<WikiRevision> = emptyList(), val exposure: List<WikiExposure> = emptyList(),
    val changesetId: String? = null, val appliedByMode: String? = null, val verification: WikiOpVerification? = null) {
    @Serializable
    private class Extras(val sources: List<WikiSource>? = null, val history: List<WikiRevision>? = null,
        val exposure: List<WikiExposure>? = null, val changesetId: String? = null, val appliedByMode: String? = null,
        val verification: WikiOpVerification? = null)
    companion object {
        fun decode(element: JsonElement): WikiEntryDetail {
            val entry = Wire.json.decodeFromJsonElement(WikiEntry.serializer(), element)
            val extras = Wire.json.decodeFromJsonElement(Extras.serializer(), element)
            return WikiEntryDetail(entry, extras.sources.orEmpty(), extras.history.orEmpty(), extras.exposure.orEmpty(),
                extras.changesetId, extras.appliedByMode, extras.verification)
        }
    }
}

// MARK: changesets, and Review

@Serializable
data class WikiSimilar(val id: String, val kind: String? = null, val title: String? = null, val status: String? = null,
    val trust: String? = null, val score: Double? = null, val rejectedReason: String? = null, val rejectedBecause: String? = null)

@Serializable
data class WikiChangesetOp(
    val id: String, val changesetId: String? = null, val seq: Int? = null, val op: String? = null, val entryId: String? = null,
    val baseRevision: Int? = null, val payload: JsonElement? = null, val similar: List<WikiSimilar>? = null,
    val tainted: Boolean? = null, val decision: String? = null, val decisionReason: String? = null, val decisionNote: String? = null,
    val resultEntryId: String? = null, val resultRevision: Int? = null, val decidedAt: String? = null,
    val verification: WikiOpVerification? = null, val appliedByMode: String? = null, val spotCheck: Boolean? = null,
    /** The current title of the entry `entryId` names — Review's read adds it, so a card can name an entry no other read
     * holds. Null when the op names none, and on every other read. */
    val entryTitle: String? = null,
)

@Serializable
data class WikiChangeset(
    val id: String, val spaceId: String? = null, val origin: String? = null, val sessionId: String? = null,
    val toolCallId: String? = null, val rationale: String? = null, val status: String? = null, val createdAt: String? = null,
    val decidedAt: String? = null, val expiresAt: String? = null, val ops: List<WikiChangesetOp>? = null,
)

@Serializable
data class WikiChangesetCounts(val applied: Int = 0, val auto: Int = 0, val unreviewed: Int = 0,
    val rejectedByCheck: Int = 0, val toReview: Int = 0)

@Serializable
data class WikiRevertPlan(val adds: Int, val amends: Int)

/** `GET /wiki/changesets/:id`: the changeset's own fields at the top level, and what the read adds. */
data class WikiChangesetView(val changeset: WikiChangeset, val appliedByMode: String? = null,
    val entries: List<WikiEntry> = emptyList(), val counts: WikiChangesetCounts = WikiChangesetCounts(),
    val revertible: Boolean = false, val revert: WikiRevertPlan? = null) {
    val id: String get() = changeset.id
    @Serializable
    private class Extras(val appliedByMode: String? = null, val entries: List<WikiEntry>? = null,
        val counts: WikiChangesetCounts? = null, val revertible: Boolean? = null, val revert: WikiRevertPlan? = null)
    companion object {
        fun decode(element: JsonElement): WikiChangesetView {
            val changeset = Wire.json.decodeFromJsonElement(WikiChangeset.serializer(), element)
            val extras = Wire.json.decodeFromJsonElement(Extras.serializer(), element)
            return WikiChangesetView(changeset, extras.appliedByMode, extras.entries.orEmpty(),
                extras.counts ?: WikiChangesetCounts(), extras.revertible ?: false, extras.revert)
        }
    }
}

@Serializable
data class WikiTimelineItem(
    val opId: String, val op: String? = null, val decision: String? = null, val origin: String? = null, val at: String? = null,
    val entryId: String? = null, val title: String? = null, val kind: String? = null, val status: String? = null,
    val trust: String? = null, val supersededById: String? = null, val supersededByTitle: String? = null, val reason: String? = null,
    val appliedByMode: String? = null, val spotCheck: Boolean? = null, val changesetId: String? = null,
    val changesetAppliedByMode: String? = null,
)

@Serializable
data class WikiTimeline(val items: List<WikiTimelineItem>? = null)

@Serializable
data class WikiSearchHit(val id: String, val kind: String? = null, val title: String? = null, val summary: String? = null,
    val trust: String? = null, val anchorState: String? = null, val match: List<String>? = null, val topics: List<String>? = null)

@Serializable
data class WikiSearchResponse(val q: String? = null, val hits: List<WikiSearchHit>? = null)

@Serializable
data class WikiChangeResult(val changesetId: String? = null, val replayed: Boolean? = null, val ops: List<Outcome>? = null) {
    @Serializable
    data class Outcome(val seq: Int? = null, val status: String? = null, val entryId: String? = null, val revision: Int? = null,
        val reasons: List<Reason>? = null)
    @Serializable
    data class Reason(val code: String? = null, val message: String? = null)
}

// MARK: health (contract `maintenance.health`)

data class WikiMaintenanceHealth(
    val look: String, val enabled: Boolean, val lastOkAt: String? = null, val lastRunAt: String? = null,
    val consecutiveFailures: Int = 0, val backlog: Int = 0, val oldestPendingAt: String? = null, val lagSeconds: Int = 0,
    val dailyLimitReached: Boolean = false, val held: Held? = null, val running: Running? = null,
    val lastRun: LastRun? = null, val lastFailure: LastFailure? = null,
) {
    data class Held(val reason: String, val at: String)
    data class Running(val sessionId: String?, val startedAt: String)
    /** What View run opens: the run's session, or the server's job (`jobId`, P9) of a run that has no session. */
    data class LastRun(val sessionId: String?, val outcome: String?, val endedAt: String, val jobId: String? = null)
    data class LastFailure(val kind: String, val reason: String?, val at: String, val sessionId: String?)
    companion object {
        /** Every field reads as its default when a server one release apart leaves it out. */
        fun read(element: JsonElement?): WikiMaintenanceHealth {
            val c = element as? JsonObject ?: JsonObject(emptyMap())
            val held = (c["held"] as? JsonObject)?.let { h ->
                val reason = h["reason"].text()?.takeIf { it in setOf("daily_limit_reached", "review_queue_full") }
                val at = h["at"].text()
                if (reason != null && at != null) Held(reason, at) else null
            }
            val running = (c["running"] as? JsonObject)?.let { r -> r["startedAt"].text()?.let { Running(r["sessionId"].text(), it) } }
            val lastRun = (c["lastRun"] as? JsonObject)?.let { r -> r["endedAt"].text()?.let { LastRun(r["sessionId"].text(), r["outcome"].text(), it, r["jobId"].text()) } }
            val lastFailure = (c["lastFailure"] as? JsonObject)?.let { f ->
                val kind = f["kind"].text(); val at = f["at"].text()
                if (kind != null && at != null) LastFailure(kind, f["reason"].text(), at, f["sessionId"].text()) else null
            }
            val look = c["look"].text()?.takeIf { it in setOf("off", "failing", "running", "behind", "ok") } ?: "unknown"
            return WikiMaintenanceHealth(look, c["enabled"].bool() ?: false, c["lastOkAt"].text(), c["lastRunAt"].text(),
                c["consecutiveFailures"].integer() ?: 0, c["backlog"].integer() ?: 0, c["oldestPendingAt"].text(),
                c["lagSeconds"].integer() ?: 0, c["dailyLimitReached"].bool() ?: false, held, running, lastRun, lastFailure)
        }
    }
}

/** The repository half of the health read (P2): its look (contract `repoOps.looks`), and how many of the space's
 * repository operations wait. */
data class WikiSpaceRepoHealth(val look: String?, val pending: Int = 0)

/** Contract `jobs.executor.read` (P9): the mode, and whether the server executes this account's wiki. */
data class WikiExecutorView(val mode: String?, val serverExecutes: Boolean = false)

/** The System model as the health read carries it while the server executes the wiki (contract `systemModel.read`):
 * its state, its name and when — never its address or key. */
data class WikiSystemModelStatus(val state: String?, val model: String? = null, val since: String? = null,
    val checkedAt: String? = null, val workerSeenAt: String? = null)

/** `GET /wiki/spaces/:id/health` — and, from P2 and P9 on, what the server's runs depend on: the repository's look,
 * whether the server executes this account's wiki (`executor`), and the System model's state while it does. Each is
 * absent from an older control plane, which reads as runner and draws the line as it always was. */
data class WikiSpaceHealth(val spaceId: String, val entries: Int, val maintenance: WikiMaintenanceHealth,
    val repo: WikiSpaceRepoHealth? = null, val executor: WikiExecutorView? = null, val systemModel: WikiSystemModelStatus? = null) {
    /** The server runs this account's wiki: what the status line's server reasons ask first. */
    val serverExecutes: Boolean get() = executor?.serverExecutes == true
    companion object {
        fun decode(element: JsonElement): WikiSpaceHealth {
            val c = element.jsonObject
            val repo = (c["repo"] as? JsonObject)?.let { WikiSpaceRepoHealth(it["look"].text(), it["pending"].integer() ?: 0) }
            val executor = (c["executor"] as? JsonObject)?.let { WikiExecutorView(it["mode"].text(), it["serverExecutes"].bool() ?: false) }
            val systemModel = (c["systemModel"] as? JsonObject)?.let {
                WikiSystemModelStatus(it["state"].text(), it["model"].text(), it["since"].text(), it["checkedAt"].text(), it["workerSeenAt"].text())
            }
            return WikiSpaceHealth(requireNotNull(c["spaceId"].text()), requireNotNull(c["entries"].integer()),
                WikiMaintenanceHealth.read(c["maintenance"]), repo, executor, systemModel)
        }
    }
}

// MARK: articles (contract `articles`)

@Serializable
data class WikiArticlePartRef(val part: Int, val kind: String? = null, val title: String? = null, val entryCount: Int? = null,
    val generatedAt: String? = null)

@Serializable
data class WikiArticleDirectory(val spaceId: String? = null, val categories: List<Category>? = null, val uncategorized: List<Topic>? = null) {
    @Serializable
    data class Topic(val slug: String, val title: String? = null, val description: String? = null, val category: String? = null,
        val article: WikiArticlePartRef? = null, val parts: List<WikiArticlePartRef>? = null)
    @Serializable
    data class Category(val key: String, val title: String? = null, val topics: List<Topic>? = null)
}

@Serializable
data class WikiArticleSentence(val text: String, val notes: List<Int>)

@Serializable
data class WikiArticleBlock(val heading: String? = null, val sentences: List<WikiArticleSentence>)

@Serializable
data class WikiArticleFootnote(val n: Int, val entryId: String, val revision: Int? = null, val entry: Entry? = null) {
    @Serializable
    data class Entry(val id: String, val kind: String? = null, val title: String? = null, val summary: String? = null,
        val status: String? = null, val trust: String? = null, val currentRevision: Int? = null)
}

@Serializable
data class WikiArticle(
    val spaceId: String? = null, val topic: Topic, val part: Int, val kind: String? = null, val title: String? = null,
    val blocks: List<WikiArticleBlock>, val footnotes: List<WikiArticleFootnote>, val entryCount: Int? = null,
    val entryIds: List<String>? = null, val entries: List<WikiEntry>? = null, val chars: Int? = null,
    val generatedAt: String? = null, val ref: String? = null, val model: String? = null,
    val overview: WikiArticlePartRef? = null, val parts: List<WikiArticlePartRef>? = null,
) {
    @Serializable
    data class Topic(val slug: String, val title: String? = null, val category: String? = null, val categoryTitle: String? = null)
}

@Serializable
data class WikiArticleIndex(val spaceId: String? = null, val items: List<Item>) {
    @Serializable
    data class Item(val part: Int, val kind: String? = null, val title: String? = null, val entryCount: Int? = null,
        val initial: String? = null, val topic: Topic)
    @Serializable
    data class Topic(val slug: String, val title: String? = null)
}

@Serializable
data class WikiTopicView(val slug: String, val title: String? = null, val description: String? = null,
    val declared: Boolean? = null, val entryCount: Int? = null, val entries: List<WikiEntry>? = null)

// MARK: documents (contract `docs`)

@Serializable
data class WikiDocsPlanRef(val version: Int, val confirmedAt: String? = null)

@Serializable
data class WikiDocsDirectory(val spaceId: String? = null, val plan: WikiDocsPlanRef? = null, val docs: Counts? = null,
    val categories: List<Category>) {
    @Serializable
    data class Section(val key: String, val number: Int? = null, val title: String, val kind: String? = null,
        val written: Boolean? = null, val stale: Boolean? = null)
    @Serializable
    data class Doc(val slug: String, val number: String? = null, val title: String, val question: String? = null,
        val written: Boolean? = null, val status: String? = null, val updatedAt: String? = null, val planVersion: Int? = null,
        val sections: List<Section>? = null,
        /** The first two sentences of its first section, cut at 200 characters (contract `docs.lead`); null until it is
         * written, and from a server before the lead. */
        val lead: String? = null)
    @Serializable
    data class Category(val key: String, val number: Int? = null, val title: String, val question: String? = null,
        val forAgents: Boolean? = null, val docs: List<Doc>? = null)
    @Serializable
    data class Counts(val total: Int, val written: Int)
}

@Serializable
data class WikiDocCounts(val sentences: Int, val sourced: Int? = null, val transition: Int? = null, val unsourced: Int? = null,
    val unverified: Int? = null, val withdrawn: Int? = null)

@Serializable
data class WikiDocSentence(val text: String, val status: String, val notes: List<Int>? = null, val newTokens: List<String>? = null,
    val withdrawn: Withdrawn? = null) {
    @Serializable
    data class Withdrawn(val reason: String, val entryId: String? = null, val path: String? = null, val at: String? = null)
}

@Serializable
data class WikiDocBlock(val kind: String, val text: String? = null, val sentences: List<WikiDocSentence>? = null)

@Serializable
data class WikiDocSection(val key: String, val number: Int? = null, val title: String, val kind: String? = null,
    val written: Boolean? = null, val stale: Boolean? = null, val staleAt: String? = null, val generatedAt: String? = null,
    val repoSha: String? = null, val model: String? = null, val blocks: List<WikiDocBlock>? = null)

@Serializable
data class WikiDocFootnote(
    val n: Int, val kind: String, val verdict: String, val checkedBy: String? = null, val quote: String? = null,
    val location: String? = null, val path: String? = null, val sha: String? = null, val lineStart: Int? = null,
    val lineEnd: Int? = null, val section: String? = null, val symbol: String? = null, val excerpt: String? = null,
    val recordId: String? = null, val charStart: Int? = null, val charEnd: Int? = null, val sessionId: String? = null,
    val sessionTitle: String? = null, val seq: Int? = null, val at: String? = null, val label: String? = null,
    val taskId: String? = null, val taskTitle: String? = null, val projectId: String? = null, val projectTitle: String? = null,
    val notePath: String? = null, val viaEntryId: String? = null,
) {
    /** A turn's, an event's or a tool call's footnote opens the transcript at the quoted record (`docs.links.sessionRecord`). */
    val sessionRecord: Pair<String, String>? get() =
        if (kind in setOf("turn", "event", "tool_call") && !sessionId.isNullOrEmpty() && !recordId.isNullOrEmpty()) sessionId to recordId else null
}

@Serializable
data class WikiDocViaEntry(val id: String, val kind: String? = null, val title: String, val status: String? = null,
    val trust: String? = null, val anchorState: String? = null, val notes: List<Int>? = null)

@Serializable
data class WikiPlanRange(val min: Int, val max: Int)

@Serializable
data class WikiDoc(
    val spaceId: String? = null, val slug: String, val number: String? = null, val title: String, val question: String? = null,
    val audience: List<String>? = null, val scopeIn: List<String>? = null, val scopeOut: List<ScopeOut>? = null,
    val category: Category? = null, val length: WikiPlanRange? = null, val planVersion: Int? = null, val written: Boolean,
    val status: String? = null, val writtenFromPlanVersion: Int? = null, val repoSha: String? = null, val updatedAt: String? = null,
    val counts: WikiDocCounts? = null, val unsourcedShare: Double? = null, val sections: List<WikiDocSection>? = null,
    val footnotes: List<WikiDocFootnote>? = null, val entries: List<WikiDocViaEntry>? = null,
) {
    @Serializable
    data class Category(val key: String, val number: Int? = null, val title: String? = null)
    @Serializable
    data class ScopeOut(val text: String, val docs: List<Target>? = null)
    @Serializable
    data class Target(val slug: String, val number: String? = null, val title: String? = null)
}

@Serializable
data class WikiDocsIndex(val spaceId: String? = null, val plan: WikiDocsPlanRef? = null, val items: List<Item>) {
    @Serializable
    data class Item(val kind: String, val title: String, val docSlug: String, val docNumber: String? = null,
        val docTitle: String? = null, val sectionKey: String? = null, val sectionNumber: Int? = null,
        val category: Category? = null, val written: Boolean? = null)
    @Serializable
    data class Category(val key: String, val title: String? = null)
}
