package io.orbitd.android.toast

import java.util.concurrent.atomic.AtomicLong

// The toast system's rules (iOS OrbitKit `ToastFeed`, 86661c204 · d625d9809 · 627989805; docs/mocks/toast-system): what
// a toast asks of you decides its shape, how long it stays, and whether anything can push it off the screen.

/** How loud a toast is: its glyph, its tint, whether it leaves by itself (web's `SessionNoticeTone`). */
enum class ToastTone {
    SUCCESS, NEUTRAL, INFO, WARNING, ERROR;

    /** An outcome you need to read twice — and usually paste somewhere — isn't taken away on a timer. */
    val isPersistent get() = this == WARNING || this == ERROR
}

/** What a toast asks of you. */
enum class ToastLevel {
    /** ① A pill: something you just did worked. Leaves on its own. */
    CONFIRM,
    /** A pill with a spinner: work under way, until the same operation's result takes its place. */
    PROGRESS,
    /** ② A card: an outcome with an Undo to decide on or a diagnostic to read. */
    RESULT,
    /** ③ A tinted card: something failed or waits for you. Never on a timer, never displaced by a later toast. */
    ATTENTION,
}

/** A glyph overriding the tone's, so a neutral outcome still says what it was ("Moved to Trash" shows the trash). */
enum class ToastGlyph { TRASH, FOLDER }

/** The branch and target the worktree bar hands the session to resolve a failed merge. */
data class ToastMergeConflict(val branch: String, val target: String)

/** One toast, as the host draws it. */
data class ToastItem(
    /** The outcome: "Accepted", "Couldn't merge into main". */
    val message: String,
    /** What it happened to: the session, or an entry's title. */
    val subtitle: String? = null,
    /** The diagnostic — for a failure, the server's own words. */
    val detail: String? = null,
    val tone: ToastTone = ToastTone.SUCCESS,
    val glyph: ToastGlyph? = null,
    /** The session it reports on: the toast doubles as the way into it. */
    val sessionId: String? = null,
    /** The action is reversible; the card carries Undo. */
    val canUndo: Boolean = false,
    /** A merge conflict's primary action resolves it in the session instead of only opening it. */
    val mergeConflict: ToastMergeConflict? = null,
    /** One operation's toasts share a key — "Merging into main…" and the merge's result — so the result takes the
     * progress pill's place instead of arriving as a second toast. */
    val key: String? = null,
    /** Work under way: drawn with a spinner until its result replaces it. */
    val inProgress: Boolean = false,
    val id: Long = ids.incrementAndGet(),
    /** Which post put up what it says now: a result that took its pill's place keeps the pill's id, and its timer
     * starts over. */
    val revision: Long = 0,
) {
    /** A failure waits for you whatever else it carries; a card is only for an Undo to decide on or a
     * diagnostic to read — an outcome that merely names its session is a pill you can tap through. */
    val level: ToastLevel get() = when {
        tone.isPersistent -> ToastLevel.ATTENTION
        inProgress -> ToastLevel.PROGRESS
        canUndo || detail != null -> ToastLevel.RESULT
        else -> ToastLevel.CONFIRM
    }

    /** How long it stays when nothing replaces it, in milliseconds; null for the ones that wait for you. Three seconds
     * for a confirmation, six for a card (web's window for an Undo); a progress pill's minute is only a net under a
     * result that never comes. */
    val dwellMillis: Long? get() = when (level) {
        ToastLevel.CONFIRM -> 3_000
        ToastLevel.RESULT -> 6_000
        ToastLevel.PROGRESS -> 60_000
        ToastLevel.ATTENTION -> null
    }

    /** Whether a tap opens something: the session it names. */
    val opens: Boolean get() = sessionId != null

    private companion object { val ids = AtomicLong() }
}

/** What is on screen: the toasts that wait for you, pinned, and the one transient toast below them. A ③ is pinned, and
 * only its ✕ or its own operation succeeding take it down; ①, ② and progress share the one transient slot, where the
 * newest wins. */
data class ToastFeed(
    /** ③ toasts, oldest first. */
    val pinned: List<ToastItem> = emptyList(),
    /** The one transient toast: ①, ② or progress. */
    val transient: ToastItem? = null,
    /** The pinned toast drawn open on a phone; the others — and this one, once folded — show as a pill. */
    val expanded: Long? = null,
    /** How many times a pinned card was opened: each opening folds it again six seconds later. */
    val openings: Long = 0,
    private val posts: Long = 0,
    private val lastText: String? = null,
    private val lastAt: Long = 0,
) {
    /** The pinned toast a phone shows — the newest — and how many wait behind it. */
    val front: ToastItem? get() = pinned.lastOrNull()
    val behindFront: Int get() = maxOf(0, pinned.size - 1)

    /** The toast with [id], wherever it is. */
    fun item(id: Long): ToastItem? = if (transient?.id == id) transient else pinned.firstOrNull { it.id == id }

    /** [item] put up at [now] (milliseconds): the feed after it, and the id it is shown under — null when it repeats
     * what went up under two seconds ago (two taps on Copy are one toast). A keyed toast takes the place of its
     * operation's toast already up and keeps that toast's id, so "Merging into main…" becomes "Merged into main" where
     * it stands. A failure pins (its progress pill goes); a success clears its operation's earlier failure, which the
     * retry it reports has answered. */
    fun post(item: ToastItem, now: Long): Pair<ToastFeed, Long?> {
        val text = listOf(item.message, item.subtitle.orEmpty(), item.detail.orEmpty(), item.tone.name).joinToString("\u001F")
        if (item.key == null && lastText == text && now - lastAt < 2_000) return this to null
        var feed = copy(posts = posts + 1, lastText = text, lastAt = now)
        var posted = item.copy(revision = feed.posts)
        if (item.key != null) {
            val current = feed.transient
            if (current?.key == item.key) {
                feed = feed.copy(transient = null)
                if (posted.level != ToastLevel.ATTENTION) {
                    posted = posted.copy(id = current!!.id)
                    return feed.copy(transient = posted) to posted.id
                }
            }
            val index = feed.pinned.indexOfFirst { it.key == item.key }
            if (index >= 0) {
                val pinnedItem = feed.pinned[index]
                if (posted.level == ToastLevel.ATTENTION) {
                    posted = posted.copy(id = pinnedItem.id)
                    return feed.copy(pinned = feed.pinned.toMutableList().also { it[index] = posted }, expanded = posted.id,
                        openings = feed.openings + 1) to posted.id
                }
                feed = feed.copy(pinned = feed.pinned.filterIndexed { i, _ -> i != index },
                    expanded = feed.expanded.takeIf { it != pinnedItem.id })
            }
        }
        return if (posted.level == ToastLevel.ATTENTION) feed.copy(pinned = feed.pinned + posted, expanded = posted.id,
            openings = feed.openings + 1) to posted.id
        else feed.copy(transient = posted) to posted.id
    }

    /** ✕, a swipe, Undo, or following the toast into its session. */
    fun dismiss(id: Long): ToastFeed = copy(transient = transient?.takeIf { it.id != id }, pinned = pinned.filter { it.id != id },
        expanded = expanded.takeIf { it != id })

    /** A dwell running out: takes the transient toast down only if it is still the one the timer was started for. */
    fun expire(id: Long): ToastFeed = if (transient?.id == id) copy(transient = null) else this

    /** Folds an open pinned card back into its pill. */
    fun fold(id: Long): ToastFeed = if (expanded == id) copy(expanded = null) else this

    /** Opens a pinned toast's card from its pill. */
    fun unfold(id: Long): ToastFeed = if (pinned.any { it.id == id }) copy(expanded = id, openings = openings + 1) else this
}
