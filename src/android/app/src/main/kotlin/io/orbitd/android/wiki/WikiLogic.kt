package io.orbitd.android.wiki

import io.orbitd.android.core.net.ApiError
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeParseException
import kotlinx.serialization.json.*

/** OrbitKit `RelativeTime`: ISO-8601 instants, and the web's ago/span words both clients print. */
internal object RelativeTime {
    fun parse(iso: String?): Instant? {
        if (iso.isNullOrEmpty()) return null
        return try { OffsetDateTime.parse(iso).toInstant() } catch (_: DateTimeParseException) {
            try { Instant.parse(iso) } catch (_: DateTimeParseException) { null }
        }
    }
    /** "45s", "12m", "3h 20m", "23h", "2d 4h", "12d" (web `formatSpan`). */
    fun span(seconds: Double): String {
        val abs = maxOf(0.0, seconds)
        val minute = 60.0; val hour = 3600.0; val day = 86_400.0
        if (abs < minute) return "${maxOf(1, abs.toInt())}s"
        if (abs < hour) return "${(abs / minute).toInt()}m"
        if (abs < day) {
            val h = (abs / hour).toInt(); val m = ((abs % hour) / minute).toInt()
            return if (h < 6 && m > 0) "${h}h ${m}m" else "${h}h"
        }
        val d = (abs / day).toInt(); val h = ((abs % day) / hour).toInt()
        return if (d < 3 && h > 0) "${d}d ${h}h" else "${d}d"
    }
    fun seconds(from: Instant, to: Instant) = (to.toEpochMilli() - from.toEpochMilli()) / 1000.0
    /** "just now" under ten seconds, "3h 20m ago" above it (the web's `ago`); nil when unreadable. */
    fun ago(iso: String?, now: Instant): String? {
        val date = parse(iso) ?: return null
        val diff = seconds(date, now)
        return if (diff < 10) "just now" else "${span(diff)} ago"
    }
}

/** A part of the Wiki home's status line (OrbitKit `WikiStatusPart`). */
internal data class WikiStatusPart(val text: String, val tone: Tone = Tone.PLAIN, val mark: Mark = Mark.NONE,
    val link: Link = Link.NONE, val strong: Boolean = false) {
    enum class Tone { PLAIN, MUTED, WARN, ERROR }
    enum class Mark { NONE, CHECK, DOT, SPIN }
    enum class Link { NONE, SETTINGS, RUN }
}

internal object WikiHealthLogic {
    /** "just now", "4m ago", "2h ago", "1d ago", "3w ago" (web `wikiAgo`). */
    fun ago(iso: String?, now: Instant): String {
        val date = RelativeTime.parse(iso) ?: return "just now"
        val diff = RelativeTime.seconds(date, now)
        val minute = 60.0; val hour = 3600.0; val day = 86_400.0
        return when {
            diff < minute -> "just now"
            diff < hour -> "${(diff / minute).toInt()}m ago"
            diff < day -> "${(diff / hour).toInt()}h ago"
            diff < 7 * day -> "${(diff / day).toInt()}d ago"
            else -> "${(diff / (7 * day)).toInt()}w ago"
        }
    }
    /** Hours up to three days, then days (web `wikiLag`). */
    fun lag(seconds: Int): String {
        val s = maxOf(0, seconds)
        return when { s < 3600 -> "${s / 60}m"; s < 3 * 86_400 -> "${s / 3600}h"; else -> "${s / 86_400}d" }
    }
    /** The maintenance part of the line in the space's look (web `wikiMaintenanceParts`). */
    fun parts(health: WikiMaintenanceHealth, now: Instant): List<WikiStatusPart> {
        val catchUp = WikiStatusPart(WikiHealthCopy.toCatchUp(health.backlog))
        return when (health.look) {
            "off" -> listOf(WikiStatusPart(WikiHealthCopy.maintenanceOff, tone = WikiStatusPart.Tone.MUTED),
                WikiStatusPart(WikiHealthCopy.setUp, link = WikiStatusPart.Link.SETTINGS))
            "running" -> listOf(WikiStatusPart(WikiHealthCopy.maintainingNow(ago(health.running?.startedAt ?: "", now)),
                mark = WikiStatusPart.Mark.SPIN), catchUp)
            "behind" -> buildList {
                add(WikiStatusPart(WikiHealthCopy.maintenanceBehind, WikiStatusPart.Tone.WARN, WikiStatusPart.Mark.DOT, strong = true))
                add(WikiStatusPart(WikiHealthCopy.behindBy(health.backlog, lag(health.lagSeconds)), WikiStatusPart.Tone.WARN))
                health.lastRunAt?.let { add(WikiStatusPart(WikiHealthCopy.lastRun(ago(it, now)))) }
                if (health.dailyLimitReached) add(WikiStatusPart(WikiHealthCopy.dailyLimitReached))
                else if (health.held?.reason == "review_queue_full") add(WikiStatusPart(WikiHealthCopy.reviewQueueFull))
            }
            "failing" -> buildList {
                add(WikiStatusPart(WikiHealthCopy.failed(health.consecutiveFailures), WikiStatusPart.Tone.ERROR, WikiStatusPart.Mark.DOT, strong = true))
                health.lastOkAt?.let { add(WikiStatusPart(WikiHealthCopy.lastSuccess(ago(it, now)))) }
                add(catchUp)
                if (health.lastRun?.sessionId != null) add(WikiStatusPart(WikiModeCopy.viewRun, link = WikiStatusPart.Link.RUN))
            }
            "ok" -> listOf(health.lastOkAt?.let { WikiStatusPart(WikiHealthCopy.maintained(ago(it, now)), mark = WikiStatusPart.Mark.CHECK) }
                ?: WikiStatusPart(WikiHealthCopy.maintenanceOn), catchUp)
            else -> emptyList()
        }
    }
    /** `●` before a dot, `✓` after a check, ` · ` between (web `wikiStatusText`): what TalkBack reads. */
    fun text(parts: List<WikiStatusPart>): String = parts.joinToString(" · ") { part ->
        (if (part.mark == WikiStatusPart.Mark.DOT) "● " else "") + part.text + (if (part.mark == WikiStatusPart.Mark.CHECK) " ✓" else "")
    }
}

/** The tones the Wiki's marks are drawn in (OrbitKit `WikiTone`). */
internal enum class WikiTone { OWNER, BLUE, MUTED, GREEN, AMBER, RED }
internal data class WikiAnchorMark(val word: String, val tone: WikiTone)
internal data class WikiFieldRow(val label: String, val lines: List<String>)
internal data class WikiDiffHunk(val label: String, val lines: List<Line>) {
    data class Line(val added: Boolean, val text: String)
}

internal object WikiLogic {
    // MARK: the home's principles

    /** How many principles the home reads: the most one read answers, far above any space's own rules (`PRINCIPLES_READ`). */
    const val PRINCIPLES_READ = 200

    /** The home's principles, from their own read (`?kind=principle`): every one, of any status, oldest recorded first —
     * the owner's rules do not reshuffle as the space fills up. Never picked out of the newest 200 entries of every kind:
     * a space holds thousands, and its principles are among the oldest of them. */
    fun principles(entries: List<WikiEntry>): List<WikiEntry> = entries.filter { it.kind == "principle" }
        .sortedBy { RelativeTime.parse(it.recordedAt) ?: Instant.MIN }

    // MARK: Activity

    /** Activity's blocks, top to bottom (design §12.3.2, mock 31 ②) — the home's management blocks, moved in their order,
     * as the web's `WikiActivityPage.tsx` draws them: the status line, the proposals' banner, the space's plan banners,
     * the other spaces' plan banners that wait on the owner, Recent decisions, Recently changed and Agents used the wiki
     * (OrbitKit `WikiLogic.ActivityBand`). The page lays its rows out in this order. */
    enum class ActivityBand(val title: String?) {
        STATUS(null), REVIEW_BANNER(null), PLAN_BANNERS(null), OTHER_PLAN_BANNERS(null),
        RECENT_DECISIONS(WikiCopy.recentDecisions), RECENTLY_CHANGED(WikiCopy.recentlyChanged), AGENTS_USED(WikiCopy.agentsUsed)
    }

    // MARK: whether the account has the wiki

    /** The refusal every wiki route answers an account the server has not switched the wiki on for (`WIKI_DISABLED`). */
    const val disabledCode = "WIKI_DISABLED"
    /** A 404 carrying WIKI_DISABLED: the wiki is off, not a read that failed (`isWikiDisabled`). */
    fun isDisabled(error: Throwable) = error is ApiError && error.status == 404 && error.code == disabledCode
    /** Whether the drawer draws the Wiki row (`wikiShown`): once the spaces read has answered anything but WIKI_DISABLED,
     * and when it failed for any other reason; not while it is on its way, so an account the wiki is off for is never
     * offered a row to press. */
    fun shown(spaces: LoadState, disabled: Boolean) = if (spaces.hasLoaded) !disabled else spaces.lastLoadFailed

    /** A 40-character sha as its short form; any other ref as it is. */
    fun shortSha(ref: String): String =
        if (ref.length == 40 && ref.all { it in '0'..'9' || it in 'a'..'f' }) ref.take(7) else ref

    fun anchorMark(state: String?, checkedRef: String?): WikiAnchorMark? = when (state) {
        "verified" -> WikiAnchorMark(checkedRef?.let(::shortSha) ?: "Checked", WikiTone.GREEN)
        "changed" -> WikiAnchorMark("Changed", WikiTone.AMBER)
        "missing" -> WikiAnchorMark("Missing", WikiTone.RED)
        else -> null
    }
    fun anchorStateMark(anchor: WikiAnchor): WikiAnchorMark = when (anchor.check?.state) {
        "verified" -> WikiAnchorMark(anchor.check?.ref?.let(::shortSha) ?: "Checked", WikiTone.GREEN)
        "changed" -> WikiAnchorMark("Changed", WikiTone.AMBER)
        "missing" -> WikiAnchorMark("Missing", WikiTone.RED)
        else -> WikiAnchorMark("Unchecked", WikiTone.MUTED)
    }
    fun anchorLabel(anchor: WikiAnchor): String {
        anchor.path?.let { path -> return anchor.symbol?.let { "$path · $it" } ?: path }
        anchor.sha?.let { return shortSha(it) }
        anchor.command?.let { return it }
        anchor.ref?.let { return it }
        return "—"
    }
    fun trustTone(trust: String?) = when (trust) {
        "owner" -> WikiTone.OWNER; "confirmed" -> WikiTone.BLUE; "auto" -> WikiTone.GREEN; "external" -> WikiTone.AMBER
        else -> WikiTone.MUTED
    }

    // MARK: an entry's fields

    val kindFields = mapOf(
        "principle" to listOf("statement", "rationale"),
        "convention" to listOf("rule", "scope", "exceptions"),
        "decision" to listOf("context", "decision", "alternatives", "consequences", "decidedAt"),
        "pitfall" to listOf("trigger", "symptom", "cause", "fix", "detector"),
        "recipe" to listOf("steps", "verify"),
        "concept" to listOf("definition", "boundaries", "notToConfuseWith"),
    )
    internal val nestedFields = mapOf("trigger" to listOf("paths", "commands", "errorSignature"),
        "verify" to listOf("command", "expectedExit"), "alternatives" to listOf("option", "whyRejected"))
    private val fieldLabels = mapOf("whyRejected" to "Rejected", "alternatives" to "Rejected", "decidedAt" to "Decided",
        "notToConfuseWith" to "Not to be confused with", "expectedExit" to "Expected exit code", "errorSignature" to "Error signature")

    /** `errorSignature` → `Error signature` (web `labelOf`). */
    fun fieldLabel(key: String): String {
        fieldLabels[key]?.let { return it }
        if (key.isEmpty()) return key
        val out = StringBuilder(key.first().uppercase())
        key.drop(1).forEach { c -> if (c.isUpperCase()) out.append(' ').append(c.lowercaseChar()) else out.append(c) }
        return out.toString()
    }
    /** Postgres `jsonb` key order: shortest first, then bytewise — the order the web walks them in. */
    fun jsonbOrder(keys: Collection<String>): List<String> = keys.sortedWith { a, b ->
        val ab = a.encodeToByteArray(); val bb = b.encodeToByteArray()
        if (ab.size != bb.size) ab.size - bb.size else {
            var r = 0
            for (i in ab.indices) { val d = (ab[i].toInt() and 0xff) - (bb[i].toInt() and 0xff); if (d != 0) { r = d; break } }
            r
        }
    }
    fun fieldRows(kind: String?, fields: JsonElement?): List<WikiFieldRow> {
        val obj = fields as? JsonObject ?: JsonObject(emptyMap())
        val keys = kind?.let { kindFields[it] } ?: jsonbOrder(obj.keys)
        return keys.flatMap { rows(it, obj[it]) }
    }
    private fun rows(key: String, value: JsonElement?): List<WikiFieldRow> {
        val label = fieldLabel(key)
        if (key == "alternatives" && value is JsonArray) {
            val lines = value.mapNotNull { item ->
                val option = item["option"].text(); val why = item["whyRejected"].text()
                if (option != null && why != null) "$option — $why" else option ?: why
            }
            return if (lines.isEmpty()) emptyList() else listOf(WikiFieldRow(label, lines))
        }
        return when (value) {
            null, JsonNull -> emptyList()
            is JsonPrimitive -> when {
                value.isString -> if (value.content.isBlank()) emptyList() else listOf(WikiFieldRow(label, listOf(value.content)))
                value.booleanOrNull != null -> emptyList()
                else -> listOf(WikiFieldRow(label, scalarLines(value)))
            }
            else -> scalarLines(value, key).let { if (it.isEmpty()) emptyList() else listOf(WikiFieldRow(label, it)) }
        }
    }
    private fun scalarLines(value: JsonElement, parent: String? = null): List<String> = when (value) {
        is JsonPrimitive -> when {
            value is JsonNull -> emptyList()
            value.isString -> if (value.content.isBlank()) emptyList() else listOf(value.content)
            value.booleanOrNull != null -> emptyList()
            value.longOrNull != null -> listOf(value.longOrNull.toString())
            else -> value.doubleOrNull?.let { d -> listOf(if (d == Math.rint(d) && Math.abs(d) < 1e15) d.toLong().toString() else d.toString()) }.orEmpty()
        }
        is JsonArray -> value.flatMap { scalarLines(it, parent) }
        is JsonObject -> {
            val known = parent?.let { nestedFields[it] }.orEmpty()
            val keys = known.filter { value[it] != null } + jsonbOrder(value.keys.filter { it !in known })
            keys.flatMap { key -> scalarLines(value.getValue(key), key).map { "${fieldLabel(key)}: $it" } }
        }
    }
    /** Every line of the old value removed and every line of the new one added (web `wikiChangesDiff`). */
    fun changesDiff(before: JsonElement?, changes: JsonElement?): List<WikiDiffHunk> {
        val changed = changes as? JsonObject ?: return emptyList()
        val old = before as? JsonObject ?: JsonObject(emptyMap())
        return jsonbOrder(changed.keys).mapNotNull { key ->
            val after = scalarLines(changed.getValue(key), key)
            val was = old[key]?.let { scalarLines(it, key) }.orEmpty()
            if (after.isEmpty() && was.isEmpty()) null
            else WikiDiffHunk(fieldLabel(key), was.map { WikiDiffHunk.Line(false, it) } + after.map { WikiDiffHunk.Line(true, it) })
        }
    }

    // MARK: the home page's reads

    fun entries(entries: List<WikiEntry>, kind: String) = entries.filter { it.kind == kind }.sortedWith(::changedFirst)
    /** Newest change first: when what an entry says became true (`byChangedAtDesc`). */
    fun changedFirst(a: WikiEntry, b: WikiEntry): Int {
        val at = RelativeTime.parse(a.validFrom) ?: Instant.MIN; val bt = RelativeTime.parse(b.validFrom) ?: Instant.MIN
        return if (at != bt) bt.compareTo(at) else b.id.compareTo(a.id)
    }
    fun changeVerb(item: WikiTimelineItem): String {
        if (item.decision == "accepted") return WikiCopy.historyConfirmedBy
        if (item.decision == "edited") return "Edited by you"
        return when (item.op) {
            "retire" -> "Retired"; "supersede" -> "Superseded"; "reinforce" -> "Reinforced"; "challenge" -> "Challenged"
            "add" -> if (item.origin == "owner") "Added by you" else if (item.appliedByMode != null) "Added" else "Proposed"
            else -> if (item.origin == "owner") "Amended by you" else "Amended"
        }
    }
    fun changeNote(item: WikiTimelineItem): String? {
        if (item.op == "retire") return item.supersededByTitle?.let { "replaced by “$it”" } ?: item.reason
        if (item.op == "supersede") item.supersededByTitle?.let { return "replaces “$it”" }
        return null
    }
    fun sourceWord(kind: String?) = when (kind) {
        "turn" -> "Turn"; "event" -> "Event"; "tool_call" -> "Tool call"; "task" -> "Task"; "task_comment" -> "Task comment"
        "approval" -> "Approval"; "evidence" -> "Evidence"; "owner_decision" -> "Your decision"; "merge_receipt" -> "Merge receipt"
        "criterion" -> "Criterion"; "commit" -> "Commit"; "note" -> "Note"; "url" -> "url"; else -> ""
    }
    fun sourceRef(source: WikiSource): String {
        source.locator["path"].text()?.let { return it }
        source.locator["url"].text()?.let { return it }
        return shortSha(source.ref ?: "")
    }

    // MARK: Review

    enum class ReviewTab(val title: String) {
        ALL(WikiCopy.tabAll), ADD(WikiCopy.tabAdd), AMEND(WikiCopy.tabAmend), RETIRE(WikiCopy.tabRetire);
        fun holds(op: String?) = when (this) { ALL -> true; ADD -> op == "add"; AMEND -> op == "amend" || op == "supersede"; RETIRE -> op == "retire" }
    }
    data class ReviewCard(val changeset: WikiChangeset, val op: WikiChangesetOp) { val id get() = "${changeset.id}:${op.seq ?: 0}" }

    fun reviewCards(changesets: List<WikiChangeset>): List<ReviewCard> = changesets.flatMap { changeset ->
        changeset.ops.orEmpty().filter { it.decision == "pending" }.sortedBy { it.seq ?: 0 }.map { ReviewCard(changeset, it) }
    }
    fun oldestProposal(cards: List<ReviewCard>): String? = cards.mapNotNull { card ->
        card.changeset.createdAt?.let { at -> RelativeTime.parse(at)?.let { at to it } } }.minByOrNull { it.second }?.first
    fun decidedToast(op: String?, action: String): String = when (action) {
        "edit" -> WikiCopy.decidedEdited; "reconfirm" -> WikiCopy.decidedReconfirmed; "amend" -> WikiCopy.decidedAmended
        "retire" -> WikiCopy.retired
        "reject" -> if (op == "retire") WikiCopy.decidedKept else WikiCopy.rejected
        else -> if (op == "retire") WikiCopy.retired else WikiCopy.decidedAccepted
    }
    /** What the server recorded for the op a decide answered: the changeset it returns lists every op with its
     * `decision`. Null when the answer does not say. */
    fun recordedDecision(answer: JsonElement?, opId: String): String? = (answer as? JsonObject)?.get("ops")?.let { it as? JsonArray }
        ?.filterIsInstance<JsonObject>()?.firstOrNull { sameWikiId(it["id"].text(), opId) }?.get("decision").text()
    /** A recorded decision that applied nothing, as the refusal to show (`conflict`: the entry moved past the op, or —
     * for a challenge — is no longer active; `withdrawn`); null when the answer did what was asked. Except a
     * challenge's Retire: the retire takes every op still waiting on the entry with it, the challenge it answers
     * included, so `withdrawn` there is the answer done (OrbitKit `WikiLogic.decisionRefusal(_:op:action:)`). */
    fun decisionRefusal(decision: String?, op: String?, action: String): String? = when (decision) {
        "conflict" -> if (op == "challenge") WikiCopy.inactiveRefused else WikiCopy.conflictRefused
        "withdrawn" -> if (op == "challenge" && action == "retire") null else WikiCopy.withdrawnRefused
        else -> null
    }
    fun cardTitle(card: ReviewCard, entry: WikiEntry?) = knownTitle(card, entry) ?: WikiCopy.entryWord
    /** The draft's title, else the named entry's — as its own read has it, or until that read lands, as Review's read
     * carries it (`entryTitle`). Null rather than the placeholder word. */
    fun knownTitle(card: ReviewCard, entry: WikiEntry?): String? {
        card.op.payload["entry"]["title"].text()?.let { return it }
        entry?.title?.takeIf { it.isNotEmpty() }?.let { return it }
        return card.op.entryTitle?.takeIf { it.isNotEmpty() }
    }
    fun reviewAnchorLines(draft: JsonElement?, fallback: List<WikiAnchor>?): List<String> {
        fun line(path: String?, symbol: String?, sha: String?, command: String?, ref: String?): String? =
            if (path != null) symbol?.let { "$path · $it" } ?: path else sha ?: command ?: ref
        val anchors = draft["anchors"]
        if (anchors is JsonArray) return anchors.mapNotNull {
            line(it["path"].text(), it["symbol"].text(), it["sha"].text(), it["command"].text(), it["ref"].text())
        }
        return fallback.orEmpty().mapNotNull { line(it.path, it.symbol, it.sha, it.command, it.ref) }
    }
    /** The keys an anchor is written with (contract `anchorTypes.<type>.fields`, and `type`). */
    val anchorInputKeys = setOf("type", "path", "symbol", "regionSha256", "sha", "criterionId", "semanticHash",
        "contentHash", "command", "expectedExit", "ref")
    fun anchorInput(anchor: JsonElement): JsonElement =
        if (anchor is JsonObject) JsonObject(anchor.filterKeys { it in anchorInputKeys }) else anchor
    fun cardKind(card: ReviewCard, entry: WikiEntry?): String? = card.op.payload["entry"]["kind"].text() ?: entry?.kind
    fun cardChip(op: String?): String = if (op == "supersede") WikiCopy.opLabel("amend") else WikiCopy.opLabel(op)
    fun proposedBy(changeset: WikiChangeset): String {
        if (changeset.sessionId != null) {
            val rationale = changeset.rationale?.trim()
            if (rationale.isNullOrEmpty()) return "a session"
            // Characters as a person sees them (grapheme clusters), as Swift's `count`/`prefix` are.
            val breaks = java.text.BreakIterator.getCharacterInstance().apply { setText(rationale) }
            var characters = 0; var cut = 0
            while (breaks.next() != java.text.BreakIterator.DONE) { characters++; if (characters == 47) cut = breaks.current() }
            return if (characters > 48) rationale.substring(0, cut) + "…" else rationale
        }
        return if (changeset.origin == "owner") "you" else WikiCopy.historyMaintenance
    }
    fun proposingSessions(cards: List<ReviewCard>) = cards.mapNotNull { it.changeset.sessionId }.toSet().size
    fun cards(cards: List<ReviewCard>, tab: ReviewTab) = cards.filter { tab.holds(it.op.op) }
    fun tabLabel(tab: ReviewTab, all: List<ReviewCard>) = "${tab.title} ${cards(all, tab).size}"
    fun clampedIndex(index: Int, count: Int): Int? = if (count <= 0) null else minOf(maxOf(0, index), count - 1)
}

/** What one space's Activity is drawn from (design §12.3.2): the home's management blocks as they stood until the home
 * became content — the status line, Recent decisions, Recently changed, Agents used the wiki — and each band's rows as the
 * web derives them (OrbitKit `WikiHomeContent`). [entries] is the newest entries of every kind, as many as one read
 * answers (200): what the status line counts until the health read is in; never the bands' rows — a space holds thousands
 * of entries, and its decisions are among the oldest of them, so they read their own kind ([decisionEntries]). */
internal data class WikiHomeContent(val space: WikiSpace, val spaces: List<WikiSpace>, val entries: List<WikiEntry>,
    val timeline: List<WikiTimelineItem>, val runs: List<WikiChangesetView> = emptyList(), val health: WikiSpaceHealth? = null,
    val decisionEntries: List<WikiEntry> = emptyList()) {
    /** The four newest decisions, of any status, from their own read (`?kind=decision`). */
    val recentDecisions: List<WikiEntry> get() = WikiLogic.entries(decisionEntries, "decision").take(RECENT_DECISIONS)
    val recentRows: List<WikiModeLogic.RecentRow> get() = WikiModeLogic.recentRows(timeline).take(5)
    val recentRunIds: List<String> get() = recentRows.mapNotNull { (it as? WikiModeLogic.RecentRow.Run)?.changesetId }
    /** How many of those rows came after the reader last looked ([seen], [WikiSeenLog]): what Activity says beside
     * Recently changed (`N new since you last looked`), the rows that wear its blue dot. */
    fun newRows(seen: Double): Int = recentRows.count { WikiSeenLog.isNew(time(it), seen) }
    fun run(id: String) = runs.firstOrNull { sameWikiId(it.id, id) }
    val mostUsed: List<WikiUsageEntry> get() = space.usage?.entries.orEmpty().filter { (it.total ?: 0) > 0 }.take(3)
    val usedThisWeek: Boolean get() = space.usage?.entries.orEmpty().any { (it.total ?: 0) > 0 }
    fun statusParts(now: Instant): List<WikiStatusPart> {
        val count = health?.entries ?: entries.size
        val parts = mutableListOf(WikiStatusPart("${WikiArticleCopy.count(count)} ${WikiCopy.entryNoun(count)}"))
        space.rootCommitSha?.takeIf { it.isNotEmpty() }?.let { parts += WikiStatusPart(WikiCopy.anchorsVerified(it.take(7), "")) }
        health?.let { parts += WikiHealthLogic.parts(it.maintenance, now) }
        return parts
    }
    fun statusLine(now: Instant) = WikiHealthLogic.text(statusParts(now))

    companion object {
        /** The decision log's rows: the newest four. */
        const val RECENT_DECISIONS = 4
        /** When one of Recently changed's rows happened: the change's own time, or the newest of a run's. */
        fun time(row: WikiModeLogic.RecentRow): String? = when (row) {
            is WikiModeLogic.RecentRow.Op -> row.item.at
            is WikiModeLogic.RecentRow.Run -> row.at
        }
    }
}

internal object WikiModeLogic {
    /** The settings page's sections, top to bottom — the web's order (`WIKI_SETTINGS_SECTIONS`). */
    enum class SettingsSection(val title: String) { REVIEW_MODE(WikiModeCopy.reviewMode), MAINTENANCE(WikiModeCopy.maintenance) }
    val modes = listOf("manual", "tiered", "automatic")
    const val defaultMode = "tiered"
    fun mode(settings: WikiSpaceSettings?): String = settings?.reviewMode?.takeIf { it in modes } ?: "manual"
    fun modeFallback(settings: WikiSpaceSettings?, zone: ZoneId = ZoneId.systemDefault()): String? {
        val mode = mode(settings)
        val on = settings?.reviewModeChangedAt?.let { monthDay(it, zone) }
        val `when` = on?.let { " on $it" } ?: ""
        return when {
            settings?.reviewModeChangedBy == "verification" && mode == "tiered" ->
                "Automatic switched itself back to Tiered$`when`: the check rejected more than 30% of the last 50 changes. Choose Automatic again when you want it back."
            settings?.reviewModeChangedBy == "spot_checks" && mode == "manual" ->
                "The spot checks switched this space back to Manual$`when`: you rejected more than 30% of the last 10. Choose another mode when you want it back."
            else -> null
        }
    }
    private val months = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
    fun monthDay(iso: String, zone: ZoneId = ZoneId.systemDefault()): String? {
        val at = RelativeTime.parse(iso)?.atZone(zone) ?: return null
        return "${months[at.monthValue - 1]} ${at.dayOfMonth}"
    }
    fun runWhen(iso: String, zone: ZoneId = ZoneId.systemDefault()): String {
        val at = RelativeTime.parse(iso)?.atZone(zone) ?: return ""
        return "${months[at.monthValue - 1]} ${at.dayOfMonth}, ${String.format(java.util.Locale.ROOT, "%02d:%02d", at.hour, at.minute)}"
    }
    fun workspaceLabel(name: String?, runner: String?): String {
        val named = name?.takeIf { it.isNotEmpty() } ?: "—"
        return if (runner.isNullOrEmpty()) named else "$named · $runner"
    }
    fun providerLabel(provider: String, model: String?) = if (model.isNullOrEmpty()) provider else "$provider · $model"
    enum class LookbackChoice { NOW, DAYS, ALL }
    fun lookbackChoice(days: Int?) = when { days == null -> LookbackChoice.ALL; days == 0 -> LookbackChoice.NOW; else -> LookbackChoice.DAYS }
    fun lookbackDays(choice: LookbackChoice, days: Int): Int? = when (choice) { LookbackChoice.NOW -> 0; LookbackChoice.DAYS -> days; LookbackChoice.ALL -> null }
    fun lookbackDaysOffered(days: Int?) = if (days != null && days > 0) days else WikiMaintenanceSettings.default.lookbackDays!!

    fun answerable(status: String?, trust: String?) = status == "active" && (trust == "auto" || trust == "unreviewed")
    fun canConfirm(status: String?, trust: String?) = answerable(status, trust) && trust == "unreviewed"
    data class Banner(val tone: WikiTone, val lead: String, val text: String)
    fun banner(status: String?, trust: String?, tainted: Boolean): Banner? {
        if (!answerable(status, trust)) return null
        if (tainted) return Banner(WikiTone.AMBER, WikiCopy.webDerived, WikiModeCopy.bannerWebDerived)
        if (trust == "auto") return Banner(WikiTone.GREEN, WikiCopy.trustLabel("auto"), WikiModeCopy.bannerAuto)
        return Banner(WikiTone.MUTED, WikiCopy.trustLabel("unreviewed"), WikiModeCopy.bannerUnreviewed)
    }
    fun whereUsedNote(status: String?, trust: String?) = if (status == "active" && trust == "unreviewed") WikiModeCopy.notSentUnreviewed else null
    fun checkedLine(verdict: String?, model: String?, tainted: Boolean, who: String?, `when`: String?): String {
        val parts = mutableListOf<String>()
        if (verdict != null && model != null) {
            parts += "Checked by $model: ${WikiModeCopy.verdictWord(verdict)}"
            if (tainted) parts += WikiModeCopy.cappedAtUnreviewed
        }
        if (who != null) parts += `when`?.let { "$who, $it" } ?: who
        return parts.joinToString(" · ")
    }

    // MARK: one run

    fun opApplied(op: WikiChangesetOp): Boolean {
        if (op.decision == "auto_applied") return true
        if (op.appliedByMode == null) return false
        return (op.decision == "pending" && op.spotCheck == true) || op.decision == "accepted" || op.decision == "edited"
    }
    fun isRun(appliedByMode: String?) = appliedByMode != null
    data class RunRow(val op: WikiChangesetOp, val entryId: String?, val title: String, val summary: String, val trust: String?)
    data class RunSummary(val applied: Int = 0, val auto: Int = 0, val unreviewed: Int = 0, val rejectedByCheck: Int = 0,
        val toReview: Int = 0, val added: List<RunRow> = emptyList(), val amended: List<RunRow> = emptyList(),
        val reinforced: List<RunRow> = emptyList(), val revertible: Boolean = false, val revertAdds: Int = 0, val revertAmends: Int = 0) {
        val revertTotal get() = revertAdds + revertAmends
    }
    fun runSummary(run: WikiChangesetView): RunSummary {
        val byId = run.entries.associateBy { wikiKey(it.id) }
        val added = mutableListOf<RunRow>(); val amended = mutableListOf<RunRow>(); val reinforced = mutableListOf<RunRow>()
        run.changeset.ops.orEmpty().sortedBy { it.seq ?: 0 }.forEach { op ->
            if (!opApplied(op)) return@forEach
            val row = runRow(op, byId)
            when (op.op) { "add" -> added += row; "amend" -> amended += row; "reinforce" -> reinforced += row }
        }
        return RunSummary(run.counts.applied, run.counts.auto, run.counts.unreviewed, run.counts.rejectedByCheck, run.counts.toReview,
            added, amended, reinforced, run.revertible, run.revert?.adds ?: 0, run.revert?.amends ?: 0)
    }
    private fun runRow(op: WikiChangesetOp, entries: Map<String, WikiEntry>): RunRow {
        val entryId = if (op.op == "add" || op.op == "supersede") op.resultEntryId ?: op.entryId else op.entryId
        val entry = entryId?.let { entries[wikiKey(it)] }
        val draft = op.payload["entry"] ?: op.payload["changes"]
        val verdictTrust = when (op.verification?.verdict) { "supported" -> "auto"; "partial" -> "unreviewed"; else -> null }
        val trust = if (entry != null) (if (entry.status == "active") entry.trust else null)
            else if (op.tainted == true && verdictTrust != null) "unreviewed" else verdictTrust
        return RunRow(op, entryId, entry?.title ?: draft["title"].text() ?: "—", entry?.summary ?: draft["summary"].text() ?: "", trust)
    }
    fun runCounts(summary: RunSummary): List<String> = buildList {
        if (summary.auto > 0) add("${summary.auto} ${WikiCopy.trustLabel("auto")}")
        if (summary.unreviewed > 0) add("${summary.unreviewed} ${WikiCopy.trustLabel("unreviewed")}")
        if (summary.rejectedByCheck > 0) add(WikiModeCopy.rejectedByCheck(summary.rejectedByCheck))
        if (summary.toReview > 0) add(WikiModeCopy.toReview(summary.toReview))
    }
    fun revertBody(summary: RunSummary): String {
        val total = summary.revertTotal
        val clauses = mutableListOf<String>()
        if (summary.revertAdds > 0) clauses += "${summary.revertAdds} added ${if (summary.revertAdds == 1) "entry is" else "entries are"} withdrawn"
        if (summary.revertAmends > 0) clauses += "${summary.revertAmends} amended ${if (summary.revertAmends == 1) "one goes back to its" else "ones go back to their"} previous revision"
        val head = "The $total change${if (total == 1) "" else "s"} it applied ${if (total == 1) "is" else "are"} undone"
        val body = if (clauses.isEmpty()) head else "$head: ${clauses.joinToString(" and ")}"
        return "$body. Agents stop getting ${if (total == 1) "it" else "them"}."
    }

    // MARK: Recently changed

    sealed interface RecentRow {
        val id: String
        data class Op(val item: WikiTimelineItem) : RecentRow { override val id get() = "op:${item.opId}" }
        data class Run(val changesetId: String, val origin: String?, val at: String?, val items: List<WikiTimelineItem>) : RecentRow {
            override val id get() = "run:${wikiKey(changesetId)}"
        }
    }
    fun recentRows(items: List<WikiTimelineItem>): List<RecentRow> {
        val rows = mutableListOf<RecentRow>(); val at = mutableMapOf<String, Int>()
        items.forEach { item ->
            val changesetId = item.changesetId
            if (changesetId == null || !isRun(item.changesetAppliedByMode)) { rows += RecentRow.Op(item); return@forEach }
            val key = wikiKey(changesetId)
            val index = at[key]
            val held = index?.let { rows[it] as? RecentRow.Run }
            if (held != null) { rows[index] = held.copy(items = held.items + item); return@forEach }
            at[key] = rows.size
            rows += RecentRow.Run(changesetId, item.origin, item.at, listOf(item))
        }
        return rows
    }

    // MARK: a challenge

    data class BrokenAnchor(val state: String, val label: String)
    fun brokenAnchors(anchors: List<WikiAnchor>?): List<BrokenAnchor> = anchors.orEmpty().mapNotNull { anchor ->
        val state = anchor.check?.state
        if (state == "changed" || state == "missing") BrokenAnchor(state, anchorWords(anchor)) else null
    }
    fun anchorWords(anchor: WikiAnchor): String = when (anchor.type) {
        "path" -> "path ${anchor.path ?: ""}"
        "symbol" -> "symbol ${anchor.symbol ?: ""} in ${anchor.path ?: ""}"
        "commit" -> "commit ${WikiLogic.shortSha(anchor.sha ?: "")}"
        // A type this build cannot name reads as `unknown`, as Swift's closed set decodes it.
        else -> "${anchor.type?.takeIf { it in setOf("criterion", "merge_evidence", "command", "record") } ?: "unknown"} anchor"
    }
    fun challengeRef(anchors: List<WikiAnchor>?): String? = anchors.orEmpty().mapNotNull { it.check }
        .filter { it.state == "changed" || it.state == "missing" }.sortedByDescending { it.at ?: "" }.firstOrNull()?.ref
}
