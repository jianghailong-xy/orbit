package io.orbitd.android.wiki

import java.time.Instant

// The spaces as a reader knows them (wiki design §12.3.3–§12.3.4): what each is called, which one the Wiki opens, and how
// much waits on the owner across all of them — OrbitKit `WikiSpaceLogic` (42d12db2b), the Swift half of the web's
// `lib/wikiSpace.ts`. Rules over the spaces list (`GET /wiki/spaces`), not over a page, because the clients are held to
// one set of cases: `src/shared/src/wiki-space.fixture.json`, which `WikiSpaceLogicTest` reads where OrbitKit and the web
// read it.

internal object WikiSpaceLogic {
    // MARK: the name

    /** What each space is called, by id (`wikiSpaceNames`): the last segment of its repository
     * (`github.com/jianghailong-xy/orbit` is `orbit`), its title when it has no repository, and — when two spaces would be
     * called the same — the segments before it until the two differ (`jianghailong-xy/orbit`). */
    fun names(spaces: List<WikiSpace>): Map<String, String> {
        val segments = spaces.associate { it.id to it.repoUrlNorm.orEmpty().split('/').filter(String::isNotEmpty) }
        val depth = spaces.associate { it.id to 1 }.toMutableMap()
        fun name(space: WikiSpace): String {
            val parts = segments[space.id].orEmpty()
            return if (parts.isEmpty()) space.title ?: space.slug else parts.takeLast(depth[space.id] ?: 1).joinToString("/")
        }
        while (true) {
            val longer = spaces.groupBy(::name).values.filter { it.size > 1 }.flatten()
                .filter { (depth[it.id] ?: 1) < (segments[it.id]?.size ?: 0) }
            if (longer.isEmpty()) break
            longer.forEach { depth[it.id] = (depth[it.id] ?: 1) + 1 }
        }
        return spaces.associate { it.id to name(it) }
    }

    fun name(space: WikiSpace, spaces: List<WikiSpace>): String = names(spaces)[space.id] ?: space.title ?: space.slug

    // MARK: which space the Wiki opens

    /** The space the Wiki opens (`wikiDefaultSpace`): the one bound to the workspace the reader is in (`workspaceIds`),
     * else the one they last looked at, else the one with the most documents written — the first of the server's list
     * when that is a tie. Null with no space. */
    fun defaultSpace(spaces: List<WikiSpace>, workspaceId: String?, lastSlug: String?): WikiSpace? {
        if (workspaceId != null) spaces.firstOrNull { space -> space.workspaceIds.orEmpty().any { sameWikiId(it, workspaceId) } }?.let { return it }
        if (lastSlug != null) spaces.firstOrNull { it.slug == lastSlug }?.let { return it }
        var most: WikiSpace? = null
        for (space in spaces) if (most == null || (space.docs?.written ?: 0) > (most.docs?.written ?: 0)) most = space
        return most
    }

    // MARK: what waits on the owner

    /** What waits on the owner in one space (`wikiWaitingIn`): its proposals in Review and the things its plan waits on
     * them for. A count an older server did not send adds nothing. */
    fun waitingIn(space: WikiSpace) = maxOf(0, space.pendingOps ?: 0) + maxOf(0, space.planWaiting ?: 0)

    /** What waits on the owner across every space (`wikiWaiting`, §12.3.3): the drawer's Wiki row and the bar's Activity
     * badge, both from here, and what Activity's amber banners add up to. */
    fun waiting(spaces: List<WikiSpace>) = spaces.sumOf(::waitingIn)

    /** The proposals alone, across every space (`wikiProposalsWaiting`): Activity's first banner, and Review's head. */
    fun proposalsWaiting(spaces: List<WikiSpace>) = spaces.sumOf { maxOf(0, it.pendingOps ?: 0) }

    /** Activity's first banner (`wikiProposalsBanner`, mock 31 ⑤): every space's proposals, with each other space's share
     * on the same line — `3 proposals to review · 2 in wikova` — and nothing after the count when they are all the current
     * space's. Null with none waiting anywhere. */
    fun proposalsBanner(spaces: List<WikiSpace>, currentId: String?, names: Map<String, String> = names(spaces)): String? {
        val total = proposalsWaiting(spaces)
        if (total <= 0) return null
        val elsewhere = spaces.filter { it.id != currentId && (it.pendingOps ?: 0) > 0 }
            .map { WikiCopy.countInSpace(it.pendingOps ?: 0, names[it.id] ?: it.title ?: it.slug) }
        return (listOf(WikiCopy.proposalsToReview(total)) + elsewhere).joinToString(" ")
    }

    /** A space as the web's picker lists it (`wikiSpaceOption`): its name, and what waits in it — `wikova · 2 waiting`. */
    fun option(name: String, space: WikiSpace): String = waitingIn(space).let { if (it > 0) "$name ${WikiCopy.spaceWaiting(it)}" else name }

    // MARK: Activity's banners

    /** One of Activity's banners (mocks 31 ②, ⑤): its line, whether it is amber, how many of the number waiting on the
     * owner it is — none for a blue one — and where a press goes. */
    data class ActivityBanner(val id: String, val band: WikiLogic.ActivityBand, val text: String, val amber: Boolean, val count: Int, val to: To) {
        sealed interface To {
            /** Review, over every space. */
            data object Review : To
            /** A space's plan page. */
            data class Plan(val slug: String) : To
            /** A space's Wiki settings: a plan held for want of a setting. */
            data class Settings(val slug: String) : To
        }
    }

    /** Activity's banners, in its order (`WikiActivityPage.tsx`): every space's proposals, each other space's share on the
     * line, into Review over every space; then the space's plan, one banner for each kind of thing that waits — or, with
     * nothing waiting, the plan's blue banner as the home drew it; then the plans of the other spaces where something
     * waits (`planWaiting`), only what waits, each saying which space. The amber banners' counts add up to [waiting] —
     * the drawer's number and the Activity badge's — as long as each plan read counts what the server's `planWaiting`
     * counts. A space's plan is in [plans] by the space's id; one not read draws nothing. */
    fun activityBanners(spaces: List<WikiSpace>, current: WikiSpace, plans: Map<String, WikiPlanState>, now: Instant,
        docs: Pair<Int, Int>?, runnerOnline: (WikiSpace) -> Boolean?): List<ActivityBanner> {
        val names = names(spaces)
        val banners = mutableListOf<ActivityBanner>()
        proposalsBanner(spaces, current.id, names)?.let {
            banners += ActivityBanner("review", WikiLogic.ActivityBand.REVIEW_BANNER, it, true, proposalsWaiting(spaces), ActivityBanner.To.Review)
        }
        fun plan(banner: WikiPlanLogic.Banner, look: WikiPlanLogic.Look, count: Int, space: WikiSpace, band: WikiLogic.ActivityBand, text: String) =
            ActivityBanner("${band.name}:${space.id}:${look.name}", band, text, banner.amber, if (banner.amber) count else 0,
                if (banner.toSettings) ActivityBanner.To.Settings(space.slug) else ActivityBanner.To.Plan(space.slug))
        val online = runnerOnline(current)
        val state = plans[current.id]
        val look = state?.let { WikiPlanLogic.look(it, online) }
        if (state != null && look != null) {
            val waiting = WikiPlanLogic.waitingBanners(state, now, docs, online)
            if (waiting.isEmpty()) {
                val banner = WikiPlanLogic.banner(look, state, now, docs, online)
                banners += plan(banner, look, 0, current, WikiLogic.ActivityBand.PLAN_BANNERS, banner.text)
            }
            waiting.forEach { banners += plan(it.banner, it.look, it.count, current, WikiLogic.ActivityBand.PLAN_BANNERS, it.banner.text) }
        }
        for (space in spaces) {
            if (space.id == current.id || (space.planWaiting ?: 0) <= 0) continue
            val other = plans[space.id] ?: continue
            val name = names[space.id] ?: space.title ?: space.slug
            WikiPlanLogic.waitingBanners(other, now, null, runnerOnline(space)).forEach { one ->
                banners += plan(one.banner, one.look, one.count, space, WikiLogic.ActivityBand.OTHER_PLAN_BANNERS, "${one.banner.text} ${WikiCopy.inSpace(name)}")
            }
        }
        return banners
    }

    // MARK: the picker

    /** One space as the picker's menu draws it (mock 31 ④): the name is the title; the repository and the documents are
     * the line under it, a line each; what waits is the amber number beside it. */
    data class MenuRow(val id: String, val slug: String, val name: String, val lines: List<String>, val waiting: Int) {
        /** The line under the name, one under another; with [sayWaiting] — no amber number to carry it — the last line ends
         * with `· N waiting`. */
        fun subtitle(sayWaiting: Boolean): String {
            val lines = this.lines.toMutableList()
            if (sayWaiting && waiting > 0 && lines.isNotEmpty()) lines[lines.lastIndex] = "${lines.last()} ${WikiCopy.spaceWaiting(waiting)}"
            return lines.joinToString("\n")
        }
    }

    /** Every space's row, in the server's order. */
    fun menuRows(spaces: List<WikiSpace>, names: Map<String, String> = names(spaces)): List<MenuRow> = spaces.map { space ->
        val documents = space.docs?.let { WikiCopy.documentCount(it.total) } ?: WikiCopy.noDocuments
        MenuRow(space.id, space.slug, names[space.id] ?: space.title ?: space.slug,
            listOfNotNull(space.repoUrlNorm?.takeIf { it.isNotEmpty() }, documents), waitingIn(space))
    }
}

/** When the reader last looked at a space (design §12.3.2): the web's `wikiSeenKey(space, 'home')` stamp, read and moved
 * by the web's rule (`moveWikiSeen`, `readWikiSeenBefore`) — OrbitKit `WikiSeenLog`. Two pages read the one stamp: the
 * home moves it as it opens, and Activity — reached from the home — marks what changed since the reader last looked. Read
 * after the home moved it, the stamp would say "just now", so a move keeps what the stamp said before, for the next page of
 * the same visit; a second move within a second of the first is the same page opening again and keeps what it said
 * before the first. The stamps themselves are the caller's to store; this holds only what each said before this run of
 * the app last moved it. */
internal class WikiSeenLog {
    private val before = mutableMapOf<String, Double>()
    private val movedAt = mutableMapOf<String, Double>()

    /** The stamp moves to [at] (seconds since 1970) from [stored], what it says now — 0 for never. */
    @Synchronized fun move(key: String, at: Double, stored: Double) {
        val last = movedAt[key]
        if (last == null || at - last >= 1) before[key] = stored
        movedAt[key] = at
    }

    /** The stamp as it stood before this run last moved it — or as it stands ([stored]), when it has not. */
    @Synchronized fun seenBefore(key: String, stored: Double): Double = before[key] ?: stored

    companion object {
        /** Where a space's stamp is kept: one per space. */
        fun key(slug: String, scope: String = "home") = "orbit.wiki.seen.$slug.$scope"

        /** Whether something that happened [at] came after the reader last looked ([seen]; 0 is never): a row that wears
         * the blue dot. Nothing seen before means everything is new. */
        fun isNew(at: String?, seen: Double): Boolean {
            if (seen <= 0) return true
            val date = RelativeTime.parse(at) ?: return false
            return date.toEpochMilli() / 1000.0 > seen
        }
    }
}
